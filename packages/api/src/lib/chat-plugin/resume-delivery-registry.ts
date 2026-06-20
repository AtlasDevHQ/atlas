/**
 * Process-local registry for the chat-surface resume-delivery port (#3750).
 *
 * Mirrors `lib/proactive/announcer-registry.ts`. When an approval-parked chat
 * turn is approved/denied, the surface-agnostic approval-review handler
 * (`api/routes/admin-approval.ts`) re-arms the run via `resolveApprovalPark`
 * and must then deliver the continued answer back to the originating chat
 * thread — but the handler is on the host side of the chat-plugin boundary and
 * holds no reference to the bridge that can post to the thread. The two ends
 * agree on this module:
 *
 *   - chat plugin → calls `registerChatResumeDeliverer(impl)` from its
 *     `initialize()` once the bridge has built its adapters; the impl closes
 *     over the bridge (and the host-side resume helper) so it can re-enter the
 *     agent loop and post the answer in-thread.
 *   - admin-approval route → calls `getChatResumeDeliverer()` and falls back to
 *     `NULL_RESUME_DELIVERER` when no chat plugin has registered (self-hosted
 *     deployments without the chat plugin still must not fail the review).
 *
 * The port deliberately keeps the resume re-entry on the registered (plugin)
 * side rather than core, because resuming a chat turn requires re-binding the
 * chat actor + origin (a chat-plugin concern). Core supplies the security-
 * sensitive primitive (`prepareResume` → `runAgent({ resume })`, which
 * re-resolves auth/connection/RLS LIVE — the same fail-closed guarantee as the
 * web resume route) via `lib/chat-plugin/resume-turn.ts`; the deliverer wires
 * it to the thread post.
 *
 * Lifecycle: single-process; plugin teardown calls `clearChatResumeDeliverer()`
 * so a dev hot-reload / `PluginRegistry.refresh("chat-interaction")` doesn't
 * leak the old bridge reference.
 */

import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("chat-resume-delivery-registry");

/**
 * Outcome of attempting to deliver a resumed chat turn. A tagged union so the
 * caller can log the rejection class without parsing prose, and so the NULL
 * fallback's "no plugin" case is distinguishable from a real delivery failure.
 *
 * - `delivered` — the turn resumed and the answer was posted in-thread.
 * - `blocked` — the live re-resolution refused (billing/suspension); a
 *   user-safe block notice was posted in-thread in place of the answer. The
 *   query never ran — this is a fail-CLOSED security outcome, surfaced
 *   distinctly from `delivered` so an operator can see a parked turn was
 *   refused on resume (not silently answered).
 * - `nothing_to_resume` — no resumable run for the conversation (already
 *   resumed by a concurrent path, lease held, expired, or durability off).
 *   Benign.
 * - `no_deliverer` — no chat plugin registered (self-hosted / no chat). The
 *   approval review still succeeds; there is simply no thread to resume.
 * - `failed` — a resumable turn existed but resume or the thread post failed.
 *   Operator-actionable (the approver's decision won't reach the user's thread
 *   unless they retry / check the admin console).
 */
export type ChatResumeDeliveryOutcome =
  | { readonly status: "delivered" }
  | { readonly status: "blocked" }
  | { readonly status: "nothing_to_resume" }
  | { readonly status: "no_deliverer" }
  | { readonly status: "failed"; readonly reason: string };

/**
 * Input the approval-review handler hands the deliverer: the conversation +
 * org to resume, the thread coordinates, and the bot-actor binding — all loaded
 * from the resume-pending store. `platform` is the chat-plugin platform slug
 * (string here — the registered impl narrows it to its bot-platform union).
 *
 * `externalId` / `externalUserId` are the actor-binding inputs the resume MUST
 * rebuild from (the workspace/team id, NOT the thread anchor) so it re-enters
 * as the same requester and the approval dedup clears on re-run. `threadId` is
 * only the post target.
 */
export interface ChatResumeDeliveryInput {
  readonly conversationId: string;
  readonly orgId: string;
  readonly platform: string;
  readonly threadId: string;
  readonly externalId: string;
  readonly externalUserId?: string;
}

/**
 * The chat-surface resume-delivery port. The real implementation (registered
 * by the chat plugin) re-enters the agent loop for the conversation and posts
 * the continued answer to `threadId` on `platform`. It must NOT throw — it
 * translates its own failures into a `failed` outcome so the approval-review
 * handler (which has already recorded + audited the decision) never 500s on a
 * delivery problem.
 */
export interface ChatResumeDeliverer {
  deliverResumedTurn(input: ChatResumeDeliveryInput): Promise<ChatResumeDeliveryOutcome>;
}

let registered: ChatResumeDeliverer | null = null;

export function registerChatResumeDeliverer(deliverer: ChatResumeDeliverer): void {
  registered = deliverer;
  log.info("Chat resume-deliverer registered");
}

export function clearChatResumeDeliverer(): void {
  registered = null;
}

/**
 * Returns the registered deliverer or {@link NULL_RESUME_DELIVERER}. Callers
 * never null-check — the fallback returns `{ status: "no_deliverer" }`, which
 * the approval-review handler treats as a clean "no chat thread to resume".
 */
export function getChatResumeDeliverer(): ChatResumeDeliverer {
  return registered ?? NULL_RESUME_DELIVERER;
}

/**
 * No-op deliverer for self-hosted deployments without the chat plugin (or
 * tests). The approval-review handler falls back to this so a parked-turn
 * resolution never fails for lack of a chat surface.
 */
export const NULL_RESUME_DELIVERER: ChatResumeDeliverer = {
  async deliverResumedTurn() {
    return { status: "no_deliverer" };
  },
};
