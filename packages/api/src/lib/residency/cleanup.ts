/**
 * Region-migration Phase 4 — source-region data cleanup (#4458).
 *
 * After a workspace's region migration completes and the 7-day grace period
 * elapses, the workspace's data must actually be DELETED from the source
 * region — the residency/PII promise in `data-residency.mdx`. This module is
 * the destructive half: `runSourceCleanupSweep` (driven by the
 * `region_migration_source_cleanup` periodic fiber in `effect/layers.ts`)
 * consumes `getCleanupDueMigrations()` and removes the org's rows.
 *
 * ## Deletion scope — derived from the bundle-scope registry, never hand-listed
 *
 * The authoritative per-table moves/stays decision is
 * `BUNDLE_TABLE_DECISIONS` in `bundle-scope.ts` (#4460). Cleanup deletes the
 * org's rows in exactly `EXPORTED_TABLES ∪ STAYS_TABLES`:
 *
 * - `exported` tables are safe to delete because their rows already moved to
 *   the target region in the export bundle;
 * - `stays` tables are region-local residue (caches, history, region-bound
 *   ciphertext) that the registry explicitly marks "NOT retained";
 * - `platform` tables are never touched — they are operator/billing/auth-spine
 *   state with no per-workspace residency dimension (`region_migrations`
 *   itself, the Stripe spine, …).
 *
 * `CLEANUP_TABLE_RULES` below maps each in-scope table to its org-scoping
 * predicate (most tables carry `org_id`/`workspace_id` directly; a few scope
 * through a parent table, and two use an `expression` — `chat_cache` because it
 * has no org column at all, `brain_vocabulary_target` because it needs the
 * earlier phase). The
 * tripwire test (`__tests__/cleanup.test.ts`) asserts the rule set equals the
 * registry-derived scope exactly AND validates every referenced column
 * against the Drizzle schema — so a new table cannot silently miss cleanup,
 * and a platform table cannot silently enter it.
 *
 * ## Safety & retry contract
 *
 * - Each migration's cleanup runs in ONE transaction: every DELETE plus the
 *   `source_cleaned_at` stamp commit together, so a partial failure rolls
 *   back to "still due" and the next sweep retries — idempotent by
 *   construction (DELETEs of already-deleted rows are no-ops).
 * - The row is re-checked under `FOR UPDATE` inside the transaction, so two
 *   instances can't double-clean (the loser sees the stamp and skips).
 * - Cutover guard: if the `organization` row still homes the workspace in
 *   the source region, the delete would destroy LIVE data — the cleanup is
 *   refused and permanently resolved as skipped (audited). An organization
 *   row whose `region` is NULL/unreadable is ambiguous and fails CLOSED:
 *   nothing is deleted, nothing is stamped, the row stays due (re-warned
 *   every sweep). The cleanup never
 *   touches `status`/`region_updated`, so the unsafe-retry guard
 *   (`resetMigrationForRetry`) is unaffected.
 * - Region identity guard: when this process knows its region
 *   (`getApiRegion()`), it only cleans migrations whose `source_region`
 *   matches — a misrouted row is warned about and left alone.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { hasInternalDB, getInternalDB } from "@atlas/api/lib/db/internal";
import { BUNDLE_TABLE_DECISIONS } from "./bundle-scope";
import { getCleanupDueMigrations, REFUSAL_DISCLOSURE } from "./migrate";
import type { PayloadCarryingRefusalSection } from "./migrate";
import { getApiRegion } from "./misrouting";

const log = createLogger("region-migration-cleanup");

// ---------------------------------------------------------------------------
// The delete-time refusal audit (#5112, extended to all three sections by #5557)
// ---------------------------------------------------------------------------

/**
 * One refusal section's delete-time accounting: which two `region_migrations`
 * columns hold it, and what the audit event and the warn call them.
 *
 * `sourceTable`, `decisions` and the payload column itself are NOT restated here —
 * they come from `REFUSAL_DISCLOSURE`, which the pre-cutover disclosure in
 * `migrate.ts` already reads. Those two surfaces describe the SAME loss seven days
 * apart, so a second spelling of "which table held it" or "which column holds the
 * last copy" is a pair that can disagree, and an operator reading both would get two
 * different answers about where to look.
 *
 * `subject` IS local, and deliberately: the disclosure speaks before the fact
 * ("curated alias edges" the target refused) while this speaks after it ("refused
 * alias edges" whose rows are now gone). Same loss, different tense — sharing the
 * phrase would make one of the two sentences read wrong.
 */
interface DeleteTimeRefusalSection {
  /** The wire section, and the key into `REFUSAL_DISCLOSURE`. */
  readonly section: PayloadCarryingRefusalSection;
  /** What the warn calls the loss, phrased for the past tense. */
  readonly subject: string;
  /** `region_migrations` column holding the TRUE refused count (NULL = unknown). */
  readonly countColumn: string;
  /** Alias the derived SELECT gives this section's `jsonb_array_length`. */
  readonly recordedColumn: string;
  /** Audit-event/warn key for the count. */
  readonly countKey: string;
  /** Audit-event/warn key for how many payloads actually landed. */
  readonly recordedKey: string;
}

/**
 * ⚠️ THE AUDIT KEYS ARE PART OF THE SHIPPED SURFACE, not derived from the column
 * names. `vocabularyEdgesRefused` and `vocabularyRefusalsRecorded` have been on this
 * event since #5112 and an operator's saved log query matches on them, so they are
 * written out rather than camel-cased from SQL at runtime — a naming helper would
 * make renaming them look like a refactor.
 */
