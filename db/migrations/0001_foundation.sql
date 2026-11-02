-- Huis Law IP — Phase 1 foundation
-- Firms, locations, users, licenses, clients, contacts, matters, folders,
-- privilege classifications and the immutable audit log.
--
-- SECURITY MODEL (read before changing anything here)
-- * Every tenant table carries firm_id and has FORCED row-level security.
-- * The application connects as a login role that is a member of huis_app.
--   huis_app has no BYPASSRLS and owns nothing.
-- * Each request runs in a transaction that sets app.firm_id and app.user_id
--   (see src/db/tenant.ts). If they are not set, every policy returns no rows:
--   the system fails closed.
-- * A small number of SECURITY DEFINER functions owned by huis_security
--   (BYPASSRLS, NOLOGIN) exist only where tenant context cannot exist yet
--   (firm sign-up, sign-in lookup) or to avoid policy recursion. Each one
--   re-checks the firm itself and returns the minimum data.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'huis_app') THEN
    CREATE ROLE huis_app NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'huis_security') THEN
    CREATE ROLE huis_security NOLOGIN BYPASSRLS;
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS huis;
REVOKE ALL ON SCHEMA huis FROM PUBLIC;
GRANT USAGE ON SCHEMA huis TO huis_app, huis_security;

SET search_path = huis, public;

-- ---------------------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------------------
CREATE TYPE huis.firm_role AS ENUM (
  -- internal firm roles
  'firm_owner', 'managing_partner', 'firm_admin', 'attorney', 'paralegal',
  'legal_assistant', 'billing_admin', 'investigator', 'expert_consultant',
  'read_only',
  -- external roles (see only matters they are explicitly added to)
  'client', 'co_counsel', 'expert_witness', 'authorized_third_party'
);

CREATE TYPE huis.privilege_classification AS ENUM (
  'attorney_client_privileged', 'attorney_work_product', 'confidential',
  'highly_confidential', 'protective_order', 'internal_firm_only',
  'client_accessible', 'co_counsel_accessible', 'expert_accessible',
  'restricted', 'public'
);

CREATE TYPE huis.contact_kind AS ENUM (
  'opposing_counsel', 'opposing_party', 'judge', 'court_staff', 'witness',
  'expert', 'co_counsel', 'insurance_adjuster', 'other'
);

CREATE TYPE huis.matter_status AS ENUM ('intake', 'open', 'closed', 'archived');
CREATE TYPE huis.matter_access AS ENUM ('owner', 'edit', 'view');
CREATE TYPE huis.license_kind AS ENUM ('attorney', 'staff', 'external');
CREATE TYPE huis.record_status AS ENUM ('active', 'suspended', 'disabled');

-- ---------------------------------------------------------------------------
-- Context helpers (fail closed when context is missing)
-- ---------------------------------------------------------------------------
CREATE FUNCTION huis.current_firm_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.firm_id', true), '')::uuid
$$;

CREATE FUNCTION huis.current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE huis.firms (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL CHECK (length(trim(name)) > 0),
  slug          text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  state_code    char(2) NOT NULL CHECK (state_code ~ '^[A-Z]{2}$'),
  time_zone     text NOT NULL DEFAULT 'America/Denver',
  plan          text NOT NULL DEFAULT 'trial',
  trial_ends_at timestamptz,
  status        huis.record_status NOT NULL DEFAULT 'active',
  white_label   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE huis.firm_locations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id     uuid NOT NULL REFERENCES huis.firms(id),
  name        text NOT NULL CHECK (length(trim(name)) > 0),
  state_code  char(2) NOT NULL CHECK (state_code ~ '^[A-Z]{2}$'),
  address     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (firm_id, id)
);

