/**
 * Host-side resume primitive for the chat surface (#3750).
 *
 * Re-enters a parked chat turn — after its approval has been resolved
 * (`resolveApprovalPark` rewrote the transcript + flipped the run back to
 * `running`) — and collects the continued answer, non-streaming. The chat
 * resume-deliverer (registered by the plugin) calls this, then posts the
 * returned answer to the originating thread.
 *
 * This is the security boundary for chat resume (acceptance criterion 3):
 * resume re-resolves auth/scoping LIVE, never from the checkpoint. The same
 * fail-closed guarantee as the web resume route — we:
 *   1. rebuild the SAME bot actor that parked (so the approval gate's
 *      `hasApprovedRequest` dedup clears for the same requester id) and bind it
 *      onto a fresh RequestContext with the chat origin;
 *   2. re-run the billing gate (a workspace suspended while parked fails
 *      closed);
 *   3. claim the single-resumer lease via `prepareResume` (a concurrent
 *      resume — e.g. the user also re-asked — loses the row race and we skip);
 *   4. re-enter `runAgent({ resume })`, whose tools re-resolve the
 *      connection/whitelist/RLS for the live request.
 *
 * The gated query itself executes here, in the requester's live context, never
 * the reviewer's (ADR-0020). A user who lost access while parked fails closed.
 */

import { runAgent } from "@atlas/api/lib/agent";
import { prepareResume, finishResume } from "@atlas/api/lib/durable-resume";
import { botActorUser, type ChatBotPlatform } from "@atlas/api/lib/auth/actor";
import { checkAgentBillingGate } from "@atlas/api/lib/billing/agent-gate";
import { createLogger, withRequestContext } from "@atlas/api/lib/logger";
import type { ApprovalRequestOrigin } from "@useatlas/types";

const log = createLogger("chat-resume-turn");

// Compile-time guard: every chat bot platform must be a valid approval-rule
// origin, so `platform as ApprovalRequestOrigin` below is sound. If a new
// `CHAT_BOT_PLATFORMS` member is added without a matching `APPROVAL_RULE_ORIGINS`
// entry, this assignment fails to typecheck rather than silently minting an
// invalid origin at runtime.
type _AssertBotPlatformIsOrigin = ChatBotPlatform extends ApprovalRequestOrigin ? true : never;
const _assertBotPlatformIsOrigin: _AssertBotPlatformIsOrigin = true;
void _assertBotPlatformIsOrigin;

export interface ResumeChatTurnInput {
  readonly conversationId: string;
  readonly orgId: string;
  /** Chat-plugin platform slug — must be a real bot platform to rebuild the actor. */
  readonly platform: ChatBotPlatform;
  /** Bot-actor binding inputs captured at park time. */
  readonly externalId: string;
  readonly externalUserId?: string;
}

/**
 * Outcome of a chat-turn resume.
 *
 * - `answered` — the turn resumed and produced a continued answer to post.
 * - `nothing_to_resume` — no resumable run (already resumed by a concurrent
 *   path, lease held by another resumer, expired/swept, or durability off).
 * - `blocked` — the live re-resolution refused (billing/suspension) — the
 *   `message` is user-safe and may be delivered in-thread in place of the
 *   answer.
 * - `failed` — resume threw. The caller surfaces this; the user must retry.
 */
export type ResumeChatTurnResult =
  | { readonly status: "answered"; readonly answer: string }
  | { readonly status: "nothing_to_resume" }
  | { readonly status: "blocked"; readonly message: string }
  | { readonly status: "failed"; readonly reason: string };

/**
 * Resume the conversation's parked turn under its original chat actor and
 * return the continued answer (non-streaming). Never throws — every failure is
 * mapped to a result variant so the approval-review handler (which has already
 * recorded the decision) cannot 500 on a resume problem.
 */
export async function resumeChatTurn(input: ResumeChatTurnInput): Promise<ResumeChatTurnResult> {
  const { conversationId, orgId, platform, externalId, externalUserId } = input;

  // Rebuild the SAME actor that parked — same `userId` so the approval gate
  // recognises the prior approval on re-run (else the rewritten transcript
  // would re-park as a fresh requester).
  const actor = botActorUser({
    platform,
    externalId,
    orgId,
    ...(externalUserId !== undefined ? { externalUserId } : {}),
  });
  const agentOrigin = platform as ApprovalRequestOrigin;
  const requestId = crypto.randomUUID();

  return withRequestContext(
    {
      requestId,
      user: actor,
      agentOrigin,
      actor: { kind: "agent" },
    },
    async (): Promise<ResumeChatTurnResult> => {
      // Live billing re-resolution — a workspace suspended/expired while the
      // turn was parked fails closed exactly as a fresh run would.
      let gate;
      try {
        gate = await checkAgentBillingGate(orgId);
      } catch (err) {
        log.error(
          { conversationId, orgId, err: err instanceof Error ? err.message : String(err) },
          "Chat resume billing gate threw — not resuming",
        );
        return { status: "failed", reason: "billing_gate_error" };
      }
      if (!gate.allowed) {
        log.warn(
          { conversationId, orgId, errorCode: gate.errorCode },
          "Chat resume blocked by billing enforcement",
        );
        return { status: "blocked", message: gate.errorMessage };
      }

      // Claim the single-resumer lease on the (now `running`, re-armed) run.
      let prepared;
      try {
        prepared = await prepareResume(conversationId, orgId);
      } catch (err) {
        log.error(
          { conversationId, orgId, err: err instanceof Error ? err.message : String(err) },
          "Chat resume prepareResume threw — not resuming",
        );
        return { status: "failed", reason: "prepare_resume_error" };
      }

      if (prepared.status !== "resumable") {
        // `none` (nothing to resume — already delivered / never armed),
        // `leased` (a concurrent resume holds the lease — that path delivers),
        // `disabled`/`error` (durability off or claim failed). All map to
        // "nothing to deliver from here"; only a genuine resumable run proceeds.
        log.info(
          { conversationId, orgId, prepareStatus: prepared.status },
          "Chat resume found no resumable run — skipping delivery",
        );
        return { status: "nothing_to_resume" };
      }

      const handle = prepared.handle;
      try {
        // Re-enter the loop from the checkpoint. `messages: []` is inert — the
        // rewritten transcript (carrying the "approved, re-run now" result) is
        // the model input. The tools re-resolve connection/whitelist/RLS live.
        const agentResult = await runAgent({
          messages: [],
          conversationId,
          resume: {
            runId: handle.runId,
            transcript: handle.transcript,
            priorStepIndex: handle.priorStepIndex,
          },
        });
        const answer = await agentResult.text;
        log.info(
          { conversationId, orgId, runId: handle.runId },
          "Chat turn resumed after approval — answer ready for thread delivery",
        );
        return { status: "answered", answer };
      } catch (err) {
        log.error(
          {
            conversationId,
            orgId,
            runId: handle.runId,
            err: err instanceof Error ? err.message : String(err),
          },
          "Chat resume agent run failed",
        );
        return { status: "failed", reason: "agent_run_error" };
      } finally {
        // Release the single-resumer lease so a later resume can re-claim.
        finishResume(handle);
      }
    },
  );
}