const DELETE_TIME_REFUSAL_SECTIONS = [
  {
    section: "brainVocabularyEdges",
    subject: "refused alias edges",
    countColumn: "vocabulary_edges_refused",
    recordedColumn: "vocabulary_refusals_recorded",
    countKey: "vocabularyEdgesRefused",
    recordedKey: "vocabularyRefusalsRecorded",
  },
  {
    section: "brainVocabularyProposals",
    subject: "refused alias-proposal decisions",
    countColumn: "vocabulary_proposals_refused",
    recordedColumn: "vocabulary_proposal_refusals_recorded",
    countKey: "vocabularyProposalsRefused",
    recordedKey: "vocabularyProposalRefusalsRecorded",
  },
  {
    section: "brainPredicateCardinalities",
    subject: "refused predicate-cardinality decisions",
    countColumn: "predicate_cardinalities_refused",
    recordedColumn: "predicate_cardinality_refusals_recorded",
    countKey: "predicateCardinalitiesRefused",
    recordedKey: "predicateCardinalityRefusalsRecorded",
  },
] as const satisfies readonly DeleteTimeRefusalSection[];

/**
 * Completeness pin: every payload-carrying section has a delete-time reader.
 *
 * The state this issue (#5557) exists to fix is precisely the other side of it —
 * #5533 shipped two payload columns whose only reader was the write that filled
 * them, so an operator was warned about unexported edge refusals and told nothing
 * about a refused vocabulary decision losing its last copy's context in the same
 * sweep. That gap was invisible to the type system and survived as a follow-up
 * issue; a fourth section now cannot repeat it silently.
 *
 * ⚠️ `as const satisfies` on the array above is what makes this able to go red — a
 * `readonly DeleteTimeRefusalSection[]` annotation would widen `section` back to the
 * full union and this check would be vacuously true.
 */
type UncoveredRefusalSection = Exclude<
  PayloadCarryingRefusalSection,
  (typeof DELETE_TIME_REFUSAL_SECTIONS)[number]["section"]
>;
const _everyPayloadSectionAudited: [UncoveredRefusalSection] extends [never] ? true : never = true;
void _everyPayloadSectionAudited;

/**
 * The refusal COLUMN LIST of the eligibility re-check, derived from the table above.
 *
 * Not a SELECT — a comma-joined list of column expressions spliced into one, which is
 * why it is not named for a statement it cannot be used as on its own.
 *
 * Derived rather than written out, because a section listed in the table but missing
 * from the SELECT reads back `undefined` — which this module's `typeof === "number"`
 * narrowing turns into "count unknown, nothing recorded", i.e. silence. That is the
 * same silence the issue is about, reintroduced one layer down and with no symptom.
 *
 * Interpolation is safe by construction: every fragment is a literal from
 * `DELETE_TIME_REFUSAL_SECTIONS`, and no caller-supplied value reaches this string.
 * The migration id stays a bound `$1`.
 *
 * ⚠️ `COALESCE(jsonb_array_length(…), 0)` folds "column NULL" and "empty array"
 * together on purpose — see `jsonbPayload` in `migrate.ts`. Both mean "no payload is
 * recoverable from this row", which is one operator sentence, not two.
 */
const REFUSAL_AUDIT_COLUMNS = DELETE_TIME_REFUSAL_SECTIONS.flatMap((s) => [
  s.countColumn,
  `COALESCE(jsonb_array_length(${REFUSAL_DISCLOSURE[s.section].column}), 0) AS ${s.recordedColumn}`,
]).join(",\n              ");

/** One section's two numbers as read off the locked row. */
interface SectionRefusalReading {
  /**
   * The target's true refused count, or `null` for UNKNOWN — a row written before
   * the column's migration, or a source build that never asked. Kept as `null`
   * rather than coerced to `0`, because `0` is a positive claim that nothing was
   * refused and this column cannot make it for those rows.
   */
  readonly refused: number | null;
  /** How many payloads are actually on this row. `0` IS a claim — see the SELECT. */
  readonly recorded: number;
}

function readSectionRefusals(
  row: Record<string, unknown>,
  section: DeleteTimeRefusalSection,
): SectionRefusalReading {
  const refused = row[section.countColumn];
  const recorded = row[section.recordedColumn];
  return {
    refused: typeof refused === "number" ? refused : null,
    recorded: typeof recorded === "number" ? recorded : 0,
  };
}

/**
 * The three-state recovery sentence, per section (#5112's shape, generalized).
 *
 * ⚠️ THREE MESSAGES, because there are three states and only one of them can
 * honestly say "re-author them from this row". Round 1 of #5112's review caught a
 * single unconditional message that promised the payloads whether or not any had
 * been recorded — the worst possible moment to be wrong, since it fires exactly when
 * the originals stop existing. Generalizing it to three sections keeps that split
 * per section rather than across their sum: a migration that recorded every edge
 * payload and no cardinality payload is COMPLETE for one and EMPTY for the other,
 * and a summed verdict would report "partial" and send the operator to a column that
 * holds nothing for the section they are chasing.
 */
function refusalRecoverySentence(
  section: DeleteTimeRefusalSection,
  refused: number,
  recorded: number,
): string {
  const column = `region_migrations.${REFUSAL_DISCLOSURE[section.section].column}`;
  if (recorded === 0) {
    return (
      "NO recovery payload was recorded for this migration (the target region's build " +
      "predated the payload contract, or every entry it sent was unreadable), so the " +
      "target region's own log is the only surviving copy — search it for this " +
      "workspace's refusal lines."
    );
  }
  if (recorded < refused) {
    return (
      `Only ${recorded} of the ${refused} recovery payloads are on this migration's ` +
      `${column} (platform-classified, so this sweep never touches it); the remainder ` +
      "exist only in the target region's log."
    );
  }
  return (
    `The recovery payloads are all on this migration's ${column} (platform-classified, ` +
    "so this sweep never touches it); re-author them there."
  );
}