-- A user account belongs to exactly one firm. A person licensed at two firms
-- has two accounts (decision #4), which keeps firms fully separated.
CREATE TABLE huis.users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id        uuid NOT NULL REFERENCES huis.firms(id),
  location_id    uuid,
  email          text NOT NULL CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  full_name      text NOT NULL CHECK (length(trim(full_name)) > 0),
  matter_code    text NOT NULL CHECK (matter_code ~ '^[A-Z0-9]{1,12}$'),
  role           huis.firm_role NOT NULL,
  status         huis.record_status NOT NULL DEFAULT 'active',
  auth_provider  text,
  auth_subject   text,
  mfa_required   boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (firm_id, id),
  FOREIGN KEY (firm_id, location_id) REFERENCES huis.firm_locations(firm_id, id)
);
CREATE UNIQUE INDEX users_firm_email_uq ON huis.users (firm_id, lower(email));
CREATE UNIQUE INDEX users_identity_uq ON huis.users (firm_id, auth_provider, auth_subject)
  WHERE auth_subject IS NOT NULL;
CREATE INDEX users_identity_lookup ON huis.users (auth_provider, auth_subject);

CREATE TABLE huis.licenses (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id      uuid NOT NULL REFERENCES huis.firms(id),
  location_id  uuid NOT NULL,
  user_id      uuid,
  kind         huis.license_kind NOT NULL,
  status       huis.record_status NOT NULL DEFAULT 'active',
  starts_at    timestamptz NOT NULL DEFAULT now(),
  ends_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (firm_id, location_id) REFERENCES huis.firm_locations(firm_id, id),
  FOREIGN KEY (firm_id, user_id) REFERENCES huis.users(firm_id, id)
);
CREATE UNIQUE INDEX licenses_one_active_per_user ON huis.licenses (user_id)
  WHERE status = 'active' AND user_id IS NOT NULL;

CREATE TABLE huis.clients (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id       uuid NOT NULL REFERENCES huis.firms(id),
  kind          text NOT NULL CHECK (kind IN ('person', 'organization')),
  display_name  text NOT NULL CHECK (length(trim(display_name)) > 0),
  email         text,
  phone         text,
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (firm_id, id),
  FOREIGN KEY (firm_id, created_by) REFERENCES huis.users(firm_id, id)
);

-- Reusable people profiles: opposing counsel, judges, witnesses, experts (#8)
CREATE TABLE huis.contacts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id       uuid NOT NULL REFERENCES huis.firms(id),
  kind          huis.contact_kind NOT NULL,
  full_name     text NOT NULL CHECK (length(trim(full_name)) > 0),
  organization  text,
  email         text,
  phone         text,
  bar_number    text,
  notes         text,
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (firm_id, id),
  FOREIGN KEY (firm_id, created_by) REFERENCES huis.users(firm_id, id)
);

CREATE TABLE huis.matter_number_counters (
  firm_id     uuid NOT NULL REFERENCES huis.firms(id),
  year        int NOT NULL,
  last_value  int NOT NULL,
  PRIMARY KEY (firm_id, year)
);

