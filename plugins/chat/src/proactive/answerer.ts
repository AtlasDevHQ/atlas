/**
 * Reaction-to-answer flow for proactive chat (slice #2293).
 *
 * After the listener has reacted 🤖 to a message (slice #2292), this
 * module:
 *   - remembers the original message in a TTL'd in-memory registry
 *   - when an asker (or anyone else in the channel) adds 🤖 back, or
 *     clicks the "Yes, answer" ephemeral button, looks the message up
 *   - resolves the asker to an Atlas user via a host-supplied callback
 *   - runs `executeQueryProactive` for linked askers, or posts the
 *     unlinked-asker stub
 *
 * Slice #2293 keeps the answer rendering minimal — see
 * `plugins/chat/src/cards/proactive-answer-card.tsx`. Rich query-result
 * cards arrive when the full agent path wires through; for now the
 * priority is round-tripping `subscribe → classify → react → answer`.
 */

import type { Author } from "chat";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** External chat-platform user that asked a question Atlas reacted to. */
export interface ProactiveAsker {
  /** Platform name, e.g. "slack". */
  platform: string;
  /** Platform-side user ID (Slack U…, etc.). */
  externalUserId: string;
  /** Optional display name for logs / fallback prompts. */
  userName?: string;
}

/** Returned by the host's user-resolver callback. */
export interface ResolvedAsker {
  /** Atlas user ID when the chat user is linked via OAuth. */
  atlasUserId?: string;
}

/**
 * Per-event context passed to the user resolver (#2624).
 *
 * Carries the per-event `workspaceId` resolved by the listener so a
 * multi-tenant host can distinguish "the same Slack user-id seen in
 * tenant A vs tenant B". Pre-#2624 the resolver received only the
 * platform identity and could only do a global lookup — on SaaS that
 * collapses two tenants' askers onto whichever workspace the user
 * happens to be a member of first.
 *
 * Kept as a separate object (Option 2 from the issue body) rather than
 * inlined into {@link ProactiveAsker} so the asker stays a pure
 * chat-platform identity while the workspace stays per-event context.
 */
export interface ProactiveUserResolverContext {
  /** Atlas workspace id (`org_id`) the event belongs to. */
  workspaceId: string;
}

/**
 * Resolver: chat-platform identity → Atlas identity.
 *
 * Receives both the asker (platform identity) and a per-event context
 * carrying the workspaceId. Hosts MUST scope the lookup by workspaceId
 * — otherwise multi-tenant collisions silently route an unlinked
 * tenant B asker to a tenant A Atlas user.
 *
 * Implementations may throw on infra failure; the listener's
 * `safeResolveUser` catches the throw and refuses with the apology
 * copy (no downgrade to the public-dataset path — that would silently
 * bypass per-user RLS for a linked Atlas user).
 */
export type ProactiveUserResolver = (
  asker: ProactiveAsker,
  ctx: ProactiveUserResolverContext,
) => Promise<ResolvedAsker>;

/** Result returned by `executeQueryProactive`. */
export interface ProactiveQueryResult {
  /** Markdown body to post in-thread. */
  answer: string;
  /**
   * Whether to subscribe the thread so follow-ups flow through
   * `onSubscribedMessage`. Defaults to true at the call site.
   */
  followupSubscribe?: boolean;
  /**
   * Fully-qualified semantic entity names the agent touched while
   * answering. Populated when the host wires the agent's entity
   * tracker through to the result (#2297 — drives the public-dataset
   * gate for unlinked askers). Empty / undefined means "host doesn't
   * report this"; the listener falls back to allowlist-presence-only
   * behavior in that case.
   */
  entitiesReferenced?: string[];
  /**
   * Column / measure names the agent touched. Combined with the
   * allowlist's per-entry `denyMetrics` to refuse a question that
   * touches a sensitive column inside an otherwise-public entity.
   */
  metricsReferenced?: string[];
}

/**
 * Execute the Atlas agent on behalf of an asker.
 *
 * Slice #2293 introduced this for linked askers only (`atlasUserId`
 * non-null). Slice #2297 extends it to public-dataset askers too:
 * when the caller passes `atlasUserId: null` (no Atlas identity
 * resolved for this chat user), the host MUST constrain the agent
 * to the workspace's public-dataset allowlist (no RLS, curated entity
 * set only). The listener post-filters the result against the same
 * allowlist before posting.
 *
 * Why nullable instead of an empty-string sentinel: a typo or accidental
 * `""` from upstream resolution can't be distinguished from "intentional
 * public-dataset call" when the slot is a `string`; `string | null`
 * forces a deliberate null check on every host implementation.
 */
export type ProactiveExecuteQuery = (
  question: string,
  context: {
    threadId: string;
    asker: ProactiveAsker;
    /**
     * Atlas user id when the asker is OAuth'd into a workspace user.
     * `null` means the asker is unlinked — host MUST constrain the
     * agent to the workspace's public-dataset allowlist.
     */
    atlasUserId: string | null;
    /**
     * Atlas workspace id the event belongs to (#2624). Threaded through
     * from the listener's per-event resolution so the host can scope
     * tool registries, allowlist lookups, and tenant-specific config
     * by the right tenant on multi-tenant SaaS. Static-tenant hosts
     * can ignore it.
     */
    workspaceId: string;
  },
) => Promise<ProactiveQueryResult>;

