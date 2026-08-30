/**
 * Region migration executor.
 *
 * Orchestrates the lifecycle of a workspace region migration:
 * pending → in_progress → completed/failed.
 *
 * The migration runs in 4 phases:
 * 1. **Export** — extract workspace data from the source region's internal DB
 * 2. **Transfer** — send the export bundle to the target region's API
 * 3. **Cutover** — update the organization's region, flush caches, invalidate pools
 * 4. **Cleanup** — schedule source data removal after a 7-day grace period
 *    (executed by the `region_migration_source_cleanup` periodic fiber, #4458 —
 *    see `cleanup.ts`; `getCleanupDueMigrations` below is its due query)
 *
 * During migration, the workspace is read-only — write operations are rejected
 * by the migration write-lock middleware (see readonly.ts).
 */

// The one spelling of the refusal item's eight fields (#5303) — the same schema
// `admin-migrate.ts` publishes in `ImportResultSchema`. `lib/**` must not import
// from `api/routes/**`, so `@useatlas/schemas` is the only legal shared home.
//
// ⚠️ A VALUE import, and safe here for a reason that is NOT the one that would
// make it safe from `@useatlas/types`. The hazard the cap constant's docstring
// describes is resolution against a PUBLISHED package: this file is copied into
// the `create-atlas` scaffold, which installs `@useatlas/types` from npm and
// therefore cannot see a symbol added in the same commit. `@useatlas/schemas`
// never publishes at all — instead `create-atlas/scripts/prepare-templates.sh`
// (step 5e) copies its SOURCE into every template and aliases it through
// `tsconfig` paths, so the scaffold gets this file and this schema from the same
// commit. That copy is what makes the import safe, not the absence of a
// registry entry — and `check-template-drift.sh` is what keeps it true.
import {
  PredicateCardinalityRefusalDetailSchema,
  VocabularyProposalRefusalDetailSchema,
  VocabularyRefusalDetailSchema,
} from "@useatlas/schemas";
import type { ZodType } from "zod";
import { createLogger } from "@atlas/api/lib/logger";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { hasInternalDB, internalQuery, getInternalDB } from "@atlas/api/lib/db/internal";
import { getConfig } from "@atlas/api/lib/config";
import { UnsafeRegionMigrationResetError } from "@atlas/api/lib/effect/errors";
import { exportWorkspaceBundle } from "./export";
import type {
  MigrationStatus,
  MigrationPhase,
  ExportBundle,
  ExportManifest,
  ImportResult,
  PredicateCardinalityRefusalDetail,
  VocabularyProposalRefusalDetail,
  VocabularyRefusalDetail,
} from "@useatlas/types";
// ⚠️ From `lib/brain/vocabulary`, NOT from `@useatlas/types` beside the type it
// bounds. A VALUE import from the published package resolves at runtime against
// the version the scaffold template pins, and `packages/api/src` is copied into
// that template — the constant's docstring carries the CI failure that proved it.
// The `import type` above is erased and therefore free.
import { VOCABULARY_REFUSAL_DETAIL_CAP } from "@atlas/api/lib/brain/vocabulary";

/** Days to wait before cleaning up source region data after migration. */
const CLEANUP_GRACE_PERIOD_DAYS = 7;

const log = createLogger("region-migration");

/**
 * Bundle sections whose exported count is reconciled against the target
 * region's acknowledgement before cutover (#4767).
 *
 * The type bound is the point: a member must be a key of BOTH
 * `manifest.counts` AND `ImportResult`, so the compiler rejects a
 * manifest-only count (`messages`, `dashboardCards`, `dashboardUserDrafts`,
 * `knowledgeLinks` — child rows the importer folds into their parent's
 * counter and never reports separately). Reconciling one of those would
 * compare against a counter that structurally does not exist and abort every
 * migration.
 *
 * A new bundle section belongs here the moment it gets its own ImportResult
 * counter — that is what makes "the target silently dropped it" a failure
 * instead of a silent success.
 */
const RECONCILED_SECTIONS = [
  "conversations",
  "semanticEntities",
  "learnedPatterns",
  "settings",
  "dashboards",
  "knowledgeDocuments",
  "scheduledTasks",
  "agentSessionMemory",
  "brainEpisodes",
  "brainFacts",
  "brainEdges",
  "factAudienceMembers",
  "brainVocabularyEdges",
  // #5203. Listed for the reason the doc comment gives — it has both a manifest
  // count and an ImportResult counter, so leaving it off would make "the target
  // silently dropped every exclusion" a successful migration. That is the one
  // failure this section cannot afford: a dropped exclusion does not degrade the
  // destination, it makes it ingest a channel a human removed from scope.
  //
  // `brainSlackIngestScope` is deliberately NOT here and cannot be: it is a
  // single optional OBJECT, not a counted array, so it has no manifest count and
  // no ImportResult counter, and the type bound above rejects it. Its loss is
  // bounded by the same reconciliation from the other side — a workspace with an
  // unreconciled scope row has, by definition, not yet turned its allowlist into
  // exclusions, so there is nothing for the counted section to under-report.
  "brainSlackChannelExclusions",
  // #5196, ADR-0039. Reconciled for the mirror image of the reason above: a
  // dropped exclusion makes the destination ingest MORE than a human agreed to,
  // and a dropped enrollment makes its warehouse producer reach NOTHING. The
  // second is the silent one — an unenrolled workspace and a working one are
  // indistinguishable from inside the code, which is exactly why the ADR makes
  // the milestone's proof a prod row count — so a target that quietly landed
  // none of them would otherwise report a clean cutover.
  "brainEnrollments",
  // #5043. Reconciled for `brainEnrollments`' reason, one step further along: a
  // dropped entry makes the destination's store resolve nothing, which is the
  // store's DESIGNED behaviour when it is empty — so a target that landed none
  // of them looks byte-identical to one working correctly, and would otherwise
  // report a clean cutover.
  "brainEntities",
  // #5440, ADR-0036 §T5. Reconciled for `brainEntities`' reason with the
  // failure one notch worse: a target that landed none of them renders every
  // migrated claim `opaque` — "we cannot name this person" — which is an
  // HONEST sentence and therefore completely indistinguishable from a
  // workspace whose capture pass has simply not run. The cutover would report
  // clean and the record would have lost the only mapping from its handles to
  // people. The section also carries operator ERASURES as tombstones, so
  // silently dropping it would additionally undo them.
  "brainActorIdentities",
  // #5113. The alias queue's permanent rejection memory. Reconciled because a
  // target that quietly landed none of them reports a clean cutover while the
  // one state that stops a producer re-writing what a human removed is gone —
  // and the producer's next run then re-proposes (and for a warehouse-derived
  // entity edge, AUTO-APPROVES) exactly that pair (#4507).
  "brainVocabularyProposals",
  // #5113. Cardinality decisions on the canonical predicate. Reconciled for
  // `brainEnrollments`' reason: an uncurated predicate never supersedes, so a
  // target that landed none of them is byte-identical to a workspace nobody
  // has curated and would otherwise report a clean cutover.
  "brainPredicateCardinalities",
] as const satisfies readonly (keyof ExportManifest["counts"] & keyof ImportResult)[];

type RefusalCapableSection = {
  [K in keyof ImportResult]: ImportResult[K] extends { refused: number } ? K : never;
}[keyof ImportResult];

const REFUSAL_ACCOUNTING = [
  "brainVocabularyEdges",
  // #5203. Its `refused` counter is structurally zero today — the import's only
  // non-imported arm is `DO NOTHING` on an existing row, which is `skipped`.
  // Listed anyway, and deliberately: the pin below makes a section growing
  // `refused` a COMPILE error precisely so the accounting-versus-loss decision
  // is made when the counter is introduced rather than discovered during a live
  // migration. The decision, made here: a refused exclusion is LOST SCOPE
  // NARROWING and must count toward the reconciled total, so a future conflict
  // rule cannot fail a cutover merely by exercising itself.
  "brainSlackChannelExclusions",
  // #5113. Both sections refuse BY DESIGN — a decided arriving row that
  // contradicts a decided destination row, and (cardinality only) an entry
  // whose predicate the destination's vocabulary canonicalizes differently.
  // Each refusal is deliberate destination-wins policy with its own log line,
  // so it counts toward the reconciled total: a genuinely conflicting decision
  // must not fail a whole cutover merely by being surfaced.
  "brainVocabularyProposals",
  "brainPredicateCardinalities",
] as const satisfies readonly RefusalCapableSection[];

type RefusalAccountingSection = (typeof REFUSAL_ACCOUNTING)[number];

/**
 * What the pre-cutover disclosure calls each accounting section's loss (#5533).
 *
 * ⚠️ A `Record` OVER THE ACCOUNTING LIST, not a lookup with a fallback. Adding a
 * section to `REFUSAL_ACCOUNTING` without deciding what its disclosure says is then
 * a compile error rather than a migration that warns about alias edges while
 * refusing something else — which is what the single hard-coded sentence did the
 * moment #5113 gave two more sections a `refused` counter.
 *
 * `column` is the `region_migrations` column holding that section's payloads, and
 * `undefined` means the section has NO payload contract. The disclosure's recovery
 * clause is emitted only when it is set, because an instruction to go and read a
 * column that does not exist is worse than no instruction — the same rule
 * `cleanup.ts` applies to an empty one.
 *
 * ⚠️ `as const satisfies`, and `column` is REQUIRED-but-nullable rather than
 * optional. Both halves are load-bearing since #5557 gave this record a second
 * reader:
 *
 * - **Required** forces a new accounting section to DECIDE whether it carries
 *   payloads, instead of inheriting "no" by omitting a line. That decision is what
 *   says whether the delete-time audit owes it a reader.
 * - **`as const`** keeps each entry's `column` a literal type rather than the
 *   widened `string | undefined` the annotation would give all four, which is what
 *   lets `PayloadCarryingRefusalSection` below name exactly the sections that have
 *   one. Under the old `const X: Record<…>` form that extraction is not expressible
 *   and `cleanup.ts` would have to re-spell all three column names — two structures
 *   that must agree about which column holds the last copy of a human decision.
 */
