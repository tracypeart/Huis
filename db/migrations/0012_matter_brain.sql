-- Phase 4 part 1: Matter Brain.
--
-- Each Matter gets its own knowledge base: the readable text of its evidence
-- (documents, filed email, transcripts) and the attorneys' notes, split into
-- passages, indexed for words and for meaning, and searchable by asking a
-- question. Every answer cites the passages it came from.
--
-- Privilege rules:
--   * A passage is visible exactly when its source is visible to the person
--     (the evidence's own row-level rules, so ethical walls apply), and only
--     to firm staff: clients, co-counsel and experts never see the Matter
--     Brain or any AI output (AI output is attorney-facing only).
--   * Attorney notes are work product: firm staff on the Matter only.
--   * Saved questions and answers are private to the person who asked.
--   * Only clean (virus-scanned) evidence is ever indexed.
--   * The AI provider is a firm setting. "local" runs inside Huis and sends
--     nothing anywhere; outside AI providers are added only after their
--     zero-retention, no-training terms are signed (open item O-3).

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

ALTER TABLE huis.firms ADD COLUMN ai_provider text NOT NULL DEFAULT 'local' CHECK (ai_provider IN ('off', 'local'));

-- ---------------------------------------------------------------------------
-- Attorney notes (work product)
-- ---------------------------------------------------------------------------
CREATE TABLE huis.matter_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id     uuid NOT NULL REFERENCES huis.firms(id),
  matter_id   uuid NOT NULL,
  author_id   uuid NOT NULL,
  title       text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  body        text NOT NULL CHECK (length(body) BETWEEN 1 AND 200000),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (firm_id, id),
  FOREIGN KEY (firm_id, matter_id) REFERENCES huis.matters(firm_id, id),
  FOREIGN KEY (firm_id, author_id) REFERENCES huis.users(firm_id, id)
);
CREATE INDEX matter_notes_matter ON huis.matter_notes (firm_id, matter_id, updated_at DESC);

ALTER TABLE huis.matter_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.matter_notes FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON huis.matter_notes TO huis_app;
GRANT SELECT ON huis.matter_notes TO huis_security;

CREATE POLICY matter_notes_select ON huis.matter_notes FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.is_internal_role(huis.app_role()) AND huis.can_see_matter(matter_id));
CREATE POLICY matter_notes_insert ON huis.matter_notes FOR INSERT TO huis_app
  WITH CHECK (firm_id = huis.current_firm_id() AND author_id = huis.current_user_id() AND huis.is_internal_role(huis.app_role())
              AND huis.app_role() <> 'read_only' AND huis.can_see_matter(matter_id));
CREATE POLICY matter_notes_update ON huis.matter_notes FOR UPDATE TO huis_app
  USING (firm_id = huis.current_firm_id() AND author_id = huis.current_user_id() AND huis.is_internal_role(huis.app_role())
         AND huis.app_role() <> 'read_only' AND huis.can_see_matter(matter_id))
  WITH CHECK (firm_id = huis.current_firm_id() AND author_id = huis.current_user_id());
CREATE POLICY matter_notes_delete ON huis.matter_notes FOR DELETE TO huis_app
  USING (firm_id = huis.current_firm_id() AND author_id = huis.current_user_id() AND huis.can_see_matter(matter_id));

-- A note never moves to another Matter or author.
CREATE FUNCTION huis.matter_notes_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.matter_id IS DISTINCT FROM OLD.matter_id OR NEW.author_id IS DISTINCT FROM OLD.author_id
     OR NEW.firm_id IS DISTINCT FROM OLD.firm_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a note cannot be moved';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER matter_notes_guard BEFORE UPDATE ON huis.matter_notes FOR EACH ROW EXECUTE FUNCTION huis.matter_notes_guard();

