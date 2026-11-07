-- Security review 21 (Phase 9 part 2a, Dropbox and the Integration Hub).
--
-- R21-1: imported evidence's "received from" showed the connected account's address ("Dropbox (name@…)") to
--        everyone who can see the item, clients included. It now names the system only; the account stays
--        in the chain of custody, which shows it to firm staff only.
-- R21-3: an import now remembers the version the person chose from the listing. If the file has changed
--        since, the worker refuses it ("open the folder again") instead of importing content nobody saw.

ALTER TABLE huis.integration_listing_items
  ADD COLUMN version text CHECK (version IS NULL OR length(version) <= 200);
ALTER TABLE huis.integration_imports
  ADD COLUMN expected_version text CHECK (expected_version IS NULL OR length(expected_version) <= 200);

CREATE OR REPLACE FUNCTION huis.worker_save_integration_listing(
  p_listing_id uuid, p_lock_token uuid, p_title text, p_parent text, p_items jsonb, p_truncated boolean, p_error text, p_reconnect boolean
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE
  l huis.integration_listings;
  v_items jsonb;
BEGIN
  SELECT * INTO l FROM huis.integration_listings WHERE id = p_listing_id AND status = 'running' AND lock_token = p_lock_token FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'listing is not held by this worker'; END IF;
  IF p_error IS NOT NULL THEN
    UPDATE huis.integration_listings SET status = CASE WHEN attempts >= 3 OR p_reconnect THEN 'failed' ELSE 'queued' END,
           last_error = left(p_error, 300), lock_token = NULL WHERE id = l.id;
    IF p_reconnect THEN
      UPDATE huis.integration_connections SET status = 'needs_reconnect', last_error = left(p_error, 300) WHERE id = l.connection_id;
    END IF;
    RETURN;
  END IF;
  IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) > 2000 THEN RAISE EXCEPTION 'invalid listing'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'id', left(x->>'id', 400),
           'kind', CASE WHEN x->>'kind' IN ('file', 'folder', 'site') THEN x->>'kind' ELSE 'file' END,
           'name', left(regexp_replace(coalesce(x->>'name', '(no name)'), '[\x00-\x1f\x7f]', '', 'g'), 300),
           'size', CASE WHEN (x->>'size') ~ '^[0-9]{1,15}$' THEN (x->>'size')::bigint END,
           'modified', CASE WHEN (x->>'modified') ~ '^\d{4}-\d{2}-\d{2}T[0-9:.]+Z?$' THEN x->>'modified' END,
           'version', left(x->>'version', 200),
           'mime', left(x->>'mime', 200)))), '[]'::jsonb)
    INTO v_items
    FROM jsonb_array_elements(p_items) x
   WHERE coalesce(x->>'id', '') ~ '^[A-Za-z0-9!,._:-]+$' AND length(x->>'id') <= 400;
  UPDATE huis.integration_listings SET status = 'ready', items = v_items, title = left(p_title, 300), parent = left(p_parent, 400),
         truncated = coalesce(p_truncated, false), last_error = NULL, lock_token = NULL WHERE id = l.id;
  DELETE FROM huis.integration_listing_items WHERE listing_id = l.id;
  INSERT INTO huis.integration_listing_items (listing_id, connection_id, item_id, name, version)
    SELECT DISTINCT ON (x->>'id') l.id, l.connection_id, x->>'id', coalesce(x->>'name', '(no name)'), x->>'version'
      FROM jsonb_array_elements(v_items) x WHERE x->>'kind' = 'file' ORDER BY x->>'id';
  UPDATE huis.integration_connections SET status = 'active', last_error = NULL, verified_at = now()
   WHERE id = l.connection_id AND status IN ('active', 'needs_reconnect');
END $$;

