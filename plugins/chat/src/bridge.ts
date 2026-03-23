/**
 * Chat SDK ↔ Atlas bridge.
 *
 * Maps Chat SDK lifecycle and events to Atlas plugin callbacks:
 *
 * - `onNewMention` → lock + subscribe thread + `executeQuery` → `thread.post()`
 * - `onSubscribedMessage` → lock + `executeQuery` with thread history → `thread.post()`
 * - `onSlashCommand("/atlas")` → post thinking → subscribe → `executeQuery` → edit
 * - `onAction("atlas_action_approve"|"atlas_action_deny")` → approve/deny → edit message
 * - Error scrubbing prevents leaking connection strings, stack traces, or
 *   internal errors to chat platforms
 *
 * The bridge owns the Chat SDK `Chat` instance and exposes its webhook
 * handlers for route mounting. State is delegated to the injected
 * StateAdapter (memory, PG, or future Redis).
 */

import { Chat } from "chat";
import type { Adapter, StateAdapter, Lock, CardElement, CardChild } from "chat";
import type { PluginLogger } from "@useatlas/plugin-sdk";
import type {
  ChatPluginConfig,
  ChatQueryResult,
  ChatMessage,
  PendingAction,
} from "./config";

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
// Card builders
// ---------------------------------------------------------------------------

/**
 * Build a Chat SDK card for an action approval prompt.
 * The adapter converts this to Block Kit (Slack), Adaptive Cards (Teams), etc.
 */
export function buildApprovalCard(action: PendingAction): CardElement {
  return {
    type: "card",
    children: [
      {
        type: "section",
        children: [
          {
            type: "text",
            text: `\u{1F512} **Action requires approval**\n${(action.summary || action.type).slice(0, 200)}`,
          } as unknown as CardChild,
        ],
      },
      {
        type: "actions",
        children: [
          {
            type: "button",
            id: "atlas_action_approve",
            label: "Approve",
            style: "primary" as const,
            value: action.id,
          },
          {
            type: "button",
            id: "atlas_action_deny",
            label: "Deny",
            style: "danger" as const,
            value: action.id,
          },
        ],
      },
    ],
  } as CardElement;
}

/**
 * Build a markdown string for a resolved action status.
 */
export function formatActionResult(
  action: PendingAction,
  status: "approved" | "denied" | "executed" | "failed",
  error?: string,
): string {
  const emoji =
    status === "executed" || status === "approved"
      ? "\u2705"
      : status === "denied"
        ? "\u26D4"
        : "\u274C";

  let text = `${emoji} **Action ${status}**: ${(action.summary || action.type).slice(0, 200)}`;
  if (error) text += `\n_${error.slice(0, 200)}_`;
  return text;
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
  thread: { post: (msg: string | { markdown: string }) => Promise<unknown> },
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

/** State adapter key for conversation ID mapping. */
function convIdKey(threadId: string): string {
  return `conv-id:${threadId}`;
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

/**
 * Create or look up a conversation via the host's conversation callbacks.
 * Non-fatal — failures are logged and return null.
 */
async function ensureConversation(
  config: ChatPluginConfig,
  stateAdapter: StateAdapter,
  threadId: string,
  question: string,
  log: PluginLogger,
): Promise<string | null> {
  if (!config.conversations) return null;

  try {
    // Check if conversation already exists for this thread
    const existing = await stateAdapter.get<string>(convIdKey(threadId));
    if (existing) return existing;

    // Create new conversation
    const conversationId = crypto.randomUUID();
    const result = await config.conversations.create({
      id: conversationId,
      title: config.conversations.generateTitle(question),
      surface: "chat-sdk",
    });

    if (result) {
      await stateAdapter.set(convIdKey(threadId), result.id, CONVERSATION_TTL_MS);
      return result.id;
    }
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err : new Error(String(err)), threadId },
      "Failed to create conversation via callbacks",
    );
  }
  return null;
}

