-- Phase 8 part 3: court date reminders.
--
-- Confirmed court dates get reminders 30, 14, 7, 3 and 1 day before and on
-- the day, in Huis (the alerts bell) and, once a sending service is set up
-- with production hosting, by email, SMS and push. Each person chooses their
-- channels and reminders.
--
-- Who is reminded: active firm staff who are members of the Matter or its
-- lead attorney. Never clients or other outside users, even on Matters shared
-- with them. Walls hold: a walled Matter's members are its only recipients.
--
-- Privilege: a reminder stores no wording, only which court date and when;
-- what it says is read from the court date itself each time it's shown, under
-- the same rules as the court calendar, so it disappears with the court date
-- (or with access to the Matter). Messages leaving Huis say only that there is
-- a court date, unless the person asks for details.

CREATE TABLE huis.alert_preferences (
  firm_id         uuid NOT NULL REFERENCES huis.firms(id),
  user_id         uuid PRIMARY KEY,
  channels        text[] NOT NULL DEFAULT '{in_app}'
                  CHECK (channels <@ ARRAY['in_app', 'email', 'sms', 'push']::text[] AND cardinality(channels) <= 4),
  reminder_days   int[] NOT NULL DEFAULT '{30,14,7,3,1,0}'
                  CHECK (reminder_days <@ ARRAY[30, 14, 7, 3, 1, 0] AND cardinality(reminder_days) <= 6),
  -- Messages sent outside Huis carry the court date's details only when the person asks.
  include_details boolean NOT NULL DEFAULT false,
  sms_number      text CHECK (sms_number IS NULL OR sms_number ~ '^\+[1-9][0-9]{6,14}$'),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (firm_id, user_id) REFERENCES huis.users(firm_id, id)
);
ALTER TABLE huis.alert_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.alert_preferences FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON huis.alert_preferences TO huis_app;
GRANT SELECT ON huis.alert_preferences TO huis_security;
-- Each person's own, firm staff only.
CREATE POLICY alert_preferences_own ON huis.alert_preferences FOR ALL TO huis_app
  USING (firm_id = huis.current_firm_id() AND user_id = huis.current_user_id() AND huis.is_internal_role(huis.app_role()))
  WITH CHECK (firm_id = huis.current_firm_id() AND user_id = huis.current_user_id() AND huis.is_internal_role(huis.app_role()));

CREATE TABLE huis.court_alerts (
  id              bigserial PRIMARY KEY,
  firm_id         uuid NOT NULL REFERENCES huis.firms(id),
  user_id         uuid NOT NULL,
  matter_id       uuid NOT NULL,
  court_event_id  uuid NOT NULL REFERENCES huis.court_events(id) ON DELETE CASCADE,
  channel         text NOT NULL CHECK (channel IN ('in_app', 'email', 'sms', 'push')),
  days_before     int NOT NULL CHECK (days_before IN (30, 14, 7, 3, 1, 0)),
  -- The court date this reminder was for (a moved date gets its own reminders).
  event_date      date NOT NULL,
  status          text NOT NULL CHECK (status IN ('delivered', 'queued', 'sending', 'sent', 'waiting_for_provider', 'failed')),
  attempts        int NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  last_error      text CHECK (last_error IS NULL OR length(last_error) <= 200),
  locked_until    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  sent_at         timestamptz,
  read_at         timestamptz,
  UNIQUE (court_event_id, user_id, channel, days_before, event_date),
  FOREIGN KEY (firm_id, user_id) REFERENCES huis.users(firm_id, id),
  FOREIGN KEY (firm_id, matter_id) REFERENCES huis.matters(firm_id, id)
);
CREATE INDEX court_alerts_mine ON huis.court_alerts (firm_id, user_id, created_at DESC);
CREATE INDEX court_alerts_queue ON huis.court_alerts (status, created_at) WHERE status IN ('queued', 'sending');