/**
 * Sweep cadence for the `region_migration_source_cleanup` fiber. Hourly is
 * plenty against a 7-day grace period; the worst-case delay between "grace
 * elapsed" and "residue deleted" is one interval.
 */
export const SOURCE_CLEANUP_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** Structured audit event, same shape as `logMigrationEvent` in migrate.ts. */
function logCleanupEvent(
  event: string,
  migrationId: string,
  details: Record<string, unknown>,
): void {
  log.info({ event, migrationId, ...details }, `Migration audit: ${event}`);
}

// ---------------------------------------------------------------------------
// Per-table scoping rules
// ---------------------------------------------------------------------------

/** How a table's rows are attributed to the migrated org for deletion. */
export type CleanupRule =
  /** The table carries the org id directly in `column`. */
  | { readonly kind: "column"; readonly column: string }
  /**
   * The table scopes through a parent: delete rows whose `fkColumn` matches
   * a `parentTable.id` owned by the org. Parent-scoped deletes run BEFORE
   * the direct-column phase (the parent rows must still exist for the
   * subquery — load-bearing for `slack_threads`, which has no FK cascade).
   */
  | {
      readonly kind: "parent";
      readonly fkColumn: string;
      readonly parentTable: string;
      readonly parentColumn: string;
    }
  /** SQL predicate over the row with `$1` = the org id (chat_cache JSONB). */
  | { readonly kind: "expression"; readonly predicate: `${string}$1${string}` }
  /** No org dimension exists — nothing is attributable; reason required. */
  | { readonly kind: "none"; readonly reason: string };

/**
 * The tables the cleanup is allowed to touch, derived at the TYPE level from
 * the bundle-scope registry: every non-`platform` decision key. The
 * `satisfies` on `CLEANUP_TABLE_RULES` below then makes both drift
 * directions a compile error — a new `exported`/`stays` table in
 * `BUNDLE_TABLE_DECISIONS` with no cleanup rule fails to type-check, and a
 * `platform` table added here is an excess property. The runtime tripwire
 * test keeps the half the type system can't see (column names vs the live
 * Drizzle schema).
 */
type CleanupScopedTable = {
  [K in keyof typeof BUNDLE_TABLE_DECISIONS]: (typeof BUNDLE_TABLE_DECISIONS)[K]["decision"] extends "platform"
    ? never
    : K;
}[keyof typeof BUNDLE_TABLE_DECISIONS];

/**
 * Org-scoping rule for every table cleanup is allowed to touch — keyed to
 * match `EXPORTED_TABLES ∪ STAYS_TABLES` exactly (compile-time via
 * `CleanupScopedTable`; re-pinned by the tripwire test). Column/table names
 * are static registry literals, validated against the Drizzle schema by the
 * tripwire.
 */
