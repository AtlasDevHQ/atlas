/**
 * Chat SDK ↔ Atlas bridge.
 *
 * Maps Chat SDK lifecycle and events to Atlas plugin callbacks:
 *
 * - `onNewMention` → subscribe thread + `executeQuery` → `thread.post()`
 * - `onSubscribedMessage` → `executeQuery` with thread history → `thread.post()`
 * - Error scrubbing prevents leaking connection strings, stack traces, or
 *   internal errors to chat platforms
 *
 * The bridge owns the Chat SDK `Chat` instance and exposes its webhook
 * handlers for route mounting.
 */

import { Chat } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { PluginLogger } from "@useatlas/plugin-sdk";
import type { ChatPluginConfig, ChatQueryResult, ChatMessage } from "./config";
import { createSlackAdapter } from "./adapters/slack";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Thread conversation history for follow-up context. */
interface ThreadHistory {
  messages: ChatMessage[];
}

/** Maximum number of threads to keep history for (LRU eviction). */
const MAX_THREAD_HISTORIES = 10_000;

/** Maximum messages per thread history. */
const MAX_MESSAGES_PER_THREAD = 200;

/** Scrubbing patterns for error messages — never expose these to users. */
const SENSITIVE_PATTERNS = [
  // Connection strings
  /(?:postgres(?:ql)?|mysql|mongodb|redis|clickhouse):\/\/[^\s]+/gi,
  // Stack traces
  /\bat\s+[\w$.]+\s*\([^)]*:\d+:\d+\)/g,
  // File paths
  /\/(?:home|usr|var|tmp|app|src)\/[^\s:]+/g,
  // API keys / tokens
  /(?:sk-|xoxb-|xoxp-|ghp_|gho_|Bearer\s+)\S+/gi,
];

// ---------------------------------------------------------------------------
// Response formatting
// ---------------------------------------------------------------------------

/**
 * Format a ChatQueryResult as a markdown string suitable for chat platforms.
 * The Chat SDK handles markdown → platform-native conversion (Block Kit, etc).
 */
export function formatQueryResponse(result: ChatQueryResult): string {
  const parts: string[] = [];

  // Answer
  parts.push(result.answer || "No answer generated.");

  // SQL
  if (result.sql.length > 0) {
    parts.push(`\n**SQL**\n\`\`\`sql\n${result.sql.join("\n\n")}\n\`\`\``);
  }

  // Data tables
  for (const dataset of result.data) {
    if (!dataset.columns.length || !dataset.rows.length) continue;

    const table = formatDataTable(dataset.columns, dataset.rows);
    if (table) parts.push(table);
  }

  // Metadata
  parts.push(
    `\n_${result.steps} steps | ${result.usage.totalTokens.toLocaleString()} tokens_`,
  );

  return parts.join("\n");
}

function formatDataTable(
  columns: string[],
  rows: Record<string, unknown>[],
  maxRows = 20,
): string | null {
  if (columns.length === 0 || rows.length === 0) return null;

  const displayRows = rows.slice(0, maxRows);
  const header = `| ${columns.join(" | ")} |`;
  const separator = `| ${columns.map(() => "---").join(" | ")} |`;
  const dataLines = displayRows.map(
    (row) => `| ${columns.map((col) => String(row[col] ?? "")).join(" | ")} |`,
  );

  let table = [header, separator, ...dataLines].join("\n");

  if (rows.length > maxRows) {
    table += `\n_Showing first ${maxRows} of ${rows.length} rows_`;
  }

  return table;
}

// ---------------------------------------------------------------------------
// Error scrubbing
// ---------------------------------------------------------------------------

/**
 * Scrub sensitive information from error messages before sending to chat.
 * Applies built-in patterns, then delegates to the user-provided scrubber.
 */
export function scrubErrorMessage(
  message: string,
  userScrubber?: (msg: string) => string,
): string {
  let scrubbed = message;
  for (const pattern of SENSITIVE_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, "[REDACTED]");
  }
  if (userScrubber) {
    try {
      scrubbed = userScrubber(scrubbed);
    } catch {
      // intentionally ignored: user scrubber failure should not prevent
      // error delivery — the built-in scrubbing has already run.
    }
  }
  return scrubbed;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Safely post an error message to a chat thread with double-fault protection. */
async function safePostError(
  thread: { post: (msg: string) => Promise<unknown> },
  message: string,
  log: PluginLogger,
  threadId: string,
): Promise<void> {
  try {
    await thread.post(message);
  } catch (postErr) {
    log.warn(
      { err: postErr instanceof Error ? postErr : new Error(String(postErr)), threadId },
      "Failed to deliver error message to chat thread",
    );
  }
}

