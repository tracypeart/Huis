-- Huis Law IP — security hardening from the independent review (Nov 2026)
--
-- Each block names the review finding it closes. Principle: the database
-- itself enforces these rules, so a bug in the app (or a hostile query run
-- through the app's own connection) still cannot break them.

SET search_path = huis, public;

-- ===========================================================================
-- Helpers
-- ===========================================================================

-- Role of any user in the current firm (for checks on the *target* of an action).
CREATE FUNCTION huis.user_role_in_firm(p_user_id uuid) RETURNS huis.firm_role
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT role FROM huis.users WHERE id = p_user_id AND firm_id = huis.current_firm_id()
$$;
ALTER FUNCTION huis.user_role_in_firm(uuid) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.user_role_in_firm(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.user_role_in_firm(uuid) TO huis_app;

CREATE FUNCTION huis.request_ip() RETURNS inet
LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN nullif(current_setting('app.ip', true), '')::inet;
EXCEPTION WHEN others THEN
  RETURN NULL;
END $$;
GRANT EXECUTE ON FUNCTION huis.request_ip() TO huis_app, huis_security;

-- folder_classification no longer answers for folders in matters the caller can't see.
CREATE OR REPLACE FUNCTION huis.folder_classification(p_folder_id uuid) RETURNS huis.privilege_classification
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT f.classification FROM huis.matter_folders f
   WHERE f.id = p_folder_id AND f.firm_id = huis.current_firm_id() AND huis.can_see_matter(f.matter_id)
$$;

-- ===========================================================================
-- H2 / F8: sign-in identities can only be linked through an invitation.
-- F5: nobody moves between firm staff and outside roles in place.
-- Session revocation: users.session_version.
-- ===========================================================================
ALTER TABLE huis.users ADD COLUMN session_version int NOT NULL DEFAULT 1;

CREATE FUNCTION huis.users_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF current_user <> 'huis_security' AND (NEW.auth_subject IS NOT NULL OR NEW.auth_provider IS NOT NULL) THEN
      RAISE EXCEPTION 'Sign-in accounts can only be linked through an invitation link';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.firm_id <> OLD.firm_id THEN
    RAISE EXCEPTION 'user identity is immutable';
  END IF;
  IF current_user <> 'huis_security' AND (NEW.auth_subject IS DISTINCT FROM OLD.auth_subject
                                          OR NEW.auth_provider IS DISTINCT FROM OLD.auth_provider) THEN
    RAISE EXCEPTION 'Sign-in accounts can only be linked through an invitation link';
  END IF;
  IF huis.is_internal_role(OLD.role) <> huis.is_internal_role(NEW.role) THEN
    RAISE EXCEPTION 'Someone cannot be moved between firm staff and an outside role. Remove their access and invite them again.';
  END IF;
  IF NEW.session_version < OLD.session_version THEN
    RAISE EXCEPTION 'session version cannot go backwards';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_guard BEFORE INSERT OR UPDATE ON huis.users
  FOR EACH ROW EXECUTE FUNCTION huis.users_guard();

-- Lets any signed-in user end all of their own sessions (used by sign-out).
CREATE FUNCTION huis.end_my_sessions() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  UPDATE huis.users SET session_version = session_version + 1
   WHERE id = huis.current_user_id() AND firm_id = huis.current_firm_id()
$$;
ALTER FUNCTION huis.end_my_sessions() OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.end_my_sessions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.end_my_sessions() TO huis_app;

-- Firm billing fields are not editable by firm admins.
CREATE FUNCTION huis.firms_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_user <> 'huis_security' AND (
       NEW.id <> OLD.id OR NEW.slug <> OLD.slug OR NEW.plan <> OLD.plan
       OR NEW.trial_ends_at IS DISTINCT FROM OLD.trial_ends_at OR NEW.status <> OLD.status
       OR NEW.created_at <> OLD.created_at) THEN
    RAISE EXCEPTION 'Plan, trial and account status are managed by Huis';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER firms_guard BEFORE UPDATE ON huis.firms
  FOR EACH ROW EXECUTE FUNCTION huis.firms_guard();

-- ===========================================================================
-- F10: matters — identity fields immutable; only matter owners may lift or
-- add an ethical wall, or change the client or lead attorney. Huis numbers
-- are always assigned by the database.
-- ===========================================================================
CREATE OR REPLACE FUNCTION huis.assign_matter_number() RETURNS trigger
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
  SELECT time_zone INTO v_tz FROM huis.firms WHERE id = NEW.firm_id;
  v_year := extract(year FROM (now() AT TIME ZONE coalesce(v_tz, 'UTC')))::int;
  NEW.opened_at := now();
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

CREATE FUNCTION huis.matters_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.firm_id <> OLD.firm_id OR NEW.huis_number <> OLD.huis_number
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at OR NEW.opened_at <> OLD.opened_at THEN
    RAISE EXCEPTION 'matter identity fields are immutable';
  END IF;
  IF current_user <> 'huis_security'
     AND (NEW.restricted <> OLD.restricted OR NEW.client_id <> OLD.client_id
          OR NEW.lead_attorney_id <> OLD.lead_attorney_id)
     AND huis.matter_access_level(OLD.id) IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'Only a matter owner can change the ethical wall, client or lead attorney';
  END IF;
  IF NEW.lead_attorney_id <> OLD.lead_attorney_id
     AND huis.user_role_in_firm(NEW.lead_attorney_id) NOT IN ('firm_owner', 'managing_partner', 'attorney') THEN
    RAISE EXCEPTION 'lead attorney must be an attorney';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER matters_guard BEFORE UPDATE ON huis.matters
  FOR EACH ROW EXECUTE FUNCTION huis.matters_guard();

-- ===========================================================================
-- G3 / F5: membership rows can't be re-pointed; outsiders are view-only.
-- ===========================================================================
CREATE FUNCTION huis.matter_members_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.firm_id <> OLD.firm_id OR NEW.matter_id <> OLD.matter_id
                           OR NEW.user_id <> OLD.user_id) THEN
    RAISE EXCEPTION 'matter membership cannot be moved; remove it and add a new one';
  END IF;
  IF NEW.access <> 'view' AND NOT huis.is_internal_role(
       (SELECT role FROM huis.users WHERE id = NEW.user_id AND firm_id = NEW.firm_id)) THEN
    RAISE EXCEPTION 'People outside the firm can only have view access';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION huis.matter_members_guard() SECURITY DEFINER;
ALTER FUNCTION huis.matter_members_guard() SET search_path = huis, pg_temp;
ALTER FUNCTION huis.matter_members_guard() OWNER TO huis_security;
CREATE TRIGGER matter_members_guard BEFORE INSERT OR UPDATE ON huis.matter_members
  FOR EACH ROW EXECUTE FUNCTION huis.matter_members_guard();

DROP POLICY matter_members_update ON huis.matter_members;
CREATE POLICY matter_members_update ON huis.matter_members FOR UPDATE TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.matter_access_level(matter_id) = 'owner')
  WITH CHECK (firm_id = huis.current_firm_id() AND huis.matter_access_level(matter_id) = 'owner');

