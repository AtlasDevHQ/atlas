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
 * The `semantic_entities` entry is exotic — its promote path composes
 * `applyTombstones` + `promoteDraftEntities` from
 * `lib/semantic/entities.ts`. See `./adapters/semantic-entities.ts`.
 */

import type { ContentModeEntry } from "./port";
import { matchScopeAcrossAliases } from "@atlas/api/lib/db/with-group-scope";
import { promoteSemanticEntities } from "./adapters/semantic-entities";

// `as const` is load-bearing: preserves key + kind literals for
// InferDraftCounts; `satisfies` enforces the port shape without widening.
// Do not collapse to one or the other.
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
        // Join keys on `connection_group_id` (#2340) so a multi-member
        // group is counted once per logical entity, not N per replica.
        // The PRD's "pending changes" banner is supposed to read as
        // "12 draft changes" — not "12 × 3 regions = 36".
        sql: (p) =>
          `SELECT 'entityEdits' AS key, COUNT(*)::int AS n FROM semantic_entities d
           INNER JOIN semantic_entities pub
             ON d.org_id = pub.org_id
            AND d.name = pub.name
            AND ${matchScopeAcrossAliases({ leftAlias: "d", rightAlias: "pub", column: "connection_group_id" })}
           WHERE d.org_id = ${p} AND d.status = 'draft' AND pub.status = 'published'`,
      },
      {
        key: "entityDeletes",
        sql: (p) =>
          `SELECT 'entityDeletes' AS key, COUNT(*)::int AS n FROM semantic_entities WHERE org_id = ${p} AND status = 'draft_delete'`,
      },
    ],
    promote: promoteSemanticEntities,
  },
] as const satisfies ReadonlyArray<ContentModeEntry>;
