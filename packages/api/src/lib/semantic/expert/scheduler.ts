/**
 * Scheduled semantic expert — periodic analysis engine tick.
 *
 * Runs the semantic layer analyzer, auto-approves high-confidence proposals,
 * and queues the rest for human review.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { getSetting, isSaasModeForGuard } from "@atlas/api/lib/settings";

const log = createLogger("semantic-expert-scheduler");

/** Default interval: 24 hours. */
export const DEFAULT_EXPERT_SCHEDULER_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Result summary from a single tick. */
export interface ExpertTickResult {
  proposalsGenerated: number;
  autoApproved: number;
  queued: number;
  /** Refused at insert — the identity was previously rejected (#4507). */
  rejected: number;
  /** Converged on an existing pending row — no duplicate queued (#4507). */
  deduped: number;
  errors: number;
}

/**
 * Check whether the expert scheduler is enabled.
 *
 * Platform-scoped (#3392): the scheduler is a single process-global fiber
 * forked once at boot by `makeSchedulerLive` (lib/effect/layers.ts) — there
 * is no per-workspace tick, so this key takes no workspace override.
 * Resolved via getSetting() so a platform-level DB override (admin
 * settings page) wins over the env var (platform DB override > env >
 * default). Consumed once at boot — changes require a restart
 * (`requiresRestart` in the registry); the scheduler layer sequences
 * after `loadSettings()` so the DB override is visible here.
 *
 * SaaS boot-guard (#4487): the scheduler's proposals are inserted with
 * `orgId: null` ("global scope for self-hosted"). A NULL-org row is only
 * sound on self-hosted; on SaaS it is the leak vector — no workspace should
 * ever produce global amendment rows. So the scheduler is force-disabled in
 * `saas` deploy mode regardless of the setting. Fail-CLOSED
 * (`isSaasModeForGuard` treats `errored` as SaaS) is the safe direction:
 * if we cannot confirm we're self-hosted, do not produce global rows.
 */
export function isExpertSchedulerEnabled(): boolean {
  if (isSaasModeForGuard()) return false;
  const v = getSetting("ATLAS_EXPERT_SCHEDULER_ENABLED");
  return v === "true" || v === "1";
}

/**
 * Get the scheduler interval in milliseconds.
 *
 * Resolves ATLAS_EXPERT_SCHEDULER_INTERVAL_HOURS through getSetting()
 * (platform DB override > env > registry default of 24). Platform-scoped
 * and boot-consumed — see isExpertSchedulerEnabled.
 */
export function getExpertSchedulerIntervalMs(): number {
  const raw = getSetting("ATLAS_EXPERT_SCHEDULER_INTERVAL_HOURS");
  if (!raw) return DEFAULT_EXPERT_SCHEDULER_INTERVAL_MS;
  const hours = parseFloat(raw);
  if (!Number.isFinite(hours) || hours <= 0) return DEFAULT_EXPERT_SCHEDULER_INTERVAL_MS;
  return hours * 60 * 60 * 1000;
}

/**
 * Run a single tick of the expert scheduler.
 *
 * 1. Loads semantic layer entities, glossary, audit patterns, and rejected keys
 * 2. Loads cached profiles from last `atlas init` or `atlas improve` run
 * 3. Runs analysis engine with cached profiles
 * 4. Inserts each proposal (status resolved by auto-approve threshold)
 * 5. For proposals marked approved, applies the amendment to YAML
 */
