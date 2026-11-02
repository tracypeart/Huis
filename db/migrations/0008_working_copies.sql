-- Phase 2 part 3b: working copies.
--
-- The original is never changed. Instead:
--   * viewing copies  — a PDF made from Word/Excel/PowerPoint/photos (in the
--                       sandbox) so every document opens page by page in Huis
--   * annotations     — highlights, notes and redaction marks drawn on pages.
--                       They are attorney work product: visible only to firm
--                       staff who can see the document, never to outsiders.
--   * produced copies — redacted and/or exhibit-stamped, Bates-numbered copies.
--                       Pages are turned into images and redactions are painted
--                       into the pixels, so nothing under a redaction survives
--                       and the copy has no hidden text layer. Each copy is a new
--                       evidence item, linked to its source in both chains of custody.

ALTER TYPE huis.evidence_source ADD VALUE IF NOT EXISTS 'produced_copy';

-- ---------------------------------------------------------------------------
-- Viewing copies
-- ---------------------------------------------------------------------------
CREATE TABLE huis.evidence_renditions (
  evidence_id  uuid PRIMARY KEY,
  firm_id      uuid NOT NULL,
  storage_key  text NOT NULL UNIQUE,
  size_bytes   bigint NOT NULL CHECK (size_bytes >= 0),
  sha256       text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  page_count   int CHECK (page_count > 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (firm_id, evidence_id) REFERENCES huis.evidence_items(firm_id, id)
);
ALTER TABLE huis.evidence_renditions ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.evidence_renditions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON huis.evidence_renditions FROM PUBLIC;
GRANT SELECT ON huis.evidence_renditions TO huis_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON huis.evidence_renditions TO huis_security;
CREATE POLICY evidence_renditions_select ON huis.evidence_renditions FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND EXISTS (SELECT 1 FROM huis.evidence_items i WHERE i.id = evidence_id));

CREATE FUNCTION huis.worker_save_rendition(
  p_job_id bigint, p_lock_token uuid, p_storage_key text, p_size bigint, p_sha256 text, p_pages int
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE
  v_job  huis.jobs;
  v_item huis.evidence_items;
BEGIN
  v_job := huis.worker_held_extract_job(p_job_id, p_lock_token);
  SELECT * INTO v_item FROM huis.evidence_items WHERE id = v_job.evidence_id;
  IF p_storage_key IS DISTINCT FROM format('firm/%s/matter/%s/evidence/%s/rendition.pdf', v_item.firm_id, v_item.matter_id, v_item.id) THEN
    RAISE EXCEPTION 'unexpected storage location';
  END IF;
  INSERT INTO huis.evidence_renditions (evidence_id, firm_id, storage_key, size_bytes, sha256, page_count)
    VALUES (v_item.id, v_item.firm_id, p_storage_key, p_size, p_sha256, nullif(p_pages, 0))
    ON CONFLICT (evidence_id) DO NOTHING;
END $$;
ALTER FUNCTION huis.worker_save_rendition(bigint, uuid, text, bigint, text, int) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.worker_save_rendition(bigint, uuid, text, bigint, text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.worker_save_rendition(bigint, uuid, text, bigint, text, int) TO huis_worker;

-- Opening a document in the page viewer is recorded like any other view.
-- (record_evidence_view from 0006 is reused by the app.)

-- ---------------------------------------------------------------------------
-- Annotations: attorney work product
-- ---------------------------------------------------------------------------
CREATE TABLE huis.evidence_annotations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id     uuid NOT NULL,
  evidence_id uuid NOT NULL,
  page        int NOT NULL CHECK (page >= 1 AND page <= 100000),
  kind        text NOT NULL CHECK (kind IN ('highlight', 'note', 'redaction')),
  -- Position as fractions of the page as displayed (0–1), so it is the same
  -- whatever size the page is shown or printed at.
  x real NOT NULL CHECK (x >= 0 AND x <= 1),
  y real NOT NULL CHECK (y >= 0 AND y <= 1),
  w real NOT NULL CHECK (w > 0 AND w <= 1 AND x + w <= 1.0001),
  h real NOT NULL CHECK (h > 0 AND h <= 1 AND y + h <= 1.0001),
  color       text CHECK (color IS NULL OR color ~ '^#[0-9a-fA-F]{6}$'),
  note        text CHECK (note IS NULL OR length(note) <= 5000),
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (firm_id, evidence_id) REFERENCES huis.evidence_items(firm_id, id)
);
CREATE INDEX evidence_annotations_item ON huis.evidence_annotations (evidence_id, page);

ALTER TABLE huis.evidence_annotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.evidence_annotations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON huis.evidence_annotations FROM PUBLIC;
GRANT SELECT, DELETE ON huis.evidence_annotations TO huis_app;
GRANT INSERT (firm_id, evidence_id, page, kind, x, y, w, h, color, note, created_by) ON huis.evidence_annotations TO huis_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON huis.evidence_annotations TO huis_security;

-- Firm staff who can see the document. Outsiders (client, co-counsel,
-- experts, third parties) never see annotations, even on shared documents.
CREATE POLICY evidence_annotations_select ON huis.evidence_annotations FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.is_internal_role(huis.app_role())
         AND EXISTS (SELECT 1 FROM huis.evidence_items i WHERE i.id = evidence_id));
