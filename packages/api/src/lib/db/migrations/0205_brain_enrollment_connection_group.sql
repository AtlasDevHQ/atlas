-- 0205 — An enrollment names its connection group (#5286).
--
-- 0199 keyed this table `(workspace_id, entity, dimension)`. That key is only
-- unique in a workspace whose entity NAMES are, and they are not:
-- `semantic_entities`' natural key has been `(org_id, entity_type, name,
-- connection_group_id)` since 0063, and `getEntity` throws
-- `AmbiguousEntityError` on a stem-only lookup spanning more than one group.
--
-- So in a multi-group workspace an enrollment could not say WHICH `test_orders`
-- it meant. The surface offered the pair anyway (the picker enumerated by name
-- and dropped the group), the write succeeded, the row stored cleanly — and the
-- producer refused it on every run, because the lookup behind it refuses to
-- choose between two entities of the same name. That is verbatim the failure the
-- enrollment page's own copy claims it prevents: *"one would store cleanly,
-- reach nothing, and look exactly like success."*
--
-- Measured on staging, where `test_orders` is the only producible entity and is
-- published under three groups — which is what made staging unable to falsify
-- #5284's fix.
--
-- ## `''` is the flat scope, and it is a SENTINEL rather than a value
--
-- A primary key cannot contain NULL, and `semantic_entities.connection_group_id`
-- is nullable — NULL there means the flat/ungrouped scope (the `__global__` demo
-- rows and every pre-0063 row). So the scope arrives here as `''`, which no real
-- group id can be, and `lib/brain/enrollment.ts` is the ONE place that translates:
-- `null` in TypeScript, `''` in SQL, both directions, at the storage seam. Every
-- other module in the tree spells the scope `string | null`, matching
-- `AdminEntitySummary.connectionId` and `getAdminEntity`'s `connectionGroupId` —
-- so a group read from the semantic layer can be handed to an enrollment verb
-- without a conversion anyone has to remember.
--
-- ## The backfill RESOLVES what an existing row meant, where that is knowable
--
-- The column DEFAULT alone would make every existing enrollment flat-scoped, and
-- for a group-scoped workspace that is not what its rows meant — it is just the
-- only thing they could say. Left there, the producer would look each one up in
-- the flat scope, find nothing, and refuse it as `entity-not-published`: advice
-- ("publish the entity") that the admin can follow forever on an entity that is
-- already published.
--
-- So the UPDATE below resolves each pre-existing row to its entity's group where
-- the workspace's published semantic layer names EXACTLY ONE — no null-group row
-- for that name, and exactly one distinct group. That is the same "unique or
-- refuse" rule `getEntity` applies, run once here instead of on every future
-- read.
--
-- Everything it cannot resolve stays `''`. Two cases land there and both are
-- right: a genuinely flat workspace, where `''` IS the scope; and a name
-- published under two groups, where the row is ambiguous and the producer's
-- `ambiguous-group` refusal is the honest answer — it names the collision, and
-- re-enrolling through the picker now records which one was meant.
--
-- ## ⚠️ The primary-key swap is SINGLE-PHASE, and the overlap window is real
--
-- `check-migration-rename-discipline.sh` does not fire here — nothing is dropped
-- or renamed, a column is added and a key widened — but the README's N-1 ↔ N
-- argument applies to a key just as it does to a column, so it is stated rather
-- than left to be discovered:
--
--   * The draining N-1 container's `enrollPair` says `ON CONFLICT (workspace_id,
--     entity, dimension)`. After this runs there is no unique index on exactly
--     those three columns, so Postgres answers 42P10 and the enroll route 500s
--     with a request id until the rollout finishes.
--   * Its `unenrollPair` deletes by the same three columns, which after this
--     migration can match more than one row — an un-enroll issued against N-1
--     during the window would remove every group's copy of the pair rather than
--     the one the admin meant.
--
-- Accepted deliberately, and the alternative was weighed: the two-phase form
-- ships release N with the column added and the old key still standing, which is
-- release N doing nothing at all — the fix IS the key. The window is the drain
-- of a `numReplicas: 1` replace-not-rolling deploy, on an owner/admin-only
-- surface, in a milestone (M5) that has never produced a row on prod. Both
-- failures are loud, neither is silent, and the write is idempotent on retry.
-- The direction this must never take is the quiet one, and it does not.

ALTER TABLE brain_enrollment
  ADD COLUMN IF NOT EXISTS connection_group_id text NOT NULL DEFAULT '';

COMMENT ON COLUMN brain_enrollment.connection_group_id IS
  'The connection group this entity is published under (semantic_entities.connection_group_id). '
  '`''''` is the flat/ungrouped scope — see migration 0205. Part of the primary key: an entity '
  'NAME is unique only within a group, so without it a pair in a multi-group workspace is '
  'unaddressable and refuses on every producer run.';

-- ⚠️ BEFORE the key changes, so the resolved rows cannot collide with each other
-- under the new one — two rows of the same workspace/entity/dimension resolve to
-- the SAME group by construction (the subquery admits one group per name), so
-- this UPDATE cannot produce a duplicate key. Under the old key they were
-- already unique, and it does not create rows.
UPDATE brain_enrollment e
   SET connection_group_id = resolved.connection_group_id
  FROM (
    SELECT org_id,
           name,
           MIN(connection_group_id) AS connection_group_id
      FROM semantic_entities
     WHERE entity_type = 'entity'
       AND status = 'published'
     GROUP BY org_id, name
    -- No flat-scope row for this name, and exactly one group. Anything else is
    -- the ambiguity this migration deliberately does not guess at.
    HAVING COUNT(*) FILTER (WHERE connection_group_id IS NULL) = 0
       AND COUNT(DISTINCT connection_group_id) = 1
  ) resolved
 WHERE e.workspace_id = resolved.org_id
   AND e.entity = resolved.name
   AND e.connection_group_id = '';

-- The pair plus its scope IS the identity. Still a plain union for the region
-- import (`admin-migrate.ts`), which now conflicts on four columns instead of
-- three; the merge semantics are unchanged because the key is still made
-- entirely of human-supplied halves.
ALTER TABLE brain_enrollment DROP CONSTRAINT IF EXISTS brain_enrollment_pkey;
ALTER TABLE brain_enrollment
  ADD CONSTRAINT brain_enrollment_pkey
  PRIMARY KEY (workspace_id, entity, connection_group_id, dimension);

-- AT MOST ONE naming dimension per entity PER GROUP, widened for the key's
-- reason. Left at `(workspace_id, entity)` it would refuse to let the second
-- group's copy of a name be named at all — a 23505 raised by an index, on an act
-- the producer is going to refuse for a stated reason anyway. The producer's
-- refusal is the honest place for that decision (see `warehouse-producer.ts`'s
-- `enrolled-in-two-groups` arm); an index cannot carry a sentence.
DROP INDEX IF EXISTS uq_brain_enrollment_naming;
CREATE UNIQUE INDEX IF NOT EXISTS uq_brain_enrollment_naming
  ON brain_enrollment (workspace_id, entity, connection_group_id)
  WHERE naming;

-- NO secondary index, still. The new PRIMARY KEY is the btree the producer's
-- listing order needs — `(workspace_id, entity, …)` leads it, and the reach read
-- orders by `(entity, dimension)` within one workspace. 0199's note applies
-- unchanged.
