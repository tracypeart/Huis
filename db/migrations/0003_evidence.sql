-- Huis Law IP — Phase 2: Universal Intake & Evidence Engine
--
-- * evidence_items: one row per received original. Originals are never
--   modified: identity fields (hash, size, storage location, filename,
--   uploader, time) are locked by trigger. Only the scanning worker can change
--   scan status. Moving between folders is allowed and recorded.
-- * evidence_custody_events: append-only, hash-chained chain of custody.
-- * upload_sessions: resumable chunked uploads (large files, whole drives).
-- * jobs: background processing queue (scan, fingerprint, duplicates).
--
-- The background worker connects as a separate role (huis_worker) that can
-- only call the narrow worker_* functions below. It cannot read tables.

SET search_path = huis, public;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'huis_worker') THEN
    CREATE ROLE huis_worker NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA huis TO huis_worker;

CREATE TYPE huis.evidence_status AS ENUM ('pending_scan', 'clean', 'infected', 'scan_failed');
CREATE TYPE huis.evidence_source AS ENUM (
  'upload', 'folder_upload', 'external_drive', 'client_portal', 'email', 'cloud_drive', 'court', 'discovery_production'
);

CREATE TABLE huis.evidence_items (
  id                     uuid PRIMARY KEY,
  firm_id                uuid NOT NULL REFERENCES huis.firms(id),
  matter_id              uuid NOT NULL,
  folder_id              uuid NOT NULL,
  original_filename      text NOT NULL CHECK (length(original_filename) BETWEEN 1 AND 1024),
  relative_path          text CHECK (relative_path IS NULL OR length(relative_path) <= 4096),
  declared_content_type  text,
  detected_content_type  text,
  size_bytes             bigint NOT NULL CHECK (size_bytes >= 0),
  sha256                 char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  storage_key            text NOT NULL UNIQUE,
  status                 huis.evidence_status NOT NULL DEFAULT 'pending_scan',
  scan_detail            text,
  scanned_at             timestamptz,
  source                 huis.evidence_source NOT NULL,
  received_from          text CHECK (received_from IS NULL OR length(received_from) <= 300),
  date_received          date,
  duplicate_of           uuid,
  uploaded_by            uuid NOT NULL,
  uploaded_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (firm_id, id),
  FOREIGN KEY (firm_id, matter_id) REFERENCES huis.matters(firm_id, id),
  FOREIGN KEY (firm_id, folder_id) REFERENCES huis.matter_folders(firm_id, id),
  FOREIGN KEY (firm_id, uploaded_by) REFERENCES huis.users(firm_id, id),
  FOREIGN KEY (firm_id, duplicate_of) REFERENCES huis.evidence_items(firm_id, id)
);
CREATE INDEX evidence_matter ON huis.evidence_items (firm_id, matter_id, uploaded_at DESC);
CREATE INDEX evidence_hash ON huis.evidence_items (firm_id, matter_id, sha256);

CREATE TABLE huis.evidence_custody_events (
  id             bigserial PRIMARY KEY,
  firm_id        uuid NOT NULL REFERENCES huis.firms(id),
  evidence_id    uuid NOT NULL,
  actor_user_id  uuid,               -- NULL = Huis system (scanner, worker)
  event          text NOT NULL CHECK (event ~ '^[a-z_]+$'),
  details        jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_address     inet,
  occurred_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  prev_hash      text,
  hash           text,
  FOREIGN KEY (firm_id, evidence_id) REFERENCES huis.evidence_items(firm_id, id)
);
CREATE INDEX custody_evidence ON huis.evidence_custody_events (evidence_id, id);

CREATE TABLE huis.upload_sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id          uuid NOT NULL REFERENCES huis.firms(id),
  matter_id        uuid NOT NULL,
  folder_id        uuid NOT NULL,
  user_id          uuid NOT NULL,
  filename         text NOT NULL CHECK (length(filename) BETWEEN 1 AND 1024),
  relative_path    text CHECK (relative_path IS NULL OR length(relative_path) <= 4096),
  declared_type    text,
  total_size       bigint NOT NULL CHECK (total_size >= 0),
  chunk_size       int NOT NULL CHECK (chunk_size BETWEEN 262144 AND 67108864),
  chunk_count      int NOT NULL CHECK (chunk_count >= 0),
  received_chunks  int[] NOT NULL DEFAULT '{}',
  source           huis.evidence_source NOT NULL,
  received_from    text,
  date_received    date,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL DEFAULT now() + interval '7 days',
  completed_at     timestamptz,
  evidence_id      uuid,
  FOREIGN KEY (firm_id, matter_id) REFERENCES huis.matters(firm_id, id),
  FOREIGN KEY (firm_id, folder_id) REFERENCES huis.matter_folders(firm_id, id),
  FOREIGN KEY (firm_id, user_id) REFERENCES huis.users(firm_id, id)
);