/** Evict oldest entries when the thread history map exceeds the max size. */
function evictOldHistories(histories: Map<string, ThreadHistory>): void {
  if (histories.size <= MAX_THREAD_HISTORIES) return;
  const keysToDelete = [...histories.keys()].slice(
    0,
    histories.size - MAX_THREAD_HISTORIES,
  );
  for (const key of keysToDelete) {
    histories.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

export interface ChatBridge {
  /** Platform webhook handlers (e.g., `webhooks.slack`). */
  readonly webhooks: Chat["webhooks"];
  /** Shut down the Chat SDK instance and clean up resources. */
  shutdown(): Promise<void>;
}

/**
 * Create a Chat SDK bridge wired to Atlas callbacks.
 *
 * The bridge:
 * 1. Creates adapter instances from config
 * 2. Sets up onNewMention → subscribe + executeQuery → thread.post
 * 3. Sets up onSubscribedMessage → executeQuery with history → thread.post
 * 4. Exposes webhook handlers for route mounting
 */
export function createChatBridge(
  config: ChatPluginConfig,
  log: PluginLogger,
): ChatBridge {
  // Build adapters from config
  const adapters: Record<string, ReturnType<typeof createSlackAdapter>> = {};

  if (config.adapters.slack) {
    adapters.slack = createSlackAdapter(config.adapters.slack);
    log.info("Slack adapter configured");
  }

  // In-memory state for dev/testing. Atlas internal DB adapter in #772.
  const state = createMemoryState();

  const chat = new Chat({
    userName: "atlas",
    adapters,
    state,
  });

  // Per-thread conversation history (in-memory for now, #772 adds persistence)
  const threadHistories = new Map<string, ThreadHistory>();

  // --- onNewMention: first interaction in a thread ---
  chat.onNewMention(async (thread, message) => {
    const threadId = `${thread.adapter.name}:${thread.id}`;
    const question = message.text?.trim();

    if (!question) {
      log.debug({ threadId }, "Empty mention received, ignoring");
      return;
    }

    log.info(
      { threadId, question: question.slice(0, 100) },
      "New mention received",
    );

    try {
      // Rate limiting
      if (config.checkRateLimit) {
        try {
          const check = config.checkRateLimit(threadId);
          if (!check.allowed) {
            await thread.post(
              "Rate limit exceeded. Please wait before trying again.",
            );
            return;
          }
        } catch (rateLimitErr) {
          log.error(
            { err: rateLimitErr instanceof Error ? rateLimitErr : new Error(String(rateLimitErr)), threadId },
            "Rate limit check failed — denying request",
          );
          await safePostError(
            thread,
            "Unable to verify rate limits. Please try again shortly.",
            log,
            threadId,
          );
          return;
        }
      }

      // Subscribe for follow-up messages
      await thread.subscribe();

      const result = await config.executeQuery(question, { threadId });

      // Store history for follow-ups (with eviction)
      threadHistories.set(threadId, {
        messages: [
          { role: "user", content: question },
          { role: "assistant", content: result.answer },
        ],
      });
      evictOldHistories(threadHistories);

      const response = formatQueryResponse(result);
      await thread.post({ markdown: response });
    } catch (err) {
      const rawMessage =
        err instanceof Error ? err.message : String(err);
      log.error(
        { err: err instanceof Error ? err : new Error(String(err)), threadId },
        "Query execution failed",
      );

      const errorMessage = scrubErrorMessage(rawMessage, config.scrubError);
      await safePostError(
        thread,
        `I was unable to answer your question: ${errorMessage}. This may be a transient issue — please try again in a few seconds.`,
        log,
        threadId,
      );
    }
  });

  // --- onSubscribedMessage: follow-up in a subscribed thread ---
  chat.onSubscribedMessage(async (thread, message) => {
    const threadId = `${thread.adapter.name}:${thread.id}`;
    const question = message.text?.trim();

    if (!question) {
      log.debug({ threadId }, "Empty follow-up message, ignoring");
      return;
    }

    log.info(
      { threadId, question: question.slice(0, 100) },
      "Follow-up message received",
    );

    try {
      // Rate limiting
      if (config.checkRateLimit) {
        try {
          const check = config.checkRateLimit(threadId);
          if (!check.allowed) {
            await thread.post(
              "Rate limit exceeded. Please wait before trying again.",
            );
            return;
          }
        } catch (rateLimitErr) {
          log.error(
            { err: rateLimitErr instanceof Error ? rateLimitErr : new Error(String(rateLimitErr)), threadId },
            "Rate limit check failed — denying request",
          );
          await safePostError(
            thread,
            "Unable to verify rate limits. Please try again shortly.",
            log,
            threadId,
          );
          return;
        }
      }

      // Build prior message context
      const history = threadHistories.get(threadId);
      const priorMessages = history?.messages;

      const result = await config.executeQuery(question, {
        threadId,
        priorMessages,
      });

      // Append to history (with truncation)
      const existing = threadHistories.get(threadId) ?? { messages: [] };
      existing.messages.push(
        { role: "user", content: question },
        { role: "assistant", content: result.answer },
      );
      if (existing.messages.length > MAX_MESSAGES_PER_THREAD) {
        existing.messages.splice(0, existing.messages.length - MAX_MESSAGES_PER_THREAD);
      }
      threadHistories.set(threadId, existing);

      const response = formatQueryResponse(result);
      await thread.post({ markdown: response });
    } catch (err) {
      const rawMessage =
        err instanceof Error ? err.message : String(err);
      log.error(
        { err: err instanceof Error ? err : new Error(String(err)), threadId },
        "Follow-up query execution failed",
      );

      const errorMessage = scrubErrorMessage(rawMessage, config.scrubError);
      await safePostError(
        thread,
        `I was unable to process your follow-up: ${errorMessage}. This may be a transient issue — please try again in a few seconds.`,
        log,
        threadId,
      );
    }
  });

  return {
    webhooks: chat.webhooks,
    async shutdown() {
      threadHistories.clear();
      await chat.shutdown();
      log.info("Chat bridge shut down");
    },
  };
}
