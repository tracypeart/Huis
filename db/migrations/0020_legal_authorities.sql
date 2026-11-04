-- Phase 7 part 1: claims matrix and legal authorities.
--
-- Legal authorities (cases, statutes, regulations, rules) are a firm-wide
-- library: public law, entered by attorneys, each linked to a real record
-- ("every legal authority links to a real record; no citations from AI
-- memory"). An authority stays unverified until an attorney confirms it;
-- changing its citation or link afterwards clears that confirmation.
--
-- Linking an authority to a claim's element in a Matter, with the
-- proposition it stands for, is work product: firm staff on the Matter only,
-- under the Case DNA rules.

CREATE TABLE huis.legal_authorities (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id      uuid NOT NULL REFERENCES huis.firms(id),
  kind         text NOT NULL CHECK (kind IN ('case', 'statute', 'regulation', 'rule', 'other')),
  citation     text NOT NULL CHECK (length(btrim(citation)) BETWEEN 1 AND 300),
  title        text NOT NULL DEFAULT '' CHECK (length(title) <= 300),
  court        text NOT NULL DEFAULT '' CHECK (length(court) <= 200),
  year         int CHECK (year IS NULL OR year BETWEEN 1600 AND 2100),
  jurisdiction text NOT NULL DEFAULT '' CHECK (length(jurisdiction) <= 100),
  -- The real record: a secure web link (official source, CourtListener, Westlaw, Lexis…).
  url          text NOT NULL CHECK (url ~ '^https://[^\s/?#@]+\.[^\s/?#@]+(/[^\s]*)?$' AND length(url) <= 2000),
  note         text NOT NULL DEFAULT '' CHECK (length(note) <= 4000),
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  verified_by  uuid,
  verified_at  timestamptz,
  CHECK ((verified_by IS NULL) = (verified_at IS NULL)),
  UNIQUE (firm_id, id),
  FOREIGN KEY (firm_id, created_by) REFERENCES huis.users(firm_id, id),
  FOREIGN KEY (firm_id, verified_by) REFERENCES huis.users(firm_id, id)
);
CREATE UNIQUE INDEX legal_authorities_citation ON huis.legal_authorities (firm_id, kind, lower(btrim(citation)));

-- Who added it and who verified it come from the database. Verifying records the person and time;
-- changing what the authority *is* (citation or link) clears the verification.
CREATE FUNCTION huis.legal_authority_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = huis, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_by := huis.current_user_id();
    NEW.created_at := clock_timestamp();
    NEW.verified_by := NULL;
    NEW.verified_at := NULL;
    RETURN NEW;
  END IF;
  IF NEW.firm_id IS DISTINCT FROM OLD.firm_id OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'an authority keeps who added it';
  END IF;
  IF NEW.citation IS DISTINCT FROM OLD.citation OR NEW.url IS DISTINCT FROM OLD.url OR NEW.kind IS DISTINCT FROM OLD.kind THEN
    NEW.verified_by := NULL;
    NEW.verified_at := NULL;
  ELSIF NEW.verified_at IS NOT NULL AND OLD.verified_at IS NULL THEN
    NEW.verified_by := huis.current_user_id();
    NEW.verified_at := clock_timestamp();
  ELSIF NEW.verified_by IS DISTINCT FROM OLD.verified_by OR NEW.verified_at IS DISTINCT FROM OLD.verified_at THEN
    IF NEW.verified_at IS NOT NULL THEN RAISE EXCEPTION 'a verification records who verified it and when'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER legal_authorities_guard BEFORE INSERT OR UPDATE ON huis.legal_authorities FOR EACH ROW EXECUTE FUNCTION huis.legal_authority_guard();

ALTER TABLE huis.legal_authorities ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.legal_authorities FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON huis.legal_authorities TO huis_app;

-- Firm staff read the library; staff who can change work (not read-only) add, edit and verify;
-- an authority can be removed only while no Matter cites it (see authority_links).
CREATE POLICY legal_authorities_select ON huis.legal_authorities FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.is_internal_role(huis.app_role()));
CREATE POLICY legal_authorities_insert ON huis.legal_authorities FOR INSERT TO huis_app
  WITH CHECK (firm_id = huis.current_firm_id() AND huis.is_internal_role(huis.app_role()) AND huis.app_role() <> 'read_only');