export async function runExpertSchedulerTick(): Promise<ExpertTickResult> {
  const result: ExpertTickResult = {
    proposalsGenerated: 0,
    autoApproved: 0,
    queued: 0,
    rejected: 0,
    deduped: 0,
    errors: 0,
  };

  try {
    // 1. Load semantic layer from disk
    const { loadEntitiesFromDisk, loadGlossaryFromDisk, loadAuditPatterns, loadRejectedKeys } =
      await import("./context-loader");

    const entities = await loadEntitiesFromDisk();
    const glossary = await loadGlossaryFromDisk();
    const auditPatterns = await loadAuditPatterns();
    const rejectedKeys = await loadRejectedKeys();

    if (entities.length === 0) {
      log.debug("No semantic entities found — skipping expert tick");
      return result;
    }

    // 2. Load cached profiles (from last `atlas init` or `atlas improve` run)
    const { loadCachedProfiles } = await import("./profile-cache");
    const profiles = loadCachedProfiles();

    // 3. Run analysis
    const { analyzeSemanticLayer } = await import("./analyzer");
    const proposals = analyzeSemanticLayer({
      profiles,
      entities,
      glossary,
      auditPatterns,
      rejectedKeys,
    });

    result.proposalsGenerated = proposals.length;

    if (proposals.length === 0) {
      log.info("Expert scheduler tick: no proposals generated");
      return result;
    }

    // 4. Insert proposals — insertSemanticAmendment resolves status (approved/pending) based on threshold
    const { insertSemanticAmendment, revertAmendmentToPending } =
      await import("@atlas/api/lib/db/internal");

    // 5. Process each proposal
    for (const proposal of proposals) {
      try {
        // Persist the finding's Connection group so the admin approve path can
        // rebuild the correct scope (#3284). NULL = the default (flat) group:
        // the layout-aware loader labels the default group `"default"`, which
        // maps to a NULL `connection_group_id` like everywhere else.
        const connectionGroupId =
          proposal.group && proposal.group !== "default" ? proposal.group : null;
        const insertResult = await insertSemanticAmendment({
          orgId: null, // global scope for self-hosted
          description: proposal.rationale,
          sourceEntity: proposal.entityName,
          connectionGroupId,
          confidence: proposal.confidence,
          amendmentPayload: {
            category: proposal.category,
            amendmentType: proposal.amendmentType,
            amendment: proposal.amendment,
            testQuery: proposal.testQuery,
          },
        });

        // Permanent rejection memory + pending dedup (#4507): a rejected
        // identity is refused at insert; an identical pending proposal
        // converges on the existing row. Neither queues a new row.
        if (insertResult.outcome === "rejected") {
          result.rejected++;
          continue;
        }
        if (insertResult.outcome === "already_pending") {
          result.deduped++;
          continue;
        }

        const { id, status } = insertResult;

        if (status === "approved") {
          // Auto-apply
          try {
            const { applyAmendmentToEntity } = await import("./apply");
            await applyAmendmentToEntity(null, proposal, `scheduled-${Date.now()}`);
            result.autoApproved++;
            log.info(
              { entity: proposal.entityName, type: proposal.amendmentType, confidence: proposal.confidence },
              "Auto-approved and applied semantic amendment",
            );
          } catch (applyErr) {
            // Revert the row so it never lingers as `approved`-but-unapplied —
            // the invariant "status='approved' ⇒ applied" must hold on this
            // path too (#4486). Reverting re-queues it for admin review.
            const reverted = await revertAmendmentToPending(id).catch(
              (revertErr: unknown) => {
                log.warn(
                  {
                    err: revertErr instanceof Error ? revertErr : new Error(String(revertErr)),
                    entity: proposal.entityName,
                    id,
                  },
                  "Failed to revert auto-approved amendment to pending after apply failure — row may remain approved-but-unapplied",
                );
                return false;
              },
            );
            log.warn(
              {
                err: applyErr instanceof Error ? applyErr : new Error(String(applyErr)),
                entity: proposal.entityName,
                id,
                reverted,
              },
              "Failed to apply auto-approved amendment — reverted to pending for admin review",
            );
            result.errors++;
          }
        } else {
          result.queued++;
        }
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err : new Error(String(err)), entity: proposal.entityName },
          "Failed to insert semantic amendment",
        );
        result.errors++;
      }
    }

    log.info(
      {
        total: result.proposalsGenerated,
        autoApproved: result.autoApproved,
        queued: result.queued,
        rejected: result.rejected,
        deduped: result.deduped,
        errors: result.errors,
      },
      "Expert scheduler tick complete",
    );
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err : new Error(String(err)) },
      "Expert scheduler tick failed",
    );
    result.errors++;
  }

  return result;
}
