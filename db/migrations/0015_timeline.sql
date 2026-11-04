-- Phase 5 part 1: Master Timeline.
--
-- The timeline is built from what Case DNA already holds (dated events,
-- facts and damages, with their sources) and from the Matter's filed email.
-- The only new data is each item's timeline categories (court, medical,
-- employment…). Until an attorney chooses them, categories is NULL and Huis
-- shows the ones its fixed, explainable rules suggest; once chosen, the
-- attorney's choice is kept exactly (an empty list means "none").

ALTER TABLE huis.dna_nodes ADD COLUMN categories text[]
  CHECK (categories IS NULL OR (
    cardinality(categories) <= 10
    AND array_position(categories, NULL) IS NULL
    AND categories <@ ARRAY['court', 'plaintiff', 'defendant', 'medical', 'financial', 'employment',
                            'communications', 'discovery', 'witness', 'damages']::text[]));

CREATE INDEX dna_nodes_timeline ON huis.dna_nodes (firm_id, matter_id, event_date) WHERE event_date IS NOT NULL;

-- The same rules as before, with categories: what Huis suggested stays as
-- Huis suggested it (categories included) until someone confirms it.
CREATE OR REPLACE FUNCTION huis.dna_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.firm_id IS DISTINCT FROM OLD.firm_id OR NEW.matter_id IS DISTINCT FROM OLD.matter_id
     OR NEW.origin IS DISTINCT FROM OLD.origin OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Case DNA history cannot be rewritten';
  END IF;
  IF TG_TABLE_NAME = 'dna_nodes' THEN
    IF NEW.kind IS DISTINCT FROM OLD.kind OR NEW.origin_key IS DISTINCT FROM OLD.origin_key THEN
      RAISE EXCEPTION 'Case DNA history cannot be rewritten';
    END IF;
    IF OLD.origin = 'huis' AND OLD.status = 'suggested' AND (
         NEW.label IS DISTINCT FROM OLD.label OR NEW.details IS DISTINCT FROM OLD.details OR NEW.event_date IS DISTINCT FROM OLD.event_date
         OR NEW.email IS DISTINCT FROM OLD.email OR NEW.role IS DISTINCT FROM OLD.role OR NEW.amount IS DISTINCT FROM OLD.amount
         OR NEW.categories IS DISTINCT FROM OLD.categories) THEN
      RAISE EXCEPTION 'Confirm a suggestion before changing it';
    END IF;
  ELSIF NEW.from_id IS DISTINCT FROM OLD.from_id OR NEW.to_id IS DISTINCT FROM OLD.to_id OR NEW.relation IS DISTINCT FROM OLD.relation THEN
    RAISE EXCEPTION 'Case DNA history cannot be rewritten';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'suggested' THEN RAISE EXCEPTION 'a decision cannot be undone to a suggestion'; END IF;
    NEW.decided_by := huis.current_user_id();
    NEW.decided_at := now();
  ELSIF NEW.decided_by IS DISTINCT FROM OLD.decided_by OR NEW.decided_at IS DISTINCT FROM OLD.decided_at THEN
    RAISE EXCEPTION 'Case DNA history cannot be rewritten';
  END IF;
  RETURN NEW;
END $$;

-- Huis's own suggestions never carry categories (the rules are applied when the timeline is shown).
CREATE FUNCTION huis.dna_huis_no_categories() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.origin = 'huis' AND NEW.categories IS NOT NULL THEN
    RAISE EXCEPTION 'Huis suggestions do not carry categories';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dna_nodes_huis_no_categories BEFORE INSERT ON huis.dna_nodes FOR EACH ROW EXECUTE FUNCTION huis.dna_huis_no_categories();

-- ---------------------------------------------------------------------------
-- Security review 11, F2: people on filed email are named by the address the
-- email was actually sent from or to, never one quoted inside a display name.
-- (Unchanged otherwise from 0013.)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION huis.worker_save_dna_suggestions(p_source_id uuid, p_lock_token uuid, p_events jsonb) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE
  r huis.brain_sources;
  e jsonb;
  v_node uuid;
  v_addr text;
  v_email text;
  v_people int := 0;
  v_pos int := 0;
  n int := 0;