export const REFUSAL_DISCLOSURE = {
  brainVocabularyEdges: {
    subject: "curated alias edges",
    decisions: "approved human review decisions",
    sourceTable: "brain_vocabulary_edge",
    column: "vocabulary_refusals",
  },
  // Structurally zero today — its only non-imported arm is `DO NOTHING` on an
  // existing row, which is `skipped`. Present because `REFUSAL_ACCOUNTING` lists it
  // deliberately, so that a future conflict rule arrives with its copy already
  // decided rather than falling back to another section's.
  brainSlackChannelExclusions: {
    subject: "Slack ingest-scope narrowings",
    decisions: "human scope decisions",
    sourceTable: "brain_slack_channel",
    // No payload contract: nothing is persisted for this section, so neither the
    // pre-cutover disclosure nor the delete-time audit may name a column for it.
    column: undefined,
  },
  brainVocabularyProposals: {
    subject: "arriving alias-proposal decisions",
    decisions: "human review decisions (approved or rejected)",
    sourceTable: "brain_vocabulary_proposal",
    column: "vocabulary_proposal_refusals",
  },
  brainPredicateCardinalities: {
    subject: "arriving predicate-cardinality decisions",
    decisions: "human review decisions (approved or rejected)",
    sourceTable: "brain_predicate_cardinality",
    column: "predicate_cardinality_refusals",
  },
} as const satisfies Record<
  RefusalAccountingSection,
  {
    readonly subject: string;
    readonly decisions: string;
    readonly sourceTable: string;
    readonly column: string | undefined;
  }
>;

/**
 * The accounting sections whose refusals leave a durable payload on
 * `region_migrations` — i.e. the ones a delete-time reader can honestly point an
 * operator at (#5557).
 *
 * Derived from `REFUSAL_DISCLOSURE` rather than listed, so a fourth payload-carrying
 * section widens this union the moment its `column` is filled in. `cleanup.ts`'s
 * audit table is keyed on it and pins its own completeness against it, which makes
 * "shipped a payload column with no delete-time reader" — the exact state #5533 left
 * and this issue closes — a compile error rather than a follow-up issue.
 */
export type PayloadCarryingRefusalSection = {
  [K in RefusalAccountingSection]: (typeof REFUSAL_DISCLOSURE)[K]["column"] extends string
    ? K
    : never;
}[RefusalAccountingSection];

/**
 * Is this section's `refused` ACCOUNTING rather than loss — and if so, what does its
 * disclosure say?
 *
 * ⚠️ ONE LIST, NOT TWO. This used to be a `ReadonlySet` built from
 * `REFUSAL_ACCOUNTING` beside the record above, and two structures that must agree
 * are two structures that can disagree — the record is keyed on
 * `RefusalAccountingSection`, so membership and copy are now the SAME fact and a
 * section cannot be accounted-for without a sentence to say so.
 *
 * The `as RefusalAccountingSection` is RELOCATED here, not removed — `Object.hasOwn`
 * narrows the object, not the key, so the assertion below still does the work. What
 * the move buys is that it now sits one line under the runtime check that justifies
 * it, instead of at a call site where the check was three statements away.
 */
function refusalDisclosureFor(
  section: string,
): (typeof REFUSAL_DISCLOSURE)[RefusalAccountingSection] | undefined {
  return Object.hasOwn(REFUSAL_DISCLOSURE, section)
    ? REFUSAL_DISCLOSURE[section as RefusalAccountingSection]
    : undefined;
}

/**
 * Completeness half of the bound above: every section that HAS both a manifest
 * count and an ImportResult counter must be listed.
 *
 * The `satisfies` proves each member is legal; this proves none is missing.
 * Without it, adding a section and forgetting to reconcile it is a silent
 * no-op — the target drops it, the guard doesn't look, and the source cleanup
 * deletes it after the grace period. That is precisely the failure the guard
 * exists to prevent, so it must be a compile error rather than a review catch.
 *
 * Bounded on `keyof ImportResult` ALONE, deliberately — not on the
 * intersection the `satisfies` uses. Intersecting here would re-open the hole:
 * a new section added to ImportResult but whose `counts:` line was forgotten
 * would drop out of the intersection and pass unnoticed. Bounded this way it
 * is forced into RECONCILED_SECTIONS, where the `satisfies` then fails until
 * the manifest count exists — so both halves of the mistake are caught.
 */
/**
 * The sections whose import can legitimately REFUSE a row (#5036).
 *
 * Derived from the wire type rather than asserted: a section is refusal-capable
 * exactly when `ImportResult` gives it a REQUIRED `refused: number`. An OPTIONAL
 * one falls out of the conditional below and would be missed — which is the
 * argument for declaring the counter required on the wire type in the first
 * place. TWO sections do — `brainVocabularyEdges` and, since #5203,
 * `brainSlackChannelExclusions`; both are listed in `REFUSAL_ACCOUNTING` below.
 * An alias edge is a human review decision and two regions can hold
 * contradictory ones, so the destination refuses one and logs it. Everywhere
 * else — `brainEnrollments` included, whose pair IS its whole key so two regions
 * cannot contradict each other — `imported + skipped` accounts for every row and
 * a `refused` in the response is a target bug.
 *
 * The distinction decides whether a shortfall ABORTS a cutover, so a second
 * section growing the counter has to be a deliberate decision rather than a
 * discovery. Two halves do that, and only the second is the completeness claim:
 * the `satisfies` below proves every LISTED member is genuinely refusal-capable,
 * while `_refusalSectionsReviewed` — inside `transferBundleToTarget`, where the
 * decision is consumed — proves none is MISSING. That split mirrors
 * `RECONCILED_SECTIONS`' own two-sided pin.
 */
type UnreconciledSection = Exclude<keyof ImportResult, (typeof RECONCILED_SECTIONS)[number]>;
const _everySectionReconciled: [UnreconciledSection] extends [never] ? true : never = true;
void _everySectionReconciled;

/**
 * Stale migration threshold: 5 minutes.
 *
 * Exported for the `region_migration_stale_reap` periodic fiber (#4459) and
 * its bounded-window contract test. Keep the operator-facing copy in
 * `data-residency.mdx` in sync if this changes.
 */
