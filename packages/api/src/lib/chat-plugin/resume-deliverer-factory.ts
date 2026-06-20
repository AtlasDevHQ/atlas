/**
 * Chat resume-deliverer factory (#3750).
 *
 * Builds the `ChatResumeDeliverer` the chat plugin registers (via
 * `onBridgeReady` → `registerChatResumeDeliverer`). Extracted from the deploy
 * config so the integration seam — platform narrowing, the resume→post
 * mapping, and the `answered` / `blocked` / `nothing_to_resume` / `failed`
 * outcome translation — is unit-testable rather than buried in `atlas.config.ts`.
 *
 * The factory takes the one bridge capability it needs (`postToThread`) as a
 * dependency so a test can pass a stub and assert exactly what gets posted and
 * which outcome each `resumeChatTurn` result maps to.
 */

import { CHAT_BOT_PLATFORMS, type ChatBotPlatform } from "@atlas/api/lib/auth/actor";
import { resumeChatTurn } from "@atlas/api/lib/chat-plugin/resume-turn";
import type {
  ChatResumeDeliverer,
  ChatResumeDeliveryOutcome,
} from "@atlas/api/lib/chat-plugin/resume-delivery-registry";

/** Posts a plain message into a thread; returns falsy on failure. The bridge's `postToThread`. */
export type PostToThread = (
  platform: string,
  threadId: string,
  message: string,
) => Promise<{ messageId: string } | null>;

function isBotPlatform(p: string): p is ChatBotPlatform {
  return (CHAT_BOT_PLATFORMS as readonly string[]).includes(p);
}

/**
 * Build the resume-deliverer. On a delivery request it:
 *   1. narrows `platform` to a real bot platform (an unknown slug — which
 *      shouldn't occur, since we wrote it at park — `failed`s rather than
 *      guessing an actor identity);
 *   2. re-enters the agent loop under the original chat actor via
 *      `resumeChatTurn` (which re-resolves auth/scoping LIVE — ADR-0020);
 *   3. posts the continued answer (or, on a billing/suspension block, a
 *      user-safe block notice) back into the thread via `postToThread`;
 *   4. maps the result: a posted answer → `delivered`, a posted block notice →
 *      `blocked` (a fail-closed security refusal, kept distinct), a failed post
 *      → `failed`, and `nothing_to_resume` / `failed` pass through.
 */
export function buildChatResumeDeliverer(deps: { postToThread: PostToThread }): ChatResumeDeliverer {
  return {
    async deliverResumedTurn({
      conversationId,
      orgId,
      platform,
      threadId,
      externalId,
      externalUserId,
    }): Promise<ChatResumeDeliveryOutcome> {
      if (!isBotPlatform(platform)) {
        return { status: "failed", reason: `unknown_platform:${platform}` };
      }

      const resumed = await resumeChatTurn({
        conversationId,
        orgId,
        platform,
        // Rebuild the SAME bot actor that parked (team/workspace id + optional
        // per-user id) so the approval dedup clears on re-run.
        externalId,
        ...(externalUserId !== undefined ? { externalUserId } : {}),
      });

      if (resumed.status === "nothing_to_resume") return { status: "nothing_to_resume" };
      if (resumed.status === "failed") return { status: "failed", reason: resumed.reason };

      // `answered` or `blocked` — both carry a user-facing message to post
      // in-thread (the answer, or the user-safe block reason).
      const message = resumed.status === "answered" ? resumed.answer : resumed.message;
      const posted = await deps.postToThread(platform, threadId, message);
      if (!posted) return { status: "failed", reason: "thread_post_failed" };
      return resumed.status === "blocked" ? { status: "blocked" } : { status: "delivered" };
    },
  };
}