BEGIN
  SELECT * INTO r FROM huis.brain_sources WHERE id = p_source_id AND status = 'running' AND lock_token = p_lock_token;
  IF NOT FOUND THEN RAISE EXCEPTION 'source is not held by this worker'; END IF;
  IF r.evidence_id IS NULL THEN RETURN 0; END IF;
  IF jsonb_typeof(p_events) <> 'array' OR jsonb_array_length(p_events) > 50 THEN RAISE EXCEPTION 'invalid suggestions'; END IF;
  -- A Matter can't be flooded with suggestions (attorneys can always add their own).
  IF (SELECT count(*) FROM huis.dna_nodes WHERE matter_id = r.matter_id AND origin = 'huis' AND status = 'suggested') >= 2000 THEN
    RETURN 0;
  END IF;

  FOR e IN SELECT * FROM jsonb_array_elements(p_events) LOOP
    BEGIN
      INSERT INTO huis.dna_nodes (firm_id, matter_id, kind, label, event_date, status, origin, origin_key)
        VALUES (r.firm_id, r.matter_id, 'event', left(e->>'label', 300), (e->>'date')::date, 'suggested', 'huis',
                format('event:%s:%s', r.evidence_id, (e->>'start')::int))
        ON CONFLICT (matter_id, origin_key) DO NOTHING
        RETURNING id INTO v_node;
      IF v_node IS NOT NULL THEN
        INSERT INTO huis.dna_citations (firm_id, matter_id, node_id, evidence_id, char_start, char_end, quote)
          VALUES (r.firm_id, r.matter_id, v_node, r.evidence_id, (e->>'start')::int, (e->>'end')::int, left(e->>'quote', 1500));
        n := n + 1;
      END IF;
    EXCEPTION WHEN others THEN
      -- One odd suggestion never stops the rest.
      NULL;
    END;
  END LOOP;

  -- People on a filed email (except the firm's own staff), at most 20 per email.
  -- The suggestion is named by address; the names an email gives are kept with
  -- each email it came from, so one email can't decide what a person is called.
  FOR v_addr IN
    SELECT a FROM huis.evidence_email m,
      LATERAL unnest(array_prepend(m.from_addr, m.to_addrs || m.cc_addrs)) a
     WHERE m.evidence_id = r.evidence_id AND a IS NOT NULL
     LIMIT 100
  LOOP
    EXIT WHEN v_people >= 20;
    v_pos := v_pos + 1;
    -- Only the address that ends the header (a display name can contain someone else's address);
    -- a bare address must be the whole value (security review 11, F2).
    v_email := lower(coalesce(substring(btrim(right(v_addr, 330)) FROM '<([^<>@\s]{1,64}@[^<>@\s]{1,255})>$'),
                              substring(btrim(right(v_addr, 330)) FROM '^([^<>@\s,;"]{1,64}@[^<>@\s,;"]{1,255})$')));
    CONTINUE WHEN v_email IS NULL OR length(v_email) > 320 OR v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$';
    CONTINUE WHEN EXISTS (SELECT 1 FROM huis.users u WHERE u.firm_id = r.firm_id AND lower(u.email) = v_email);
    v_people := v_people + 1;
    BEGIN
      v_node := NULL;
      INSERT INTO huis.dna_nodes (firm_id, matter_id, kind, label, email, status, origin, origin_key)
        VALUES (r.firm_id, r.matter_id, 'person', left(v_email, 300), v_email, 'suggested', 'huis', 'person:' || v_email)
        ON CONFLICT (matter_id, origin_key) DO NOTHING
        RETURNING id INTO v_node;
      IF v_node IS NOT NULL THEN n := n + 1;
      ELSE SELECT id INTO v_node FROM huis.dna_nodes WHERE matter_id = r.matter_id AND origin_key = 'person:' || v_email;
      END IF;
      -- Cited to this email (so the person leaves the map if every email they came from does).
      INSERT INTO huis.dna_citations (firm_id, matter_id, node_id, evidence_id, char_start, char_end, quote)
        VALUES (r.firm_id, r.matter_id, v_node, r.evidence_id, 1000000000 + v_pos, 1000000000 + v_pos, left('Email header: ' || v_addr, 1500))
        ON CONFLICT DO NOTHING;
    EXCEPTION WHEN others THEN NULL;
    END;
  END LOOP;
  RETURN n;
END $$;
ALTER FUNCTION huis.worker_save_dna_suggestions(uuid, uuid, jsonb) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.worker_save_dna_suggestions(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.worker_save_dna_suggestions(uuid, uuid, jsonb) TO huis_worker;