/**
 * Persist messages to the host's conversation system — non-fatal.
 * Async to handle implementations that return promises from addMessage.
 */
async function persistConversationMessages(
  config: ChatPluginConfig,
  conversationId: string | null,
  question: string,
  answer: string,
  log: PluginLogger,
  threadId: string,
): Promise<void> {
  if (!config.conversations || !conversationId) return;

  try {
    await config.conversations.addMessage({
      conversationId,
      role: "user",
      content: question,
    });
    await config.conversations.addMessage({
      conversationId,
      role: "assistant",
      content: answer,
    });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err : new Error(String(err)), threadId },
      "Failed to persist conversation messages via callbacks",
    );
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
 * 1. Creates the Chat SDK instance from pre-built adapters
 * 2. Sets up onNewMention → lock + subscribe + executeQuery → thread.post
 * 3. Sets up onSubscribedMessage → lock + executeQuery with history → thread.post
 * 4. Sets up onSlashCommand("/atlas") → post thinking → subscribe → executeQuery → edit
 * 5. Sets up onAction for approval buttons → approve/deny → edit message
 * 6. Exposes webhook handlers for route mounting
 *
 * @param config       - Chat plugin configuration
 * @param log          - Plugin-scoped logger
 * @param stateAdapter - Chat SDK state adapter (memory, PG, or future Redis)
 * @param adapterInstances - Pre-built adapter instances (created by index.ts)
 */
