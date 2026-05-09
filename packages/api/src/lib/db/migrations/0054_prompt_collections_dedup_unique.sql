-- Migration 0054: Dedupe prompt_collections + add unique index (#2169).
--
-- The reported repro: /admin/prompts on a freshly /use-demo-seeded SaaS
-- workspace shows two "E-commerce KPIs" libraries side by side. Cause:
--   1. `seedPromptLibrary()` at startup (called from `runSeeds()` in
--      packages/api/src/lib/db/migrate.ts) inserts the global built-in
--      collections (org_id IS NULL, is_builtin = true) — one row per
--      industry.
--   2. The pre-#2169 /use-demo handler (`seedDemoPromptCollections`)
--      then *copied* every global builtin matching the demo industry
--      into the calling org's namespace (org_id = <orgId>, is_builtin =
--      true). Each copy was an exact replica of the global row.
--   3. The `org-with-demo` branch of `buildCollectionsListQuery` (see
--      packages/api/src/lib/prompts/scoping.ts) returns BOTH rows in a
--      single SELECT — its predicate accepts org_id IS NULL OR org_id =
--      $1 for matching-industry builtins — so /admin/prompts renders
--      the same library twice.
--
-- Fix has two halves: the route stops creating the per-org copies (see
-- the same PR's edit to packages/api/src/api/routes/onboarding.ts), and
-- this migration cleans up the rows that already exist on workspaces
-- that hit the bug. We then add a unique index so any future regression
-- (concurrent /use-demo, a new seed path, an admin import) fails loudly
-- instead of silently doubling the listing.
--
-- Ordering matters: dedupe BEFORE the unique index. A workspace with
-- existing duplicates would error on the CREATE UNIQUE INDEX otherwise,
-- leaving the migration broken on every replay.

-- ---------------------------------------------------------------------------
-- Step 1 — drop org-scoped builtin copies that match a global builtin.
-- ---------------------------------------------------------------------------
--
-- The cascade on prompt_items.collection_id (FK ON DELETE CASCADE) drops
-- the per-org copies of the items along with their parent. We do NOT
-- reparent items here (unlike step 2 below) because the items being
-- dropped are themselves verbatim copies of the global collection's
-- items — the global parent is still present, and the `org-with-demo`
-- listing query already returns its items, so the user observes no
-- semantic loss.
--
-- Match key: (lower(name), industry). `is_builtin = true` rows are
-- read-only at the admin layer (admin-prompts.ts returns 403 on edits
-- to is_builtin = true rows; see lines 556, 602, 625, 667, 716, 745),
-- so the org-scoped copy can never have diverged from the global —
-- dropping it is lossless. If a future schema change opens edits on
-- builtin copies, this step needs to gain a reparent before the delete.
DELETE FROM prompt_collections org_copy
USING prompt_collections global
WHERE org_copy.org_id IS NOT NULL
  AND org_copy.is_builtin = true
  AND global.org_id IS NULL
  AND global.is_builtin = true
  AND lower(org_copy.name) = lower(global.name)
  AND org_copy.industry = global.industry;

-- ---------------------------------------------------------------------------
-- Step 2 — fold any remaining same-org duplicates into the oldest row.
-- ---------------------------------------------------------------------------
--
-- Catches duplicates the step 1 cleanup didn't handle: same org_id, same
-- lower(name) (e.g. a custom collection a user manually created twice
-- via a double-clicked "Create" button). Keep the oldest row by
-- created_at; reparent prompt_items belonging to newer rows so we don't
-- cascade-delete them; then drop the newer rows.
--
-- DISTINCT ON (bucket-key) returns one keeper per bucket per the
-- trailing ORDER BY (oldest created_at, id tiebreak). Rows where
-- org_id IS NULL collapse into a single NULL bucket via COALESCE —
-- there should only ever be one global row per name, but the
-- belt-and-suspenders keeps the unique index below safe from a stray
-- duplicate global. Single-row buckets are emitted too; the UPDATE
-- excludes self-matches via `dup.id <> keepers.keeper_id`, so they
-- become no-ops.
WITH keepers AS (
  SELECT DISTINCT ON (COALESCE(org_id, ''), lower(name))
    id AS keeper_id,
    COALESCE(org_id, '') AS org_key,
    lower(name) AS name_key
  FROM prompt_collections
  ORDER BY COALESCE(org_id, ''), lower(name), created_at ASC, id ASC
)
UPDATE prompt_items
SET collection_id = keepers.keeper_id
FROM keepers, prompt_collections dup
WHERE prompt_items.collection_id = dup.id
  AND COALESCE(dup.org_id, '') = keepers.org_key
  AND lower(dup.name) = keepers.name_key
  AND dup.id <> keepers.keeper_id;

DELETE FROM prompt_collections dup
USING (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY COALESCE(org_id, ''), lower(name)
      ORDER BY created_at ASC, id ASC
    ) AS row_num
  FROM prompt_collections
) ranked
WHERE dup.id = ranked.id
  AND ranked.row_num > 1;

-- ---------------------------------------------------------------------------
-- Step 3 — enforce uniqueness going forward.
-- ---------------------------------------------------------------------------
--
-- (org_id, lower(name)) — case-insensitive so "E-commerce KPIs" and
-- "E-COMMERCE KPIs" can't coexist within the same workspace. Globals
-- (org_id IS NULL) collapse into a single bucket via COALESCE, so only
-- one global row per case-insensitive name is allowed. Different orgs
-- can each have their own "E-commerce KPIs" custom (different org_id).
CREATE UNIQUE INDEX IF NOT EXISTS prompt_collections_org_name_uniq
  ON prompt_collections (COALESCE(org_id, ''), lower(name));
