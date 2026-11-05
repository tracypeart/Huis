-- Phase 9 part 1: the Integration Hub, and OneDrive / SharePoint.
--
-- Every outside system connects through its own adapter (src/integrations/),
-- and every item that moves between Huis and an outside system has a sync
-- record: which system, which account, the outside id and version, the Huis
-- item, the direction, and its status.
--
-- Privilege and security (same model as connected mailboxes, Phase 3):
--   * A connection belongs to one staff member (their own OneDrive). Only they
--     browse it; nobody else at the firm, administrators included.
--   * Sign-in tokens are encrypted by the app and stored where the app can't
--     read them back; only the worker can, through its own functions. So
--     browsing also goes through the worker: the app asks for a folder, the
--     worker lists it, and only names, sizes and dates are kept (no contents).
--   * Importing copies the chosen file into a Matter as evidence (scanned,
--     fingerprinted, chain of custody recording where it came from), where the
--     Matter's rules (walls, red folder, client access) apply. The same
--     version of a file is imported into a Matter once.
--   * Every request is checked again when the worker carries it out (the
--     person must still own the connection, be active staff and be able to
--     add to the Matter).

ALTER TYPE huis.evidence_source ADD VALUE IF NOT EXISTS 'integration';

CREATE TABLE huis.integration_connections (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id          uuid NOT NULL REFERENCES huis.firms(id),
  owner_user_id    uuid NOT NULL,
  provider         text NOT NULL CHECK (provider IN ('onedrive', 'google_drive', 'dropbox', 'filevine', 'clio', 'strongsuit')),
  -- The provider's stable id for the account, and the organization (tenant) it belongs to.
  account_subject  text NOT NULL CHECK (length(account_subject) BETWEEN 1 AND 200),
  external_tenant  text CHECK (external_tenant IS NULL OR length(external_tenant) <= 200),
  account_label    text CHECK (account_label IS NULL OR length(account_label) <= 320),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'needs_reconnect', 'disconnected')),
  last_error       text CHECK (last_error IS NULL OR length(last_error) <= 300),
  -- When the provider last accepted this connection's sign-in (a listing or import worked). Security
  -- review 19, R19-1: a connection that never worked can be taken over by the account's real owner.
  verified_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (firm_id, id),
  UNIQUE (firm_id, provider, account_subject),
  FOREIGN KEY (firm_id, owner_user_id) REFERENCES huis.users(firm_id, id)
);

CREATE TABLE huis.integration_credentials (
  connection_id uuid PRIMARY KEY REFERENCES huis.integration_connections(id) ON DELETE CASCADE,
  ciphertext    bytea NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Folder listings fetched by the worker for the owner: names, sizes and dates only.
CREATE TABLE huis.integration_listings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id        uuid NOT NULL,
  connection_id  uuid NOT NULL REFERENCES huis.integration_connections(id) ON DELETE CASCADE,
  -- 'root', a folder id, or 'sites' (SharePoint sites the person follows) / 'site:<id>'.
  location       text NOT NULL CHECK (length(location) BETWEEN 1 AND 400),
  status         text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'ready', 'failed')),
  items          jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(items) = 'array'),
  -- The folder's own name and its parent (for "up").
  title          text CHECK (title IS NULL OR length(title) <= 300),
  parent         text CHECK (parent IS NULL OR length(parent) <= 400),
  truncated      boolean NOT NULL DEFAULT false,
  last_error     text CHECK (last_error IS NULL OR length(last_error) <= 300),
  requested_at   timestamptz NOT NULL DEFAULT now(),
  lock_token     uuid,
  locked_until   timestamptz,
  attempts       int NOT NULL DEFAULT 0,
  UNIQUE (connection_id, location),
  FOREIGN KEY (firm_id, connection_id) REFERENCES huis.integration_connections(firm_id, id)
);

-- Import requests: copy one outside file into a Matter.
CREATE TABLE huis.integration_imports (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id          uuid NOT NULL,
  connection_id    uuid NOT NULL REFERENCES huis.integration_connections(id) ON DELETE CASCADE,
  matter_id        uuid NOT NULL,
  folder_id        uuid NOT NULL,
  external_id      text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 400),
  external_name    text NOT NULL CHECK (length(external_name) BETWEEN 1 AND 300),
  shared_outside_firm boolean NOT NULL,
  requested_by     uuid NOT NULL,
  requested_at     timestamptz NOT NULL DEFAULT now(),
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'skipped', 'failed')),
  lock_token       uuid,
  locked_until     timestamptz,
  attempts         int NOT NULL DEFAULT 0,
  last_error       text CHECK (last_error IS NULL OR length(last_error) <= 300),
  evidence_id      uuid,
  completed_at     timestamptz,
  FOREIGN KEY (firm_id, connection_id) REFERENCES huis.integration_connections(firm_id, id),
  FOREIGN KEY (firm_id, matter_id) REFERENCES huis.matters(firm_id, id),
  FOREIGN KEY (firm_id, requested_by) REFERENCES huis.users(firm_id, id)
);
CREATE UNIQUE INDEX integration_imports_once ON huis.integration_imports (connection_id, external_id, matter_id) WHERE status IN ('queued', 'running');
CREATE INDEX integration_imports_queue ON huis.integration_imports (requested_at) WHERE status IN ('queued', 'running');