export const STALE_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Cadence of the `region_migration_stale_reap` periodic fiber (#4459).
 *
 * Must not exceed {@link STALE_THRESHOLD_MS}: a workspace whose migration
 * crashed mid-flight stays write-locked (`isWorkspaceMigrating`) until the
 * reaper fails the row, so the sweep interval bounds the worst-case unlock
 * window at threshold + one interval (~6 min today) with no operator action.
 */
export const STALE_MIGRATION_REAP_INTERVAL_MS = 60 * 1000;

// ---------------------------------------------------------------------------
// Migration steps (for logging)
// ---------------------------------------------------------------------------

const MIGRATION_STEPS: Record<MigrationPhase, string> = {
  validating: "Validating migration request",
  exporting: "Exporting workspace data",
  transferring: "Transferring data to target region",
  cutting_over: "Updating region assignment and flushing caches",
  scheduling_cleanup: "Scheduling source data cleanup",
  completed: "Migration completed",
  failed: "Migration failed",
};

// ---------------------------------------------------------------------------
// Audit helpers
// ---------------------------------------------------------------------------

/** Log a structured migration lifecycle event via pino. */
function logMigrationEvent(
  event: string,
  migrationId: string,
  details: Record<string, unknown>,
): void {
  log.info({ event, migrationId, ...details }, `Migration audit: ${event}`);
}

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

async function updateMigrationStatus(
  migrationId: string,
  status: MigrationStatus,
  extra?: { errorMessage?: string; completedAt?: string; regionUpdated?: boolean },
): Promise<void> {
  const sets = [`status = $1`];
  const params: unknown[] = [status];
  let idx = 2;

  if (extra?.completedAt) {
    sets.push(`completed_at = $${idx}`);
    params.push(extra.completedAt);
    idx++;
  }
  if (extra?.errorMessage !== undefined) {
    sets.push(`error_message = $${idx}`);
    params.push(extra.errorMessage);
    idx++;
  }
  // Folded into the same UPDATE so the failure path stamps the guard column
  // atomically with the status flip. Without this, a Phase 4 failure that
  // survived the dedicated `region_updated` persist (or a transient failure
  // on the persist itself) would leave status='failed' + region_updated=FALSE
  // and the resetMigrationForRetry guard would fail open.
  if (extra?.regionUpdated !== undefined) {
    sets.push(`region_updated = $${idx}`);
    params.push(extra.regionUpdated);
    idx++;
  }

  params.push(migrationId);
  await internalQuery(
    `UPDATE region_migrations SET ${sets.join(", ")} WHERE id = $${idx}`,
    params,
  );
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Discriminated result from migration execution. */
export type MigrationResult =
  | {
      readonly success: true;
      readonly migrationId: string;
      /**
       * Curated alias edges the TARGET region refused (#5112).
       *
       * On the success arm only, and that is not an oversight: this is the arm
       * on which the source's `brain_vocabulary_edge` rows are now scheduled for
       * deletion, so it is the only arm where the number is a call to act. A
       * failed migration deleted nothing.
       *
       * `> 0` means that many of a human's approved review decisions are NOT
       * applied in the destination and the source's copies expire with the grace
       * period. The payloads are on `region_migrations.vocabulary_refusals`,
       * which the cleanup sweep never touches.
       */
      readonly vocabularyEdgesRefused: number;
    }
  | { readonly success: false; readonly migrationId: string; readonly error: string };

/** Failure reason codes for structured HTTP status mapping. */
export type MigrationFailureReason = "not_found" | "invalid_status" | "db_error" | "no_db";

/** Discriminated result from retry/cancel operations. */
export type OperationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: MigrationFailureReason; readonly error: string };

// ---------------------------------------------------------------------------
// Transfer helper — POST bundle to target region
// ---------------------------------------------------------------------------

/**
 * One target-region response's worth of refusal evidence, brought back to the
 * source (#5112).
 *
 * `refused` is the count the reconciliation loop already validated as a
 * non-negative integer. `details` is what the source can still act on, screened
 * entry-by-entry from foreign JSON.
 *
 * `details.length < refused` is the load-bearing comparison, and every cause reads
 * the same to the operator — "part of this loss has no payload here". The causes: the
 * list was capped (by the target, or by this region's own `slice` when the target
 * ignored the bound), the target predates #5112 and sent none, or an entry was
 * malformed and screened out. `malformedDetails` separates the last, because that one
 * is a bug in a region rather than a documented bound.
 */
export interface RefusalEvidence<TDetail> {
  readonly refused: number;
  readonly details: readonly TDetail[];
  /** Entries the target sent that this build could not read. */
  readonly malformedDetails: number;
}

/** #5112's evidence — the refused alias EDGES. Kept as a name for its call sites. */
export type VocabularyRefusalEvidence = RefusalEvidence<VocabularyRefusalDetail>;

/**
 * Every refusal-carrying section's evidence from one target response (#5533).
 *
 * ⚠️ ONE OBJECT, THREE SECTIONS, and they are kept apart rather than concatenated.
 * The three payload shapes are genuinely different (an edge's slot and approver; a
 * proposal's pair and two statuses; a cardinality's key, two values and a second
 * canonical norm), each lands in its OWN `region_migrations` column, and each has
 * its own `length < refused` comparison to make. Merging them would need a
 * discriminator on the wire that no region sends, and would turn three independent
 * truncation signals into one that cannot say which section was truncated.
 *
 * ⚠️ A section added here without a column to write it to is a compile error at
 * `transferBundleToTarget`'s `return { … }`, which must name every member — NOT,
 * as an earlier version of this said, at `recordMigrationRefusals`, which merely
 * destructures three of them. Destructuring a subset is legal TypeScript, so that
 * site would have stayed green. The safety property is real; only the mechanism was
 * misnamed, and a pin that names the wrong site is one nobody can check.
 */
export interface MigrationRefusalEvidence {
  readonly vocabularyEdges: RefusalEvidence<VocabularyRefusalDetail>;
  readonly vocabularyProposals: RefusalEvidence<VocabularyProposalRefusalDetail>;
  readonly predicateCardinalities: RefusalEvidence<PredicateCardinalityRefusalDetail>;
}

/** What {@link screenRefusalDetails} kept, and how many entries it could not read. */
export interface ScreenedDetails<TDetail> {
  readonly details: readonly TDetail[];
  /** Entries the target sent that this build could not read. */
  readonly malformed: number;
}

/** #5112's screen result. Kept as a name for its call sites. */
export type ScreenedRefusalDetails = ScreenedDetails<VocabularyRefusalDetail>;

/**
 * Screen `refusalDetails` out of a target region's JSON (#5112).
 *
 * ⚠️ EVERY FIELD IS FOREIGN INPUT and this value is about to be written into this
 * region's own database as `jsonb`, so it is screened rather than cast. The counters
 * one block down get the same treatment for the same reason, and the argument there
 * applies with more force here: a counter that is wrong is a number that misleads,
 * while an unscreened array is another region's arbitrary JSON persisted under a name
 * that claims a shape.
 *
 * Screening DROPS a bad entry rather than failing the migration. That is the opposite
 * polarity to the counter check, and deliberately so: an unusable COUNTER breaks
 * reconciliation, which is the guard that decides whether it is safe to delete the
 * source's data. A malformed refusal PAYLOAD does not — the count still reconciles,
 * the source's own `brain_vocabulary_edge` rows are still present for the whole grace
 * period, and aborting a cutover over an unreadable log-grade field would make this
 * improvement a new way for migrations to fail. The count of what was dropped is
 * returned so the caller can say so out loud.
 *
 * EXPORTED for its own tests. The integration path through `executeRegionMigration`
 * can only carry as many refusals as the fixture exports edges, so the cap and the
 * "every arm of the screen" cases are unreachable from there — and a cap test whose
 * input cannot exceed the cap tests nothing.
 *
 * ⚠️ DERIVED FROM THE SCHEMA SINCE #5303, not from a hand-maintained field list.
 * This function used to be the THIRD independent spelling of the eight fields — a
 * destructure, two predicate lists, and a re-built literal — coupled to
 * `VocabularyRefusalDetail` by nothing but care. It is now a per-entry
 * `safeParse` against `VocabularyRefusalDetailSchema`, which is the same eight
 * fields the route's `ImportResultSchema` publishes.
 *
 * Every clause of the old screen has an exact counterpart, and that is what makes
 * the swap behaviour-preserving rather than merely shorter:
 *
 *   - `entry === null || typeof entry !== "object" || Array.isArray(entry)` →
 *     Zod's object type check, which rejects `null`, primitives AND arrays;
 *   - the six `isStr` checks → `z.string()`;
 *   - the two `isStrOrNull` checks → `.nullable()`, which accepts `null` and
 *     rejects `undefined`. This is the distinction the old comment was written
 *     about, and it survives verbatim: a MISSING `approvedBy` is malformed
 *     because reading it as `null` would invent "auto-approved" for an entry that
 *     never said so;
 *   - the field-by-field re-build → Zod object parsing, which STRIPS undeclared
 *     keys by default. `safeParse().data` is a fresh object, so a foreign
 *     region's arbitrary extra keys still never reach this region's `jsonb`
 *     column.
 *
 * What it buys: a ninth field added to `VocabularyRefusalDetail` is a compile
 * error over in `@useatlas/schemas` (so it cannot be forgotten), and once added
 * to the schema it is screened HERE with no edit at all — which is precisely the
 * coupling the two deleted predicate lists could not provide.
 *
 * ⚠️ It is the KEY-SET pin that makes that true, not the `satisfies` — an earlier
 * version of this sentence credited the `satisfies`, and measurement says an
 * OPTIONAL ninth field passes it silently and is then stripped here. Both pins
 * live beside the schema; the reasoning and the numbers are there.
 */
export function screenRefusalDetails(raw: unknown): ScreenedRefusalDetails {
  return screenDetailsAgainst(raw, VocabularyRefusalDetailSchema);
}

/**
 * The alias-PROPOSAL screen (#5533) — {@link screenRefusalDetails}' contract on the
 * neighbouring payload. Exported for the same reason: the integration path can only
 * carry as many refusals as the fixture exports rows, so the cap arm and the
 * malformed arms are unreachable from there.
 */
export function screenProposalRefusalDetails(
  raw: unknown,
): ScreenedDetails<VocabularyProposalRefusalDetail> {
  return screenDetailsAgainst(raw, VocabularyProposalRefusalDetailSchema);
}

/** The predicate-CARDINALITY screen (#5533). See {@link screenProposalRefusalDetails}. */
export function screenCardinalityRefusalDetails(
  raw: unknown,
): ScreenedDetails<PredicateCardinalityRefusalDetail> {
  return screenDetailsAgainst(raw, PredicateCardinalityRefusalDetailSchema);
}

/**
 * The screen itself, parameterized by schema (#5533).
 *
 * ⚠️ ONE IMPLEMENTATION FOR ALL THREE PAYLOADS, and that is the #5303 lesson applied
 * a second time rather than a tidiness preference. #5303's finding was that the
 * screen had drifted from the type because it was coupled to it BY HAND; three
 * hand-copied screens over three schemas would re-create exactly that, three times
 * over, with the same failure mode — a payload silently stripped of a field that is
 * the last surviving copy of a human review decision.
 *
 * The polarity, the per-entry parse and the pre-loop `.slice()` are all
 * {@link screenRefusalDetails}' — read its docstring for why each is what it is.
 * The one thing to keep in mind here is that they now hold for three callers, so
 * changing any of them changes all three.
 */
function screenDetailsAgainst<TDetail>(
  raw: unknown,
  schema: ZodType<TDetail>,
): ScreenedDetails<TDetail> {
  if (raw === undefined || raw === null) return { details: [], malformed: 0 };
  if (!Array.isArray(raw)) return { details: [], malformed: 1 };

  const details: TDetail[] = [];
  let malformed = 0;
  // Bounded HERE as well as at the producer, and BEFORE the loop. The producer's
  // cap is a promise about a well-behaved region; this one is a property of what
  // this region will store, and the two are different guarantees — a target that
  // ignores the cap is exactly the target whose payload should not size a row in
  // this database. Slicing first is also what keeps `malformed` a statement about
  // what this region LOOKED AT: garbage past the cap is never examined, so it is
  // never counted.
  for (const entry of raw.slice(0, VOCABULARY_REFUSAL_DETAIL_CAP)) {
    // ⚠️ PER ENTRY, never `z.array(...).safeParse(raw)`. A whole-array parse fails
    // the entire array on one bad element, which would turn a single unreadable
    // payload into zero recovered refusals — the opposite of this function's
    // polarity. A bad entry is DROPPED and counted; the good ones beside it
    // survive.
    const parsed = schema.safeParse(entry);
    if (!parsed.success) {
      malformed++;
      continue;
    }
    details.push(parsed.data);
  }
  // Anything past the cap is not malformed — it is bounded. Counting it as
  // malformed would report a target bug for behaviour this build defines.
  return { details, malformed };
}

/**
 * Send an export bundle to the target region's internal import endpoint.
 *
 * Uses ATLAS_INTERNAL_SECRET for service-to-service auth. The target endpoint
 * is derived from the region's apiUrl in the residency config.
 *
 * On success it returns the target's refusal evidence (#5112, extended to the two
 * #5113 vocabulary-memory sections by #5533) — the counts AND the payloads —
 * because this is the only point at which the source ever sees them, and the
 * source is the region that schedules the delete.
 */
async function transferBundleToTarget(
  bundle: ExportBundle,
  targetApiUrl: string,
  orgId: string,
  migrationId: string,
): Promise<
  | { ok: true; refusals: MigrationRefusalEvidence }
  | { ok: false; error: string }
> {
  const secret = process.env.ATLAS_INTERNAL_SECRET;
  if (!secret) {
    return { ok: false, error: "ATLAS_INTERNAL_SECRET is not configured — cannot authenticate cross-region transfer" };
  }

  const url = `${targetApiUrl.replace(/\/+$/, "")}/api/v1/internal/migrate/import`;

  log.info({ migrationId, targetApiUrl: url, orgId }, "Transferring bundle to target region");

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Atlas-Internal-Token": secret,
      },
      body: JSON.stringify({ ...bundle, orgId }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Network error connecting to target region: ${msg}` };
  }

  if (!response.ok) {
    let detail: string;
    try {
      const body = await response.json() as { message?: string; error?: string };
      detail = body.message ?? body.error ?? `HTTP ${response.status}`;
    } catch {
      // intentionally ignored: response body may not be JSON (e.g. reverse proxy HTML error)
      detail = `HTTP ${response.status} ${response.statusText}`;
    }
    return { ok: false, error: `Target region import failed: ${detail}` };
  }

  // A 200 is not proof the target understood the bundle. An older build's
  // `importBundle` simply has no loop for a section it doesn't know about: it
  // ignores those keys, imports the rest, and answers 200 — after which this
  // migration cuts over and schedules the destructive source cleanup. The
  // dropped pillar is then deleted from the source after the grace period,
  // with no error logged anywhere. (On the ADMIN import route the same outcome
  // arrives one step earlier, because its zod request schema strips unknown
  // keys before the importer ever sees them.)
  //
  // Before #4767 the bundle VERSION was the guard: a v1 target rejected a v2
  // bundle outright. The brain sections are deliberately optional-on-the-wire
  // (so a pre-#4767 SOURCE can still migrate), which removes that guard —
  // this reconciliation replaces it, and generalizes to every future section.
  //
  // Deployment reality that makes this a live hazard rather than a theoretical
  // one: regions deploy independently, so a window where US has #4767 and EU
  // does not is routine, not exceptional.
  // `refused` is #5036's third vocabulary counter. Every field is optional here
  // regardless of what the local `ImportResult` requires, because this is
  // another region's JSON and possibly another region's BUILD.
  //
  // `refusalDetails` is #5112's payload, and it is typed `unknown` rather than
  // `VocabularyRefusalDetail[]` on purpose: a declared array type here would let
  // the rest of this function index into another region's JSON as though the
  // shape were proven. `screenRefusalDetails` is where it becomes a type.
  let acknowledged: Partial<
    Record<
      (typeof RECONCILED_SECTIONS)[number],
      { imported?: number; skipped?: number; refused?: number; refusalDetails?: unknown }
    >
  >;
  try {
    acknowledged = await response.json() as typeof acknowledged;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Target region returned an unreadable import result: ${msg}` };
  }
  if (!acknowledged || typeof acknowledged !== "object" || Array.isArray(acknowledged)) {
    return {
      ok: false,
      error:
        "Target region returned a non-object import result — it is most likely not an Atlas " +
        `import endpoint (or a proxy answered in its place). Migration ${migrationId} aborted ` +
        "BEFORE cutover; no source data has been deleted.",
    };
  }

  // ⚠️ DERIVED FROM THE WIRE TYPE, not spelled as a literal — this file's own
  // idiom, and for its own reason. `RECONCILED_SECTIONS`' two-sided pin exists
  // because "adding a section and forgetting to reconcile it is a silent
  // no-op"; adding a REFUSAL OUTCOME to a second section is the same shape, and
  // a hard-coded `section === "brainVocabularyEdges"` would be guarded only by a
  // runtime warn that fires during a live migration, AFTER the target has
  // already committed a partial import. Declared this way, a second section
  // growing `refused` is a COMPILE error that forces the
  // accounting-versus-loss decision to be made deliberately.
  const _refusalSectionsReviewed: [
    Exclude<RefusalCapableSection, (typeof REFUSAL_ACCOUNTING)[number]>,
  ] extends [never]
    ? true
    : never = true;
  void _refusalSectionsReviewed;

  // #5112. Accumulated inside the loop so it uses the counter the loop has
  // already validated as a non-negative integer, rather than re-reading the raw
  // JSON and re-deciding whether to trust it.
  //
  // ⚠️ THIS INITIALIZER IS LOAD-BEARING, not a placeholder. A bundle that carried
  // zero alias edges never reaches the capture block — the loop `continue`s on
  // `expected === 0` — so `refused: 0` here is what gets recorded, and it is what
  // makes a later NULL on the column mean "this build never asked" rather than "we
  // forgot". Zero is the honest value in that case: a source that exported no edges
  // cannot have had one refused.
  //
  // ⚠️ ALL THREE INITIALIZED, for the reason above applied per section (#5533): a
  // bundle can carry edges and no proposals, or the reverse, and the section the
  // bundle did not carry must still record a `0` rather than leaving its column
  // NULL — NULL is reserved for "this build never asked".
  let vocabularyEdges: RefusalEvidence<VocabularyRefusalDetail> = { refused: 0, details: [], malformedDetails: 0 };
  let vocabularyProposals: RefusalEvidence<VocabularyProposalRefusalDetail> = { refused: 0, details: [], malformedDetails: 0 };
  let predicateCardinalities: RefusalEvidence<PredicateCardinalityRefusalDetail> = { refused: 0, details: [], malformedDetails: 0 };

  for (const section of RECONCILED_SECTIONS) {
    // Ground truth from the payload where the section IS a top-level array;
    // the manifest is a self-report written in a different literal, so a
    // forgotten `counts:` line would otherwise turn the guard off for that
    // section without anyone noticing. `brainFacts` is the one section with no
    // top-level array (facts nest inside their episode), so it necessarily
    // trusts the manifest.
    const payload = (bundle as unknown as Record<string, unknown>)[section];
    const declared = bundle.manifest.counts[section];
    const expected = Array.isArray(payload) ? payload.length : declared;
    // The manifest is what both regions LOG and what the CLI prints, so a
    // divergence between it and the payload must not pass unremarked even
    // though reconciliation trusts the payload.
    if (Array.isArray(payload) && declared !== undefined && declared !== payload.length) {
      log.warn(
        { migrationId, section, declared, actual: payload.length },
        "Manifest count disagrees with the exported payload — reconciling against the payload; this is an exporter bug",
      );
    }
    if (expected === undefined) {
      return {
        ok: false,
        error:
          `Bundle section '${section}' carries no manifest count, so the target's handling of ` +
          `it cannot be verified. Migration ${migrationId} aborted BEFORE cutover; no source ` +
          "data has been deleted. This is an exporter bug — the section needs a manifest count.",
      };
    }
    if (expected === 0) {
      // ⚠️ NOT SILENT ANY MORE. Nothing exported means nothing to reconcile, and
      // that is still true — a source that sent zero rows cannot lose any. But
      // `continue` also skipped the counter validation and, since #5112, the refusal
      // capture, so a target answering `{imported: 0, skipped: 0, refused: 7}` for a
      // section the bundle carried NOTHING of was discarded without a word. This
      // block's own comment calls that shape "either a target bug or a section that
      // grew a refusal without anyone revisiting … Both are worth a human's
      // attention" — and this was the one path where the attention was switched off.
      //
      // Still a `continue`, not a return: the arithmetic is unaffected and failing a
      // cutover over a counter about rows that do not exist would be the
      // over-reaction this whole block is careful to avoid elsewhere.
      const idle = acknowledged[section];
      const claimed = (idle?.imported ?? 0) + (idle?.skipped ?? 0) + (idle?.refused ?? 0);
      if (claimed !== 0) {
        log.warn(
          { migrationId, section, imported: idle?.imported, skipped: idle?.skipped, refused: idle?.refused },
          "Target region reported non-zero counters for a section the bundle carried NOTHING of " +
            "— not reconciled (there is nothing to reconcile) and not fatal, but it means the " +
            "target is counting rows this bundle did not send. Check both builds.",
        );
      }
      continue;
    }
    const got = acknowledged[section];

    // ⚠️ `refused` IS ACCOUNTING, NOT LOSS — but ONLY for the one section that
    // can produce it, and the scoping is the whole point (ADR-0037 §8 §4).
    //
    // This guard asks one question: did the target ACCOUNT for every row the
    // bundle carried, or did it silently drop a section it does not understand?
    // A refused vocabulary edge is accounted for — the target looked at it,
    // decided applying it would close a cycle or take a second parent, logged
    // enough to re-author it by hand, and carried on. Left out of the sum
    // entirely, the FIRST genuinely conflicting alias edge in a workspace would
    // abort an entire cutover and blame an old target build.
    //
    // ⚠️ ADDING IT FOR EVERY SECTION IS THE WRONG FIX, and it was this slice's
    // own first cut. Only the sections in `REFUSAL_ACCOUNTING` can refuse —
    // `brainVocabularyEdges` when this was written; the two #5113 vocabulary-
    // memory sections since. A blanket `+ (got?.refused ?? 0)` means a target that
    // answers `brainFacts: {imported: 0, skipped: 0, refused: 40}` — through a
    // bug, a proxy, or a future section half-implemented in one region —
    // reconciles CLEAN, cuts over, and the source cleanup then deletes 40 facts
    // that were never imported. That is exactly the silently-dropped-a-section
    // event this block exists to prevent, re-opened by one key.
    //
    // So the term is section-scoped, and an unexpected `refused` elsewhere is
    // surfaced rather than ignored: it is either a target bug or a section that
    // grew a refusal without anyone revisiting whether ITS refusal is also
    // accounting rather than loss. Both are worth a human's attention, and
    // neither is worth failing a cutover over on its own — the count still has
    // to reconcile without it, which is the conservative reading.
    // ⚠️ EVERY COUNTER IS FOREIGN INPUT. `acknowledged` is `as`-cast from another
    // region's JSON and only its top level is shape-checked, so a counter can be
    // negative, fractional or NaN. Negative is the one that FAILS OPEN: a target
    // answering `{imported: 12, skipped: 0, refused: -2}` against an expected 10
    // sums to exactly 10, reconciles clean, and cuts over while having imported
    // two rows more than the bundle carried — and `refused > 0` is false, so the
    // disclosure below stays silent too. Refusing an unusable counter outright
    // is the conservative reading, and it is the same polarity as the rest of
    // this block: a count that cannot be trusted is not a count.
    const counters = { imported: got?.imported, skipped: got?.skipped, refused: got?.refused };
    for (const [name, value] of Object.entries(counters)) {
      if (value === undefined) continue;
      if (!Number.isInteger(value) || value < 0) {
        return {
          ok: false,
          error:
            `Target region reported an unusable '${name}' counter (${String(value)}) for section ` +
            `'${section}' — counters must be non-negative whole numbers. Migration ${migrationId} ` +
            "aborted BEFORE cutover; no source data has been deleted. This is a target bug: a " +
            "counter that cannot be trusted cannot reconcile the section it describes.",
        };
      }
    }

    const refused = got?.refused ?? 0;
    const disclosure = refusalDisclosureFor(section);
    const refusalIsAccounting = disclosure !== undefined;
    if (refused > 0 && !refusalIsAccounting) {
      log.warn(
        { migrationId, section, refused },
        "Target region reported REFUSED rows for a section that cannot refuse any — not counted " +
          "toward reconciliation. Either the target is buggy or this section grew a refusal " +
          "outcome whose accounting nobody has reviewed.",
      );
    }
    const total = (got?.imported ?? 0) + (got?.skipped ?? 0) + (refusalIsAccounting ? refused : 0);
    if (total !== expected) {
      // ⚠️ THE EVIDENCE BELONGS IN THE ERROR, not only in the warn above. This
      // string is the DURABLE operator-facing surface — it lands in
      // `region_migrations.error_message` and is what the API and the CLI
      // render — while the warn is an ephemeral line in a stream nobody may
      // read. Without this clause the channel an operator is guaranteed to see
      // carries only the GUESS ("version skew, check both builds") while the
      // channel they may never open carries the actual cause.
      const anomaly =
        refused > 0 && !refusalIsAccounting
          ? ` The target also reported refused=${refused} for '${section}', which has no refusal ` +
            `outcome in this build — that is the likely cause rather than a dropped section.`
          : "";
      return {
        ok: false,
        error:
          `Target region accounted for ${got ? total : 0}/${expected} '${section}' rows.${anomaly} ` +
          `The most likely cause is a version skew between this region and the target — ` +
          `EITHER an older target that does not understand this bundle section and dropped it, ` +
          `OR an older SOURCE (this region) that does not understand a counter the target ` +
          `reported. Check both builds before upgrading either. Migration ${migrationId} ` +
          `aborted BEFORE cutover — no source data has been deleted and the workspace is still ` +
          `served from its current region. ` +
          `NOTE: the target has already COMMITTED a partial import; the import is idempotent, ` +
          `so align the builds and re-run, or tear down the partial copy if abandoning.`,
      };
    }

    // ⚠️ THE SOURCE SIDE HAS TO SAY THIS OUT LOUD, and until #5036's review it
    // did not. `refused` was consumed by the sum above and discarded — the only
    // record of a dropped human decision was a `log.warn` in the TARGET
    // region's process, which the operator driving the cutover is not watching.
    // Meanwhile THIS region schedules the source cleanup (`cleanupAfter`), and
    // after the grace period the source's own `brain_vocabulary_edge` rows are
    // DELETED. So the durable record of N approved review decisions would have
    // been log lines in another region, outliving the data by only as long as
    // that region's retention.
    //
    // Pre-#5036 the same input failed the import outright and nothing was ever
    // scheduled for deletion. Refusing gracefully is the right call; doing it
    // without telling the side that owns the delete timer is not.
    // ⚠️ THE PAYLOADS ARE READ HERE, BEFORE THE DISCLOSURE BELOW AND BEFORE
    // CUTOVER (#5112). `refused > 0` is not the condition: a target that refuses
    // nothing still tells us `0`, and recording that `0` is what makes a later
    // NULL on the column mean "this build never asked" rather than "we forgot".
    //
    // ⚠️ THREE SECTIONS SINCE #5533, one branch each rather than a shared loop over
    // a table of screens. Each screen returns a DIFFERENT payload type and each
    // result lands in a differently-typed variable, so a table would have to erase
    // all three to `unknown` — which is the one thing the screens exist to prevent.
    // The repetition is three lines; the shared half (the two warns, and the
    // evidence it builds) is `captureRefusalPayloads`.
    //
    // ⚠️ EACH ARM ASSIGNS BOTH, and `captured` is NOT re-derived from `section`
    // afterwards. It was, in this change's first cut: a second `section === …`
    // ternary spelling the same mapping a second time, with nothing tying the two
    // together. That is the defect this very change removed one block down — the
    // hard-coded `section === "brainVocabularyEdges" ? … : undefined` that left
    // `detailsRecorded` and `malformedDetails` `undefined` on every other
    // section — reintroduced by its own fix. A fourth payload section added to the
    // chain and missed in the ternary would set `disclosure.column`, so the warn
    // would tell the operator to "read `detailsRecorded` on this line first" while
    // that field was absent: a recovery instruction naming a field that is not
    // there, which is the same defect as one naming an empty column. One
    // assignment per arm makes the two impossible to disagree.
    let captured: RefusalEvidence<unknown> | undefined;
    if (section === "brainVocabularyEdges") {
      captured = vocabularyEdges = captureRefusalPayloads(
        migrationId, section, refused, screenRefusalDetails(got?.refusalDetails),
      );
    } else if (section === "brainVocabularyProposals") {
      captured = vocabularyProposals = captureRefusalPayloads(
        migrationId, section, refused, screenProposalRefusalDetails(got?.refusalDetails),
      );
    } else if (section === "brainPredicateCardinalities") {
      captured = predicateCardinalities = captureRefusalPayloads(
        migrationId, section, refused, screenCardinalityRefusalDetails(got?.refusalDetails),
      );
    }
    // `undefined` means this section has no payload contract — every section in
    // `RECONCILED_SECTIONS` except the three above, which includes the one
    // refusal-ACCOUNTING section that carries no payloads
    // (`brainSlackChannelExclusions`). The numbers and the recovery clause below
    // both key off it being present, so a payload-less section is never told to
    // read a field that is not on its line.

    if (disclosure && refused > 0) {
      log.warn(
        {
          migrationId,
          section,
          refused,
          // #5112 — the three numbers that say how much of this loss has a
          // payload on THIS side. `detailsRecorded < refused` is the operator's
          // signal that the source's own rows are the only copy for some of it,
          // and `malformedDetails > 0` separates "the target sent something this
          // build cannot read" from the documented cap.
          detailsRecorded: captured?.details.length,
          malformedDetails: captured?.malformedDetails,
        },
        // ⚠️ CONDITIONAL TENSE, and it points at THIS region's own data.
        //
        // Two corrections, both caught by asking whether this fix reproduces the
        // defect it fixes. First: it runs in phase 2, BEFORE cutover and before
        // cleanup is scheduled, either of which can still fail — so stating "the
        // source copy is deleted" as fact is the same over-report the target-side
        // warn was just rewritten to avoid, one module over and in the same
        // commit. Second, and worse: it used to say "retrieve them from the
        // TARGET's logs", making another region's log retention the recovery
        // PATH — the artifact this disclosure exists because it is NOT
        // sufficient. The target log is still NAMED, because it is where the
        // per-edge detail lives; what changed is that this region's own rows are
        // named first and called the copy that needs no cooperation.
        //
        // The source does not need them. It still HOLDS its own rows, in its own
        // database, for the whole grace period — the operator's job is to look
        // before the window closes, not to go reading a foreign log stream.
        //
        // ⚠️ PER-SECTION SINCE #5533, not one sentence about alias edges. Three of
        // the four accounting sections now refuse rows out of three DIFFERENT
        // tables, and a disclosure that names `brain_vocabulary_edge` while
        // reporting a refused predicate-cardinality decision sends the operator to
        // a table that does not hold it — which is the same defect as naming an
        // empty column, one step earlier.
        `Target region REFUSED ${disclosure.subject} during import — that many ` +
          `${disclosure.decisions} will NOT be applied in the destination. If this migration ` +
          `completes, THIS region's own ${disclosure.sourceTable} rows are deleted once the ` +
          "cleanup grace period expires: export or re-author them from this region's database " +
          "before then. Which specific rows were refused is logged in the target region. The " +
          `full set is also still in THIS region's own ${disclosure.sourceTable} until cleanup ` +
          "runs, and that is the copy that needs no cooperation from anyone." +
          // ⚠️ SECTION-SCOPED, because `detailsRecorded` is only populated for the
          // sections with a payload contract — this warn is shared with
          // `brainSlackChannelExclusions`, whose `refused` is structurally zero today
          // but which would otherwise be told to read a field that is not on its line.
          // A recovery instruction naming an absent field is the same defect as one
          // naming an empty column.
          (disclosure.column
            ? " Whatever payloads the target returned are recorded on THIS migration's " +
              `region_migrations row (${disclosure.column}), which is platform-classified and ` +
              "outlives the cleanup — but read `detailsRecorded` on this line first: it is how " +
              "many actually landed here, and a target predating the payload contract reports a " +
              "count with none."
            : ""),
      );
    }
  }

  return {
    ok: true,
    refusals: { vocabularyEdges, vocabularyProposals, predicateCardinalities },
  };
}

