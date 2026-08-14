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

import { createLogger } from "@atlas/api/lib/logger";
import { hasInternalDB, internalQuery, getInternalDB } from "@atlas/api/lib/db/internal";
import { getConfig } from "@atlas/api/lib/config";
import { UnsafeRegionMigrationResetError } from "@atlas/api/lib/effect/errors";
import { exportWorkspaceBundle } from "./export";
import type { MigrationStatus, MigrationPhase, ExportBundle, ExportManifest, ImportResult } from "@useatlas/types";

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
] as const satisfies readonly RefusalCapableSection[];

const REFUSAL_ACCOUNTING_SECTIONS: ReadonlySet<string> = new Set(REFUSAL_ACCOUNTING);

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
 * place. Only
 * `brainVocabularyEdges` does — an alias edge is a human review decision and two
 * regions can hold contradictory ones, so the destination refuses one and logs
 * it. Everywhere else `imported + skipped` accounts for every row and a
 * `refused` in the response is a target bug.
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
  | { readonly success: true; readonly migrationId: string }
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
 * Send an export bundle to the target region's internal import endpoint.
 *
 * Uses ATLAS_INTERNAL_SECRET for service-to-service auth. The target endpoint
 * is derived from the region's apiUrl in the residency config.
 */
async function transferBundleToTarget(
  bundle: ExportBundle,
  targetApiUrl: string,
  orgId: string,
  migrationId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
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
  let acknowledged: Partial<
    Record<
      (typeof RECONCILED_SECTIONS)[number],
      { imported?: number; skipped?: number; refused?: number }
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
    if (expected === 0) continue; // nothing exported ⇒ nothing to reconcile
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
    // own first cut. `brainVocabularyEdges` is the only section whose import can
    // refuse anything. A blanket `+ (got?.refused ?? 0)` means a target that
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
    const refusalIsAccounting = REFUSAL_ACCOUNTING_SECTIONS.has(section);
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
    if (refusalIsAccounting && refused > 0) {
      log.warn(
        { migrationId, section, refused },
        // ⚠️ CONDITIONAL TENSE, and it points at THIS region's own data.
        //
        // Two corrections, both caught by asking whether this fix reproduces the
        // defect it fixes. First: it runs in phase 2, BEFORE cutover and before
        // cleanup is scheduled, either of which can still fail — so stating "the
        // source copy is deleted" as fact is the same over-report the target-side
        // warn was just rewritten to avoid, one module over and in the same
        // commit. Second, and worse: it used to say "retrieve them from the
        // TARGET's logs", which makes another region's log retention the
        // recovery path — the very artifact this disclosure exists because it is
        // NOT sufficient.
        //
        // The source does not need them. It still HOLDS its own
        // `brain_vocabulary_edge` rows, in its own database, for the whole grace
        // period — the operator's job is to look before the window closes, not
        // to go reading a foreign log stream.
        "Target region REFUSED curated alias edges during import — that many approved human " +
          "review decisions will NOT be applied in the destination. If this migration completes, " +
          "THIS region's own brain_vocabulary_edge rows are deleted once the cleanup grace " +
          "period expires: export or re-author them from this region's database before then. " +
          "Which specific edges were refused is logged in the target region against this " +
          "workspace; the full set is still here until cleanup runs.",
      );
    }
  }

  return { ok: true };
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

    log.info({ migrationId }, "Phase 2 complete: data transferred to target region");

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
    });

    log.info({ migrationId, workspaceId, sourceRegion, targetRegion, completedAt }, "Migration completed successfully");

    return { success: true, migrationId };
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err);

    // If the region was already updated, retry is dangerous — data exists in both regions
    const errorMessage = regionUpdated
      ? `${rawMessage} (WARNING: region was already updated to "${targetRegion}" — do NOT retry without investigation)`
      : rawMessage;

    log.error({ err: rawMessage, migrationId, workspaceId, regionUpdated }, "Migration failed");

    logMigrationEvent("region_migration_failed", migrationId, {
      workspaceId,
      sourceRegion,
      targetRegion,
      error: errorMessage,
      regionUpdated,
    });

    // Mark as failed and atomically stamp `region_updated` from the local
    // var. This single UPDATE is the load-bearing convergence point for the
    // guard column: regardless of whether the dedicated cutover persist at
    // line 282 succeeded, threw, or was never reached, the failed row's
    // `region_updated` will mirror what the executor actually observed.
    try {
      await updateMigrationStatus(migrationId, "failed", {
        errorMessage,
        completedAt: new Date().toISOString(),
        regionUpdated,
      });
    } catch (updateErr) {
      log.error(
        { err: updateErr instanceof Error ? updateErr.message : String(updateErr), migrationId, regionUpdated },
        "Failed to update migration status to 'failed' — region_updated column may not reflect actual cutover state",
      );
    }

    return { success: false, migrationId, error: errorMessage };
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
