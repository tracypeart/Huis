-- Phase 5 part 2: contradiction engine.
--
-- Potential contradictions are worked out when they're read, from what the
-- person can see (Matter Brain passages and the timeline), so nothing about
-- them is stored until an attorney decides. This table keeps those decisions:
-- a confirmed contradiction (its statement becomes a Case DNA fact, linked
-- "contradicts" to the evidence, through the ordinary Case DNA rules), or a
-- rejected one (so it isn't suggested again).
--
-- Work product: firm staff on the Matter only, as for Case DNA.

CREATE TABLE huis.contradiction_decisions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id            uuid NOT NULL REFERENCES huis.firms(id),
  matter_id          uuid NOT NULL,
  flag_key           text NOT NULL CHECK (flag_key ~ '^[0-9a-f]{64}$'),
  decision           text NOT NULL CHECK (decision IN ('confirmed', 'rejected')),
  statement_node_id  uuid REFERENCES huis.dna_nodes(id) ON DELETE SET NULL,
  decided_by         uuid NOT NULL,
  decided_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (matter_id, flag_key),
  CHECK (decision = 'confirmed' OR statement_node_id IS NULL),
  FOREIGN KEY (firm_id, matter_id) REFERENCES huis.matters(firm_id, id),
  FOREIGN KEY (firm_id, decided_by) REFERENCES huis.users(firm_id, id)
);
CREATE INDEX contradiction_decisions_matter ON huis.contradiction_decisions (firm_id, matter_id);

-- Who and when come from the database, and a confirmed decision points at a statement in the same Matter.
CREATE FUNCTION huis.contradiction_decision_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = huis, pg_temp AS $$
BEGIN
  IF current_user <> 'huis_security' THEN
    NEW.decided_by := huis.current_user_id();
    NEW.decided_at := now();
  END IF;
  IF NEW.statement_node_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM huis.dna_nodes n
        WHERE n.id = NEW.statement_node_id AND n.matter_id = NEW.matter_id AND n.firm_id = NEW.firm_id
          AND n.kind = 'fact' AND n.status = 'confirmed') THEN
    RAISE EXCEPTION 'a contradiction must point at a confirmed fact in the same Matter';
  END IF;
  -- A confirmation is the end of confirming: its statement must already be cited, with evidence linked
  -- "contradicts" to it (security review 12, F5), so a bare "confirmed" row can't hide a flag.
  IF NEW.decision = 'confirmed' AND (NEW.statement_node_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM huis.dna_citations c WHERE c.node_id = NEW.statement_node_id)
       OR NOT EXISTS (SELECT 1 FROM huis.dna_links l WHERE l.to_id = NEW.statement_node_id AND l.relation = 'contradicts' AND l.status = 'confirmed')) THEN
    RAISE EXCEPTION 'a confirmed contradiction needs its cited statement and the evidence linked to it';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER contradiction_decisions_check BEFORE INSERT ON huis.contradiction_decisions
  FOR EACH ROW EXECUTE FUNCTION huis.contradiction_decision_check();

ALTER TABLE huis.contradiction_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.contradiction_decisions FORCE ROW LEVEL SECURITY;
-- No UPDATE: a decision is made once. A rejection can be withdrawn (deleted) to reconsider, and so can a
-- confirmation whose statement has since been deleted from Case DNA.
GRANT SELECT, INSERT, DELETE ON huis.contradiction_decisions TO huis_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON huis.contradiction_decisions TO huis_security;

CREATE POLICY contradiction_decisions_select ON huis.contradiction_decisions FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.dna_readable(matter_id));
CREATE POLICY contradiction_decisions_insert ON huis.contradiction_decisions FOR INSERT TO huis_app
  WITH CHECK (firm_id = huis.current_firm_id() AND huis.dna_writable(matter_id));
CREATE POLICY contradiction_decisions_delete ON huis.contradiction_decisions FOR DELETE TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.dna_writable(matter_id) AND (decision = 'rejected' OR statement_node_id IS NULL));
