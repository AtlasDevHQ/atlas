/**
 * Status reaction lifecycle for chat messages.
 *
 * Adds visual feedback reactions to user messages as queries progress:
 *   received (👀) → processing (⏳) → complete (✅) or error (⚠️)
 *
 * Uses Chat SDK's type-safe emoji API — no raw Unicode strings. All
 * operations are best-effort: reaction failures are logged at debug
 * level and never fail the query.
 */

import { emoji } from "chat";
import type { EmojiValue, Adapter } from "chat";
import type { PluginLogger } from "@useatlas/plugin-sdk";

// ---------------------------------------------------------------------------
// Status emoji (type-safe via Chat SDK singletons)
// ---------------------------------------------------------------------------

/** Default emoji for each lifecycle stage. */
export const StatusEmoji = {
  received: emoji.eyes,
  processing: emoji.hourglass,
  complete: emoji.check,
  error: emoji.warning,
} as const;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Reaction lifecycle configuration. */
export interface ReactionConfig {
  /** Enable status reactions on user messages. Default: true. */
  enabled?: boolean;
  /** Custom emoji overrides for each lifecycle stage.
   * Use Chat SDK's `emoji` helper for type-safe values, or
   * `emoji.custom("my_emoji")` for workspace-specific emoji. */
  customEmoji?: {
    received?: EmojiValue;
    processing?: EmojiValue;
    complete?: EmojiValue;
    error?: EmojiValue;
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Manages the reaction lifecycle on a single user message.
 *
 * Each transition removes the previous reaction and adds the new one.
 * All operations are best-effort — failures are logged at debug level
 * and never propagated. This ensures reactions never block or fail a
 * query execution.
 */
export class ReactionLifecycle {
  private readonly adapter: Adapter;
  private readonly threadId: string;
  private readonly messageId: string;
  private readonly log: PluginLogger;
  private readonly received: EmojiValue;
  private readonly processing: EmojiValue;
  private readonly complete: EmojiValue;
  private readonly errEmoji: EmojiValue;
  private currentEmoji: EmojiValue | null = null;

  constructor(
    adapter: Adapter,
    threadId: string,
    messageId: string,
    log: PluginLogger,
    config?: ReactionConfig,
  ) {
    this.adapter = adapter;
    this.threadId = threadId;
    this.messageId = messageId;
    this.log = log;
    this.received = config?.customEmoji?.received ?? StatusEmoji.received;
    this.processing = config?.customEmoji?.processing ?? StatusEmoji.processing;
    this.complete = config?.customEmoji?.complete ?? StatusEmoji.complete;
    this.errEmoji = config?.customEmoji?.error ?? StatusEmoji.error;
  }

  /** React with 👀 — "I see your message". */
  async markReceived(): Promise<void> {
    await this.transition(this.received);
  }

  /** React with ⏳ — "Processing your query". */
  async markProcessing(): Promise<void> {
    await this.transition(this.processing);
  }

  /** React with ✅ — "Query completed successfully". */
  async markComplete(): Promise<void> {
    await this.transition(this.complete);
  }

  /** React with ⚠️ — "Query encountered an error". */
  async markError(): Promise<void> {
    await this.transition(this.errEmoji);
  }

  /**
   * Transition to a new status emoji. Removes the previous reaction
   * first, then adds the new one. Both steps are independently
   * best-effort — a failed removal doesn't prevent the new reaction.
   */
  private async transition(next: EmojiValue): Promise<void> {
    if (this.currentEmoji) {
      try {
        await this.adapter.removeReaction(this.threadId, this.messageId, this.currentEmoji);
      } catch (err) {
        this.log.debug(
          { err: err instanceof Error ? err : new Error(String(err)), threadId: this.threadId },
          "Failed to remove previous reaction — continuing",
        );
      }
    }

    try {
      await this.adapter.addReaction(this.threadId, this.messageId, next);
      this.currentEmoji = next;
    } catch (err) {
      this.log.debug(
        { err: err instanceof Error ? err : new Error(String(err)), threadId: this.threadId },
        `Failed to add ${next.name} reaction — continuing without indicator`,
      );
    }
  }
}

/** No-op lifecycle stub for disabled reactions or unsupported contexts. */
const NOOP_LIFECYCLE: ReactionLifecycle = {
  markReceived: () => Promise.resolve(),
  markProcessing: () => Promise.resolve(),
  markComplete: () => Promise.resolve(),
  markError: () => Promise.resolve(),
} as unknown as ReactionLifecycle;

/**
 * Create a ReactionLifecycle for a user message, or a no-op stub
 * when reactions are disabled.
 */
export function createReactionLifecycle(
  adapter: Adapter,
  threadId: string,
  messageId: string,
  log: PluginLogger,
  config?: ReactionConfig,
): ReactionLifecycle {
  if (config?.enabled === false) return NOOP_LIFECYCLE;
  return new ReactionLifecycle(adapter, threadId, messageId, log, config);
}
