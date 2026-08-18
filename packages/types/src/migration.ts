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
 *
 * v3 (#5035, ADR-0037 §8) puts a brain fact's IDENTITY on the wire: the three
 * slot keys and the two comparable values ({@link ExportedBrainFact}). It is a
 * version bump rather than an additive field because the importer's behaviour
 * DIFFERS by version — a v3 fact's keys are carried verbatim, a v1/v2 fact's
 * are computed once at import against the destination's vocabulary — and the
 * discriminator has to be the manifest rather than field presence. Field
 * presence would make a v3 producer that dropped a key indistinguishable from a
 * legacy bundle, and the legacy arm RE-DERIVES: the over-match direction §8
 * exists to refuse. It also DROPS `predicateCardinality`, which #5027 moved to
 * the vocabulary and whose per-row values are LLM guesses.
 *
 * The bundle version bumps exactly once across the M4 arc; #5028 drops the
 * database column and is told not to touch the format.
 *
 * ⚠️ **A version bump is a DEPLOY-ORDERING constraint across regions, and this
 * is the only place it is written down.** A source region that deploys first
 * exports v3 into a destination still running v2 code, which refuses the whole
 * bundle with *"Unsupported bundle version: 3"*. That is the correct
 * fail-loud direction — the alternative is a destination silently dropping
 * fields it does not know — but it means **every destination region must be on
 * the new release before any source region is**, and a cutover attempted in the
 * window fails at the import call rather than corrupting anything. Importers
 * only ever gain versions ({@link SupportedBundleVersion}), so the reverse
 * direction (old bundle, new destination) needs no coordination at all.
 */
export const EXPORT_BUNDLE_VERSION = 3;

/**
 * Bundle versions an importer accepts. v1 = the pre-#4460 four-pillar bundle
 * (conversations, semantic entities, learned patterns, settings) with the
 * newer sections absent. v2 = pre-#5035, so brain facts carry no identity.
 * Type-only so scaffold-bound consumers don't need a new published value
 * symbol.
 */
export type SupportedBundleVersion = 1 | 2 | 3;

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
    /** The curated identity vocabulary's approved edges (#5022, ADR-0037 §6). */
    brainVocabularyEdges?: number;
    brainSlackChannelExclusions?: number;
    /** The warehouse producer's enrolled reach (#5196, ADR-0039). */
    brainEnrollments?: number;
    /** The entity store's snapshot entries (#5043, ADR-0037 §5). */
    brainEntities?: number;
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
   * `null` is a legitimate value, not a missing one. A bundle written before
   * this field existed carries no RECORDED pre-widening grants — the source
   * region had no column to record them in — so facts widened in the
   * #4823-to-0183 window land disclosing. That is the same accepted residual
   * migration 0183's header records, reappearing for cross-region moves, not a
   * new one.
   */
  preWideningVisibleTo: string[] | null;
  /**
   * The claim's identity slot — `alias(lexicalNorm(surface))` (#5019).
   *
   * **v3 and later only, and REQUIRED there** (`null` is a legitimate value: a
   * surface that norms away to nothing has no key, permanently). Absent on a
   * v1/v2 bundle, whose facts are keyed ONCE at import against the
   * destination's post-merge vocabulary.
   *
   * The one place a key is projected to the wire, and the exception is granted
   * by ADR-0037 §8 rather than assumed: *a row-copy path carries keys verbatim.*
   * Re-deriving at the destination fails to OVER-match — a destination alias the
   * source lacks merges imported facts into a slot they never belonged to, and
   * publish then stamps `valid_to` across the merge, irreversibly. Carrying
   * fails to UNDER-match: a key the destination's vocabulary cannot produce
   * collides with nothing until a human curates. Recoverable, so it is the
   * direction to fail in.
   *
   * `keys-not-on-the-wire.test.ts` holds the prohibition everywhere else and
   * names this file as a row-copy site.
   */
  subjectKey?: string | null;
  /** The predicate slot — see {@link ExportedBrainFact.subjectKey}. v3+, required there. */
  predicateKey?: string | null;
  /** The object slot — see {@link ExportedBrainFact.subjectKey}. v3+, required there. */
  objectKey?: string | null;
  /**
   * The object's comparable value — a tagged canonical (`money:USD:499`,
   * `number:499`, `entity:01J…`), the column that can prove DIFFERENCE (#5030).
   *
   * **v3 and later only, and REQUIRED there** (`null` is the `unknown` verdict,
   * a first-class value). It rides the wire, but it does NOT all survive the
   * import: an `entity:`-tagged value is a STORE-LOCAL id, which is non-null and
   * by construction unequal to every id the destination mints for the same real
   * entity — counterfeit positive evidence of difference, strictly worse than
   * the NULL it replaces, because NULL reads as `unknown` and reaches a human
   * while a foreign id reads as `different` and stamps `valid_to` autonomously.
   * The importer nulls those and marks the row `provisional`.
   *
   * Value-typed tags travel verbatim: money-with-currency, number, date, time
   * and bool are region-invariant parses. The TAG is the discriminator, which is
   * why #5030 made it a prefix rather than a guess (`lib/brain/object-cmp.ts`).
   */
  objectCmp?: string | null;
  /**
   * The subject's comparable value (#5032) — see
   * {@link ExportedBrainFact.objectCmp}. v3+, required there.
   *
   * Only a resolved store id can ever reach this column, so in practice EVERY
   * non-null value here is nulled at import. It travels anyway rather than being
   * dropped from the format: the null-out is the IMPORTER's rule, and a bundle
   * that silently omitted the column could not be told apart from one whose
   * source region had no store.
   */
  subjectCmp?: string | null;
  /**
   * @deprecated v1/v2 only. Absent from v3 and IGNORED by the importer.
   *
   * #5027 moved cardinality onto the canonical predicate
   * (`brain_predicate_cardinality`), and the per-row values this field carried
   * are LLM guesses — so carrying them forward would restore a guess as though
   * it were a curated decision. #5028 drops the database column.
   *
   * ⚠️ **Optional rather than REMOVED, and it is still a breaking change for
   * READERS.** A consumer that *writes* the field keeps compiling; one that
   * *reads* it does not, because the type widened from `"single" | "multi"` to
   * `… | undefined` — a direct assignment or an exhaustive `switch` now fails
   * under strict mode. Keeping the declaration buys the write side and the
   * migration path, not source compatibility outright, so the changelog line is
   * *"reading `predicateCardinality` now requires handling `undefined`"*. (An
   * earlier version of this comment justified it as *"a consumer built against
   * an older `@useatlas/types` keeps compiling"* — that consumer is not
   * resolving this package at all, so the sentence described nobody.)
   */
  predicateCardinality?: "single" | "multi";
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

/** The claim slot an alias edge governs (ADR-0037 §6). */
export type ExportedVocabularySlotPosition = "subject" | "predicate" | "object";

/**
 * An approved alias edge — the curated identity vocabulary's durable half
 * (#5022, ADR-0037 §6/§8).
 *
 * The human's decision, and the reason the vocabulary moves at all: the keys on
 * every exported fact are `alias(lexicalNorm(surface))`, so a workspace that
 * arrived without its vocabulary would keep keys nothing in the target region
 * can explain or undo. `stays` would delete these at source after the grace
 * period (#4458), destroying curated decisions and stranding the keys in one
 * move.
 *
 * POSITION-SCOPED, and the position travels with the edge. Dropping it would
 * collapse three independent forests into one at the import, which is the exact
 * shape ADR-0037 §6 rules out: a predicate approval re-keying subjects.
 *
 * Both norms are LEXICAL NORMS, not surfaces. Not a key column — no read
 * surface may project `subject_key`/`predicate_key`/`object_key`
 * (`keys-not-on-the-wire.test.ts`), and this is the vocabulary that PRODUCES
 * them, which ADR-0037 §8 exports by name.
 */
export interface ExportedBrainVocabularyEdge {
  slotPosition: ExportedVocabularySlotPosition;
  /** The norm aliased away. */
  fromNorm: string;
  /** The norm it was approved onto. */
  toNorm: string;
  /** The approver, or `null` for an auto-approved warehouse-derived edge. */
  approvedBy: string | null;
  approvedAt: string;
}

/**
 * One Slack channel an admin removed from the company brain's ingest scope
 * (#5203, ADR-0036).
 *
 * ⚠️ THE EXCLUSION HALF ONLY. `brain_slack_channel` also carries OBSERVED state
 * — `is_member`, `name`, `is_private`, the health-probe verdicts — and none of
 * it travels. All of it is re-derived from `users.conversations` on the target's
 * first sync, and carrying a stale membership would have the destination poll
 * channels its bot may not be in.
 *
 * What cannot be re-derived is the DECISION. Scope in the target is "every
 * channel the bot is in, minus exclusions", so an exclusion that failed to
 * travel does not degrade the destination — it makes the destination ingest a
 * channel a human took out of scope. That is over-DISCLOSURE, the
 * unrecoverable direction, and it is why this section exists rather than being
 * deferred like `brain_vocabulary_proposal`'s rejection memory (whose cost is
 * under-supersession, which is recoverable by re-authoring).
 */
export interface ExportedBrainSlackChannelExclusion {
  /** The Slack channel id — `^[CG][A-Z0-9]{2,}$`, matching the table's CHECK. */
  channelId: string;
  excludedAt: string;
  /** Why, as the admin wrote it. `null` when they gave no reason. */
  exclusionReason: string | null;
  /** Who excluded it. Never empty — the table's CHECK refuses an unattributed row. */
  excludedBy: string;
}

/**
 * A workspace whose pre-#5203 Slack channel scope has not yet been reconciled
 * against live bot membership (#5203).
 *
 * Present only for a workspace that migrates in the window between upgrading
 * and its first sync. Carried for the same reason the exclusions are: while
 * `reconciledAt` is null the captured allowlist IS the scope, so a bundle that
 * dropped it would land the workspace in the destination looking like one that
 * never had a `slack-history` install — i.e. promoted to "every channel the bot
 * is in". The narrowing intent, one step earlier than an exclusion.
 */
export interface ExportedBrainSlackIngestScope {
  /** The retired installs' union. MAY BE EMPTY — empty means "ingest nothing yet". */
  legacyChannels: string[];
}

/**
 * One `(entity, dimension)` pair a human enrolled as the tier-1 warehouse
 * producer's reach (#5196, ADR-0039).
 *
 * The whole row travels — there is no observed half to leave behind, because
 * nothing derives an enrollment. It is a deliberate human act end to end, which
 * is what puts it in the same asset class as `ExportedBrainVocabularyEdge`.
 *
 * ⚠️ **`entity` is a semantic-layer NAME, and it lands unresolved.** It is not a
 * `semantic_entities` id and is not checked against the destination's semantic
 * layer at import: a workspace's entities travel on the same bundle, and an
 * enrollment naming one that failed to travel is a pair the destination's
 * producer simply never matches — the fail-closed direction, and visible on the
 * enrollment surface beside the entity list. Refusing the row instead would
 * discard a human decision over an ordering accident.
 */
export interface ExportedBrainEnrollment {
  entity: string;
  /**
   * The connection group the entity is published under, or `null`/absent for the
   * flat scope (#5286).
   *
   * OPTIONAL on the wire, on `naming`'s precedent and for its reason: a bundle
   * written before enrollment carried a group has none, and the flat scope is
   * that bundle's truth rather than a guess about it. It travels because it is
   * half the row's identity now — dropped, a multi-group source region's two
   * enrollments would collide into one at the destination, and the survivor
   * would be whichever the import reached first.
   *
   * ⚠️ It is NOT re-resolved at the destination. A group id is a
   * `connection_group_id` in the SOURCE region's internal DB, and a region
   * migration carries the datasource installs that mint them — so the id means
   * the same thing on both sides, and inferring a "matching" group by name would
   * be the machine picking which of two entities a human meant.
   */
  connectionGroupId?: string | null;
  /** The bare dimension/measure/metric name — ADR-0037 §4's emission contract. */
  dimension: string;
  enrolledAt: string;
  /** Who enrolled it. Never empty — the table's CHECK refuses an unattributed row. */
  enrolledBy: string;
  /** Why, as the admin wrote it. `null` when they gave no reason. */
  note: string | null;
  /**
   * Whether this dimension names its entity's canonical surface (#5043).
   *
   * It travels because it is the same kind of human decision the row already is,
   * and because losing it is silent in the ADR-0039 way: the destination's store
   * writes no entry, every lookup abstains, and the enrollment list still shows
   * the pair as live. OPTIONAL on the wire, so a v3 bundle written before #5043
   * imports as `false` — which is the pre-#5043 truth rather than a guess.
   */
  naming?: boolean;
}

/**
 * One entity-store entry — a snapshot of one warehouse row (#5043, ADR-0037 §5).
 *
 * ## Why it travels rather than being re-derived
 *
 * It looks derived, and `brain_vocabulary_target` — genuinely derived — stays.
 * The difference is what the derivation needs. A closure is a pure function of
 * edges that travel on the same bundle, so the destination can rebuild it
 * immediately. An entry is a function of a WAREHOUSE READ, which the destination
 * cannot repeat until its datasource credentials are re-established and a human
 * re-runs the producer.
 *
 * ⚠️ **The ids do NOT travel on the facts, and it would be wrong to say they do.**
 * `regionPortableComparable` classifies the `entity:` tag `store-local`, so the
 * importer NULLS `subject_cmp`/`object_cmp` on every entity-valued row — a
 * foreign id there is counterfeit positive evidence of DIFFERENCE, which is the
 * one direction that stamps `valid_to` without a human.
 *
 * What these entries buy the destination is a BRIDGE: they resolve surfaces by
 * name from the moment the bundle lands until the destination has warehouse
 * credentials again and a human re-runs the producer — the window in which
 * nothing else can. `stays` is also DELETION (#4458), so the source's copy would
 * go too.
 *
 * ⚠️ **The bridge has a COST, and an earlier version of this comment denied it.**
 * It said the first producer run replaces these ids "harmlessly, because no fact
 * carries the old ones". True at the moment of import — the importer NULLs an
 * entity-valued `_cmp` — and false for the whole window the entries exist to
 * serve: extraction consults the store, so every fact extracted during the
 * bridge carries the imported, SOURCE-workspace id. The destination's first
 * producer run then retires those ids for freshly minted ones.
 *
 * What that costs, stated rather than assumed: at `subject_cmp` a proven
 * difference SUPPRESSES every consumer, so bridge-window facts and post-run
 * facts about one warehouse row quietly stop corroborating — unmatched
 * corroboration, which is the recoverable direction and is invisible. At
 * `object_cmp` a proven difference is positive evidence, and whether that can
 * reach a `valid_to` stamp for this pair is NOT traced here and is not asserted
 * either way (#5233).
 *
 * ⚠️ And the replacement is keyed on `(workspace_id, entity)`. If the two
 * regions' semantic layers name the entity differently, the imported rows are
 * never deleted, both sets go live, and every shared canonical norm is poisoned
 * — the store then resolves NOTHING for that entity until someone intervenes.
 * The run report's `entityEdges.ambiguous` is what makes that visible — on every arm
 * that got far enough to count it, which includes a FAILED pass that reached the
 * `proposing` phase. Only a failure at `store-read` or `planning` reports no
 * `ambiguous`, and the condition stays invisible on exactly those runs (#5277 folded
 * the old flat `entityEdgesAmbiguous` into the outcome union). The reaper (#5233) is
 * what fixes the condition itself.
 *
 * The failure direction if it were dropped is ADR-0039's invisible one: the
 * cutover reports clean, the store resolves nothing, and every test stays green.
 */
export interface ExportedBrainEntity {
  /** `wh_<sha256>` — globally unique, and the value already on `subject_cmp`. */
  entityId: string;
  /** The semantic-layer entity name this row came from. */
  entity: string;
  /** The primary key's surface, verbatim. */
  keySurface: string;
  /** `lexicalNorm(keySurface)`. Carried, not recomputed — see the importer. */
  keyNorm: string;
  /** The naming dimension's value, verbatim — the human surface. */
  canonicalSurface: string;
  /** `lexicalNorm(canonicalSurface)`. */
  canonicalNorm: string;
  /** When the snapshot that produced this entry was taken. */
  snapshotAt: string;
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
  /**
   * The curated identity vocabulary's APPROVED EDGES (#5022, ADR-0037 §6/§8).
   * Same optional-on-the-wire shape as the sections above.
   *
   * The derived closure (`brain_vocabulary_target`) has no section here on
   * purpose: §8 has the import union the approved edges and RECOMPUTE the
   * closure, so carrying it would ship a relation the importer must ignore —
   * a source closure restored into a destination that already holds a
   * vocabulary is a closure of neither.
   */
  brainVocabularyEdges?: ExportedBrainVocabularyEdge[];
  /**
   * The company brain's Slack ingest-scope decisions (#5203). Same
   * optional-on-the-wire shape as the sections above.
   *
   * Both are NARROWINGS, which is why they travel while the observed membership
   * beside them does not: losing either widens what the destination ingests
   * past what a human agreed to.
   */
  brainSlackChannelExclusions?: ExportedBrainSlackChannelExclusion[];
  /** Absent unless the workspace migrated mid-reconcile — see the type. */
  brainSlackIngestScope?: ExportedBrainSlackIngestScope;
  /**
   * The warehouse producer's enrolled reach (#5196, ADR-0039). Same
   * optional-on-the-wire shape as the sections above.
   *
   * A NARROWING like the Slack sections, but its loss fails in the opposite
   * direction and that is why it is easy to under-rate: losing an exclusion
   * makes the destination ingest MORE than a human agreed to, while losing an
   * enrollment makes its producer reach NOTHING. The second is silent — an
   * unenrolled workspace and a working one are indistinguishable from inside the
   * code — so it travels for the same reason, discovered the hard way.
   */
  brainEnrollments?: ExportedBrainEnrollment[];
  /**
   * The entity store's snapshot entries (#5043, ADR-0037 §5). Same
   * optional-on-the-wire shape as the sections above.
   */
  brainEntities?: ExportedBrainEntity[];
}

// ---------------------------------------------------------------------------
// Import result
// ---------------------------------------------------------------------------

/**
 * One refused alias edge, carried back to the SOURCE region (#5112).
 *
 * ## Why this is on the wire at all
 *
 * The refused edge is a HUMAN's approved decision the destination is dropping,
 * and #5036 made the target region's `log.warn` the entire recovery path. But
 * the SOURCE region is the one that cuts over and schedules the cleanup which
 * DELETEs its own `brain_vocabulary_edge` rows after the grace period — so the
 * party owning the irreversible act held only a COUNT, while the record that
 * would let anyone undo it lived in another region's log retention, outliving
 * the data by only as long as that retention.
 *
 * These fields are exactly the target-side warn's payload, so one shape carries
 * the recovery information whether it is read out of a log line or out of the
 * source's `region_migrations.vocabulary_refusals` column.
 *
 * ⚠️ **FOREIGN INPUT on the source side.** This is another region's JSON and
 * possibly another region's BUILD: a target predating #5112 omits the field
 * entirely, and nothing about the transport guarantees the shape. `migrate.ts`
 * screens every entry before it writes one into its own database.
 *
 * ⚠️ **BOUNDED, and the bound is deliberately NOT exported from this package.**
 * The producer caps the array; `refused` is always the true total, so a
 * `refusalDetails` shorter than `refused` is what says the list was truncated.
 * The number itself lives with the producer
 * (`VOCABULARY_REFUSAL_DETAIL_CAP` in `packages/api/src/lib/brain/vocabulary.ts`)
 * because a value export here is a RUNTIME symbol, and `packages/api/src` is
 * copied into the scaffold template — which installs the published version of
 * this package and cannot see a symbol added in the same commit. That constant's
 * docstring carries the full diagnosis. Consumers should read the comparison, not
 * the constant, which we reserve the right to change.
 */
export interface VocabularyRefusalDetail {
  /** The slot position the edge was approved at, verbatim from the source row. */
  slotPosition: string;
  fromNorm: string;
  toNorm: string;
  /** `null` is an auto-approved edge, not an unknown one. */
  approvedBy: string | null;
  /** The SOURCE region's approval timestamp, carried verbatim (never re-stamped). */
  approvedAt: string;
  /** Which of the four rules refused it — `already-aliased`, `would-cycle`, … */
  refusal: string;
  /**
   * What the DESTINATION holds for `fromNorm` instead, or `null` for the arms
   * that have no conflicting edge.
   *
   * `null` rather than absent, on the target-side warn's reasoning: a missing key
   * and a key whose value is "there is no conflicting edge" read identically in
   * a log aggregator or a JSONB query, and only one of them is true.
   */
  existingTarget: string | null;
  /** The refusal's human-readable reason, as the destination phrased it. */
  reason: string;
}

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
  /**
   * The curated identity vocabulary (#5022). Counted on the EDGES — the
   * decisions — because the closure is recomputed rather than imported, so a
   * count of its rows would report work the bundle did not carry.
   *
   * THE ONLY SECTION WITH A THIRD COUNTER, and the asymmetry is the point
   * (#5036, ADR-0037 §8 §4). Everywhere else `skipped` means "the destination
   * already holds this row", because a conversation present in both regions is
   * the same conversation. An alias edge is a HUMAN REVIEW DECISION, and two
   * regions can hold contradictory ones legitimately — so the import has two
   * outcomes here that are not the same event at all:
   *
   *   - `skipped` — already approved in this region onto the SAME target.
   *     Benign, and exactly what an idempotent re-import looks like from the
   *     inside.
   *   - `refused` — the arriving edge would have closed a cycle or taken a
   *     second parent, so a source-region human's approved decision was NOT
   *     applied. Every one is logged with enough of the source row to re-author
   *     it by hand, and that log is the entire recovery path.
   *
   * Reporting them as one number would restore the conflation the slice exists
   * to remove: `skipped: 2` cannot distinguish a clean re-import from two
   * discarded approvals, and only one of those is something to act on.
   *
   * REQUIRED, like every other counter, on the established reading that this
   * type describes what THIS region answers. A target predating #5036 omits it
   * and refuses nothing (it skips instead); consumers that read a foreign
   * region's response model that with their own cross-version type, as
   * `migrate.ts` and `cli/migrate-import.ts` already do for whole sections.
   */
  brainVocabularyEdges: {
    imported: number;
    skipped: number;
    refused: number;
    /**
     * The refused edges themselves, capped by the producer (#5112).
     *
     * The cap is NOT a `{@link}` to a symbol in this package, deliberately — see
     * {@link VocabularyRefusalDetail}. Read the bound as the comparison
     * `refusalDetails.length < refused`, which is what says the list was
     * truncated, rather than as a number this package publishes.
     *
     * THE ONLY SECTION THAT RETURNS PAYLOADS RATHER THAN COUNTS, and the reason
     * is the same asymmetry that earned `refused` its own counter one field up:
     * every other outcome in this type is re-derivable. A skipped conversation
     * is still in both regions; a refused alias edge is a human review decision
     * the destination declined, and the only copy that survives a cutover is the
     * SOURCE's — for as long as the grace period lasts.
     *
     * REQUIRED, on `refused`'s reasoning: this type describes what THIS region
     * answers, and an optional field is one a producer can quietly stop
     * populating without the `_SchemaMatchesWireType` pin in `admin-migrate.ts`
     * noticing (it cannot see an optional NESTED member). A target predating
     * #5112 omits it, and `migrate.ts` models a foreign region's response with
     * its own cross-version type, exactly as it already does for `refused`.
     *
     * `[]` means NONE when `refused === 0`. When `refused > 0` it means the
     * target answered without payloads — an older build — which is not the same
     * as "nothing to recover", and the source's disclosure says so.
     */
    refusalDetails: VocabularyRefusalDetail[];
  };
  brainSlackChannelExclusions: { imported: number; skipped: number; refused: number };
  /**
   * The warehouse producer's enrolled reach (#5196, ADR-0039).
   *
   * TWO counters, not three, and the contrast with the pair above is the reason
   * to state it. An alias edge earns `refused` because two regions can hold
   * CONTRADICTORY approved decisions — a second parent, a cycle — so a discarded
   * one is an event someone must act on. An enrollment has no such conflict to
   * have: the pair is the whole key, both regions' rows are human acts of the
   * same kind, and a pair enrolled in both is the same decision twice. So the
   * merge is a union, and `skipped` means exactly what it means everywhere else.
   */
  brainEnrollments: {
    imported: number;
    skipped: number;
    /**
     * Rows whose arriving `naming` flag was NOT applied (#5043).
     *
     * A third counter because `imported + skipped` structurally cannot express
     * it: the row landed (or was already here), and only the human decision
     * riding on it was declined. Without it the drop is invisible — the
     * destination's entity store writes no entry for that entity, every lookup
     * abstains, and the enrollment list still shows the pair as live, which is
     * the ADR-0039 shape where a loss looks exactly like a working system.
     *
     * NOT a `refused` in `REFUSAL_ACCOUNTING`'s sense, and deliberately named
     * differently: a shortfall here does not abort a cutover, because the pair
     * itself did arrive.
     */
    namingDropped: number;
    /**
     * Rows where an arriving `naming` flag WAS applied to a pair this region
     * already held unnamed (#5043).
     *
     * The positive twin of {@link namingDropped}, and it exists for the same
     * reason: that write makes the destination's next producer run re-key every
     * fact about the entity, and `imported + skipped` reports it as `skipped` —
     * which everywhere else means "this region already holds it". It holds the
     * PAIR; it did not hold the DECISION.
     */
    namingApplied: number;
  };
  /**
   * The entity store's snapshot entries (#5043, ADR-0037 §5).
   *
   * TWO counters, on `brainEnrollments`' reasoning and not `brainVocabularyEdges`'.
   * The `entity_id` is a digest of `(workspace, entity, primary key)`, so two
   * regions holding the same id are holding the same warehouse row — there is no
   * contradictory decision to refuse. `skipped` is a destination that already
   * snapshotted that row.
   *
   * ⚠️ **`DO NOTHING`, so an OLDER arriving snapshot never overwrites a newer
   * local one.** The alternative reading — last-writer-wins on `snapshot_at` —
   * would let a bundle taken last week re-key the destination's corpus onto a
   * name that has since changed, which is ADR-0037 §5's workspace-wide blast
   * radius arriving from a direction nobody is watching.
   */
  brainEntities: { imported: number; skipped: number };
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
