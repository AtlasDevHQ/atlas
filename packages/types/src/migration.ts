/** Migration bundle types — wire format for `atlas-operator export` / `atlas import`. */

import type { MessageRole, Surface } from "./conversation";
import type { LearnedPattern } from "./learned-pattern";

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

/**
 * Bundle format version produced by exporters. Increment on breaking changes.
 *
 * v2 (#4460) widens the bundle to the pillars that shipped after v1 —
 * dashboards, knowledge documents, scheduled tasks, agent session memory.
 * The new sections are REQUIRED on a v2 bundle (so a producer that claims v2
 * but drops a section fails validation loudly instead of silently stranding
 * data), while importers keep accepting v1 bundles from pre-#4460 producers.
 */
export const EXPORT_BUNDLE_VERSION = 2;

/**
 * Bundle versions an importer accepts. v1 = the pre-#4460 four-pillar bundle
 * (conversations, semantic entities, learned patterns, settings) with the
 * newer sections absent. Type-only so scaffold-bound consumers don't need a
 * new published value symbol.
 */
export type SupportedBundleVersion = 1 | 2;

/** Metadata header for an export bundle. */
export interface ExportManifest {
  version: SupportedBundleVersion;
  exportedAt: string;
  source: {
    /** Human-readable label for the source instance (e.g. "self-hosted"). */
    label: string;
    /** Base URL of the source Atlas API, if known. */
    apiUrl?: string;
  };
  counts: {
    conversations: number;
    messages: number;
    semanticEntities: number;
    learnedPatterns: number;
    settings: number;
    /** v2 sections (#4460) — absent on a v1 bundle. */
    dashboards?: number;
    dashboardCards?: number;
    dashboardUserDrafts?: number;
    knowledgeDocuments?: number;
    knowledgeLinks?: number;
    scheduledTasks?: number;
    agentSessionMemory?: number;
    /** Company brain (#4767, ADR-0036). */
    brainEpisodes?: number;
    brainFacts?: number;
    brainEdges?: number;
    factAudienceMembers?: number;
  };
}

// ---------------------------------------------------------------------------
// Per-entity export shapes
// ---------------------------------------------------------------------------

/** Exported conversation — includes messages inline. */
export interface ExportedConversation {
  id: string;
  userId: string | null;
  title: string | null;
  surface: Surface;
  connectionId: string | null;
  starred: boolean;
  createdAt: string;
  updatedAt: string;
  messages: ExportedMessage[];
}

/** Exported message within a conversation. */
export interface ExportedMessage {
  id: string;
  role: MessageRole;
  content: unknown;
  createdAt: string;
}

/** Exported semantic entity (DB-backed YAML). */
export interface ExportedSemanticEntity {
  name: string;
  entityType: string;
  yamlContent: string;
  /**
   * Group scope (multi-environment semantic layer, #2340). Three accepted
   * shapes:
   * - **omitted** — producer with no group concept (pre-1.4.4 bundle).
   *   Importers coalesce this to `null`.
   * - **explicit `null`** — 1.4.4+ unscoped row (global / no binding), or a
   *   bundle whose legacy `connectionId` no longer resolves to a live group.
   * - **explicit string** — group id. One entity row per group; multi-member
   *   groups share the same definition.
   *
   * Optional because strict shape validation on import would otherwise reject
   * producers that have no concept of the column. Value-nullability alone
   * wasn't enough — optionality is what makes the field additive on the wire.
   */
  connectionGroupId?: string | null;
}

/** Exported learned pattern. */
export interface ExportedLearnedPattern {
  patternSql: string;
  description: string | null;
  sourceEntity: string | null;
  confidence: number;
  status: LearnedPattern["status"];
  /**
   * Row type — `query_pattern` (default) or `semantic_amendment`. Carried so an
   * amendment survives workspace migration as an amendment instead of
   * round-tripping as an orphaned query pattern (#4569, audit M9). Optional for
   * backward-compat with pre-#4569 bundles (absent ⇒ `query_pattern`).
   */
  type?: LearnedPattern["type"];
  /**
   * The stored amendment envelope (entity, amendment type, diff, payload) for a
   * `semantic_amendment` row; `null`/absent for query patterns. Opaque
   * passthrough — carried verbatim from source jsonb to target so the
   * amendment's content survives the migration (#4569) without coupling the
   * bundle to a specific `AmendmentPayload` schema version. (Workspace
   * ownership is carried by `orgId` + `connectionGroupId`, not this envelope.)
   */
  amendmentPayload?: Record<string, unknown> | null;
  /** Connection group the row targets (ADR-0012); `null`/absent = default group. */
  connectionGroupId?: string | null;
  /** Reviewer attribution carried through the migration; `null`/absent if unreviewed. */
  reviewedBy?: string | null;
  /** Review timestamp (paired with `reviewedBy`); `null`/absent if unreviewed. */
  reviewedAt?: string | null;
  /** Observed repetition count — pattern/amendment strength; absent ⇒ 1. */
  repetitionCount?: number;
  /**
   * Which road reached `status = 'approved'` (#4571): `false` = a human approved
   * it, `true` = the nightly auto-promote job did. Carried so the injection
   * eligibility bypass survives workspace migration — a human-approved pattern
   * stays human-approved (injectable regardless of confidence), a machine-promoted
   * one stays confidence-gated. Optional for backward-compat with pre-#4571
   * bundles; the importer fails closed on absence (treats it as machine/gated) so
   * an old bundle can never grant an unearned bypass.
   */
  autoPromoted?: boolean;
}