/**
 * Build one section's refusal evidence out of a screen result, and say out loud
 * anything the screen found wrong with the target's payload (#5112, #5533).
 *
 * ⚠️ TWO WARNS THAT DO NOT DEPEND ON `refused > 0`, because both describe a TARGET
 * BUG rather than a loss, and a target bug is worth saying out loud whether or not
 * anything was refused. Round 1 of #5112's review found both numbers computed and
 * then discarded unless the disclosure fired — so a target answering `refused: 0`
 * with a garbage `refusalDetails` produced a count in hand and not one byte of
 * signal.
 */
function captureRefusalPayloads<TDetail>(
  migrationId: string,
  section: string,
  refused: number,
  screened: ScreenedDetails<TDetail>,
): RefusalEvidence<TDetail> {
  if (screened.malformed > 0) {
    log.warn(
      { migrationId, section, refused, malformedDetails: screened.malformed },
      "Target region sent refusal payloads this build could not read — they were DROPPED " +
        "rather than stored, which is the right polarity (the count still reconciles and the " +
        "source keeps its own rows) but it is a bug in the target region: its payload does " +
        "not match the contract it answered on.",
    );
  }
  // The inverse of the load-bearing `details.length < refused` comparison. More
  // payloads than the target's own count contradicts itself, and this module
  // already refuses an unusable COUNTER on the reasoning that a count which
  // cannot be trusted is not a count — the same argument applies to a payload
  // set that disagrees with the count beside it. Not fatal: the count is the
  // reconciled value and the extra payloads are merely stored.
  if (screened.details.length > refused) {
    log.warn(
      { migrationId, section, refused, detailsRecorded: screened.details.length },
      "Target region sent MORE refusal payloads than its own refused counter — target bug. " +
        "The counter is what reconciles and what the audit trail records; the surplus " +
        "payloads are stored as-is.",
    );
  }
  return { refused, details: screened.details, malformedDetails: screened.malformed };
}