-- Two independent identifiers (#7): the court's case number and Huis's own
-- number, plus an optional firm-defined number. The UUID never changes.
CREATE TABLE huis.matters (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id             uuid NOT NULL REFERENCES huis.firms(id),
  location_id         uuid NOT NULL,
  client_id           uuid NOT NULL,
  title               text NOT NULL CHECK (length(trim(title)) > 0),
  huis_number         text NOT NULL,
  court_case_number   text,
  firm_matter_number  text,
  jurisdiction_state  char(2) NOT NULL CHECK (jurisdiction_state ~ '^[A-Z]{2}$'),
  court_name          text,
  practice_area       text,
  status              huis.matter_status NOT NULL DEFAULT 'open',
  restricted          boolean NOT NULL DEFAULT false,  -- ethical wall
  lead_attorney_id    uuid NOT NULL,
  opened_at           timestamptz NOT NULL DEFAULT now(),
  closed_at           timestamptz,
  created_by          uuid NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (firm_id, id),
  UNIQUE (firm_id, huis_number),
  FOREIGN KEY (firm_id, location_id) REFERENCES huis.firm_locations(firm_id, id),
  FOREIGN KEY (firm_id, client_id) REFERENCES huis.clients(firm_id, id),
  FOREIGN KEY (firm_id, lead_attorney_id) REFERENCES huis.users(firm_id, id),
  FOREIGN KEY (firm_id, created_by) REFERENCES huis.users(firm_id, id)
);
CREATE UNIQUE INDEX matters_firm_number_uq ON huis.matters (firm_id, firm_matter_number)
  WHERE firm_matter_number IS NOT NULL;
CREATE INDEX matters_court_case ON huis.matters (firm_id, court_case_number);

CREATE TABLE huis.matter_members (
  firm_id    uuid NOT NULL,
  matter_id  uuid NOT NULL,
  user_id    uuid NOT NULL,
  access     huis.matter_access NOT NULL,
  added_by   uuid NOT NULL,
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (matter_id, user_id),
  FOREIGN KEY (firm_id, matter_id) REFERENCES huis.matters(firm_id, id),
  FOREIGN KEY (firm_id, user_id) REFERENCES huis.users(firm_id, id),
  FOREIGN KEY (firm_id, added_by) REFERENCES huis.users(firm_id, id)
);
CREATE INDEX matter_members_user ON huis.matter_members (user_id);

CREATE TABLE huis.matter_contacts (
  firm_id     uuid NOT NULL,
  matter_id   uuid NOT NULL,
  contact_id  uuid NOT NULL,
  role_label  text,
  PRIMARY KEY (matter_id, contact_id),
  FOREIGN KEY (firm_id, matter_id) REFERENCES huis.matters(firm_id, id),
  FOREIGN KEY (firm_id, contact_id) REFERENCES huis.contacts(firm_id, id)
);

-- Folders inside a matter. Every matter gets a red Privileged & Confidential
-- area automatically. Being in that folder does NOT create privilege; it
-- records an attorney's designation.
CREATE TABLE huis.matter_folders (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id              uuid NOT NULL,
  matter_id            uuid NOT NULL,
  parent_id            uuid,
  name                 text NOT NULL CHECK (length(trim(name)) > 0),
  classification       huis.privilege_classification NOT NULL DEFAULT 'internal_firm_only',
  is_privileged_area   boolean NOT NULL DEFAULT false,
  color                text CHECK (color IS NULL OR color ~ '^#[0-9A-Fa-f]{6}$'),
  created_by           uuid NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (firm_id, id),
  FOREIGN KEY (firm_id, matter_id) REFERENCES huis.matters(firm_id, id),
  FOREIGN KEY (firm_id, parent_id) REFERENCES huis.matter_folders(firm_id, id),
  FOREIGN KEY (firm_id, created_by) REFERENCES huis.users(firm_id, id)
);
CREATE UNIQUE INDEX matter_folders_one_privileged_area ON huis.matter_folders (matter_id)
  WHERE is_privileged_area;

-- Append-only, hash-chained audit log
CREATE TABLE huis.audit_events (
  id             bigserial PRIMARY KEY,
  firm_id        uuid NOT NULL REFERENCES huis.firms(id),
  actor_user_id  uuid,
  action         text NOT NULL CHECK (action ~ '^[a-z_]+\.[a-z_.]+$'),
  target_type    text,
  target_id      uuid,
  matter_id      uuid,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_address     inet,
  user_agent     text,
  occurred_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  prev_hash      text,
  hash           text
);
CREATE INDEX audit_events_firm_time ON huis.audit_events (firm_id, id);
CREATE INDEX audit_events_matter ON huis.audit_events (firm_id, matter_id);

-- ---------------------------------------------------------------------------
-- Security-definer helpers (owned by huis_security; bypass RLS deliberately)
-- ---------------------------------------------------------------------------
CREATE FUNCTION huis.app_role() RETURNS huis.firm_role
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT u.role FROM huis.users u
  WHERE u.id = huis.current_user_id()
    AND u.firm_id = huis.current_firm_id()
    AND u.status = 'active'
$$;

CREATE FUNCTION huis.is_internal_role(r huis.firm_role) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT r IN ('firm_owner', 'managing_partner', 'firm_admin', 'attorney',
               'paralegal', 'legal_assistant', 'billing_admin', 'investigator',
               'expert_consultant', 'read_only')
$$;

CREATE FUNCTION huis.is_admin_role(r huis.firm_role) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT r IN ('firm_owner', 'managing_partner', 'firm_admin')
$$;

-- Can the current user see this matter?
--  * restricted (ethical wall) matters: explicit members only, no exceptions
--  * external users: explicit members only
--  * otherwise: any active internal user of the same firm
CREATE FUNCTION huis.can_see_matter(p_matter_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM huis.matters m
    WHERE m.id = p_matter_id
      AND m.firm_id = huis.current_firm_id()
      AND (
        EXISTS (SELECT 1 FROM huis.matter_members mm
                WHERE mm.matter_id = m.id AND mm.user_id = huis.current_user_id())
        OR (NOT m.restricted AND huis.is_internal_role(huis.app_role()))
      )
  )
$$;

CREATE FUNCTION huis.matter_access_level(p_matter_id uuid) RETURNS huis.matter_access
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT mm.access FROM huis.matter_members mm
  WHERE mm.matter_id = p_matter_id
    AND mm.firm_id = huis.current_firm_id()
    AND mm.user_id = huis.current_user_id()
$$;

-- Matter numbering: HUIS-<STATE>-<ATTORNEY CODE>-<YEAR>-<000001>
CREATE FUNCTION huis.assign_matter_number() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE
  v_year int;
  v_seq  int;
  v_code text;
  v_tz   text;
BEGIN
  IF NEW.firm_id IS DISTINCT FROM huis.current_firm_id() THEN
    RAISE EXCEPTION 'matter firm does not match the current firm context';
  END IF;
  IF NEW.huis_number IS NOT NULL AND NEW.huis_number <> '' THEN
    RETURN NEW;
  END IF;
  SELECT time_zone INTO v_tz FROM huis.firms WHERE id = NEW.firm_id;
  v_year := extract(year FROM (NEW.opened_at AT TIME ZONE coalesce(v_tz, 'UTC')))::int;
  SELECT matter_code INTO v_code FROM huis.users
    WHERE id = NEW.lead_attorney_id AND firm_id = NEW.firm_id
      AND status = 'active' AND role IN ('firm_owner', 'managing_partner', 'attorney');
  IF v_code IS NULL THEN
    RAISE EXCEPTION 'lead attorney must be an active attorney in this firm';
  END IF;
  INSERT INTO huis.matter_number_counters AS c (firm_id, year, last_value)
    VALUES (NEW.firm_id, v_year, 1)
    ON CONFLICT (firm_id, year) DO UPDATE SET last_value = c.last_value + 1
    RETURNING last_value INTO v_seq;
  NEW.huis_number := format('HUIS-%s-%s-%s-%s',
    NEW.jurisdiction_state, v_code, v_year, lpad(v_seq::text, 6, '0'));
  RETURN NEW;
END $$;

CREATE TRIGGER matters_assign_number BEFORE INSERT ON huis.matters
  FOR EACH ROW EXECUTE FUNCTION huis.assign_matter_number();

-- Every new matter, guaranteed at the database level:
--  * the creator and the lead attorney become matter owners (this is what lets
--    them see an ethically-walled matter they just created)
--  * a red Privileged & Confidential area and standard folders exist
--  * a matter.created audit event is written
CREATE FUNCTION huis.matter_after_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, public, pg_temp AS $$
DECLARE
  v_folder record;
BEGIN
  IF NEW.firm_id IS DISTINCT FROM huis.current_firm_id()
     OR NEW.created_by IS DISTINCT FROM huis.current_user_id() THEN
    RAISE EXCEPTION 'matter does not match the current firm and user context';
  END IF;

  INSERT INTO huis.matter_members (firm_id, matter_id, user_id, access, added_by)
    VALUES (NEW.firm_id, NEW.id, NEW.created_by, 'owner', NEW.created_by);
  IF NEW.lead_attorney_id <> NEW.created_by THEN
    INSERT INTO huis.matter_members (firm_id, matter_id, user_id, access, added_by)
      VALUES (NEW.firm_id, NEW.id, NEW.lead_attorney_id, 'owner', NEW.created_by);
  END IF;

  INSERT INTO huis.matter_folders (firm_id, matter_id, name, classification,
                                   is_privileged_area, color, created_by)
    VALUES (NEW.firm_id, NEW.id, 'Privileged & Confidential',
            'attorney_client_privileged', true, '#DC2626', NEW.created_by);

  FOR v_folder IN
    SELECT * FROM (VALUES
      ('Correspondence', 'internal_firm_only'::huis.privilege_classification),
      ('Pleadings & Court Filings', 'internal_firm_only'),
      ('Discovery', 'confidential'),
      ('Evidence', 'confidential'),
      ('Client Uploads', 'client_accessible'),
      ('Research', 'attorney_work_product'),
      ('Financial', 'confidential')
    ) AS f(name, classification)
  LOOP
    INSERT INTO huis.matter_folders (firm_id, matter_id, name, classification, created_by)
      VALUES (NEW.firm_id, NEW.id, v_folder.name, v_folder.classification, NEW.created_by);
  END LOOP;

  INSERT INTO huis.audit_events (firm_id, actor_user_id, action, target_type,
                                 target_id, matter_id, metadata)
    VALUES (NEW.firm_id, NEW.created_by, 'matter.created', 'matter', NEW.id, NEW.id,
            jsonb_build_object('huis_number', NEW.huis_number,
                               'restricted', NEW.restricted));
  RETURN NULL;
END $$;

CREATE TRIGGER matters_after_insert AFTER INSERT ON huis.matters
  FOR EACH ROW EXECUTE FUNCTION huis.matter_after_insert();

-- Audit chain: each event's hash covers the previous event's hash, so any
-- later edit or deletion of a row is detectable.
CREATE FUNCTION huis.audit_event_digest(e huis.audit_events, p_prev text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(public.digest(concat_ws('|',
    coalesce(p_prev, 'GENESIS'), e.id::text, e.firm_id::text,
    coalesce(e.actor_user_id::text, ''), e.action,
    coalesce(e.target_type, ''), coalesce(e.target_id::text, ''),
    coalesce(e.matter_id::text, ''), e.metadata::text,
    coalesce(host(e.ip_address), ''), coalesce(e.user_agent, ''),
    to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
  ), 'sha256'), 'hex')
$$;

CREATE FUNCTION huis.audit_chain_before_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, public, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.firm_id::text, 0));
  SELECT hash INTO NEW.prev_hash FROM huis.audit_events
    WHERE firm_id = NEW.firm_id ORDER BY id DESC LIMIT 1;
  NEW.occurred_at := clock_timestamp();
  NEW.hash := huis.audit_event_digest(NEW, NEW.prev_hash);
  RETURN NEW;