CREATE POLICY legal_authorities_update ON huis.legal_authorities FOR UPDATE TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.is_internal_role(huis.app_role()) AND huis.app_role() <> 'read_only')
  WITH CHECK (firm_id = huis.current_firm_id());
CREATE POLICY legal_authorities_delete ON huis.legal_authorities FOR DELETE TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.is_internal_role(huis.app_role()) AND huis.app_role() <> 'read_only'
         AND (created_by = huis.current_user_id() OR huis.is_firm_admin()));

-- ---------------------------------------------------------------------------
-- An authority cited for a claim's element (or the claim or defense itself), in a Matter.
-- ---------------------------------------------------------------------------
CREATE TABLE huis.authority_links (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id       uuid NOT NULL REFERENCES huis.firms(id),
  matter_id     uuid NOT NULL,
  node_id       uuid NOT NULL REFERENCES huis.dna_nodes(id) ON DELETE CASCADE,
  authority_id  uuid NOT NULL,
  stance        text NOT NULL CHECK (stance IN ('supports', 'opposes', 'explains')),
  proposition   text NOT NULL CHECK (length(btrim(proposition)) BETWEEN 1 AND 1000),
  pinpoint      text NOT NULL DEFAULT '' CHECK (length(pinpoint) <= 100),
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (node_id, authority_id, stance),
  FOREIGN KEY (firm_id, matter_id) REFERENCES huis.matters(firm_id, id),
  -- An authority a Matter cites can't be deleted from the library.
  FOREIGN KEY (firm_id, authority_id) REFERENCES huis.legal_authorities(firm_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (firm_id, created_by) REFERENCES huis.users(firm_id, id)
);
CREATE INDEX authority_links_matter ON huis.authority_links (firm_id, matter_id);
CREATE INDEX authority_links_authority ON huis.authority_links (authority_id);

-- Only a confirmed claim, defense or element of the same Matter; who and when from the database.
CREATE FUNCTION huis.authority_link_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = huis, pg_temp AS $$
BEGIN
  NEW.created_by := huis.current_user_id();
  NEW.created_at := clock_timestamp();
  IF NOT EXISTS (SELECT 1 FROM huis.dna_nodes n
                  WHERE n.id = NEW.node_id AND n.matter_id = NEW.matter_id AND n.firm_id = NEW.firm_id
                    AND n.kind IN ('claim', 'defense', 'element') AND n.status = 'confirmed') THEN
    RAISE EXCEPTION 'an authority is cited for a confirmed claim, defense or element of the same Matter';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER authority_links_check BEFORE INSERT ON huis.authority_links FOR EACH ROW EXECUTE FUNCTION huis.authority_link_check();

ALTER TABLE huis.authority_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.authority_links FORCE ROW LEVEL SECURITY;
-- No UPDATE: remove a citation and add it again to change it.
GRANT SELECT, INSERT, DELETE ON huis.authority_links TO huis_app;

-- Work product: the Case DNA rules (firm staff on the Matter; read-only staff read only), and only while
-- the claim, defense or element it's cited for is visible.
CREATE POLICY authority_links_select ON huis.authority_links FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.dna_readable(matter_id) AND EXISTS (SELECT 1 FROM huis.dna_nodes n WHERE n.id = node_id));
CREATE POLICY authority_links_insert ON huis.authority_links FOR INSERT TO huis_app
  WITH CHECK (firm_id = huis.current_firm_id() AND huis.dna_writable(matter_id) AND EXISTS (SELECT 1 FROM huis.dna_nodes n WHERE n.id = node_id));
-- (Every change rule repeats the visibility conditions: a DELETE with no WHERE clause must never reach other rows.)
CREATE POLICY authority_links_delete ON huis.authority_links FOR DELETE TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.dna_writable(matter_id) AND EXISTS (SELECT 1 FROM huis.dna_nodes n WHERE n.id = node_id));