CREATE TABLE huis.jobs (
  id            bigserial PRIMARY KEY,
  firm_id       uuid NOT NULL REFERENCES huis.firms(id),
  kind          text NOT NULL CHECK (kind IN ('evidence.process')),
  evidence_id   uuid NOT NULL,
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  attempts      int NOT NULL DEFAULT 0,
  run_after     timestamptz NOT NULL DEFAULT now(),
  locked_until  timestamptz,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (firm_id, evidence_id) REFERENCES huis.evidence_items(firm_id, id)
);
CREATE INDEX jobs_ready ON huis.jobs (run_after) WHERE status IN ('queued', 'running');

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Folder classification lookup without recursion through folder policies.
CREATE FUNCTION huis.folder_classification(p_folder_id uuid) RETURNS huis.privilege_classification
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT classification FROM huis.matter_folders
   WHERE id = p_folder_id AND firm_id = huis.current_firm_id()
$$;

CREATE FUNCTION huis.folder_is_privileged_area(p_folder_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT coalesce((SELECT is_privileged_area FROM huis.matter_folders
                    WHERE id = p_folder_id AND firm_id = huis.current_firm_id()), true)
$$;

-- Which folders may someone outside the firm see items in?
CREATE FUNCTION huis.external_may_see_folder(p_folder_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT NOT huis.folder_is_privileged_area(p_folder_id) AND CASE huis.app_role()
    WHEN 'client' THEN huis.folder_classification(p_folder_id) = 'client_accessible'
    WHEN 'co_counsel' THEN huis.folder_classification(p_folder_id) IN ('co_counsel_accessible', 'client_accessible')
    WHEN 'expert_witness' THEN huis.folder_classification(p_folder_id) = 'expert_accessible'
    ELSE false END
$$;

-- Generic chain digest for custody events.
CREATE FUNCTION huis.custody_digest(e huis.evidence_custody_events, p_prev text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(public.digest(concat_ws('|',
    coalesce(p_prev, 'GENESIS'), e.id::text, e.firm_id::text, e.evidence_id::text,
    coalesce(e.actor_user_id::text, 'SYSTEM'), e.event, e.details::text,
    coalesce(host(e.ip_address), ''),
    to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
  ), 'sha256'), 'hex')
$$;

CREATE FUNCTION huis.custody_before_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, public, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.evidence_id::text, 1));
  SELECT hash INTO NEW.prev_hash FROM huis.evidence_custody_events
    WHERE evidence_id = NEW.evidence_id ORDER BY id DESC LIMIT 1;
  NEW.occurred_at := clock_timestamp();
  NEW.hash := huis.custody_digest(NEW, NEW.prev_hash);
  RETURN NEW;
END $$;

CREATE TRIGGER custody_chain BEFORE INSERT ON huis.evidence_custody_events
  FOR EACH ROW EXECUTE FUNCTION huis.custody_before_insert();
CREATE TRIGGER custody_no_update BEFORE UPDATE OR DELETE ON huis.evidence_custody_events
  FOR EACH ROW EXECUTE FUNCTION huis.audit_events_immutable();
CREATE TRIGGER custody_no_truncate BEFORE TRUNCATE ON huis.evidence_custody_events
  FOR EACH STATEMENT EXECUTE FUNCTION huis.audit_events_immutable();

-- Returns the first broken custody event id for an item, or NULL if intact.
CREATE FUNCTION huis.verify_custody_chain(p_evidence_id uuid) RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = huis, public, pg_temp AS $$
DECLARE
  r      huis.evidence_custody_events;
  v_prev text := NULL;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM huis.evidence_items i WHERE i.id = p_evidence_id
                 AND i.firm_id = huis.current_firm_id() AND huis.can_see_matter(i.matter_id)) THEN
    RAISE EXCEPTION 'not permitted';
  END IF;
  FOR r IN SELECT * FROM huis.evidence_custody_events WHERE evidence_id = p_evidence_id ORDER BY id LOOP
    IF r.prev_hash IS DISTINCT FROM v_prev OR r.hash IS DISTINCT FROM huis.custody_digest(r, v_prev) THEN
      RETURN r.id;
    END IF;
    v_prev := r.hash;
  END LOOP;
  RETURN NULL;