CREATE POLICY evidence_annotations_insert ON huis.evidence_annotations FOR INSERT TO huis_app
  WITH CHECK (firm_id = huis.current_firm_id() AND created_by = huis.current_user_id()
              AND huis.is_internal_role(huis.app_role()) AND huis.app_role() <> 'read_only'
              AND EXISTS (SELECT 1 FROM huis.evidence_items i WHERE i.id = evidence_id AND i.firm_id = firm_id));
-- Authors remove their own; matter managers can remove anyone's.
CREATE POLICY evidence_annotations_delete ON huis.evidence_annotations FOR DELETE TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.is_internal_role(huis.app_role()) AND huis.app_role() <> 'read_only'
         AND EXISTS (SELECT 1 FROM huis.evidence_items i WHERE i.id = evidence_id
                     AND (created_by = huis.current_user_id() OR huis.can_manage_matter_content(i.matter_id))));

-- ---------------------------------------------------------------------------
-- Produced copies (redacted / exhibit / Bates)
-- ---------------------------------------------------------------------------
CREATE TABLE huis.bates_counters (
  matter_id uuid PRIMARY KEY REFERENCES huis.matters(id),
  next_number bigint NOT NULL DEFAULT 1 CHECK (next_number >= 1)
);
ALTER TABLE huis.bates_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.bates_counters FORCE ROW LEVEL SECURITY;
REVOKE ALL ON huis.bates_counters FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON huis.bates_counters TO huis_security;

CREATE TABLE huis.copy_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id       uuid NOT NULL,
  matter_id     uuid NOT NULL,
  source_id     uuid NOT NULL,
  redact        boolean NOT NULL,
  exhibit_label text CHECK (exhibit_label IS NULL OR exhibit_label ~ '^[A-Za-z0-9][A-Za-z0-9 .#-]{0,39}$'),
  bates_prefix  text CHECK (bates_prefix IS NULL OR bates_prefix ~ '^[A-Z0-9][A-Z0-9_-]{0,23}$'),
  bates_start   bigint,
  bates_end     bigint,
  page_count    int NOT NULL CHECK (page_count BETWEEN 1 AND 2000),
  target_folder_id uuid NOT NULL,
  -- The redaction marks at the moment the copy was requested (later edits don't change it).
  redactions    jsonb NOT NULL DEFAULT '[]'::jsonb,
  shared_outside_firm boolean NOT NULL,
  requested_by  uuid NOT NULL,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  lock_token    uuid,
  locked_until  timestamptz,
  attempts      int NOT NULL DEFAULT 0,
  last_error    text,
  produced_id   uuid,
  completed_at  timestamptz,
  FOREIGN KEY (firm_id, source_id) REFERENCES huis.evidence_items(firm_id, id),
  CHECK (redact OR exhibit_label IS NOT NULL OR bates_prefix IS NOT NULL)
);
CREATE INDEX copy_requests_source ON huis.copy_requests (source_id);
CREATE INDEX copy_requests_queue ON huis.copy_requests (requested_at) WHERE status IN ('queued', 'running');

ALTER TABLE huis.copy_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.copy_requests FORCE ROW LEVEL SECURITY;
REVOKE ALL ON huis.copy_requests FROM PUBLIC;
GRANT SELECT ON huis.copy_requests TO huis_app;
GRANT SELECT, INSERT, UPDATE ON huis.copy_requests TO huis_security;
-- Requests (which hold redaction positions) are internal work product.
CREATE POLICY copy_requests_select ON huis.copy_requests FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.is_internal_role(huis.app_role())
         AND EXISTS (SELECT 1 FROM huis.evidence_items i WHERE i.id = source_id));

