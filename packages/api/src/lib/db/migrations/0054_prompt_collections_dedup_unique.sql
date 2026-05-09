-- Migration 0054: Dedupe prompt_collections + add unique index (#2169).
--
-- The reported repro: /admin/prompts on a freshly /use-demo-seeded SaaS
-- workspace shows two "E-commerce KPIs" libraries side by side. Cause:
--   1. `runSeeds()` at startup inserts the global built-in collections
--      (org_id IS NULL, is_builtin = true) — one row per industry.
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
-- the per-org copies of the items along with their parent. The user
-- still sees the items via the global collection's items, returned by
-- the same `org-with-demo` listing query.
--
-- Match key: (lower(name), industry). `is_builtin = true` rows are
-- read-only at the admin layer (admin-prompts.ts returns 403 on edits),
-- so the org-scoped copy can never have diverged from the global —
-- dropping it is lossless.
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
-- The CTE picks the keeper per (org_id, lower(name)) bucket. Rows where
-- org_id IS NULL collapse into the same NULL bucket — there should only
-- ever be one global row per name, but we belt-and-suspenders this so
-- the unique index below can't be tripped by a stray duplicate global.
WITH keepers AS (
  SELECT
    COALESCE(org_id, '') AS org_key,
    lower(name) AS name_key,
    (
      SELECT id FROM prompt_collections inner_pc
      WHERE COALESCE(inner_pc.org_id, '') = COALESCE(outer_pc.org_id, '')
        AND lower(inner_pc.name) = lower(outer_pc.name)
      ORDER BY inner_pc.created_at ASC, inner_pc.id ASC
      LIMIT 1
    ) AS keeper_id
  FROM prompt_collections outer_pc
  GROUP BY COALESCE(org_id, ''), lower(name)
  HAVING COUNT(*) > 1
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