-- ===========================================================================
-- F2: the red privileged area can't be un-designated or re-classified, and
-- only owners/editors (or firm admins on unwalled matters) manage folders.
-- ===========================================================================
CREATE FUNCTION huis.matter_folders_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF current_user <> 'huis_security' AND NEW.is_privileged_area THEN
      RAISE EXCEPTION 'The privileged area is created automatically';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.firm_id <> OLD.firm_id OR NEW.matter_id <> OLD.matter_id
     OR NEW.is_privileged_area <> OLD.is_privileged_area OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'folder identity fields are immutable';
  END IF;
  IF OLD.is_privileged_area AND NEW.classification <> OLD.classification THEN
    RAISE EXCEPTION 'The privileged area keeps its classification';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER matter_folders_guard BEFORE INSERT OR UPDATE ON huis.matter_folders
  FOR EACH ROW EXECUTE FUNCTION huis.matter_folders_guard();

CREATE FUNCTION huis.can_manage_matter_content(p_matter_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT huis.can_see_matter(p_matter_id)
     AND huis.is_internal_role(huis.app_role()) AND huis.app_role() <> 'read_only'
     AND (huis.matter_access_level(p_matter_id) IN ('owner', 'edit')
          OR huis.is_admin_role(huis.app_role())
          OR huis.app_role() IN ('attorney', 'paralegal', 'legal_assistant'))
$$;
GRANT EXECUTE ON FUNCTION huis.can_manage_matter_content(uuid) TO huis_app;

DROP POLICY matter_folders_insert ON huis.matter_folders;
DROP POLICY matter_folders_update ON huis.matter_folders;
CREATE POLICY matter_folders_insert ON huis.matter_folders FOR INSERT TO huis_app
  WITH CHECK (firm_id = huis.current_firm_id() AND huis.can_manage_matter_content(matter_id));
CREATE POLICY matter_folders_update ON huis.matter_folders FOR UPDATE TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.can_manage_matter_content(matter_id)
         AND (huis.matter_access_level(matter_id) IN ('owner', 'edit') OR huis.is_admin_role(huis.app_role())))
  WITH CHECK (firm_id = huis.current_firm_id());