/**
 * Record the target's refusal evidence on the SOURCE's own migration row (#5112,
 * extended to the two #5113 vocabulary-memory sections by #5533).
 *
 * This is the durability step the whole issue is about. Everything else in this
 * flow is a log line or a counter; `region_migrations` is `platform`-classified in
 * `bundle-scope.ts`, so `runSourceCleanupSweep` never deletes it — which makes
 * these six columns the one artifact that outlives the grace-period delete of the
 * `brain_vocabulary_edge`, `brain_vocabulary_proposal` and
 * `brain_predicate_cardinality` rows they describe.
 *
 * ## ONE STATEMENT, SIX COLUMNS
 *
 * Not three writes. Three would open a window in which one section's evidence is
 * durable and another's is not, and the abort decision below is made against the
 * TOTAL — so a partial write would have to be either re-attempted or reasoned about
 * per section, for no gain. One `UPDATE` either lands the whole record or lands
 * none of it, which is the only state its caller (`executeRegionMigration`) can act
 * on.
 *
 * ## Failing here ABORTS the migration when there is something to lose
 *
 * The polarity is chosen against the irreversible act, exactly as
 * `transferBundleToTarget`'s counter check is. Continuing past a failed write with
 * anything refused would cut over and schedule the destructive cleanup while the
 * only durable record of N human decisions is a log line in another region — the
 * precise state this issue exists to remove, re-entered through the error path.
 * Throwing here happens BEFORE cutover, so nothing is deleted and the workspace is
 * still served from this region.
 *
 * ⚠️ The threshold is the SUM across all three sections, not the edge count. A
 * migration that refused no edges and three predicate-cardinality decisions has
 * exactly as much to lose, and reading only `vocabularyEdges.refused` here would
 * carry on past a failed write for it — silently re-opening the hole for the two
 * sections #5533 exists to close.
 *
 * With nothing refused anywhere a failed write costs a `0` nobody will act on, so it
 * warns and carries on: a migration that is going to lose nothing should not fail on
 * the bookkeeping for the loss.
 *
 * ## Exported for its own real-Postgres test, and that is not a convenience.
 *
 * Both existing halves of this feature's coverage are hand-written statements ABOUT
 * these columns: the mock suite greps `capturedQueries` for a substring and
 * inspects `params` without ever executing the SQL, and the pg falsifier seeds the
 * row with its own `INSERT`. So a typo'd column name, a missing `::jsonb` cast, or a
 * dropped `JSON.stringify` was invisible to both — measured: renaming the column in
 * this statement to `vocabulary_refusals_json` left every test green, while in
 * production it makes this function throw and (because a refusal aborts) fails EVERY
 * migration that carries one.
 *
 * `migrate-roundtrip-pg.test.ts` drives this function against the migrated schema,
 * which is the only thing that confronts the statement with the real table.
 */
