-- Phase 4 part 3: full export of a Matter (evidence, Matter Brain notes, Case DNA).
--
-- The firm owns its data and can take a complete copy of a Matter at any
-- time. Because an export holds everything in the Matter, including the
-- privileged area and work product, only these people can export:
--   * the Matter's owner (the responsible attorney), or
--   * a firm owner, managing partner or administrator who can see the Matter
--     (ethical walls apply: someone outside a wall can't export it).
-- Read-only staff and outside users never can. The export is built at the
-- moment it's requested from what that person can see; Huis keeps no copy.
-- Every item included is recorded in its chain of custody as "exported".

CREATE FUNCTION huis.can_export_matter(p_matter_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT huis.can_see_matter(p_matter_id)
     AND huis.is_internal_role(huis.app_role()) AND huis.app_role() <> 'read_only'
     AND (huis.matter_access_level(p_matter_id) = 'owner' OR huis.is_admin_role(huis.app_role()))
$$;
GRANT EXECUTE ON FUNCTION huis.can_export_matter(uuid) TO huis_app;

-- Records the export of each clean item in the Matter's chain of custody, and
-- writes the "matter.exported" audit event itself, so a custody "exported"
-- entry can never exist without its audit record (review 10). Each export id
-- can be used once.
CREATE FUNCTION huis.record_matter_export(p_matter_id uuid, p_export_id uuid) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, public, pg_temp AS $$
DECLARE n int;
BEGIN
  IF NOT huis.can_export_matter(p_matter_id) THEN RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501'; END IF;
  IF p_export_id IS NULL THEN RAISE EXCEPTION 'export id required' USING ERRCODE = '22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('huis.export:' || p_export_id::text, 0));
  IF EXISTS (SELECT 1 FROM huis.evidence_custody_events WHERE event = 'exported' AND details->>'export_id' = p_export_id::text)
     OR EXISTS (SELECT 1 FROM huis.audit_events WHERE action = 'matter.exported' AND metadata->>'export_id' = p_export_id::text) THEN
    RAISE EXCEPTION 'export id already used' USING ERRCODE = '23505';
  END IF;
  INSERT INTO huis.evidence_custody_events (firm_id, evidence_id, actor_user_id, event, details, ip_address)
    SELECT v.firm_id, v.id, huis.current_user_id(), 'exported', jsonb_build_object('export_id', p_export_id), huis.request_ip()
      FROM huis.evidence_items v
     WHERE v.matter_id = p_matter_id AND v.firm_id = huis.current_firm_id() AND v.status = 'clean'
       AND huis.can_see_evidence(v.matter_id, v.folder_id, v.uploaded_by)
     ORDER BY v.uploaded_at, v.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  INSERT INTO huis.audit_events (firm_id, actor_user_id, action, target_type, target_id, matter_id, metadata, ip_address)
    VALUES (huis.current_firm_id(), huis.current_user_id(), 'matter.exported', 'matter', p_matter_id, p_matter_id,
            jsonb_build_object('export_id', p_export_id, 'items', n::text), huis.request_ip());
  RETURN n;
END $$;
ALTER FUNCTION huis.record_matter_export(uuid, uuid) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.record_matter_export(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.record_matter_export(uuid, uuid) TO huis_app;