-- Sync records: the link between an outside item and a Huis item.
CREATE TABLE huis.sync_records (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id            uuid NOT NULL REFERENCES huis.firms(id),
  connection_id      uuid REFERENCES huis.integration_connections(id) ON DELETE SET NULL,
  matter_id          uuid NOT NULL,
  external_system    text NOT NULL CHECK (external_system IN ('onedrive', 'google_drive', 'dropbox', 'filevine', 'clio', 'strongsuit')),
  external_tenant    text CHECK (external_tenant IS NULL OR length(external_tenant) <= 200),
  external_record_id text NOT NULL CHECK (length(external_record_id) BETWEEN 1 AND 400),
  external_version   text CHECK (external_version IS NULL OR length(external_version) <= 200),
  internal_type      text NOT NULL CHECK (internal_type IN ('evidence', 'matter', 'contact', 'court_event')),
  internal_id        uuid NOT NULL,
  sync_direction     text NOT NULL CHECK (sync_direction IN ('import', 'export', 'two_way')),
  sync_status        text NOT NULL CHECK (sync_status IN ('synced', 'changed_outside', 'failed')),
  last_synced_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (matter_id, external_system, external_record_id, external_version, internal_type),
  FOREIGN KEY (firm_id, matter_id) REFERENCES huis.matters(firm_id, id)
);
CREATE INDEX sync_records_internal ON huis.sync_records (internal_type, internal_id);

-- The files in each held listing, one row each, so an import request looks them up by index
-- (security review 19, R19-5). Only the checked functions read or write it.
CREATE TABLE huis.integration_listing_items (
  listing_id    uuid NOT NULL REFERENCES huis.integration_listings(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES huis.integration_connections(id) ON DELETE CASCADE,
  item_id       text NOT NULL CHECK (length(item_id) BETWEEN 1 AND 400),
  name          text NOT NULL CHECK (length(name) <= 300),
  PRIMARY KEY (listing_id, item_id)
);
CREATE INDEX integration_listing_items_lookup ON huis.integration_listing_items (connection_id, item_id);
ALTER TABLE huis.integration_listing_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.integration_listing_items FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON huis.integration_listing_items TO huis_security;

ALTER TABLE huis.integration_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.integration_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.integration_listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.integration_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.sync_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.integration_connections FORCE ROW LEVEL SECURITY;
ALTER TABLE huis.integration_credentials FORCE ROW LEVEL SECURITY;
ALTER TABLE huis.integration_listings FORCE ROW LEVEL SECURITY;
ALTER TABLE huis.integration_imports FORCE ROW LEVEL SECURITY;
ALTER TABLE huis.sync_records FORCE ROW LEVEL SECURITY;

-- The app reads (never writes) these directly; every change goes through a checked function.
GRANT SELECT ON huis.integration_connections, huis.integration_listings, huis.integration_imports, huis.sync_records TO huis_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON huis.integration_connections, huis.integration_credentials, huis.integration_listings,
  huis.integration_imports, huis.sync_records TO huis_security;

-- A connection is its owner's alone, while they are active firm staff.
CREATE FUNCTION huis.owns_integration(p_connection_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT huis.is_internal_role(huis.app_role()) AND huis.app_role() <> 'read_only' AND EXISTS (
    SELECT 1 FROM huis.integration_connections c JOIN huis.users u ON u.id = c.owner_user_id
     WHERE c.id = p_connection_id AND c.firm_id = huis.current_firm_id() AND c.owner_user_id = huis.current_user_id()
       AND c.status <> 'disconnected' AND u.status = 'active')
$$;
ALTER FUNCTION huis.owns_integration(uuid) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.owns_integration(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.owns_integration(uuid) TO huis_app;

CREATE POLICY integration_connections_select ON huis.integration_connections FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND owner_user_id = huis.current_user_id() AND huis.is_internal_role(huis.app_role()));
CREATE POLICY integration_listings_select ON huis.integration_listings FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.owns_integration(connection_id));
-- Your own import requests, while you can still see the Matter.
CREATE POLICY integration_imports_select ON huis.integration_imports FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND requested_by = huis.current_user_id() AND huis.can_see_matter(matter_id));
-- Sync records: firm staff who can see the Matter (and, for evidence, the item itself).
CREATE POLICY sync_records_select ON huis.sync_records FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.is_internal_role(huis.app_role()) AND huis.can_see_matter(matter_id)
         AND (internal_type <> 'evidence' OR EXISTS (SELECT 1 FROM huis.evidence_items i WHERE i.id = internal_id)));

