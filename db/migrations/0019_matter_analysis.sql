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
  IF EXISTS (SELECT 1 FROM jsonb_each(NEW.counts) e WHERE jsonb_typeof(e.value) <> 'number') THEN
    RAISE EXCEPTION 'an analysis records numbers only';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER matter_analyses_check BEFORE INSERT ON huis.matter_analyses FOR EACH ROW EXECUTE FUNCTION huis.matter_analysis_check();

ALTER TABLE huis.matter_analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.matter_analyses FORCE ROW LEVEL SECURITY;
-- No UPDATE or DELETE: the record of when the Matter was analyzed stays.
GRANT SELECT, INSERT ON huis.matter_analyses TO huis_app;
GRANT SELECT ON huis.matter_analyses TO huis_security;

CREATE POLICY matter_analyses_select ON huis.matter_analyses FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.is_internal_role(huis.app_role()) AND huis.can_see_matter(matter_id));
CREATE POLICY matter_analyses_insert ON huis.matter_analyses FOR INSERT TO huis_app
  WITH CHECK (firm_id = huis.current_firm_id() AND huis.is_internal_role(huis.app_role()) AND huis.app_role() <> 'read_only'
              AND huis.can_see_matter(matter_id));

-- Reanalyze: the Matter Brain tries again everything in this Matter it couldn't read before.
-- Only firm staff who can change the Matter's work (not read-only staff) who can see the Matter.
CREATE FUNCTION huis.brain_retry_failed(p_matter_id uuid) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE n int;
BEGIN
  IF NOT (huis.is_internal_role(huis.app_role()) AND huis.app_role() <> 'read_only' AND huis.can_see_matter(p_matter_id)) THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
  END IF;
  UPDATE huis.brain_sources SET status = 'queued', attempts = 0, last_error = NULL, lock_token = NULL, locked_until = NULL, queued_at = now()
   WHERE matter_id = p_matter_id AND firm_id = huis.current_firm_id() AND status = 'failed';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
ALTER FUNCTION huis.brain_retry_failed(uuid) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.brain_retry_failed(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.brain_retry_failed(uuid) TO huis_app;
GRANT UPDATE ON huis.brain_sources TO huis_security;
