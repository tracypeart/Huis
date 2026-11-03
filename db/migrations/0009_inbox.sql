-- Phase 3 part 1: Huis Inbox — connected mailboxes, sync and filing.
--
-- Privilege model:
--   * An attorney's mailbox holds every client's privileged communications,
--     so UNFILED mail is visible only to the mailbox's owner and the people
--     the owner explicitly delegates (e.g. their assistant). Not to firm
--     owners or administrators.
--   * Filing an email copies the original message into a Matter as evidence
--     (scanned, fingerprinted, custody-tracked, attachments split out), where
--     the Matter's rules (walls, red folder, client access) apply.
--   * Mailbox credentials (refresh tokens) are encrypted by the app with a
--     key derived per firm and stored where the app can't read them back;
--     only the worker can, through one function.

ALTER TYPE huis.evidence_source ADD VALUE IF NOT EXISTS 'mailbox';

-- Matter color for color-coded organization (inbox, lists).
ALTER TABLE huis.matters ADD COLUMN color text CHECK (color IS NULL OR color ~ '^#[0-9a-fA-F]{6}$');

CREATE TABLE huis.mail_connections (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id          uuid NOT NULL REFERENCES huis.firms(id),
  owner_user_id    uuid NOT NULL,
  provider         text NOT NULL CHECK (provider IN ('microsoft', 'google')),
  account_subject  text NOT NULL,           -- provider's stable id for the mailbox account
  account_address  text,
  display_name     text,
  scope            text NOT NULL DEFAULT 'all' CHECK (scope IN ('all', 'selected')),
  sync_since       date,                    -- optional: only mail received on/after this date
  manage           boolean NOT NULL DEFAULT false,  -- "Let Huis manage": keep syncing continuously
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'needs_reconnect', 'disconnected')),
  last_synced_at   timestamptz,
  last_error       text,
  next_sync_at     timestamptz NOT NULL DEFAULT now(),
  lock_token       uuid,
  locked_until     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (firm_id, id),
  FOREIGN KEY (firm_id, owner_user_id) REFERENCES huis.users(firm_id, id),
  UNIQUE (firm_id, provider, account_subject)
);

-- Encrypted refresh tokens. The app writes through connect_mailbox(); only
-- the worker reads, through worker_mail_credentials().
CREATE TABLE huis.mail_credentials (
  connection_id uuid PRIMARY KEY REFERENCES huis.mail_connections(id) ON DELETE CASCADE,
  ciphertext    bytea NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE huis.mail_delegates (
  connection_id uuid NOT NULL REFERENCES huis.mail_connections(id) ON DELETE CASCADE,
  firm_id       uuid NOT NULL,
  user_id       uuid NOT NULL,
  granted_by    uuid NOT NULL,
  granted_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, user_id),
  FOREIGN KEY (firm_id, user_id) REFERENCES huis.users(firm_id, id)
);

CREATE TABLE huis.mail_folders (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id            uuid NOT NULL,
  connection_id      uuid NOT NULL REFERENCES huis.mail_connections(id) ON DELETE CASCADE,
  provider_folder_id text NOT NULL,
  parent_provider_id text,
  display_name       text NOT NULL,
  path               text NOT NULL,
  included           boolean NOT NULL DEFAULT true,
  well_known         text,
  delta_link         text,           -- where the next sync of this folder resumes
  total_items        int,
  last_synced_at     timestamptz,
  UNIQUE (connection_id, provider_folder_id)
);

-- array_to_string isn't marked immutable (it can't know about every array type);
-- for text arrays it is, which the search index needs.
CREATE FUNCTION huis.join_addresses(text[]) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT array_to_string($1, ' ') $$;

CREATE TABLE huis.mail_messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id             uuid NOT NULL,
  connection_id       uuid NOT NULL REFERENCES huis.mail_connections(id) ON DELETE CASCADE,
  folder_id           uuid REFERENCES huis.mail_folders(id) ON DELETE SET NULL,
  provider_message_id text NOT NULL,
  internet_message_id text,
  conversation_id     text,
  subject             text,
  from_address        text,
  from_name           text,
  to_addresses        text[] NOT NULL DEFAULT '{}',
  cc_addresses        text[] NOT NULL DEFAULT '{}',
  received_at         timestamptz,
  sent_at             timestamptz,
  has_attachments     boolean NOT NULL DEFAULT false,
  importance          text,
  is_read             boolean,
  preview             text,
  body_text           text,
  removed_at          timestamptz,    -- deleted from the mailbox after sync
  filed_matter_id     uuid,
  filed_evidence_id   uuid,
  filed_at            timestamptz,
  filed_by            uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(subject, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(from_address, '') || ' ' || coalesce(from_name, '') || ' ' || huis.join_addresses(to_addresses) || ' ' || huis.join_addresses(cc_addresses)), 'B') ||
    setweight(to_tsvector('english', left(coalesce(body_text, ''), 500000)), 'C')
  ) STORED,
  UNIQUE (connection_id, provider_message_id)
);
CREATE INDEX mail_messages_list ON huis.mail_messages (connection_id, received_at DESC);
CREATE INDEX mail_messages_tsv ON huis.mail_messages USING gin (tsv);
CREATE INDEX mail_messages_conversation ON huis.mail_messages (connection_id, conversation_id);