export function createChatBridge(
  config: ChatPluginConfig,
  log: PluginLogger,
  stateAdapter: StateAdapter,
  adapterInstances: { slack?: Adapter | null },
): ChatBridge {
  // Build adapters dict from pre-built instances
  const adapters: Record<string, Adapter> = {};
  if (adapterInstances.slack) {
    adapters.slack = adapterInstances.slack;
    log.info("Slack adapter configured");
  }

  const chat = new Chat({
    userName: "atlas",
    adapters,
    state: stateAdapter,
  });

  // --- Shared handler logic ---

  async function handleQuery(
    threadId: string,
    question: string,
    postResponse: (response: string) => Promise<unknown>,
    postApproval: ((action: PendingAction) => Promise<void>) | null,
    priorMessages?: ChatMessage[],
  ): Promise<void> {
    const result = await config.executeQuery(question, {
      threadId,
      priorMessages,
    });

    // Post the response first — ensure the user gets the answer
    const response = formatQueryResponse(result);
    await postResponse(response);

    // Post ephemeral approval prompts for pending actions
    if (config.actions && result.pendingActions?.length && postApproval) {
      for (const action of result.pendingActions) {
        try {
          await postApproval(action);
        } catch (err) {
          log.warn(
            { err: err instanceof Error ? err : new Error(String(err)), threadId, actionId: action.id },
            "Failed to post action approval prompt",
          );
        }
      }
    }

    // Persist conversation history (non-fatal)
    await persistHistory(stateAdapter, threadId, [
      { role: "user", content: question },
      { role: "assistant", content: result.answer },
    ], log);

    // Persist to host conversation system (non-fatal)
    const conversationId = await ensureConversation(
      config, stateAdapter, threadId, question, log,
    );
    await persistConversationMessages(
      config, conversationId, question, result.answer, log, threadId,
    );
  }

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

      await handleQuery(
        threadId,
        question,
        (response) => thread.post({ markdown: response }),
        (action) =>
          thread.postEphemeral(
            message.author,
            { card: buildApprovalCard(action), fallbackText: `Action requires approval: ${action.summary}` },
            { fallbackToDM: false },
          ).then(() => {}),
      );
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

      await handleQuery(
        threadId,
        question,
        (response) => thread.post({ markdown: response }),
        (action) =>
          thread.postEphemeral(
            message.author,
            { card: buildApprovalCard(action), fallbackText: `Action requires approval: ${action.summary}` },
            { fallbackToDM: false },
          ).then(() => {}),
        priorMessages,
      );
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

  // --- onSlashCommand: /atlas <question> ---
  chat.onSlashCommand("/atlas", async (event) => {
    const question = event.text?.trim();
    const channelId = event.channel.id;

    if (!question) {
      try {
        await event.channel.postEphemeral(
          event.user,
          { markdown: "Usage: `/atlas <your question>`\nExample: `/atlas how many active users last month?`" },
          { fallbackToDM: false },
        );
      } catch (ephErr) {
        log.warn(
          { err: ephErr instanceof Error ? ephErr : new Error(String(ephErr)), channelId },
          "Failed to post usage hint ephemeral",
        );
      }
      return;
    }

    log.info(
      { channelId, userId: event.user.userId, question: question.slice(0, 100) },
      "Slash command received",
    );

    // Post thinking indicator
    let thinkingMsg;
    try {
      thinkingMsg = await event.channel.post({
        markdown: `\u231B Thinking about: _${question.slice(0, 150)}_...`,
      });
    } catch (postErr) {
      log.error(
        { err: postErr instanceof Error ? postErr : new Error(String(postErr)), channelId },
        "Failed to post thinking indicator for slash command",
      );
      try {
        await event.channel.postEphemeral(
          event.user,
          { markdown: "Unable to start processing your question. Please try again." },
          { fallbackToDM: false },
        );
      } catch {
        // intentionally ignored: double-fault — both post and ephemeral failed
      }
      return;
    }

    // Construct the thread ID for subscription.
    // Slack format: "slack:CHANNEL:THREAD_TS" — channel.id is "slack:CHANNEL",
    // thinkingMsg.id is the message timestamp.
    const threadId = `${channelId}:${thinkingMsg.id}`;

    // Dedup lock — prevent duplicate processing on Slack retries
    const lock = await tryAcquireLock(stateAdapter, `bridge:${threadId}`, DEDUP_LOCK_TTL_MS, log, threadId);
    if (!lock) {
      log.debug({ threadId }, "Slash command already being processed");
      return;
    }

    try {
      // Subscribe the thread for follow-up messages
      try {
        await stateAdapter.subscribe(threadId);
      } catch (subErr) {
        log.warn(
          { err: subErr instanceof Error ? subErr : new Error(String(subErr)), threadId },
          "Failed to subscribe thread — follow-ups may not work",
        );
      }

      // Rate limiting
      if (config.checkRateLimit) {
        try {
          const check = config.checkRateLimit(threadId);
          if (!check.allowed) {
            try {
              await thinkingMsg.edit({
                markdown: "Rate limit exceeded. Please wait before trying again.",
              });
            } catch (editErr) {
              log.warn(
                { err: editErr instanceof Error ? editErr : new Error(String(editErr)), threadId },
                "Failed to edit thinking message with rate limit notice",
              );
            }
            return;
          }
        } catch (rateLimitErr) {
          log.error(
            { err: rateLimitErr instanceof Error ? rateLimitErr : new Error(String(rateLimitErr)), threadId },
            "Rate limit check failed — denying request",
          );
          try {
            await thinkingMsg.edit({
              markdown: "Unable to verify rate limits. Please try again shortly.",
            });
          } catch (editErr) {
            log.warn(
              { err: editErr instanceof Error ? editErr : new Error(String(editErr)), threadId },
              "Failed to edit thinking message with rate limit error",
            );
          }
          return;
        }
      }

      await handleQuery(
        threadId,
        question,
        (response) => thinkingMsg.edit({ markdown: response }).then(() => {}),
        event.adapter.postEphemeral
          ? (action) =>
              event.adapter.postEphemeral!(
                threadId,
                event.user.userId,
                { card: buildApprovalCard(action), fallbackText: `Action requires approval: ${action.summary}` },
              ).then(() => {})
          : null,
      );
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      log.error(
        { err: err instanceof Error ? err : new Error(String(err)), threadId },
        "Slash command query execution failed",
      );

      const errorMessage = scrubErrorMessage(rawMessage, config.scrubError);
      try {
        await thinkingMsg.edit({
          markdown: `I was unable to answer your question: ${errorMessage}. This may be a transient issue — please try again in a few seconds.`,
        });
      } catch (editErr) {
        log.warn(
          { err: editErr instanceof Error ? editErr : new Error(String(editErr)), threadId },
          "Failed to edit thinking message with error",
        );
      }
    } finally {
      await stateAdapter.releaseLock(lock).catch((releaseErr: unknown) => {
        log.error(
          { err: releaseErr instanceof Error ? releaseErr : new Error(String(releaseErr)), threadId },
          "Failed to release slash command lock — thread may be blocked until TTL expires",
        );
      });
    }
  });

  // --- onAction: approve/deny buttons ---
  if (config.actions) {
    chat.onAction(
      ["atlas_action_approve", "atlas_action_deny"],
      async (event) => {
        const actionId = event.value;
        const isApprove = event.actionId === "atlas_action_approve";
        const userId = event.user.userId;

        if (!actionId) {
          log.warn({ actionId: event.actionId }, "Action event missing value");
          return;
        }

        log.info(
          { actionId, userId, action: isApprove ? "approve" : "deny" },
          "Action button clicked",
        );

        try {
          const actionEntry = await config.actions!.get(actionId);
          if (!actionEntry) {
            log.warn({ actionId, userId }, "Action not found — may have expired");
            try {
              await event.adapter.editMessage(event.threadId, event.messageId, {
                markdown: "This action is no longer available — it may have expired or already been resolved.",
              });
            } catch (editErr) {
              log.warn(
                { err: editErr instanceof Error ? editErr : new Error(String(editErr)), actionId },
                "Failed to edit message for missing action",
              );
            }
            return;
          }

          const pendingAction: PendingAction = {
            id: actionEntry.id,
            type: actionEntry.action_type,
            target: actionEntry.target,
            summary: actionEntry.summary,
          };

          if (isApprove) {
            const result = await config.actions!.approve(
              actionId,
              `chat-sdk:${userId}`,
            );

            if (!result) {
              // Already resolved
              log.warn({ actionId, userId }, "Action already resolved");
              await event.adapter.editMessage(event.threadId, event.messageId, {
                markdown: `${pendingAction.summary || pendingAction.type} — this action has already been resolved.`,
              });
              return;
            }

            const status =
              result.status === "executed"
                ? "executed" as const
                : result.status === "failed"
                  ? "failed" as const
                  : "approved" as const;
            const resultText = formatActionResult(
              pendingAction,
              status,
              result.error ?? undefined,
            );
            await event.adapter.editMessage(event.threadId, event.messageId, {
              markdown: resultText,
            });
          } else {
            const result = await config.actions!.deny(
              actionId,
              `chat-sdk:${userId}`,
            );

            if (!result) {
              log.warn({ actionId }, "Action already resolved when deny attempted");
              await event.adapter.editMessage(event.threadId, event.messageId, {
                markdown: `${pendingAction.summary || pendingAction.type} — this action has already been resolved.`,
              });
              return;
            }

            const resultText = formatActionResult(pendingAction, "denied");
            await event.adapter.editMessage(event.threadId, event.messageId, {
              markdown: resultText,
            });
          }
        } catch (err) {
          log.error(
            { err: err instanceof Error ? err : new Error(String(err)), actionId },
            "Failed to process action",
          );

          // Try to update the original message with an error
          try {
            await event.adapter.editMessage(event.threadId, event.messageId, {
              markdown: "\u26A0\uFE0F Failed to process action. Please try again or use the web UI.",
            });
          } catch (editErr) {
            log.warn(
              { err: editErr instanceof Error ? editErr : new Error(String(editErr)), actionId },
              "Failed to edit message with action error",
            );
          }
        }
      },
    );
  }

  return {
    webhooks: chat.webhooks,
    async shutdown() {
      await chat.shutdown();
      log.info("Chat bridge shut down");
    },
  };
}