-- ---------------------------------------------------------------------------
-- Index: one row per source (evidence item or note), passages per source
-- ---------------------------------------------------------------------------
CREATE TABLE huis.brain_sources (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id       uuid NOT NULL REFERENCES huis.firms(id),
  matter_id     uuid NOT NULL,
  evidence_id   uuid UNIQUE,
  note_id       uuid UNIQUE REFERENCES huis.matter_notes(id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'indexed', 'failed')),
  provider      text,
  model         text,
  content_hash  text,
  chunk_count   int NOT NULL DEFAULT 0,
  last_error    text,
  attempts      int NOT NULL DEFAULT 0,
  lock_token    uuid,
  locked_until  timestamptz,
  queued_at     timestamptz NOT NULL DEFAULT now(),
  indexed_at    timestamptz,
  CHECK ((evidence_id IS NULL) <> (note_id IS NULL)),
  FOREIGN KEY (firm_id, matter_id) REFERENCES huis.matters(firm_id, id),
  FOREIGN KEY (firm_id, evidence_id) REFERENCES huis.evidence_items(firm_id, id)
);
CREATE INDEX brain_sources_queue ON huis.brain_sources (queued_at) WHERE status IN ('queued', 'running');
CREATE INDEX brain_sources_matter ON huis.brain_sources (firm_id, matter_id);

CREATE TABLE huis.brain_chunks (
  id           bigserial PRIMARY KEY,
  firm_id      uuid NOT NULL REFERENCES huis.firms(id),
  matter_id    uuid NOT NULL,
  source_id    uuid NOT NULL REFERENCES huis.brain_sources(id) ON DELETE CASCADE,
  evidence_id  uuid,
  note_id      uuid,
  chunk_no     int NOT NULL CHECK (chunk_no >= 0),
  content      text NOT NULL CHECK (length(content) BETWEEN 1 AND 4000),
  char_start   int NOT NULL CHECK (char_start >= 0),
  char_end     int NOT NULL CHECK (char_end >= char_start),
  model        text NOT NULL,
  embedding    vector,
  tsv          tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  UNIQUE (source_id, chunk_no)
);
CREATE INDEX brain_chunks_matter ON huis.brain_chunks (firm_id, matter_id);
CREATE INDEX brain_chunks_tsv ON huis.brain_chunks USING gin (tsv);

ALTER TABLE huis.brain_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.brain_chunks  ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.brain_sources FORCE ROW LEVEL SECURITY;
ALTER TABLE huis.brain_chunks  FORCE ROW LEVEL SECURITY;
GRANT SELECT (id, firm_id, matter_id, evidence_id, note_id, status, chunk_count, indexed_at, queued_at) ON huis.brain_sources TO huis_app;
GRANT SELECT (id, firm_id, matter_id, source_id, evidence_id, note_id, chunk_no, content, char_start, char_end, model, embedding, tsv)
  ON huis.brain_chunks TO huis_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON huis.brain_sources, huis.brain_chunks TO huis_security;
GRANT USAGE ON SEQUENCE huis.brain_chunks_id_seq TO huis_security;

-- Visible exactly when the source is visible to this person, and only to firm staff.
CREATE FUNCTION huis.brain_source_visible(p_matter_id uuid, p_evidence_id uuid, p_note_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT huis.is_internal_role(huis.app_role()) AND (
    (p_evidence_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM huis.evidence_items i
        WHERE i.id = p_evidence_id AND i.matter_id = p_matter_id AND i.status = 'clean'))
    OR (p_note_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM huis.matter_notes n WHERE n.id = p_note_id AND n.matter_id = p_matter_id))
  )
$$;
GRANT EXECUTE ON FUNCTION huis.brain_source_visible(uuid, uuid, uuid) TO huis_app;

CREATE POLICY brain_sources_select ON huis.brain_sources FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.brain_source_visible(matter_id, evidence_id, note_id));
CREATE POLICY brain_chunks_select ON huis.brain_chunks FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.brain_source_visible(matter_id, evidence_id, note_id));

-- Queueing: new readable evidence text and new or changed notes.
CREATE FUNCTION huis.brain_queue_evidence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE i huis.evidence_items;
BEGIN
  SELECT * INTO i FROM huis.evidence_items WHERE id = NEW.evidence_id;
  -- Exact duplicates add nothing to the Brain.
  IF NOT FOUND OR i.duplicate_of IS NOT NULL THEN RETURN NEW; END IF;
  INSERT INTO huis.brain_sources (firm_id, matter_id, evidence_id)
    VALUES (i.firm_id, i.matter_id, i.id)
    ON CONFLICT (evidence_id) DO UPDATE SET status = 'queued', attempts = 0, last_error = NULL, queued_at = now();
  RETURN NEW;