export const CLEANUP_TABLE_RULES = {
  // ── Exported pillars (already moved — delete the source copy) ────────────
  conversations: { kind: "column", column: "org_id" },
  messages: {
    kind: "parent",
    fkColumn: "conversation_id",
    parentTable: "conversations",
    parentColumn: "org_id",
  },
  semantic_entities: { kind: "column", column: "org_id" },
  learned_patterns: { kind: "column", column: "org_id" },
  // Platform-scoped settings rows have org_id NULL and are never matched.
  settings: { kind: "column", column: "org_id" },
  dashboards: { kind: "column", column: "org_id" },
  dashboard_cards: {
    kind: "parent",
    fkColumn: "dashboard_id",
    parentTable: "dashboards",
    parentColumn: "org_id",
  },
  dashboard_user_drafts: {
    kind: "parent",
    fkColumn: "dashboard_id",
    parentTable: "dashboards",
    parentColumn: "org_id",
  },
  knowledge_documents: { kind: "column", column: "workspace_id" },
  knowledge_links: {
    kind: "parent",
    fkColumn: "source_document_id",
    parentTable: "knowledge_documents",
    parentColumn: "workspace_id",
  },
  scheduled_tasks: { kind: "column", column: "org_id" },
  agent_session_memory: { kind: "column", column: "org_id" },
  // Company brain (#4767, ADR-0036). Facts are scoped THROUGH their episode
  // rather than by their own workspace_id — not for scoping but for PHASE:
  // `brain_facts.source_episode_id` was the first RESTRICT FK among the in-scope
  // tables (#5022 added a second, on the vocabulary closure), so the facts must
  // be gone before the column phase deletes the
  // episodes, or the sweep fails outright on any workspace that has a brain.
  //
  // The two predicates select the same rows because a composite FK
  // (`fk_brain_facts_episode`) makes a fact and its episode share a workspace
  // at rest — without that constraint this rule would silently leave residue
  // behind, which is a residency-deletion promise quietly broken.
  //
  // Edges CASCADE from both endpoints, so the explicit DELETE is usually
  // redundant; the rule is kept so the registry stays a complete map of every
  // workspace-scoped table.
  brain_facts: {
    kind: "parent",
    fkColumn: "source_episode_id",
    parentTable: "brain_episodes",
    parentColumn: "workspace_id",
  },
  brain_episodes: { kind: "column", column: "workspace_id" },
  brain_edges: { kind: "column", column: "workspace_id" },
  fact_audience_member: { kind: "column", column: "workspace_id" },
  // The curated identity vocabulary's approved edges (#5022, ADR-0037 §6).
  // Column-scoped, and safe in the column phase only because its one dependant
  // — `brain_vocabulary_target`, a RESTRICT FK — is deleted in the earlier
  // phase; see its rule below.
  brain_vocabulary_edge: { kind: "column", column: "workspace_id" },
  // The Slack ingest scope (#5203). Plain column rules — no FK in either
  // direction, and no ordering constraint between them: `brain_slack_channel` is
  // keyed `(workspace_id, channel_id)` and `brain_slack_ingest_scope` on
  // `workspace_id` alone, with nothing referencing either. Both are `exported`,
  // so by the #4458 contract the source's rows go after the grace period and the
  // decisions they carry live on in the target's copy.
  brain_slack_channel: { kind: "column", column: "workspace_id" },
  brain_slack_ingest_scope: { kind: "column", column: "workspace_id" },
  // The warehouse producer's enrolled reach (#5196, ADR-0039). Plain column
  // rule: no FK in either direction, and deliberately none to the semantic layer
  // — `entity` stores a NAME rather than a `semantic_entities` id, so there is
  // no ordering constraint against the entity phase either.
  brain_enrollment: { kind: "column", column: "workspace_id" },
  // The entity store's snapshot entries (#5043, ADR-0037 §5). Plain column rule
  // for `brain_enrollment`'s reason: no FK in either direction, and deliberately
  // none to `brain_facts` — the ids appear there as `subject_cmp`/`object_cmp`
  // VALUES, which is a comparison column and never a join arm, so there is
  // nothing to order against.
  brain_entity: { kind: "column", column: "workspace_id" },

  // The human NAME behind each claim's actor handle (#5440, ADR-0036 §T5).
  // Plain column rule for `brain_entity`'s reason: no FK in either direction —
  // the join to `brain_facts` is `provenance ->> 'actor'` to `actor`, a VALUE
  // join with no constraint — so there is nothing to order against.
  brain_actor_identity: { kind: "column", column: "workspace_id" },

  // ── Stays residue (region-local; registry says NOT retained) ─────────────
  // The vocabulary's derived closure (#5022). `expression` rather than
  // `column`, and the predicate IS just the column — the kind is chosen for its
  // PHASE, exactly as `brain_facts` above is `parent`-scoped for phase rather
  // than for scoping. `fk_brain_vocabulary_target_edge` is RESTRICT, so these
  // rows must be gone before the column phase reaches `brain_vocabulary_edge`,
  // or the whole sweep fails outright on any workspace that has approved an
  // alias.
  //
  // Demoting it to `{ kind: "column", column: "workspace_id" }` would NOT
  // "happen to work" — an earlier version of this comment claimed it would, and
  // had the direction backwards. `brain_vocabulary_edge` is declared ABOVE, so
  // both rules would land in the column phase in THAT order and the RESTRICT FK
  // would abort the sweep. The phase split is the only thing making the order
  // right, and the tripwire test pins the shape so it stays a decision rather
  // than a re-discovery.
  brain_vocabulary_target: { kind: "expression", predicate: "workspace_id = $1" },
  // The alias queue and its rejection memory (#5023). Column-scoped and phase-
  // indifferent: no FK points at it in either direction, so unlike the closure
  // above there is no ordering obligation to encode. The rows it deletes are
  // NOT all re-derivable — bundle-scope.ts records that the `rejected` half is
  // a human decision this classification loses at a cutover, and names #5036 as
  // where it starts travelling.
  brain_vocabulary_proposal: { kind: "column", column: "workspace_id" },
  // Cardinality on the canonical predicate (#5027). Column-scoped and
  // phase-indifferent, like the queue above: no FK points at it in either
  // direction. bundle-scope.ts records what this deletion costs — the curated
  // `single` entries and the producers' rejection memory — and why carrying
  // them is DEFERRED rather than refused. The blocker #5035 removed — imported
  // facts are keyed now, so a carried entry would have rows to match — but the
  // MERGE against a destination that already holds its own entries is still
  // unspecified, and that is what #5036 owns.
  brain_predicate_cardinality: { kind: "column", column: "workspace_id" },
  // Scheduling state for the audience re-verifiers (#4971) — "this audience has
  // had its turn", read by nothing but the scan's ORDER BY. Workspace-scoped and
  // therefore deletable by column, like the membership table it sits beside, but
  // classified 'stays' rather than exported: the target rebuilds it from a
  // uniformly-NULL first cycle.
  brain_audience_reverify_attempt: { kind: "column", column: "workspace_id" },
  // The Coverage Surface's dated roster and its cycle record (#5213, ADR-0041).
  // Column-scoped and phase-indifferent: no FK in either direction — the roster
  // stores a channel id and a length-prefixed `<entity>`/`<dimension>` pair as
  // plain text, never a row reference — so nothing to order against
  // `brain_slack_channel`
  // or `semantic_entities`. Classified 'stays' rather than exported because
  // every reading in them is a reading of the SOURCE region's credentials at a
  // source-region instant; the target rebuilds both on its first successful
  // cycle, and until then has no row for the class at all — which #5214 renders
  // as "never enumerated here" rather than as a failed enumeration.
  brain_coverage_snapshot: { kind: "column", column: "workspace_id" },
  brain_coverage_cycle: { kind: "column", column: "workspace_id" },
  brain_warehouse_entity_success: { kind: "column", column: "workspace_id" },
  // The in-flight batch ledger (#5352, migration 0207). `brain_episodes` points
  // AT it under a composite FK, so the DELETE ORDER puts it after that table —
  // the same constraint the purge scope records.
  brain_extraction_batch: { kind: "column", column: "workspace_id" },
  // No org column: cache keys have no org dimension, but the Slack
  // installation store rides this table with the org id in the JSONB value
  // (see the bundle-scope rationale) — scope by that expression. Generic
  // cache rows are unattributable and expire by TTL.
  chat_cache: { kind: "expression", predicate: "value->>'orgId' = $1" },
  dashboard_draft_card_cache: {
    kind: "parent",
    fkColumn: "dashboard_id",
    parentTable: "dashboards",
    parentColumn: "org_id",
  },
  scheduled_task_runs: {
    kind: "parent",
    fkColumn: "task_id",
    parentTable: "scheduled_tasks",
    parentColumn: "org_id",
  },
  agent_runs: { kind: "column", column: "org_id" },
  knowledge_sync_credentials: { kind: "column", column: "workspace_id" },
  knowledge_sync_state: { kind: "column", column: "workspace_id" },
  semantic_entity_versions: { kind: "column", column: "org_id" },
  semantic_profile_status: { kind: "column", column: "org_id" },
  connection_profile_state: { kind: "column", column: "org_id" },
  learned_pattern_injections: { kind: "column", column: "org_id" },
  query_suggestions: { kind: "column", column: "org_id" },
  suggestion_user_clicks: {
    kind: "parent",
    fkColumn: "suggestion_id",
    parentTable: "query_suggestions",
    parentColumn: "org_id",
  },
  // No FK to conversations (plain index), so the parent-first phase ordering
  // is what guarantees these rows are matched before conversations vanish.
  slack_threads: {
    kind: "parent",
    fkColumn: "conversation_id",
    parentTable: "conversations",
    parentColumn: "org_id",
  },
  action_log: { kind: "column", column: "org_id" },
  audit_log: { kind: "column", column: "org_id" },
  admin_action_log: { kind: "column", column: "org_id" },
  token_usage: { kind: "column", column: "org_id" },
  usage_events: { kind: "column", column: "workspace_id" },
  usage_summaries: { kind: "column", column: "workspace_id" },
  overage_meter_reports: { kind: "column", column: "org_id" },
  pii_column_classifications: { kind: "column", column: "org_id" },
  backups: {
    kind: "none",
    reason:
      "Backup artifacts are instance-level (no workspace column) — rotated by the backup retention policy, not attributable to one org.",
  },
  backup_config: {
    kind: "none",
    reason: "Single-row instance backup schedule — no workspace dimension.",
  },
  connection_group_descriptions: { kind: "column", column: "org_id" },
  workspace_plugins: { kind: "column", column: "workspace_id" },
  plugin_grant_revocation_failures: { kind: "column", column: "workspace_id" },
  plugin_settings: { kind: "column", column: "org_id" },
  integration_credentials: { kind: "column", column: "workspace_id" },
  twenty_integrations: { kind: "column", column: "workspace_id" },
  workspace_action_credentials: { kind: "column", column: "workspace_id" },
  discord_installations: { kind: "column", column: "org_id" },
  github_installations: { kind: "column", column: "org_id" },
  linear_installations: { kind: "column", column: "org_id" },
  email_installations: { kind: "column", column: "org_id" },
  sandbox_credentials: { kind: "column", column: "org_id" },
  sso_providers: { kind: "column", column: "org_id" },
  scim_group_mappings: { kind: "column", column: "org_id" },
  custom_domains: { kind: "column", column: "workspace_id" },
  ip_allowlist: { kind: "column", column: "org_id" },
  custom_roles: { kind: "column", column: "org_id" },
  workspace_branding: { kind: "column", column: "org_id" },
  workspace_model_config: { kind: "column", column: "org_id" },
  workspace_model_catalog: { kind: "column", column: "org_id" },
  mcp_action_policy: { kind: "column", column: "org_id" },
  approval_rules: { kind: "column", column: "org_id" },
  approval_queue: { kind: "column", column: "org_id" },
  prompt_collections: { kind: "column", column: "org_id" },
  prompt_items: {
    kind: "parent",
    fkColumn: "collection_id",
    parentTable: "prompt_collections",
    parentColumn: "org_id",
  },
  user_favorite_prompts: { kind: "column", column: "org_id" },
  // The OAuth client's `reference_id` claim IS the workspace/org id (see
  // lib/auth/oauth-workspace-grants.ts).
  oauth_client_rate_limits: { kind: "column", column: "reference_id" },
  oauth_client_workspace_scope: { kind: "column", column: "reference_id" },
  oauth_client_workspace_grants: { kind: "column", column: "workspace_id" },
  audit_retention_config: { kind: "column", column: "org_id" },
  admin_action_retention_config: { kind: "column", column: "org_id" },
  sla_thresholds: { kind: "column", column: "workspace_id" },
  sla_metrics: { kind: "column", column: "workspace_id" },
  sla_alerts: { kind: "column", column: "workspace_id" },
  workspace_proactive_config: { kind: "column", column: "workspace_id" },
  channel_proactive_config: { kind: "column", column: "workspace_id" },
  proactive_pauses: { kind: "column", column: "workspace_id" },
  proactive_meter_events: { kind: "column", column: "workspace_id" },
  proactive_classification_review: { kind: "column", column: "workspace_id" },
  proactive_public_dataset: { kind: "column", column: "workspace_id" },
} satisfies Readonly<Record<CleanupScopedTable, CleanupRule>>;

