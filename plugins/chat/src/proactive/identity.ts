/**
 * Runtime chokepoints for the proactive identity brands (#2641).
 *
 * Type-only brands live in `@useatlas/types/proactive`; this module is
 * the single runtime entry that promotes a bare `string` into a
 * `WorkspaceId` / `AtlasUserId` / `ExternalUserId`. Every host
 * adapter — `packages/api/src/lib/proactive/{user-resolver,answer-adapter}.ts`,
 * the SaaS `deploy/api/atlas.config.ts` boundary, the per-event
 * resolver in `listener.ts` — constructs branded values via these
 * helpers so an empty or malformed id fails fast instead of silently
 * collapsing every asker onto a single global tenant.
 *
 * Splitting from `@useatlas/types`: the types package is type-only
 * (the "@useatlas/types scaffold gotcha" — adding value exports breaks
 * scaffold CI until the package is republished). Runtime promotion
 * needs a value export, so the assert helpers live here and the
 * types live there. The plugin re-exports both from `@useatlas/chat`
 * so a host can `import { assertWorkspaceId, type WorkspaceId }` from
 * a single module.
 */

import type {
  AtlasUserId,
  ChannelId,
  ExternalUserId,
  ThreadId,
  WorkspaceId,
} from "@useatlas/types/proactive";

/**
 * The branded identity field that failed promotion. Literal union (not
 * `string`) so catch sites — `safeResolveWorkspace` in `listener.ts`,
 * the slash handler in `bridge.ts` — can exhaustively narrow on
 * `err.field` and a telemetry consumer grouping by `field` sees a
 * stable, typo-proof set.
 */
export type ProactiveIdentityField =
  | "WorkspaceId"
  | "AtlasUserId"
  | "ExternalUserId"
  | "ThreadId"
  | "ChannelId";

/**
 * Thrown by the `assert*Id` helpers when a boundary input is empty.
 *
 * Empty is the failure mode that silently routes every asker to the
 * "global" tenant or the unlinked path (pre-#2624 / pre-#2641). Promoting
 * an empty string into a brand is a host-wiring bug, not a runtime
 * condition the listener can recover from — surface as a thrown error
 * so the host's boundary `try/catch` (see `safeResolveWorkspace` in
 * `listener.ts`) converts it into a silent skip rather than running
 * with a misattributed tenant.
 */
export class InvalidProactiveIdentityError extends Error {
  constructor(public readonly field: ProactiveIdentityField) {
    super(`Proactive identifier ${field} must be a non-empty string`);
    this.name = "InvalidProactiveIdentityError";
  }
}

/**
 * True when `value` is a non-empty string with at least one
 * non-whitespace character. Whitespace-only strings (`"   "`, `"\n"`,
 * `"\t"`) are an "innocent-looking empty" upstream-trim-bug that would
 * otherwise pass the `length === 0` check and propagate a useless id
 * into the listener — same failure-mode class as the empty string.
 * Rejection is non-mutating: callers receive the original value if it
 * passes (DB rows may have been stored with leading/trailing space and
 * the brand must match those rows verbatim).
 */
function isNonEmptyIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Promote a bare string into a {@link WorkspaceId}. Throws
 * {@link InvalidProactiveIdentityError} on empty / whitespace-only
 * input. Use at every boundary that accepts a workspace id from
 * outside the plugin — the per-event resolver result in the listener,
 * the host adapter constructors, and the SaaS config wiring.
 */
export function assertWorkspaceId(value: string): WorkspaceId {
  if (!isNonEmptyIdentifier(value)) {
    throw new InvalidProactiveIdentityError("WorkspaceId");
  }
  return value as WorkspaceId;
}

/**
 * Promote a bare string into an {@link AtlasUserId}. Throws
 * {@link InvalidProactiveIdentityError} on empty / whitespace-only
 * input. Use when the host's user-resolver returns a linked Atlas id
 * and before constructing `{ kind: "linked", atlasUserId }`.
 */
export function assertAtlasUserId(value: string): AtlasUserId {
  if (!isNonEmptyIdentifier(value)) {
    throw new InvalidProactiveIdentityError("AtlasUserId");
  }
  return value as AtlasUserId;
}

/**
 * Promote a bare string into an {@link ExternalUserId}. Throws
 * {@link InvalidProactiveIdentityError} on empty / whitespace-only
 * input. Use when building a
 * {@link import("./answerer").ProactiveAsker} from a chat SDK
 * `Author`. Self-bot / placeholder events that pass through the
 * listener never reach `ProactiveAsker` construction.
 */
export function assertExternalUserId(value: string): ExternalUserId {
  if (!isNonEmptyIdentifier(value)) {
    throw new InvalidProactiveIdentityError("ExternalUserId");
  }
  return value as ExternalUserId;
}

/**
 * Promote a bare string into a {@link ThreadId} — the chat-adapter's
 * encoded thread id (e.g. Slack `"slack:CHANNEL:THREAD_TS"`). Use at
 * the seam where the chat SDK's untyped `Thread.id` /
 * `ReactionEvent.threadId` (both `string`) flow into the listener's
 * branded slots — `PendingAnswers.record/peek/consume`.
 *
 * Branding both `ThreadId` and {@link ChannelId} eliminates the #2680
 * footgun where `pending.record(thread.channelId, ...)` compiled
 * silently against a slot that semantically required `thread.id` — the
 * keys never matched the encoded form `event.threadId` carries on the
 * reaction-back side, and every dogfood answer-flow attempt skipped at
 * the `unknown-message` branch (debug-level log, no meter row).
 */
export function assertThreadId(value: string): ThreadId {
  if (!isNonEmptyIdentifier(value)) {
    throw new InvalidProactiveIdentityError("ThreadId");
  }
  return value as ThreadId;
}

/**
 * Promote a bare string into a {@link ChannelId} — the chat-adapter's
 * bare channel id (e.g. Slack `"slack:CHANNEL"`). Distinct nominal
 * type from {@link ThreadId} even though both are strings; see
 * {@link assertThreadId} for the bug-pattern context.
 */
export function assertChannelId(value: string): ChannelId {
  if (!isNonEmptyIdentifier(value)) {
    throw new InvalidProactiveIdentityError("ChannelId");
  }
  return value as ChannelId;
}
