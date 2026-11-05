-- Phase 9 part 2b: Google Drive.
--
-- Google Drive plugs into the Integration Hub with Google's narrowest file permission, drive.file: Huis can open
-- only the files the person chooses in Google's own file picker. There are no folders to browse. The picker hands
-- back file ids, which the app passes here (request_integration_picked); the worker checks each one with the
-- connection's own sealed sign-in and lists only files that account can open. From there, importing is exactly
-- as for OneDrive and Dropbox (only listed files, the version chosen, custody, sync records, re-checks).
-- Huis's ids: "picked" (the person's latest choice) and "gdrive:<Drive file id>".

-- The file ids the person chose, waiting for the worker to check them (Google Drive's "picked" listing only).
ALTER TABLE huis.integration_listings
  ADD COLUMN picked text[] CHECK (picked IS NULL OR (cardinality(picked) BETWEEN 1 AND 200 AND location = 'picked'));

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
DECLARE v_id uuid;
BEGIN
  IF NOT huis.owns_integration(p_connection_id) THEN RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501'; END IF;
  -- Folder ids are the provider's: letters, digits and a few punctuation marks, nothing else.
  -- (Postgres caps a regex repeat at 255, so lengths are checked separately.)
  IF p_location IS NULL OR length(p_location) > 400
     OR p_location !~ '^(root|sites|site:[A-Za-z0-9,._-]+|drive:[A-Za-z0-9!._-]+:[A-Za-z0-9!._-]+|dbx:id:[A-Za-z0-9_-]+)$'
     OR p_location ~ '(^|[:,])\.+([:,]|$)' THEN
    RAISE EXCEPTION 'invalid folder';
  END IF;
  -- Each system's own ids only (OneDrive's never reach Dropbox, or the reverse). Google Drive has no folders
  -- to browse (drive.file): its files arrive through request_integration_picked only.
  IF (SELECT provider FROM huis.integration_connections WHERE id = p_connection_id) = 'google_drive'
     OR ((SELECT provider FROM huis.integration_connections WHERE id = p_connection_id) = 'dropbox' AND p_location !~ '^(root$|dbx:)')
     OR ((SELECT provider FROM huis.integration_connections WHERE id = p_connection_id) <> 'dropbox' AND p_location ~ '^dbx:') THEN
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

-- Records the files a person chose in Google's picker, for the worker to check and list.
CREATE FUNCTION huis.request_integration_picked(p_connection_id uuid, p_files text[]) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE
  v_id uuid;
  v_file text;
BEGIN
  IF NOT huis.owns_integration(p_connection_id) THEN RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501'; END IF;
  IF (SELECT provider FROM huis.integration_connections WHERE id = p_connection_id) <> 'google_drive' THEN
    RAISE EXCEPTION 'invalid folder';
  END IF;
  IF p_files IS NULL OR cardinality(p_files) = 0 OR cardinality(p_files) > 200 THEN RAISE EXCEPTION 'choose between 1 and 200 files'; END IF;
  -- Drive file ids only: letters, digits, "-" and "_" (length checked separately: Postgres caps a regex repeat at 255).
  FOREACH v_file IN ARRAY p_files LOOP
    IF v_file IS NULL OR length(v_file) NOT BETWEEN 10 AND 200 OR v_file !~ '^[A-Za-z0-9_-]+$' THEN RAISE EXCEPTION 'invalid file'; END IF;
  END LOOP;
  INSERT INTO huis.integration_listings (firm_id, connection_id, location, picked)
    VALUES (huis.current_firm_id(), p_connection_id, 'picked', (SELECT array_agg(DISTINCT f) FROM unnest(p_files) f))
    ON CONFLICT (connection_id, location) DO UPDATE
      SET picked = EXCLUDED.picked, status = 'queued', requested_at = now(), attempts = 0, last_error = NULL,
          lock_token = NULL, locked_until = NULL
    RETURNING id INTO v_id;
  RETURN v_id;
END $$;
ALTER FUNCTION huis.request_integration_picked(uuid, text[]) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.request_integration_picked(uuid, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.request_integration_picked(uuid, text[]) TO huis_app;

-- The claim now hands the worker the chosen file ids (a new result column, so the function is recreated).
DROP FUNCTION huis.worker_claim_integration_listing();
CREATE FUNCTION huis.worker_claim_integration_listing()
RETURNS TABLE (listing_id uuid, lock_token uuid, firm_id uuid, connection_id uuid, provider text, account_subject text, location text,
               picked text[], ciphertext bytea)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
#variable_conflict use_column
DECLARE
  l huis.integration_listings;
  c huis.integration_connections;
  v_token uuid := gen_random_uuid();
BEGIN
  SELECT * INTO l FROM huis.integration_listings
   WHERE (status = 'queued' OR (status = 'running' AND locked_until < now())) AND attempts < 3
   ORDER BY requested_at FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO c FROM huis.integration_connections WHERE id = l.connection_id;
  IF c.status <> 'active' THEN
    UPDATE huis.integration_listings SET status = 'failed', last_error = 'reconnect the account' WHERE id = l.id;
    RETURN;
  END IF;
  -- An owner who left the firm, or is no longer staff who can add material, has nothing listed.
  IF NOT EXISTS (SELECT 1 FROM huis.users u WHERE u.id = c.owner_user_id AND u.firm_id = c.firm_id AND u.status = 'active'
                   AND huis.is_internal_role(u.role) AND u.role <> 'read_only') THEN
    UPDATE huis.integration_listings SET status = 'failed', last_error = 'the account owner no longer has access' WHERE id = l.id;
    RETURN;
  END IF;
  UPDATE huis.integration_listings SET status = 'running', lock_token = v_token, attempts = attempts + 1,
         locked_until = now() + interval '5 minutes' WHERE id = l.id;
  RETURN QUERY SELECT l.id, v_token, l.firm_id, c.id, c.provider, c.account_subject, l.location, l.picked,
    (SELECT k.ciphertext FROM huis.integration_credentials k WHERE k.connection_id = c.id);
END $$;
ALTER FUNCTION huis.worker_claim_integration_listing() OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.worker_claim_integration_listing() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.worker_claim_integration_listing() TO huis_worker;

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
      CASE c.provider WHEN 'onedrive' THEN 'OneDrive / SharePoint' WHEN 'dropbox' THEN 'Dropbox' WHEN 'google_drive' THEN 'Google Drive' ELSE left(c.provider, 100) END,
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