/** A deletable statement derived from one rule (rules of kind "none" yield none). */
export interface CleanupStatement {
  readonly table: string;
  /** Parameterized DELETE with `$1` = the migrated org/workspace id. */
  readonly sql: string;
}

/**
 * Build the ordered DELETE statements for one org's cleanup. Parent-scoped and
 * expression rules run first (a parent subquery needs the parent rows to still
 * exist — see `slack_threads`). The direct-column phase then deletes the parents
 * themselves. Within the column phase ordering doesn't matter, because every FK
 * LEFT in that phase is `ON DELETE CASCADE` (or `SET NULL` for
 * `conversations.bound_dashboard_id`) — pinned against real Postgres by
 * `migrate-roundtrip-pg.test.ts`.
 *
 * That last clause holds only because the non-CASCADE children are deliberately
 * ordered, and there are now THREE such FKs — two pulled OUT of the column
 * phase, and one that cannot be:
 *
 *   - `brain_facts.source_episode_id` (#4767) — evidence must not vanish under a
 *     live claim. `brain_facts` carries a `parent` rule despite having its own
 *     `workspace_id`, purely so its delete precedes `brain_episodes`.
 *   - `fk_brain_vocabulary_target_edge` (#5022) — the derived closure must go
 *     before its approved edges. `brain_vocabulary_target` carries an
 *     `expression` rule for exactly that phase reason, not for simplicity.
 *   - ⚠️ `fk_brain_episodes_extraction_batch` (#5352) — NO ACTION, and the ONE
 *     case the early phase cannot express, because it points the other way: the
 *     CHILD is `brain_episodes`, so `brain_extraction_batch` has to be deleted
 *     LAST, not first, and the early phase runs first by construction. Both
 *     therefore sit in the column phase and the ordering rests on DECLARATION
 *     ORDER — `brain_episodes` is declared above `brain_extraction_batch`, and
 *     `buildCleanupStatements` walks `Object.entries`. That is exactly the
 *     "invisible, unasserted property of literal ordering" the `brain_facts`
 *     tripwire calls out, so it has a tripwire of its own in `cleanup.test.ts`;
 *     alphabetising this registry would otherwise break region cleanup for
 *     every workspace with a brain, silently, at the first sweep.
 *
 * The two expression rules are therefore not equivalent: `brain_vocabulary_target`
 * NEEDS the early phase, `chat_cache` merely tolerates it. Any further
 * non-CASCADE FK between in-scope tables needs one of these three treatments,
 * chosen by which side of it is in scope. Exported for the tripwire + PG tests.
 */