-- ===========================================================================
-- F3 / F4 / G2: matter contacts, clients and contacts — outsiders get nothing,
-- read-only users can't write.
-- ===========================================================================
DROP POLICY matter_contacts_all ON huis.matter_contacts;
CREATE POLICY matter_contacts_select ON huis.matter_contacts FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.is_internal_role(huis.app_role()) AND huis.can_see_matter(matter_id));
CREATE POLICY matter_contacts_insert ON huis.matter_contacts FOR INSERT TO huis_app
  WITH CHECK (firm_id = huis.current_firm_id() AND huis.can_manage_matter_content(matter_id));
CREATE POLICY matter_contacts_update ON huis.matter_contacts FOR UPDATE TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.can_manage_matter_content(matter_id))
  WITH CHECK (firm_id = huis.current_firm_id() AND huis.can_manage_matter_content(matter_id));
CREATE POLICY matter_contacts_delete ON huis.matter_contacts FOR DELETE TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.can_manage_matter_content(matter_id));

CREATE FUNCTION huis.matter_contacts_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.firm_id <> OLD.firm_id OR NEW.matter_id <> OLD.matter_id OR NEW.contact_id <> OLD.contact_id THEN
    RAISE EXCEPTION 'matter contact links cannot be moved';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER matter_contacts_guard BEFORE UPDATE ON huis.matter_contacts
  FOR EACH ROW EXECUTE FUNCTION huis.matter_contacts_guard();

DROP POLICY clients_all ON huis.clients;
CREATE POLICY clients_select ON huis.clients FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.is_internal_role(huis.app_role()));
CREATE POLICY clients_write ON huis.clients FOR INSERT TO huis_app
  WITH CHECK (firm_id = huis.current_firm_id() AND huis.is_internal_role(huis.app_role())
              AND huis.app_role() <> 'read_only' AND created_by = huis.current_user_id());
CREATE POLICY clients_update ON huis.clients FOR UPDATE TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.is_internal_role(huis.app_role()) AND huis.app_role() <> 'read_only')
  WITH CHECK (firm_id = huis.current_firm_id());

DROP POLICY contacts_all ON huis.contacts;
CREATE POLICY contacts_select ON huis.contacts FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.is_internal_role(huis.app_role()));
CREATE POLICY contacts_write ON huis.contacts FOR INSERT TO huis_app
  WITH CHECK (firm_id = huis.current_firm_id() AND huis.is_internal_role(huis.app_role())
              AND huis.app_role() <> 'read_only' AND created_by = huis.current_user_id());
CREATE POLICY contacts_update ON huis.contacts FOR UPDATE TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.is_internal_role(huis.app_role()) AND huis.app_role() <> 'read_only')
  WITH CHECK (firm_id = huis.current_firm_id());

-- ===========================================================================
-- F7: evidence must live in a folder of its own matter; receipt details are
-- part of the original record and immutable.
-- ===========================================================================
ALTER TABLE huis.matter_folders ADD CONSTRAINT matter_folders_firm_matter_id_uq UNIQUE (firm_id, matter_id, id);
ALTER TABLE huis.evidence_items ADD CONSTRAINT evidence_folder_in_matter
  FOREIGN KEY (firm_id, matter_id, folder_id) REFERENCES huis.matter_folders(firm_id, matter_id, id);
