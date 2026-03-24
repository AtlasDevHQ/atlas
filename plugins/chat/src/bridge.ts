/**
 * Chat SDK ↔ Atlas bridge.
 *
 * Maps Chat SDK lifecycle and events to Atlas plugin callbacks:
 *
 * - `onNewMention` → lock + subscribe thread + `executeQuery`/`executeQueryStream` → post card or stream
 * - `onSubscribedMessage` → lock + query with thread history → post card or stream
 * - `onSlashCommand(configurable, default "/atlas")` → post thinking → subscribe → query → edit with card or stream
 * - `onAction("atlas_action_approve"|"atlas_action_deny")` → approve/deny → edit message
 * - `onAction("atlas_run_again")` → re-execute query → post result card
 * - `onAction("atlas_export_csv")` → stub response (full implementation in separate issue)
 * - `onModalSubmit("atlas_clarify")` → feed clarification response into conversation
 * - `onModalClose("atlas_clarify")` → log dismissal
 * - Error scrubbing prevents leaking connection strings, stack traces, or
 *   internal errors to chat platforms
 *
 * Query results, errors, and approval prompts render as platform-native
 * JSX cards (Block Kit on Slack, Adaptive Cards on Teams, Discord Embeds)
 * with automatic markdown fallback for text-only platforms.
 *
 * The bridge owns the Chat SDK `Chat` instance and exposes its webhook
 * handlers for route mounting. State is delegated to the injected
 * StateAdapter (memory, PG, or future Redis).
 */

import { Chat, Modal, TextInput } from "chat";
import type { Adapter, StateAdapter, Lock, CardElement, StreamChunk } from "chat";
import { toModalElement } from "chat/jsx-runtime";
import type { PluginLogger } from "@useatlas/plugin-sdk";
import type {
  ChatPluginConfig,
  ChatQueryResult,
  ChatMessage,
  PendingAction,
} from "./config";
import { buildQueryResultCard } from "./cards/query-result-card";
import { buildErrorCard } from "./cards/error-card";
import { buildApprovalCardJSX } from "./cards/approval-card";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum messages per thread conversation history. */
const MAX_MESSAGES_PER_THREAD = 200;

/** TTL for conversation history entries (7 days). */
const CONVERSATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** TTL for event dedup locks (30 seconds). */
const DEDUP_LOCK_TTL_MS = 30_000;

/** Callback ID for the Slack clarification modal. */
const MODAL_CALLBACK_ID = "atlas_clarify";

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
// Response formatting (legacy helpers — see also ./cards/ for JSX cards)
// ---------------------------------------------------------------------------

/**
 * Format a ChatQueryResult as a markdown string suitable for chat platforms.
 * @deprecated Use `buildQueryResultCard()` from `./cards/` instead. Kept for
 * backward compatibility with hosts that consume markdown directly.
 */
export function formatQueryResponse(result: ChatQueryResult): string {
  const { fallbackText } = buildQueryResultCard(result);
  return fallbackText;
}

/**
 * Build a Chat SDK card for an action approval prompt.
 * @deprecated Use `buildApprovalCardJSX()` from `./cards/` instead. Kept for
 * backward compatibility.
 */
