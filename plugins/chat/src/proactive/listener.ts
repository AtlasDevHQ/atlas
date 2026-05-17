/**
 * Proactive chat listener wiring.
 *
 * Registers an `onNewMessage` handler on the Chat SDK so that channel
 * messages (which would otherwise fall through) get classified and —
 * when policy says so — reacted to with 🤖.
 *
 * Slice #2292 stops at the reaction. The reply path lands in #2293.
 *
 * Important: this module never imports `@atlas/ee` directly. The host
 * (typically `packages/api`) wires `isEnabled` to
 * `isEnterpriseEnabled() && workspaceFlag` so the plugin stays
 * decoupled from the enterprise gate.
 */

import { emoji } from "chat";
import type { Chat, Message, Thread } from "chat";
import type { PluginLogger } from "@useatlas/plugin-sdk";
import { classifyMessage } from "./classifier";
import { decideInterjection } from "./policy";
import type {
  ChannelProactiveConfig,
  LLMClassifierFn,
  ProactiveGateFn,
  RecentActivity,
  WorkspaceProactiveConfig,
} from "./types";

// ---------------------------------------------------------------------------
// Public config
// ---------------------------------------------------------------------------

/** Configuration for the proactive listener. */
export interface ProactiveListenerConfig {
  /** Gate: returns true when proactive mode is allowed (enterprise + workspace flag). */
  isEnabled: ProactiveGateFn;
  /** LLM classifier callback. Plugins do not own the model wiring. */
  classify: LLMClassifierFn;
  /** Workspace-level config. */
  workspace: WorkspaceProactiveConfig;
  /**
   * Optional explicit channel allowlist. If omitted, the listener reads
   * `ATLAS_PROACTIVE_CHANNELS` (comma-separated channel IDs). This is
   * intentionally crude for slice #2292 — admin UI lands in #2294.
   */
  channelAllowlist?: string[];
  /** Per-channel overrides keyed by channel ID. */
  channelConfigs?: Record<string, ChannelProactiveConfig>;
}

/**
 * Reaction emoji used when policy decides to interject.
 *
 * `robot_face` isn't in the Chat SDK's well-known emoji map, so we go
 * through the SDK's `custom()` escape hatch. The adapter resolves the
 * shortcode per platform (`:robot_face:` on Slack, 🤖 on Google Chat,
 * etc.) so the plugin stays free of raw Unicode.
 */
export const PROACTIVE_REACTION = emoji.custom("robot_face");

// ---------------------------------------------------------------------------
// Channel allowlist resolution
// ---------------------------------------------------------------------------

/** Resolve the channel allowlist from config or `ATLAS_PROACTIVE_CHANNELS`. */
export function resolveChannelAllowlist(
  explicit: string[] | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Set<string> {
  if (explicit && explicit.length > 0) return new Set(explicit);
  const raw = env.ATLAS_PROACTIVE_CHANNELS ?? "";
  return new Set(
    raw
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
}

// ---------------------------------------------------------------------------
// Listener registration
// ---------------------------------------------------------------------------

/**
 * Register the proactive listener on a Chat SDK instance.
 *
 * Does nothing (and logs at debug) when `isEnabled()` returns falsy at
 * registration time. The gate is *also* re-checked inside the handler
 * for every message so that a workspace toggle flip takes effect
 * without restart.
 */
export async function registerProactiveListener(
  chat: Chat,
  log: PluginLogger,
  config: ProactiveListenerConfig,
): Promise<void> {
  const enabledAtRegistration = await config.isEnabled();
  if (!enabledAtRegistration) {
    log.debug("Proactive listener not registered — gate is closed");
    return;
  }

  const allowlist = resolveChannelAllowlist(config.channelAllowlist);
  log.info(
    { allowlistSize: allowlist.size },
    "Proactive listener registered",
  );

  // Per-channel last-interjection timestamps for rate limiting. In-memory
  // is fine for slice #2292 — #2296 swaps in a durable meter.
  const recent = new Map<string, RecentActivity>();

  // Match any non-empty message. The classifier+policy gate downstream.
  chat.onNewMessage(/.+/, async (thread: Thread, message: Message) => {
    try {
      // Re-check the gate per message so a workspace toggle flip wins
      // without a restart.
      if (!(await config.isEnabled())) return;

      // Bots (including this one) and empty messages bypass the
      // classifier outright.
      if (message.author.isBot === true || message.author.isMe) return;
      const text = message.text?.trim() ?? "";
      if (text.length === 0) return;

      const channelId = thread.channelId;
      const channelAllowed = allowlist.has(channelId);
      const channelConfig = config.channelConfigs?.[channelId];

      const classification = await classifyMessage({
        text,
        mode: config.workspace.classifierMode,
        llm: config.classify,
      });

      const decision = decideInterjection({
        classification,
        workspace: config.workspace,
        channel: channelConfig,
        channelAllowed,
        recentActivity: recent.get(channelId),
      });

      log.debug(
        {
          channelId,
          messageId: message.id,
          isQuestion: classification.isQuestion,
          confidence: classification.confidence,
          action: decision.action,
          reason: decision.reason,
        },
        "Proactive classification decision",
      );

      if (decision.action !== "react") return;

      const sent = thread.createSentMessageFromMessage(message);
      await sent.addReaction(PROACTIVE_REACTION);
      recent.set(channelId, { lastInterjectionAt: Date.now() });
    } catch (err) {
      // Listener must never crash the Chat SDK event loop.
      log.warn(
        {
          err: err instanceof Error ? err : new Error(String(err)),
          messageId: message?.id,
        },
        "Proactive listener handler threw — suppressed",
      );
    }
  });
}
