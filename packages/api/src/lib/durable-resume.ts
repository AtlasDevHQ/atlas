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
  releaseResumeLease,
} from "@atlas/api/lib/durable-session";
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