-- Filing requests: the worker fetches the original message from the
-- provider and records it in the Matter as evidence.
CREATE TABLE huis.mail_filings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id         uuid NOT NULL,
  message_id      uuid NOT NULL REFERENCES huis.mail_messages(id) ON DELETE CASCADE,
  matter_id       uuid NOT NULL,
  folder_id       uuid NOT NULL,
  shared_outside_firm boolean NOT NULL,
  requested_by    uuid NOT NULL,
  requested_at    timestamptz NOT NULL DEFAULT now(),
  method          text NOT NULL DEFAULT 'manual' CHECK (method IN ('manual', 'assisted', 'automatic')),
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  lock_token      uuid,
  locked_until    timestamptz,
  attempts        int NOT NULL DEFAULT 0,
  last_error      text,
  evidence_id     uuid,
  completed_at    timestamptz
);
CREATE UNIQUE INDEX mail_filings_once ON huis.mail_filings (message_id, matter_id) WHERE status <> 'failed';
CREATE INDEX mail_filings_queue ON huis.mail_filings (requested_at) WHERE status IN ('queued', 'running');

-- ---------------------------------------------------------------------------
-- Who may see a mailbox: its owner and the owner's delegates (same firm).
-- ---------------------------------------------------------------------------
CREATE FUNCTION huis.can_see_mailbox(p_connection_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT huis.is_internal_role(huis.app_role()) AND EXISTS (
    SELECT 1 FROM huis.mail_connections c
      JOIN huis.users o ON o.id = c.owner_user_id
     WHERE c.id = p_connection_id AND c.firm_id = huis.current_firm_id() AND c.status <> 'disconnected'
       -- The owner must still be active firm staff (not someone who has left).
       AND o.status = 'active' AND huis.is_internal_role(o.role)
       AND (c.owner_user_id = huis.current_user_id()
            OR EXISTS (SELECT 1 FROM huis.mail_delegates d JOIN huis.users u ON u.id = d.user_id
                        WHERE d.connection_id = c.id AND d.user_id = huis.current_user_id()
                          AND u.status = 'active' AND huis.is_internal_role(u.role) AND u.role <> 'read_only')))
$$;
ALTER FUNCTION huis.can_see_mailbox(uuid) OWNER TO huis_security;

ALTER TABLE huis.mail_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.mail_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.mail_delegates   ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.mail_folders     ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.mail_messages    ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.mail_filings     ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.mail_connections FORCE ROW LEVEL SECURITY;
ALTER TABLE huis.mail_credentials FORCE ROW LEVEL SECURITY;
ALTER TABLE huis.mail_delegates   FORCE ROW LEVEL SECURITY;
ALTER TABLE huis.mail_folders     FORCE ROW LEVEL SECURITY;
ALTER TABLE huis.mail_messages    FORCE ROW LEVEL SECURITY;
ALTER TABLE huis.mail_filings     FORCE ROW LEVEL SECURITY;

REVOKE ALL ON huis.mail_connections, huis.mail_credentials, huis.mail_delegates, huis.mail_folders,
  huis.mail_messages, huis.mail_filings FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON huis.mail_connections, huis.mail_credentials, huis.mail_delegates,
  huis.mail_folders, huis.mail_messages, huis.mail_filings TO huis_security;

-- The app reads; all changes go through the functions below.
GRANT SELECT (id, firm_id, owner_user_id, provider, account_address, display_name, scope, sync_since, manage, status,
  last_synced_at, last_error, next_sync_at, created_at) ON huis.mail_connections TO huis_app;
GRANT SELECT ON huis.mail_delegates, huis.mail_messages, huis.mail_filings TO huis_app;
GRANT SELECT (id, firm_id, connection_id, provider_folder_id, parent_provider_id, display_name, path, included,
  well_known, total_items, last_synced_at) ON huis.mail_folders TO huis_app;
-- (mail_credentials: no app access at all.)

CREATE POLICY mail_connections_select ON huis.mail_connections FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.can_see_mailbox(id));
CREATE POLICY mail_delegates_select ON huis.mail_delegates FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.can_see_mailbox(connection_id));
CREATE POLICY mail_folders_select ON huis.mail_folders FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.can_see_mailbox(connection_id));
CREATE POLICY mail_messages_select ON huis.mail_messages FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.can_see_mailbox(connection_id));
CREATE POLICY mail_filings_select ON huis.mail_filings FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id()
         AND EXISTS (SELECT 1 FROM huis.mail_messages m WHERE m.id = message_id));