/** Exported setting key/value pair. */
export interface ExportedSetting {
  key: string;
  value: string;
}

// ---------------------------------------------------------------------------
// v2 sections (#4460) — dashboards, knowledge, scheduled tasks, session memory
// ---------------------------------------------------------------------------

/**
 * Exported dashboard card. Card-level `cached_*` snapshot columns are a
 * deliberate carve-out — the target region regenerates card data on first
 * render rather than importing stale result sets.
 *
 * The JSONB fields (`chartConfig`, `annotations`, `layout`) are `unknown` by
 * design — opaque passthrough from source jsonb to target jsonb. Typing them
 * as the web-facing dashboard shapes would claim a validation the import path
 * does not perform (the read side re-validates on render, e.g. annotations
 * via `dashboardCardAnnotationsSchema`).
 */
export interface ExportedDashboardCard {
  /** Original UUID, preserved so draft snapshots referencing cards stay valid. */
  id: string;
  position: number;
  title: string;
  /** Card SQL; empty string for a text/section card. */
  sql: string;
  chartConfig: unknown;
  /** Markdown body of a text card; null for a chart card. */
  content: string | null;
  /** Event-annotation markers (JSONB array). */
  annotations: unknown;
  connectionGroupId: string | null;
  /** Grid layout (JSONB); null = not yet placed. */
  layout: unknown;
  createdAt: string;
  updatedAt: string;
}

/**
 * Exported per-user dashboard draft (ADR-0034 — drafts are content, not
 * operational state, so they ride the bundle). The draft-card data cache
 * (`dashboard_draft_card_cache`) is a carve-out and regenerates on demand.
 */
