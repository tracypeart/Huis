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
