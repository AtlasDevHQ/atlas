/**
 * Crash-resume entry point (#3747, ADR-0020 phase 2).
 *
 * Turns the durable checkpoint substrate (#3745/#3746) into a resumable turn: a
 * turn interrupted mid-flight (deploy, crash, serverless timeout, OOM) re-enters
 * the agent loop from its last `running` checkpoint instead of restarting from
 * the user's message — completed tool calls are already in the stored transcript
 * and do NOT re-execute.
 *
 * This module owns ONLY the resume DECISION: claim the single-resumer lease on
 * the latest non-terminal run and hand the caller the transcript + run id +
 * lease token to re-enter {@link import("./agent").runAgent} with. The chat
 * route owns the rest — it re-resolves security LIVE (auth/connection/whitelist/
 * RLS), invokes `runAgent` with the returned `resume` descriptor, streams over
 * the existing UI-message protocol, surfaces the run id as the `x-run-id`
 * response header, and releases the lease when the stream finishes. Keeping the
 * decision here (a plain, mockable async fn) and the wiring in the route mirrors
 * how the per-step checkpoint write (`durable-session.ts`) sits beside the loop.
 *
 * Security note (ADR-0020 invariant): the checkpoint stores WHAT the agent was
 * doing, never WHAT it was allowed to do. This function never reads authorization
 * from the stored row — the caller must have already re-verified conversation
 * ownership (org/user scope) and re-resolved the connection/whitelist/RLS for
 * the live request BEFORE calling here, so a user who lost access while the turn
 * was interrupted fails closed on resume.
 */

import type { ModelMessage } from "ai";
import {
  getResumeLeaseSeconds,
  isDurabilityEnabled,
  loadAndLeaseResumableRun,
  loadParkedRunByApprovalRef,
  releaseResumeLease,
  resolveParkedRun,
} from "@atlas/api/lib/durable-session";
import { applyApprovalDecision, type ApprovalDecision } from "@atlas/api/lib/approvals/evaluate";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("durable-resume");

/**
 * The `resume` descriptor passed into `runAgent` to re-enter an interrupted
 * turn, plus the lease token the caller must release when the resumed stream
 * finishes. Shaped so `runAgent({ ..., resume })` consumes the first three
 * fields directly.
 */
export interface ResumeHandle {
  /** Reuse the interrupted turn's run id — resumed checkpoints target the same row. */
  readonly runId: string;
  /** Stored transcript as of the last completed step (input + completed steps). */
  readonly transcript: ModelMessage[];
  /** Completed-step count of the resumed checkpoint; the turn continues at +1. */
  readonly priorStepIndex: number;
  /** Lease token held by this resume; pass to {@link finishResume} when the stream ends. */
  readonly leaseOwner: string;
}

/**
 * Outcome of preparing a resume for a conversation.
 *
 * - `"resumable"` — a non-terminal run was found and leased; `handle` carries
 *   the transcript + run id + lease for `runAgent`.
 * - `"none"` — nothing to resume (no non-terminal run; the prior turn finished,
 *   or durability was never on for this conversation). The caller should treat
 *   this as a normal "no interrupted turn" — there is nothing to do.
 * - `"leased"` — a non-terminal run exists but another resume holds a live lease.
 *   The single-flight rejection: the caller returns a 409-style "already
 *   resuming" rather than forking the turn.
 * - `"disabled"` — durability is off for this workspace (settings flag), so
 *   resume is not available.
 * - `"error"` — the claim failed (DB blip). Fail closed: do NOT resume; the
 *   caller returns a retryable error rather than risk a second stream.
 */
export type PrepareResumeResult =
  | { readonly status: "resumable"; readonly handle: ResumeHandle }
  | { readonly status: "none" }
  | { readonly status: "leased" }
  | { readonly status: "disabled" }
  | { readonly status: "error" };

