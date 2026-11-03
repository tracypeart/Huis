-- Phase 3 part 2: matter suggestions and Manual / Assisted / Automatic filing.
--
-- Suggestions are explainable: every suggested Matter comes with the reasons
-- (a Huis number or court case number in the email, an earlier email in the
-- same conversation filed there, the client or a linked contact in the
-- conversation, their organization's domain, the Matter's title). Only
-- Matters the person can see AND add to are ever suggested.
--
-- Filing modes (firm setting, decided by a firm administrator):
--   manual    — suggestions shown; people file themselves
--   assisted  — the top suggestion can be filed in one click
--   automatic — Huis files emails with a strong identifier (Huis number,
--               court case number, or same conversation as an email already
--               filed there), only when the mailbox owner has also turned it
--               on for their mailbox, and only into the Matter's internal
--               Correspondence folder — never a folder outsiders can see.

ALTER TABLE huis.firms ADD COLUMN mail_filing_mode text NOT NULL DEFAULT 'assisted'
  CHECK (mail_filing_mode IN ('manual', 'assisted', 'automatic'));
ALTER TABLE huis.firms ADD COLUMN mail_filing_mode_since timestamptz;
ALTER TABLE huis.mail_connections ADD COLUMN auto_file boolean NOT NULL DEFAULT false;
-- Automatic filing only ever looks at email received after it was turned on.
ALTER TABLE huis.mail_connections ADD COLUMN auto_file_since timestamptz;
ALTER TABLE huis.mail_messages ADD COLUMN auto_checked_at timestamptz;
ALTER TABLE huis.mail_filings ADD COLUMN reasons text[] NOT NULL DEFAULT '{}';
CREATE INDEX mail_messages_auto ON huis.mail_messages (connection_id) WHERE auto_checked_at IS NULL AND filed_matter_id IS NULL;

GRANT SELECT (auto_file) ON huis.mail_connections TO huis_app;

