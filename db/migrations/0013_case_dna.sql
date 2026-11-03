-- Phase 4 part 2: Case DNA™.
--
-- Each Matter's relationship map: people, organizations, events, claims,
-- defenses, legal elements, facts and damages, the links between them, and
-- the evidence behind each one.
--
-- AI suggests; attorneys decide. Huis's own suggestions start as
-- "suggested" and only become part of the map when someone confirms them.
-- Rejected suggestions stay rejected (they aren't suggested again).
--
-- Privilege: Case DNA is attorney work product. Firm staff who can see the
-- Matter can read it; clients and other outside users never can. A node
-- drawn from evidence that is no longer clean disappears from the map.

CREATE TABLE huis.dna_nodes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id      uuid NOT NULL REFERENCES huis.firms(id),
  matter_id    uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('person', 'organization', 'event', 'claim', 'defense', 'element', 'fact', 'damage')),
  label        text NOT NULL CHECK (length(label) BETWEEN 1 AND 300),
  details      text NOT NULL DEFAULT '' CHECK (length(details) <= 20000),
  event_date   date CHECK (event_date IS NULL OR event_date BETWEEN DATE '1900-01-01' AND DATE '2100-12-31'),
  email        text CHECK (email IS NULL OR (length(email) <= 320 AND email = lower(email))),
  role         text CHECK (role IS NULL OR length(role) <= 100),
  amount       numeric(14, 2) CHECK (amount IS NULL OR amount >= 0),
  status       text NOT NULL CHECK (status IN ('suggested', 'confirmed', 'rejected')),
  origin       text NOT NULL CHECK (origin IN ('attorney', 'huis')),
  origin_key   text CHECK (origin_key IS NULL OR length(origin_key) <= 400),
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_by   uuid,
  decided_at   timestamptz,
  UNIQUE (firm_id, id),
  UNIQUE (matter_id, origin_key),
  CHECK ((origin = 'huis') = (created_by IS NULL)),
  CHECK (origin = 'huis' OR status <> 'suggested'),
  FOREIGN KEY (firm_id, matter_id) REFERENCES huis.matters(firm_id, id),
  FOREIGN KEY (firm_id, created_by) REFERENCES huis.users(firm_id, id),
  FOREIGN KEY (firm_id, decided_by) REFERENCES huis.users(firm_id, id)
);
CREATE INDEX dna_nodes_matter ON huis.dna_nodes (firm_id, matter_id, kind);

CREATE TABLE huis.dna_links (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id      uuid NOT NULL REFERENCES huis.firms(id),
  matter_id    uuid NOT NULL,
  from_id      uuid NOT NULL REFERENCES huis.dna_nodes(id) ON DELETE CASCADE,
  to_id        uuid NOT NULL REFERENCES huis.dna_nodes(id) ON DELETE CASCADE,
  relation     text NOT NULL CHECK (relation IN ('element_of', 'supports', 'contradicts', 'involves', 'witness_to',
                                                  'defends_against', 'caused', 'works_for', 'related_to')),
  status       text NOT NULL CHECK (status IN ('suggested', 'confirmed', 'rejected')),
  origin       text NOT NULL CHECK (origin IN ('attorney', 'huis')),
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_by   uuid,
  decided_at   timestamptz,
  UNIQUE (from_id, to_id, relation),
  CHECK (from_id <> to_id),
  CHECK ((origin = 'huis') = (created_by IS NULL)),
  FOREIGN KEY (firm_id, matter_id) REFERENCES huis.matters(firm_id, id),
  FOREIGN KEY (firm_id, created_by) REFERENCES huis.users(firm_id, id),
  FOREIGN KEY (firm_id, decided_by) REFERENCES huis.users(firm_id, id)
);
CREATE INDEX dna_links_from ON huis.dna_links (from_id);
CREATE INDEX dna_links_to ON huis.dna_links (to_id);

-- Where a node came from: a passage of evidence or an attorney note.
CREATE TABLE huis.dna_citations (
  id           bigserial PRIMARY KEY,
  firm_id      uuid NOT NULL REFERENCES huis.firms(id),
  matter_id    uuid NOT NULL,
  node_id      uuid NOT NULL REFERENCES huis.dna_nodes(id) ON DELETE CASCADE,
  evidence_id  uuid,
  note_id      uuid REFERENCES huis.matter_notes(id) ON DELETE CASCADE,
  char_start   int NOT NULL CHECK (char_start >= 0),
  char_end     int NOT NULL CHECK (char_end >= char_start),
  quote        text NOT NULL CHECK (length(quote) BETWEEN 1 AND 1500),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((evidence_id IS NULL) <> (note_id IS NULL)),
  UNIQUE (node_id, evidence_id, note_id, char_start),
  FOREIGN KEY (firm_id, matter_id) REFERENCES huis.matters(firm_id, id),
  FOREIGN KEY (firm_id, evidence_id) REFERENCES huis.evidence_items(firm_id, id)
);
CREATE INDEX dna_citations_node ON huis.dna_citations (node_id);
CREATE INDEX dna_citations_evidence ON huis.dna_citations (evidence_id);

