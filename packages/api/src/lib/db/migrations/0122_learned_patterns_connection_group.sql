-- 0122 — learned_patterns.connection_group_id (#3284).
--
-- The expert / `atlas improve` pipeline is now group-aware end-to-end: the
-- entity loader (`loadEntitiesFromDisk`) discovers `groups/<group>/entities/`
-- across the flat/groups/legacy layouts (ADR-0012), and the resolved group is
-- threaded analyze → insert → apply so an auto- or admin-approved amendment for
-- a `groups/<group>/` entity updates THAT group's row instead of 409-ing as
-- ambiguous or corrupting the default-scope copy.
--
-- This column persists that group on the amendment row so the admin approve
-- path (`admin-semantic-improve.ts` review-of-pending), which rebuilds the
-- proposal from the stored row's `source_entity` alone, can recover the target
-- group and pass it through `applyAmendmentToEntity` →
-- `getEntity`/`upsertEntityForGroup`/`syncEntityToDisk`. NULL means the default
-- (flat `entities/`) group — the same null = default convention
-- `semantic_entities.connection_group_id` uses.
--
-- Additive-only: a single nullable column, no constraint changes — safe to ship
-- in a single release under the two-phase-drop discipline (only DROP COLUMN /
-- DROP TABLE need the N / N+1 split). The Drizzle mirror in `db/schema.ts`
-- (`learnedPatterns.connectionGroupId`) lands in the SAME PR so
-- `check-schema-drift` stays green. Not Better-Auth-dependent, so it does NOT
-- join `MANAGED_AUTH_MIGRATIONS`.
--
-- Idempotent: `ADD COLUMN IF NOT EXISTS` is a no-op on re-run.

ALTER TABLE learned_patterns
  ADD COLUMN IF NOT EXISTS connection_group_id text;

COMMENT ON COLUMN learned_patterns.connection_group_id IS
  'Connection group the semantic amendment targets (ADR-0012). NULL = default (flat entities/) group. Threaded analyze → insert → apply so admin approve-of-pending rebuilds the correct group scope. #3284.';