CREATE OR REPLACE FUNCTION huis.request_integration_import(
  p_connection_id uuid, p_matter_id uuid, p_folder_id uuid, p_items text[], p_acknowledged boolean
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE
  f huis.matter_folders;
  v_exposes boolean;
  v_item text;
  v_name text;
  v_version text;
  v_queued int := 0;
  v_already int := 0;
BEGIN
  IF NOT huis.owns_integration(p_connection_id) THEN RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501'; END IF;
  IF NOT huis.can_see_matter(p_matter_id) OR NOT huis.can_manage_matter_content(p_matter_id) THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
  END IF;
  IF p_items IS NULL OR cardinality(p_items) = 0 OR cardinality(p_items) > 200 THEN RAISE EXCEPTION 'choose between 1 and 200 files'; END IF;
  SELECT * INTO f FROM huis.matter_folders WHERE id = p_folder_id AND matter_id = p_matter_id AND firm_id = huis.current_firm_id();
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'folder_not_found'); END IF;
  v_exposes := NOT f.is_privileged_area
    AND f.classification IN ('client_accessible', 'co_counsel_accessible', 'expert_accessible', 'public');
  IF v_exposes AND NOT coalesce(p_acknowledged, false) THEN RETURN jsonb_build_object('error', 'acknowledgement_required'); END IF;
  FOREACH v_item IN ARRAY p_items LOOP
    -- An indexed lookup per file (security review 19, R19-5). The rows are the files of each folder's last
    -- successful listing, so they stay usable while the folder is being fetched again.
    v_name := NULL;
    v_version := NULL;
    SELECT i.name, i.version INTO v_name, v_version FROM huis.integration_listing_items i
     WHERE i.connection_id = p_connection_id AND i.item_id = v_item
     LIMIT 1;
    IF v_name IS NULL THEN RAISE EXCEPTION 'that file was not listed'; END IF;
    BEGIN
      INSERT INTO huis.integration_imports (firm_id, connection_id, matter_id, folder_id, external_id, external_name, expected_version,
                                           shared_outside_firm, requested_by)
        VALUES (huis.current_firm_id(), p_connection_id, p_matter_id, f.id, v_item, v_name, v_version, v_exposes, huis.current_user_id());
      v_queued := v_queued + 1;
    EXCEPTION WHEN unique_violation THEN
      v_already := v_already + 1;
    END;
  END LOOP;
  RETURN jsonb_build_object('queued', v_queued, 'already', v_already);
END $$;

-- The claim now hands the worker the chosen version (a new result column, so the function is recreated).
DROP FUNCTION huis.worker_claim_integration_import();
CREATE FUNCTION huis.worker_claim_integration_import()
RETURNS TABLE (import_id uuid, lock_token uuid, firm_id uuid, matter_id uuid, connection_id uuid, provider text, account_subject text,
               external_id text, external_name text, expected_version text, ciphertext bytea)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
#variable_conflict use_column
DECLARE
  r huis.integration_imports;
  c huis.integration_connections;
  v_token uuid := gen_random_uuid();
BEGIN
  LOOP
    SELECT * INTO r FROM huis.integration_imports
     WHERE (status = 'queued' OR (status = 'running' AND locked_until < now())) AND attempts < 5
     ORDER BY requested_at FOR UPDATE SKIP LOCKED LIMIT 1;
    IF NOT FOUND THEN RETURN; END IF;
    EXIT WHEN huis.integration_import_allowed(r.id);
    UPDATE huis.integration_imports SET status = 'failed', last_error = 'the requester no longer has access', lock_token = NULL WHERE id = r.id;
  END LOOP;
  SELECT * INTO c FROM huis.integration_connections WHERE id = r.connection_id;
  UPDATE huis.integration_imports SET status = 'running', lock_token = v_token, attempts = attempts + 1,
         locked_until = now() + interval '60 minutes' WHERE id = r.id;
  RETURN QUERY SELECT r.id, v_token, r.firm_id, r.matter_id, c.id, c.provider, c.account_subject, r.external_id, r.external_name, r.expected_version,
    (SELECT k.ciphertext FROM huis.integration_credentials k WHERE k.connection_id = c.id);
END $$;
ALTER FUNCTION huis.worker_claim_integration_import() OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.worker_claim_integration_import() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.worker_claim_integration_import() TO huis_worker;