export interface ExportedDashboardUserDraft {
  userId: string;
  /** Full DashboardSnapshot JSONB. */
  draft: unknown;
  /** Published snapshot at fork time (three-way-merge baseline). */
  baseline: unknown;
  publishedBaselineAt: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Exported dashboard, with cards and per-user drafts inline (the messages-in-
 * conversations pattern — idempotency skip is per dashboard).
 *
 * Share tokens are deliberately NOT exported: share URLs are region-bound
 * (served from the source region's host), so existing links die on migration
 * and the owner re-mints them in the target. `shareMode` (the preference)
 * survives; the token does not.
 */
export interface ExportedDashboard {
  /** Original UUID, preserved so card/draft FKs survive the import. */
  id: string;
  ownerId: string;
  title: string;
  description: string | null;
  /** Sharing preference; the share token itself is dropped — the owner re-shares post-migration. */
  shareMode: "public" | "org";
  refreshSchedule: string | null;
  /** Parameter definitions (JSONB array). */
  parameters: unknown;
  /** First-publish visibility marker; null = still private to the owner. */
  firstPublishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  cards: ExportedDashboardCard[];
  drafts: ExportedDashboardUserDraft[];
}

/** Exported intra-collection knowledge link (rides with its source document). */
export interface ExportedKnowledgeLink {
  targetPath: string;
  anchorText: string | null;
}

/**
 * Exported knowledge document with review `status` preserved and its link
 * graph inline (#4460 — links ride the bundle rather than re-deriving at
 * import, so the graph tier works immediately without re-parsing bodies).
 * The FTS vector is a generated column and rebuilds automatically on insert.
 * Sync credentials + sync state are carve-outs (per-region ciphertext; the
 * customer re-enters the secret and re-syncs in the target region).
 */
export interface ExportedKnowledgeDocument {
  /** Original UUID, preserved so link/graph references survive the import. */
  id: string;
  collectionId: string;
  path: string;
  type: string | null;
  title: string | null;
  description: string | null;
  /** OKF tags (JSONB array, opaque passthrough — not validated at import). */
  tags: unknown;
  /** OKF `timestamp` frontmatter field. */
  docTimestamp: string | null;
  resource: string | null;
  body: string;
  atlasSource: string | null;
  atlasIngestedAt: string | null;
  /** Content-mode review status — preserved across the migration. */
  status: "draft" | "published" | "archived";
  createdAt: string;
  updatedAt: string;
  links: ExportedKnowledgeLink[];
}

/**
 * Exported scheduled-task definition. Run history (`scheduled_task_runs`) is
 * a carve-out; `last_run_at`/`next_run_at` are deliberately absent — the
 * importer recomputes `next_run_at` from the cron expression so the target
 * region's scheduler re-plans on its own clock. `connectionGroupId`/`pluginId`
 * references dangle until the datasource/plugin is re-installed in the target.
 */
export interface ExportedScheduledTask {
  /** Original UUID, preserved for idempotent re-import. */
  id: string;
  ownerId: string;
  name: string;
  question: string;
  cronExpression: string;
  /**
   * Deliberately wider than `DeliveryChannel`: the column is free-form text
   * and a bundle may carry a channel value from a newer/older producer; the
   * importer round-trips it opaquely rather than rejecting on enum drift.
   */
  deliveryChannel: string;
  /** Recipient list (JSONB array, opaque passthrough — not validated at import). */
  recipients: unknown;
  connectionGroupId: string | null;
  /** Same deliberate width as {@link ExportedScheduledTask.deliveryChannel}. */
  approvalMode: string;
  enabled: boolean;
  /** Plugin ownership; null = user-created task. */
  pluginId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Exported durable session memory slot (ADR-0020). Moves because it is
 * long-lived working memory keyed by conversation — the FK resolves against
 * the bundle's conversations (preserved UUIDs). `agent_runs` checkpoints are
 * a carve-out: resume leases are region-local and un-resumable cross-region.
 */
export interface ExportedAgentSessionMemory {
  conversationId: string;
  namespace: string;
  value: unknown;
  createdAt: string;
  updatedAt: string;
}

/**
 * Exported brain fact — tier-2, a reviewed SPO claim (#4767, ADR-0036).
 * Rides inline with its source episode, the way a knowledge link rides with
 * its document: `sourceEpisodeId` is implied by the nesting, which also gives
 * the importer its FK ordering for free (episode, then facts, then edges).
 *
 * Everything that makes the claim trustworthy travels with it — provenance,
 * BOTH grants, review `status`, and all four temporal columns. A brain fact
 * stripped of any of those would arrive in the target region as an
 * unprovenanced, ungated claim, which is worse than not arriving at all.
 *
 * "Both grants" is the part that is easy to get wrong: `visibleTo` gates the
 * CLAIM and {@link ExportedBrainFact.preWideningVisibleTo} gates its
 * ATTRIBUTION (#4836). Carrying only the first would land every widened fact
 * in the target region reading as never-widened — which discloses in full, and
 * is the exact leak #4836 closed, silently restored by a supported path.
 */
export interface ExportedBrainFact {
  /** Original UUID, preserved so edge endpoints survive the import. */
  id: string;
  subject: string;
  predicate: string;
  object: string;
  validFrom: string | null;
  validTo: string | null;
  ingestedAt: string;
  /** The tombstone — preserved, because invalidate-never-delete travels too. */
  invalidatedAt: string | null;
  extractedAt: string | null;
  /** Provenance payload (JSONB, opaque passthrough). Never empty. */
  provenance: unknown;
  /** Content-mode review status — preserved across the migration. */
  status: "draft" | "published" | "archived";
  /** The grant principal set. Never empty (`cardinality > 0` is a CHECK). */
  visibleTo: string[];
  /**
   * The grant this fact held BEFORE publish-time widening, or `null` when it
   * was never widened (#4836).
   *
   * The ACL input for provenance ATTRIBUTION, not a history field. It has to
   * travel because it cannot be reconstructed: the widening UPDATE overwrote
   * `visibleTo` in place, and the import writes `status` verbatim, so the
   * target region never re-publishes the fact and never re-derives it. Absent,
   * every widened fact reads as never-widened in the target and discloses its
   * first episode's actor, channel and timestamp to the whole org.
   *
   * `null` is a legitimate value, not a missing one — a bundle written before
   * this field existed carries no widened facts this can describe, and `null`
   * is what those facts already mean.
   */
  preWideningVisibleTo: string[] | null;
  predicateCardinality: "single" | "multi";
  createdAt: string;
  updatedAt: string;
}

/**
 * Exported brain episode — tier-3 raw evidence, with its extracted facts
 * inline (#4767, ADR-0036).
 *
 * `extractedAt` is preserved rather than reset: re-running extraction in the
 * target region would mint fresh candidates for episodes already reviewed,
 * flooding the target's review queue with work a human has already done.
 */
export interface ExportedBrainEpisode {
  /** Original UUID, preserved so fact and edge references survive. */
  id: string;
  source: string;
  sourceId: string;
  sourceActor: string | null;
  /** Body XOR locator — exactly one is set (a CHECK on the table). */
  body: string | null;
  locator: string | null;
  occurredAt: string | null;
  ingestedAt: string;
  extractedAt: string | null;
  /** The grant principal set. Never empty. */
  visibleTo: string[];
  createdAt: string;
  facts: ExportedBrainFact[];
}

/**
 * Exported brain edge (#4767, ADR-0036). Top-level rather than nested,
 * because an edge can point at a fact or an episode on either side and
 * therefore belongs to neither. The importer writes edges LAST, once every
 * endpoint exists.
 */
export interface ExportedBrainEdge {
  edgeType: "supersedes" | "in-tension-with" | "derives-from" | "provenance";
  /** Exactly one `from*` and one `to*` is set (a CHECK on the table). */
  fromFactId: string | null;
  fromEpisodeId: string | null;
  toFactId: string | null;
  toEpisodeId: string | null;
  createdAt: string;
}

/**
 * Exported audience membership (#4767, ADR-0036). Moves with the workspace
 * because it is what makes an `audience:` grant mean anything: without it,
 * every fact granted to an audience becomes invisible to everyone in the
 * target region — a silent, total loss of access rather than a visible error.
 */
export interface ExportedFactAudienceMember {
  /** WITHOUT the `audience:` prefix — the prefix belongs to the grammar. */
  audienceId: string;
  userId: string;
  source: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Full bundle
// ---------------------------------------------------------------------------

/** Complete export bundle — serialized as a single JSON file. */
export interface ExportBundle {
  manifest: ExportManifest;
  conversations: ExportedConversation[];
  semanticEntities: ExportedSemanticEntity[];
  learnedPatterns: ExportedLearnedPattern[];
  settings: ExportedSetting[];
  /**
   * v2 sections (#4460). Optional on the wire so a v1 bundle still validates;
   * REQUIRED (enforced by the importer) when `manifest.version` is 2, and the
   * importer imports whichever sections are present regardless of version so a
   * producer built against stale types can never silently strand a section.
   */
  dashboards?: ExportedDashboard[];
  knowledgeDocuments?: ExportedKnowledgeDocument[];
  scheduledTasks?: ExportedScheduledTask[];
  agentSessionMemory?: ExportedAgentSessionMemory[];
  /**
   * Company brain sections (#4767, ADR-0036). Same optional-on-the-wire shape
   * as the other v2 sections. Facts nest inside their episode; edges and
   * audience membership are top-level because they reference both classes.
   */
  brainEpisodes?: ExportedBrainEpisode[];
  brainEdges?: ExportedBrainEdge[];
  factAudienceMembers?: ExportedFactAudienceMember[];
}

// ---------------------------------------------------------------------------
// Import result
// ---------------------------------------------------------------------------

/** Summary returned by the import endpoint. */
export interface ImportResult {
  conversations: { imported: number; skipped: number };
  semanticEntities: { imported: number; skipped: number };
  learnedPatterns: { imported: number; skipped: number };
  settings: { imported: number; skipped: number };
  /**
   * v2 sections (#4460) — 0/0 when the bundle carries no v2 sections (the
   * normal v1 case; present sections import regardless of claimed version).
   */
  dashboards: { imported: number; skipped: number };
  knowledgeDocuments: { imported: number; skipped: number };
  scheduledTasks: { imported: number; skipped: number };
  agentSessionMemory: { imported: number; skipped: number };
  /** Company brain (#4767). Facts are counted on their own key, not their episode's. */
  brainEpisodes: { imported: number; skipped: number };
  brainFacts: { imported: number; skipped: number };
  brainEdges: { imported: number; skipped: number };
  factAudienceMembers: { imported: number; skipped: number };
}

// ---------------------------------------------------------------------------
// Cross-region migration phases
// ---------------------------------------------------------------------------

/** Phases of the cross-region data migration lifecycle. */
export const MIGRATION_PHASES = [
  "validating",
  "exporting",
  "transferring",
  "cutting_over",
  "scheduling_cleanup",
  "completed",
  "failed",
] as const;

export type MigrationPhase = (typeof MIGRATION_PHASES)[number];

/** Grace period (in days) before source data is eligible for cleanup. */
export const CLEANUP_GRACE_PERIOD_DAYS = 7;