-- The app can't insert produced copies directly (only Huis processing can).
DROP POLICY evidence_insert ON huis.evidence_items;
CREATE POLICY evidence_insert ON huis.evidence_items FOR INSERT TO huis_app
  WITH CHECK (firm_id = huis.current_firm_id() AND uploaded_by = huis.current_user_id()
              AND status = 'pending_scan' AND duplicate_of IS NULL
              AND parent_id IS NULL AND container_path IS NULL AND depth = 0
              AND source::text NOT IN ('extracted', 'produced_copy')
              AND extraction_status IS NULL AND extraction_detail IS NULL
              AND page_count IS NULL
              AND huis.can_see_matter(matter_id) AND huis.app_role() <> 'read_only'
              AND (huis.is_internal_role(huis.app_role())
                   OR (huis.app_role() = 'client' AND huis.folder_classification(folder_id) = 'client_accessible')));


-- Asks Huis to produce a copy. Checks permissions, snapshots the redaction
-- marks, reserves Bates numbers and records the request in custody.
CREATE FUNCTION huis.request_copy(
  p_source_id uuid, p_redact boolean, p_exhibit_label text, p_bates_prefix text,
  p_folder_id uuid, p_acknowledged boolean
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, public, pg_temp AS $$
DECLARE
  v       huis.evidence_items;
  v_to    huis.matter_folders;
  v_from  huis.matter_folders;
  v_pages int;
  v_exposes boolean;
  v_reds  jsonb;
  v_start bigint;
  v_label text := nullif(btrim(p_exhibit_label), '');
  v_prefix text := nullif(upper(btrim(p_bates_prefix)), '');
  v_id    uuid;
BEGIN
  SELECT * INTO v FROM huis.evidence_items WHERE id = p_source_id AND firm_id = huis.current_firm_id();
  IF NOT FOUND OR NOT huis.can_see_matter(v.matter_id) OR NOT huis.can_manage_matter_content(v.matter_id) THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
  END IF;
  IF v.status <> 'clean' THEN RETURN 'not_clean'; END IF;
  IF NOT coalesce(p_redact, false) AND v_label IS NULL AND v_prefix IS NULL THEN RETURN 'nothing_to_do'; END IF;
  IF v_label IS NOT NULL AND v_label !~ '^[A-Za-z0-9][A-Za-z0-9 .#-]{0,39}$' THEN RETURN 'invalid_label'; END IF;
  IF v_prefix IS NOT NULL AND v_prefix !~ '^[A-Z0-9][A-Z0-9_-]{0,23}$' THEN RETURN 'invalid_prefix'; END IF;

  -- Pages come from the viewing copy, or the original when it is a PDF.
  SELECT page_count INTO v_pages FROM huis.evidence_renditions WHERE evidence_id = v.id;
  IF v_pages IS NULL AND v.detected_content_type = 'PDF' THEN v_pages := v.page_count; END IF;
  IF v_pages IS NULL THEN RETURN 'no_pages'; END IF;
  IF v_pages > 2000 THEN RETURN 'too_many_pages'; END IF;

  SELECT * INTO v_from FROM huis.matter_folders WHERE id = v.folder_id;
  SELECT * INTO v_to FROM huis.matter_folders WHERE id = p_folder_id AND matter_id = v.matter_id AND firm_id = v.firm_id;
  IF NOT FOUND THEN RETURN 'folder_not_found'; END IF;
  v_exposes := NOT v_to.is_privileged_area
    AND v_to.classification IN ('client_accessible', 'co_counsel_accessible', 'expert_accessible', 'public');
  IF v_exposes AND NOT coalesce(p_acknowledged, false) THEN RETURN 'acknowledgement_required'; END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object('page', page, 'x', x, 'y', y, 'w', w, 'h', h) ORDER BY page, y, x), '[]'::jsonb)
    INTO v_reds FROM huis.evidence_annotations WHERE evidence_id = v.id AND kind = 'redaction';
  IF coalesce(p_redact, false) AND jsonb_array_length(v_reds) = 0 THEN RETURN 'no_redactions'; END IF;
  IF NOT coalesce(p_redact, false) THEN v_reds := '[]'::jsonb; END IF;

  IF v_prefix IS NOT NULL THEN
    INSERT INTO huis.bates_counters (matter_id) VALUES (v.matter_id) ON CONFLICT DO NOTHING;
    UPDATE huis.bates_counters SET next_number = next_number + v_pages
     WHERE matter_id = v.matter_id RETURNING next_number - v_pages INTO v_start;
  END IF;

  INSERT INTO huis.copy_requests (firm_id, matter_id, source_id, redact, exhibit_label, bates_prefix, bates_start, bates_end,
      page_count, target_folder_id, redactions, shared_outside_firm, requested_by)
    VALUES (v.firm_id, v.matter_id, v.id, coalesce(p_redact, false), v_label, v_prefix, v_start,
      CASE WHEN v_start IS NULL THEN NULL ELSE v_start + v_pages - 1 END,
      v_pages, v_to.id, v_reds, v_exposes, huis.current_user_id())
    RETURNING id INTO v_id;

  INSERT INTO huis.evidence_custody_events (firm_id, evidence_id, actor_user_id, event, details, ip_address)
    VALUES (v.firm_id, v.id, huis.current_user_id(), 'copy_requested', jsonb_build_object(
      'copy_request', v_id, 'redactions', jsonb_array_length(v_reds), 'exhibit_label', v_label,
      'bates', CASE WHEN v_start IS NULL THEN NULL ELSE format('%s-%s to %s-%s', v_prefix, lpad(v_start::text, 6, '0'),
                    v_prefix, lpad((v_start + v_pages - 1)::text, 6, '0')) END,
      'to_folder', v_to.name, 'from_privileged_area', v_from.is_privileged_area,
      'shared_outside_firm', v_exposes,
      'privilege_waiver_acknowledged', CASE WHEN v_exposes THEN true ELSE NULL END), huis.request_ip());
  RETURN v_id::text;