export function buildCleanupStatements(): readonly CleanupStatement[] {
  const first: CleanupStatement[] = [];
  const second: CleanupStatement[] = [];
  for (const [table, rule] of Object.entries<CleanupRule>(CLEANUP_TABLE_RULES)) {
    switch (rule.kind) {
      case "parent":
        first.push({
          table,
          sql: `DELETE FROM ${table} WHERE ${rule.fkColumn} IN (SELECT id FROM ${rule.parentTable} WHERE ${rule.parentColumn} = $1)`,
        });
        break;
      case "expression":
        first.push({ table, sql: `DELETE FROM ${table} WHERE ${rule.predicate}` });
        break;
      case "column":
        second.push({ table, sql: `DELETE FROM ${table} WHERE ${rule.column} = $1` });
        break;
      case "none":
        // intentionally no statement: no org dimension to scope a delete by
        break;
      default:
        // Exhaustiveness guard: a new CleanupRule kind must decide its
        // statement shape here, or the table would silently miss cleanup.
        rule satisfies never;
        break;
    }
  }
  return [...first, ...second];
}

// ---------------------------------------------------------------------------
// Per-migration cleanup
// ---------------------------------------------------------------------------

/** Outcome of one migration's cleanup attempt. */
export type SourceCleanupResult =
  | { readonly outcome: "cleaned"; readonly deletedRows: number }
  /** Another instance already cleaned it, or the row is no longer eligible. */
  | { readonly outcome: "already_resolved" }
  /**
   * The workspace is homed in the source region again (cutover guard) — the
   * delete would destroy live data. Permanently resolved as skipped; a later
   * migration away from this region gets its own row and its own cleanup.
   */
  | { readonly outcome: "workspace_active_in_source" }
  /**
   * The organization row exists but its `region` is NULL/unreadable — an
   * ambiguous home we refuse to delete against (fail closed). NOT resolved:
   * no stamp, the row stays due and is re-attempted (and re-warned) every
   * sweep until an operator fixes the organization row.
   */
  | { readonly outcome: "organization_region_unknown" };

/**
 * Delete one migrated workspace's source-region residue, transactionally.
 * See the module doc for the safety/retry contract.
 */
