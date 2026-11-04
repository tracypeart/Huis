-- Phase 6 part 2: specialized agents behind one interface.
--
-- An agent's turn in an AI Workspace conversation stores only the question,
-- which agent answered and the settings it used (dates, person, element,
-- subject words). Never the answer itself: the answer is worked out again,
-- as the person reading it, each time the conversation is opened. So an
-- agent's answer is always current, can't be forged by writing to the table,
-- and sharing a conversation never shows a reader anything they can't open.
-- (Matter Brain answers stay in brain_answers, checked by the database.)

CREATE TABLE huis.ai_agent_turns (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id          uuid NOT NULL REFERENCES huis.firms(id),
  matter_id        uuid NOT NULL,
  conversation_id  uuid NOT NULL REFERENCES huis.ai_conversations(id) ON DELETE CASCADE,
  asked_by         uuid NOT NULL,
  question         text NOT NULL CHECK (length(btrim(question)) BETWEEN 1 AND 2000),
  agent            text NOT NULL CHECK (agent IN ('timeline', 'email', 'evidence', 'contradictions', 'privilege')),
  params           jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(params) = 'object' AND length(params::text) <= 4000),
  why              text NOT NULL CHECK (length(why) <= 2000),
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (firm_id, matter_id) REFERENCES huis.matters(firm_id, id),
  FOREIGN KEY (firm_id, asked_by) REFERENCES huis.users(firm_id, id)
);
CREATE INDEX ai_agent_turns_conversation ON huis.ai_agent_turns (conversation_id, created_at);

-- A turn joins only its asker's own conversation, in the same Matter, at the time the database says.
CREATE FUNCTION huis.ai_agent_turn_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = huis, pg_temp AS $$
BEGIN
  NEW.created_at := now();
  IF NOT EXISTS (SELECT 1 FROM huis.ai_conversations c
                  WHERE c.id = NEW.conversation_id AND c.firm_id = NEW.firm_id AND c.matter_id = NEW.matter_id AND c.owner_id = NEW.asked_by) THEN
    RAISE EXCEPTION 'a turn can only join its asker''s own conversation in the same Matter';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ai_agent_turns_check BEFORE INSERT ON huis.ai_agent_turns FOR EACH ROW EXECUTE FUNCTION huis.ai_agent_turn_check();

ALTER TABLE huis.ai_agent_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.ai_agent_turns FORCE ROW LEVEL SECURITY;
-- No UPDATE: a turn is what was asked, when.
GRANT SELECT, INSERT, DELETE ON huis.ai_agent_turns TO huis_app;
GRANT SELECT, DELETE ON huis.ai_agent_turns TO huis_security;

-- Visible with its conversation (the owner's, or a shared one), to firm staff who can see the Matter.
CREATE POLICY ai_agent_turns_select ON huis.ai_agent_turns FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.is_internal_role(huis.app_role()) AND huis.can_see_matter(matter_id)
         AND EXISTS (SELECT 1 FROM huis.ai_conversations c WHERE c.id = conversation_id));
CREATE POLICY ai_agent_turns_insert ON huis.ai_agent_turns FOR INSERT TO huis_app
  WITH CHECK (firm_id = huis.current_firm_id() AND huis.is_internal_role(huis.app_role()) AND huis.can_see_matter(matter_id)
              AND asked_by = huis.current_user_id());
-- (Every change rule repeats the visibility conditions: a DELETE with no WHERE clause must never reach other rows.)
CREATE POLICY ai_agent_turns_delete ON huis.ai_agent_turns FOR DELETE TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.is_internal_role(huis.app_role()) AND huis.can_see_matter(matter_id)
         AND asked_by = huis.current_user_id());

