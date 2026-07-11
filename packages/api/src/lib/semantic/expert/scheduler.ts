/**
 * Scheduled semantic expert — periodic analysis engine tick.
 *
 * SaaS-first (#4516): one platform fiber, forked once at boot, iterates the
 * workspaces that opted into autonomous improvement. Self-hosted's single
 * implicit workspace is the degenerate case of the same per-workspace tick —
 * not a different model. Each workspace's tick passes that workspace's billing
 * gate (a blocked workspace no-ops, spending nothing), loads that workspace's
 * own semantic context, and inserts org-stamped proposals; eligible ones route
 * through the decide seam for auto-apply.
 */

import { createLogger, withRequestContext } from "@atlas/api/lib/logger";
import { getSetting, isSaasModeForGuard } from "@atlas/api/lib/settings";
import { checkAgentBillingGate } from "@atlas/api/lib/billing/agent-gate";

const log = createLogger("semantic-expert-scheduler");

/** Default interval: 24 hours. */
export const DEFAULT_EXPERT_SCHEDULER_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Per-workspace autonomous-improvement opt-in (#4516). Workspace-scoped,
 * off by default — enabling it is a workspace-admin settings action. Must match
 * the `key`/`envVar` of the registry entry in lib/settings.ts; a guard test in
 * scheduler.test.ts cross-checks this constant against the real registry
 * (`getSettingDefinition`) so a rename can't silently zero out enumeration. */
export const AUTONOMOUS_IMPROVE_ENABLED_KEY = "ATLAS_AUTONOMOUS_IMPROVE_ENABLED";

/** Counters produced by a single workspace's tick. */
interface WorkspaceTickCounters {
  proposalsGenerated: number;
  autoApproved: number;
  queued: number;
  /** Refused at insert — the identity was previously rejected (#4507). */
  rejected: number;
  /** Converged on an existing pending row — no duplicate queued (#4507). */
  deduped: number;
  errors: number;
}

/** Result summary from a single tick — the sum across every workspace the
 * tick considered, plus the iteration/gate counters (#4516). */
export interface ExpertTickResult extends WorkspaceTickCounters {
  /** Workspaces the tick iterated (1 on the self-hosted degenerate path). */
  workspacesConsidered: number;
  /** Workspaces a billing POLICY block skipped — over-budget / suspended /
   * trial-expired. Their tick no-op'd, zero spend: this is the working system. */
  workspacesGateBlocked: number;
  /** Workspaces the billing gate could not evaluate (fail-closed 503 — e.g. an
   * internal-DB brownout). Kept SEPARATE from `workspacesGateBlocked` so a
   * gate-lookup outage doesn't masquerade as "everyone is over budget" in the
   * tick summary. Skipped like a block, but the cause is infra, not policy. */
  workspacesGateErrored: number;
}

/** Outcome of one workspace's tick. `counters` is present iff the tick actually
 * ran (gate passed) — a skipped workspace structurally carries no counters, so
 * the aggregator can't fold a blocked/errored workspace's absent work into the
 * totals. `gate-blocked` (policy) and `gate-errored` (fail-closed infra) are
 * kept distinct so the summary never conflates the two (#4516). */
type WorkspaceTickOutcome =
  | { status: "ran"; counters: WorkspaceTickCounters }
  | { status: "gate-blocked" }
  | { status: "gate-errored" };

function emptyCounters(): WorkspaceTickCounters {
  return { proposalsGenerated: 0, autoApproved: 0, queued: 0, rejected: 0, deduped: 0, errors: 0 };
}

function addCounters(into: WorkspaceTickCounters, from: WorkspaceTickCounters): void {
  into.proposalsGenerated += from.proposalsGenerated;
  into.autoApproved += from.autoApproved;
  into.queued += from.queued;
  into.rejected += from.rejected;
  into.deduped += from.deduped;
  into.errors += from.errors;
}

/**
 * Check whether the autonomous-improvement fiber is enabled on this deployment.
 *
 * This is the PLATFORM MASTER SWITCH (#4516) — whether the single
 * process-global fiber runs at all — not the per-workspace opt-in. Resolved via
 * getSetting() so a platform-level DB override (admin settings page) wins over
 * the env var (platform DB override > env > default). Consumed once at boot by
 * the fiber gate (`makeSchedulerLive`, lib/effect/layers.ts) — changes require a
 * restart (`requiresRestart` in the registry).
 *
 * Deploy-mode agnostic: the pre-#4516 SaaS force-disable boot-guard (#4487) is
 * RETIRED. It existed because the scheduler inserted NULL-org ("global scope")
 * rows that leak across tenants on SaaS; now on SaaS every insert is org-stamped
 * and the tick is gated per-workspace (see {@link runExpertSchedulerTick}) —
 * self-hosted still inserts its single-tenant NULL-org row, which is sound
 * because there is only one tenant — so the fiber is safe to run on SaaS and the
 * deployment master switch is the only gate here.
 */
export function isExpertSchedulerEnabled(): boolean {
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
 * Resolve the set of workspaces this tick should improve.
 *
 * SaaS-first (#4516): on SaaS, iterate the workspaces that opted into
 * autonomous improvement (the workspace-scoped `ATLAS_AUTONOMOUS_IMPROVE_ENABLED`
 * knob, off by default). On self-hosted the whole deployment is one implicit
 * workspace — the degenerate case — so it runs once with the global (NULL-org)
 * scope, equivalent to the pre-#4516 behavior; the platform master switch the
 * fiber already checked is its sole enable.
 *
 * NOTE: this deploy-mode branch SELECTS an iteration strategy (enumerate
 * per-workspace vs. one degenerate workspace); it is NOT the retired #4487
 * boot-guard, which force-DISABLED the scheduler on SaaS. Per-workspace billing
 * gating + the one-workspace-owner insert invariant (#4510) are what make
 * running on SaaS org-safe by construction.
 */
async function resolveImproveWorkspaces(): Promise<Array<{ orgId: string | null }>> {
  if (!isSaasModeForGuard()) {
    return [{ orgId: null }];
  }
  const orgIds = await listAutonomousImproveOrgIds();
  return orgIds.map((orgId) => ({ orgId }));
}

/**
 * Enumerate the workspaces that opted into autonomous improvement. Reads the
 * settings table directly (one row per workspace override) joined to
 * `organization` so a stale override for a deleted workspace is dropped; the
 * per-workspace billing gate is the authoritative filter for suspended /
 * over-budget workspaces, so this query intentionally does not re-check status.
 *
 * "opted in" means "has an explicit workspace-scoped DB override set to true" —
 * this deliberately does NOT route through getSetting()'s env/default tier: an
 * env var or platform default cannot opt a *specific* tenant into autonomy. So a
 * platform-level `ATLAS_AUTONOMOUS_IMPROVE_ENABLED=true` enrolls nobody by
 * design; enrollment is always a per-workspace admin action.
 */
async function listAutonomousImproveOrgIds(): Promise<string[]> {
  const { hasInternalDB, internalQuery } = await import("@atlas/api/lib/db/internal");
  if (!hasInternalDB()) return [];

  const rows = await internalQuery<{ org_id: string }>(
    `SELECT DISTINCT s.org_id AS org_id
       FROM settings s
       JOIN organization o ON o.id = s.org_id
      WHERE s.key = $1 AND s.value IN ('true', '1') AND s.org_id IS NOT NULL`,
    [AUTONOMOUS_IMPROVE_ENABLED_KEY],
  );
  return rows.map((r) => r.org_id);
}

/**
 * Run a single tick of the autonomous-improvement scheduler.
 *
 * Iterates the resolved workspace set (see {@link resolveImproveWorkspaces})
 * and runs each workspace's tick independently — a per-workspace failure is
 * logged and never aborts the sweep. Returns the aggregate counters plus the
 * iteration/gate observability fields.
 */
export async function runExpertSchedulerTick(): Promise<ExpertTickResult> {
  const totals: ExpertTickResult = {
    ...emptyCounters(),
    workspacesConsidered: 0,
    workspacesGateBlocked: 0,
    workspacesGateErrored: 0,
  };

  let workspaces: Array<{ orgId: string | null }>;
  try {
    workspaces = await resolveImproveWorkspaces();
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err : new Error(String(err)) },
      "Failed to resolve autonomous-improvement workspaces",
    );
    totals.errors++;
    return totals;
  }

  // Sequential, not Promise.all: a background sweep over a normally-small set —
  // serializing keeps the per-workspace DB + apply work from bursting the
  // internal pool alongside live traffic (matches reportPeriodOverages).
  for (const { orgId } of workspaces) {
    totals.workspacesConsidered++;
    try {
      const outcome = await runWorkspaceImproveTick(orgId);
      if (outcome.status === "gate-blocked") {
        totals.workspacesGateBlocked++;
        continue;
      }
      if (outcome.status === "gate-errored") {
        totals.workspacesGateErrored++;
        continue;
      }
      addCounters(totals, outcome.counters);
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err : new Error(String(err)), orgId },
        "Autonomous-improvement tick failed for workspace — will retry next tick",
      );
      totals.errors++;
    }
  }

  log.info(
    {
      workspacesConsidered: totals.workspacesConsidered,
      workspacesGateBlocked: totals.workspacesGateBlocked,
      workspacesGateErrored: totals.workspacesGateErrored,
      total: totals.proposalsGenerated,
      autoApproved: totals.autoApproved,
      queued: totals.queued,
      rejected: totals.rejected,
      deduped: totals.deduped,
      errors: totals.errors,
    },
    "Autonomous-improvement scheduler tick complete",
  );

  return totals;
}