/**
 * Claim the latest resumable run for a conversation under the single-resumer
 * lease. Gated on the per-workspace durability flag (same flag the write path
 * checks) so resume is unavailable exactly where checkpoints were never written.
 *
 * The lease claim is atomic (one CTE-driven UPDATE, no TOCTOU) — a second
 * concurrent call for the same run loses the row race and gets `"leased"`.
 *
 * @param conversationId - The conversation whose interrupted turn to resume.
 *   Ownership MUST already be verified by the caller against the live request's
 *   auth scope (this fn does not re-check it — it loads by conversation id only).
 * @param orgId - The live request's org, used only to resolve the per-workspace
 *   durability flag + lease TTL. NOT used for authorization (that is the caller's
 *   job) and NOT read from the checkpoint.
 */
export async function prepareResume(
  conversationId: string,
  orgId: string | undefined,
): Promise<PrepareResumeResult> {
  if (!isDurabilityEnabled(orgId)) return { status: "disabled" };

  const leaseSeconds = getResumeLeaseSeconds(orgId);
  const claim = await loadAndLeaseResumableRun(conversationId, leaseSeconds);

  switch (claim.status) {
    case "no_db":
      // No internal DB ⇒ nothing was ever checkpointed; treat as "nothing to
      // resume" (same observable outcome as a clean prior turn).
      return { status: "none" };
    case "none":
      return { status: "none" };
    case "leased":
      log.info({ conversationId }, "Resume rejected — run already leased by another resumer");
      return { status: "leased" };
    case "error":
      // Fail closed — never resume on an uncertain claim.
      return { status: "error" };
    case "resumable": {
      const { run } = claim;
      log.info(
        { conversationId, runId: run.runId, stepIndex: run.stepIndex },
        "Resuming interrupted agent run from checkpoint",
      );
      return {
        status: "resumable",
        handle: {
          runId: run.runId,
          transcript: run.transcript,
          priorStepIndex: run.stepIndex,
          leaseOwner: run.leaseOwner,
        },
      };
    }
    default: {
      const _exhaustive: never = claim;
      return _exhaustive;
    }
  }
}

/**
 * Release the resume lease held by a {@link ResumeHandle}, once the resumed
 * stream has finished (cleanly or with an error). Best-effort, fire-and-forget:
 * a failed release leaves the lease to lapse on its TTL. Idempotent on the
 * owner-token guard — releasing a lease another resumer re-claimed is a no-op.
 */
export function finishResume(handle: Pick<ResumeHandle, "runId" | "leaseOwner">): void {
  releaseResumeLease({ runId: handle.runId, leaseOwner: handle.leaseOwner });
}

// ── Approval-park resolution (#3748, ADR-0020 phase 3) ──────────────────────

/**
 * Outcome of resolving an approval-park decision.
 *
 * - `"resumed"` — the parked run was found, its transcript rewritten with the
 *   decision, and the row flipped back to `running` (resumable). The requester's
 *   client reattaches via the resume endpoint to continue the turn in its own
 *   live security context. `conversationId` is surfaced so the caller can
 *   correlate / notify.
 * - `"none"` — nothing to resume, benignly: no parked run is waiting on this
 *   approval request (already resolved by a concurrent review, expired and swept,
 *   or the turn never parked), or there is no internal DB / durability is off.
 *   The decision is recorded on the queue; there is simply no turn to re-arm.
 * - `"failed"` — a parked run WAS waiting on this request but it could NOT be
 *   re-armed: either the stored transcript carried no matching needs-approval
 *   marker (corruption / encoding drift — we fail closed rather than arm an
 *   un-rewritten turn) or the resolve write hit a DB error. This is
 *   operator-actionable: a human's recorded decision will otherwise never resume
 *   the requester's turn (it stays parked until the max-park sweep fails it), so
 *   the caller surfaces it at error severity. `runId` identifies the stuck run.
 */
export type ResolveApprovalParkResult =
  | { readonly status: "resumed"; readonly conversationId: string; readonly runId: string }
  | { readonly status: "none" }
  | { readonly status: "failed"; readonly runId: string };