export function buildApprovalCard(action: PendingAction): CardElement {
  return buildApprovalCardJSX(action).card;
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
  thread: { post: (msg: string | { card: CardElement; fallbackText: string }) => Promise<unknown> },
  message: string | { card: CardElement; fallbackText: string },
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
  /**
   * Open a Slack modal for parameter collection / clarification.
   * Returns the view ID on success, or undefined if the platform
   * does not support modals.
   */
  openClarificationModal(
    event: { openModal: (modal: unknown) => Promise<{ viewId: string } | undefined> },
    prompt: string,
  ): Promise<{ viewId: string } | undefined>;
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
 * 4. Sets up onSlashCommand (configurable, default "/atlas") → post thinking → subscribe → executeQuery → edit
 * 5. Sets up onAction for approval, Run Again, and Export CSV buttons
 * 6. Sets up onModalSubmit/onModalClose for clarification modals (Slack)
 * 7. Exposes webhook handlers and openClarificationModal for route mounting
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
  adapterInstances: { slack?: Adapter | null; teams?: Adapter | null; discord?: Adapter | null; gchat?: Adapter | null; telegram?: Adapter | null; github?: Adapter | null },
): ChatBridge {
  // Build adapters dict from pre-built instances
  const adapters: Record<string, Adapter> = {};
  if (adapterInstances.slack) {
    adapters.slack = adapterInstances.slack;
    log.info("Slack adapter configured");
  }
  if (adapterInstances.teams) {
    adapters.teams = adapterInstances.teams;
    log.info("Teams adapter configured");
  }
  if (adapterInstances.discord) {
    adapters.discord = adapterInstances.discord;
    log.info("Discord adapter configured");
  }
  if (adapterInstances.gchat) {
    adapters.gchat = adapterInstances.gchat;
    log.info("Google Chat adapter configured");
  }
  if (adapterInstances.telegram) {
    adapters.telegram = adapterInstances.telegram;
    log.info("Telegram adapter configured");
  }
  if (adapterInstances.github) {
    adapters.github = adapterInstances.github;
    log.info("GitHub adapter configured");
  }

  const chat = new Chat({
    userName: "atlas",
    adapters,
    state: stateAdapter,
    ...(config.streaming?.chunkIntervalMs != null && {
      streamingUpdateIntervalMs: config.streaming.chunkIntervalMs,
    }),
  });

  // --- Shared handler logic ---

  /** Whether streaming is available and enabled. */
  const streamingEnabled =
    typeof config.executeQueryStream === "function" &&
    config.streaming?.enabled !== false;

  async function handleQuery(
    threadId: string,
    question: string,
    postResponse: (response: { card: CardElement; fallbackText: string }) => Promise<unknown>,
    postApproval: ((action: PendingAction) => Promise<void>) | null,
    priorMessages?: ChatMessage[],
  ): Promise<void> {
    const result = await config.executeQuery(question, {
      threadId,
      priorMessages,
    });

    // Post the response first — ensure the user gets the answer
    const response = buildQueryResultCard(result);
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

  /**
   * Streaming variant of handleQuery. Passes the async iterable from
   * `executeQueryStream` to Chat SDK for incremental delivery.
   *
   * Throws if `postStream` fails or if the final `result` promise rejects
   * after the stream completes — callers handle error posting per context.
   */
  async function handleStreamingQuery(
    threadId: string,
    question: string,
    postStream: (stream: AsyncIterable<string | StreamChunk>) => Promise<unknown>,
    postApproval: ((action: PendingAction) => Promise<void>) | null,
    priorMessages?: ChatMessage[],
  ): Promise<void> {
    // Defensive guard — streamingEnabled should prevent this, but
    // protects against config mutation after bridge creation.
    if (typeof config.executeQueryStream !== "function") {
      throw new Error(
        "handleStreamingQuery called but executeQueryStream is not configured",
      );
    }

    const streamResult = config.executeQueryStream(question, {
      threadId,
      priorMessages,
    });
    if (!streamResult?.stream || !streamResult?.result) {
      throw new Error(
        "executeQueryStream must return { stream, result }",
      );
    }
    const { stream, result } = streamResult;

    // Prevent unhandled rejection if the stream consumer aborts early
    // and the result promise rejects as a consequence.
    result.catch((err) => {
      log.debug(
        { err: err instanceof Error ? err : new Error(String(err)), threadId },
        "Streaming result promise rejected (likely due to stream abort)",
      );
    });

    // Stream to platform — Chat SDK handles native streaming on Slack
    // and edit-based fallback on Teams/Discord/Google Chat.
    // Throws if the stream errors mid-way (partial content may be visible).
    await postStream(stream);

    // Stream completed — retrieve final structured result for persistence.
    // If result rejects, re-throw so the caller's catch block posts an error
    // card — the user already saw streamed text but would miss approval prompts.
    let queryResult: ChatQueryResult;
    try {
      queryResult = await result;
    } catch (resultErr) {
      log.error(
        { err: resultErr instanceof Error ? resultErr : new Error(String(resultErr)), threadId },
        "Stream completed but final result unavailable — approval prompts, history, and conversation tracking lost",
      );
      throw resultErr;
    }

    // Post approval prompts for pending actions
    if (config.actions && queryResult.pendingActions?.length && postApproval) {
      for (const action of queryResult.pendingActions) {
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
      { role: "assistant", content: queryResult.answer },
    ], log);

    // Persist to host conversation system (non-fatal)
    const conversationId = await ensureConversation(
      config, stateAdapter, threadId, question, log,
    );
    await persistConversationMessages(
      config, conversationId, question, queryResult.answer, log, threadId,
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
            const rateLimitCard = buildErrorCard({
              message: "Rate limit exceeded.",
              retryHint: "Please wait before trying again.",
            });
            await thread.post({ card: rateLimitCard.card, fallbackText: rateLimitCard.fallbackText });
            return;
          }
        } catch (rateLimitErr) {
          log.error(
            { err: rateLimitErr instanceof Error ? rateLimitErr : new Error(String(rateLimitErr)), threadId },
            "Rate limit check failed — denying request",
          );
          await safePostError(
            thread,
            buildErrorCard({ message: "Unable to verify rate limits. Please try again shortly." }),
            log,
            threadId,
          );
          return;
        }
      }

      // Subscribe for follow-up messages
      await thread.subscribe();

      const approvalCallback = (action: PendingAction) => {
        const approval = buildApprovalCardJSX(action);
        return thread.postEphemeral(
          message.author,
          { card: approval.card, fallbackText: approval.fallbackText },
          { fallbackToDM: false },
        ).then(() => {});
      };

      if (streamingEnabled) {
        await handleStreamingQuery(
          threadId,
          question,
          (stream) => thread.post(stream),
          approvalCallback,
        );
      } else {
        await handleQuery(
          threadId,
          question,
          (response) => thread.post({ card: response.card, fallbackText: response.fallbackText }),
          approvalCallback,
        );
      }
    } catch (err) {
      const rawMessage =
        err instanceof Error ? err.message : String(err);
      log.error(
        { err: err instanceof Error ? err : new Error(String(err)), threadId },
        "Query execution failed",
      );

      const errorMessage = scrubErrorMessage(rawMessage, config.scrubError);
      const errorCard = buildErrorCard({ message: errorMessage });
      await safePostError(
        thread,
        errorCard,
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
            const rateLimitCard = buildErrorCard({
              message: "Rate limit exceeded.",
              retryHint: "Please wait before trying again.",
            });
            await thread.post({ card: rateLimitCard.card, fallbackText: rateLimitCard.fallbackText });
            return;
          }
        } catch (rateLimitErr) {
          log.error(
            { err: rateLimitErr instanceof Error ? rateLimitErr : new Error(String(rateLimitErr)), threadId },
            "Rate limit check failed — denying request",
          );
          await safePostError(
            thread,
            buildErrorCard({ message: "Unable to verify rate limits. Please try again shortly." }),
            log,
            threadId,
          );
          return;
        }
      }

      // Retrieve prior conversation context (non-fatal — falls back to no context)
      const priorMessages = await retrieveHistory(stateAdapter, threadId, log);

      const approvalCallback = (action: PendingAction) => {
        const approval = buildApprovalCardJSX(action);
        return thread.postEphemeral(
          message.author,
          { card: approval.card, fallbackText: approval.fallbackText },
          { fallbackToDM: false },
        ).then(() => {});
      };

      if (streamingEnabled) {
        await handleStreamingQuery(
          threadId,
          question,
          (stream) => thread.post(stream),
          approvalCallback,
          priorMessages,
        );
      } else {
        await handleQuery(
          threadId,
          question,
          (response) => thread.post({ card: response.card, fallbackText: response.fallbackText }),
          approvalCallback,
          priorMessages,
        );
      }
    } catch (err) {
      const rawMessage =
        err instanceof Error ? err.message : String(err);
      log.error(
        { err: err instanceof Error ? err : new Error(String(err)), threadId },
        "Follow-up query execution failed",
      );

      const errorMessage = scrubErrorMessage(rawMessage, config.scrubError);
      const errorCard = buildErrorCard({ message: errorMessage });
      await safePostError(
        thread,
        errorCard,
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

  // --- onSlashCommand: /<configurable> <question> ---
  const commandName = config.slashCommandName ?? "/atlas";
  chat.onSlashCommand(commandName, async (event) => {
    const question = event.text?.trim();
    const channelId = event.channel.id;

    if (!question) {
      try {
        await event.channel.postEphemeral(
          event.user,
          { markdown: `Usage: \`${commandName} <your question>\`\nExample: \`${commandName} how many active users last month?\`` },
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
            const rateLimitCard = buildErrorCard({
              message: "Rate limit exceeded.",
              retryHint: "Please wait before trying again.",
            });
            try {
              await thinkingMsg.edit({
                card: rateLimitCard.card,
                fallbackText: rateLimitCard.fallbackText,
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
          const rateLimitErrorCard = buildErrorCard({
            message: "Unable to verify rate limits. Please try again shortly.",
          });
          try {
            await thinkingMsg.edit({
              card: rateLimitErrorCard.card,
              fallbackText: rateLimitErrorCard.fallbackText,
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

      const approvalCallback = event.adapter.postEphemeral
        ? (action: PendingAction) => {
            const approval = buildApprovalCardJSX(action);
            return event.adapter.postEphemeral!(
              threadId,
              event.user.userId,
              { card: approval.card, fallbackText: approval.fallbackText },
            ).then(() => {});
          }
        : null;

      if (streamingEnabled) {
        await handleStreamingQuery(
          threadId,
          question,
          (stream) => thinkingMsg.edit(stream).then(() => {}),
          approvalCallback,
        );
      } else {
        await handleQuery(
          threadId,
          question,
          (response) => thinkingMsg.edit({ card: response.card, fallbackText: response.fallbackText }).then(() => {}),
          approvalCallback,
        );
      }
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      log.error(
        { err: err instanceof Error ? err : new Error(String(err)), threadId },
        "Slash command query execution failed",
      );

      const errorMessage = scrubErrorMessage(rawMessage, config.scrubError);
      const errorCard = buildErrorCard({ message: errorMessage });
      try {
        await thinkingMsg.edit({
          card: errorCard.card,
          fallbackText: errorCard.fallbackText,
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

  // --- onAction: Run Again button ---
  chat.onAction("atlas_run_again", async (event) => {
    const sqlPayload = event.value;
    const threadId = event.threadId;

    if (!sqlPayload || !threadId) {
      log.warn({ actionId: event.actionId }, "Run Again action missing value or threadId");
      return;
    }

    log.info(
      { threadId, userId: event.user.userId },
      "Run Again button clicked",
    );

    // Dedup lock — prevent duplicate execution on double-clicks or retries
    const lock = await tryAcquireLock(stateAdapter, `bridge:run-again:${threadId}`, DEDUP_LOCK_TTL_MS, log, threadId);
    if (!lock) {
      log.debug({ threadId }, "Run Again already being processed");
      return;
    }

    try {
      const priorMessages = await retrieveHistory(stateAdapter, threadId, log);
      const question = `Re-run this SQL query: ${sqlPayload}`;

      if (event.thread) {
        if (streamingEnabled) {
          await handleStreamingQuery(
            threadId, question,
            (stream) => event.thread!.post(stream),
            null, priorMessages,
          );
        } else {
          await handleQuery(
            threadId, question,
            (response) => event.thread!.post({ card: response.card, fallbackText: response.fallbackText }),
            null, priorMessages,
          );
        }
      } else {
        // Fallback: post via adapter when thread is not available
        const result = await config.executeQuery(question, { threadId, priorMessages });
        const response = buildQueryResultCard(result);
        await event.adapter.postMessage(threadId, { card: response.card, fallbackText: response.fallbackText });
      }
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err : new Error(String(err)), threadId },
        "Run Again query execution failed",
      );

      const errorMessage = scrubErrorMessage(
        err instanceof Error ? err.message : String(err),
        config.scrubError,
      );
      try {
        await event.adapter.postMessage(threadId, { ...buildErrorCard({ message: errorMessage }) });
      } catch (postErr) {
        log.warn(
          { err: postErr instanceof Error ? postErr : new Error(String(postErr)), threadId },
          "Failed to post error for Run Again action",
        );
      }
    } finally {
      await stateAdapter.releaseLock(lock).catch((releaseErr: unknown) => {
        log.error(
          { err: releaseErr instanceof Error ? releaseErr : new Error(String(releaseErr)), threadId },
          "Failed to release Run Again lock — thread may be blocked until TTL expires",
        );
      });
    }
  });

  // --- onAction: Export CSV button (stub — full implementation in #770) ---
  chat.onAction("atlas_export_csv", async (event) => {
    const threadId = event.threadId;

    if (!threadId) {
      log.warn({ actionId: event.actionId }, "Export CSV action missing threadId");
      return;
    }

    log.info(
      { threadId, userId: event.user.userId },
      "Export CSV button clicked (stub)",
    );

    try {
      await event.adapter.postMessage(threadId, {
        markdown: "CSV export is not yet available. This feature is coming soon.",
      });
    } catch (postErr) {
      log.warn(
        { err: postErr instanceof Error ? postErr : new Error(String(postErr)), threadId },
        "Failed to post Export CSV stub response",
      );
    }
  });

  // --- Slack modal: clarification parameter collection ---
  chat.onModalSubmit(MODAL_CALLBACK_ID, async (event) => {
    const response = event.values.clarification_response;

    if (!response?.trim()) {
      return {
        action: "errors" as const,
        errors: { clarification_response: "Please provide a response" },
      };
    }

    log.info(
      { callbackId: event.callbackId, userId: event.user.userId },
      "Modal clarification submitted",
    );

    // Feed the response back into the conversation thread
    if (!event.relatedThread) {
      log.warn(
        { callbackId: event.callbackId, userId: event.user.userId },
        "Modal submission has no related thread — cannot deliver clarification response",
      );
      return {
        action: "errors" as const,
        errors: {
          clarification_response:
            "Unable to deliver your response — the original thread could not be found. Please re-ask your question in the channel.",
        },
      };
    }

    const threadId = `${event.adapter.name}:${event.relatedThread.id}`;
    try {
      const priorMessages = await retrieveHistory(stateAdapter, threadId, log);

      if (streamingEnabled) {
        await handleStreamingQuery(
          threadId,
          response.trim(),
          (stream) => event.relatedThread!.post(stream),
          null,
          priorMessages,
        );
      } else {
        await handleQuery(
          threadId,
          response.trim(),
          (cardResponse) => event.relatedThread!.post({
            card: cardResponse.card,
            fallbackText: cardResponse.fallbackText,
          }),
          null,
          priorMessages,
        );
      }
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err : new Error(String(err)), threadId },
        "Modal clarification query failed",
      );

      const errorMessage = scrubErrorMessage(
        err instanceof Error ? err.message : String(err),
        config.scrubError,
      );
      try {
        await event.relatedThread.post(buildErrorCard({ message: errorMessage }));
      } catch (postErr) {
        log.warn(
          { err: postErr instanceof Error ? postErr : new Error(String(postErr)), threadId },
          "Failed to post error after modal clarification",
        );
      }
    }

    return { action: "close" as const };
  });

  chat.onModalClose(MODAL_CALLBACK_ID, async (event) => {
    log.debug(
      { userId: event.user.userId, callbackId: event.callbackId },
      "Clarification modal dismissed",
    );
  });

  return {
    webhooks: chat.webhooks,

    /**
     * Open a clarification modal on Slack. Returns the view ID on success,
     * or undefined if the platform does not support modals.
     *
     * This is exposed on the bridge so that host integrations can trigger
     * modals programmatically when the agent requests clarification.
     */
    async openClarificationModal(
      event: { openModal: (modal: unknown) => Promise<{ viewId: string } | undefined> },
      prompt: string,
    ): Promise<{ viewId: string } | undefined> {
      const modal = toModalElement(
        Modal({
          callbackId: MODAL_CALLBACK_ID,
          title: "Provide Details",
          submitLabel: "Submit",
          notifyOnClose: true,
          children: [
            TextInput({
              id: "clarification_response",
              label: prompt.slice(0, 150),
              multiline: true,
              placeholder: "Type your response here...",
            }),
          ],
        }),
      );

      if (!modal) {
        log.warn("Failed to build clarification modal element");
        return undefined;
      }

      try {
        return await event.openModal(modal);
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err : new Error(String(err)) },
          "Failed to open clarification modal via platform API",
        );
        return undefined;
      }
    },

    async shutdown() {
      await chat.shutdown();
      log.info("Chat bridge shut down");
    },
  };
}
