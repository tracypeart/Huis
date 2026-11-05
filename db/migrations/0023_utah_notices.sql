-- Phase 8 part 2: Utah court notices.
--
-- Utah sends notices through each firm's e-filing service provider (EFSP), in
-- that provider's own format. Huis reads email from a Utah courts address
-- (utcourts.gov) and from senders the firm's administrators register as their
-- EFSP. The Utah reader is marked unverified until checked against real
-- notices (O-7): its proposals say so, and, like every proposal, each needs an
-- attorney to confirm it.

-- Senders the firm trusts for court notices (its EFSP's notification address).
CREATE TABLE huis.court_notice_senders (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id    uuid NOT NULL REFERENCES huis.firms(id),
  address    text NOT NULL CHECK (length(address) <= 320 AND address = lower(address) AND address ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  label      text NOT NULL CHECK (length(label) BETWEEN 1 AND 100),
  added_by   uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (firm_id, address),
  FOREIGN KEY (firm_id, added_by) REFERENCES huis.users(firm_id, id)
);
ALTER TABLE huis.court_notice_senders ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.court_notice_senders FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON huis.court_notice_senders TO huis_app;
GRANT SELECT ON huis.court_notice_senders TO huis_security;
-- Firm staff can see the list; only administrators change it, in their own name.
CREATE POLICY court_notice_senders_select ON huis.court_notice_senders FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.is_internal_role(huis.app_role()));
CREATE POLICY court_notice_senders_insert ON huis.court_notice_senders FOR INSERT TO huis_app
  WITH CHECK (firm_id = huis.current_firm_id() AND huis.is_admin_role(huis.app_role()) AND added_by = huis.current_user_id());
CREATE POLICY court_notice_senders_delete ON huis.court_notice_senders FOR DELETE TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.is_admin_role(huis.app_role()));

-- Which reader proposed a court date ('federal' CM/ECF notices, or 'utah', unverified).
ALTER TABLE huis.court_events ADD COLUMN reader text CHECK (reader IS NULL OR reader IN ('federal', 'utah'));
UPDATE huis.court_events SET reader = 'federal' WHERE origin = 'huis';
ALTER TABLE huis.court_events ADD CONSTRAINT court_events_reader CHECK ((origin = 'huis') = (reader IS NOT NULL));

-- The reader, like the rest of where a proposal came from, can't be rewritten.
CREATE OR REPLACE FUNCTION huis.court_event_reader_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.reader IS DISTINCT FROM OLD.reader THEN RAISE EXCEPTION 'court calendar history cannot be rewritten'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER court_events_reader_guard BEFORE UPDATE ON huis.court_events FOR EACH ROW EXECUTE FUNCTION huis.court_event_reader_guard();

