-- Phase 6 part 1: AI Workspace and Prompt Library.
--
-- AI Workspace: saved conversations inside a Matter, each a series of Matter
-- Brain questions and answers, with a category (strategy, research,
-- deposition…). A conversation is private to its owner unless the owner
-- shares it with the firm staff on the Matter. Every answer is still shown
-- only while every source it drew on is available to the person *reading*
-- it, so sharing never reveals a document someone can't open.
--
-- Prompt Library: personal prompts (only their owner), firm prompts
-- (approved templates, managed by firm administrators, visible to all firm
-- staff) and Huis's built-in prompts (in the code).
--
-- Work product: firm staff only. Clients and other outside users never see either.

CREATE TABLE huis.ai_conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id     uuid NOT NULL REFERENCES huis.firms(id),
  matter_id   uuid NOT NULL,
  owner_id    uuid NOT NULL,
  title       text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  category    text NOT NULL CHECK (category IN ('strategy', 'research', 'deposition', 'discovery', 'timeline', 'damages',
                                                 'motion', 'trial', 'client', 'miscellaneous')),
  shared      boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (firm_id, id),
  FOREIGN KEY (firm_id, matter_id) REFERENCES huis.matters(firm_id, id),
  FOREIGN KEY (firm_id, owner_id) REFERENCES huis.users(firm_id, id)
);
CREATE INDEX ai_conversations_matter ON huis.ai_conversations (firm_id, matter_id, updated_at DESC);

-- Who owns a conversation, and where it lives, never change.
CREATE FUNCTION huis.ai_conversation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.firm_id IS DISTINCT FROM OLD.firm_id OR NEW.matter_id IS DISTINCT FROM OLD.matter_id
     OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a conversation stays with its owner and Matter';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER ai_conversations_guard BEFORE UPDATE ON huis.ai_conversations FOR EACH ROW EXECUTE FUNCTION huis.ai_conversation_guard();

ALTER TABLE huis.ai_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.ai_conversations FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON huis.ai_conversations TO huis_app;
GRANT SELECT, DELETE ON huis.ai_conversations TO huis_security;

-- Firm staff on the Matter see their own conversations and shared ones; only the owner changes one.
CREATE POLICY ai_conversations_select ON huis.ai_conversations FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.is_internal_role(huis.app_role()) AND huis.can_see_matter(matter_id)
         AND (owner_id = huis.current_user_id() OR shared));
CREATE POLICY ai_conversations_insert ON huis.ai_conversations FOR INSERT TO huis_app
  WITH CHECK (firm_id = huis.current_firm_id() AND huis.is_internal_role(huis.app_role()) AND huis.can_see_matter(matter_id)
              AND owner_id = huis.current_user_id());
CREATE POLICY ai_conversations_update ON huis.ai_conversations FOR UPDATE TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.is_internal_role(huis.app_role()) AND huis.can_see_matter(matter_id)
         AND owner_id = huis.current_user_id())
  WITH CHECK (firm_id = huis.current_firm_id() AND owner_id = huis.current_user_id());
CREATE POLICY ai_conversations_delete ON huis.ai_conversations FOR DELETE TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.is_internal_role(huis.app_role()) AND owner_id = huis.current_user_id());

-- ---------------------------------------------------------------------------
-- Answers belong to a conversation (or to nobody's conversation: the Brain's "My questions").
-- ---------------------------------------------------------------------------
ALTER TABLE huis.brain_answers ADD COLUMN conversation_id uuid REFERENCES huis.ai_conversations(id) ON DELETE CASCADE;
CREATE INDEX brain_answers_conversation ON huis.brain_answers (conversation_id, created_at) WHERE conversation_id IS NOT NULL;

-- An answer joins only its asker's own conversation, in the same Matter.
CREATE FUNCTION huis.brain_answer_conversation_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = huis, pg_temp AS $$
BEGIN
  IF NEW.conversation_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM huis.ai_conversations c
        WHERE c.id = NEW.conversation_id AND c.firm_id = NEW.firm_id AND c.matter_id = NEW.matter_id AND c.owner_id = NEW.asked_by) THEN
    RAISE EXCEPTION 'an answer can only join its asker''s own conversation in the same Matter';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER brain_answers_conversation_check BEFORE INSERT ON huis.brain_answers
  FOR EACH ROW EXECUTE FUNCTION huis.brain_answer_conversation_check();