-- ---------------------------------------------------------------------------
-- The app's checked functions
-- ---------------------------------------------------------------------------
-- Connects (or reconnects) the person's own account. One owner per account; an
-- account that needs reconnecting or was disconnected can be taken over, which
-- clears what was held for the old owner.
CREATE FUNCTION huis.connect_integration(
  p_provider text, p_account_subject text, p_external_tenant text, p_account_label text, p_ciphertext bytea
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE c huis.integration_connections;
BEGIN
  IF NOT huis.is_internal_role(huis.app_role()) OR huis.app_role() = 'read_only' THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
  END IF;
  IF p_provider NOT IN ('onedrive') OR coalesce(p_account_subject, '') = '' OR p_ciphertext IS NULL THEN
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

-- Disconnects: the credentials and listings are deleted; imported evidence stays.
CREATE FUNCTION huis.disconnect_integration(p_connection_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
BEGIN
  IF NOT huis.owns_integration(p_connection_id) THEN RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501'; END IF;
  DELETE FROM huis.integration_credentials WHERE connection_id = p_connection_id;
  DELETE FROM huis.integration_listings WHERE connection_id = p_connection_id;
  UPDATE huis.integration_imports SET status = 'failed', last_error = 'disconnected', lock_token = NULL
   WHERE connection_id = p_connection_id AND status IN ('queued', 'running');
  UPDATE huis.integration_connections SET status = 'disconnected' WHERE id = p_connection_id;
  RETURN true;
END $$;

-- Asks the worker to list a folder (or fetch it again).
CREATE FUNCTION huis.request_integration_listing(p_connection_id uuid, p_location text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT huis.owns_integration(p_connection_id) THEN RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501'; END IF;
  -- Folder ids are the provider's: letters, digits and a few punctuation marks, nothing else.
  -- (Postgres caps a regex repeat at 255, so lengths are checked separately.)
  IF p_location IS NULL OR length(p_location) > 400
     OR p_location !~ '^(root|sites|site:[A-Za-z0-9,._-]+|drive:[A-Za-z0-9!._-]+:[A-Za-z0-9!._-]+)$'
     OR p_location ~ '(^|[:,])\.+([:,]|$)' THEN
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

-- Asks the worker to import files into a Matter. Only files the worker listed in
-- this connection can be named, so the app can't ask for anything else.
CREATE FUNCTION huis.request_integration_import(
  p_connection_id uuid, p_matter_id uuid, p_folder_id uuid, p_items text[], p_acknowledged boolean
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE
  f huis.matter_folders;
  v_exposes boolean;
  v_item text;
  v_name text;
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
    SELECT i.name INTO v_name FROM huis.integration_listing_items i
     WHERE i.connection_id = p_connection_id AND i.item_id = v_item
     LIMIT 1;
    IF v_name IS NULL THEN RAISE EXCEPTION 'that file was not listed'; END IF;
    BEGIN
      INSERT INTO huis.integration_imports (firm_id, connection_id, matter_id, folder_id, external_id, external_name, shared_outside_firm, requested_by)
        VALUES (huis.current_firm_id(), p_connection_id, p_matter_id, f.id, v_item, v_name, v_exposes, huis.current_user_id());
      v_queued := v_queued + 1;
    EXCEPTION WHEN unique_violation THEN
      v_already := v_already + 1;
    END;
  END LOOP;
  RETURN jsonb_build_object('queued', v_queued, 'already', v_already);
END $$;

ALTER FUNCTION huis.connect_integration(text, text, text, text, bytea) OWNER TO huis_security;
ALTER FUNCTION huis.disconnect_integration(uuid) OWNER TO huis_security;
ALTER FUNCTION huis.request_integration_listing(uuid, text) OWNER TO huis_security;
ALTER FUNCTION huis.request_integration_import(uuid, uuid, uuid, text[], boolean) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.connect_integration(text, text, text, text, bytea), huis.disconnect_integration(uuid),
  huis.request_integration_listing(uuid, text), huis.request_integration_import(uuid, uuid, uuid, text[], boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.connect_integration(text, text, text, text, bytea), huis.disconnect_integration(uuid),
  huis.request_integration_listing(uuid, text), huis.request_integration_import(uuid, uuid, uuid, text[], boolean) TO huis_app;

-- ---------------------------------------------------------------------------
-- Worker functions
-- ---------------------------------------------------------------------------
-- Whether an import is still allowed, evaluated as its requester.
CREATE FUNCTION huis.integration_import_allowed(p_import_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE
  r huis.integration_imports;
  u huis.users;
  f huis.matter_folders;
BEGIN
  SELECT * INTO r FROM huis.integration_imports WHERE id = p_import_id;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO u FROM huis.users WHERE id = r.requested_by AND firm_id = r.firm_id;
  IF NOT FOUND OR u.status <> 'active' OR NOT huis.is_internal_role(u.role) OR u.role = 'read_only' THEN RETURN false; END IF;
  PERFORM set_config('app.firm_id', r.firm_id::text, true);
  PERFORM set_config('app.user_id', r.requested_by::text, true);
  IF NOT huis.owns_integration(r.connection_id) OR NOT huis.can_see_matter(r.matter_id) OR NOT huis.can_manage_matter_content(r.matter_id) THEN
    RETURN false;
  END IF;
  SELECT * INTO f FROM huis.matter_folders WHERE id = r.folder_id AND matter_id = r.matter_id;
  IF NOT FOUND THEN RETURN false; END IF;
  -- A folder that became shared outside the firm since the request needs a new acknowledgement.
  IF NOT r.shared_outside_firm AND NOT f.is_privileged_area
     AND f.classification IN ('client_accessible', 'co_counsel_accessible', 'expert_accessible', 'public') THEN
    RETURN false;
  END IF;
  RETURN true;
END $$;
ALTER FUNCTION huis.integration_import_allowed(uuid) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.integration_import_allowed(uuid) FROM PUBLIC;

CREATE FUNCTION huis.worker_claim_integration_listing()
RETURNS TABLE (listing_id uuid, lock_token uuid, firm_id uuid, connection_id uuid, provider text, account_subject text, location text, ciphertext bytea)
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
  RETURN QUERY SELECT l.id, v_token, l.firm_id, c.id, c.provider, c.account_subject, l.location,
    (SELECT k.ciphertext FROM huis.integration_credentials k WHERE k.connection_id = c.id);
END $$;

-- Saves a listing: each item's id, kind, name, size and modified date only.
CREATE FUNCTION huis.worker_save_integration_listing(
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
  INSERT INTO huis.integration_listing_items (listing_id, connection_id, item_id, name)
    SELECT DISTINCT ON (x->>'id') l.id, l.connection_id, x->>'id', coalesce(x->>'name', '(no name)')
      FROM jsonb_array_elements(v_items) x WHERE x->>'kind' = 'file' ORDER BY x->>'id';
  UPDATE huis.integration_connections SET status = 'active', last_error = NULL, verified_at = now()
   WHERE id = l.connection_id AND status IN ('active', 'needs_reconnect');
END $$;

-- Saves a rotated sign-in token, only for the connection of a listing or import this worker holds.
CREATE FUNCTION huis.worker_save_integration_credentials(p_kind text, p_job_id uuid, p_lock_token uuid, p_ciphertext bytea) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE v_connection uuid;
BEGIN
  IF p_kind = 'listing' THEN
    SELECT connection_id INTO v_connection FROM huis.integration_listings WHERE id = p_job_id AND status = 'running' AND lock_token = p_lock_token;
  ELSIF p_kind = 'import' THEN
    SELECT connection_id INTO v_connection FROM huis.integration_imports WHERE id = p_job_id AND status = 'running' AND lock_token = p_lock_token;
  END IF;
  IF v_connection IS NULL OR p_ciphertext IS NULL THEN RAISE EXCEPTION 'that work is not held by this worker'; END IF;
  UPDATE huis.integration_credentials SET ciphertext = p_ciphertext, updated_at = now() WHERE connection_id = v_connection;
END $$;

CREATE FUNCTION huis.worker_claim_integration_import()
RETURNS TABLE (import_id uuid, lock_token uuid, firm_id uuid, matter_id uuid, connection_id uuid, provider text, account_subject text,
               external_id text, external_name text, ciphertext bytea)
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
  RETURN QUERY SELECT r.id, v_token, r.firm_id, r.matter_id, c.id, c.provider, c.account_subject, r.external_id, r.external_name,
    (SELECT k.ciphertext FROM huis.integration_credentials k WHERE k.connection_id = c.id);
END $$;

-- The file is in the vault: record it as evidence (or skip it if this version is already in the Matter).
CREATE FUNCTION huis.worker_complete_integration_import(
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
      left(format('%s (%s)', CASE c.provider WHEN 'onedrive' THEN 'OneDrive / SharePoint' ELSE c.provider END, coalesce(c.account_label, 'account')), 300),
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

CREATE FUNCTION huis.worker_fail_integration_import(p_import_id uuid, p_lock_token uuid, p_error text, p_final boolean, p_reconnect boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE r huis.integration_imports;
BEGIN
  UPDATE huis.integration_imports
     SET status = CASE WHEN p_final OR p_reconnect OR attempts >= 5 THEN 'failed' ELSE 'queued' END,
         last_error = left(p_error, 300), lock_token = NULL, locked_until = NULL
   WHERE id = p_import_id AND status = 'running' AND lock_token = p_lock_token
   RETURNING * INTO r;
  IF FOUND AND p_reconnect THEN
    UPDATE huis.integration_connections SET status = 'needs_reconnect', last_error = left(p_error, 300) WHERE id = r.connection_id;
  END IF;
END $$;

ALTER FUNCTION huis.worker_claim_integration_listing() OWNER TO huis_security;
ALTER FUNCTION huis.worker_save_integration_listing(uuid, uuid, text, text, jsonb, boolean, text, boolean) OWNER TO huis_security;
ALTER FUNCTION huis.worker_save_integration_credentials(text, uuid, uuid, bytea) OWNER TO huis_security;
ALTER FUNCTION huis.worker_claim_integration_import() OWNER TO huis_security;
ALTER FUNCTION huis.worker_complete_integration_import(uuid, uuid, uuid, bigint, text, text, text, timestamptz, text, text) OWNER TO huis_security;
ALTER FUNCTION huis.worker_fail_integration_import(uuid, uuid, text, boolean, boolean) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.worker_claim_integration_listing(), huis.worker_save_integration_listing(uuid, uuid, text, text, jsonb, boolean, text, boolean),
  huis.worker_save_integration_credentials(text, uuid, uuid, bytea), huis.worker_claim_integration_import(),
  huis.worker_complete_integration_import(uuid, uuid, uuid, bigint, text, text, text, timestamptz, text, text),
  huis.worker_fail_integration_import(uuid, uuid, text, boolean, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.worker_claim_integration_listing(), huis.worker_save_integration_listing(uuid, uuid, text, text, jsonb, boolean, text, boolean),
  huis.worker_save_integration_credentials(text, uuid, uuid, bytea), huis.worker_claim_integration_import(),
  huis.worker_complete_integration_import(uuid, uuid, uuid, bigint, text, text, text, timestamptz, text, text),
  huis.worker_fail_integration_import(uuid, uuid, text, boolean, boolean) TO huis_worker;

-- Imported files, like mailbox filings, are top-level items only the worker creates.
DROP POLICY evidence_insert ON huis.evidence_items;
CREATE POLICY evidence_insert ON huis.evidence_items FOR INSERT TO huis_app
  WITH CHECK (firm_id = huis.current_firm_id() AND uploaded_by = huis.current_user_id()
              AND status = 'pending_scan' AND duplicate_of IS NULL
              AND parent_id IS NULL AND container_path IS NULL AND depth = 0
              AND source::text NOT IN ('extracted', 'produced_copy', 'mailbox', 'integration')
              AND extraction_status IS NULL AND extraction_detail IS NULL
              AND page_count IS NULL
              AND huis.can_see_matter(matter_id) AND huis.app_role() <> 'read_only'
              AND (huis.is_internal_role(huis.app_role())
                   OR (huis.app_role() = 'client' AND huis.folder_classification(folder_id) = 'client_accessible')));


CREATE OR REPLACE FUNCTION huis.evidence_after_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, public, pg_temp AS $$
DECLARE
  v_parent huis.evidence_items;
  v_worker boolean := pg_has_role(session_user, 'huis_worker', 'MEMBER') AND NOT pg_has_role(session_user, 'huis_app', 'MEMBER');
BEGIN
  IF NEW.source::text IN ('produced_copy', 'mailbox', 'integration') THEN
    IF NOT v_worker OR NEW.parent_id IS NOT NULL THEN
      RAISE EXCEPTION 'this evidence can only be created by Huis processing';
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
