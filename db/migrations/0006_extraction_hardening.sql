-- Huis Law IP — fixes from the independent review of Phase 2 part 2

SET search_path = huis, public;

-- ---------------------------------------------------------------------------
-- F1: people can only record originals. Derived items (attachments, archive
-- contents) can only come from the worker's own database login.
-- ---------------------------------------------------------------------------
DROP POLICY evidence_insert ON huis.evidence_items;
CREATE POLICY evidence_insert ON huis.evidence_items FOR INSERT TO huis_app
  WITH CHECK (firm_id = huis.current_firm_id() AND uploaded_by = huis.current_user_id()
              AND status = 'pending_scan' AND duplicate_of IS NULL
              AND parent_id IS NULL AND container_path IS NULL AND depth = 0
              AND source <> 'extracted' AND extraction_status IS NULL AND extraction_detail IS NULL
              AND page_count IS NULL
              AND huis.can_see_matter(matter_id) AND huis.app_role() <> 'read_only'
              AND (huis.is_internal_role(huis.app_role())
                   OR (huis.app_role() = 'client' AND huis.folder_classification(folder_id) = 'client_accessible')));

-- The app may only supply the columns of an original upload.
REVOKE INSERT ON huis.evidence_items FROM huis_app;
GRANT INSERT (id, firm_id, matter_id, folder_id, original_filename, relative_path, declared_content_type,
              size_bytes, sha256, storage_key, source, received_from, date_received, uploaded_by)
  ON huis.evidence_items TO huis_app;

-- Track the top-level upload each derived item came from (for quotas).
ALTER TABLE huis.evidence_items ADD COLUMN root_id uuid;
UPDATE huis.evidence_items c SET root_id = (
  WITH RECURSIVE up AS (
    SELECT id, parent_id FROM huis.evidence_items WHERE id = c.parent_id
    UNION ALL SELECT p.id, p.parent_id FROM huis.evidence_items p JOIN up ON p.id = up.parent_id
  ) SELECT id FROM up WHERE parent_id IS NULL LIMIT 1)
WHERE c.parent_id IS NOT NULL;
CREATE INDEX evidence_root ON huis.evidence_items (root_id) WHERE root_id IS NOT NULL;

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
     OR NEW.root_id IS DISTINCT FROM OLD.root_id
     OR NEW.container_path IS DISTINCT FROM OLD.container_path
     OR NEW.depth <> OLD.depth THEN
    RAISE EXCEPTION 'original evidence is immutable';
  END IF;
  IF current_user <> 'huis_security' THEN
    RAISE EXCEPTION 'evidence can only be changed through Huis (scanner results and recorded moves)';
  END IF;
  RETURN NEW;
END $$;

-- The trigger now checks who actually connected (session_user), not the
-- function owner, so the derived-item path can't be reached by the app.
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
    IF NOT pg_has_role(session_user, 'huis_worker', 'MEMBER') OR pg_has_role(session_user, 'huis_app', 'MEMBER') THEN
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
-- F4: quota on everything unpacked from one upload; lock the parent so a
-- concurrent move and extraction can't split a family.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION huis.worker_add_derived(
  p_job_id bigint, p_lock_token uuid, p_child_id uuid, p_filename text, p_container_path text,
  p_declared_type text, p_size bigint, p_sha256 text, p_storage_key text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE
  v_job    huis.jobs;
  v_parent huis.evidence_items;
  v_root   huis.evidence_items;
  v_count  int;
  v_total  bigint;
BEGIN
  v_job := huis.worker_held_extract_job(p_job_id, p_lock_token);
  SELECT * INTO v_parent FROM huis.evidence_items WHERE id = v_job.evidence_id FOR UPDATE;
  IF v_parent.status <> 'clean' THEN RAISE EXCEPTION 'parent is not clean'; END IF;
  IF v_parent.depth >= 4 THEN RAISE EXCEPTION 'items nested too deeply'; END IF;
  SELECT count(*) INTO v_count FROM huis.evidence_items WHERE parent_id = v_parent.id;
  IF v_count >= 20000 THEN RAISE EXCEPTION 'too many items in one container'; END IF;
  IF p_storage_key IS DISTINCT FROM format('firm/%s/matter/%s/evidence/%s/original', v_parent.firm_id, v_parent.matter_id, p_child_id) THEN
    RAISE EXCEPTION 'unexpected storage location';
  END IF;

  SELECT * INTO v_root FROM huis.evidence_items WHERE id = coalesce(v_parent.root_id, v_parent.id);
  SELECT coalesce(sum(size_bytes), 0) INTO v_total FROM huis.evidence_items WHERE root_id = v_root.id;
  IF v_total + p_size > least(greatest(20 * v_root.size_bytes, 1073741824), 53687091200) THEN
    RAISE EXCEPTION 'unpacking quota for this upload reached';
  END IF;

  INSERT INTO huis.evidence_items (id, firm_id, matter_id, folder_id, original_filename, declared_content_type,
      size_bytes, sha256, storage_key, source, received_from, date_received, uploaded_by, uploaded_at,
      parent_id, root_id, container_path, depth)
    VALUES (p_child_id, v_parent.firm_id, v_parent.matter_id, v_parent.folder_id,
      left(coalesce(nullif(p_filename, ''), 'unnamed'), 1024), left(p_declared_type, 200),
      p_size, p_sha256, p_storage_key, 'extracted', v_parent.received_from, v_parent.date_received,
      v_parent.uploaded_by, now(), v_parent.id, v_root.id, left(p_container_path, 4096), v_parent.depth + 1);