-- Everything in a link or citation stays inside its Matter.
CREATE FUNCTION huis.dna_same_matter() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'dna_links' THEN
    IF NOT EXISTS (SELECT 1 FROM huis.dna_nodes n WHERE n.id = NEW.from_id AND n.matter_id = NEW.matter_id AND n.firm_id = NEW.firm_id)
       OR NOT EXISTS (SELECT 1 FROM huis.dna_nodes n WHERE n.id = NEW.to_id AND n.matter_id = NEW.matter_id AND n.firm_id = NEW.firm_id) THEN
      RAISE EXCEPTION 'links must stay within one Matter';
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM huis.dna_nodes n WHERE n.id = NEW.node_id AND n.matter_id = NEW.matter_id AND n.firm_id = NEW.firm_id)
       OR (NEW.evidence_id IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM huis.evidence_items i WHERE i.id = NEW.evidence_id AND i.matter_id = NEW.matter_id))
       OR (NEW.note_id IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM huis.matter_notes x WHERE x.id = NEW.note_id AND x.matter_id = NEW.matter_id)) THEN
      RAISE EXCEPTION 'citations must stay within one Matter';
    END IF;
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION huis.dna_same_matter() OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.dna_same_matter() FROM PUBLIC;
CREATE TRIGGER dna_links_same_matter BEFORE INSERT OR UPDATE ON huis.dna_links FOR EACH ROW EXECUTE FUNCTION huis.dna_same_matter();
CREATE TRIGGER dna_citations_same_matter BEFORE INSERT OR UPDATE ON huis.dna_citations FOR EACH ROW EXECUTE FUNCTION huis.dna_same_matter();

-- What can change after creation: wording, dates and amounts, and the decision (recorded with who and when).
CREATE FUNCTION huis.dna_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER dna_nodes_guard BEFORE UPDATE ON huis.dna_nodes FOR EACH ROW EXECUTE FUNCTION huis.dna_guard();
CREATE TRIGGER dna_links_guard BEFORE UPDATE ON huis.dna_links FOR EACH ROW EXECUTE FUNCTION huis.dna_guard();

-- A node built on evidence that is no longer clean leaves the map.
CREATE FUNCTION huis.dna_node_sources_ok(p_node_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = huis, pg_temp AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM huis.dna_citations c JOIN huis.evidence_items i ON i.id = c.evidence_id
     WHERE c.node_id = p_node_id AND (i.status <> 'clean' OR i.matter_id <> c.matter_id))
$$;
ALTER FUNCTION huis.dna_node_sources_ok(uuid) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.dna_node_sources_ok(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.dna_node_sources_ok(uuid) TO huis_app;

CREATE FUNCTION huis.dna_readable(p_matter_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT huis.is_internal_role(huis.app_role()) AND huis.can_see_matter(p_matter_id)
$$;
CREATE FUNCTION huis.dna_writable(p_matter_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT huis.is_internal_role(huis.app_role()) AND huis.app_role() <> 'read_only' AND huis.can_see_matter(p_matter_id)
$$;
GRANT EXECUTE ON FUNCTION huis.dna_readable(uuid), huis.dna_writable(uuid) TO huis_app;

ALTER TABLE huis.dna_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.dna_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.dna_citations ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.dna_nodes FORCE ROW LEVEL SECURITY;
ALTER TABLE huis.dna_links FORCE ROW LEVEL SECURITY;
ALTER TABLE huis.dna_citations FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON huis.dna_nodes, huis.dna_links TO huis_app;
GRANT SELECT, INSERT, DELETE ON huis.dna_citations TO huis_app;
GRANT USAGE ON SEQUENCE huis.dna_citations_id_seq TO huis_app, huis_security;
GRANT SELECT, INSERT, UPDATE, DELETE ON huis.dna_nodes, huis.dna_links, huis.dna_citations TO huis_security;

CREATE POLICY dna_nodes_select ON huis.dna_nodes FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.dna_readable(matter_id) AND huis.dna_node_sources_ok(id));
CREATE POLICY dna_nodes_insert ON huis.dna_nodes FOR INSERT TO huis_app
  WITH CHECK (firm_id = huis.current_firm_id() AND huis.dna_writable(matter_id)
              AND origin = 'attorney' AND created_by = huis.current_user_id() AND status = 'confirmed' AND origin_key IS NULL
              AND decided_by IS NULL AND decided_at IS NULL);
CREATE POLICY dna_nodes_update ON huis.dna_nodes FOR UPDATE TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.dna_writable(matter_id) AND huis.dna_node_sources_ok(id))
  WITH CHECK (firm_id = huis.current_firm_id());
CREATE POLICY dna_nodes_delete ON huis.dna_nodes FOR DELETE TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.dna_writable(matter_id) AND origin = 'attorney');

-- Links are visible only when both ends are.
CREATE POLICY dna_links_select ON huis.dna_links FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.dna_readable(matter_id)
         AND EXISTS (SELECT 1 FROM huis.dna_nodes n WHERE n.id = from_id)
         AND EXISTS (SELECT 1 FROM huis.dna_nodes n WHERE n.id = to_id));