export async function recordMigrationRefusals(
  migrationId: string,
  evidence: MigrationRefusalEvidence,
): Promise<void> {
  const { vocabularyEdges, vocabularyProposals, predicateCardinalities } = evidence;
  const totalRefused =
    vocabularyEdges.refused + vocabularyProposals.refused + predicateCardinalities.refused;
  try {
    await internalQuery(
      `UPDATE region_migrations
          SET vocabulary_edges_refused = $2,
              vocabulary_refusals = $3::jsonb,
              vocabulary_proposals_refused = $4,
              vocabulary_proposal_refusals = $5::jsonb,
              predicate_cardinalities_refused = $6,
              predicate_cardinality_refusals = $7::jsonb
        WHERE id = $1`,
      [
        migrationId,
        vocabularyEdges.refused,
        // `null` rather than `'[]'` when there is nothing to record, so a query
        // for "migrations with recoverable payloads" is `IS NOT NULL` and does not
        // have to know that an empty array means the same thing.
        jsonbPayload(vocabularyEdges.details),
        vocabularyProposals.refused,
        jsonbPayload(vocabularyProposals.details),
        predicateCardinalities.refused,
        jsonbPayload(predicateCardinalities.details),
      ],
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (totalRefused > 0) {
      // ⚠️ THE DRIVER TEXT GOES TO THE LOG, NEVER INTO THE THROWN MESSAGE — and the
      // first version of this did interpolate it, which was the leak this whole
      // scrubbing discussion is about, committed by the fix for it.
      //
      // Whatever is thrown here is caught by `executeRegionMigration`, written to
      // `region_migrations.error_message`, and served VERBATIM to a workspace admin by
      // `admin-residency.ts`'s `failed` arm. `errorMessage`'s scrub is credential-URI
      // only — it rewrites `scheme://user:pass@host` and leaves
      // `connect ECONNREFUSED 10.0.3.7:5432`, a pg `DETAIL: Key (…)=(…)` row fragment,
      // and internal column spellings untouched. So scrubbing downstream is not
      // sufficient for a pg error, and the only reliable answer is not to put driver
      // text on a customer-served field in the first place.
      //
      // Nothing is lost operationally: the raw message is right here at `error` level
      // with the `migrationId` as the join key, which is the same split the import
      // routes' 500s already use (generic body, `requestId` as the handle).
      log.error(
        {
          err: message,
          migrationId,
          refused: totalRefused,
          // Broken out, because the three losses have three different recovery
          // paths and an operator reading this needs to know which table to look in.
          vocabularyEdgesRefused: vocabularyEdges.refused,
          vocabularyProposalsRefused: vocabularyProposals.refused,
          predicateCardinalitiesRefused: predicateCardinalities.refused,
        },
        "Failed to record refused vocabulary decisions on the migration row — aborting before cutover",
      );
      throw new Error(
        `Failed to record ${totalRefused} refused vocabulary decision(s) on the migration row. ` +
          `Migration ${migrationId} aborted BEFORE cutover; no source data has been deleted and the ` +
          `workspace is still served from this region. Continuing would schedule the source cleanup ` +
          `with no durable record of the refused decisions — the target region's log would be the ` +
          `only copy, and it outlives the data by only as long as that region's log retention. ` +
          `The underlying database error is recorded server-side against this migration id.`,
      );
    }
    log.warn(
      { err: message, migrationId },
      "Could not record the vocabulary-refusal bookkeeping on the migration row — nothing was " +
        "refused, so no recovery payload was lost; continuing",
    );
  }
}

/**
 * A payload array as a `jsonb` parameter, or `null` when there is nothing to record.
 *
 * `null` rather than `'[]'`, so a query for "migrations with recoverable payloads"
 * is `IS NOT NULL` and does not additionally have to know that an empty array means
 * the same thing.
 *
 * ⚠️ ONE READER FOLDS THE TWO TOGETHER, ACROSS ALL THREE COLUMNS (#5557).
 * `cleanup.ts`'s delete-time audit selects `COALESCE(jsonb_array_length(<column>),
 * 0)` for each payload column named in `REFUSAL_DISCLOSURE` — so `NULL` and `'[]'`
 * arrive as the same `0`, which is the only reading that makes this convention free
 * to choose: both mean "no payload is recoverable from this row", and the operator
 * message keyed off that `0` is the same sentence either way.
 *
 * That fold is what the convention BUYS, not a caveat on it. The distinction the
 * `null` preserves is for the other query — "which migrations still hold a
 * recoverable payload", an `IS NOT NULL` per column that does not have to know an
 * empty array means the same thing.
 *
 * Stated exactly because an earlier version of this comment claimed `cleanup.ts`
 * reads "these columns" while it read one of the three, and the correction that
 * replaced it recorded the gap as a deferral. Both are now stale: the reader is
 * `DELETE_TIME_REFUSAL_SECTIONS` in `cleanup.ts`, keyed on
 * `PayloadCarryingRefusalSection` above, and a fourth payload column cannot ship
 * without one.
 */
function jsonbPayload(details: readonly unknown[]): string | null {
  return details.length === 0 ? null : JSON.stringify(details);
}

// ---------------------------------------------------------------------------
// Core executor
// ---------------------------------------------------------------------------

/**
 * Execute a region migration by ID.
 *
 * Transitions: pending → in_progress → completed/failed.
 *
 * Phase 1 (Export): Builds an ExportBundle from the source region's internal DB.
 * Phase 2 (Transfer): POSTs the bundle to the target region's import endpoint.
 * Phase 3 (Cutover): Updates organization.region, flushes caches.
 * Phase 4 (Cleanup): Schedules source data cleanup after the grace period.
 *
 * On failure at any phase, records the error and leaves the region unchanged.
 */
export async function executeRegionMigration(
  migrationId: string,
): Promise<MigrationResult> {
  if (!hasInternalDB()) {
    log.warn({ migrationId }, "Migration skipped — internal database not available");
    return { success: false, migrationId, error: "Internal database not available" };
  }

  // Load migration record
  const rows = await internalQuery<{
    id: string;
    workspace_id: string;
    source_region: string;
    target_region: string;
    status: string;
  }>(
    `SELECT id, workspace_id, source_region, target_region, status
     FROM region_migrations WHERE id = $1`,
    [migrationId],
  );

  const migration = rows[0];
  if (!migration) {
    log.warn({ migrationId }, "Migration skipped — record not found");
    return { success: false, migrationId, error: "Migration not found" };
  }

  if (migration.status !== "pending") {
    log.warn({ migrationId, status: migration.status }, "Migration skipped — not in pending status");
    return {
      success: false,
      migrationId,
      error: `Migration is "${migration.status}", expected "pending"`,
    };
  }

  const { workspace_id: workspaceId, source_region: sourceRegion, target_region: targetRegion } = migration;

  // Mark as in_progress — workspace is now read-only
  log.info({ migrationId, workspaceId, sourceRegion, targetRegion, step: MIGRATION_STEPS.validating }, "Migration starting");
  await updateMigrationStatus(migrationId, "in_progress");

  logMigrationEvent("region_migration_started", migrationId, {
    workspaceId,
    sourceRegion,
    targetRegion,
  });

  // Track whether region was updated — declared outside try so the catch block can access it
  let regionUpdated = false;

  try {
    // ── Phase 1: Export ──────────────────────────────────────────────
    log.info({ migrationId, step: MIGRATION_STEPS.exporting }, "Phase 1: Exporting workspace data");

    const bundle = await exportWorkspaceBundle(workspaceId, `region-migration:${sourceRegion}`);

    log.info(
      { migrationId, counts: bundle.manifest.counts },
      "Phase 1 complete: workspace data exported",
    );

    // ── Phase 2: Transfer ────────────────────────────────────────────
    log.info({ migrationId, step: MIGRATION_STEPS.transferring }, "Phase 2: Transferring to target region");

    const config = getConfig();
    const targetRegionConfig = config?.residency?.regions[targetRegion];
    const targetApiUrl = targetRegionConfig?.apiUrl;

    if (!targetApiUrl) {
      throw new Error(
        `Target region "${targetRegion}" has no apiUrl configured — ` +
        `cannot transfer data. Add apiUrl to the region config in atlas.config.ts.`,
      );
    }

    const transferResult = await transferBundleToTarget(bundle, targetApiUrl, workspaceId, migrationId);
    if (!transferResult.ok) {
      throw new Error(transferResult.error);
    }

    // ⚠️ PERSISTED BEFORE CUTOVER, not in Phase 4 beside the cleanup schedule
    // (#5112). The refusals are a fact about the TARGET's response and are known
    // the instant Phase 2 returns; deferring the write to Phase 4 would leave a
    // window where the target has committed a partial import — refusals included
    // — and the source holds no record of it, which is exactly the window a
    // cutover failure lands in. Writing here means the record exists even for a
    // migration that never completes, and `recordMigrationRefusals` throwing
    // aborts while nothing has been deleted.
    await recordMigrationRefusals(migrationId, transferResult.refusals);
    const vocabularyEdgesRefused = transferResult.refusals.vocabularyEdges.refused;
    const vocabularyProposalsRefused = transferResult.refusals.vocabularyProposals.refused;
    const predicateCardinalitiesRefused = transferResult.refusals.predicateCardinalities.refused;

    log.info(
      {
        migrationId,
        vocabularyEdgesRefused,
        vocabularyProposalsRefused,
        predicateCardinalitiesRefused,
      },
      "Phase 2 complete: data transferred to target region",
    );

    // ── Phase 3: Cutover ─────────────────────────────────────────────
    log.info({ migrationId, step: MIGRATION_STEPS.cutting_over }, "Phase 3: Updating region assignment");

    const pool = getInternalDB();
    const updateResult = await pool.query(
      `UPDATE organization SET region = $1, region_assigned_at = now()
       WHERE id = $2 RETURNING id`,
      [targetRegion, workspaceId],
    );

    if (updateResult.rows.length === 0) {
      throw new Error(`Workspace "${workspaceId}" not found in organization table`);
    }
    regionUpdated = true;

    // Persist the cutover happy-path before flush/Phase 4 can throw so the
    // column reflects reality the instant the destination takes ownership.
    // If this UPDATE itself fails, the failure-path catch (below) re-stamps
    // from the local `regionUpdated` flag via updateMigrationStatus, so
    // both write paths converge on the same column value — the guard's
    // correctness does not depend on this UPDATE succeeding.
    await internalQuery(
      `UPDATE region_migrations SET region_updated = TRUE WHERE id = $1`,
      [migrationId],
    );

    // Purge exactly the migrated Workspace's cached entries — not the whole
    // region's. A residency cutover moves one Workspace; co-tenants sharing this
    // process must keep their warm entries. (`workspaceId` is the organization
    // id, which is the `orgId` the Query Cache keys + scope-tags by.)
    try {
      const { flushCacheByOrg } = await import("@atlas/api/lib/cache/index");
      const purged = await flushCacheByOrg(workspaceId);
      log.info({ migrationId, workspaceId, purged }, "Workspace cache purged during migration");
    } catch (cacheErr) {
      log.warn(
        { err: cacheErr instanceof Error ? cacheErr.message : String(cacheErr), migrationId },
        "Cache purge failed during migration (non-fatal)",
      );
    }

    log.info({ migrationId }, "Phase 3 complete: region updated and Workspace cache purged");

    // ── Phase 4: Schedule cleanup ────────────────────────────────────
    log.info({ migrationId, step: MIGRATION_STEPS.scheduling_cleanup }, "Phase 4: Scheduling source data cleanup");

    const cleanupAfter = new Date();
    cleanupAfter.setDate(cleanupAfter.getDate() + CLEANUP_GRACE_PERIOD_DAYS);

    logMigrationEvent("region_migration_cleanup_scheduled", migrationId, {
      workspaceId,
      sourceRegion,
      cleanupAfter: cleanupAfter.toISOString(),
      gracePeriodDays: CLEANUP_GRACE_PERIOD_DAYS,
      // ⚠️ THIS IS THE EVENT THE COUNT BELONGS ON (#5112). It fires for the exact
      // 7-day timer the refusal disclosure names, so the audit channel now carries
      // the deadline and what expires with it in one record — instead of a bare
      // `log.warn` in phase 2 sitting beside an audit event built for this. A
      // non-zero value here means the delete this event schedules is what makes
      // the source's copies unrecoverable.
      //
      // ⚠️ ALL THREE SINCE #5533. This event names the timer, and the timer now
      // expires three tables' worth of curated decisions, not one — reporting only
      // the edges here would understate exactly what the delete makes permanent.
      vocabularyEdgesRefused,
      vocabularyRefusalDetailsRecorded: transferResult.refusals.vocabularyEdges.details.length,
      vocabularyProposalsRefused,
      vocabularyProposalRefusalDetailsRecorded:
        transferResult.refusals.vocabularyProposals.details.length,
      predicateCardinalitiesRefused,
      predicateCardinalityRefusalDetailsRecorded:
        transferResult.refusals.predicateCardinalities.details.length,
    });

    log.info(
      { migrationId, cleanupAfter: cleanupAfter.toISOString(), gracePeriodDays: CLEANUP_GRACE_PERIOD_DAYS },
      "Phase 4 complete: cleanup scheduled",
    );

    // ── Finalize ─────────────────────────────────────────────────────
    const completedAt = new Date().toISOString();
    await updateMigrationStatus(migrationId, "completed", { completedAt });

    logMigrationEvent("region_migration_completed", migrationId, {
      workspaceId,
      sourceRegion,
      targetRegion,
      // #5112 — on the completion event too, not only on the cleanup one. The two
      // answer different questions and an operator reads them at different times:
      // "did this migration lose any curated decisions" is a property of the
      // migration, and it must be answerable from the terminal event without
      // correlating back to the scheduling event that preceded it. All three
      // sections since #5533, on the scheduling event's reasoning.
      vocabularyEdgesRefused,
      vocabularyProposalsRefused,
      predicateCardinalitiesRefused,
    });

    log.info({ migrationId, workspaceId, sourceRegion, targetRegion, completedAt, vocabularyEdgesRefused }, "Migration completed successfully");

    return { success: true, migrationId, vocabularyEdgesRefused };
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err);

    // ⚠️ SCRUBBED FOR THE DURABLE FIELD, RAW FOR THE LOG (#5112 panel round 1).
    //
    // `failureMessage` below is not just a log string: it is written to
    // `region_migrations.error_message` and returned VERBATIM to a workspace admin
    // by `admin-residency.ts`'s `failed` arm. So every message that can reach this
    // catch is customer-readable.
    //
    // ⚠️ AND THE SCRUB IS NOT SUFFICIENT ON ITS OWN — stated exactly, because an
    // earlier version of this comment claimed it closed a hazard it does not.
    // `errorMessage` rewrites `scheme://user:pass@host` and NOTHING ELSE, so
    // `connect ECONNREFUSED 10.0.3.7:5432`, a pg `DETAIL: Key (…)=(…)` row fragment
    // and internal column spellings all survive it. It is a floor, not a filter.
    //
    // What actually keeps driver text off this field is the throw sites not putting it
    // there: `recordMigrationRefusals` (#5112, #5533) logs the DB error at `error` and throws
    // a message with none of it. `transferBundleToTarget`'s `Network error connecting
    // to target region: ${msg}` still interpolates a `fetch` error carrying the
    // internal region host — PRE-EXISTING, unchanged here, and filed as a follow-up
    // rather than fixed inline, because every message that can reach this catch needs
    // the same audit and that is a wider change than this PR.
    //
    // `error-scrub.ts` lists "concatenated into a thrown `new Error(...)`" as a
    // carve-out, and that carve-out is about keeping a THROWN error inspectable.
    // It does not contemplate a throw whose message is persisted and then served,
    // which is what this line does — so the raw text goes to `log.error` (where the
    // operator can still see it) and the scrubbed text goes everywhere durable.
    const safeMessage = errorMessage(err);

    // If the region was already updated, retry is dangerous — data exists in both regions
    const failureMessage = regionUpdated
      ? `${safeMessage} (WARNING: region was already updated to "${targetRegion}" — do NOT retry without investigation)`
      : safeMessage;

    log.error({ err: rawMessage, migrationId, workspaceId, regionUpdated }, "Migration failed");

    logMigrationEvent("region_migration_failed", migrationId, {
      workspaceId,
      sourceRegion,
      targetRegion,
      error: failureMessage,
      regionUpdated,
    });

    // Mark as failed and atomically stamp `region_updated` from the local
    // var. This single UPDATE is the load-bearing convergence point for the
    // guard column: regardless of whether the dedicated cutover persist at
    // line 282 succeeded, threw, or was never reached, the failed row's
    // `region_updated` will mirror what the executor actually observed.
    try {
      await updateMigrationStatus(migrationId, "failed", {
        errorMessage: failureMessage,
        completedAt: new Date().toISOString(),
        regionUpdated,
      });
    } catch (updateErr) {
      log.error(
        { err: updateErr instanceof Error ? updateErr.message : String(updateErr), migrationId, regionUpdated },
        "Failed to update migration status to 'failed' — region_updated column may not reflect actual cutover state",
      );
    }

    return { success: false, migrationId, error: failureMessage };
  }
}