CREATE OR REPLACE FUNCTION huis.worker_complete_integration_import(
  p_import_id uuid, p_lock_token uuid, p_evidence_id uuid, p_size bigint, p_sha256 text, p_storage_key text,
  p_version text, p_modified timestamptz, p_mime text, p_path text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, public, pg_temp AS $$
DECLARE
  r huis.integration_imports;
  c huis.integration_connections;
  v_existing uuid;
BEGIN
  SELECT * INTO r FROM huis.integration_imports WHERE id = p_import_id AND status = 'running' AND lock_token = p_lock_token FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'import is not held by this worker'; END IF;
  IF p_storage_key IS DISTINCT FROM format('firm/%s/matter/%s/evidence/%s/original', r.firm_id, r.matter_id, p_evidence_id) THEN
    RAISE EXCEPTION 'unexpected storage location';
  END IF;
  IF NOT huis.integration_import_allowed(r.id) THEN
    UPDATE huis.integration_imports SET status = 'failed', last_error = 'the requester no longer has access', lock_token = NULL WHERE id = r.id;
    RETURN 'denied';
  END IF;
  SELECT * INTO c FROM huis.integration_connections WHERE id = r.connection_id;
  -- The same version of the same file is in this Matter already: don't copy it twice.
  SELECT s.internal_id INTO v_existing FROM huis.sync_records s
    JOIN huis.evidence_items i ON i.id = s.internal_id
   WHERE s.matter_id = r.matter_id AND s.external_system = c.provider AND s.external_record_id = r.external_id
     AND s.external_version IS NOT DISTINCT FROM left(p_version, 200) AND s.internal_type = 'evidence';
  IF v_existing IS NOT NULL THEN
    UPDATE huis.integration_imports SET status = 'skipped', evidence_id = v_existing, completed_at = now(), lock_token = NULL,
           last_error = 'this version is already in the Matter' WHERE id = r.id;
    RETURN 'duplicate';
  END IF;
  INSERT INTO huis.evidence_items (id, firm_id, matter_id, folder_id, original_filename, declared_content_type,
      size_bytes, sha256, storage_key, source, received_from, date_received, uploaded_by, uploaded_at)
    VALUES (p_evidence_id, r.firm_id, r.matter_id, r.folder_id,
      left(regexp_replace(r.external_name, '[\x00-\x1f/\\:*?"<>|]+', ' ', 'g'), 255), left(coalesce(p_mime, 'application/octet-stream'), 200),
      p_size, p_sha256, p_storage_key, 'integration',
      -- Security review 21, R21-1: the system's name only. The account (often a personal address) is in the chain
      -- of custody, which shows it to firm staff only; this field is shown to everyone who can see the item.
      CASE c.provider WHEN 'onedrive' THEN 'OneDrive / SharePoint' WHEN 'dropbox' THEN 'Dropbox' ELSE left(c.provider, 100) END,
      (now() AT TIME ZONE 'UTC')::date, r.requested_by, now());
  INSERT INTO huis.evidence_custody_events (firm_id, evidence_id, event, details)
    VALUES (r.firm_id, p_evidence_id, 'imported_from_integration', jsonb_build_object(
      'system', c.provider, 'account', c.account_label, 'tenant', c.external_tenant, 'external_id', r.external_id,
      'version', left(p_version, 200), 'modified_at', p_modified, 'path', left(p_path, 1000),
      'imported_by', r.requested_by, 'shared_outside_firm', r.shared_outside_firm,
      'privilege_waiver_acknowledged', CASE WHEN r.shared_outside_firm THEN true ELSE NULL END, 'retrieved_at', now()));
  INSERT INTO huis.sync_records (firm_id, connection_id, matter_id, external_system, external_tenant, external_record_id, external_version,
                                 internal_type, internal_id, sync_direction, sync_status)
    VALUES (r.firm_id, c.id, r.matter_id, c.provider, c.external_tenant, r.external_id, left(p_version, 200), 'evidence', p_evidence_id, 'import', 'synced');
  UPDATE huis.integration_imports SET status = 'done', evidence_id = p_evidence_id, completed_at = now(), lock_token = NULL WHERE id = r.id;
  UPDATE huis.integration_connections SET verified_at = now() WHERE id = c.id;
  RETURN 'done';
END $$;