END $$;

CREATE TRIGGER audit_events_chain BEFORE INSERT ON huis.audit_events
  FOR EACH ROW EXECUTE FUNCTION huis.audit_chain_before_insert();

CREATE FUNCTION huis.audit_events_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit events are append-only';
END $$;

CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON huis.audit_events
  FOR EACH ROW EXECUTE FUNCTION huis.audit_events_immutable();
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON huis.audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION huis.audit_events_immutable();

-- Verify the current firm's audit chain. Returns the id of the first broken
-- event, or NULL if the chain is intact. Admin roles only.
CREATE FUNCTION huis.verify_audit_chain() RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = huis, public, pg_temp AS $$
DECLARE
  r      huis.audit_events;
  v_prev text := NULL;
BEGIN
  IF NOT huis.is_admin_role(huis.app_role()) THEN
    RAISE EXCEPTION 'not permitted';
  END IF;
  FOR r IN SELECT * FROM huis.audit_events
           WHERE firm_id = huis.current_firm_id() ORDER BY id LOOP
    IF r.prev_hash IS DISTINCT FROM v_prev
       OR r.hash IS DISTINCT FROM huis.audit_event_digest(r, v_prev) THEN
      RETURN r.id;
    END IF;
    v_prev := r.hash;
  END LOOP;
  RETURN NULL;