// ---------------------------------------------------------------------------
// Background processing
// ---------------------------------------------------------------------------

/**
 * Trigger migration execution asynchronously.
 * Returns immediately — the migration runs in the background.
 */
export function triggerMigrationExecution(migrationId: string): void {
  setTimeout(() => {
    executeRegionMigration(migrationId)
      .then((result) => {
        if (!result.success) {
          log.error(
            { migrationId, error: result.error },
            "Background migration execution failed",
          );
        }
      })
      .catch((err) => {
        log.error(
          { err: err instanceof Error ? err.message : String(err), migrationId },
          "Unhandled error in background migration execution",
        );
      });
  }, 0);
}

// ---------------------------------------------------------------------------
// Stale migration detection
// ---------------------------------------------------------------------------

/**
 * Find and fail migrations stuck in "in_progress" past the stale threshold.
 * Staleness is anchored to `requested_at` (there is no started_at column), so
 * the retry reset MUST refresh `requested_at` — see `resetMigrationForRetry`.
 *
 * Returns `found` (stale rows detected) and `reaped` (rows successfully marked
 * failed) separately so the `region_migration_stale_reap` fiber's span can
 * distinguish "nothing stale" from "stale but couldn't reap" (#4459). Throws
 * when rows were found but NONE could be reaped — the workspace write-lock is
 * still stuck, which callers must surface as a failure (span ERROR + warn),
 * not a quiet zero. Partial success stays non-throwing: the per-row error is
 * already logged and the next sweep retries the stragglers.
 */