-- Whether an address is the Utah courts' own.
CREATE FUNCTION huis.is_utah_court_sender(p_from text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(substring(p_from FROM '<([^<>[:space:]]+@[^<>[:space:]]+)>[[:space:]]*$'), btrim(coalesce(p_from, '')))
         ~* '^[^@[:space:]]{1,64}@([a-z0-9-]{1,63}\.){0,4}utcourts\.gov$'
$$;
GRANT EXECUTE ON FUNCTION huis.is_utah_court_sender(text) TO huis_app;

-- Whether an email may carry a court notice for a given reader, for a firm.
CREATE FUNCTION huis.is_notice_sender(p_firm_id uuid, p_reader text, p_from text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT CASE p_reader
    WHEN 'federal' THEN huis.is_court_sender(p_from)
    WHEN 'utah' THEN huis.is_utah_court_sender(p_from) OR EXISTS (
      SELECT 1 FROM huis.court_notice_senders s
       WHERE s.firm_id = p_firm_id
         AND s.address = lower(coalesce(substring(p_from FROM '<([^<>[:space:]]+@[^<>[:space:]]+)>[[:space:]]*$'), btrim(coalesce(p_from, '')))))
    ELSE false END
$$;
ALTER FUNCTION huis.is_notice_sender(uuid, text, text) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.is_notice_sender(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.is_notice_sender(uuid, text, text) TO huis_app;

-- Huis's proposals from a court notice, by reader. Same rules as before (the quote
-- comes from the notice itself; keyed by the filing), plus the sender check per reader.
CREATE FUNCTION huis.worker_save_court_proposals(p_source_id uuid, p_lock_token uuid, p_reader text, p_events jsonb) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE
  r huis.brain_sources;
  e jsonb;
  v_text text;
  v_start int;
  v_end int;
  v_quote text;
  v_kind text;
  n int := 0;
BEGIN
  SELECT * INTO r FROM huis.brain_sources WHERE id = p_source_id AND status = 'running' AND lock_token = p_lock_token;
  IF NOT FOUND THEN RAISE EXCEPTION 'source is not held by this worker'; END IF;
  IF r.evidence_id IS NULL OR p_reader NOT IN ('federal', 'utah') THEN RETURN 0; END IF;
  IF NOT EXISTS (SELECT 1 FROM huis.evidence_email m WHERE m.evidence_id = r.evidence_id AND huis.is_notice_sender(r.firm_id, p_reader, m.from_addr)) THEN
    RETURN 0;
  END IF;
  IF jsonb_typeof(p_events) <> 'array' OR jsonb_array_length(p_events) > 20 THEN RAISE EXCEPTION 'invalid court dates'; END IF;
  IF (SELECT count(*) FROM huis.court_events WHERE matter_id = r.matter_id AND origin = 'huis' AND status = 'suggested') >= 1000 THEN
    RETURN 0;
  END IF;
  SELECT left(content, 200000) INTO v_text FROM huis.evidence_text WHERE evidence_id = r.evidence_id;
  IF v_text IS NULL OR (p_reader = 'federal' AND position('Notice of Electronic Filing' IN v_text) = 0) THEN RETURN 0; END IF;

  FOR e IN SELECT * FROM jsonb_array_elements(p_events) LOOP
    BEGIN
      v_start := (e->>'start')::int;
      v_end := (e->>'end')::int;
      v_quote := left(btrim(regexp_replace(substr(v_text, v_start + 1, v_end - v_start), '\s+', ' ', 'g')), 1000);
      CONTINUE WHEN v_start < 0 OR v_end <= v_start OR v_end - v_start > 1000 OR coalesce(v_quote, '') = '';
      v_kind := e->>'kind';
      CONTINUE WHEN v_kind NOT IN ('hearing', 'deadline', 'trial', 'conference');
      INSERT INTO huis.court_events (firm_id, matter_id, kind, title, event_date, event_time, location, judge, status, origin, origin_key,
                                     source_evidence_id, char_start, char_end, quote, reader)
        VALUES (r.firm_id, r.matter_id, v_kind, left(e->>'title', 200), (e->>'date')::date, nullif(e->>'time', '')::time,
                left(nullif(e->>'location', ''), 200), left(nullif(e->>'judge', ''), 200), 'suggested', 'huis',
                left(format('%s:%s:%s:%s:%s:%s', CASE p_reader WHEN 'federal' THEN 'nef' ELSE 'utah' END,
                            coalesce(huis.case_key(e->>'caseNumber'), 'nocase'), coalesce(left(e->>'documentNumber', 10), ''),
                            lower(regexp_replace(left(e->>'title', 200), '\s+', ' ', 'g')), e->>'date', coalesce(e->>'time', ''))
                     || CASE WHEN huis.case_key(e->>'caseNumber') IS NULL THEN ':' || r.evidence_id::text ELSE '' END, 400),
                r.evidence_id, v_start, v_end, v_quote, p_reader)
        ON CONFLICT (matter_id, origin_key) DO NOTHING;
      IF FOUND THEN n := n + 1; END IF;
    EXCEPTION WHEN others THEN
      NULL;
    END;
  END LOOP;
  RETURN n;
END $$;
ALTER FUNCTION huis.worker_save_court_proposals(uuid, uuid, text, jsonb) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.worker_save_court_proposals(uuid, uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.worker_save_court_proposals(uuid, uuid, text, jsonb) TO huis_worker;

-- The earlier function is replaced by the one above.
DROP FUNCTION huis.worker_save_court_suggestions(uuid, uuid, jsonb);

-- When an administrator registers a sender, the firm's email from it is read again
-- (so notices already filed are proposed too). Only that firm's, only from that sender.
CREATE FUNCTION huis.requeue_notices_from(p_address text) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE n int;
BEGIN
  IF NOT huis.is_admin_role(huis.app_role()) THEN RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501'; END IF;
  UPDATE huis.brain_sources b SET status = 'queued', attempts = 0, last_error = NULL, queued_at = now()
    FROM huis.evidence_email m
   WHERE m.evidence_id = b.evidence_id AND b.firm_id = huis.current_firm_id() AND m.firm_id = huis.current_firm_id()
     AND b.status IN ('indexed', 'failed')
     AND lower(coalesce(substring(m.from_addr FROM '<([^<>[:space:]]+@[^<>[:space:]]+)>[[:space:]]*$'), btrim(coalesce(m.from_addr, '')))) = lower(p_address);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
ALTER FUNCTION huis.requeue_notices_from(text) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.requeue_notices_from(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.requeue_notices_from(text) TO huis_app;

-- Utah notices already filed from a Utah courts address are read again.
UPDATE huis.brain_sources b SET status = 'queued', attempts = 0, last_error = NULL, queued_at = now()
  FROM huis.evidence_email m
 WHERE m.evidence_id = b.evidence_id AND huis.is_utah_court_sender(m.from_addr);
