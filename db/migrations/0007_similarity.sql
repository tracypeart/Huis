-- Phase 2 part 3a: near-duplicates and versions.
--
-- After a file's text is read, the worker computes a compact fingerprint of
-- its wording (MinHash over 5-word phrases) and the database links it to
-- similar items in the same matter:
--   near_duplicate — almost the same wording (≥ 85%) under a different name
--   version        — same document name once words like "final", "v2",
--                    "copy" and dates are ignored, with overlapping wording (≥ 30%)
-- Exact byte-for-byte duplicates are already linked by duplicate_of.
--
-- Privilege: a link is only visible to someone who can see BOTH items, so a
-- client can never learn that a shared document resembles a privileged one.

CREATE TABLE huis.evidence_fingerprints (
  evidence_id  uuid PRIMARY KEY,
  firm_id      uuid NOT NULL,
  matter_id    uuid NOT NULL,
  minhash      int[] NOT NULL CHECK (cardinality(minhash) = 64),
  name_stem    text,
  is_email     boolean NOT NULL,
  phrase_count int NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (firm_id, evidence_id) REFERENCES huis.evidence_items(firm_id, id)
);

-- Locality-sensitive hashing bands (32 bands of 2 values) for fast candidate lookup.
CREATE TABLE huis.evidence_lsh (
  evidence_id uuid NOT NULL REFERENCES huis.evidence_fingerprints(evidence_id),
  matter_id   uuid NOT NULL,
  band        smallint NOT NULL,
  hash        bigint NOT NULL,
  PRIMARY KEY (evidence_id, band)
);
CREATE INDEX evidence_lsh_lookup ON huis.evidence_lsh (matter_id, band, hash);

-- A band value shared by very many items (automated emails, boilerplate)
-- says nothing useful, so matching reads at most 201 entries per band value
-- and skips crowded ones: the work per item is bounded however big the matter.
CREATE INDEX evidence_fingerprints_stem ON huis.evidence_fingerprints (matter_id, name_stem) WHERE name_stem IS NOT NULL;

CREATE TABLE huis.evidence_similarity (
  item_a     uuid NOT NULL,
  item_b     uuid NOT NULL,
  firm_id    uuid NOT NULL,
  matter_id  uuid NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('near_duplicate', 'version')),
  score      real NOT NULL CHECK (score >= 0 AND score <= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_a, item_b),
  CHECK (item_a < item_b),
  FOREIGN KEY (firm_id, item_a) REFERENCES huis.evidence_items(firm_id, id),
  FOREIGN KEY (firm_id, item_b) REFERENCES huis.evidence_items(firm_id, id)
);
CREATE INDEX evidence_similarity_b ON huis.evidence_similarity (item_b);

ALTER TABLE huis.evidence_fingerprints ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.evidence_lsh          ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.evidence_similarity   ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.evidence_fingerprints FORCE ROW LEVEL SECURITY;
ALTER TABLE huis.evidence_lsh          FORCE ROW LEVEL SECURITY;
ALTER TABLE huis.evidence_similarity   FORCE ROW LEVEL SECURITY;

-- Fingerprints are internal: the app can't read or write them at all.
REVOKE ALL ON huis.evidence_fingerprints, huis.evidence_lsh, huis.evidence_similarity FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON huis.evidence_fingerprints, huis.evidence_lsh, huis.evidence_similarity TO huis_security;
GRANT SELECT ON huis.evidence_similarity TO huis_app;

-- Visible only when BOTH items are visible to this person (evidence RLS applies inside).
CREATE POLICY evidence_similarity_select ON huis.evidence_similarity FOR SELECT TO huis_app
  USING (firm_id = huis.current_firm_id()
         AND EXISTS (SELECT 1 FROM huis.evidence_items i WHERE i.id = item_a)
         AND EXISTS (SELECT 1 FROM huis.evidence_items i WHERE i.id = item_b));

-- Records an item's fingerprint and links it to similar items in its matter.
-- Only the worker holding this item's extract job can call it.
CREATE FUNCTION huis.worker_save_similarity(
  p_job_id bigint, p_lock_token uuid, p_minhash int[], p_name_stem text, p_is_email boolean, p_phrase_count int
) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE
  v_job   huis.jobs;
  v_item  huis.evidence_items;
  v_stem  text := nullif(left(btrim(coalesce(p_name_stem, '')), 200), '');
  v_links int := 0;
  c       record;