END $$;
ALTER FUNCTION huis.request_copy(uuid, boolean, text, text, uuid, boolean) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.request_copy(uuid, boolean, text, text, uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.request_copy(uuid, boolean, text, text, uuid, boolean) TO huis_app;

-- Worker: claim the next copy to produce.
CREATE FUNCTION huis.worker_claim_copy()
RETURNS TABLE (request_id uuid, lock_token uuid, firm_id uuid, matter_id uuid, source_id uuid, source_key text,
               source_filename text, redact boolean, exhibit_label text, bates_prefix text, bates_start bigint,
               page_count int, redactions jsonb, attempts int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
#variable_conflict use_column
DECLARE
  r huis.copy_requests;
  v_token uuid := gen_random_uuid();
  v_key text;
  v_item huis.evidence_items;
BEGIN
  SELECT * INTO r FROM huis.copy_requests
   WHERE (status = 'queued' OR (status = 'running' AND locked_until < now())) AND attempts < 5
   ORDER BY requested_at FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE huis.copy_requests SET status = 'running', lock_token = v_token, attempts = attempts + 1,
         locked_until = now() + interval '2 hours' WHERE id = r.id;
  SELECT * INTO v_item FROM huis.evidence_items WHERE id = r.source_id;
  SELECT storage_key INTO v_key FROM huis.evidence_renditions WHERE evidence_id = r.source_id;
  IF v_key IS NULL THEN v_key := v_item.storage_key; END IF;
  RETURN QUERY SELECT r.id, v_token, r.firm_id, r.matter_id, r.source_id, v_key, v_item.original_filename,
    r.redact, r.exhibit_label, r.bates_prefix, r.bates_start, r.page_count, r.redactions, r.attempts + 1;
END $$;

-- Worker: record the produced copy as a new evidence item (scanned, read and
-- custody-tracked like any other), linked to its source.
CREATE FUNCTION huis.worker_complete_copy(
  p_request_id uuid, p_lock_token uuid, p_new_id uuid, p_filename text, p_size bigint, p_sha256 text,
  p_storage_key text, p_pages int
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, public, pg_temp AS $$
DECLARE
  r huis.copy_requests;
  v huis.evidence_items;
BEGIN
  SELECT * INTO r FROM huis.copy_requests WHERE id = p_request_id AND status = 'running' AND lock_token = p_lock_token FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'copy request is not held by this worker'; END IF;
  SELECT * INTO v FROM huis.evidence_items WHERE id = r.source_id;
  IF p_storage_key IS DISTINCT FROM format('firm/%s/matter/%s/evidence/%s/original', r.firm_id, r.matter_id, p_new_id) THEN
    RAISE EXCEPTION 'unexpected storage location';
  END IF;
  IF p_pages IS DISTINCT FROM r.page_count THEN RAISE EXCEPTION 'page count changed'; END IF;

  INSERT INTO huis.evidence_items (id, firm_id, matter_id, folder_id, original_filename, declared_content_type,
      size_bytes, sha256, storage_key, source, received_from, date_received, uploaded_by, uploaded_at)
    VALUES (p_new_id, r.firm_id, r.matter_id, r.target_folder_id, left(p_filename, 1024), 'application/pdf',
      p_size, p_sha256, p_storage_key, 'produced_copy', left(format('Produced by Huis from "%s"', v.original_filename), 500),
      current_date, r.requested_by, now());

  UPDATE huis.copy_requests SET status = 'done', produced_id = p_new_id, completed_at = now(), lock_token = NULL
   WHERE id = r.id;
  INSERT INTO huis.evidence_custody_events (firm_id, evidence_id, event, details)
    VALUES (r.firm_id, r.source_id, 'copy_produced', jsonb_build_object(
      'copy_request', r.id, 'copy_id', p_new_id, 'sha256', p_sha256, 'redactions', jsonb_array_length(r.redactions),
      'exhibit_label', r.exhibit_label, 'bates_start', r.bates_start, 'bates_end', r.bates_end));
  INSERT INTO huis.evidence_custody_events (firm_id, evidence_id, event, details)
    VALUES (r.firm_id, p_new_id, 'produced_from', jsonb_build_object(
      'copy_request', r.id, 'source_id', r.source_id, 'source_filename', v.original_filename, 'source_sha256', v.sha256,
      'redactions', jsonb_array_length(r.redactions), 'exhibit_label', r.exhibit_label,
      'bates_prefix', r.bates_prefix, 'bates_start', r.bates_start, 'bates_end', r.bates_end,
      'requested_by', r.requested_by));
END $$;

CREATE FUNCTION huis.worker_fail_copy(p_request_id uuid, p_lock_token uuid, p_error text, p_final boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
BEGIN
  UPDATE huis.copy_requests
     SET status = CASE WHEN p_final OR attempts >= 5 THEN 'failed' ELSE 'queued' END,
         last_error = left(p_error, 500), lock_token = NULL, locked_until = NULL
   WHERE id = p_request_id AND status = 'running' AND lock_token = p_lock_token;
END $$;

ALTER FUNCTION huis.worker_claim_copy() OWNER TO huis_security;
ALTER FUNCTION huis.worker_complete_copy(uuid, uuid, uuid, text, bigint, text, text, int) OWNER TO huis_security;
ALTER FUNCTION huis.worker_fail_copy(uuid, uuid, text, boolean) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.worker_claim_copy(), huis.worker_complete_copy(uuid, uuid, uuid, text, bigint, text, text, int),
  huis.worker_fail_copy(uuid, uuid, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.worker_claim_copy(), huis.worker_complete_copy(uuid, uuid, uuid, text, bigint, text, text, int),
  huis.worker_fail_copy(uuid, uuid, text, boolean) TO huis_worker;

-- Produced copies are inserted by the worker as new top-level items. The
-- after-insert trigger records their receipt (and queues the usual scan).
CREATE OR REPLACE FUNCTION huis.evidence_after_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, public, pg_temp AS $$
DECLARE
  v_parent huis.evidence_items;
  v_worker boolean := pg_has_role(session_user, 'huis_worker', 'MEMBER') AND NOT pg_has_role(session_user, 'huis_app', 'MEMBER');
BEGIN
  IF NEW.source::text = 'produced_copy' THEN
    IF NOT v_worker OR NEW.parent_id IS NOT NULL THEN
      RAISE EXCEPTION 'produced copies can only be created by Huis processing';
    END IF;
    INSERT INTO huis.evidence_custody_events (firm_id, evidence_id, actor_user_id, event, details)
      VALUES (NEW.firm_id, NEW.id, NEW.uploaded_by, 'received', jsonb_build_object(
        'original_filename', NEW.original_filename, 'size_bytes', NEW.size_bytes, 'sha256', NEW.sha256,
        'source', NEW.source, 'received_from', NEW.received_from, 'date_received', NEW.date_received));
  ELSIF NEW.parent_id IS NULL THEN
    IF NEW.firm_id IS DISTINCT FROM huis.current_firm_id() OR NEW.uploaded_by IS DISTINCT FROM huis.current_user_id() THEN
      RAISE EXCEPTION 'evidence does not match the current firm and user context';
    END IF;
    INSERT INTO huis.evidence_custody_events (firm_id, evidence_id, actor_user_id, event, details, ip_address)
      VALUES (NEW.firm_id, NEW.id, NEW.uploaded_by, 'received', jsonb_build_object(
        'original_filename', NEW.original_filename, 'relative_path', NEW.relative_path,
        'size_bytes', NEW.size_bytes, 'sha256', NEW.sha256, 'source', NEW.source,
        'received_from', NEW.received_from, 'date_received', NEW.date_received), huis.request_ip());
  ELSE
    IF NOT v_worker THEN
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