ALTER TABLE huis.upload_sessions ADD CONSTRAINT upload_folder_in_matter
  FOREIGN KEY (firm_id, matter_id, folder_id) REFERENCES huis.matter_folders(firm_id, matter_id, id);

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
     OR NEW.date_received IS DISTINCT FROM OLD.date_received THEN
    RAISE EXCEPTION 'original evidence is immutable';
  END IF;
  IF current_user <> 'huis_security' THEN
    RAISE EXCEPTION 'evidence can only be changed through Huis (scanner results and recorded moves)';
  END IF;
  RETURN NEW;
END $$;

-- The app no longer updates evidence rows directly (moves go through
-- huis.move_evidence, which records custody in the same step).
DROP POLICY evidence_update ON huis.evidence_items;
REVOKE UPDATE ON huis.evidence_items FROM huis_app;

-- ===========================================================================
-- H1: custody events are written only by the database itself, never by the
-- app — so they can't be forged. J1: processing is queued exactly once, by the
-- database, when evidence is recorded.
-- ===========================================================================
DROP POLICY custody_insert ON huis.evidence_custody_events;
REVOKE INSERT ON huis.evidence_custody_events FROM huis_app;
DROP POLICY jobs_enqueue ON huis.jobs;
REVOKE INSERT ON huis.jobs FROM huis_app;
ALTER TABLE huis.jobs ADD CONSTRAINT jobs_one_per_evidence UNIQUE (evidence_id);
ALTER TABLE huis.jobs ADD COLUMN lock_token uuid;

CREATE FUNCTION huis.evidence_after_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, public, pg_temp AS $$
BEGIN
  IF NEW.firm_id IS DISTINCT FROM huis.current_firm_id() OR NEW.uploaded_by IS DISTINCT FROM huis.current_user_id() THEN
    RAISE EXCEPTION 'evidence does not match the current firm and user context';
  END IF;
  INSERT INTO huis.evidence_custody_events (firm_id, evidence_id, actor_user_id, event, details, ip_address)
    VALUES (NEW.firm_id, NEW.id, NEW.uploaded_by, 'received', jsonb_build_object(
      'original_filename', NEW.original_filename, 'relative_path', NEW.relative_path,
      'size_bytes', NEW.size_bytes, 'sha256', NEW.sha256, 'source', NEW.source,
      'received_from', NEW.received_from, 'date_received', NEW.date_received), huis.request_ip());
  INSERT INTO huis.jobs (firm_id, kind, evidence_id) VALUES (NEW.firm_id, 'evidence.process', NEW.id);
  RETURN NULL;
END $$;
ALTER FUNCTION huis.evidence_after_insert() OWNER TO huis_security;
CREATE TRIGGER evidence_after_insert AFTER INSERT ON huis.evidence_items
  FOR EACH ROW EXECUTE FUNCTION huis.evidence_after_insert();