END $$;

-- Originals are immutable. Only the worker (running as huis_security through
-- worker_* functions) may set scan results and duplicate links. People may
-- move an item to another folder of the same matter.
CREATE FUNCTION huis.evidence_guard_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.firm_id <> OLD.firm_id OR NEW.matter_id <> OLD.matter_id
     OR NEW.original_filename <> OLD.original_filename
     OR NEW.relative_path IS DISTINCT FROM OLD.relative_path
     OR NEW.size_bytes <> OLD.size_bytes OR NEW.sha256 <> OLD.sha256
     OR NEW.storage_key <> OLD.storage_key OR NEW.uploaded_by <> OLD.uploaded_by
     OR NEW.uploaded_at <> OLD.uploaded_at OR NEW.source <> OLD.source
     OR NEW.declared_content_type IS DISTINCT FROM OLD.declared_content_type THEN
    RAISE EXCEPTION 'original evidence is immutable';
  END IF;
  IF current_user <> 'huis_security' AND (
       NEW.status IS DISTINCT FROM OLD.status OR NEW.scan_detail IS DISTINCT FROM OLD.scan_detail
       OR NEW.scanned_at IS DISTINCT FROM OLD.scanned_at
       OR NEW.detected_content_type IS DISTINCT FROM OLD.detected_content_type
       OR NEW.duplicate_of IS DISTINCT FROM OLD.duplicate_of) THEN
    RAISE EXCEPTION 'scan results can only be recorded by the Huis scanner';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER evidence_guard BEFORE UPDATE ON huis.evidence_items
  FOR EACH ROW EXECUTE FUNCTION huis.evidence_guard_update();
CREATE TRIGGER evidence_no_delete BEFORE DELETE OR TRUNCATE ON huis.evidence_items
  FOR EACH STATEMENT EXECUTE FUNCTION huis.audit_events_immutable();

-- ---------------------------------------------------------------------------
-- Worker functions (callable only by huis_worker)
-- ---------------------------------------------------------------------------