END $$;
CREATE TRIGGER brain_queue_evidence AFTER INSERT OR UPDATE OF content ON huis.evidence_text
  FOR EACH ROW EXECUTE FUNCTION huis.brain_queue_evidence();

CREATE FUNCTION huis.brain_queue_note() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
BEGIN
  INSERT INTO huis.brain_sources (firm_id, matter_id, note_id)
    VALUES (NEW.firm_id, NEW.matter_id, NEW.id)
    ON CONFLICT (note_id) DO UPDATE SET status = 'queued', attempts = 0, last_error = NULL, queued_at = now();
  RETURN NEW;
END $$;
CREATE TRIGGER brain_queue_note AFTER INSERT OR UPDATE OF title, body ON huis.matter_notes
  FOR EACH ROW EXECUTE FUNCTION huis.brain_queue_note();
ALTER FUNCTION huis.brain_queue_evidence() OWNER TO huis_security;
ALTER FUNCTION huis.brain_queue_note() OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.brain_queue_evidence(), huis.brain_queue_note() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Worker: claim a source, save its passages, or fail it
-- ---------------------------------------------------------------------------
CREATE FUNCTION huis.worker_claim_brain_source()
RETURNS TABLE (source_id uuid, lock_token uuid, firm_id uuid, matter_id uuid, kind text, content text, ai_provider text, attempts int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
#variable_conflict use_column
DECLARE
  r huis.brain_sources;
  v_token uuid := gen_random_uuid();
  v_text text;
  v_provider text;
BEGIN
  SELECT b.* INTO r FROM huis.brain_sources b JOIN huis.firms f ON f.id = b.firm_id
   WHERE (b.status = 'queued' OR (b.status = 'running' AND b.locked_until < now())) AND b.attempts < 5 AND f.ai_provider <> 'off'
   ORDER BY b.queued_at LIMIT 1 FOR UPDATE OF b SKIP LOCKED;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT ai_provider INTO v_provider FROM huis.firms WHERE id = r.firm_id;
  IF r.evidence_id IS NOT NULL THEN
    -- Only clean evidence is indexed; anything else leaves the Brain.
    SELECT left(t.content, 2000000) INTO v_text FROM huis.evidence_text t JOIN huis.evidence_items i ON i.id = t.evidence_id
     WHERE t.evidence_id = r.evidence_id AND i.status = 'clean' AND i.matter_id = r.matter_id;
  ELSE
    SELECT n.title || E'\n\n' || n.body INTO v_text FROM huis.matter_notes n WHERE n.id = r.note_id AND n.matter_id = r.matter_id;
  END IF;
  IF v_text IS NULL THEN
    DELETE FROM huis.brain_chunks WHERE source_id = r.id;
    UPDATE huis.brain_sources SET status = 'indexed', chunk_count = 0, indexed_at = now(), lock_token = NULL WHERE id = r.id;
    RETURN;
  END IF;
  UPDATE huis.brain_sources SET status = 'running', lock_token = v_token, locked_until = now() + interval '10 minutes',
         attempts = attempts + 1 WHERE id = r.id;
  RETURN QUERY SELECT r.id, v_token, r.firm_id, r.matter_id, CASE WHEN r.evidence_id IS NOT NULL THEN 'evidence' ELSE 'note' END,
                      v_text, v_provider, r.attempts + 1;
END $$;

CREATE FUNCTION huis.worker_save_brain_chunks(
  p_source_id uuid, p_lock_token uuid, p_provider text, p_model text, p_content_hash text, p_chunks jsonb
) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, public, pg_temp AS $$
DECLARE
  r huis.brain_sources;
  c jsonb;
  n int := 0;
  v_dims int;
BEGIN
  SELECT * INTO r FROM huis.brain_sources WHERE id = p_source_id AND status = 'running' AND lock_token = p_lock_token FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'source is not held by this worker'; END IF;
  IF jsonb_typeof(p_chunks) <> 'array' OR jsonb_array_length(p_chunks) > 5000 THEN RAISE EXCEPTION 'invalid chunks'; END IF;
  IF p_model IS NULL OR p_model !~ '^[A-Za-z0-9._:-]{1,100}$' OR p_provider !~ '^[a-z]{1,30}$' THEN RAISE EXCEPTION 'invalid model'; END IF;
  DELETE FROM huis.brain_chunks WHERE source_id = r.id;
  FOR c IN SELECT * FROM jsonb_array_elements(p_chunks) LOOP
    IF c->'embedding' IS NOT NULL AND jsonb_typeof(c->'embedding') = 'array' THEN
      IF jsonb_array_length(c->'embedding') NOT BETWEEN 1 AND 4096 THEN RAISE EXCEPTION 'invalid embedding'; END IF;
      IF v_dims IS NULL THEN v_dims := jsonb_array_length(c->'embedding');
      ELSIF v_dims <> jsonb_array_length(c->'embedding') THEN RAISE EXCEPTION 'inconsistent embeddings'; END IF;
    END IF;
    INSERT INTO huis.brain_chunks (firm_id, matter_id, source_id, evidence_id, note_id, chunk_no, content, char_start, char_end, model, embedding)
      VALUES (r.firm_id, r.matter_id, r.id, r.evidence_id, r.note_id, (c->>'n')::int, c->>'content',
              (c->>'start')::int, (c->>'end')::int, p_model,
              CASE WHEN jsonb_typeof(c->'embedding') = 'array' THEN (c->>'embedding')::vector END);
    n := n + 1;
  END LOOP;
  UPDATE huis.brain_sources SET status = 'indexed', provider = p_provider, model = p_model, content_hash = left(p_content_hash, 64),
         chunk_count = n, indexed_at = now(), last_error = NULL, lock_token = NULL, locked_until = NULL WHERE id = r.id;
  RETURN n;
END $$;

CREATE FUNCTION huis.worker_fail_brain_source(p_source_id uuid, p_lock_token uuid, p_error text, p_final boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
BEGIN
  UPDATE huis.brain_sources
     SET status = CASE WHEN p_final THEN 'failed' ELSE 'queued' END, last_error = left(p_error, 300),
         lock_token = NULL, locked_until = NULL, queued_at = now() + interval '1 minute'
   WHERE id = p_source_id AND status = 'running' AND lock_token = p_lock_token;
END $$;

ALTER FUNCTION huis.worker_claim_brain_source() OWNER TO huis_security;
ALTER FUNCTION huis.worker_save_brain_chunks(uuid, uuid, text, text, text, jsonb) OWNER TO huis_security;
ALTER FUNCTION huis.worker_fail_brain_source(uuid, uuid, text, boolean) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.worker_claim_brain_source(), huis.worker_save_brain_chunks(uuid, uuid, text, text, text, jsonb),
  huis.worker_fail_brain_source(uuid, uuid, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.worker_claim_brain_source(), huis.worker_save_brain_chunks(uuid, uuid, text, text, text, jsonb),
  huis.worker_fail_brain_source(uuid, uuid, text, boolean) TO huis_worker;

-- ---------------------------------------------------------------------------
-- Questions and answers (private to the person who asked)
-- ---------------------------------------------------------------------------
CREATE TABLE huis.brain_answers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id     uuid NOT NULL REFERENCES huis.firms(id),
  matter_id   uuid NOT NULL,
  asked_by    uuid NOT NULL,
  question    text NOT NULL CHECK (length(question) BETWEEN 1 AND 2000),
  answer      text NOT NULL CHECK (length(answer) <= 100000),
  citations   jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(citations) = 'array'),
  provider    text NOT NULL,
  model       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (firm_id, matter_id) REFERENCES huis.matters(firm_id, id),
  FOREIGN KEY (firm_id, asked_by) REFERENCES huis.users(firm_id, id)
);
CREATE INDEX brain_answers_mine ON huis.brain_answers (firm_id, asked_by, matter_id, created_at DESC);
ALTER TABLE huis.brain_answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.brain_answers FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON huis.brain_answers TO huis_app;
CREATE POLICY brain_answers_select ON huis.brain_answers FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND asked_by = huis.current_user_id()
         AND huis.is_internal_role(huis.app_role()) AND huis.can_see_matter(matter_id));