CREATE POLICY dna_links_insert ON huis.dna_links FOR INSERT TO huis_app
  WITH CHECK (firm_id = huis.current_firm_id() AND huis.dna_writable(matter_id)
              AND origin = 'attorney' AND created_by = huis.current_user_id() AND status = 'confirmed'
              AND decided_by IS NULL AND decided_at IS NULL
              AND EXISTS (SELECT 1 FROM huis.dna_nodes n WHERE n.id = from_id)
              AND EXISTS (SELECT 1 FROM huis.dna_nodes n WHERE n.id = to_id));
CREATE POLICY dna_links_update ON huis.dna_links FOR UPDATE TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.dna_writable(matter_id))
  WITH CHECK (firm_id = huis.current_firm_id());
CREATE POLICY dna_links_delete ON huis.dna_links FOR DELETE TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.dna_writable(matter_id) AND origin = 'attorney');

-- Citations: visible only with their node and their source (evidence rules, so walls apply).
CREATE POLICY dna_citations_select ON huis.dna_citations FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.dna_readable(matter_id)
         AND EXISTS (SELECT 1 FROM huis.dna_nodes n WHERE n.id = node_id)
         AND ((evidence_id IS NOT NULL AND EXISTS (SELECT 1 FROM huis.evidence_items i WHERE i.id = evidence_id AND i.status = 'clean'))
              OR (note_id IS NOT NULL AND EXISTS (SELECT 1 FROM huis.matter_notes x WHERE x.id = note_id))));
CREATE POLICY dna_citations_insert ON huis.dna_citations FOR INSERT TO huis_app
  WITH CHECK (firm_id = huis.current_firm_id() AND huis.dna_writable(matter_id)
              AND EXISTS (SELECT 1 FROM huis.dna_nodes n WHERE n.id = node_id AND n.origin = 'attorney')
              AND ((evidence_id IS NOT NULL AND EXISTS (SELECT 1 FROM huis.evidence_items i WHERE i.id = evidence_id AND i.status = 'clean'))
                   OR (note_id IS NOT NULL AND EXISTS (SELECT 1 FROM huis.matter_notes x WHERE x.id = note_id))));
CREATE POLICY dna_citations_delete ON huis.dna_citations FOR DELETE TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.dna_writable(matter_id));

-- ---------------------------------------------------------------------------
-- Huis's suggestions, saved by the worker while it reads a document:
-- dated events found in the text, and the people on a filed email.
-- ---------------------------------------------------------------------------
CREATE FUNCTION huis.worker_save_dna_suggestions(p_source_id uuid, p_lock_token uuid, p_events jsonb) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE
  r huis.brain_sources;
  e jsonb;
  v_node uuid;
  v_addr text;
  v_name text;
  v_email text;
  n int := 0;
BEGIN
  SELECT * INTO r FROM huis.brain_sources WHERE id = p_source_id AND status = 'running' AND lock_token = p_lock_token;
  IF NOT FOUND THEN RAISE EXCEPTION 'source is not held by this worker'; END IF;
  IF r.evidence_id IS NULL THEN RETURN 0; END IF;
  IF jsonb_typeof(p_events) <> 'array' OR jsonb_array_length(p_events) > 50 THEN RAISE EXCEPTION 'invalid suggestions'; END IF;

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

  -- People on a filed email (except the firm's own staff).
  FOR v_addr IN
    SELECT a FROM huis.evidence_email m,
      LATERAL unnest(array_prepend(m.from_addr, m.to_addrs || m.cc_addrs)) a
     WHERE m.evidence_id = r.evidence_id AND a IS NOT NULL
     LIMIT 100
  LOOP
    v_email := lower(coalesce(substring(v_addr FROM '<([^<>@\s]+@[^<>\s]+)>'), substring(v_addr FROM '([^<>@\s,;"]+@[^<>\s,;"]+)')));
    CONTINUE WHEN v_email IS NULL OR length(v_email) > 320;
    CONTINUE WHEN EXISTS (SELECT 1 FROM huis.users u WHERE u.firm_id = r.firm_id AND lower(u.email) = v_email);
    v_name := nullif(btrim(regexp_replace(split_part(v_addr, '<', 1), '["'']', '', 'g')), '');
    BEGIN
      INSERT INTO huis.dna_nodes (firm_id, matter_id, kind, label, email, status, origin, origin_key)
        VALUES (r.firm_id, r.matter_id, 'person', left(coalesce(v_name, v_email), 300), v_email, 'suggested', 'huis',
                'person:' || v_email)
        ON CONFLICT (matter_id, origin_key) DO NOTHING;
      IF FOUND THEN n := n + 1; END IF;
    EXCEPTION WHEN others THEN NULL;
    END;
  END LOOP;
  RETURN n;
END $$;
ALTER FUNCTION huis.worker_save_dna_suggestions(uuid, uuid, jsonb) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.worker_save_dna_suggestions(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.worker_save_dna_suggestions(uuid, uuid, jsonb) TO huis_worker;
