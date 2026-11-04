-- Phase 8 part 1: the court calendar and federal court notices.
--
-- Each Matter's court dates: hearings, conferences, trials and deadlines.
-- Attorneys add their own; Huis proposes dates it reads in federal court
-- notices (CM/ECF Notices of Electronic Filing) filed into the Matter. A
-- proposed date never counts until someone confirms it: Huis never silently
-- creates a court deadline. Rejected proposals aren't proposed again.
--
-- Privilege: court dates are part of the firm's work on the Matter, under the
-- same rules as Case DNA: firm staff who can see the Matter can read them,
-- read-only staff can't change them, and clients and other outside users
-- never see them. A date read from a notice that is no longer clean (e.g.
-- later found infected) disappears.

CREATE TABLE huis.court_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id      uuid NOT NULL REFERENCES huis.firms(id),
  matter_id    uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('hearing', 'deadline', 'trial', 'conference', 'other')),
  title        text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  event_date   date NOT NULL CHECK (event_date BETWEEN DATE '1900-01-01' AND DATE '2100-12-31'),
  event_time   time,
  location     text CHECK (location IS NULL OR length(location) <= 200),
  judge        text CHECK (judge IS NULL OR length(judge) <= 200),
  notes        text NOT NULL DEFAULT '' CHECK (length(notes) <= 5000),
  status       text NOT NULL CHECK (status IN ('suggested', 'confirmed', 'rejected')),
  origin       text NOT NULL CHECK (origin IN ('attorney', 'huis')),
  origin_key   text CHECK (origin_key IS NULL OR length(origin_key) <= 400),
  -- Where Huis read it: the notice (an email filed into the Matter) and the exact words.
  source_evidence_id uuid,
  char_start   int CHECK (char_start IS NULL OR char_start >= 0),
  char_end     int CHECK (char_end IS NULL OR char_end >= char_start),
  quote        text CHECK (quote IS NULL OR length(quote) <= 1000),
  done_at      timestamptz,
  done_by      uuid,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_by   uuid,
  decided_at   timestamptz,
  UNIQUE (firm_id, id),
  UNIQUE (matter_id, origin_key),
  CHECK ((origin = 'huis') = (created_by IS NULL)),
  CHECK (origin = 'huis' OR (status <> 'suggested' AND source_evidence_id IS NULL AND quote IS NULL)),
  CHECK (origin = 'attorney' OR (source_evidence_id IS NOT NULL AND quote IS NOT NULL AND char_start IS NOT NULL)),
  CHECK ((done_at IS NULL) = (done_by IS NULL)),
  FOREIGN KEY (firm_id, matter_id) REFERENCES huis.matters(firm_id, id),
  FOREIGN KEY (firm_id, source_evidence_id) REFERENCES huis.evidence_items(firm_id, id),
  FOREIGN KEY (firm_id, created_by) REFERENCES huis.users(firm_id, id),
  FOREIGN KEY (firm_id, decided_by) REFERENCES huis.users(firm_id, id),
  FOREIGN KEY (firm_id, done_by) REFERENCES huis.users(firm_id, id)
);
CREATE INDEX court_events_matter ON huis.court_events (firm_id, matter_id, event_date);
CREATE INDEX court_events_upcoming ON huis.court_events (firm_id, event_date) WHERE status = 'confirmed' AND done_at IS NULL;

-- What can change: an attorney's own wording, dates and notes; the decision
-- (recorded with who and when); and marking it done (who and when). What Huis
-- proposed stays as Huis read it until someone confirms it.
CREATE FUNCTION huis.court_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.firm_id IS DISTINCT FROM OLD.firm_id OR NEW.matter_id IS DISTINCT FROM OLD.matter_id
     OR NEW.origin IS DISTINCT FROM OLD.origin OR NEW.origin_key IS DISTINCT FROM OLD.origin_key
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.source_evidence_id IS DISTINCT FROM OLD.source_evidence_id OR NEW.char_start IS DISTINCT FROM OLD.char_start
     OR NEW.char_end IS DISTINCT FROM OLD.char_end OR NEW.quote IS DISTINCT FROM OLD.quote THEN
    RAISE EXCEPTION 'court calendar history cannot be rewritten';
  END IF;
  IF OLD.status = 'suggested' AND (
       NEW.kind IS DISTINCT FROM OLD.kind OR NEW.title IS DISTINCT FROM OLD.title OR NEW.event_date IS DISTINCT FROM OLD.event_date
       OR NEW.event_time IS DISTINCT FROM OLD.event_time OR NEW.location IS DISTINCT FROM OLD.location OR NEW.judge IS DISTINCT FROM OLD.judge
       OR NEW.notes IS DISTINCT FROM OLD.notes) THEN
    RAISE EXCEPTION 'Confirm a proposed court date before changing it';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'suggested' THEN RAISE EXCEPTION 'a decision cannot be undone to a proposal'; END IF;
    NEW.decided_by := huis.current_user_id();
    NEW.decided_at := now();
  ELSIF NEW.decided_by IS DISTINCT FROM OLD.decided_by OR NEW.decided_at IS DISTINCT FROM OLD.decided_at THEN
    RAISE EXCEPTION 'court calendar history cannot be rewritten';
  END IF;
  IF NEW.done_at IS DISTINCT FROM OLD.done_at OR NEW.done_by IS DISTINCT FROM OLD.done_by THEN
    IF NEW.status <> 'confirmed' THEN RAISE EXCEPTION 'only a confirmed court date can be marked done'; END IF;
    IF NEW.done_at IS NOT NULL THEN NEW.done_at := now(); NEW.done_by := huis.current_user_id();
    ELSE NEW.done_by := NULL; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER court_events_guard BEFORE UPDATE ON huis.court_events FOR EACH ROW EXECUTE FUNCTION huis.court_event_guard();