/**
 * Run one workspace's improvement tick.
 *
 * `orgId` is the workspace owner — a real id on SaaS, `null` on the self-hosted
 * degenerate path. The billing gate is checked FIRST: a suspended / over-budget
 * workspace no-ops here and spends nothing (#4516 AC3). The analysis + insert +
 * decide work runs under an `agentOrigin: 'scheduler'` request-context frame so
 * origin-scoped approval rules (#2072 / ADR-0015) fire and any metered spend
 * attributes to origin `scheduler` for this workspace.
 *
 * 1. Loads this workspace's entities, glossary, audit patterns, and rejected keys
 * 2. Loads cached profiles from the last `atlas init` / `atlas improve` run
 * 3. Runs the analysis engine
 * 4. Inserts each proposal `pending`; the insert reports auto-approve eligibility
 * 5. Routes eligible proposals through the decide seam (#4506) — claim →
 *    apply + version snapshot → stamp `approved`
 * 6. Emits ONE batched proactive notice (#4520) when the tick left net-new
 *    pending Amendments (`queued > 0`) for a real workspace — best-effort,
 *    over the proactive seam, degrading cleanly to no notice when disabled
 */
async function runWorkspaceImproveTick(orgId: string | null): Promise<WorkspaceTickOutcome> {
  // Billing gate first — a blocked workspace's tick no-ops before any context
  // load or LLM/apply work (#4516 AC3). On self-hosted (orgId null) the gate
  // is a passthrough (checkAgentBillingGate treats no-org as always-allowed).
  const gate = await checkAgentBillingGate(orgId ?? undefined);
  if (!gate.allowed) {
    // Distinguish a fail-closed infra failure (503 — the workspace-status /
    // plan-limit lookup could not complete, e.g. an internal-DB brownout) from
    // a real policy block. Both skip the workspace (fail-closed is the safe
    // direction), but conflating them would make a gate-lookup outage read as
    // "every workspace is over budget" in the tick summary (#4516).
    if (gate.httpStatus === 503) {
      log.warn(
        { orgId, errorCode: gate.errorCode, httpStatus: gate.httpStatus },
        "Autonomous improvement skipped — billing gate unavailable (fail-closed); workspace not run",
      );
      return { status: "gate-errored" };
    }
    log.info(
      { orgId, errorCode: gate.errorCode },
      "Autonomous improvement skipped for workspace — billing gate blocked (over-budget / suspended)",
    );
    return { status: "gate-blocked" };
  }

  const counters = emptyCounters();
  const requestId = `scheduled-${orgId ?? "self"}-${Date.now()}`;

  // Stamp origin `scheduler` (#4508 / ADR-0015) so the decide seam's auto-apply
  // validation (executeSQL) matches origin-scoped approval rules and any metered
  // spend attributes to this workspace under origin `scheduler`.
  return withRequestContext(
    { requestId, agentOrigin: "scheduler", actor: { kind: "scheduler" } },
    async () => {
      // 1. Load this workspace's semantic context. On SaaS (orgId present) read
      //    the workspace's own DB rows + per-org disk mirror; on self-hosted read
      //    the bundled disk layer. Audit patterns + rejected keys are org-scoped
      //    so one tenant's query history / rejections never bleed into another's
      //    proposals (#4516). Glossary is loaded from the shared/default disk
      //    layer for both paths — the scheduler does NOT yet read the per-org DB
      //    glossary (`semantic_entities` type=glossary). Reading shared disk files
      //    carries no tenant data, so there's no cross-tenant leak; the tradeoff
      //    is that a workspace's own DB glossary terms aren't consulted here yet
      //    (group-scoped glossary is #4518's surface, not this slice).
      const {
        loadEntitiesForOrg,
        loadEntitiesFromDisk,
        loadGlossaryFromDisk,
        loadAuditPatterns,
        loadRejectedKeys,
      } = await import("./context-loader");

      const entities = orgId
        ? (await loadEntitiesForOrg(orgId, "published")).entities
        : await loadEntitiesFromDisk();
      const glossary = await loadGlossaryFromDisk();
      const auditPatterns = await loadAuditPatterns(orgId ?? undefined);
      const rejectedKeys = await loadRejectedKeys(orgId ?? undefined);

      if (entities.length === 0) {
        log.debug({ orgId }, "No semantic entities found — skipping workspace tick");
        return { status: "ran", counters };
      }

      // 2. Load cached profiles (from last `atlas init` / `atlas improve` run).
      //    This is a single GLOBAL disk cache written only by the CLI — normally
      //    empty on SaaS, so there is no per-tenant profile to read and the
      //    analyzer degrades gracefully. It stays unscoped for that reason (not
      //    because profiles aren't tenant data — sampled column values are);
      //    per-workspace profiling is #4509's surface, not this slice.
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

      counters.proposalsGenerated = proposals.length;

      if (proposals.length === 0) {
        log.info({ orgId }, "Autonomous-improvement tick: no proposals generated");
        return { status: "ran", counters };
      }

      // 4. Insert proposals — every row lands `pending`; insertSemanticAmendment
      //    reports auto-approve ELIGIBILITY and the decide seam (#4506) is the
      //    only path to `approved`. Every insert is org-stamped (#4510) — the
      //    one-workspace-owner invariant refuses a NULL-org insert on SaaS by
      //    construction, so a stamping regression fails loudly rather than
      //    leaking a global row.
      const { insertSemanticAmendment } = await import("@atlas/api/lib/db/internal");

      for (const proposal of proposals) {
        try {
          // Persist the finding's Connection group so the admin approve path can
          // rebuild the correct scope (#3284). NULL = the default (flat) group.
          const connectionGroupId =
            proposal.group && proposal.group !== "default" ? proposal.group : null;
          const insertResult = await insertSemanticAmendment({
            orgId,
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
            counters.rejected++;
            continue;
          }
          if (insertResult.outcome === "already_pending") {
            counters.deduped++;
            continue;
          }

          const { id, autoApprove } = insertResult;

          if (autoApprove) {
            // Route the auto-approve through the decide seam: claim-then-apply,
            // `approved` stamped only after a successful apply + version
            // snapshot. On apply failure the seam has already compensated the
            // row back to `pending` with a visible reason — the invariant
            // "status='approved' ⇒ applied" holds by construction (#4486, #4506).
            try {
              const { decideAmendment } = await import("./decide");
              const decision = await decideAmendment({
                id,
                orgId,
                decision: "approved",
                reviewedBy: "expert-scheduler",
                requestId,
              });
              if (decision.kind === "approved") {
                counters.autoApproved++;
                log.info(
                  { orgId, entity: proposal.entityName, type: proposal.amendmentType, confidence: proposal.confidence },
                  "Auto-approved and applied semantic amendment",
                );
              } else {
                // A concurrent decision beat the scheduler to its own insert
                // (admin reviewing the queue mid-tick) — nothing to do here.
                counters.queued++;
                log.info(
                  { orgId, entity: proposal.entityName, id, outcome: decision.kind },
                  "Auto-approve skipped — amendment was already decided concurrently",
                );
              }
            } catch (applyErr) {
              log.warn(
                {
                  err: applyErr instanceof Error ? applyErr : new Error(String(applyErr)),
                  orgId,
                  entity: proposal.entityName,
                  id,
                },
                "Failed to apply auto-approved amendment — the decide seam returned it to pending for admin review",
              );
              counters.errors++;
            }
          } else {
            counters.queued++;
          }
        } catch (err) {
          log.warn(
            { err: err instanceof Error ? err : new Error(String(err)), orgId, entity: proposal.entityName },
            "Failed to insert semantic amendment",
          );
          counters.errors++;
        }
      }

      // 6. One batched proactive notice per tick (#4520). Only the scheduler
      //    notifies — interactive proposals (admin console / CLI) don't, because
      //    the admin is already there. `counters.queued` is the net-new pending
      //    rows the admin must review (auto-approved rows are already applied;
      //    deduped/rejected produced no new work; plus a rare concurrent-decision
      //    fallback), so it is exactly the notice's count. The self-hosted
      //    degenerate workspace (orgId null) has no
      //    workspace identity to key the proactive channel on, so it is skipped;
      //    autonomy notifications are a SaaS-first, per-workspace convenience.
      //
      //    The whole block is wrapped: the notice is a best-effort convenience
      //    on top of work already durably committed (the queued Amendments),
      //    so NOTHING in the notification path — not the dynamic import, not a
      //    contract violation in the bridge — may taint this tick's reporting.
      //    Containing it here keeps the already-counted queued/autoApproved rows
      //    from being dropped by the sweep-level catch (#4520 AC3). The bridge
      //    itself already degrades a non-EE deploy to a `{ posted: false }`
      //    skip; this is defence in depth against an unexpected throw.
      if (orgId && counters.queued > 0) {
        try {
          const { notifyAmendmentsPending } = await import(
            "@atlas/api/lib/proactive/notify-amendments"
          );
          const notice = await notifyAmendmentsPending({
            workspaceId: orgId,
            count: counters.queued,
          });
          if (notice.posted) {
            log.info(
              { orgId, count: counters.queued, messageId: notice.messageId ?? null },
              "Notified workspace admins of pending semantic-layer amendments",
            );
          } else {
            log.debug(
              { orgId, count: counters.queued, reason: notice.reason },
              "Amendments-pending notice not posted",
            );
          }
        } catch (notifyErr) {
          // Should-never-fire: the bridge is designed never to throw, and the
          // dynamic import is a local module. WARN (not DEBUG) so a genuine
          // contract regression / module-load break surfaces to operators —
          // this path is invisible on the healthy tick, so it costs no noise.
          log.warn(
            {
              orgId,
              count: counters.queued,
              err: notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
            },
            "Amendments-pending notice step threw — tick reporting unaffected",
          );
        }
      }

      return { status: "ran", counters };
    },
  );
}
