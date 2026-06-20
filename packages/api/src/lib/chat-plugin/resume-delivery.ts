/**
 * Chat resume-on-approval delivery glue (#3750).
 *
 * Called by the approval-review handler after a parked turn is re-armed
 * (`resolveApprovalPark` → `resumed`). Loads the thread coordinates written at
 * park time, hands them to the registered chat deliverer (which re-enters the
 * agent loop and posts the continued answer in-thread), and consumes the
 * pending row on a terminal outcome so a re-review can't double-deliver.
 *
 * Runs for BOTH an approve and a deny: on deny, `resolveApprovalPark` rewrites
 * the transcript with a "denied — do not retry" result and re-arms the run, so
 * the resumed turn posts the denial back in-thread rather than leaving the user
 * waiting forever on a thread that never continues.
 *
 * Fail-soft: the approval decision is already recorded + audited, so this never
 * throws into the review handler — it logs and returns. Lives in `lib/` (not
 * the route) so the route stays thin and this glue is unit-testable.
 */

import { createLogger } from "@atlas/api/lib/logger";
import type { ApprovalDecision } from "@atlas/api/lib/approvals/evaluate";
import {
  loadResumePending,
  clearResumePending,
} from "@atlas/api/lib/chat-plugin/resume-pending-store";
import { getChatResumeDeliverer } from "@atlas/api/lib/chat-plugin/resume-delivery-registry";

const log = createLogger("chat-resume-delivery");

/**
 * Deliver a resumed chat turn for `conversationId`, if one is pending. Returns
 * the deliverer outcome's status (or `"no_pending"` when no chat thread was
 * waiting on this conversation — the common web-turn / no-coordinates case).
 *
 * @param conversationId - The re-armed run's conversation (from
 *   `resolveApprovalPark`).
 * @param decision - The recorded approval decision, for log correlation.
 */
export async function deliverChatResumeIfPending(
  conversationId: string,
  decision: ApprovalDecision,
): Promise<"delivered" | "blocked" | "nothing_to_resume" | "no_deliverer" | "failed" | "no_pending"> {
  const coords = await loadResumePending(conversationId);
  if (!coords) {
    // No chat thread is waiting on this conversation — a web turn, or
    // durability/coordinates were never written. Nothing to do.
    return "no_pending";
  }

  const outcome = await getChatResumeDeliverer().deliverResumedTurn({
    conversationId,
    orgId: coords.orgId,
    platform: coords.platform,
    threadId: coords.threadId,
    externalId: coords.externalId,
    ...(coords.externalUserId !== undefined ? { externalUserId: coords.externalUserId } : {}),
  });

  switch (outcome.status) {
    case "delivered":
      // Consume the pending row so a duplicate/late review can't re-deliver.
      await clearResumePending(conversationId);
      log.info(
        { conversationId, platform: coords.platform, decision },
        "Chat thread resumed + answer delivered after approval decision",
      );
      return "delivered";
    case "blocked":
      // A fail-CLOSED security refusal: the live re-resolution (billing /
      // suspension) blocked the resume and a user-safe notice was posted
      // in-thread instead of the answer. Consume the coordinate (a billing
      // block won't clear on retry) but surface at WARN so an operator sees a
      // parked turn was refused on resume — not silently answered.
      await clearResumePending(conversationId);
      log.warn(
        { conversationId, platform: coords.platform, decision },
        "Chat resume BLOCKED by live re-resolution (billing/suspension) — posted a block notice in-thread instead of the answer",
      );
      return "blocked";
    case "nothing_to_resume":
      // The run was already resumed (a concurrent path, or the user re-asked)
      // — drop the coordinate so it doesn't linger.
      await clearResumePending(conversationId);
      log.info(
        { conversationId, platform: coords.platform, decision },
        "Chat resume found nothing to resume — clearing pending coordinate",
      );
      return "nothing_to_resume";
    case "no_deliverer":
      // No chat plugin registered (shouldn't happen if a coordinate exists, but
      // a deploy that dropped the plugin could). Leave the coordinate to
      // TTL-expire in case the plugin re-registers and a manual retry runs.
      log.warn(
        { conversationId, platform: coords.platform, decision },
        "Chat resume coordinate found but no deliverer registered — leaving for TTL",
      );
      return "no_deliverer";
    case "failed":
      // Operator-actionable: the decision is recorded but the thread did not
      // get its continuation. Leave the coordinate so a retry path can re-run.
      log.error(
        { conversationId, platform: coords.platform, decision, reason: outcome.reason },
        "Chat resume delivery FAILED after approval decision — thread not continued; investigate",
      );
      return "failed";
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}