END $$;

-- Firm sign-up. Runs before any tenant context exists, so it is a definer
-- function: it creates a NEW firm, its first location, its owner and the
-- owner's license, and writes the first audit event. It can never touch an
-- existing firm.
CREATE FUNCTION huis.bootstrap_firm(
  p_firm_name text, p_slug text, p_state char(2), p_location_name text,
  p_owner_email text, p_owner_name text, p_owner_code text,
  p_auth_provider text, p_auth_subject text, p_trial_days int DEFAULT 7
) RETURNS TABLE (firm_id uuid, location_id uuid, owner_user_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, public, pg_temp AS $$
DECLARE
  v_firm uuid := gen_random_uuid();
  v_loc  uuid := gen_random_uuid();
  v_user uuid := gen_random_uuid();
BEGIN
  INSERT INTO huis.firms (id, name, slug, state_code, plan, trial_ends_at)
    VALUES (v_firm, p_firm_name, p_slug, p_state, 'trial',
            now() + make_interval(days => p_trial_days));
  INSERT INTO huis.firm_locations (id, firm_id, name, state_code)
    VALUES (v_loc, v_firm, p_location_name, p_state);
  INSERT INTO huis.users (id, firm_id, location_id, email, full_name, matter_code,
                          role, auth_provider, auth_subject)
    VALUES (v_user, v_firm, v_loc, p_owner_email, p_owner_name, p_owner_code,
            'firm_owner', p_auth_provider, p_auth_subject);
  INSERT INTO huis.licenses (firm_id, location_id, user_id, kind)
    VALUES (v_firm, v_loc, v_user, 'attorney');
  INSERT INTO huis.audit_events (firm_id, actor_user_id, action, target_type, target_id)
    VALUES (v_firm, v_user, 'firm.created', 'firm', v_firm);
  RETURN QUERY SELECT v_firm, v_loc, v_user;
END $$;

-- Sign-in lookup: which active accounts does this identity have?
-- Returns ids and names only — never matter or client data.
CREATE FUNCTION huis.resolve_identity(p_provider text, p_subject text)
RETURNS TABLE (firm_id uuid, user_id uuid, firm_name text, role huis.firm_role)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT u.firm_id, u.id, f.name, u.role
  FROM huis.users u JOIN huis.firms f ON f.id = u.firm_id
  WHERE u.auth_provider = p_provider AND u.auth_subject = p_subject
    AND u.status = 'active' AND f.status = 'active'
  ORDER BY f.name
$$;

ALTER FUNCTION huis.app_role() OWNER TO huis_security;
ALTER FUNCTION huis.can_see_matter(uuid) OWNER TO huis_security;
ALTER FUNCTION huis.matter_access_level(uuid) OWNER TO huis_security;
ALTER FUNCTION huis.assign_matter_number() OWNER TO huis_security;
ALTER FUNCTION huis.matter_after_insert() OWNER TO huis_security;
ALTER FUNCTION huis.audit_chain_before_insert() OWNER TO huis_security;
ALTER FUNCTION huis.verify_audit_chain() OWNER TO huis_security;
ALTER FUNCTION huis.bootstrap_firm(text, text, char, text, text, text, text, text, text, int) OWNER TO huis_security;
ALTER FUNCTION huis.resolve_identity(text, text) OWNER TO huis_security;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA huis FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  huis.current_firm_id(), huis.current_user_id(), huis.app_role(),
  huis.is_internal_role(huis.firm_role), huis.is_admin_role(huis.firm_role),
  huis.can_see_matter(uuid), huis.matter_access_level(uuid),
  huis.verify_audit_chain(),
  huis.bootstrap_firm(text, text, char, text, text, text, text, text, text, int),
  huis.resolve_identity(text, text)
TO huis_app;
GRANT EXECUTE ON FUNCTION
  huis.current_firm_id(), huis.current_user_id(),
  huis.is_internal_role(huis.firm_role), huis.is_admin_role(huis.firm_role),
  huis.audit_event_digest(huis.audit_events, text)
TO huis_security;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA huis TO huis_security;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA huis TO huis_security, huis_app;

GRANT SELECT, UPDATE ON huis.firms TO huis_app;
GRANT SELECT, INSERT, UPDATE ON huis.firm_locations, huis.users, huis.licenses,
  huis.clients, huis.contacts, huis.matters, huis.matter_folders TO huis_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON huis.matter_members, huis.matter_contacts TO huis_app;
GRANT SELECT, INSERT ON huis.audit_events TO huis_app;
-- matter_number_counters is only touched by the definer trigger.

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
ALTER TABLE huis.firms                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.firm_locations         ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.users                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.licenses               ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.clients                ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.contacts               ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.matter_number_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.matters                ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.matter_members         ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.matter_contacts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.matter_folders         ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.audit_events           ENABLE ROW LEVEL SECURITY;

ALTER TABLE huis.firms                  FORCE ROW LEVEL SECURITY;
ALTER TABLE huis.firm_locations         FORCE ROW LEVEL SECURITY;
ALTER TABLE huis.users                  FORCE ROW LEVEL SECURITY;
ALTER TABLE huis.licenses               FORCE ROW LEVEL SECURITY;
ALTER TABLE huis.clients                FORCE ROW LEVEL SECURITY;
ALTER TABLE huis.contacts               FORCE ROW LEVEL SECURITY;
ALTER TABLE huis.matter_number_counters FORCE ROW LEVEL SECURITY;
ALTER TABLE huis.matters                FORCE ROW LEVEL SECURITY;
ALTER TABLE huis.matter_members         FORCE ROW LEVEL SECURITY;
ALTER TABLE huis.matter_contacts        FORCE ROW LEVEL SECURITY;
ALTER TABLE huis.matter_folders         FORCE ROW LEVEL SECURITY;
ALTER TABLE huis.audit_events           FORCE ROW LEVEL SECURITY;

-- huis_security bypasses RLS by role attribute; no policies needed for it.

-- Firms: only your own firm; only admins may update it.
CREATE POLICY firms_select ON huis.firms FOR SELECT TO huis_app
  USING (id = huis.current_firm_id());
CREATE POLICY firms_update ON huis.firms FOR UPDATE TO huis_app
  USING (id = huis.current_firm_id() AND huis.is_admin_role(huis.app_role()))
  WITH CHECK (id = huis.current_firm_id());

-- Locations: visible to internal users; managed by admins.
CREATE POLICY locations_select ON huis.firm_locations FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.is_internal_role(huis.app_role()));
CREATE POLICY locations_write ON huis.firm_locations FOR INSERT TO huis_app
  WITH CHECK (firm_id = huis.current_firm_id() AND huis.is_admin_role(huis.app_role()));
