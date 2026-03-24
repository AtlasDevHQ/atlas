/**
 * Status reaction lifecycle for chat messages.
 *
 * Adds visual feedback reactions to user messages as queries progress:
 *   received (👀) → processing (⏳) → complete (✅) or error (⚠️)
 *
 * Uses Chat SDK's type-safe emoji API — no raw Unicode strings. All
 * operations are best-effort: reaction failures are caught and logged
 * at debug level. The public methods on {@link IReactionLifecycle} never
 * throw — callers can safely await them without try/catch.
 */

import { emoji } from "chat";
import type { EmojiValue, Adapter } from "chat";
import type { PluginLogger } from "@useatlas/plugin-sdk";

// ---------------------------------------------------------------------------
// Status emoji
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
// Interface
// ---------------------------------------------------------------------------

/** Public contract for reaction lifecycle management. */
export interface IReactionLifecycle {
  /** Mark the message as received (default: eyes emoji). */
  markReceived(): Promise<void>;
  /** Mark the message as being processed (default: hourglass emoji). */
  markProcessing(): Promise<void>;
  /** Mark the query as successfully completed (default: check emoji). */
  markComplete(): Promise<void>;
  /** Mark the query as failed (default: warning emoji). */
  markError(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Manages the reaction lifecycle on a single user message.
 *
 * Each transition removes the previous reaction and adds the new one.
 * All operations are best-effort — failures are caught at every level
 * and never propagated. This ensures reactions never block or fail a
 * query execution.
 */
export class ReactionLifecycle implements IReactionLifecycle {
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

  async markReceived(): Promise<void> {
    await this.transition(this.received);
  }

  async markProcessing(): Promise<void> {
    await this.transition(this.processing);
  }

  async markComplete(): Promise<void> {
    await this.transition(this.complete);
  }

  async markError(): Promise<void> {
    await this.transition(this.errEmoji);
  }

  /**
   * Transition to a new status emoji. Removes the previous reaction
   * first, then adds the new one. Both steps are independently
   * best-effort — a failed removal doesn't prevent the new reaction.
   *
   * The outer try/catch ensures this method never throws, even if the
   * logger or adapter has unexpected failures.
   */
  private async transition(next: EmojiValue): Promise<void> {
    try {
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
    } catch {
      // intentionally ignored: outermost guard ensures transition() never throws,
      // even if the logger itself fails during error handling above.
    }
  }
}

/** No-op lifecycle stub returned when reactions are explicitly disabled. */
const NOOP_LIFECYCLE: IReactionLifecycle = {
  markReceived: () => Promise.resolve(),
  markProcessing: () => Promise.resolve(),
  markComplete: () => Promise.resolve(),
  markError: () => Promise.resolve(),
};

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
): IReactionLifecycle {
  if (config?.enabled === false) return NOOP_LIFECYCLE;
  return new ReactionLifecycle(adapter, threadId, messageId, log, config);
}
