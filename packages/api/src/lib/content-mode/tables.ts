/**
 * Registration tuple for mode-participating content tables (#1515).
 *
 * Adding a new simple content table is a one-line change at the end of
 * this tuple: `{ kind: "simple", key: "dashboards" }` is enough — the
 * physical table name, default UPDATE SQL, and default COUNT SQL are
 * derived from the key, and the `ModeDraftCounts` wire type updates
 * itself via `InferDraftCounts`.
 *
 * Order matters: `runPublishPhases` invokes adapters in tuple order
 * inside the caller's transaction. Tables with foreign-key dependencies
 * on later entries must be declared earlier.
 *
 * Exotic adapters wrap existing domain helpers; see `adapters/` for the
 * semantic-entities adapter that composes `promoteDraftEntities` and
 * the overlay CTE.
 */

import { Effect } from "effect";
import type { PoolClient } from "pg";
import type { ContentModeEntry, PromotionReport, PublishPhaseError } from "./port";

/**
 * Temporary stub for the semantic-entities exotic adapter. Phase 2 of
 * #1515 replaces this with a composition of the existing
 * `promoteDraftEntities` + `applyTombstones` helpers from
 * `lib/semantic/entities.ts`. The stub succeeds with zero promoted so
 * the publish path stays green until the migration lands.
 */
const promoteSemanticEntitiesStub = (
  _tx: PoolClient,
  _orgId: string,
): Effect.Effect<PromotionReport, PublishPhaseError, never> =>
  Effect.succeed({ table: "semantic_entities", promoted: 0 });

export const CONTENT_MODE_TABLES = [
  { kind: "simple", key: "connections" },
  { kind: "simple", key: "prompts", table: "prompt_collections" },
  { kind: "simple", key: "starterPrompts", table: "query_suggestions" },
  {
    kind: "exotic",
    key: "semantic_entities",
    countSegments: [
      {
        key: "entities",
        sql: (p) =>
          `SELECT 'entities' AS key, COUNT(*)::int AS n FROM semantic_entities WHERE org_id = ${p} AND status = 'draft'`,
      },
      {
        key: "entityEdits",
        sql: (p) =>
          `SELECT 'entityEdits' AS key, COUNT(*)::int AS n FROM semantic_entities d
           INNER JOIN semantic_entities pub
             ON d.org_id = pub.org_id
            AND d.name = pub.name
            AND COALESCE(d.connection_id, '__default__') = COALESCE(pub.connection_id, '__default__')
           WHERE d.org_id = ${p} AND d.status = 'draft' AND pub.status = 'published'`,
      },
      {
        key: "entityDeletes",
        sql: (p) =>
          `SELECT 'entityDeletes' AS key, COUNT(*)::int AS n FROM semantic_entities WHERE org_id = ${p} AND status = 'draft_delete'`,
      },
    ],
    promote: promoteSemanticEntitiesStub,
  },
] as const satisfies ReadonlyArray<ContentModeEntry>;