CREATE POLICY brain_answers_insert ON huis.brain_answers FOR INSERT TO huis_app
  WITH CHECK (firm_id = huis.current_firm_id() AND asked_by = huis.current_user_id()
              AND huis.is_internal_role(huis.app_role()) AND huis.can_see_matter(matter_id));
CREATE POLICY brain_answers_delete ON huis.brain_answers FOR DELETE TO huis_app
  USING (firm_id = huis.current_firm_id() AND asked_by = huis.current_user_id());

-- ---------------------------------------------------------------------------
-- AI usage log: who used which provider, how much. Never any content.
-- ---------------------------------------------------------------------------
CREATE TABLE huis.ai_requests (
  id            bigserial PRIMARY KEY,
  firm_id       uuid NOT NULL REFERENCES huis.firms(id),
  user_id       uuid,
  matter_id     uuid,
  purpose       text NOT NULL CHECK (purpose IN ('ask', 'index')),
  provider      text NOT NULL CHECK (provider ~ '^[a-z]{1,30}$'),
  model         text NOT NULL CHECK (model ~ '^[A-Za-z0-9._:-]{1,100}$'),
  input_chars   int NOT NULL CHECK (input_chars >= 0),
  output_chars  int NOT NULL CHECK (output_chars >= 0),
  duration_ms   int NOT NULL CHECK (duration_ms >= 0),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_requests_firm ON huis.ai_requests (firm_id, created_at DESC);
ALTER TABLE huis.ai_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.ai_requests FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON huis.ai_requests TO huis_app;
GRANT USAGE ON SEQUENCE huis.ai_requests_id_seq TO huis_app, huis_security;
GRANT INSERT ON huis.ai_requests TO huis_security;
CREATE POLICY ai_requests_select ON huis.ai_requests FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.is_admin_role(huis.app_role()));
CREATE POLICY ai_requests_insert ON huis.ai_requests FOR INSERT TO huis_app
  WITH CHECK (firm_id = huis.current_firm_id() AND user_id = huis.current_user_id() AND purpose = 'ask'
              AND huis.is_internal_role(huis.app_role()));