export async function cleanupMigrationSourceData(migration: {
  readonly id: string;
  readonly workspaceId: string;
  readonly sourceRegion: string;
}): Promise<SourceCleanupResult> {
  const { id: migrationId, workspaceId, sourceRegion } = migration;
  const pool = getInternalDB();
  const client = await pool.connect();
  // Set when ROLLBACK itself fails: passed to `release()` so the pool
  // destroys the connection instead of handing a possibly-aborted
  // transaction to an unrelated later query.
  let broken: Error | undefined;
  try {
    await client.query("BEGIN");
    // Bound the FOR UPDATE waits: without this, a wedged transaction holding
    // the organization row would hang the tick forever — the fiber would
    // stop ticking with no error and no span (absence-only signal). With it,
    // a stuck lock surfaces as a tick failure → warn + span ERROR + retry.
    await client.query("SET LOCAL lock_timeout = '10s'");

    // Re-check eligibility under a row lock — the loser of a concurrent
    // sweep (multi-instance deploy) sees the winner's stamp and skips.
    // ALL SIX refusal columns ride the SAME `FOR UPDATE` read — no extra query, and
    // read under the lock that pins the verdict to the deletes. This sweep is the
    // irreversible act: after it, the source's own `brain_vocabulary_edge`,
    // `brain_vocabulary_proposal` and `brain_predicate_cardinality` rows are gone and
    // the payloads on this row are the last copy of those human decisions. The audit
    // event below is where that becomes visible at the moment it becomes true, rather
    // than only in a phase-2 warn emitted seven days earlier.
    //
    // ⚠️ Each payload column is read as a LENGTH, not as the array. The warns below
    // tell an operator to go and re-author from those columns, and round 1 of #5112's
    // review caught the edge one making that promise unconditionally — while the
    // column is NULL for a target that predated the payload contract (count answered,
    // no payloads) and shorter than the count whenever the cap bit or an entry was
    // screened out. A recovery instruction pointing at an empty column, emitted at the
    // instant the originals become unrecoverable, is worse than no instruction.
    const rows = await client.query(
      `SELECT status,
              source_cleaned_at,
              ${REFUSAL_AUDIT_COLUMNS}
         FROM region_migrations WHERE id = $1 FOR UPDATE`,
      [migrationId],
    );
    const row: Record<string, unknown> | undefined = rows.rows[0];
    if (!row || row.status !== "completed" || row.source_cleaned_at !== null) {
      await client.query("ROLLBACK");
      return { outcome: "already_resolved" };
    }
    const refusalReadings = DELETE_TIME_REFUSAL_SECTIONS.map((section) => ({
      section,
      ...readSectionRefusals(row, section),
    }));
    // Flat keys, not a nested object per section: this rides a log line, and a
    // saved query for `vocabularyEdgesRefused` has matched a top-level key since
    // #5112. Nesting the three would break every such query to buy grouping that
    // the key names already carry.
    const refusalAudit: Record<string, number | null> = {};
    for (const reading of refusalReadings) {
      refusalAudit[reading.section.countKey] = reading.refused;
      refusalAudit[reading.section.recordedKey] = reading.recorded;
    }

    // Cutover guard: never delete a workspace that is homed HERE. After a
    // normal cutover the source DB's organization row points at the target
    // region; if it points at the source region again (e.g. the workspace
    // migrated back before this cleanup ran), the "residue" is live data.
    // `FOR UPDATE` pins the verdict to the deletes: a concurrent cutover
    // UPDATE on this row blocks until this transaction finishes, so the
    // region we checked is the region the deletes run against.
    // A missing organization row means the workspace was deleted entirely —
    // removing its residue is exactly what we want, so proceed.
    const org = await client.query(
      `SELECT region FROM organization WHERE id = $1 FOR UPDATE`,
      [workspaceId],
    );
    const orgRow = org.rows[0];
    if (orgRow) {
      if (orgRow.region === sourceRegion) {
        await client.query(
          `UPDATE region_migrations SET source_cleaned_at = NOW() WHERE id = $1`,
          [migrationId],
        );
        await client.query("COMMIT");
        log.warn(
          { migrationId, workspaceId, sourceRegion },
          "Source cleanup skipped — workspace is homed in the source region again; residue is live data",
        );
        logCleanupEvent("region_migration_source_cleanup_skipped", migrationId, {
          workspaceId,
          sourceRegion,
          reason: "workspace_active_in_source_region",
        });
        return { outcome: "workspace_active_in_source" };
      }
      if (typeof orgRow.region !== "string" || orgRow.region.trim() === "") {
        // Fail closed on ambiguity: an organization row with region NULL,
        // empty, or any non-string value doesn't prove the workspace moved
        // away, and the only irreversible mistake here is deleting live
        // data. (Region names are free strings across residency/, so a full
        // membership check isn't possible here — NULL/empty is the
        // detectable ambiguity.) No stamp — the row stays due, so the state
        // stays visible (re-warned every sweep) until an operator resolves
        // the organization row.
        await client.query("ROLLBACK");
        log.warn(
          { migrationId, workspaceId, sourceRegion, region: orgRow.region ?? null },
          "Source cleanup refused — organization.region is NULL/empty/unreadable; leaving the migration due",
        );
        return { outcome: "organization_region_unknown" };
      }
    }

    const deletedByTable: Record<string, number> = {};
    let deletedRows = 0;
    for (const stmt of buildCleanupStatements()) {
      const result = await client.query(stmt.sql, [workspaceId]);
      if (result.rowCount === undefined || result.rowCount === null) {
        // Real pg always reports rowCount for DELETE; a client that doesn't
        // degrades the deletion audit (not the deletes) — make that visible.
        log.debug(
          { migrationId, table: stmt.table },
          "DELETE reported no rowCount — deletion audit counts will under-report",
        );
      }
      const count = result.rowCount ?? 0;
      if (count > 0) deletedByTable[stmt.table] = count;
      deletedRows += count;
    }

    await client.query(
      `UPDATE region_migrations SET source_cleaned_at = NOW() WHERE id = $1`,
      [migrationId],
    );
    await client.query("COMMIT");

    logCleanupEvent("region_migration_source_cleaned", migrationId, {
      workspaceId,
      sourceRegion,
      deletedRows,
      deletedByTable,
      // #5112, all three sections since #5557 — the counts travel with the deletion
      // audit, because THIS is the event that made the loss permanent. `null` =
      // unknown (a row predating the section's column).
      ...refusalAudit,
    });
    log.info(
      {
        migrationId,
        workspaceId,
        sourceRegion,
        deletedRows,
        ...Object.fromEntries(
          refusalReadings.map((r) => [r.section.countKey, r.refused] as const),
        ),
      },
      "Source-region data cleanup completed",
    );
    // ⚠️ A SEPARATE `warn` PER SECTION, not a clause on the `info` above and not one
    // line summing the three (#5112, #5557). The line above is routine — it fires for
    // every migration — and an operator who greps for it is looking at row counts.
    // These say an irreversible thing just happened to a human's decisions and point
    // at where they can still be found, which from this instant on is the only
    // remaining copy.
    //
    // Per section rather than merged, for the same reason `migrate.ts`'s pre-cutover
    // disclosure is: the three losses come out of three DIFFERENT tables with three
    // different recovery columns, and one line naming `brain_vocabulary_edge` while
    // reporting a refused predicate-cardinality decision sends the operator to a table
    // that does not hold it.
    for (const { section, refused, recorded } of refusalReadings) {
      // `null` is UNKNOWN and is not a reason to shout — there may be nothing to
      // shout about. `0` is a claim that nothing was lost, and a disclosure that
      // fires for every migration that lost nothing is alarm fatigue.
      if (refused === null || refused <= 0) continue;
      const { sourceTable, decisions } = REFUSAL_DISCLOSURE[section.section];
      log.warn(
        {
          migrationId,
          workspaceId,
          sourceRegion,
          section: section.section,
          [section.countKey]: refused,
          [section.recordedKey]: recorded,
        },
        `Source cleanup DELETED the ${sourceTable} rows behind ${section.subject} — that ` +
          `many ${decisions} were never applied in the target region and ` +
          `their source rows are now gone. ${refusalRecoverySentence(section, refused, recorded)}`,
      );
    }
    return { outcome: "cleaned", deletedRows };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      broken = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
      log.error(
        { err: broken.message, migrationId },
        "Source cleanup rollback failed — destroying the connection instead of pooling it",
      );
    }
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    client.release(broken);
  }
}