CREATE POLICY locations_update ON huis.firm_locations FOR UPDATE TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.is_admin_role(huis.app_role()))
  WITH CHECK (firm_id = huis.current_firm_id());

-- Users: internal users see colleagues; external users see only themselves.
-- Only admins add or change users.
CREATE POLICY users_select ON huis.users FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id()
         AND (id = huis.current_user_id() OR huis.is_internal_role(huis.app_role())));
CREATE POLICY users_insert ON huis.users FOR INSERT TO huis_app
  WITH CHECK (firm_id = huis.current_firm_id() AND huis.is_admin_role(huis.app_role()));
CREATE POLICY users_update ON huis.users FOR UPDATE TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.is_admin_role(huis.app_role()))
  WITH CHECK (firm_id = huis.current_firm_id());

-- Licenses: admins and billing see all; users see their own.
CREATE POLICY licenses_select ON huis.licenses FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id()
         AND (user_id = huis.current_user_id()
              OR huis.is_admin_role(huis.app_role())
              OR huis.app_role() = 'billing_admin'));
CREATE POLICY licenses_insert ON huis.licenses FOR INSERT TO huis_app
  WITH CHECK (firm_id = huis.current_firm_id() AND huis.is_admin_role(huis.app_role()));
CREATE POLICY licenses_update ON huis.licenses FOR UPDATE TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.is_admin_role(huis.app_role()))
  WITH CHECK (firm_id = huis.current_firm_id());