// ---------------------------------------------------------------------------
// Pending-answer registry
// ---------------------------------------------------------------------------

/** A message we reacted to and are waiting on a follow-up reaction/button. */
export interface PendingAnswerEntry {
  text: string;
  asker: ProactiveAsker;
  /**
   * Workspace id resolved when the channel-message handler reacted to
   * this message (#2620 multi-tenant). The reaction-back / button-click
   * handlers reuse this id rather than re-resolving from the reaction
   * event so the answer routes to the same tenant that the original
   * reaction was emitted for.
   */
  workspaceId: string;
  /** Epoch ms when this entry was recorded. */
  recordedAt: number;
}

/**
 * Time after which a pending-answer entry is forgotten.
 *
 * Two hours feels right: long enough that a user can step away and
 * come back to react, short enough that the in-memory map can't bloat
 * unbounded. Persistent storage of pending answers can land later if
 * data shows it matters; reaction-back within 2h is the realistic
 * happy path.
 */
export const PENDING_ANSWER_TTL_MS = 2 * 60 * 60 * 1000;

/** Hard cap on the in-memory registry. Oldest entries evict on overflow. */
export const PENDING_ANSWER_MAX_ENTRIES = 10_000;

/**
 * In-memory registry of "Atlas reacted, waiting for asker to opt in".
 *
 * Single-process only — multi-pod deployments would need a shared
 * store, but for slice #2293 (Slack-first, low scale) a Map suffices.
 * The pause + meter slices already plan to move state into PG/Redis;
 * we'll piggyback then.
 */
export class PendingAnswers {
  private readonly store = new Map<string, PendingAnswerEntry>();

  constructor(
    private readonly ttlMs: number = PENDING_ANSWER_TTL_MS,
    private readonly maxEntries: number = PENDING_ANSWER_MAX_ENTRIES,
    private readonly now: () => number = Date.now,
  ) {}

  /** Build the lookup key from thread + message IDs. */
  static key(threadId: string, messageId: string): string {
    return `${threadId}:${messageId}`;
  }

  /** Record that Atlas reacted to a message and is waiting on opt-in. */
  record(threadId: string, messageId: string, entry: Omit<PendingAnswerEntry, "recordedAt">): void {
    if (this.store.size >= this.maxEntries) {
      // Evict the oldest entry to keep the map bounded. Insertion order
      // in a Map is preserved, so the first key is the oldest.
      const oldestKey = this.store.keys().next().value;
      if (oldestKey) this.store.delete(oldestKey);
    }
    this.store.set(PendingAnswers.key(threadId, messageId), {
      ...entry,
      recordedAt: this.now(),
    });
  }

  /**
   * Look up and consume a pending entry. Returns null if missing or
   * expired. Consuming is by design — an asker who reacts twice
   * should not trigger two answers.
   */
  consume(threadId: string, messageId: string): PendingAnswerEntry | null {
    const key = PendingAnswers.key(threadId, messageId);
    const entry = this.store.get(key);
    if (!entry) return null;
    if (this.now() - entry.recordedAt > this.ttlMs) {
      this.store.delete(key);
      return null;
    }
    this.store.delete(key);
    return entry;
  }

  /** Read-only peek for tests; does not consume. */
  peek(threadId: string, messageId: string): PendingAnswerEntry | null {
    const entry = this.store.get(PendingAnswers.key(threadId, messageId));
    if (!entry) return null;
    if (this.now() - entry.recordedAt > this.ttlMs) return null;
    return entry;
  }

  /** Current size for tests + admin diagnostics. */
  size(): number {
    return this.store.size;
  }
}

// ---------------------------------------------------------------------------
// Reaction-back gating (pure)
// ---------------------------------------------------------------------------

/** Decision returned by `shouldAnswerOnReaction`. */
export type ReactionAnswerDecision =
  | { action: "answer"; pending: PendingAnswerEntry }
  | { action: "skip"; reason: "self-reaction" | "unknown-message" | "removed" };

export interface ShouldAnswerOnReactionInput {
  /** Whether the reaction was added (`true`) or removed (`false`). */
  added: boolean;
  /** Author of the reaction. Self-reactions are ignored. */
  reactor: Pick<Author, "isMe" | "isBot" | "userId">;
  /** Pending lookup; consumed when answered to prevent double-fire. */
  pending: PendingAnswerEntry | null;
}

/**
 * Pure decision for whether a reaction triggers an answer.
 *
 * Separated from the side-effecting handler so the decision matrix can
 * be unit-tested without faking the Chat SDK.
 */
export function shouldAnswerOnReaction(
  input: ShouldAnswerOnReactionInput,
): ReactionAnswerDecision {
  if (!input.added) return { action: "skip", reason: "removed" };
  if (input.reactor.isMe || input.reactor.isBot === true) {
    return { action: "skip", reason: "self-reaction" };
  }
  if (!input.pending) return { action: "skip", reason: "unknown-message" };
  return { action: "answer", pending: input.pending };
}
