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
  // #2744 / ADR-0007 — `connections` segment key preserved for wire
  // compatibility (`/api/v1/mode` `draftCounts.connections` keeps its
  // contract) but the physical table is now `workspace_plugins` with
  // `org_id` widened to `workspace_id`. The `where` filter scopes
  // count + promote to `pillar='datasource'` rows so a future bug or
  // manual fix-up that leaves a chat/action `workspace_plugins` row in
  // `status='draft'` doesn't (a) inflate `draftCounts.connections` in the
  // admin banner or (b) get silently promoted by the publish endpoint.
  // Chat/action handlers currently always write `status='published'` —
  // this filter is a defense-in-depth.
  {
    kind: "simple",
    key: "connections",
    table: "workspace_plugins",
    orgColumn: "workspace_id",
    where: "pillar = 'datasource'",
  },
  { kind: "simple", key: "prompts", table: "prompt_collections" },
  { kind: "simple", key: "starterPrompts", table: "query_suggestions" },
  // #4206 / ADR-0028 — hosted OKF knowledge documents. Every ingest lands
  // `draft` (the review gate); the atomic publish endpoint promotes them and
  // the non-admin agent read gates on `status='published'`. `workspace_id` is
  // the org scope (workspace-global, never group-scoped). `knowledge_links` is
  // NOT registered — a link's visibility follows its source document, so it is
  // content-mode-exempt derived data (see migration 0163).
  {
    kind: "simple",
    key: "knowledgeDocuments",
    table: "knowledge_documents",
    orgColumn: "workspace_id",
  },
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
        //
        // `entity_type` in the join key matches the partial unique index
        // from migration 0063. Without it, a draft *metric* named
        // "accounts" cross-matches a published *entity* of the same name,
        // double-counting some rows and silently miscounting others.
        sql: (p) =>
          `SELECT 'entityEdits' AS key, COUNT(*)::int AS n FROM semantic_entities d
           INNER JOIN semantic_entities pub
             ON d.org_id = pub.org_id
            AND d.entity_type = pub.entity_type
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