-- Clients and contacts: internal users only.
CREATE POLICY clients_all ON huis.clients FOR ALL TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.is_internal_role(huis.app_role()))
  WITH CHECK (firm_id = huis.current_firm_id() AND huis.is_internal_role(huis.app_role()));
CREATE POLICY contacts_all ON huis.contacts FOR ALL TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.is_internal_role(huis.app_role()))
  WITH CHECK (firm_id = huis.current_firm_id() AND huis.is_internal_role(huis.app_role()));

-- Matters: firm + ethical wall rules (see can_see_matter).
CREATE POLICY matters_select ON huis.matters FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.can_see_matter(id));
CREATE POLICY matters_insert ON huis.matters FOR INSERT TO huis_app
  WITH CHECK (firm_id = huis.current_firm_id()
              AND huis.is_internal_role(huis.app_role())
              AND created_by = huis.current_user_id());
CREATE POLICY matters_update ON huis.matters FOR UPDATE TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.can_see_matter(id)
         AND (huis.matter_access_level(id) IN ('owner', 'edit')
              OR (NOT restricted AND huis.is_admin_role(huis.app_role()))))
  WITH CHECK (firm_id = huis.current_firm_id());

-- Matter children follow the matter's visibility.
CREATE POLICY matter_members_select ON huis.matter_members FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.can_see_matter(matter_id));
-- Creator and lead attorney are added by the matter_after_insert trigger.
-- After that, only matter owners manage members. On unrestricted matters,
-- firm admins may also add members. On restricted (walled) matters, only
-- matter owners can — admins included only if they are owners.
CREATE POLICY matter_members_write ON huis.matter_members FOR INSERT TO huis_app
  WITH CHECK (firm_id = huis.current_firm_id() AND (
    huis.matter_access_level(matter_id) = 'owner'
    OR (huis.is_admin_role(huis.app_role()) AND huis.can_see_matter(matter_id))
  ));