BEGIN
  v_job := huis.worker_held_extract_job(p_job_id, p_lock_token);
  SELECT * INTO v_item FROM huis.evidence_items WHERE id = v_job.evidence_id;
  IF cardinality(p_minhash) <> 64 OR array_position(p_minhash, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'invalid fingerprint';
  END IF;
  IF EXISTS (SELECT 1 FROM huis.evidence_fingerprints WHERE evidence_id = v_item.id) THEN
    RETURN 0; -- already fingerprinted (a retried job)
  END IF;

  INSERT INTO huis.evidence_fingerprints (evidence_id, firm_id, matter_id, minhash, name_stem, is_email, phrase_count)
    VALUES (v_item.id, v_item.firm_id, v_item.matter_id, p_minhash, v_stem, p_is_email, greatest(p_phrase_count, 0));
  INSERT INTO huis.evidence_lsh (evidence_id, matter_id, band, hash)
    SELECT v_item.id, v_item.matter_id, b,
           (p_minhash[b * 2 + 1]::bigint << 32) | (p_minhash[b * 2 + 2]::bigint & 4294967295)
      FROM generate_series(0, 31) b;

  -- Too little text to compare meaningfully (a few words, a blank scan).
  IF p_phrase_count < 20 THEN RETURN 0; END IF;

  FOR c IN
    WITH cand AS (
      SELECT l.evidence_id, count(*) AS shared
        FROM huis.evidence_lsh me
        CROSS JOIN LATERAL (
          SELECT array_agg(x.evidence_id) AS ids FROM (
            SELECT o.evidence_id FROM huis.evidence_lsh o
             WHERE o.matter_id = me.matter_id AND o.band = me.band AND o.hash = me.hash AND o.evidence_id <> me.evidence_id
             LIMIT 201) x
        ) bucket
        -- crowded band values (over 200 items) are skipped
        CROSS JOIN LATERAL unnest(CASE WHEN coalesce(cardinality(bucket.ids), 0) <= 200 THEN bucket.ids ELSE '{}'::uuid[] END) AS l(evidence_id)
       WHERE me.evidence_id = v_item.id
       GROUP BY l.evidence_id
       ORDER BY count(*) DESC
       LIMIT 200
    )
    SELECT f.evidence_id, f.name_stem, f.is_email, o.sha256 AS other_sha,
           (SELECT count(*) FROM generate_subscripts(p_minhash, 1) k WHERE p_minhash[k] = f.minhash[k])::real / 64 AS score
      FROM cand
      JOIN huis.evidence_fingerprints f ON f.evidence_id = cand.evidence_id
      JOIN huis.evidence_items o ON o.id = f.evidence_id
     WHERE f.phrase_count >= 20 AND o.firm_id = v_item.firm_id AND o.matter_id = v_item.matter_id
     ORDER BY score DESC
  LOOP
    EXIT WHEN v_links >= 50;  -- at most 50 links per item
    -- Exact copies are already linked as duplicates.
    CONTINUE WHEN c.other_sha = v_item.sha256;
    IF v_stem IS NOT NULL AND c.name_stem = v_stem AND NOT p_is_email AND NOT c.is_email AND c.score >= 0.3 THEN
      INSERT INTO huis.evidence_similarity (item_a, item_b, firm_id, matter_id, kind, score)
        VALUES (least(v_item.id, c.evidence_id), greatest(v_item.id, c.evidence_id), v_item.firm_id, v_item.matter_id, 'version', c.score)
        ON CONFLICT DO NOTHING;
      v_links := v_links + 1;
    ELSIF c.score >= 0.85 THEN
      INSERT INTO huis.evidence_similarity (item_a, item_b, firm_id, matter_id, kind, score)
        VALUES (least(v_item.id, c.evidence_id), greatest(v_item.id, c.evidence_id), v_item.firm_id, v_item.matter_id, 'near_duplicate', c.score)
        ON CONFLICT DO NOTHING;
      v_links := v_links + 1;
    END IF;
  END LOOP;
  RETURN v_links;
END $$;

ALTER FUNCTION huis.worker_save_similarity(bigint, uuid, int[], text, boolean, int) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.worker_save_similarity(bigint, uuid, int[], text, boolean, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.worker_save_similarity(bigint, uuid, int[], text, boolean, int) TO huis_worker;

-- ---------------------------------------------------------------------------
-- Unpacking budgets as running totals.
-- Outlook mailboxes can produce hundreds of thousands of items; adding up
-- every previous item on each insert (0006) doesn't scale, so the budget is
-- kept as counters: one row per upload (everything unpacked from it) and one
-- per container (its direct contents).
-- ---------------------------------------------------------------------------
CREATE TABLE huis.unpack_counters (
  item_id uuid PRIMARY KEY REFERENCES huis.evidence_items(id),
  items   bigint NOT NULL DEFAULT 0,
  bytes   bigint NOT NULL DEFAULT 0
);
ALTER TABLE huis.unpack_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.unpack_counters FORCE ROW LEVEL SECURITY;
REVOKE ALL ON huis.unpack_counters FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON huis.unpack_counters TO huis_security;

INSERT INTO huis.unpack_counters (item_id, items, bytes)
  SELECT root_id, count(*), sum(size_bytes) FROM huis.evidence_items WHERE parent_id IS NOT NULL GROUP BY root_id
  ON CONFLICT DO NOTHING;
-- Container rows are only needed for counts; roots already hold their own.
INSERT INTO huis.unpack_counters (item_id, items, bytes)
  SELECT parent_id, count(*), 0 FROM huis.evidence_items WHERE parent_id IS NOT NULL AND parent_id <> root_id GROUP BY parent_id
  ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION huis.worker_add_derived(
  p_job_id bigint, p_lock_token uuid, p_child_id uuid, p_filename text, p_container_path text,
  p_declared_type text, p_size bigint, p_sha256 text, p_storage_key text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE
  v_job    huis.jobs;
  v_parent huis.evidence_items;
  v_root   huis.evidence_items;
  v_budget huis.unpack_counters;
  v_direct bigint;
BEGIN
  v_job := huis.worker_held_extract_job(p_job_id, p_lock_token);
  SELECT * INTO v_parent FROM huis.evidence_items WHERE id = v_job.evidence_id FOR UPDATE;
  IF v_parent.status <> 'clean' THEN RAISE EXCEPTION 'parent is not clean'; END IF;
  IF v_parent.depth >= 4 THEN RAISE EXCEPTION 'items nested too deeply'; END IF;
  IF p_size IS NULL OR p_size < 0 THEN RAISE EXCEPTION 'invalid size'; END IF;
  IF p_storage_key IS DISTINCT FROM format('firm/%s/matter/%s/evidence/%s/original', v_parent.firm_id, v_parent.matter_id, p_child_id) THEN
    RAISE EXCEPTION 'unexpected storage location';
  END IF;

  SELECT * INTO v_root FROM huis.evidence_items WHERE id = coalesce(v_parent.root_id, v_parent.id);

  -- Whole-upload budget (row locked, so concurrent jobs from one upload queue up).
  INSERT INTO huis.unpack_counters (item_id) VALUES (v_root.id) ON CONFLICT DO NOTHING;
  SELECT * INTO v_budget FROM huis.unpack_counters WHERE item_id = v_root.id FOR UPDATE;
  IF v_budget.items >= 250000 THEN RAISE EXCEPTION 'unpacking quota for this upload reached (items)'; END IF;
  IF v_budget.bytes + p_size > least(greatest(20 * v_root.size_bytes, 1073741824), 53687091200) THEN
    RAISE EXCEPTION 'unpacking quota for this upload reached';
  END IF;
  UPDATE huis.unpack_counters SET items = items + 1, bytes = bytes + p_size WHERE item_id = v_root.id;

  -- Direct contents of this container.
  IF v_parent.id <> v_root.id THEN
    INSERT INTO huis.unpack_counters (item_id, items) VALUES (v_parent.id, 1)
      ON CONFLICT (item_id) DO UPDATE SET items = huis.unpack_counters.items + 1
      RETURNING items INTO v_direct;
  ELSE
    v_direct := v_budget.items + 1;
  END IF;
  IF v_direct > 250000 THEN RAISE EXCEPTION 'too many items in one container'; END IF;

  INSERT INTO huis.evidence_items (id, firm_id, matter_id, folder_id, original_filename, declared_content_type,
      size_bytes, sha256, storage_key, source, received_from, date_received, uploaded_by, uploaded_at,
      parent_id, root_id, container_path, depth)
    VALUES (p_child_id, v_parent.firm_id, v_parent.matter_id, v_parent.folder_id,
      left(coalesce(nullif(p_filename, ''), 'unnamed'), 1024), left(p_declared_type, 200),
      p_size, p_sha256, p_storage_key, 'extracted', v_parent.received_from, v_parent.date_received,
      v_parent.uploaded_by, now(), v_parent.id, v_root.id, left(p_container_path, 4096), v_parent.depth + 1);
END $$;

-- ---------------------------------------------------------------------------
-- Long jobs (large mailboxes) renew their lease so no second worker picks
-- them up while they're still running.
-- ---------------------------------------------------------------------------
CREATE FUNCTION huis.worker_renew_lease(p_job_id bigint, p_lock_token uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
BEGIN
  UPDATE huis.jobs SET locked_until = now() + interval '6 hours'
   WHERE id = p_job_id AND status = 'running' AND lock_token = p_lock_token;
  RETURN FOUND;
END $$;
ALTER FUNCTION huis.worker_renew_lease(bigint, uuid) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.worker_renew_lease(bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.worker_renew_lease(bigint, uuid) TO huis_worker;

-- What an upload may still unpack, so the worker stops encrypting and
-- storing contained files once the budget is used up (instead of storing
-- everything and discarding the excess).
CREATE FUNCTION huis.worker_unpack_remaining(p_job_id bigint, p_lock_token uuid, OUT items bigint, OUT bytes bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE
  v_job  huis.jobs;
  v_item huis.evidence_items;
  v_root huis.evidence_items;
  v_used huis.unpack_counters;
BEGIN
  v_job := huis.worker_held_extract_job(p_job_id, p_lock_token);
  SELECT * INTO v_item FROM huis.evidence_items WHERE id = v_job.evidence_id;
  SELECT * INTO v_root FROM huis.evidence_items WHERE id = coalesce(v_item.root_id, v_item.id);
  SELECT * INTO v_used FROM huis.unpack_counters WHERE item_id = v_root.id;
  items := greatest(0, 250000 - coalesce(v_used.items, 0));
  bytes := greatest(0, least(greatest(20 * v_root.size_bytes, 1073741824), 53687091200) - coalesce(v_used.bytes, 0));
END $$;
ALTER FUNCTION huis.worker_unpack_remaining(bigint, uuid) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.worker_unpack_remaining(bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.worker_unpack_remaining(bigint, uuid) TO huis_worker;