-- Readable by the asker, or by anyone who can see the shared conversation it belongs to;
-- either way only while every source it drew on is available to the person reading it.
DROP POLICY brain_answers_select ON huis.brain_answers;
CREATE POLICY brain_answers_select ON huis.brain_answers FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.is_internal_role(huis.app_role()) AND huis.can_see_matter(matter_id)
         AND huis.brain_answer_sources_visible(matter_id, source_evidence, source_notes)
         AND (asked_by = huis.current_user_id()
              OR (conversation_id IS NOT NULL
                  AND EXISTS (SELECT 1 FROM huis.ai_conversations c WHERE c.id = conversation_id AND c.shared))));

-- How many answers a conversation holds in all (for a conversation the reader can see). The app
-- counts the ones the reader can open under row-level security; the difference is how many are
-- withheld from them. A count only: nothing about the withheld answers themselves.
CREATE FUNCTION huis.ai_conversation_answer_count(p_conversation_id uuid) RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT count(*)::int FROM huis.brain_answers a JOIN huis.ai_conversations c ON c.id = a.conversation_id
   WHERE a.conversation_id = p_conversation_id
     AND c.firm_id = huis.current_firm_id() AND huis.is_internal_role(huis.app_role()) AND huis.can_see_matter(c.matter_id)
     AND (c.owner_id = huis.current_user_id() OR c.shared)
$$;
ALTER FUNCTION huis.ai_conversation_answer_count(uuid) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.ai_conversation_answer_count(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.ai_conversation_answer_count(uuid) TO huis_app;
GRANT SELECT ON huis.brain_answers TO huis_security;

-- ---------------------------------------------------------------------------
-- Prompt Library: personal prompts and firm prompts (built-in ones live in the code).
-- ---------------------------------------------------------------------------
CREATE TABLE huis.ai_prompts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id     uuid NOT NULL REFERENCES huis.firms(id),
  scope       text NOT NULL CHECK (scope IN ('personal', 'firm')),
  owner_id    uuid,
  created_by  uuid NOT NULL,
  title       text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  body        text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 2000),
  category    text NOT NULL CHECK (category IN ('strategy', 'research', 'deposition', 'discovery', 'timeline', 'damages',
                                                 'motion', 'trial', 'client', 'miscellaneous')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'personal') = (owner_id IS NOT NULL)),
  FOREIGN KEY (firm_id, owner_id) REFERENCES huis.users(firm_id, id),
  FOREIGN KEY (firm_id, created_by) REFERENCES huis.users(firm_id, id)
);
CREATE INDEX ai_prompts_firm ON huis.ai_prompts (firm_id, scope, category);

CREATE FUNCTION huis.ai_prompt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.firm_id IS DISTINCT FROM OLD.firm_id OR NEW.scope IS DISTINCT FROM OLD.scope OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a prompt keeps its owner and scope';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER ai_prompts_guard BEFORE UPDATE ON huis.ai_prompts FOR EACH ROW EXECUTE FUNCTION huis.ai_prompt_guard();

CREATE FUNCTION huis.is_firm_admin() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT huis.app_role()::text IN ('firm_owner', 'managing_partner', 'firm_admin')
$$;
GRANT EXECUTE ON FUNCTION huis.is_firm_admin() TO huis_app;

ALTER TABLE huis.ai_prompts ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.ai_prompts FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON huis.ai_prompts TO huis_app;

-- Firm prompts: every firm staff member reads them, administrators manage them. Personal prompts: their owner only.
CREATE POLICY ai_prompts_select ON huis.ai_prompts FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.is_internal_role(huis.app_role())
         AND (scope = 'firm' OR owner_id = huis.current_user_id()));
CREATE POLICY ai_prompts_insert ON huis.ai_prompts FOR INSERT TO huis_app
  WITH CHECK (firm_id = huis.current_firm_id() AND huis.is_internal_role(huis.app_role()) AND created_by = huis.current_user_id()
              AND ((scope = 'personal' AND owner_id = huis.current_user_id()) OR (scope = 'firm' AND huis.is_firm_admin())));
CREATE POLICY ai_prompts_update ON huis.ai_prompts FOR UPDATE TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.is_internal_role(huis.app_role())
         AND ((scope = 'personal' AND owner_id = huis.current_user_id()) OR (scope = 'firm' AND huis.is_firm_admin())))
  WITH CHECK (firm_id = huis.current_firm_id());
CREATE POLICY ai_prompts_delete ON huis.ai_prompts FOR DELETE TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.is_internal_role(huis.app_role())
         AND ((scope = 'personal' AND owner_id = huis.current_user_id()) OR (scope = 'firm' AND huis.is_firm_admin())));