// ---------------------------------------------------------------------------
// The sweep — tick body of the `region_migration_source_cleanup` fiber
// ---------------------------------------------------------------------------

/**
 * One sweep's outcome, attached to the fiber's per-tick span. The buckets
 * partition the due set together with the implicit failure remainder:
 * `cleaned + skipped + blocked + <failed> === due`.
 */
export interface SweepSummary {
  readonly due: number;
  /** Deleted + stamped. */
  readonly cleaned: number;
  /** RESOLVED without deleting (already stamped, or cutover-guard stamp). */
  readonly skipped: number;
  /**
   * NOT resolved and NOT attempted/completed by design: region-identity
   * mismatch or an ambiguous organization row. These stay due — a non-zero
   * value that persists across sweeps is an operator signal.
   */
  readonly blocked: number;
}

/**
 * Clean every migration whose grace period has elapsed.
 *
 * Returns the buckets separately so the fiber's span can distinguish
 * "nothing owed" from "owed but not done". Mirrors the sibling
 * `failStaleMigrations` contract: throws when attempts FAILED outright and
 * nothing succeeded or resolved — that tick must surface as span ERROR +
 * warn, not a quiet zero. Guard-blocked rows don't suppress the throw (they
 * are counted, not treated as success), and partial failure stays
 * non-throwing: the per-migration error is logged and the next sweep
 * retries the stragglers.
 */
export async function runSourceCleanupSweep(): Promise<SweepSummary> {
  if (!hasInternalDB()) return { due: 0, cleaned: 0, skipped: 0, blocked: 0 };

  const due = await getCleanupDueMigrations();
  if (due.length === 0) return { due: 0, cleaned: 0, skipped: 0, blocked: 0 };

  const apiRegion = getApiRegion();
  if (apiRegion === null) {
    // Single-instance / self-hosted deploys have no region identity — the
    // cutover guard inside each cleanup is the remaining check. Record that
    // a destructive sweep is running without the region-identity guard.
    log.info(
      { due: due.length },
      "Region identity unresolved (no ATLAS_API_REGION / residency.defaultRegion) — cleaning without the region-identity guard",
    );
  }
  let cleaned = 0;
  let skipped = 0;
  let blocked = 0;
  for (const migration of due) {
    // Region identity guard: a process that knows its region only cleans its
    // own rows. In the 3-region deploy each region's internal DB holds only
    // its own migrations, so a mismatch here means misconfiguration — warn
    // and leave the row alone (it stays due; nothing is deleted).
    if (apiRegion !== null && migration.sourceRegion !== apiRegion) {
      blocked++;
      log.warn(
        { migrationId: migration.id, sourceRegion: migration.sourceRegion, apiRegion },
        "Source cleanup blocked — migration's source region does not match this instance's region identity",
      );
      continue;
    }
    try {
      const result = await cleanupMigrationSourceData(migration);
      switch (result.outcome) {
        case "cleaned":
          cleaned++;
          break;
        case "already_resolved":
        case "workspace_active_in_source":
          skipped++;
          break;
        case "organization_region_unknown":
          blocked++;
          break;
        default:
          result satisfies never;
          break;
      }
    } catch (err) {
      log.error(
        {
          err: err instanceof Error ? err.message : String(err),
          migrationId: migration.id,
          workspaceId: migration.workspaceId,
        },
        "Source-region cleanup failed for migration — rolled back, will retry next sweep",
      );
    }
  }

  const failed = due.length - cleaned - skipped - blocked;
  if (failed > 0 && cleaned === 0 && skipped === 0) {
    throw new Error(
      `Found ${due.length} region migration(s) due for source cleanup but every attempt failed — migrated workspace data persists in the source region`,
    );
  }

  return { due: due.length, cleaned, skipped, blocked };
}