-- ---------------------------------------------------------------------------
-- App functions
-- ---------------------------------------------------------------------------
-- Connects (or reconnects) a mailbox for the current user.
CREATE FUNCTION huis.connect_mailbox(
  p_provider text, p_account_subject text, p_account_address text, p_display_name text, p_ciphertext bytea, p_connection_id uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, public, pg_temp AS $$
DECLARE
  c huis.mail_connections;
BEGIN
  IF NOT huis.is_internal_role(huis.app_role()) OR huis.app_role() = 'read_only' THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
  END IF;
  IF p_provider NOT IN ('microsoft', 'google') OR coalesce(p_account_subject, '') = '' OR p_ciphertext IS NULL THEN
    RAISE EXCEPTION 'invalid mailbox';
  END IF;
  SELECT * INTO c FROM huis.mail_connections
   WHERE firm_id = huis.current_firm_id() AND provider = p_provider AND account_subject = p_account_subject FOR UPDATE;
  IF FOUND AND c.owner_user_id <> huis.current_user_id() THEN
    -- One owner per mailbox. A connection that never worked (never synced),
    -- needs reconnecting or was disconnected can be taken over by whoever
    -- next connects with a working sign-in — so nobody can block a colleague
    -- by claiming their account first. Taking over wipes everything held
    -- for the old connection (credentials, mail, folders, delegates).
    IF c.last_synced_at IS NOT NULL AND c.status IN ('active', 'paused') THEN RETURN NULL; END IF;
    DELETE FROM huis.mail_messages WHERE connection_id = c.id;
    DELETE FROM huis.mail_folders WHERE connection_id = c.id;
    DELETE FROM huis.mail_delegates WHERE connection_id = c.id;
    DELETE FROM huis.mail_credentials WHERE connection_id = c.id;
    UPDATE huis.mail_connections SET owner_user_id = huis.current_user_id(), status = 'active', last_error = NULL,
           last_synced_at = NULL, scope = 'all', sync_since = NULL, manage = false, lock_token = NULL, locked_until = NULL,
           account_address = left(p_account_address, 320), display_name = left(p_display_name, 200), next_sync_at = now()
     WHERE id = c.id RETURNING * INTO c;
  ELSIF FOUND THEN
    UPDATE huis.mail_connections SET status = 'active', last_error = NULL, account_address = left(p_account_address, 320),
           display_name = left(p_display_name, 200), next_sync_at = now() WHERE id = c.id;
  ELSE
    INSERT INTO huis.mail_connections (id, firm_id, owner_user_id, provider, account_subject, account_address, display_name)
      VALUES (p_connection_id, huis.current_firm_id(), huis.current_user_id(), p_provider, left(p_account_subject, 200),
              left(p_account_address, 320), left(p_display_name, 200))
      RETURNING * INTO c;
  END IF;
  INSERT INTO huis.mail_credentials (connection_id, ciphertext) VALUES (c.id, p_ciphertext)
    ON CONFLICT (connection_id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, updated_at = now();
  RETURN c.id;
END $$;

-- Owner-only mailbox settings.
CREATE FUNCTION huis.update_mailbox(
  p_connection_id uuid, p_scope text, p_sync_since date, p_manage boolean, p_status text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, public, pg_temp AS $$
DECLARE
  c huis.mail_connections;
BEGIN
  IF NOT huis.is_internal_role(huis.app_role()) THEN RETURN false; END IF;
  SELECT * INTO c FROM huis.mail_connections
   WHERE id = p_connection_id AND firm_id = huis.current_firm_id() AND owner_user_id = huis.current_user_id() FOR UPDATE;
  IF NOT FOUND OR c.status = 'disconnected' THEN RETURN false; END IF;
  IF p_scope NOT IN ('all', 'selected') OR p_status NOT IN ('active', 'paused', 'disconnected') THEN
    RAISE EXCEPTION 'invalid settings';
  END IF;
  UPDATE huis.mail_connections SET scope = p_scope, sync_since = p_sync_since, manage = coalesce(p_manage, false),
         status = p_status, next_sync_at = now() WHERE id = c.id;
  IF p_status = 'disconnected' THEN
    -- Disconnecting deletes the credentials and all unfiled mail; filed copies stay in their Matters.
    DELETE FROM huis.mail_credentials WHERE connection_id = c.id;
    -- Every message goes, including ones waiting to be filed (their filing
    -- requests go with them; a filing already in progress then can't complete).
    DELETE FROM huis.mail_messages WHERE connection_id = c.id;
    DELETE FROM huis.mail_folders WHERE connection_id = c.id;
    DELETE FROM huis.mail_delegates WHERE connection_id = c.id;
  END IF;
  RETURN true;
END $$;

CREATE FUNCTION huis.set_mail_folder_included(p_folder_id uuid, p_included boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, public, pg_temp AS $$
BEGIN
  IF NOT huis.is_internal_role(huis.app_role()) THEN RETURN false; END IF;
  UPDATE huis.mail_folders f SET included = coalesce(p_included, false)
   WHERE f.id = p_folder_id AND f.firm_id = huis.current_firm_id()
     AND EXISTS (SELECT 1 FROM huis.mail_connections c WHERE c.id = f.connection_id AND c.owner_user_id = huis.current_user_id());
  RETURN FOUND;
END $$;

-- The owner grants or removes a delegate (internal, non-read-only staff in the same firm).
CREATE FUNCTION huis.set_mail_delegate(p_connection_id uuid, p_user_id uuid, p_granted boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, public, pg_temp AS $$
DECLARE
  c huis.mail_connections;
  u huis.users;
BEGIN
  IF NOT huis.is_internal_role(huis.app_role()) THEN RETURN false; END IF;
  SELECT * INTO c FROM huis.mail_connections
   WHERE id = p_connection_id AND firm_id = huis.current_firm_id() AND owner_user_id = huis.current_user_id();
  IF NOT FOUND THEN RETURN false; END IF;
  IF NOT coalesce(p_granted, false) THEN
    DELETE FROM huis.mail_delegates WHERE connection_id = c.id AND user_id = p_user_id;
    -- Their filing requests that haven't run yet are cancelled too.
    UPDATE huis.mail_filings f SET status = 'failed', last_error = 'access removed', lock_token = NULL
     WHERE f.requested_by = p_user_id AND f.status = 'queued'
       AND EXISTS (SELECT 1 FROM huis.mail_messages m WHERE m.id = f.message_id AND m.connection_id = c.id);
    RETURN true;
  END IF;
  SELECT * INTO u FROM huis.users WHERE id = p_user_id AND firm_id = c.firm_id AND status = 'active';
  IF NOT FOUND OR NOT huis.is_internal_role(u.role) OR u.role = 'read_only' OR u.id = c.owner_user_id THEN RETURN false; END IF;
  INSERT INTO huis.mail_delegates (connection_id, firm_id, user_id, granted_by)
    VALUES (c.id, c.firm_id, u.id, huis.current_user_id()) ON CONFLICT DO NOTHING;
  RETURN true;
END $$;

-- Asks Huis to file an email into a Matter.
CREATE FUNCTION huis.request_mail_filing(
  p_message_id uuid, p_matter_id uuid, p_folder_id uuid, p_acknowledged boolean, p_method text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, public, pg_temp AS $$
DECLARE
  m  huis.mail_messages;
  f  huis.matter_folders;
  v_exposes boolean;
  v_id uuid;
BEGIN
  SELECT * INTO m FROM huis.mail_messages WHERE id = p_message_id AND firm_id = huis.current_firm_id();
  IF NOT FOUND OR NOT huis.can_see_mailbox(m.connection_id) THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
  END IF;
  IF NOT huis.can_see_matter(p_matter_id) OR NOT huis.can_manage_matter_content(p_matter_id) THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
  END IF;
  IF m.removed_at IS NOT NULL THEN RETURN 'removed'; END IF;
  SELECT * INTO f FROM huis.matter_folders WHERE id = p_folder_id AND matter_id = p_matter_id AND firm_id = m.firm_id;
  IF NOT FOUND THEN RETURN 'folder_not_found'; END IF;
  v_exposes := NOT f.is_privileged_area
    AND f.classification IN ('client_accessible', 'co_counsel_accessible', 'expert_accessible', 'public');
  IF v_exposes AND NOT coalesce(p_acknowledged, false) THEN RETURN 'acknowledgement_required'; END IF;
  IF EXISTS (SELECT 1 FROM huis.mail_filings WHERE message_id = m.id AND matter_id = p_matter_id AND status <> 'failed') THEN
    RETURN 'already_filed';
  END IF;
  INSERT INTO huis.mail_filings (firm_id, message_id, matter_id, folder_id, shared_outside_firm, requested_by, method)
    VALUES (m.firm_id, m.id, p_matter_id, f.id, v_exposes, huis.current_user_id(),
            CASE WHEN p_method IN ('manual', 'assisted') THEN p_method ELSE 'manual' END)
    RETURNING id INTO v_id;
  RETURN v_id::text;
END $$;

ALTER FUNCTION huis.connect_mailbox(text, text, text, text, bytea, uuid) OWNER TO huis_security;
ALTER FUNCTION huis.update_mailbox(uuid, text, date, boolean, text) OWNER TO huis_security;
ALTER FUNCTION huis.set_mail_folder_included(uuid, boolean) OWNER TO huis_security;
ALTER FUNCTION huis.set_mail_delegate(uuid, uuid, boolean) OWNER TO huis_security;
ALTER FUNCTION huis.request_mail_filing(uuid, uuid, uuid, boolean, text) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.connect_mailbox(text, text, text, text, bytea, uuid), huis.update_mailbox(uuid, text, date, boolean, text),
  huis.set_mail_folder_included(uuid, boolean), huis.set_mail_delegate(uuid, uuid, boolean),
  huis.request_mail_filing(uuid, uuid, uuid, boolean, text), huis.can_see_mailbox(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.connect_mailbox(text, text, text, text, bytea, uuid), huis.update_mailbox(uuid, text, date, boolean, text),
  huis.set_mail_folder_included(uuid, boolean), huis.set_mail_delegate(uuid, uuid, boolean),
  huis.request_mail_filing(uuid, uuid, uuid, boolean, text), huis.can_see_mailbox(uuid) TO huis_app;

-- ---------------------------------------------------------------------------
-- Worker functions: sync and filing
-- ---------------------------------------------------------------------------
CREATE FUNCTION huis.worker_claim_mailbox()
RETURNS TABLE (connection_id uuid, lock_token uuid, firm_id uuid, provider text, account_subject text, scope text, sync_since date, ciphertext bytea)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
#variable_conflict use_column
DECLARE
  c huis.mail_connections;
  v_token uuid := gen_random_uuid();
BEGIN
  SELECT mc.* INTO c FROM huis.mail_connections mc JOIN huis.users o ON o.id = mc.owner_user_id
   WHERE mc.status = 'active' AND mc.next_sync_at <= now() AND (mc.locked_until IS NULL OR mc.locked_until < now())
     AND o.status = 'active' AND huis.is_internal_role(o.role)
   ORDER BY mc.next_sync_at FOR UPDATE OF mc SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE huis.mail_connections SET lock_token = v_token, locked_until = now() + interval '30 minutes' WHERE id = c.id;
  RETURN QUERY SELECT c.id, v_token, c.firm_id, c.provider, c.account_subject, c.scope, c.sync_since,
    (SELECT k.ciphertext FROM huis.mail_credentials k WHERE k.connection_id = c.id);
END $$;

CREATE FUNCTION huis.worker_held_mailbox(p_connection_id uuid, p_lock_token uuid) RETURNS huis.mail_connections
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE c huis.mail_connections;
BEGIN
  SELECT * INTO c FROM huis.mail_connections WHERE id = p_connection_id AND lock_token = p_lock_token AND locked_until > now();
  IF NOT FOUND THEN RAISE EXCEPTION 'mailbox is not held by this worker'; END IF;
  RETURN c;
END $$;

CREATE FUNCTION huis.worker_save_credentials(p_connection_id uuid, p_lock_token uuid, p_ciphertext bytea) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
BEGIN
  PERFORM huis.worker_held_mailbox(p_connection_id, p_lock_token);
  UPDATE huis.mail_credentials SET ciphertext = p_ciphertext, updated_at = now() WHERE connection_id = p_connection_id;
END $$;

-- Folders seen in the mailbox. New folders are included when the mailbox
-- syncs everything; with "selected folders" they start excluded.
CREATE FUNCTION huis.worker_upsert_mail_folder(
  p_connection_id uuid, p_lock_token uuid, p_provider_folder_id text, p_parent text, p_name text, p_path text,
  p_well_known text, p_total int
) RETURNS TABLE (folder_id uuid, included boolean, delta_link text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
#variable_conflict use_column
DECLARE
  c huis.mail_connections;
  f huis.mail_folders;
BEGIN
  c := huis.worker_held_mailbox(p_connection_id, p_lock_token);
  INSERT INTO huis.mail_folders (firm_id, connection_id, provider_folder_id, parent_provider_id, display_name, path, well_known, total_items, included)
    VALUES (c.firm_id, c.id, left(p_provider_folder_id, 1000), left(p_parent, 1000), left(coalesce(nullif(p_name, ''), '(unnamed)'), 300),
            left(p_path, 2000), left(p_well_known, 50), p_total, c.scope = 'all')
    ON CONFLICT (connection_id, provider_folder_id) DO UPDATE
      SET display_name = EXCLUDED.display_name, path = EXCLUDED.path, parent_provider_id = EXCLUDED.parent_provider_id,
          total_items = EXCLUDED.total_items, well_known = EXCLUDED.well_known
    RETURNING * INTO f;
  RETURN QUERY SELECT f.id, f.included, f.delta_link;
END $$;

CREATE FUNCTION huis.worker_save_mail_folder_state(p_connection_id uuid, p_lock_token uuid, p_folder_id uuid, p_delta_link text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
BEGIN
  PERFORM huis.worker_held_mailbox(p_connection_id, p_lock_token);
  UPDATE huis.mail_folders SET delta_link = left(p_delta_link, 8000), last_synced_at = now()
   WHERE id = p_folder_id AND connection_id = p_connection_id;
END $$;

-- Saves a batch of messages (JSON array) for one folder.
CREATE FUNCTION huis.worker_save_mail_messages(p_connection_id uuid, p_lock_token uuid, p_folder_id uuid, p_messages jsonb) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE
  c huis.mail_connections;
  n int := 0;
  r jsonb;
BEGIN
  c := huis.worker_held_mailbox(p_connection_id, p_lock_token);
  IF NOT EXISTS (SELECT 1 FROM huis.mail_folders WHERE id = p_folder_id AND connection_id = c.id) THEN
    RAISE EXCEPTION 'unknown folder';
  END IF;
  IF jsonb_typeof(p_messages) <> 'array' OR jsonb_array_length(p_messages) > 500 THEN RAISE EXCEPTION 'invalid batch'; END IF;
  FOR r IN SELECT * FROM jsonb_array_elements(p_messages) LOOP
   BEGIN
    IF (r->>'removed')::boolean IS TRUE THEN
      UPDATE huis.mail_messages SET removed_at = coalesce(removed_at, now()), updated_at = now()
       WHERE connection_id = c.id AND provider_message_id = r->>'id';
    ELSE
      INSERT INTO huis.mail_messages (firm_id, connection_id, folder_id, provider_message_id, internet_message_id, conversation_id,
          subject, from_address, from_name, to_addresses, cc_addresses, received_at, sent_at, has_attachments, importance,
          is_read, preview, body_text)
        VALUES (c.firm_id, c.id, p_folder_id, left(r->>'id', 1000), left(r->>'internetMessageId', 1000), left(r->>'conversationId', 1000),
          left(r->>'subject', 1000), left(lower(r->>'fromAddress'), 320), left(r->>'fromName', 300),
          ARRAY(SELECT left(lower(x), 320) FROM jsonb_array_elements_text(coalesce(r->'to', '[]'::jsonb)) x LIMIT 500),
          ARRAY(SELECT left(lower(x), 320) FROM jsonb_array_elements_text(coalesce(r->'cc', '[]'::jsonb)) x LIMIT 500),
          (r->>'receivedAt')::timestamptz, (r->>'sentAt')::timestamptz, coalesce((r->>'hasAttachments')::boolean, false),
          left(r->>'importance', 20), (r->>'isRead')::boolean, left(r->>'preview', 1000), left(r->>'body', 1000000))
        ON CONFLICT (connection_id, provider_message_id) DO UPDATE
          SET folder_id = EXCLUDED.folder_id, subject = EXCLUDED.subject, is_read = EXCLUDED.is_read,
              preview = EXCLUDED.preview, body_text = EXCLUDED.body_text, removed_at = NULL, updated_at = now();
    END IF;
    n := n + 1;
   EXCEPTION WHEN others THEN
    -- One malformed message (bad characters, impossible dates) is skipped;
    -- it must never stop the rest of the mailbox from syncing.
    NULL;
   END;
  END LOOP;
  RETURN n;
END $$;

CREATE FUNCTION huis.worker_finish_mailbox(p_connection_id uuid, p_lock_token uuid, p_error text, p_needs_reconnect boolean, p_more boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE c huis.mail_connections;
BEGIN
  c := huis.worker_held_mailbox(p_connection_id, p_lock_token);
  UPDATE huis.mail_connections
     SET lock_token = NULL, locked_until = NULL,
         last_error = left(p_error, 500),
         last_synced_at = CASE WHEN p_error IS NULL THEN now() ELSE last_synced_at END,
         status = CASE WHEN p_needs_reconnect THEN 'needs_reconnect' ELSE status END,
         -- More to import: continue soon. Otherwise: every 5 minutes if Huis manages
         -- the mailbox, else wait for the next manual "Sync now".
         next_sync_at = CASE WHEN p_more THEN now() + interval '5 seconds'
                             WHEN p_error IS NOT NULL THEN now() + interval '15 minutes'
                             WHEN c.manage THEN now() + interval '5 minutes'
                             ELSE 'infinity'::timestamptz END
   WHERE id = c.id;
END $$;

-- Is the person who asked for this filing still allowed to make it? Checked
-- again when the worker picks it up and when it completes, as that person:
-- still active staff, still able to see the mailbox, still able to add to the
-- Matter (walls included), and the folder hasn't become visible to outsiders
-- without the privilege acknowledgement.
CREATE FUNCTION huis.filing_still_allowed(p_filing_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, public, pg_temp AS $$
DECLARE
  r huis.mail_filings;
  m huis.mail_messages;
  u huis.users;
  f huis.matter_folders;
  v_exposes boolean;
BEGIN
  SELECT * INTO r FROM huis.mail_filings WHERE id = p_filing_id;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO m FROM huis.mail_messages WHERE id = r.message_id;
  IF NOT FOUND OR m.removed_at IS NOT NULL THEN RETURN false; END IF;
  SELECT * INTO u FROM huis.users WHERE id = r.requested_by AND firm_id = r.firm_id;
  IF NOT FOUND OR u.status <> 'active' OR NOT huis.is_internal_role(u.role) OR u.role = 'read_only' THEN RETURN false; END IF;
  -- Evaluate the permission checks as the requester, for this transaction only.
  PERFORM set_config('app.firm_id', r.firm_id::text, true);
  PERFORM set_config('app.user_id', r.requested_by::text, true);
  IF NOT huis.can_see_mailbox(m.connection_id) OR NOT huis.can_see_matter(r.matter_id)
     OR NOT huis.can_manage_matter_content(r.matter_id) THEN
    RETURN false;
  END IF;
  SELECT * INTO f FROM huis.matter_folders WHERE id = r.folder_id AND matter_id = r.matter_id;
  IF NOT FOUND THEN RETURN false; END IF;
  v_exposes := NOT f.is_privileged_area
    AND f.classification IN ('client_accessible', 'co_counsel_accessible', 'expert_accessible', 'public');
  RETURN NOT v_exposes OR r.shared_outside_firm;
END $$;
ALTER FUNCTION huis.filing_still_allowed(uuid) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.filing_still_allowed(uuid) FROM PUBLIC;

-- Filing: claim, complete, fail.
-- Saves a refresh token Microsoft rotated while a filing was being fetched.
CREATE FUNCTION huis.worker_save_filing_credentials(p_filing_id uuid, p_lock_token uuid, p_ciphertext bytea) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE r huis.mail_filings;
BEGIN
  SELECT * INTO r FROM huis.mail_filings WHERE id = p_filing_id AND status = 'running' AND lock_token = p_lock_token;
  IF NOT FOUND THEN RAISE EXCEPTION 'filing is not held by this worker'; END IF;
  UPDATE huis.mail_credentials k SET ciphertext = p_ciphertext, updated_at = now()
    FROM huis.mail_messages m WHERE m.id = r.message_id AND k.connection_id = m.connection_id;
END $$;
ALTER FUNCTION huis.worker_save_filing_credentials(uuid, uuid, bytea) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.worker_save_filing_credentials(uuid, uuid, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.worker_save_filing_credentials(uuid, uuid, bytea) TO huis_worker;

CREATE FUNCTION huis.worker_claim_mail_filing()
RETURNS TABLE (filing_id uuid, lock_token uuid, firm_id uuid, matter_id uuid, connection_id uuid, provider text,
               account_subject text, provider_message_id text, ciphertext bytea, attempts int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
#variable_conflict use_column
DECLARE
  r huis.mail_filings;
  m huis.mail_messages;
  c huis.mail_connections;
  v_token uuid := gen_random_uuid();
BEGIN
  LOOP
    SELECT * INTO r FROM huis.mail_filings
     WHERE (status = 'queued' OR (status = 'running' AND locked_until < now())) AND attempts < 5
     ORDER BY requested_at FOR UPDATE SKIP LOCKED LIMIT 1;
    IF NOT FOUND THEN RETURN; END IF;
    EXIT WHEN huis.filing_still_allowed(r.id);
    UPDATE huis.mail_filings SET status = 'failed', last_error = 'the requester no longer has access', lock_token = NULL
     WHERE id = r.id;
  END LOOP;
  UPDATE huis.mail_filings SET status = 'running', lock_token = v_token, attempts = attempts + 1,
         locked_until = now() + interval '30 minutes' WHERE id = r.id;
  SELECT * INTO m FROM huis.mail_messages WHERE id = r.message_id;
  SELECT * INTO c FROM huis.mail_connections WHERE id = m.connection_id;
  RETURN QUERY SELECT r.id, v_token, r.firm_id, r.matter_id, c.id, c.provider, c.account_subject, m.provider_message_id,
    (SELECT k.ciphertext FROM huis.mail_credentials k WHERE k.connection_id = c.id), r.attempts + 1;
END $$;

CREATE FUNCTION huis.worker_complete_mail_filing(
  p_filing_id uuid, p_lock_token uuid, p_evidence_id uuid, p_size bigint, p_sha256 text, p_storage_key text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, public, pg_temp AS $$
DECLARE
  r huis.mail_filings;
  m huis.mail_messages;
  c huis.mail_connections;
  v_name text;
BEGIN
  SELECT * INTO r FROM huis.mail_filings WHERE id = p_filing_id AND status = 'running' AND lock_token = p_lock_token FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'filing is not held by this worker'; END IF;
  IF p_storage_key IS DISTINCT FROM format('firm/%s/matter/%s/evidence/%s/original', r.firm_id, r.matter_id, p_evidence_id) THEN
    RAISE EXCEPTION 'unexpected storage location';
  END IF;
  IF NOT huis.filing_still_allowed(r.id) THEN
    UPDATE huis.mail_filings SET status = 'failed', last_error = 'the requester no longer has access', lock_token = NULL WHERE id = r.id;
    RETURN false;
  END IF;
  SELECT * INTO m FROM huis.mail_messages WHERE id = r.message_id;
  SELECT * INTO c FROM huis.mail_connections WHERE id = m.connection_id;
  -- "2025-04-18 Re March meeting.eml"
  v_name := left(coalesce(to_char(m.received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') || ' ', '') ||
            coalesce(nullif(btrim(regexp_replace(regexp_replace(m.subject, '[\x00-\x1f/\\:*?"<>|]+', ' ', 'g'), '\s+', ' ', 'g')), ''), '(no subject)'), 200) || '.eml';
  INSERT INTO huis.evidence_items (id, firm_id, matter_id, folder_id, original_filename, declared_content_type,
      size_bytes, sha256, storage_key, source, received_from, date_received, uploaded_by, uploaded_at)
    VALUES (p_evidence_id, r.firm_id, r.matter_id, r.folder_id, v_name, 'message/rfc822', p_size, p_sha256, p_storage_key,
      'mailbox', left(coalesce(m.from_address, 'unknown sender'), 300), (m.received_at AT TIME ZONE 'UTC')::date,
      r.requested_by, now());
  INSERT INTO huis.evidence_custody_events (firm_id, evidence_id, event, details)
    VALUES (r.firm_id, p_evidence_id, 'filed_from_mailbox', jsonb_build_object(
      'mailbox', c.account_address, 'provider', c.provider, 'internet_message_id', m.internet_message_id,
      'received_at', m.received_at, 'filed_by', r.requested_by, 'method', r.method,
      'shared_outside_firm', r.shared_outside_firm,
      'privilege_waiver_acknowledged', CASE WHEN r.shared_outside_firm THEN true ELSE NULL END,
      'retrieved_at', now()));
  UPDATE huis.mail_filings SET status = 'done', evidence_id = p_evidence_id, completed_at = now(), lock_token = NULL WHERE id = r.id;
  UPDATE huis.mail_messages SET filed_matter_id = r.matter_id, filed_evidence_id = p_evidence_id, filed_at = now(),
         filed_by = r.requested_by, updated_at = now() WHERE id = m.id;
  RETURN true;
END $$;

CREATE FUNCTION huis.worker_fail_mail_filing(p_filing_id uuid, p_lock_token uuid, p_error text, p_final boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
BEGIN
  UPDATE huis.mail_filings
     SET status = CASE WHEN p_final OR attempts >= 5 THEN 'failed' ELSE 'queued' END,
         last_error = left(p_error, 500), lock_token = NULL, locked_until = NULL
   WHERE id = p_filing_id AND status = 'running' AND lock_token = p_lock_token;
END $$;

ALTER FUNCTION huis.worker_claim_mailbox() OWNER TO huis_security;
ALTER FUNCTION huis.worker_held_mailbox(uuid, uuid) OWNER TO huis_security;
ALTER FUNCTION huis.worker_save_credentials(uuid, uuid, bytea) OWNER TO huis_security;
ALTER FUNCTION huis.worker_upsert_mail_folder(uuid, uuid, text, text, text, text, text, int) OWNER TO huis_security;
ALTER FUNCTION huis.worker_save_mail_folder_state(uuid, uuid, uuid, text) OWNER TO huis_security;
ALTER FUNCTION huis.worker_save_mail_messages(uuid, uuid, uuid, jsonb) OWNER TO huis_security;
ALTER FUNCTION huis.worker_finish_mailbox(uuid, uuid, text, boolean, boolean) OWNER TO huis_security;
ALTER FUNCTION huis.worker_claim_mail_filing() OWNER TO huis_security;
ALTER FUNCTION huis.worker_complete_mail_filing(uuid, uuid, uuid, bigint, text, text) OWNER TO huis_security;
ALTER FUNCTION huis.worker_fail_mail_filing(uuid, uuid, text, boolean) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.worker_claim_mailbox(), huis.worker_held_mailbox(uuid, uuid), huis.worker_save_credentials(uuid, uuid, bytea),
  huis.worker_upsert_mail_folder(uuid, uuid, text, text, text, text, text, int), huis.worker_save_mail_folder_state(uuid, uuid, uuid, text),
  huis.worker_save_mail_messages(uuid, uuid, uuid, jsonb), huis.worker_finish_mailbox(uuid, uuid, text, boolean, boolean),
  huis.worker_claim_mail_filing(), huis.worker_complete_mail_filing(uuid, uuid, uuid, bigint, text, text),
  huis.worker_fail_mail_filing(uuid, uuid, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.worker_claim_mailbox(), huis.worker_save_credentials(uuid, uuid, bytea),
  huis.worker_upsert_mail_folder(uuid, uuid, text, text, text, text, text, int), huis.worker_save_mail_folder_state(uuid, uuid, uuid, text),
  huis.worker_save_mail_messages(uuid, uuid, uuid, jsonb), huis.worker_finish_mailbox(uuid, uuid, text, boolean, boolean),
  huis.worker_claim_mail_filing(), huis.worker_complete_mail_filing(uuid, uuid, uuid, bigint, text, text),
  huis.worker_fail_mail_filing(uuid, uuid, text, boolean) TO huis_worker;
GRANT EXECUTE ON FUNCTION huis.worker_held_mailbox(uuid, uuid) TO huis_security;

-- "Sync now" (owner or delegate).
CREATE FUNCTION huis.request_mailbox_sync(p_connection_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, public, pg_temp AS $$
BEGIN
  IF NOT huis.can_see_mailbox(p_connection_id) THEN RETURN false; END IF;
  UPDATE huis.mail_connections SET next_sync_at = now() WHERE id = p_connection_id AND status = 'active';
  RETURN FOUND;
END $$;
ALTER FUNCTION huis.request_mailbox_sync(uuid) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.request_mailbox_sync(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.request_mailbox_sync(uuid) TO huis_app;

-- Mailbox filings are created by the worker; the app can never insert 'mailbox' evidence.
DROP POLICY evidence_insert ON huis.evidence_items;
CREATE POLICY evidence_insert ON huis.evidence_items FOR INSERT TO huis_app
  WITH CHECK (firm_id = huis.current_firm_id() AND uploaded_by = huis.current_user_id()
              AND status = 'pending_scan' AND duplicate_of IS NULL
              AND parent_id IS NULL AND container_path IS NULL AND depth = 0
              AND source::text NOT IN ('extracted', 'produced_copy', 'mailbox')
              AND extraction_status IS NULL AND extraction_detail IS NULL
              AND page_count IS NULL
              AND huis.can_see_matter(matter_id) AND huis.app_role() <> 'read_only'
              AND (huis.is_internal_role(huis.app_role())
                   OR (huis.app_role() = 'client' AND huis.folder_classification(folder_id) = 'client_accessible')));

-- Mailbox filings are, like produced copies, top-level items only the worker creates.
CREATE OR REPLACE FUNCTION huis.evidence_after_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, public, pg_temp AS $$
DECLARE
  v_parent huis.evidence_items;
  v_worker boolean := pg_has_role(session_user, 'huis_worker', 'MEMBER') AND NOT pg_has_role(session_user, 'huis_app', 'MEMBER');
BEGIN
  IF NEW.source::text IN ('produced_copy', 'mailbox') THEN
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
