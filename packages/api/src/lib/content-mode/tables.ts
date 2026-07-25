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
// Function DECLARATIONS only — see `BRAIN_FACTS_TABLE`'s comment in the
// adapter. The `port → tables → adapters → port` ESM cycle means this module
// evaluates while the adapter is still initializing, so a `const` import would
// be in its temporal dead zone at tuple-construction time; hoisted functions
// are not.
import { brainFactStatusClause, brainFactsCountSql, promoteBrainFacts } from "./adapters/brain-facts";

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
    promotedKey: "entities",
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
  // #4769 / ADR-0036 — the company brain's tier-2 fact class. Exotic for its
  // WRITE only: reads are plain status semantics (see the adapter's
  // `readFilter`), but promotion must be able to refuse an individual fact and
  // name it, which a blanket UPDATE cannot. Scoped by `workspace_id`, like
  // `knowledge_documents` and `connections`.
  //
  // `brain_episodes` is deliberately NOT registered: episodes are append-only
  // evidence with no `status` column at all (migration 0180), and evidence is
  // not review-gated — only the CLAIMS drawn from it are. `brain_edges` is
  // derived structure whose visibility follows its endpoints, so it is
  // content-mode-exempt for the same reason `knowledge_links` is.
  {
    kind: "exotic",
    // Literal, matching `BRAIN_FACTS_TABLE` — see the import note above.
    key: "brain_facts",
    promotedKey: "brainFacts",
    countSegments: [{ key: "brainFacts", sql: brainFactsCountSql }],
    promote: promoteBrainFacts,
    // Plain status semantics, no overlay CTE. Present because an exotic entry
    // without a `readFilter` makes `ContentModeRegistry.readFilter` fail with
    // `ExoticReadFilterUnavailableError` — the alternative to which would be a
    // silent fallback that serves draft facts to the agent.
    readFilter: {
      published: (alias: string) => brainFactStatusClause("published", alias),
      developerOverlay: (alias: string) => brainFactStatusClause("developer", alias),
    },
  },
] as const satisfies ReadonlyArray<ContentModeEntry>;
