-- Huis Law IP — Phase 2 part 2: make evidence readable and searchable
--
-- * evidence_text: extracted text per item + full-text index. Visibility is
--   exactly the item's own visibility (walls, privilege area, outsiders).
-- * evidence_email: headers of email items (from, to, subject, date…).
-- * Derived items: email attachments and archive contents become their own
--   evidence items (parent_id), are fingerprinted, scanned and have custody.
-- * Jobs: a clean scan queues extraction; only the worker can record results.
--
-- Note on storage: extracted text lives in the database (so it can be
-- searched) and is protected by row-level security and the database's own
-- encryption at rest in production. Original files stay in the per-firm
-- encrypted vault.

SET search_path = huis, public;

ALTER TYPE huis.evidence_source ADD VALUE IF NOT EXISTS 'extracted';

CREATE TYPE huis.extraction_status AS ENUM (
  'pending', 'done', 'partial', 'no_text', 'unsupported', 'needs_provider', 'failed'
);

ALTER TABLE huis.evidence_items
  ADD COLUMN parent_id uuid,
  ADD COLUMN container_path text CHECK (container_path IS NULL OR length(container_path) <= 4096),
  ADD COLUMN depth int NOT NULL DEFAULT 0 CHECK (depth BETWEEN 0 AND 5),
  ADD COLUMN extraction_status huis.extraction_status,
  ADD COLUMN extraction_detail text,
  ADD COLUMN page_count int,
  ADD CONSTRAINT evidence_parent_fk FOREIGN KEY (firm_id, parent_id) REFERENCES huis.evidence_items(firm_id, id);
CREATE INDEX evidence_parent ON huis.evidence_items (parent_id) WHERE parent_id IS NOT NULL;

CREATE OR REPLACE FUNCTION huis.evidence_guard_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.firm_id <> OLD.firm_id OR NEW.matter_id <> OLD.matter_id
     OR NEW.original_filename <> OLD.original_filename
     OR NEW.relative_path IS DISTINCT FROM OLD.relative_path
     OR NEW.size_bytes <> OLD.size_bytes OR NEW.sha256 <> OLD.sha256
     OR NEW.storage_key <> OLD.storage_key OR NEW.uploaded_by <> OLD.uploaded_by
     OR NEW.uploaded_at <> OLD.uploaded_at OR NEW.source <> OLD.source
     OR NEW.declared_content_type IS DISTINCT FROM OLD.declared_content_type
     OR NEW.received_from IS DISTINCT FROM OLD.received_from
     OR NEW.date_received IS DISTINCT FROM OLD.date_received
     OR NEW.parent_id IS DISTINCT FROM OLD.parent_id
     OR NEW.container_path IS DISTINCT FROM OLD.container_path
     OR NEW.depth <> OLD.depth THEN
    RAISE EXCEPTION 'original evidence is immutable';
  END IF;
  IF current_user <> 'huis_security' THEN
    RAISE EXCEPTION 'evidence can only be changed through Huis (scanner results and recorded moves)';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- Text, email headers
-- ---------------------------------------------------------------------------
CREATE TABLE huis.evidence_text (
  evidence_id  uuid PRIMARY KEY,
  firm_id      uuid NOT NULL,
  content      text NOT NULL,
  method       text NOT NULL CHECK (method IN ('native', 'ocr', 'transcript', 'mixed')),
  char_count   int NOT NULL,
  truncated    boolean NOT NULL DEFAULT false,
  tsv          tsvector GENERATED ALWAYS AS (to_tsvector('english', left(content, 1000000))) STORED,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (firm_id, evidence_id) REFERENCES huis.evidence_items(firm_id, id)
);
CREATE INDEX evidence_text_tsv ON huis.evidence_text USING gin (tsv);

CREATE TABLE huis.evidence_email (
  evidence_id  uuid PRIMARY KEY,
  firm_id      uuid NOT NULL,
  from_addr    text,
  to_addrs     text[] NOT NULL DEFAULT '{}',
  cc_addrs     text[] NOT NULL DEFAULT '{}',
  bcc_addrs    text[] NOT NULL DEFAULT '{}',
  subject      text,
  sent_at      timestamptz,
  message_id   text,
  in_reply_to  text,
  attachment_count int NOT NULL DEFAULT 0,
  FOREIGN KEY (firm_id, evidence_id) REFERENCES huis.evidence_items(firm_id, id)
);
CREATE INDEX evidence_email_sent ON huis.evidence_email (firm_id, sent_at);