CREATE POLICY matter_members_update ON huis.matter_members FOR UPDATE TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.matter_access_level(matter_id) = 'owner')
  WITH CHECK (firm_id = huis.current_firm_id());
CREATE POLICY matter_members_delete ON huis.matter_members FOR DELETE TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.matter_access_level(matter_id) = 'owner');

CREATE POLICY matter_contacts_all ON huis.matter_contacts FOR ALL TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.can_see_matter(matter_id))
  WITH CHECK (firm_id = huis.current_firm_id() AND huis.can_see_matter(matter_id));

CREATE POLICY matter_folders_select ON huis.matter_folders FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.can_see_matter(matter_id)
         AND (NOT is_privileged_area OR huis.is_internal_role(huis.app_role())));
CREATE POLICY matter_folders_insert ON huis.matter_folders FOR INSERT TO huis_app
  WITH CHECK (firm_id = huis.current_firm_id() AND huis.can_see_matter(matter_id)
              AND huis.is_internal_role(huis.app_role()));
CREATE POLICY matter_folders_update ON huis.matter_folders FOR UPDATE TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.can_see_matter(matter_id)
         AND huis.is_internal_role(huis.app_role()))
  WITH CHECK (firm_id = huis.current_firm_id());

-- Audit: anyone in the firm can append for their own firm; only admins read.
CREATE POLICY audit_insert ON huis.audit_events FOR INSERT TO huis_app
  WITH CHECK (firm_id = huis.current_firm_id()
              AND actor_user_id IS NOT DISTINCT FROM huis.current_user_id());
CREATE POLICY audit_select ON huis.audit_events FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.is_admin_role(huis.app_role()));