-- A date read from a notice is visible while that notice is clean and the person can open it.
CREATE FUNCTION huis.court_event_source_ok(p_source uuid, p_matter uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT p_source IS NULL OR EXISTS (SELECT 1 FROM huis.evidence_items i WHERE i.id = p_source AND i.matter_id = p_matter AND i.status = 'clean')
$$;
GRANT EXECUTE ON FUNCTION huis.court_event_source_ok(uuid, uuid) TO huis_app;

ALTER TABLE huis.court_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.court_events FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON huis.court_events TO huis_app;
GRANT SELECT, INSERT, UPDATE ON huis.court_events TO huis_security;

CREATE POLICY court_events_select ON huis.court_events FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.dna_readable(matter_id) AND huis.court_event_source_ok(source_evidence_id, matter_id));
CREATE POLICY court_events_insert ON huis.court_events FOR INSERT TO huis_app
  WITH CHECK (firm_id = huis.current_firm_id() AND huis.dna_writable(matter_id)
              AND origin = 'attorney' AND status = 'confirmed' AND created_by = huis.current_user_id()
              AND origin_key IS NULL AND decided_by IS NULL AND decided_at IS NULL AND done_at IS NULL);
-- (Every change policy repeats the read conditions.)
CREATE POLICY court_events_update ON huis.court_events FOR UPDATE TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.dna_writable(matter_id) AND huis.court_event_source_ok(source_evidence_id, matter_id))
  WITH CHECK (firm_id = huis.current_firm_id());
-- Huis's proposals can be rejected, never deleted, so the record stays complete.
CREATE POLICY court_events_delete ON huis.court_events FOR DELETE TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.dna_writable(matter_id) AND origin = 'attorney');

-- ---------------------------------------------------------------------------
-- Huis's proposals, saved by the worker while it reads a filed email that is a
-- federal court notice. The quote always comes from the notice itself.
-- ---------------------------------------------------------------------------
CREATE FUNCTION huis.worker_save_court_suggestions(p_source_id uuid, p_lock_token uuid, p_events jsonb) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE
  r huis.brain_sources;
  e jsonb;
  v_text text;
  v_start int;
  v_end int;
  v_quote text;
  v_kind text;
  n int := 0;
BEGIN
  SELECT * INTO r FROM huis.brain_sources WHERE id = p_source_id AND status = 'running' AND lock_token = p_lock_token;
  IF NOT FOUND THEN RAISE EXCEPTION 'source is not held by this worker'; END IF;
  IF r.evidence_id IS NULL THEN RETURN 0; END IF;
  -- Only email filed into the Matter (court notices arrive by email).
  IF NOT EXISTS (SELECT 1 FROM huis.evidence_email m WHERE m.evidence_id = r.evidence_id) THEN RETURN 0; END IF;
  IF jsonb_typeof(p_events) <> 'array' OR jsonb_array_length(p_events) > 20 THEN RAISE EXCEPTION 'invalid court dates'; END IF;
  IF (SELECT count(*) FROM huis.court_events WHERE matter_id = r.matter_id AND origin = 'huis' AND status = 'suggested') >= 1000 THEN
    RETURN 0;
  END IF;
  SELECT left(content, 200000) INTO v_text FROM huis.evidence_text WHERE evidence_id = r.evidence_id;
  IF v_text IS NULL OR position('Notice of Electronic Filing' IN v_text) = 0 THEN RETURN 0; END IF;

  FOR e IN SELECT * FROM jsonb_array_elements(p_events) LOOP
    BEGIN
      v_start := (e->>'start')::int;
      v_end := (e->>'end')::int;
      v_quote := left(btrim(regexp_replace(substr(v_text, v_start + 1, v_end - v_start), '\s+', ' ', 'g')), 1000);
      CONTINUE WHEN v_start < 0 OR v_end <= v_start OR v_end - v_start > 1000 OR coalesce(v_quote, '') = '';
      v_kind := e->>'kind';
      CONTINUE WHEN v_kind NOT IN ('hearing', 'deadline', 'trial', 'conference');
      INSERT INTO huis.court_events (firm_id, matter_id, kind, title, event_date, event_time, location, judge, status, origin, origin_key,
                                     source_evidence_id, char_start, char_end, quote)
        VALUES (r.firm_id, r.matter_id, v_kind, left(e->>'title', 200), (e->>'date')::date, nullif(e->>'time', '')::time,
                left(nullif(e->>'location', ''), 200), left(nullif(e->>'judge', ''), 200), 'suggested', 'huis',
                format('nef:%s:%s:%s', r.evidence_id, v_start, e->>'date'), r.evidence_id, v_start, v_end, v_quote)
        ON CONFLICT (matter_id, origin_key) DO NOTHING;
      IF FOUND THEN n := n + 1; END IF;
    EXCEPTION WHEN others THEN
      -- One odd proposal never stops the rest.
      NULL;
    END;
  END LOOP;
  RETURN n;
END $$;
ALTER FUNCTION huis.worker_save_court_suggestions(uuid, uuid, jsonb) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.worker_save_court_suggestions(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.worker_save_court_suggestions(uuid, uuid, jsonb) TO huis_worker;

-- Court notices already filed are read again, so their dates are proposed too.
UPDATE huis.brain_sources b SET status = 'queued', attempts = 0, last_error = NULL, queued_at = now()
  FROM huis.evidence_text t
 WHERE t.evidence_id = b.evidence_id AND position('Notice of Electronic Filing' IN t.content) > 0
   AND EXISTS (SELECT 1 FROM huis.evidence_email m WHERE m.evidence_id = b.evidence_id);