-- Download: checks visibility and scan status, and records custody.
CREATE FUNCTION huis.record_evidence_download(p_evidence_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, public, pg_temp AS $$
DECLARE
  v huis.evidence_items;
BEGIN
  SELECT * INTO v FROM huis.evidence_items WHERE id = p_evidence_id AND firm_id = huis.current_firm_id();
  IF NOT FOUND OR NOT huis.can_see_evidence(v.matter_id, v.folder_id, v.uploaded_by) OR v.status <> 'clean' THEN
    RETURN false;
  END IF;
  INSERT INTO huis.evidence_custody_events (firm_id, evidence_id, actor_user_id, event, ip_address)
    VALUES (v.firm_id, v.id, huis.current_user_id(), 'downloaded', huis.request_ip());
  RETURN true;
END $$;
ALTER FUNCTION huis.record_evidence_download(uuid) OWNER TO huis_security;

-- F9: moving evidence. Moving into a folder that people outside the firm can
-- see requires an explicit privilege-waiver acknowledgement, which is recorded.
CREATE FUNCTION huis.move_evidence(p_evidence_id uuid, p_folder_id uuid, p_acknowledged boolean) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, public, pg_temp AS $$
DECLARE
  v      huis.evidence_items;
  v_from huis.matter_folders;
  v_to   huis.matter_folders;
  v_exposes boolean;
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
  UPDATE huis.evidence_items SET folder_id = v_to.id WHERE id = v.id;
  INSERT INTO huis.evidence_custody_events (firm_id, evidence_id, actor_user_id, event, details, ip_address)
    VALUES (v.firm_id, v.id, huis.current_user_id(), 'moved', jsonb_build_object(
      'from', v_from.name, 'to', v_to.name,
      'left_privileged_area', v_from.is_privileged_area,
      'shared_outside_firm', v_exposes,
      'privilege_waiver_acknowledged', CASE WHEN v_exposes THEN true ELSE NULL END), huis.request_ip());
  RETURN 'moved';
END $$;
ALTER FUNCTION huis.move_evidence(uuid, uuid, boolean) OWNER TO huis_security;

REVOKE ALL ON FUNCTION huis.record_evidence_download(uuid), huis.move_evidence(uuid, uuid, boolean),
  huis.evidence_after_insert() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.record_evidence_download(uuid), huis.move_evidence(uuid, uuid, boolean) TO huis_app;
GRANT EXECUTE ON FUNCTION huis.can_see_evidence(uuid, uuid, uuid), huis.can_manage_matter_content(uuid) TO huis_security;

-- Worker: a lock token proves which worker owns a job; results never
-- overwrite an item that already has a verdict.
DROP FUNCTION huis.worker_claim_job();
DROP FUNCTION huis.worker_complete(bigint, huis.evidence_status, text, text, text);
DROP FUNCTION huis.worker_fail(bigint, text, boolean);

CREATE FUNCTION huis.worker_claim_job()
RETURNS TABLE (job_id bigint, lock_token uuid, firm_id uuid, evidence_id uuid, storage_key text, sha256 text,
               size_bytes bigint, matter_id uuid, attempts int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_job   huis.jobs;
  v_token uuid := gen_random_uuid();
BEGIN
  SELECT * INTO v_job FROM huis.jobs j
   WHERE (j.status = 'queued' OR (j.status = 'running' AND j.locked_until < now()))
     AND j.run_after <= now()
   ORDER BY j.id
   FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE huis.jobs SET status = 'running', attempts = attempts + 1, lock_token = v_token,
         locked_until = now() + interval '6 hours' WHERE id = v_job.id;
  RETURN QUERY SELECT v_job.id, v_token, i.firm_id, i.id, i.storage_key, i.sha256::text, i.size_bytes,
                      i.matter_id, v_job.attempts + 1
    FROM huis.evidence_items i WHERE i.id = v_job.evidence_id;
END $$;

CREATE FUNCTION huis.worker_complete(
  p_job_id bigint, p_lock_token uuid, p_status huis.evidence_status, p_detail text, p_detected_type text,
  p_verified_sha256 text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE
  v_job  huis.jobs;
  v_item huis.evidence_items;
  v_dup  uuid;
BEGIN
  SELECT * INTO v_job FROM huis.jobs WHERE id = p_job_id AND status = 'running' AND lock_token = p_lock_token FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'job is not held by this worker'; END IF;
  SELECT * INTO v_item FROM huis.evidence_items WHERE id = v_job.evidence_id FOR UPDATE;

  IF v_item.status <> 'pending_scan' THEN
    -- A verdict already exists; it is never overwritten.
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

  UPDATE huis.jobs SET status = 'done', locked_until = NULL, lock_token = NULL, last_error = NULL WHERE id = p_job_id;
END $$;

CREATE FUNCTION huis.worker_fail(p_job_id bigint, p_lock_token uuid, p_error text, p_final boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE
  v_job huis.jobs;
BEGIN
  SELECT * INTO v_job FROM huis.jobs WHERE id = p_job_id AND lock_token = p_lock_token FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF p_final THEN
    UPDATE huis.jobs SET status = 'failed', locked_until = NULL, lock_token = NULL, last_error = left(p_error, 500) WHERE id = p_job_id;
    UPDATE huis.evidence_items SET status = 'scan_failed', scan_detail = 'Processing failed; the file is held and cannot be opened.',
           scanned_at = now() WHERE id = v_job.evidence_id AND status = 'pending_scan';
    INSERT INTO huis.evidence_custody_events (firm_id, evidence_id, event, details)
      VALUES (v_job.firm_id, v_job.evidence_id, 'scan_failed', jsonb_build_object('detail', 'processing failed'));
  ELSE
    UPDATE huis.jobs SET status = 'queued', locked_until = NULL, lock_token = NULL, last_error = left(p_error, 500),
           run_after = now() + make_interval(secs => least(3600, 30 * power(2, v_job.attempts))::int)
     WHERE id = p_job_id;
  END IF;
END $$;

ALTER FUNCTION huis.worker_claim_job() OWNER TO huis_security;
ALTER FUNCTION huis.worker_complete(bigint, uuid, huis.evidence_status, text, text, text) OWNER TO huis_security;
ALTER FUNCTION huis.worker_fail(bigint, uuid, text, boolean) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.worker_claim_job(), huis.worker_complete(bigint, uuid, huis.evidence_status, text, text, text),
  huis.worker_fail(bigint, uuid, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.worker_claim_job(), huis.worker_complete(bigint, uuid, huis.evidence_status, text, text, text),
  huis.worker_fail(bigint, uuid, text, boolean) TO huis_worker;

-- ===========================================================================
-- F6 / G1: tamper-evident chains ordered by a sequence assigned under the
-- chain lock, so concurrent writes never look like tampering.
-- ===========================================================================
ALTER TABLE huis.audit_events ADD COLUMN chain_seq bigint;
ALTER TABLE huis.evidence_custody_events ADD COLUMN chain_seq bigint;

CREATE OR REPLACE FUNCTION huis.audit_event_digest(e huis.audit_events, p_prev text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(public.digest(concat_ws('|',
    coalesce(p_prev, 'GENESIS'), e.chain_seq::text, e.id::text, e.firm_id::text,
    coalesce(e.actor_user_id::text, ''), e.action,
    coalesce(e.target_type, ''), coalesce(e.target_id::text, ''),
    coalesce(e.matter_id::text, ''), e.metadata::text,
    coalesce(host(e.ip_address), ''), coalesce(e.user_agent, ''),
    to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
  ), 'sha256'), 'hex')
$$;

CREATE OR REPLACE FUNCTION huis.custody_digest(e huis.evidence_custody_events, p_prev text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(public.digest(concat_ws('|',
    coalesce(p_prev, 'GENESIS'), e.chain_seq::text, e.id::text, e.firm_id::text, e.evidence_id::text,
    coalesce(e.actor_user_id::text, 'SYSTEM'), e.event, e.details::text,
    coalesce(host(e.ip_address), ''),
    to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
  ), 'sha256'), 'hex')
$$;

CREATE OR REPLACE FUNCTION huis.audit_chain_before_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, public, pg_temp AS $$
DECLARE
  v_last huis.audit_events;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.firm_id::text, 0));
  SELECT * INTO v_last FROM huis.audit_events WHERE firm_id = NEW.firm_id ORDER BY chain_seq DESC LIMIT 1;
  NEW.chain_seq := coalesce(v_last.chain_seq, 0) + 1;
  NEW.prev_hash := v_last.hash;
  NEW.occurred_at := clock_timestamp();
  NEW.hash := huis.audit_event_digest(NEW, NEW.prev_hash);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION huis.custody_before_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, public, pg_temp AS $$
DECLARE
  v_last huis.evidence_custody_events;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.evidence_id::text, 1));
  SELECT * INTO v_last FROM huis.evidence_custody_events WHERE evidence_id = NEW.evidence_id ORDER BY chain_seq DESC LIMIT 1;
  NEW.chain_seq := coalesce(v_last.chain_seq, 0) + 1;
  NEW.prev_hash := v_last.hash;
  NEW.occurred_at := clock_timestamp();
  NEW.hash := huis.custody_digest(NEW, NEW.prev_hash);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION huis.verify_audit_chain() RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = huis, public, pg_temp AS $$
DECLARE
  r        huis.audit_events;
  v_prev   text := NULL;
  v_expect bigint := 1;
BEGIN
  IF NOT huis.is_admin_role(huis.app_role()) THEN
    RAISE EXCEPTION 'not permitted';
  END IF;
  FOR r IN SELECT * FROM huis.audit_events WHERE firm_id = huis.current_firm_id() ORDER BY chain_seq LOOP
    IF r.chain_seq IS DISTINCT FROM v_expect OR r.prev_hash IS DISTINCT FROM v_prev
       OR r.hash IS DISTINCT FROM huis.audit_event_digest(r, v_prev) THEN
      RETURN r.id;
    END IF;
    v_prev := r.hash;
    v_expect := v_expect + 1;
  END LOOP;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION huis.verify_custody_chain(p_evidence_id uuid) RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = huis, public, pg_temp AS $$
DECLARE
  r        huis.evidence_custody_events;
  v_prev   text := NULL;
  v_expect bigint := 1;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM huis.evidence_items i WHERE i.id = p_evidence_id
                 AND i.firm_id = huis.current_firm_id() AND huis.can_see_matter(i.matter_id)) THEN
    RAISE EXCEPTION 'not permitted';
  END IF;
  FOR r IN SELECT * FROM huis.evidence_custody_events WHERE evidence_id = p_evidence_id ORDER BY chain_seq LOOP
    IF r.chain_seq IS DISTINCT FROM v_expect OR r.prev_hash IS DISTINCT FROM v_prev
       OR r.hash IS DISTINCT FROM huis.custody_digest(r, v_prev) THEN
      RETURN r.id;
    END IF;
    v_prev := r.hash;
    v_expect := v_expect + 1;
  END LOOP;
  RETURN NULL;
END $$;

-- One-time rebuild of existing chains in the new format (development data
-- only; nothing is in production yet). Runs as the migration owner.
ALTER TABLE huis.audit_events DISABLE TRIGGER audit_events_no_update;
ALTER TABLE huis.evidence_custody_events DISABLE TRIGGER custody_no_update;
DO $$
DECLARE
  r      record;
  v_prev text;
  v_key  text := '';
  v_seq  bigint;
  e      huis.audit_events;
  c      huis.evidence_custody_events;
BEGIN
  FOR e IN SELECT * FROM huis.audit_events ORDER BY firm_id, id LOOP
    IF e.firm_id::text <> v_key THEN v_key := e.firm_id::text; v_prev := NULL; v_seq := 0; END IF;
    v_seq := v_seq + 1;
    e.chain_seq := v_seq;
    UPDATE huis.audit_events SET chain_seq = v_seq, prev_hash = v_prev,
           hash = huis.audit_event_digest(e, v_prev) WHERE id = e.id
      RETURNING hash INTO v_prev;
  END LOOP;
  v_key := '';
  FOR c IN SELECT * FROM huis.evidence_custody_events ORDER BY evidence_id, id LOOP
    IF c.evidence_id::text <> v_key THEN v_key := c.evidence_id::text; v_prev := NULL; v_seq := 0; END IF;
    v_seq := v_seq + 1;
    c.chain_seq := v_seq;
    UPDATE huis.evidence_custody_events SET chain_seq = v_seq, prev_hash = v_prev,
           hash = huis.custody_digest(c, v_prev) WHERE id = c.id
      RETURNING hash INTO v_prev;
  END LOOP;
END $$;
ALTER TABLE huis.audit_events ENABLE TRIGGER audit_events_no_update;
ALTER TABLE huis.evidence_custody_events ENABLE TRIGGER custody_no_update;

ALTER TABLE huis.audit_events ALTER COLUMN chain_seq SET NOT NULL;
ALTER TABLE huis.evidence_custody_events ALTER COLUMN chain_seq SET NOT NULL;
CREATE UNIQUE INDEX audit_events_chain_uq ON huis.audit_events (firm_id, chain_seq);
CREATE UNIQUE INDEX custody_chain_uq ON huis.evidence_custody_events (evidence_id, chain_seq);
