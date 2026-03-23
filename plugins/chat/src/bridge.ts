/**
 * Chat SDK ↔ Atlas bridge.
 *
 * Maps Chat SDK lifecycle and events to Atlas plugin callbacks:
 *
 * - `onNewMention` → lock + subscribe thread + `executeQuery` → `thread.post()`
 * - `onSubscribedMessage` → lock + `executeQuery` with thread history → `thread.post()`
 * - Error scrubbing prevents leaking connection strings, stack traces, or
 *   internal errors to chat platforms
 *
 * The bridge owns the Chat SDK `Chat` instance and exposes its webhook
 * handlers for route mounting. State is delegated to the injected
 * StateAdapter (memory, PG, or future Redis).
 */

import { Chat } from "chat";
import type { StateAdapter, Lock } from "chat";
import type { PluginLogger } from "@useatlas/plugin-sdk";
import type { ChatPluginConfig, ChatQueryResult, ChatMessage } from "./config";
import { createSlackAdapter } from "./adapters/slack";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum messages per thread conversation history. */
const MAX_MESSAGES_PER_THREAD = 200;

/** TTL for conversation history entries (7 days). */
const CONVERSATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** TTL for event dedup locks (30 seconds). */
const DEDUP_LOCK_TTL_MS = 30_000;

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
    } catch (scrubErr) {
      // intentionally non-fatal: user scrubber failure should not prevent
      // error delivery — the built-in scrubbing has already run.
      console.debug(
        "User scrubError callback threw:",
        scrubErr instanceof Error ? scrubErr.message : String(scrubErr),
      );
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

/** State adapter key for conversation history. */
function convKey(threadId: string): string {
  return `conv:${threadId}`;
}

/**
 * Attempt to acquire a dedup lock. Returns the lock on success, null if
 * already locked, or null (with a warning log) if the adapter throws.
 */
async function tryAcquireLock(
  stateAdapter: StateAdapter,
  lockKey: string,
  ttlMs: number,
  log: PluginLogger,
  threadId: string,
): Promise<Lock | null> {
  try {
    return await stateAdapter.acquireLock(lockKey, ttlMs);
  } catch (lockErr) {
    log.error(
      { err: lockErr instanceof Error ? lockErr : new Error(String(lockErr)), threadId },
      "Failed to acquire dedup lock — processing without lock protection",
    );
    // Return a synthetic lock so the handler still runs; releaseLock
    // will be a no-op (token won't match anything in the backend).
    return { threadId: lockKey, token: "synthetic-fallback", expiresAt: Date.now() + ttlMs };
  }
}

/** Persist conversation messages — non-fatal; failures are logged. */
async function persistHistory(
  stateAdapter: StateAdapter,
  threadId: string,
  messages: ChatMessage[],
  log: PluginLogger,
): Promise<void> {
  try {
    for (const msg of messages) {
      await stateAdapter.appendToList(
        convKey(threadId),
        msg,
        { maxLength: MAX_MESSAGES_PER_THREAD, ttlMs: CONVERSATION_TTL_MS },
      );
    }
  } catch (historyErr) {
    log.warn(
      { err: historyErr instanceof Error ? historyErr : new Error(String(historyErr)), threadId },
      "Failed to persist conversation history — follow-ups may lack context",
    );
  }
}

/** Retrieve prior conversation context — non-fatal; returns undefined on failure. */
async function retrieveHistory(
  stateAdapter: StateAdapter,
  threadId: string,
  log: PluginLogger,
): Promise<ChatMessage[] | undefined> {
  try {
    const messages = await stateAdapter.getList<ChatMessage>(convKey(threadId));
    return messages.length > 0 ? messages : undefined;
  } catch (historyErr) {
    log.warn(
      { err: historyErr instanceof Error ? historyErr : new Error(String(historyErr)), threadId },
      "Failed to retrieve conversation history — proceeding without context",
    );
    return undefined;
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
 * 2. Sets up onNewMention → lock + subscribe + executeQuery → thread.post
 * 3. Sets up onSubscribedMessage → lock + executeQuery with history → thread.post
 * 4. Exposes webhook handlers for route mounting
 *
 * @param config       - Chat plugin configuration
 * @param log          - Plugin-scoped logger
 * @param stateAdapter - Chat SDK state adapter (memory, PG, or future Redis)
 */
export function createChatBridge(
  config: ChatPluginConfig,
  log: PluginLogger,
  stateAdapter: StateAdapter,
): ChatBridge {
  // Build adapters from config
  const adapters: Record<string, ReturnType<typeof createSlackAdapter>> = {};

  if (config.adapters.slack) {
    adapters.slack = createSlackAdapter(config.adapters.slack);
    log.info("Slack adapter configured");
  }

  const chat = new Chat({
    userName: "atlas",
    adapters,
    state: stateAdapter,
  });

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

    // Dedup lock — prevent duplicate processing of the same event
    const lock = await tryAcquireLock(stateAdapter, `bridge:${threadId}`, DEDUP_LOCK_TTL_MS, log, threadId);
    if (!lock) {
      log.debug({ threadId }, "Thread locked — event already being processed");
      return;
    }

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

      // Post the response first — ensure the user gets the answer
      const response = formatQueryResponse(result);
      await thread.post({ markdown: response });

      // Persist conversation history (non-fatal)
      await persistHistory(stateAdapter, threadId, [
        { role: "user", content: question },
        { role: "assistant", content: result.answer },
      ], log);
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
    } finally {
      await stateAdapter.releaseLock(lock).catch((releaseErr: unknown) => {
        log.error(
          { err: releaseErr instanceof Error ? releaseErr : new Error(String(releaseErr)), threadId },
          "Failed to release thread lock — thread may be blocked until TTL expires",
        );
      });
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

    // Dedup lock — prevent duplicate processing
    const lock = await tryAcquireLock(stateAdapter, `bridge:${threadId}`, DEDUP_LOCK_TTL_MS, log, threadId);
    if (!lock) {
      log.debug({ threadId }, "Thread locked — event already being processed");
      return;
    }

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

      // Retrieve prior conversation context (non-fatal — falls back to no context)
      const priorMessages = await retrieveHistory(stateAdapter, threadId, log);

      const result = await config.executeQuery(question, {
        threadId,
        priorMessages,
      });

      // Post the response first — ensure the user gets the answer
      const response = formatQueryResponse(result);
      await thread.post({ markdown: response });

      // Persist conversation history (non-fatal)
      await persistHistory(stateAdapter, threadId, [
        { role: "user", content: question },
        { role: "assistant", content: result.answer },
      ], log);
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
    } finally {
      await stateAdapter.releaseLock(lock).catch((releaseErr: unknown) => {
        log.error(
          { err: releaseErr instanceof Error ? releaseErr : new Error(String(releaseErr)), threadId },
          "Failed to release thread lock — thread may be blocked until TTL expires",
        );
      });
    }
  });

  return {
    webhooks: chat.webhooks,
    async shutdown() {
      await chat.shutdown();
      log.info("Chat bridge shut down");
    },
  };
}
