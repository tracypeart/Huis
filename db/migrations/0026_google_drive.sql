-- Phase 9 part 2b: Google Drive.
--
-- Google Drive plugs into the Integration Hub (0024, 0025) like OneDrive and Dropbox, with one difference:
-- Huis asks only for Google's drive.file permission, so it can open nothing but the files the person
-- chooses for it in Google's own file picker. The worker lists those chosen files (one listing, "root")
-- and imports ticked ones into a Matter, with the same checks, chain of custody and sync records.
-- Google Drive file ids are letters, digits, "-" and "_"; Huis names them "gdrive:<id>". Files are never
-- browsed by folder, so "gdrive:" ids are never listing locations.

CREATE OR REPLACE FUNCTION huis.connect_integration(
  p_provider text, p_account_subject text, p_external_tenant text, p_account_label text, p_ciphertext bytea
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE c huis.integration_connections;
BEGIN
  IF NOT huis.is_internal_role(huis.app_role()) OR huis.app_role() = 'read_only' THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
  END IF;
  IF p_provider NOT IN ('onedrive', 'dropbox', 'google_drive') OR coalesce(p_account_subject, '') = '' OR p_ciphertext IS NULL THEN
    RAISE EXCEPTION 'invalid connection';
  END IF;
  SELECT * INTO c FROM huis.integration_connections
   WHERE firm_id = huis.current_firm_id() AND provider = p_provider AND account_subject = p_account_subject FOR UPDATE;
  IF FOUND AND c.owner_user_id <> huis.current_user_id() THEN
    -- Security review 19, R19-1 (as review 5, R5-5, for mailboxes): only a connection that works can't be
    -- taken over. One that never worked (e.g. a colleague squatting the account id with a made-up token),
    -- needs reconnecting or was disconnected goes to whoever signs in with the account, and is wiped.
    IF c.status = 'active' AND c.verified_at IS NOT NULL THEN RETURN NULL; END IF;
    DELETE FROM huis.integration_listings WHERE connection_id = c.id;
    UPDATE huis.integration_imports SET status = 'failed', last_error = 'the connection changed hands', lock_token = NULL
     WHERE connection_id = c.id AND status IN ('queued', 'running');
    UPDATE huis.integration_connections SET owner_user_id = huis.current_user_id(), status = 'active', last_error = NULL, verified_at = NULL,
           external_tenant = left(p_external_tenant, 200), account_label = left(p_account_label, 320)
     WHERE id = c.id RETURNING * INTO c;
  ELSIF FOUND THEN
    UPDATE huis.integration_connections SET status = 'active', last_error = NULL,
           external_tenant = left(p_external_tenant, 200), account_label = left(p_account_label, 320)
     WHERE id = c.id RETURNING * INTO c;
  ELSE
    INSERT INTO huis.integration_connections (firm_id, owner_user_id, provider, account_subject, external_tenant, account_label)
      VALUES (huis.current_firm_id(), huis.current_user_id(), p_provider, left(p_account_subject, 200),
              left(p_external_tenant, 200), left(p_account_label, 320))
      RETURNING * INTO c;
  END IF;
  INSERT INTO huis.integration_credentials (connection_id, ciphertext) VALUES (c.id, p_ciphertext)
    ON CONFLICT (connection_id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, updated_at = now();
  RETURN c.id;
END $$;

CREATE OR REPLACE FUNCTION huis.request_integration_listing(p_connection_id uuid, p_location text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE v_id uuid; v_provider text;
BEGIN
  IF NOT huis.owns_integration(p_connection_id) THEN RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501'; END IF;
  -- Folder ids are the provider's: letters, digits and a few punctuation marks, nothing else.
  -- (Postgres caps a regex repeat at 255, so lengths are checked separately.)
  IF p_location IS NULL OR length(p_location) > 400
     OR p_location !~ '^(root|sites|site:[A-Za-z0-9,._-]+|drive:[A-Za-z0-9!._-]+:[A-Za-z0-9!._-]+|dbx:id:[A-Za-z0-9_-]+|gdrive:[A-Za-z0-9_-]+)$'
     OR p_location ~ '(^|[:,])\.+([:,]|$)' THEN
    RAISE EXCEPTION 'invalid folder';
  END IF;
  -- Each system's own ids only (OneDrive's never reach Dropbox or Google Drive, or the reverse). Google Drive
  -- has one listing: the files chosen for Huis in Google's file picker (drive.file shows Huis nothing else).
  v_provider := (SELECT provider FROM huis.integration_connections WHERE id = p_connection_id);
  IF (v_provider = 'dropbox' AND p_location !~ '^(root$|dbx:)')
     OR (v_provider = 'google_drive' AND p_location <> 'root')
     OR (v_provider <> 'dropbox' AND p_location ~ '^dbx:')
     OR p_location ~ '^gdrive:' THEN
    RAISE EXCEPTION 'invalid folder';
  END IF;
  -- At most a few hundred folders held per connection (oldest dropped).
  DELETE FROM huis.integration_listings WHERE id IN (
    SELECT id FROM huis.integration_listings WHERE connection_id = p_connection_id ORDER BY requested_at DESC OFFSET 300);
  INSERT INTO huis.integration_listings (firm_id, connection_id, location)
    VALUES (huis.current_firm_id(), p_connection_id, p_location)
    ON CONFLICT (connection_id, location) DO UPDATE
      SET status = CASE WHEN huis.integration_listings.status = 'running' THEN 'running' ELSE 'queued' END,
          requested_at = now(), attempts = 0, last_error = NULL
    RETURNING id INTO v_id;
  RETURN v_id;
END $$;

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
      left(format('%s (%s)', CASE c.provider WHEN 'onedrive' THEN 'OneDrive / SharePoint' WHEN 'dropbox' THEN 'Dropbox' WHEN 'google_drive' THEN 'Google Drive' ELSE c.provider END, coalesce(c.account_label, 'account')), 300),
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