-- ---------------------------------------------------------------------------
-- Security review 13
-- ---------------------------------------------------------------------------
-- F1: someone walled out of a Matter can't delete its conversations or answers either
-- (a DELETE with no WHERE clause would otherwise skip the visibility rule).
DROP POLICY ai_conversations_delete ON huis.ai_conversations;
CREATE POLICY ai_conversations_delete ON huis.ai_conversations FOR DELETE TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.is_internal_role(huis.app_role()) AND huis.can_see_matter(matter_id)
         AND owner_id = huis.current_user_id());
DROP POLICY brain_answers_delete ON huis.brain_answers;
CREATE POLICY brain_answers_delete ON huis.brain_answers FOR DELETE TO huis_app
  USING (firm_id = huis.current_firm_id() AND asked_by = huis.current_user_id() AND huis.is_internal_role(huis.app_role())
         AND huis.can_see_matter(matter_id));

-- F2: an answer colleagues may read must be what Huis produced, not text someone wrote into the table.
-- The database rebuilds its citations and sources from the passages it cites (only passages of this
-- Matter that the asker can open), stamps the time itself, and for the built-in AI checks that the
-- answer is in the built-in form and every quoted line is words the cited passage really contains.
-- Outside providers (Phase 6 part 4) will add their own rule here when they are added.
CREATE FUNCTION huis.brain_answer_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = huis, pg_temp AS $$
DECLARE
  c jsonb;
  ch huis.brain_chunks;
  v_out jsonb := '[]'::jsonb;
  v_ev uuid[] := '{}';
  v_notes uuid[] := '{}';
  v_text text := '';
  v_quote text[];
  v_found boolean;
BEGIN
  NEW.created_at := clock_timestamp();  -- the moment it was written, so turns asked together keep their order
  IF jsonb_typeof(NEW.citations) <> 'array' OR jsonb_array_length(NEW.citations) > 50 THEN RAISE EXCEPTION 'invalid citations'; END IF;
  FOR c IN SELECT * FROM jsonb_array_elements(NEW.citations) LOOP
    -- Row-level security applies (this runs as the asker): only passages they can open, in this Matter.
    SELECT * INTO ch FROM huis.brain_chunks
     WHERE id = CASE WHEN c->>'chunkId' ~ '^[0-9]{1,18}$' THEN (c->>'chunkId')::bigint END AND matter_id = NEW.matter_id;
    IF NOT FOUND OR jsonb_typeof(c->'n') <> 'number' THEN RAISE EXCEPTION 'an answer can only cite passages of its own Matter'; END IF;
    v_out := v_out || jsonb_build_object('n', (c->>'n')::int, 'chunkId', ch.id::text, 'evidenceId', ch.evidence_id, 'noteId', ch.note_id,
                                         'start', ch.char_start, 'end', ch.char_end);
    IF ch.evidence_id IS NOT NULL AND NOT ch.evidence_id = ANY (v_ev) THEN v_ev := v_ev || ch.evidence_id; END IF;
    IF ch.note_id IS NOT NULL AND NOT ch.note_id = ANY (v_notes) THEN v_notes := v_notes || ch.note_id; END IF;
  END LOOP;
  NEW.citations := v_out;
  NEW.source_evidence := v_ev;
  NEW.source_notes := v_notes;

  IF NEW.provider <> 'local' THEN RAISE EXCEPTION 'unknown AI provider'; END IF;
  IF NEW.answer = 'Huis didn''t find passages in this Matter that match the question. Try other words, or check that the documents have finished being read.' THEN
    IF jsonb_array_length(v_out) > 0 THEN RAISE EXCEPTION 'an answer that found nothing cites nothing'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.answer !~ '^The most relevant passages in this Matter:\n\n(• “[^”]*” \[[0-9]{1,2}\](\n|$))+$' THEN
    RAISE EXCEPTION 'not an answer from the built-in AI';
  END IF;
  FOR v_quote IN SELECT regexp_matches(NEW.answer, '• “([^”]*)” \[([0-9]{1,2})\]', 'g') LOOP
    SELECT replace(regexp_replace(k.content, '\s+', ' ', 'g'), '”', '"') INTO v_text
      FROM jsonb_array_elements(v_out) x JOIN huis.brain_chunks k ON k.id = (x->>'chunkId')::bigint
     WHERE (x->>'n')::int = v_quote[2]::int LIMIT 1;
    v_found := v_text IS NOT NULL AND length(v_quote[1]) > 0 AND position(v_quote[1] IN v_text) > 0;
    IF NOT v_found THEN RAISE EXCEPTION 'a quoted line must be words from the passage it cites'; END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER brain_answers_check BEFORE INSERT ON huis.brain_answers FOR EACH ROW EXECUTE FUNCTION huis.brain_answer_check();