ALTER TABLE huis.evidence_text  ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.evidence_email ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.evidence_text  FORCE ROW LEVEL SECURITY;
ALTER TABLE huis.evidence_email FORCE ROW LEVEL SECURITY;
GRANT SELECT ON huis.evidence_text, huis.evidence_email TO huis_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON huis.evidence_text, huis.evidence_email TO huis_security;

-- Visible exactly when the item itself is visible (evidence RLS applies inside).
CREATE POLICY evidence_text_select ON huis.evidence_text FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND EXISTS (SELECT 1 FROM huis.evidence_items i WHERE i.id = evidence_id));
CREATE POLICY evidence_email_select ON huis.evidence_email FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND EXISTS (SELECT 1 FROM huis.evidence_items i WHERE i.id = evidence_id));

-- ---------------------------------------------------------------------------
-- Jobs: one scan job and one extraction job per item
-- ---------------------------------------------------------------------------
ALTER TABLE huis.jobs DROP CONSTRAINT jobs_one_per_evidence;
ALTER TABLE huis.jobs ADD CONSTRAINT jobs_one_per_kind UNIQUE (evidence_id, kind);
ALTER TABLE huis.jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE huis.jobs ADD CONSTRAINT jobs_kind_check CHECK (kind IN ('evidence.process', 'evidence.extract'));

-- ---------------------------------------------------------------------------
-- New items: originals (from a person) or derived (from the worker)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION huis.evidence_after_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, public, pg_temp AS $$
DECLARE
  v_parent huis.evidence_items;