-- Worker records indexing usage (no content).
CREATE FUNCTION huis.worker_log_ai(p_source_id uuid, p_lock_token uuid, p_provider text, p_model text, p_input int, p_output int, p_ms int) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE r huis.brain_sources;
BEGIN
  SELECT * INTO r FROM huis.brain_sources WHERE id = p_source_id AND status = 'running' AND lock_token = p_lock_token;
  IF NOT FOUND THEN RAISE EXCEPTION 'source is not held by this worker'; END IF;
  INSERT INTO huis.ai_requests (firm_id, matter_id, purpose, provider, model, input_chars, output_chars, duration_ms)
    VALUES (r.firm_id, r.matter_id, 'index', p_provider, p_model, greatest(p_input, 0), greatest(p_output, 0), greatest(p_ms, 0));
END $$;
ALTER FUNCTION huis.worker_log_ai(uuid, uuid, text, text, int, int, int) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.worker_log_ai(uuid, uuid, text, text, int, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.worker_log_ai(uuid, uuid, text, text, int, int, int) TO huis_worker;

-- Firm administrators choose the AI provider.
CREATE FUNCTION huis.set_ai_provider(p_provider text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
BEGIN
  IF NOT huis.is_admin_role(huis.app_role()) THEN RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501'; END IF;
  IF p_provider NOT IN ('off', 'local') THEN RAISE EXCEPTION 'invalid provider'; END IF;
  UPDATE huis.firms SET ai_provider = p_provider WHERE id = huis.current_firm_id();
END $$;
ALTER FUNCTION huis.set_ai_provider(text) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.set_ai_provider(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.set_ai_provider(text) TO huis_app;
GRANT SELECT (ai_provider) ON huis.firms TO huis_app;

-- Existing readable evidence joins the Brain.
INSERT INTO huis.brain_sources (firm_id, matter_id, evidence_id)
  SELECT i.firm_id, i.matter_id, i.id FROM huis.evidence_text t JOIN huis.evidence_items i ON i.id = t.evidence_id
   WHERE i.duplicate_of IS NULL
  ON CONFLICT DO NOTHING;