END $$;

-- ---------------------------------------------------------------------------
-- An infected attachment or archive entry quarantines everything it came from.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION huis.worker_complete(
  p_job_id bigint, p_lock_token uuid, p_status huis.evidence_status, p_detail text, p_detected_type text,
  p_verified_sha256 text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE
  v_job  huis.jobs;
  v_item huis.evidence_items;
  v_dup  uuid;
  v_anc  record;
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

  IF p_status = 'infected' AND v_item.parent_id IS NOT NULL THEN
    FOR v_anc IN
      WITH RECURSIVE up AS (
        SELECT id, parent_id FROM huis.evidence_items WHERE id = v_item.parent_id
        UNION ALL SELECT p.id, p.parent_id FROM huis.evidence_items p JOIN up ON p.id = up.parent_id
      ) SELECT id FROM up
    LOOP
      UPDATE huis.evidence_items SET status = 'infected', scanned_at = now(),
             scan_detail = left(format('Quarantined: contains a threat inside "%s".', v_item.original_filename), 500)
       WHERE id = v_anc.id AND status <> 'infected';
      INSERT INTO huis.evidence_custody_events (firm_id, evidence_id, event, details)
        VALUES (v_item.firm_id, v_anc.id, 'quarantined_contains_threat', jsonb_build_object('item', v_item.id));
    END LOOP;
  END IF;

  IF p_status = 'clean' THEN
    INSERT INTO huis.jobs (firm_id, kind, evidence_id) VALUES (v_item.firm_id, 'evidence.extract', v_item.id)
      ON CONFLICT (evidence_id, kind) DO NOTHING;
  END IF;

  UPDATE huis.jobs SET status = 'done', locked_until = NULL, lock_token = NULL, last_error = NULL WHERE id = p_job_id;
END $$;

-- ---------------------------------------------------------------------------
-- F2: a move takes along only the contained items that are still with their
-- parent. Anything someone deliberately put elsewhere — above all in the red
-- privileged area — stays where it is.
-- ---------------------------------------------------------------------------
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
      SELECT e.id FROM huis.evidence_items e WHERE e.id = v.id
      UNION ALL
      SELECT c.id FROM huis.evidence_items c JOIN fam ON c.parent_id = fam.id
       WHERE c.folder_id = v.folder_id
    ) SELECT fam.id FROM fam
  LOOP
    UPDATE huis.evidence_items SET folder_id = v_to.id WHERE id = r.id;
    INSERT INTO huis.evidence_custody_events (firm_id, evidence_id, actor_user_id, event, details, ip_address)
      VALUES (v.firm_id, r.id, huis.current_user_id(), 'moved', jsonb_build_object(
        'from', v_from.name, 'to', v_to.name,
        'left_privileged_area', v_from.is_privileged_area,
        'shared_outside_firm', v_exposes,
        'privilege_waiver_acknowledged', CASE WHEN v_exposes THEN true ELSE NULL END,
        'moved_with', CASE WHEN r.id <> v.id THEN v.id ELSE NULL END), huis.request_ip());
  END LOOP;
  RETURN 'moved';
END $$;

-- ---------------------------------------------------------------------------
-- F5: reading a document's text on screen is recorded like a download.
-- ---------------------------------------------------------------------------
CREATE FUNCTION huis.record_evidence_view(p_evidence_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, public, pg_temp AS $$
DECLARE
  v huis.evidence_items;
BEGIN
  SELECT * INTO v FROM huis.evidence_items WHERE id = p_evidence_id AND firm_id = huis.current_firm_id();
  IF NOT FOUND OR NOT huis.can_see_evidence(v.matter_id, v.folder_id, v.uploaded_by) OR v.status <> 'clean' THEN
    RETURN false;
  END IF;
  INSERT INTO huis.evidence_custody_events (firm_id, evidence_id, actor_user_id, event, ip_address)
    VALUES (v.firm_id, v.id, huis.current_user_id(), 'viewed', huis.request_ip());
  RETURN true;
END $$;
ALTER FUNCTION huis.record_evidence_view(uuid) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.record_evidence_view(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.record_evidence_view(uuid) TO huis_app;
