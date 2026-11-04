-- Phase 6 part 3: light analysis and Reanalyze Matter.
--
-- The Matter analysis itself is worked out each time it's read, as the reader,
-- by fixed rules (counts and gaps, never a made-up score). What's stored is
-- only when someone last ran "Reanalyze Matter" and the counts at that moment
-- (numbers only, no content), so Huis can say what's new since then.

CREATE TABLE huis.matter_analyses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id     uuid NOT NULL REFERENCES huis.firms(id),
  matter_id   uuid NOT NULL,
  run_by      uuid NOT NULL,
  run_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- Numbers only, e.g. {"evidence": 41, "retried": 2}.
  counts      jsonb NOT NULL DEFAULT '{}'::jsonb
              CHECK (jsonb_typeof(counts) = 'object' AND length(counts::text) <= 2000),
  FOREIGN KEY (firm_id, matter_id) REFERENCES huis.matters(firm_id, id),
  FOREIGN KEY (firm_id, run_by) REFERENCES huis.users(firm_id, id)
);
CREATE INDEX matter_analyses_matter ON huis.matter_analyses (firm_id, matter_id, run_at DESC);

-- Who and when come from the database; every count is a number.
CREATE FUNCTION huis.matter_analysis_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = huis, pg_temp AS $$
BEGIN
  NEW.run_by := huis.current_user_id();
  NEW.run_at := clock_timestamp();
  -- Only these counts, as whole numbers (security review 15, F6: nothing else, not even as a key).
  IF EXISTS (SELECT 1 FROM jsonb_each(NEW.counts) e
              WHERE e.key NOT IN ('evidence', 'notes', 'retried') OR jsonb_typeof(e.value) <> 'number'
                 OR (e.value)::text !~ '^[0-9]{1,9}$') THEN
    RAISE EXCEPTION 'an analysis records numbers only';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER matter_analyses_check BEFORE INSERT ON huis.matter_analyses FOR EACH ROW EXECUTE FUNCTION huis.matter_analysis_check();

ALTER TABLE huis.matter_analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.matter_analyses FORCE ROW LEVEL SECURITY;
-- Records are written only by reanalyze_matter() below (security review 15, F6): the app can read them, not write them.
GRANT SELECT ON huis.matter_analyses TO huis_app;
GRANT SELECT, INSERT ON huis.matter_analyses TO huis_security;

CREATE POLICY matter_analyses_select ON huis.matter_analyses FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.is_internal_role(huis.app_role()) AND huis.can_see_matter(matter_id));

-- A document the Matter Brain gave up on: failed, or still "running" after its last allowed attempt's lock ran out
-- (the worker died on it; it would otherwise wait forever; security review 15, F1).
CREATE FUNCTION huis.brain_source_gave_up(p_status text, p_attempts int, p_locked_until timestamptz) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT p_status = 'failed' OR (p_status = 'running' AND p_attempts >= 5 AND p_locked_until IS NOT NULL AND p_locked_until < now())
$$;
GRANT EXECUTE ON FUNCTION huis.brain_source_gave_up(text, int, timestamptz) TO huis_app, huis_worker;
-- The app may read these two operational columns (no content) to tell "being added" from "gave up".
GRANT SELECT (attempts, locked_until) ON huis.brain_sources TO huis_app;

-- How many times someone has asked the Matter Brain to try a document again (at most 3, so a document that
-- always fails isn't handed back to the worker forever; security review 15, F3).
ALTER TABLE huis.brain_sources ADD COLUMN manual_retries int NOT NULL DEFAULT 0 CHECK (manual_retries BETWEEN 0 AND 3);
CREATE OR REPLACE FUNCTION huis.brain_retry_allowed() RETURNS int LANGUAGE sql IMMUTABLE AS $$ SELECT 3 $$;

-- Reanalyze: the Matter Brain tries again what it gave up on (only sources the caller can see, at most 3 times
-- each), and a record of the moment is written, with numbers the database counts itself: the Matter's top-level
-- items and notes at that moment, and how many were retried. Firm staff who can change the Matter's work.
CREATE FUNCTION huis.reanalyze_matter(p_matter_id uuid) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE n int; v_firm uuid := huis.current_firm_id();
BEGIN
  IF NOT (huis.is_internal_role(huis.app_role()) AND huis.app_role() <> 'read_only' AND huis.can_see_matter(p_matter_id)) THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
  END IF;
  UPDATE huis.brain_sources b
     SET status = 'queued', attempts = 0, last_error = NULL, lock_token = NULL, locked_until = NULL, queued_at = now(),
         manual_retries = b.manual_retries + 1
   WHERE b.matter_id = p_matter_id AND b.firm_id = v_firm
     AND huis.brain_source_gave_up(b.status, b.attempts, b.locked_until)
     AND b.manual_retries < huis.brain_retry_allowed()
     -- Only what the caller could see (security review 15, F2): clean evidence of this Matter, or a note.
     AND ((b.evidence_id IS NOT NULL AND EXISTS (SELECT 1 FROM huis.evidence_items i WHERE i.id = b.evidence_id AND i.matter_id = p_matter_id AND i.status = 'clean'))
          OR (b.note_id IS NOT NULL AND EXISTS (SELECT 1 FROM huis.matter_notes x WHERE x.id = b.note_id AND x.matter_id = p_matter_id)));
  GET DIAGNOSTICS n = ROW_COUNT;
  INSERT INTO huis.matter_analyses (firm_id, matter_id, run_by, counts)
    VALUES (v_firm, p_matter_id, huis.current_user_id(), jsonb_build_object(
      'evidence', (SELECT count(*) FROM huis.evidence_items WHERE matter_id = p_matter_id AND firm_id = v_firm AND parent_id IS NULL),
      'notes', (SELECT count(*) FROM huis.matter_notes WHERE matter_id = p_matter_id AND firm_id = v_firm),
      'retried', n));
  RETURN n;
END $$;
ALTER FUNCTION huis.reanalyze_matter(uuid) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.reanalyze_matter(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.reanalyze_matter(uuid) TO huis_app;
GRANT UPDATE ON huis.brain_sources TO huis_security;
GRANT SELECT ON huis.evidence_items, huis.matter_notes TO huis_security;

-- Kept for direct use: the same retry, without starting a new analysis period.
CREATE FUNCTION huis.brain_retry_failed(p_matter_id uuid) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE n int;
BEGIN
  IF NOT (huis.is_internal_role(huis.app_role()) AND huis.app_role() <> 'read_only' AND huis.can_see_matter(p_matter_id)) THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
  END IF;
  UPDATE huis.brain_sources b
     SET status = 'queued', attempts = 0, last_error = NULL, lock_token = NULL, locked_until = NULL, queued_at = now(),
         manual_retries = b.manual_retries + 1
   WHERE b.matter_id = p_matter_id AND b.firm_id = huis.current_firm_id()
     AND huis.brain_source_gave_up(b.status, b.attempts, b.locked_until)
     AND b.manual_retries < huis.brain_retry_allowed()
     AND ((b.evidence_id IS NOT NULL AND EXISTS (SELECT 1 FROM huis.evidence_items i WHERE i.id = b.evidence_id AND i.matter_id = p_matter_id AND i.status = 'clean'))
          OR (b.note_id IS NOT NULL AND EXISTS (SELECT 1 FROM huis.matter_notes x WHERE x.id = b.note_id AND x.matter_id = p_matter_id)));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
ALTER FUNCTION huis.brain_retry_failed(uuid) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.brain_retry_failed(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.brain_retry_failed(uuid) TO huis_app;