CREATE FUNCTION huis.worker_claim_job()
RETURNS TABLE (job_id bigint, firm_id uuid, evidence_id uuid, storage_key text, sha256 text,
               size_bytes bigint, matter_id uuid, attempts int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_job huis.jobs;
BEGIN
  SELECT * INTO v_job FROM huis.jobs j
   WHERE (j.status = 'queued' OR (j.status = 'running' AND j.locked_until < now()))
     AND j.run_after <= now()
   ORDER BY j.id
   FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE huis.jobs SET status = 'running', attempts = attempts + 1,
         locked_until = now() + interval '15 minutes' WHERE id = v_job.id;
  RETURN QUERY SELECT v_job.id, i.firm_id, i.id, i.storage_key, i.sha256::text, i.size_bytes,
                      i.matter_id, v_job.attempts + 1
    FROM huis.evidence_items i WHERE i.id = v_job.evidence_id;
END $$;

CREATE FUNCTION huis.worker_complete(
  p_job_id bigint, p_status huis.evidence_status, p_detail text, p_detected_type text,
  p_verified_sha256 text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE
  v_job  huis.jobs;
  v_item huis.evidence_items;
  v_dup  uuid;
BEGIN
  SELECT * INTO v_job FROM huis.jobs WHERE id = p_job_id AND status = 'running' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'job not running'; END IF;
  SELECT * INTO v_item FROM huis.evidence_items WHERE id = v_job.evidence_id FOR UPDATE;

  IF p_verified_sha256 IS DISTINCT FROM v_item.sha256::text THEN
    -- Stored bytes no longer match the fingerprint taken at upload.
    p_status := 'scan_failed';
    p_detail := 'Integrity check failed: stored file does not match its original fingerprint.';
  END IF;

  IF p_status = 'clean' THEN
    SELECT e.id INTO v_dup FROM huis.evidence_items e
     WHERE e.firm_id = v_item.firm_id AND e.matter_id = v_item.matter_id
       AND e.sha256 = v_item.sha256 AND e.id <> v_item.id AND e.uploaded_at <= v_item.uploaded_at
       AND e.status = 'clean'
     ORDER BY e.uploaded_at, e.id LIMIT 1;
  END IF;

  UPDATE huis.evidence_items
     SET status = p_status, scan_detail = left(p_detail, 500), scanned_at = now(),
         detected_content_type = left(p_detected_type, 200), duplicate_of = v_dup
   WHERE id = v_item.id;

  INSERT INTO huis.evidence_custody_events (firm_id, evidence_id, event, details)
    VALUES (v_item.firm_id, v_item.id, 'integrity_verified',
            jsonb_build_object('sha256_matches', p_verified_sha256 IS NOT DISTINCT FROM v_item.sha256::text));
  INSERT INTO huis.evidence_custody_events (firm_id, evidence_id, event, details)
    VALUES (v_item.firm_id, v_item.id,
            CASE p_status WHEN 'clean' THEN 'scanned_clean' WHEN 'infected' THEN 'scanned_infected' ELSE 'scan_failed' END,
            jsonb_build_object('detail', left(p_detail, 500), 'detected_type', p_detected_type));
  IF v_dup IS NOT NULL THEN
    INSERT INTO huis.evidence_custody_events (firm_id, evidence_id, event, details)
      VALUES (v_item.firm_id, v_item.id, 'duplicate_detected', jsonb_build_object('duplicate_of', v_dup));
  END IF;

  UPDATE huis.jobs SET status = 'done', locked_until = NULL, last_error = NULL WHERE id = p_job_id;
END $$;

CREATE FUNCTION huis.worker_fail(p_job_id bigint, p_error text, p_final boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE
  v_job huis.jobs;
BEGIN
  SELECT * INTO v_job FROM huis.jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF p_final THEN
    UPDATE huis.jobs SET status = 'failed', locked_until = NULL, last_error = left(p_error, 500) WHERE id = p_job_id;
    UPDATE huis.evidence_items SET status = 'scan_failed', scan_detail = 'Processing failed; the file is held and cannot be opened.',
           scanned_at = now() WHERE id = v_job.evidence_id AND status = 'pending_scan';
    INSERT INTO huis.evidence_custody_events (firm_id, evidence_id, event, details)
      VALUES (v_job.firm_id, v_job.evidence_id, 'scan_failed', jsonb_build_object('detail', 'processing failed'));
  ELSE
    UPDATE huis.jobs SET status = 'queued', locked_until = NULL, last_error = left(p_error, 500),
           run_after = now() + make_interval(secs => least(3600, 30 * power(2, v_job.attempts))::int)
     WHERE id = p_job_id;
  END IF;
END $$;

ALTER FUNCTION huis.folder_classification(uuid) OWNER TO huis_security;
ALTER FUNCTION huis.folder_is_privileged_area(uuid) OWNER TO huis_security;
ALTER FUNCTION huis.external_may_see_folder(uuid) OWNER TO huis_security;
ALTER FUNCTION huis.custody_before_insert() OWNER TO huis_security;
ALTER FUNCTION huis.verify_custody_chain(uuid) OWNER TO huis_security;
ALTER FUNCTION huis.worker_claim_job() OWNER TO huis_security;
ALTER FUNCTION huis.worker_complete(bigint, huis.evidence_status, text, text, text) OWNER TO huis_security;
ALTER FUNCTION huis.worker_fail(bigint, text, boolean) OWNER TO huis_security;

REVOKE ALL ON FUNCTION huis.folder_classification(uuid), huis.folder_is_privileged_area(uuid),
  huis.external_may_see_folder(uuid), huis.custody_digest(huis.evidence_custody_events, text),
  huis.verify_custody_chain(uuid), huis.worker_claim_job(),
  huis.worker_complete(bigint, huis.evidence_status, text, text, text),
  huis.worker_fail(bigint, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.folder_classification(uuid), huis.folder_is_privileged_area(uuid),
  huis.external_may_see_folder(uuid), huis.verify_custody_chain(uuid) TO huis_app;
GRANT EXECUTE ON FUNCTION huis.custody_digest(huis.evidence_custody_events, text) TO huis_security;
GRANT EXECUTE ON FUNCTION huis.worker_claim_job(),
  huis.worker_complete(bigint, huis.evidence_status, text, text, text),
  huis.worker_fail(bigint, text, boolean) TO huis_worker;

-- ---------------------------------------------------------------------------
-- Privileges and row-level security
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON huis.evidence_items TO huis_app;
GRANT SELECT, INSERT ON huis.evidence_custody_events TO huis_app;
GRANT SELECT, INSERT, UPDATE ON huis.upload_sessions TO huis_app;
GRANT INSERT ON huis.jobs TO huis_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON huis.evidence_items, huis.evidence_custody_events,
  huis.upload_sessions, huis.jobs TO huis_security;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA huis TO huis_app, huis_security;

ALTER TABLE huis.evidence_items          ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.evidence_custody_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.upload_sessions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.jobs                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.evidence_items          FORCE ROW LEVEL SECURITY;
ALTER TABLE huis.evidence_custody_events FORCE ROW LEVEL SECURITY;
ALTER TABLE huis.upload_sessions         FORCE ROW LEVEL SECURITY;
ALTER TABLE huis.jobs                    FORCE ROW LEVEL SECURITY;

-- Who can see an item: anyone who can see the matter, except that people
-- outside the firm never see the red privileged area and only see folders
-- shared with their role — plus anything they uploaded themselves.
CREATE FUNCTION huis.can_see_evidence(p_matter_id uuid, p_folder_id uuid, p_uploaded_by uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT huis.can_see_matter(p_matter_id) AND (
    huis.is_internal_role(huis.app_role())
    OR huis.external_may_see_folder(p_folder_id)
    OR p_uploaded_by = huis.current_user_id()
  )
$$;
GRANT EXECUTE ON FUNCTION huis.can_see_evidence(uuid, uuid, uuid) TO huis_app;

CREATE POLICY evidence_select ON huis.evidence_items FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.can_see_evidence(matter_id, folder_id, uploaded_by));
CREATE POLICY evidence_insert ON huis.evidence_items FOR INSERT TO huis_app
  WITH CHECK (firm_id = huis.current_firm_id() AND uploaded_by = huis.current_user_id()
              AND status = 'pending_scan' AND duplicate_of IS NULL AND huis.can_see_matter(matter_id)
              AND huis.app_role() <> 'read_only'
              AND (huis.is_internal_role(huis.app_role())
                   OR (huis.app_role() = 'client' AND huis.folder_classification(folder_id) = 'client_accessible')));
CREATE POLICY evidence_update ON huis.evidence_items FOR UPDATE TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.can_see_matter(matter_id)
         AND huis.is_internal_role(huis.app_role()) AND huis.app_role() <> 'read_only')
  WITH CHECK (firm_id = huis.current_firm_id());

CREATE POLICY custody_select ON huis.evidence_custody_events FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND EXISTS (
    SELECT 1 FROM huis.evidence_items i WHERE i.id = evidence_id));
CREATE POLICY custody_insert ON huis.evidence_custody_events FOR INSERT TO huis_app
  WITH CHECK (firm_id = huis.current_firm_id() AND actor_user_id = huis.current_user_id()
              AND event IN ('received', 'viewed', 'downloaded', 'moved')
              AND EXISTS (SELECT 1 FROM huis.evidence_items i WHERE i.id = evidence_id));

CREATE POLICY uploads_own ON huis.upload_sessions FOR ALL TO huis_app
  USING (firm_id = huis.current_firm_id() AND user_id = huis.current_user_id())
  WITH CHECK (firm_id = huis.current_firm_id() AND user_id = huis.current_user_id()
              AND huis.can_see_matter(matter_id) AND huis.app_role() <> 'read_only'
              AND (huis.is_internal_role(huis.app_role())
                   OR (huis.app_role() = 'client' AND huis.folder_classification(folder_id) = 'client_accessible'
                       AND NOT huis.folder_is_privileged_area(folder_id))));

CREATE POLICY jobs_enqueue ON huis.jobs FOR INSERT TO huis_app
  WITH CHECK (firm_id = huis.current_firm_id() AND status = 'queued'
              AND EXISTS (SELECT 1 FROM huis.evidence_items i WHERE i.id = evidence_id));