-- Public mail domains: sharing one says nothing about a Matter.
CREATE FUNCTION huis.is_public_mail_domain(p_domain text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(coalesce(p_domain, '')) = ANY (ARRAY['gmail.com','googlemail.com','outlook.com','hotmail.com','live.com','msn.com',
    'yahoo.com','ymail.com','icloud.com','me.com','mac.com','aol.com','proton.me','protonmail.com','gmx.com','mail.com',
    'comcast.net','att.net','verizon.net','msn.com','zoho.com','yandex.com'])
$$;

CREATE FUNCTION huis.email_domain(p_address text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT nullif(lower(split_part(coalesce(p_address, ''), '@', 2)), '')
$$;

-- Identifier-like tokens in text ("2:24-cv-01234", "HUIS-UT-ABC-2026-000001",
-- "250901234"), each reduced to letters and digits. Matching whole tokens
-- means 2:24-cv-0123 doesn't match inside 2:24-cv-01234 and a case number
-- doesn't match inside a phone number.
CREATE FUNCTION huis.id_tokens(p_text text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(array_agg(DISTINCT regexp_replace(t[1], '[^A-Z0-9]', '', 'g')), '{}')
    FROM regexp_matches(upper(coalesce(p_text, '')), '([A-Z0-9]+(?:[-:./][A-Z0-9]+)*)', 'g') t
$$;
-- A court case number usable for matching: at least 6 letters/digits and at
-- least 2 digits, so a word like "REGARDS" can never act as a case number.
CREATE FUNCTION huis.case_key(p_number text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN length(k) >= 6 AND length(regexp_replace(k, '[^0-9]', '', 'g')) >= 2 THEN k END
    FROM (SELECT regexp_replace(upper(coalesce(p_number, '')), '[^A-Z0-9]', '', 'g') AS k) x
$$;

-- Scores the Matters an email may belong to, for the current person.
-- p_member_only limits candidates to Matters the person is explicitly a
-- member of (owner or edit): used for automatic filing. "people" is true when
-- the client or a contact linked to the Matter is on the email.
CREATE FUNCTION huis.score_matters(p_message_id uuid, p_member_only boolean)
RETURNS TABLE (matter_id uuid, title text, color text, score int, strong boolean, people boolean, reasons text[])
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = huis, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  m        huis.mail_messages;
  c        huis.mail_connections;
  v_text   text;
  v_tokens text[];
  v_people text[];
  v_domains text[];
BEGIN
  SELECT * INTO m FROM huis.mail_messages WHERE id = p_message_id AND firm_id = huis.current_firm_id();
  IF NOT FOUND OR NOT huis.can_see_mailbox(m.connection_id) THEN RETURN; END IF;
  SELECT * INTO c FROM huis.mail_connections WHERE id = m.connection_id;
  v_text := upper(coalesce(m.subject, '') || ' ' || left(coalesce(m.body_text, ''), 20000));
  v_tokens := huis.id_tokens(v_text);
  -- Everyone on the email except the mailbox's own address.
  -- (Capped, so a message with a huge recipient list can't make this slow.)
  v_people := ARRAY(SELECT DISTINCT lower(a) FROM unnest((ARRAY[m.from_address] || m.to_addresses || m.cc_addresses)[1:200]) a
                     WHERE a IS NOT NULL AND lower(a) IS DISTINCT FROM lower(c.account_address));
  v_domains := ARRAY(SELECT DISTINCT huis.email_domain(a) FROM unnest(v_people) a
                      WHERE NOT huis.is_public_mail_domain(huis.email_domain(a)) AND huis.email_domain(a) IS NOT NULL);

  RETURN QUERY
  WITH candidates AS (
    SELECT mt.* FROM huis.matters mt
     WHERE mt.firm_id = m.firm_id AND mt.status NOT IN ('closed', 'archived')
       AND huis.can_see_matter(mt.id) AND huis.can_manage_matter_content(mt.id)
       AND (NOT p_member_only OR EXISTS (SELECT 1 FROM huis.matter_members mm
                                          WHERE mm.matter_id = mt.id AND mm.user_id = huis.current_user_id()
                                            AND mm.access IN ('owner', 'edit')))
  ), signals AS (
    SELECT mt.id AS mid, 100 AS pts, true AS strong, false AS who, format('Huis number %s appears in the email', mt.huis_number) AS why
      FROM candidates mt WHERE regexp_replace(upper(mt.huis_number), '[^A-Z0-9]', '', 'g') = ANY (v_tokens)
    UNION ALL
    SELECT mt.id, 90, true, false, format('Court case number %s appears in the email', mt.court_case_number)
      FROM candidates mt
     WHERE huis.case_key(mt.court_case_number) = ANY (v_tokens)
    UNION ALL
    SELECT DISTINCT mt.id, 85, true, false, 'An earlier email in this conversation was filed here'
      FROM candidates mt
      JOIN huis.mail_messages o ON o.connection_id = m.connection_id AND o.conversation_id = m.conversation_id
                               AND o.id <> m.id AND o.filed_matter_id = mt.id
     WHERE m.conversation_id IS NOT NULL
    UNION ALL
    SELECT mt.id, 60, false, true, format('The client (%s) is on this email', cl.display_name)
      FROM candidates mt JOIN huis.clients cl ON cl.id = mt.client_id
     WHERE lower(cl.email) = ANY (v_people)
    UNION ALL
    SELECT DISTINCT mt.id, 55, false, true, format('%s (%s) is on this email', ct.full_name, replace(coalesce(nullif(mc.role_label, ''), ct.kind::text), '_', ' '))
      FROM candidates mt
      JOIN huis.matter_contacts mc ON mc.matter_id = mt.id
      JOIN huis.contacts ct ON ct.id = mc.contact_id
     WHERE lower(ct.email) = ANY (v_people)
    UNION ALL
    SELECT DISTINCT mt.id, 25, false, false, format('Someone from %s is on this email', d)
      FROM candidates mt
      LEFT JOIN huis.clients cl ON cl.id = mt.client_id
      LEFT JOIN huis.matter_contacts mc ON mc.matter_id = mt.id
      LEFT JOIN huis.contacts ct ON ct.id = mc.contact_id
      CROSS JOIN LATERAL unnest(ARRAY[huis.email_domain(cl.email), huis.email_domain(ct.email)]) d
     WHERE d IS NOT NULL AND NOT huis.is_public_mail_domain(d)
       -- Someone else at the same organization (an exact match already counts above).
       AND EXISTS (SELECT 1 FROM unnest(v_people) a
                    WHERE huis.email_domain(a) = d AND a <> lower(coalesce(cl.email, '')) AND a <> lower(coalesce(ct.email, '')))
    UNION ALL
    SELECT mt.id, 40, false, false, 'The Matter''s title is in the subject'
      FROM candidates mt
     WHERE length(mt.title) >= 6 AND position(upper(mt.title) IN upper(coalesce(m.subject, ''))) > 0
  )
  SELECT s.mid, mt.title, mt.color,
         least(100, max(s.pts) + 5 * (count(DISTINCT s.why)::int - 1))::int,
         bool_or(s.strong),
         bool_or(s.who),
         array_agg(DISTINCT s.why)
    FROM signals s JOIN candidates mt ON mt.id = s.mid
   GROUP BY s.mid, mt.title, mt.color
  HAVING max(s.pts) >= 40
   ORDER BY 4 DESC, 2
   LIMIT 5;
END $$;
ALTER FUNCTION huis.score_matters(uuid, boolean) OWNER TO huis_security;

-- What people see: every Matter they can see and add to.
CREATE FUNCTION huis.suggest_matters(p_message_id uuid)
RETURNS TABLE (matter_id uuid, title text, color text, score int, strong boolean, reasons text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, public, pg_temp AS $$
  SELECT s.matter_id, s.title, s.color, s.score, s.strong, s.reasons FROM huis.score_matters(p_message_id, false) s
$$;
ALTER FUNCTION huis.suggest_matters(uuid) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.suggest_matters(uuid), huis.score_matters(uuid, boolean), huis.is_public_mail_domain(text),
  huis.email_domain(text), huis.id_tokens(text), huis.case_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.suggest_matters(uuid) TO huis_app;
GRANT EXECUTE ON FUNCTION huis.is_public_mail_domain(text), huis.email_domain(text), huis.id_tokens(text), huis.case_key(text)
  TO huis_app, huis_security;

-- Firm administrators choose the filing mode.
CREATE FUNCTION huis.set_mail_filing_mode(p_mode text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, public, pg_temp AS $$
BEGIN
  IF NOT huis.is_admin_role(huis.app_role()) THEN RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501'; END IF;
  IF p_mode NOT IN ('manual', 'assisted', 'automatic') THEN RAISE EXCEPTION 'invalid mode'; END IF;
  UPDATE huis.firms SET mail_filing_mode = p_mode,
         mail_filing_mode_since = CASE WHEN p_mode = 'automatic' AND mail_filing_mode <> 'automatic' THEN now()
                                       WHEN p_mode = 'automatic' THEN mail_filing_mode_since END
   WHERE id = huis.current_firm_id();
END $$;
-- The mailbox owner turns automatic filing on or off for their own mailbox.
CREATE FUNCTION huis.set_mailbox_auto_file(p_connection_id uuid, p_on boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, public, pg_temp AS $$
BEGIN
  IF NOT huis.is_internal_role(huis.app_role()) OR huis.app_role() = 'read_only' THEN RETURN false; END IF;
  UPDATE huis.mail_connections SET auto_file = coalesce(p_on, false),
         auto_file_since = CASE WHEN coalesce(p_on, false) AND NOT auto_file THEN now()
                                WHEN coalesce(p_on, false) THEN auto_file_since END
   WHERE id = p_connection_id AND firm_id = huis.current_firm_id() AND owner_user_id = huis.current_user_id() AND status <> 'disconnected';
  IF NOT FOUND THEN RETURN false; END IF;
  -- Email already in Huis is never filed automatically.
  IF coalesce(p_on, false) THEN
    UPDATE huis.mail_messages SET auto_checked_at = now()
     WHERE connection_id = p_connection_id AND auto_checked_at IS NULL AND received_at < now();
  END IF;
  RETURN true;
END $$;
ALTER FUNCTION huis.set_mail_filing_mode(text) OWNER TO huis_security;
ALTER FUNCTION huis.set_mailbox_auto_file(uuid, boolean) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.set_mail_filing_mode(text), huis.set_mailbox_auto_file(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.set_mail_filing_mode(text), huis.set_mailbox_auto_file(uuid, boolean) TO huis_app;

-- One-click ("assisted") filing: the top suggestion, into the Matter's
-- internal Correspondence folder. Uses the same checks as manual filing.
CREATE FUNCTION huis.request_assisted_filing(p_message_id uuid, p_matter_id uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, public, pg_temp AS $$
DECLARE
  v_mode text;
  v_folder uuid;
  v_reasons text[];
  v_r text;
BEGIN
  SELECT mail_filing_mode INTO v_mode FROM huis.firms WHERE id = huis.current_firm_id();
  IF v_mode = 'manual' THEN RETURN 'mode_manual'; END IF;
  SELECT s.reasons INTO v_reasons FROM huis.suggest_matters(p_message_id) s WHERE s.matter_id = p_matter_id;
  IF NOT FOUND THEN RETURN 'not_suggested'; END IF;
  SELECT f.id INTO v_folder FROM huis.matter_folders f
   WHERE f.matter_id = p_matter_id AND f.name = 'Correspondence' AND NOT f.is_privileged_area AND f.classification = 'internal_firm_only'
   ORDER BY f.created_at, f.id LIMIT 1;
  IF v_folder IS NULL THEN RETURN 'no_folder'; END IF;
  v_r := huis.request_mail_filing(p_message_id, p_matter_id, v_folder, false, 'assisted');
  IF v_r ~ '^[0-9a-f-]{36}$' THEN UPDATE huis.mail_filings SET reasons = v_reasons WHERE id = v_r::uuid; END IF;
  RETURN v_r;
END $$;
ALTER FUNCTION huis.request_assisted_filing(uuid, uuid) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.request_assisted_filing(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.request_assisted_filing(uuid, uuid) TO huis_app;

-- Worker: automatic filing for one mailbox, run after it syncs. Suggestions
-- are computed as the mailbox's owner (their walls and permissions apply).
CREATE FUNCTION huis.worker_auto_file(p_connection_id uuid, p_lock_token uuid) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, public, pg_temp AS $$
DECLARE
  c       huis.mail_connections;
  v_mode  text;
  v_since timestamptz;
  v_owner huis.users;
  msg     record;
  best    record;
  second_score int;
  v_folder uuid;
  n int := 0;
BEGIN
  c := huis.worker_held_mailbox(p_connection_id, p_lock_token);
  SELECT mail_filing_mode, mail_filing_mode_since INTO v_mode, v_since FROM huis.firms WHERE id = c.firm_id;
  v_since := greatest(v_since, c.auto_file_since);
  SELECT * INTO v_owner FROM huis.users WHERE id = c.owner_user_id;
  IF v_mode <> 'automatic' OR NOT c.auto_file OR NOT c.manage OR c.status <> 'active'
     OR v_owner.status <> 'active' OR NOT huis.is_internal_role(v_owner.role) OR v_owner.role = 'read_only'
     OR v_since IS NULL THEN
    RETURN 0;
  END IF;
  -- Act as the mailbox owner for this transaction only.
  PERFORM set_config('app.firm_id', c.firm_id::text, true);
  PERFORM set_config('app.user_id', c.owner_user_id::text, true);
  FOR msg IN
    SELECT id FROM huis.mail_messages
     WHERE connection_id = c.id AND auto_checked_at IS NULL AND filed_matter_id IS NULL AND removed_at IS NULL
     ORDER BY received_at NULLS LAST LIMIT 200
  LOOP
    UPDATE huis.mail_messages SET auto_checked_at = now() WHERE id = msg.id;
    -- Only email received after automatic filing was turned on.
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM huis.mail_messages WHERE id = msg.id AND received_at >= v_since);
    -- The winner must be a Matter the owner is on, with a strong identifier
    -- AND the client or a linked contact on the email: a number alone, which
    -- anyone can type into an email, is never enough to file automatically.
    best := NULL;
    SELECT * INTO best FROM huis.score_matters(msg.id, true) s
     WHERE s.strong AND s.people AND s.score >= 85 ORDER BY s.score DESC LIMIT 1;
    CONTINUE WHEN best IS NULL OR best.matter_id IS NULL;
    -- Only when one Matter clearly stands out among all the owner can add to.
    SELECT max(s.score) INTO second_score FROM huis.score_matters(msg.id, false) s WHERE s.matter_id <> best.matter_id;
    CONTINUE WHEN second_score IS NOT NULL AND second_score >= best.score - 10;
    SELECT f.id INTO v_folder FROM huis.matter_folders f
     WHERE f.matter_id = best.matter_id AND f.name = 'Correspondence' AND NOT f.is_privileged_area AND f.classification = 'internal_firm_only'
     ORDER BY f.created_at, f.id LIMIT 1;
    CONTINUE WHEN v_folder IS NULL;
    CONTINUE WHEN EXISTS (SELECT 1 FROM huis.mail_filings WHERE message_id = msg.id AND status <> 'failed');
    INSERT INTO huis.mail_filings (firm_id, message_id, matter_id, folder_id, shared_outside_firm, requested_by, method, reasons)
      VALUES (c.firm_id, msg.id, best.matter_id, v_folder, false, c.owner_user_id, 'automatic', best.reasons);
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;
ALTER FUNCTION huis.worker_auto_file(uuid, uuid) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.worker_auto_file(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.worker_auto_file(uuid, uuid) TO huis_worker;

-- Re-checks a filing as its requester when it runs. Automatic filings are
-- also re-checked against the firm's mode and the owner's mailbox setting,
-- so switching automatic filing off stops filings already queued.
CREATE OR REPLACE FUNCTION huis.filing_still_allowed(p_filing_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, public, pg_temp AS $$
DECLARE
  r huis.mail_filings;
  m huis.mail_messages;
  u huis.users;
  f huis.matter_folders;
  c huis.mail_connections;
  v_exposes boolean;
BEGIN
  SELECT * INTO r FROM huis.mail_filings WHERE id = p_filing_id;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO m FROM huis.mail_messages WHERE id = r.message_id;
  IF NOT FOUND OR m.removed_at IS NOT NULL THEN RETURN false; END IF;
  SELECT * INTO u FROM huis.users WHERE id = r.requested_by AND firm_id = r.firm_id;
  IF NOT FOUND OR u.status <> 'active' OR NOT huis.is_internal_role(u.role) OR u.role = 'read_only' THEN RETURN false; END IF;
  IF r.method = 'automatic' THEN
    SELECT * INTO c FROM huis.mail_connections WHERE id = m.connection_id;
    IF NOT FOUND OR NOT c.auto_file OR NOT c.manage OR c.owner_user_id <> r.requested_by
       OR (SELECT mail_filing_mode FROM huis.firms WHERE id = r.firm_id) <> 'automatic'
       OR NOT EXISTS (SELECT 1 FROM huis.matter_members mm WHERE mm.matter_id = r.matter_id AND mm.user_id = r.requested_by
                       AND mm.access IN ('owner', 'edit')) THEN
      RETURN false;
    END IF;
  END IF;
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

-- Record why an email was filed (suggestion reasons) in its chain of custody.
CREATE OR REPLACE FUNCTION huis.worker_complete_mail_filing(
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
      'reasons', CASE WHEN cardinality(r.reasons) > 0 THEN to_jsonb(r.reasons) ELSE NULL END,
      'shared_outside_firm', r.shared_outside_firm,
      'privilege_waiver_acknowledged', CASE WHEN r.shared_outside_firm THEN true ELSE NULL END,
      'retrieved_at', now()));
  UPDATE huis.mail_filings SET status = 'done', evidence_id = p_evidence_id, completed_at = now(), lock_token = NULL WHERE id = r.id;
  UPDATE huis.mail_messages SET filed_matter_id = r.matter_id, filed_evidence_id = p_evidence_id, filed_at = now(),
         filed_by = r.requested_by, updated_at = now() WHERE id = m.id;
  RETURN true;
END $$;