BEGIN
  IF NEW.parent_id IS NULL THEN
    IF NEW.firm_id IS DISTINCT FROM huis.current_firm_id() OR NEW.uploaded_by IS DISTINCT FROM huis.current_user_id() THEN
      RAISE EXCEPTION 'evidence does not match the current firm and user context';
    END IF;
    INSERT INTO huis.evidence_custody_events (firm_id, evidence_id, actor_user_id, event, details, ip_address)
      VALUES (NEW.firm_id, NEW.id, NEW.uploaded_by, 'received', jsonb_build_object(
        'original_filename', NEW.original_filename, 'relative_path', NEW.relative_path,
        'size_bytes', NEW.size_bytes, 'sha256', NEW.sha256, 'source', NEW.source,
        'received_from', NEW.received_from, 'date_received', NEW.date_received), huis.request_ip());
  ELSE
    -- Derived items can only be created by the worker functions below.
    IF current_user <> 'huis_security' THEN
      RAISE EXCEPTION 'derived evidence can only be created by Huis processing';
    END IF;
    SELECT * INTO v_parent FROM huis.evidence_items WHERE id = NEW.parent_id;
    INSERT INTO huis.evidence_custody_events (firm_id, evidence_id, event, details)
      VALUES (NEW.firm_id, NEW.id, 'extracted', jsonb_build_object(
        'parent_id', v_parent.id, 'parent_filename', v_parent.original_filename, 'parent_sha256', v_parent.sha256,
        'container_path', NEW.container_path, 'size_bytes', NEW.size_bytes, 'sha256', NEW.sha256));
    INSERT INTO huis.evidence_custody_events (firm_id, evidence_id, event, details)
      VALUES (NEW.firm_id, v_parent.id, 'contained_item_extracted', jsonb_build_object(
        'child_id', NEW.id, 'container_path', NEW.container_path, 'sha256', NEW.sha256));
  END IF;
  INSERT INTO huis.jobs (firm_id, kind, evidence_id) VALUES (NEW.firm_id, 'evidence.process', NEW.id);
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Worker functions
-- ---------------------------------------------------------------------------
DROP FUNCTION huis.worker_claim_job();
CREATE FUNCTION huis.worker_claim_job()
RETURNS TABLE (job_id bigint, lock_token uuid, kind text, firm_id uuid, evidence_id uuid, storage_key text, sha256 text,
               size_bytes bigint, matter_id uuid, attempts int, original_filename text, detected_content_type text, depth int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_job   huis.jobs;
  v_token uuid := gen_random_uuid();
BEGIN
  SELECT * INTO v_job FROM huis.jobs j
   WHERE (j.status = 'queued' OR (j.status = 'running' AND j.locked_until < now()))
     AND j.run_after <= now()
   ORDER BY CASE j.kind WHEN 'evidence.process' THEN 0 ELSE 1 END, j.id
   FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE huis.jobs SET status = 'running', attempts = attempts + 1, lock_token = v_token,
         locked_until = now() + interval '6 hours' WHERE id = v_job.id;
  RETURN QUERY SELECT v_job.id, v_token, v_job.kind, i.firm_id, i.id, i.storage_key, i.sha256::text, i.size_bytes,
                      i.matter_id, v_job.attempts + 1, i.original_filename, i.detected_content_type, i.depth
    FROM huis.evidence_items i WHERE i.id = v_job.evidence_id;
END $$;

-- Scan completion: as before, plus queue extraction for clean items.
CREATE OR REPLACE FUNCTION huis.worker_complete(
  p_job_id bigint, p_lock_token uuid, p_status huis.evidence_status, p_detail text, p_detected_type text,
  p_verified_sha256 text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE
  v_job  huis.jobs;
  v_item huis.evidence_items;
  v_dup  uuid;
BEGIN
  SELECT * INTO v_job FROM huis.jobs WHERE id = p_job_id AND status = 'running' AND lock_token = p_lock_token
    AND kind = 'evidence.process' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'job is not held by this worker'; END IF;
  SELECT * INTO v_item FROM huis.evidence_items WHERE id = v_job.evidence_id FOR UPDATE;

  IF v_item.status <> 'pending_scan' THEN
    UPDATE huis.jobs SET status = 'done', locked_until = NULL, lock_token = NULL WHERE id = p_job_id;
    RETURN;
  END IF;

  IF p_verified_sha256 IS DISTINCT FROM v_item.sha256::text THEN
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
         detected_content_type = left(p_detected_type, 200), duplicate_of = v_dup,
         extraction_status = CASE WHEN p_status = 'clean' THEN 'pending'::huis.extraction_status ELSE NULL END
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

  IF p_status = 'clean' THEN
    INSERT INTO huis.jobs (firm_id, kind, evidence_id) VALUES (v_item.firm_id, 'evidence.extract', v_item.id)
      ON CONFLICT (evidence_id, kind) DO NOTHING;
  END IF;

  UPDATE huis.jobs SET status = 'done', locked_until = NULL, lock_token = NULL, last_error = NULL WHERE id = p_job_id;
END $$;

-- Failure handling for both job kinds.
CREATE OR REPLACE FUNCTION huis.worker_fail(p_job_id bigint, p_lock_token uuid, p_error text, p_final boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE
  v_job huis.jobs;
BEGIN
  SELECT * INTO v_job FROM huis.jobs WHERE id = p_job_id AND lock_token = p_lock_token FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF p_final THEN
    UPDATE huis.jobs SET status = 'failed', locked_until = NULL, lock_token = NULL, last_error = left(p_error, 500) WHERE id = p_job_id;
    IF v_job.kind = 'evidence.process' THEN
      UPDATE huis.evidence_items SET status = 'scan_failed', scan_detail = 'Processing failed; the file is held and cannot be opened.',
             scanned_at = now() WHERE id = v_job.evidence_id AND status = 'pending_scan';
      INSERT INTO huis.evidence_custody_events (firm_id, evidence_id, event, details)
        VALUES (v_job.firm_id, v_job.evidence_id, 'scan_failed', jsonb_build_object('detail', 'processing failed'));
    ELSE
      UPDATE huis.evidence_items SET extraction_status = 'failed',
             extraction_detail = 'Text could not be extracted from this file.' WHERE id = v_job.evidence_id;
    END IF;
  ELSE
    UPDATE huis.jobs SET status = 'queued', locked_until = NULL, lock_token = NULL, last_error = left(p_error, 500),
           run_after = now() + make_interval(secs => least(3600, 30 * power(2, v_job.attempts))::int)
     WHERE id = p_job_id;
  END IF;
END $$;

-- Holds an extraction job for the calling worker, or raises.
CREATE FUNCTION huis.worker_held_extract_job(p_job_id bigint, p_lock_token uuid) RETURNS huis.jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE
  v_job huis.jobs;
BEGIN
  SELECT * INTO v_job FROM huis.jobs WHERE id = p_job_id AND status = 'running' AND lock_token = p_lock_token
    AND kind = 'evidence.extract' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'job is not held by this worker'; END IF;
  RETURN v_job;
END $$;

-- Adds an item found inside another (email attachment, archive entry).
-- The new item lives in the same matter and folder as its parent and is
-- scanned before anyone can open it.
CREATE FUNCTION huis.worker_add_derived(
  p_job_id bigint, p_lock_token uuid, p_child_id uuid, p_filename text, p_container_path text,
  p_declared_type text, p_size bigint, p_sha256 text, p_storage_key text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE
  v_job    huis.jobs;
  v_parent huis.evidence_items;
  v_count  int;
BEGIN
  v_job := huis.worker_held_extract_job(p_job_id, p_lock_token);
  SELECT * INTO v_parent FROM huis.evidence_items WHERE id = v_job.evidence_id;
  IF v_parent.status <> 'clean' THEN RAISE EXCEPTION 'parent is not clean'; END IF;
  IF v_parent.depth >= 4 THEN RAISE EXCEPTION 'items nested too deeply'; END IF;
  SELECT count(*) INTO v_count FROM huis.evidence_items WHERE parent_id = v_parent.id;
  IF v_count >= 20000 THEN RAISE EXCEPTION 'too many items in one container'; END IF;
  IF p_storage_key IS DISTINCT FROM format('firm/%s/matter/%s/evidence/%s/original', v_parent.firm_id, v_parent.matter_id, p_child_id) THEN
    RAISE EXCEPTION 'unexpected storage location';
  END IF;

  INSERT INTO huis.evidence_items (id, firm_id, matter_id, folder_id, original_filename, declared_content_type,
      size_bytes, sha256, storage_key, source, received_from, date_received, uploaded_by, uploaded_at,
      parent_id, container_path, depth)
    VALUES (p_child_id, v_parent.firm_id, v_parent.matter_id, v_parent.folder_id,
      left(coalesce(nullif(p_filename, ''), 'unnamed'), 1024), left(p_declared_type, 200),
      p_size, p_sha256, p_storage_key, 'extracted', v_parent.received_from, v_parent.date_received,
      v_parent.uploaded_by, now(), v_parent.id, left(p_container_path, 4096), v_parent.depth + 1);
END $$;

-- Records extracted text / email headers and finishes the extraction job.
CREATE FUNCTION huis.worker_save_extraction(
  p_job_id bigint, p_lock_token uuid, p_status huis.extraction_status, p_detail text,
  p_text text, p_method text, p_page_count int, p_email jsonb, p_children int
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE
  v_job  huis.jobs;
  v_item huis.evidence_items;
  v_text text := left(coalesce(p_text, ''), 5000000);
BEGIN
  v_job := huis.worker_held_extract_job(p_job_id, p_lock_token);
  SELECT * INTO v_item FROM huis.evidence_items WHERE id = v_job.evidence_id FOR UPDATE;

  IF length(v_text) > 0 THEN
    INSERT INTO huis.evidence_text (evidence_id, firm_id, content, method, char_count, truncated)
      VALUES (v_item.id, v_item.firm_id, v_text, p_method, length(v_text), length(coalesce(p_text, '')) > 5000000)
      ON CONFLICT (evidence_id) DO UPDATE SET content = EXCLUDED.content, method = EXCLUDED.method,
        char_count = EXCLUDED.char_count, truncated = EXCLUDED.truncated, created_at = now();
  END IF;

  IF p_email IS NOT NULL THEN
    INSERT INTO huis.evidence_email (evidence_id, firm_id, from_addr, to_addrs, cc_addrs, bcc_addrs, subject,
        sent_at, message_id, in_reply_to, attachment_count)
      VALUES (v_item.id, v_item.firm_id, left(p_email->>'from', 1000),
        coalesce(ARRAY(SELECT left(x, 1000) FROM jsonb_array_elements_text(coalesce(p_email->'to', '[]')) x LIMIT 500), '{}'),
        coalesce(ARRAY(SELECT left(x, 1000) FROM jsonb_array_elements_text(coalesce(p_email->'cc', '[]')) x LIMIT 500), '{}'),
        coalesce(ARRAY(SELECT left(x, 1000) FROM jsonb_array_elements_text(coalesce(p_email->'bcc', '[]')) x LIMIT 500), '{}'),
        left(p_email->>'subject', 2000),
        CASE WHEN (p_email->>'date') ~ '^\d{4}-\d{2}-\d{2}T' THEN (p_email->>'date')::timestamptz END,
        left(p_email->>'messageId', 1000), left(p_email->>'inReplyTo', 1000), coalesce(p_children, 0))
      ON CONFLICT (evidence_id) DO NOTHING;
  END IF;

  UPDATE huis.evidence_items SET extraction_status = p_status, extraction_detail = left(p_detail, 500),
         page_count = p_page_count WHERE id = v_item.id;

  INSERT INTO huis.evidence_custody_events (firm_id, evidence_id, event, details)
    VALUES (v_item.firm_id, v_item.id, 'text_extracted', jsonb_build_object(
      'status', p_status, 'method', p_method, 'characters', length(v_text), 'pages', p_page_count,
      'items_extracted', coalesce(p_children, 0)));

  UPDATE huis.jobs SET status = 'done', locked_until = NULL, lock_token = NULL, last_error = NULL WHERE id = p_job_id;
END $$;

-- Moving an item moves everything extracted from it too (an email and its
-- attachments always share the same protection).
CREATE OR REPLACE FUNCTION huis.move_evidence(p_evidence_id uuid, p_folder_id uuid, p_acknowledged boolean) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, public, pg_temp AS $$
DECLARE
  v      huis.evidence_items;
  v_from huis.matter_folders;
  v_to   huis.matter_folders;
  v_exposes boolean;
  r      record;
BEGIN
  SELECT * INTO v FROM huis.evidence_items WHERE id = p_evidence_id AND firm_id = huis.current_firm_id() FOR UPDATE;
  IF NOT FOUND OR NOT huis.can_see_matter(v.matter_id) OR NOT huis.can_manage_matter_content(v.matter_id) THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_from FROM huis.matter_folders WHERE id = v.folder_id;
  SELECT * INTO v_to FROM huis.matter_folders WHERE id = p_folder_id AND matter_id = v.matter_id AND firm_id = v.firm_id;
  IF NOT FOUND THEN RETURN 'folder_not_found'; END IF;
  IF v_to.id = v_from.id THEN RETURN 'unchanged'; END IF;
  v_exposes := NOT v_to.is_privileged_area
    AND v_to.classification IN ('client_accessible', 'co_counsel_accessible', 'expert_accessible', 'public');
  IF v_exposes AND NOT coalesce(p_acknowledged, false) THEN
    RETURN 'acknowledgement_required';
  END IF;
  FOR r IN
    WITH RECURSIVE fam AS (
      SELECT e.id, e.folder_id FROM huis.evidence_items e WHERE e.id = v.id
      UNION ALL
      SELECT c.id, c.folder_id FROM huis.evidence_items c JOIN fam ON c.parent_id = fam.id
    ) SELECT fam.id, f.name AS from_name, f.is_privileged_area AS from_priv
        FROM fam JOIN huis.matter_folders f ON f.id = fam.folder_id
  LOOP
    UPDATE huis.evidence_items SET folder_id = v_to.id WHERE id = r.id;
    INSERT INTO huis.evidence_custody_events (firm_id, evidence_id, actor_user_id, event, details, ip_address)
      VALUES (v.firm_id, r.id, huis.current_user_id(), 'moved', jsonb_build_object(
        'from', r.from_name, 'to', v_to.name,
        'left_privileged_area', r.from_priv,
        'shared_outside_firm', v_exposes,
        'privilege_waiver_acknowledged', CASE WHEN v_exposes THEN true ELSE NULL END,
        'moved_with', CASE WHEN r.id <> v.id THEN v.id ELSE NULL END), huis.request_ip());
  END LOOP;
  RETURN 'moved';
END $$;

ALTER FUNCTION huis.worker_claim_job() OWNER TO huis_security;
ALTER FUNCTION huis.worker_held_extract_job(bigint, uuid) OWNER TO huis_security;
ALTER FUNCTION huis.worker_add_derived(bigint, uuid, uuid, text, text, text, bigint, text, text) OWNER TO huis_security;
ALTER FUNCTION huis.worker_save_extraction(bigint, uuid, huis.extraction_status, text, text, text, int, jsonb, int) OWNER TO huis_security;

REVOKE ALL ON FUNCTION huis.worker_claim_job(), huis.worker_held_extract_job(bigint, uuid),
  huis.worker_add_derived(bigint, uuid, uuid, text, text, text, bigint, text, text),
  huis.worker_save_extraction(bigint, uuid, huis.extraction_status, text, text, text, int, jsonb, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.worker_claim_job(),
  huis.worker_add_derived(bigint, uuid, uuid, text, text, text, bigint, text, text),
  huis.worker_save_extraction(bigint, uuid, huis.extraction_status, text, text, text, int, jsonb, int) TO huis_worker;
GRANT EXECUTE ON FUNCTION huis.worker_held_extract_job(bigint, uuid) TO huis_security;
