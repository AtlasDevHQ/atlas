/**
 * Scheduled semantic expert — periodic analysis engine tick.
 *
 * Runs the semantic layer analyzer, auto-approves high-confidence proposals,
 * and queues the rest for human review.
 */

import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("semantic-expert-scheduler");

/** Default interval: 24 hours. */
export const DEFAULT_EXPERT_SCHEDULER_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Result summary from a single tick. */
export interface ExpertTickResult {
  proposalsGenerated: number;
  autoApproved: number;
  queued: number;
  errors: number;
}

/**
 * Check whether the expert scheduler is enabled.
 *
 * Reads from the env var — the settings system wraps this with
 * per-workspace overrides at the layer level.
 */
export function isExpertSchedulerEnabled(): boolean {
  const v = process.env.ATLAS_EXPERT_SCHEDULER_ENABLED;
  return v === "true" || v === "1";
}

/**
 * Get the scheduler interval in milliseconds.
 * Reads ATLAS_EXPERT_SCHEDULER_INTERVAL_HOURS, defaults to 24.
 */
export function getExpertSchedulerIntervalMs(): number {
  const raw = process.env.ATLAS_EXPERT_SCHEDULER_INTERVAL_HOURS;
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
    const { insertSemanticAmendment } =
      await import("@atlas/api/lib/db/internal");

    // 5. Process each proposal
    for (const proposal of proposals) {
      try {
        const { status } = await insertSemanticAmendment({
          orgId: null, // global scope for self-hosted
          description: proposal.rationale,
          sourceEntity: proposal.entityName,
          confidence: proposal.confidence,
          amendmentPayload: {
            category: proposal.category,
            amendmentType: proposal.amendmentType,
            amendment: proposal.amendment,
            testQuery: proposal.testQuery,
          },
        });

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
            log.warn(
              { err: applyErr instanceof Error ? applyErr : new Error(String(applyErr)), entity: proposal.entityName },
              "Failed to apply auto-approved amendment",
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
      { total: result.proposalsGenerated, autoApproved: result.autoApproved, queued: result.queued, errors: result.errors },
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