-- From the app, the only change is marking a reminder read, once.
CREATE FUNCTION huis.court_alert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'huis_security' THEN RETURN NEW; END IF;
  IF (to_jsonb(NEW) - 'read_at') IS DISTINCT FROM (to_jsonb(OLD) - 'read_at') THEN
    RAISE EXCEPTION 'reminders cannot be changed';
  END IF;
  IF OLD.read_at IS NOT NULL THEN NEW.read_at := OLD.read_at;
  ELSIF NEW.read_at IS NOT NULL THEN NEW.read_at := now(); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER court_alerts_guard BEFORE UPDATE ON huis.court_alerts FOR EACH ROW EXECUTE FUNCTION huis.court_alert_guard();

ALTER TABLE huis.court_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.court_alerts FORCE ROW LEVEL SECURITY;
GRANT SELECT, UPDATE ON huis.court_alerts TO huis_app;
GRANT SELECT, INSERT, UPDATE ON huis.court_alerts TO huis_security;
GRANT USAGE ON SEQUENCE huis.court_alerts_id_seq TO huis_security;
-- Your own reminders, while you can still see the Matter and the court date itself
-- (row-level security on the court calendar applies inside the lookup).
CREATE POLICY court_alerts_select ON huis.court_alerts FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND user_id = huis.current_user_id() AND huis.is_internal_role(huis.app_role())
         AND huis.can_see_matter(matter_id) AND EXISTS (SELECT 1 FROM huis.court_events e WHERE e.id = court_event_id));
CREATE POLICY court_alerts_update ON huis.court_alerts FOR UPDATE TO huis_app
  USING (firm_id = huis.current_firm_id() AND user_id = huis.current_user_id() AND huis.is_internal_role(huis.app_role())
         AND huis.can_see_matter(matter_id) AND EXISTS (SELECT 1 FROM huis.court_events e WHERE e.id = court_event_id))
  WITH CHECK (firm_id = huis.current_firm_id() AND user_id = huis.current_user_id());

-- A firm's time zone must be a real one (security review 18, R18-3): an
-- unknown zone would break every date calculation that uses it.
CREATE FUNCTION huis.firm_time_zone_valid() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.time_zone) THEN
    RAISE EXCEPTION 'Unknown time zone: choose one such as America/Denver' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER firms_time_zone_valid BEFORE INSERT OR UPDATE OF time_zone ON huis.firms FOR EACH ROW EXECUTE FUNCTION huis.firm_time_zone_valid();