/**
 * Resolve an approval-queue decision against the turn it parked (#3748). Loads
 * the parked run keyed on the approval-queue ref (`parked_reason`), rewrites the
 * stored transcript so the needs-approval tool result becomes an approved
 * (re-run unblocked by `hasApprovedRequest`) or denied result, and flips the run
 * back to `running` so it is resumable. This is the "append the tool result /
 * trigger a resume" step the approval review handler invokes after recording the
 * decision on the queue.
 *
 * Security: the gated query is NOT executed here — execution happens on resume,
 * in the requester's live context (auth/whitelist/RLS re-resolved fresh), never
 * the reviewer's (ADR-0020 invariant). Fail-soft: a failure to arm the resume
 * must not fail the review (the decision is already on the queue) — but it is
 * NOT silent. A `"none"` outcome is benign (nothing was waiting); a `"failed"`
 * outcome means a recorded decision will otherwise never resume the requester's
 * turn, so it is surfaced at error severity for an operator to act on.
 *
 * @param approvalRequestId - The reviewed approval-queue request id.
 * @param decision - `"approve"` or `"deny"`.
 * @param opts.reviewerLabel - Reviewer's display label, woven into the agent-
 *   facing decision message (telemetry/UX only — not an authorization input).
 * @param opts.comment - Optional reviewer comment surfaced to the agent.
 */
export async function resolveApprovalPark(
  approvalRequestId: string,
  decision: ApprovalDecision,
  opts?: { reviewerLabel?: string | null; comment?: string | null },
): Promise<ResolveApprovalParkResult> {
  const loaded = await loadParkedRunByApprovalRef(approvalRequestId);
  if (loaded.status === "error") {
    // Could not even reach the DB to look up the parked run (the loader logged
    // the cause at warn). A recorded decision may have a turn stuck behind this
    // blip, so surface it as actionable rather than silently benign — it stays
    // parked until the next review retries or the max-park sweep fails it.
    log.error(
      { approvalRequestId, decision },
      "Approval-park resolution could not load the parked run (DB error) — cannot re-arm",
    );
    return { status: "failed", runId: "unknown" };
  }
  if (loaded.status === "none") {
    // No internal DB, durability off, or no matching parked run — nothing to re-arm.
    return { status: "none" };
  }
  const parked = loaded.run;

  // Source the rewrite key from the loaded row's `parked_reason` (the SSOT link),
  // which the WHERE clause guarantees equals `approvalRequestId`.
  const { transcript: rewritten, changed } = applyApprovalDecision(
    parked.transcript,
    parked.parkedReason,
    decision,
    opts,
  );
  if (!changed) {
    // A parked run was waiting, but its transcript had no matching needs-approval
    // marker (corruption / encoding drift). Fail CLOSED: do not flip it back to
    // `running` carrying a stale "needs approval" result (which would just re-park
    // on resume). Leave it parked for the max-park sweep to fail, and surface it.
    log.error(
      { approvalRequestId, runId: parked.runId, conversationId: parked.conversationId, decision },
      "Approval-park resolution found a parked run but no matching marker to rewrite — left parked, not armed",
    );
    return { status: "failed", runId: parked.runId };
  }

  const outcome = await resolveParkedRun({
    runId: parked.runId,
    transcript: rewritten,
    stepIndex: parked.stepIndex,
  });

  switch (outcome) {
    case "resolved":
      log.info(
        { approvalRequestId, runId: parked.runId, conversationId: parked.conversationId, decision },
        "Resolved approval-park — transcript rewritten, run re-armed for resume",
      );
      return { status: "resumed", conversationId: parked.conversationId, runId: parked.runId };
    case "error":
      // The decision is recorded on the queue, but the re-arm write failed
      // (resolveParkedRun logged the DB cause). The requester's turn stays parked
      // until the sweep fails it — operator-actionable, not a benign no-op.
      log.error(
        { approvalRequestId, runId: parked.runId, conversationId: parked.conversationId, decision },
        "Approval-park resolution failed to re-arm a parked run after a recorded decision — left parked",
      );
      return { status: "failed", runId: parked.runId };
    case "noop":
      // The row was already resolved (a concurrent/duplicate review). Benign.
      log.info(
        { approvalRequestId, runId: parked.runId, decision },
        "Approval-park already resolved by a concurrent review — nothing to re-arm",
      );
      return { status: "none" };
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}