export async function failStaleMigrations(): Promise<{
  found: number;
  reaped: number;
}> {
  if (!hasInternalDB()) return { found: 0, reaped: 0 };

  const staleThresholdSec = STALE_THRESHOLD_MS / 1000;
  const staleRows = await internalQuery<{ id: string; workspace_id: string }>(
    `SELECT id, workspace_id FROM region_migrations
     WHERE status = 'in_progress'
       AND requested_at < NOW() - make_interval(secs => $1)`,
    [staleThresholdSec],
  );

  let reaped = 0;
  for (const row of staleRows) {
    try {
      await updateMigrationStatus(row.id, "failed", {
        errorMessage: `Migration timed out — stuck in progress for over ${STALE_THRESHOLD_MS / 60_000} minutes`,
        completedAt: new Date().toISOString(),
      });
      logMigrationEvent("region_migration_failed", row.id, {
        workspaceId: row.workspace_id,
        reason: "stale_timeout",
      });
      reaped++;
      log.warn({ migrationId: row.id, workspaceId: row.workspace_id }, "Stale migration marked as failed");
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err), migrationId: row.id },
        "Failed to mark stale migration as failed",
      );
    }
  }

  if (staleRows.length > 0 && reaped === 0) {
    throw new Error(
      `Found ${staleRows.length} stale region migration(s) but could not mark any as failed — affected workspaces remain write-locked`,
    );
  }

  return { found: staleRows.length, reaped };
}

// ---------------------------------------------------------------------------
// Cleanup detection
// ---------------------------------------------------------------------------

/**
 * Find completed migrations where the source data grace period has elapsed
 * and the source-region residue has not been cleaned up yet.
 *
 * Consumed by the `region_migration_source_cleanup` periodic fiber (#4458)
 * via `runSourceCleanupSweep` in `cleanup.ts`. `source_cleaned_at IS NULL`
 * is the retry contract: the cleanup stamps it in the same transaction as
 * its deletes, so a partially-failed cleanup rolls back to "still due" and
 * is retried on the next sweep.
 */
export async function getCleanupDueMigrations(): Promise<
  Array<{ id: string; workspaceId: string; sourceRegion: string; completedAt: string }>
> {
  if (!hasInternalDB()) return [];

  const rows = await internalQuery<{
    id: string;
    workspace_id: string;
    source_region: string;
    completed_at: string;
  }>(
    `SELECT id, workspace_id, source_region, completed_at
     FROM region_migrations
     WHERE status = 'completed'
       AND completed_at < NOW() - make_interval(days => $1)
       AND source_cleaned_at IS NULL
     ORDER BY completed_at ASC`,
    [CLEANUP_GRACE_PERIOD_DAYS],
  );

  return rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    sourceRegion: r.source_region,
    completedAt: r.completed_at,
  }));
}

// ---------------------------------------------------------------------------
// Retry support
// ---------------------------------------------------------------------------

/**
 * Reset a failed migration to "pending" so it can be re-executed.
 * Only works for migrations in "failed" status.
 *
 * Throws `UnsafeRegionMigrationResetError` (mapped to HTTP 409) when the
 * failed row has `region_updated = TRUE`. Phase 3 already flipped the
 * workspace into the destination; re-running Phase 1 would re-export a
 * workspace that already moved. Recovery requires the manual-intervention
 * runbook, not retry.
 *
 * @param workspaceId - The org ID that owns this migration (for authorization).
 */
export async function resetMigrationForRetry(
  migrationId: string,
  workspaceId: string,
): Promise<OperationResult> {
  if (!hasInternalDB()) {
    return { ok: false, reason: "no_db", error: "Internal database not available" };
  }

  let rows: Array<{
    id: string;
    status: string;
    workspace_id: string;
    region_updated: boolean;
    target_region: string;
    source_region: string;
  }>;
  try {
    rows = await internalQuery<{
      id: string;
      status: string;
      workspace_id: string;
      region_updated: boolean;
      target_region: string;
      source_region: string;
    }>(
      `SELECT id, status, workspace_id, region_updated, target_region, source_region FROM region_migrations WHERE id = $1`,
      [migrationId],
    );
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err), migrationId }, "Failed to load migration for retry");
    return { ok: false, reason: "db_error", error: "Database error while resetting migration" };
  }

  if (rows.length === 0) {
    return { ok: false, reason: "not_found", error: "Migration not found" };
  }

  const row = rows[0];

  if (row.workspace_id !== workspaceId) {
    return { ok: false, reason: "not_found", error: "Migration not found" };
  }

  if (row.status !== "failed") {
    return { ok: false, reason: "invalid_status", error: `Cannot retry migration in "${row.status}" status` };
  }

  // Hard guard: never re-run Phase 1 on a row where Phase 3 already succeeded.
  // Throw a typed error so the route handler maps it to 409 and the operator
  // is forced through the manual-intervention runbook.
  if (row.region_updated) {
    log.warn(
      { migrationId, workspaceId, targetRegion: row.target_region, sourceRegion: row.source_region },
      "Refused to reset migration — region was already updated to destination",
    );
    throw new UnsafeRegionMigrationResetError({
      message:
        `Migration "${migrationId}" cannot be reset: the workspace has already moved from ` +
        `"${row.source_region}" to "${row.target_region}". Re-running export from the source ` +
        `would corrupt the destination. Follow the manual-intervention runbook in the data-residency docs.`,
      migrationId,
      workspaceId,
      targetRegion: row.target_region,
      sourceRegion: row.source_region,
    });
  }

  try {
    // `requested_at = NOW()` restarts the staleness clock: the reaper
    // (`failStaleMigrations`, swept every minute by the
    // `region_migration_stale_reap` fiber) anchors its threshold to
    // `requested_at`, so without this reset a retry started more than
    // STALE_THRESHOLD_MS after the original request would re-enter
    // `in_progress` already "stale" and be killed within one sweep (#4459).
    await internalQuery(
      `UPDATE region_migrations SET status = 'pending', error_message = NULL, completed_at = NULL,
              requested_at = NOW()
       WHERE id = $1`,
      [migrationId],
    );

    log.info({ migrationId }, "Migration reset for retry");
    return { ok: true };
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err), migrationId }, "Failed to reset migration for retry");
    return { ok: false, reason: "db_error", error: "Database error while resetting migration" };
  }
}

// ---------------------------------------------------------------------------
// Cancel support
// ---------------------------------------------------------------------------

/**
 * Cancel a pending migration. Only works for migrations in "pending" status.
 * In-progress migrations cannot be cancelled.
 *
 * @param workspaceId - The org ID that owns this migration (for authorization).
 */
export async function cancelMigration(
  migrationId: string,
  workspaceId: string,
): Promise<OperationResult> {
  if (!hasInternalDB()) {
    return { ok: false, reason: "no_db", error: "Internal database not available" };
  }

  try {
    const rows = await internalQuery<{ id: string; status: string; workspace_id: string }>(
      `SELECT id, status, workspace_id FROM region_migrations WHERE id = $1`,
      [migrationId],
    );

    if (rows.length === 0) {
      return { ok: false, reason: "not_found", error: "Migration not found" };
    }

    if (rows[0].workspace_id !== workspaceId) {
      return { ok: false, reason: "not_found", error: "Migration not found" };
    }

    if (rows[0].status !== "pending") {
      return { ok: false, reason: "invalid_status", error: `Cannot cancel migration in "${rows[0].status}" status` };
    }

    await internalQuery(
      `UPDATE region_migrations SET status = 'cancelled', error_message = 'Cancelled by admin', completed_at = $1
       WHERE id = $2`,
      [new Date().toISOString(), migrationId],
    );

    logMigrationEvent("region_migration_cancelled", migrationId, { workspaceId });
    log.info({ migrationId }, "Migration cancelled");
    return { ok: true };
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err), migrationId }, "Failed to cancel migration");
    return { ok: false, reason: "db_error", error: "Database error while cancelling migration" };
  }
}