-- ---------------------------------------------------------------------------
-- Worker: queue the reminders due today, and deliver those leaving Huis.
-- ---------------------------------------------------------------------------
-- Due today (in each firm's own time zone): confirmed, not done, its notice (if any) clean.
CREATE FUNCTION huis.worker_queue_court_alerts() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE
  f record;
  k int;
  n int := 0;
BEGIN
  -- One firm at a time, so a problem with one firm never stops another's reminders (R18-3).
  FOR f IN SELECT id, time_zone FROM huis.firms LOOP
    BEGIN
      WITH due AS (
        SELECT e.id AS event_id, e.firm_id, e.matter_id, e.event_date,
               e.event_date - (now() AT TIME ZONE f.time_zone)::date AS days_before
          FROM huis.court_events e
         WHERE e.firm_id = f.id AND e.status = 'confirmed' AND e.done_at IS NULL
           AND e.event_date BETWEEN (now() AT TIME ZONE f.time_zone)::date AND (now() AT TIME ZONE f.time_zone)::date + 30
           AND (e.source_evidence_id IS NULL OR EXISTS (
                 SELECT 1 FROM huis.evidence_items i WHERE i.id = e.source_evidence_id AND i.matter_id = e.matter_id AND i.status = 'clean'))
      ), recipients AS (
        -- Members of the Matter, and (on a Matter without a wall) its lead attorney: active firm staff only.
        -- Behind a wall, membership is what counts: a lead attorney taken off a walled Matter isn't reminded (R18-1).
        SELECT d.*, u.id AS user_id
          FROM due d
          JOIN huis.matters m ON m.id = d.matter_id AND m.firm_id = d.firm_id
          JOIN huis.users u ON u.firm_id = d.firm_id AND u.status = 'active' AND huis.is_internal_role(u.role)
         WHERE (NOT m.restricted AND u.id = m.lead_attorney_id)
            OR EXISTS (SELECT 1 FROM huis.matter_members mm WHERE mm.matter_id = d.matter_id AND mm.user_id = u.id)
      ), wanted AS (
        SELECT r.*, ch AS channel
          FROM recipients r
          LEFT JOIN huis.alert_preferences p ON p.user_id = r.user_id AND p.firm_id = r.firm_id
          CROSS JOIN LATERAL unnest(coalesce(p.channels, ARRAY['in_app'])) ch
         WHERE r.days_before = ANY (coalesce(p.reminder_days, ARRAY[30, 14, 7, 3, 1, 0]))
      )
      INSERT INTO huis.court_alerts (firm_id, user_id, matter_id, court_event_id, channel, days_before, event_date, status, sent_at)
      SELECT firm_id, user_id, matter_id, event_id, channel, days_before, event_date,
             CASE WHEN channel = 'in_app' THEN 'delivered' ELSE 'queued' END,
             CASE WHEN channel = 'in_app' THEN now() END
        FROM wanted
      ON CONFLICT (court_event_id, user_id, channel, days_before, event_date) DO NOTHING;
      GET DIAGNOSTICS k = ROW_COUNT;
      n := n + k;
    EXCEPTION WHEN others THEN
      RAISE WARNING 'court reminders skipped for one firm: %', SQLERRM;
    END;
  END LOOP;
  RETURN n;
END $$;
ALTER FUNCTION huis.worker_queue_court_alerts() OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.worker_queue_court_alerts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.worker_queue_court_alerts() TO huis_worker;

-- One reminder to send outside Huis, checked again at the moment of sending:
-- the court date must still be confirmed, not done, on the same day, with a
-- clean notice, and the person must still be active staff on the Matter.
-- Details are included only when the person asked for them.
CREATE FUNCTION huis.worker_claim_court_alert()
RETURNS TABLE (alert_id bigint, channel text, email text, sms_number text, days_before int, event_date date,
               include_details boolean, kind text, title text, event_time text, matter_title text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE
  a huis.court_alerts;
  v_left int;
  v_why text;
BEGIN
  LOOP
    SELECT * INTO a FROM huis.court_alerts c
     WHERE c.channel <> 'in_app' AND (c.status = 'queued' OR (c.status = 'sending' AND c.locked_until < now())) AND c.attempts < 5
     ORDER BY c.created_at LIMIT 1 FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN RETURN; END IF;
    -- How far away the date really is now, in the firm's time zone (R18-4).
    SELECT a.event_date - (now() AT TIME ZONE f.time_zone)::date INTO v_left FROM huis.firms f WHERE f.id = a.firm_id;
    v_why := CASE
      WHEN v_left IS NULL OR v_left < 0 THEN 'the court date has passed'
      -- A newer reminder for the same date and channel is due: send that one instead.
      WHEN EXISTS (SELECT 1 FROM huis.court_alerts o
                    WHERE o.court_event_id = a.court_event_id AND o.user_id = a.user_id AND o.channel = a.channel
                      AND o.event_date = a.event_date AND o.days_before < a.days_before AND o.days_before >= v_left
                      AND o.status IN ('queued', 'sending', 'sent', 'waiting_for_provider')) THEN 'a later reminder replaces it'
      -- Still the court date it was for, still wanted, still someone who should know (R18-1, R18-2).
      WHEN NOT EXISTS (
         SELECT 1 FROM huis.court_events e
           JOIN huis.matters m ON m.id = e.matter_id
           JOIN huis.users u ON u.id = a.user_id AND u.firm_id = a.firm_id AND u.status = 'active' AND huis.is_internal_role(u.role)
          WHERE e.id = a.court_event_id AND e.status = 'confirmed' AND e.done_at IS NULL AND e.event_date = a.event_date
            AND ((NOT m.restricted AND u.id = m.lead_attorney_id)
                 OR EXISTS (SELECT 1 FROM huis.matter_members mm WHERE mm.matter_id = m.id AND mm.user_id = u.id))
            AND (e.source_evidence_id IS NULL OR EXISTS (
                  SELECT 1 FROM huis.evidence_items i WHERE i.id = e.source_evidence_id AND i.matter_id = e.matter_id AND i.status = 'clean'))) THEN 'no longer applies'
      WHEN NOT EXISTS (
         SELECT 1 WHERE a.channel = ANY (coalesce((SELECT p.channels FROM huis.alert_preferences p WHERE p.user_id = a.user_id), ARRAY['in_app']))
                    AND a.days_before = ANY (coalesce((SELECT p.reminder_days FROM huis.alert_preferences p WHERE p.user_id = a.user_id), ARRAY[30, 14, 7, 3, 1, 0]))) THEN 'no longer wanted'
      END;
    IF v_why IS NOT NULL THEN
      UPDATE huis.court_alerts SET status = 'failed', last_error = v_why, locked_until = NULL WHERE id = a.id;
      CONTINUE;
    END IF;
    UPDATE huis.court_alerts SET status = 'sending', attempts = attempts + 1, locked_until = now() + interval '5 minutes' WHERE id = a.id;
    RETURN QUERY
      SELECT a.id, a.channel, u.email::text, p.sms_number, v_left, a.event_date, coalesce(p.include_details, false),
             CASE WHEN coalesce(p.include_details, false) THEN e.kind END,
             CASE WHEN coalesce(p.include_details, false) THEN e.title END,
             CASE WHEN coalesce(p.include_details, false) THEN to_char(e.event_time, 'HH24:MI') END,
             CASE WHEN coalesce(p.include_details, false) THEN m.title END
        FROM huis.users u
        JOIN huis.court_events e ON e.id = a.court_event_id
        JOIN huis.matters m ON m.id = e.matter_id
        LEFT JOIN huis.alert_preferences p ON p.user_id = u.id
       WHERE u.id = a.user_id;
    RETURN;
  END LOOP;
END $$;
ALTER FUNCTION huis.worker_claim_court_alert() OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.worker_claim_court_alert() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.worker_claim_court_alert() TO huis_worker;

-- How a send went: sent, no sending service set up yet (kept, visible, retried
-- once one is), or failed (retried a few times).
CREATE FUNCTION huis.worker_finish_court_alert(p_alert_id bigint, p_outcome text, p_error text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
BEGIN
  IF p_outcome NOT IN ('sent', 'waiting_for_provider', 'failed') THEN RAISE EXCEPTION 'invalid outcome'; END IF;
  UPDATE huis.court_alerts
     SET status = CASE WHEN p_outcome = 'failed' AND attempts < 5 THEN 'queued' ELSE p_outcome END,
         sent_at = CASE WHEN p_outcome = 'sent' THEN now() END,
         last_error = CASE WHEN p_outcome = 'sent' THEN NULL ELSE left(p_error, 200) END,
         locked_until = NULL
   WHERE id = p_alert_id AND status = 'sending';
END $$;
ALTER FUNCTION huis.worker_finish_court_alert(bigint, text, text) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.worker_finish_court_alert(bigint, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.worker_finish_court_alert(bigint, text, text) TO huis_worker;

-- Once a sending service is set up, reminders that waited for one are tried again
-- (only those still ahead of their court date).
CREATE FUNCTION huis.worker_retry_waiting_court_alerts(p_channel text) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE n int;
BEGIN
  UPDATE huis.court_alerts a SET status = 'queued', attempts = 0
    FROM huis.firms f
   WHERE f.id = a.firm_id AND a.status = 'waiting_for_provider' AND a.channel = p_channel
     AND a.event_date >= (now() AT TIME ZONE f.time_zone)::date;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
ALTER FUNCTION huis.worker_retry_waiting_court_alerts(text) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.worker_retry_waiting_court_alerts(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.worker_retry_waiting_court_alerts(text) TO huis_worker;
