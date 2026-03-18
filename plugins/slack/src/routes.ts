/**
 * Slack integration routes — plugin version.
 *
 * - POST /commands  — slash command handler (/atlas)
 * - POST /events    — Events API (thread follow-ups, url_verification)
 * - POST /interactions — Block Kit action buttons (approve/deny)
 * - GET  /install   — OAuth install redirect
 * - GET  /callback  — OAuth callback
 *
 * All runtime dependencies (agent executor, conversations, actions, rate
 * limiting) are received via the SlackRuntimeDeps interface rather than
 * imported from @atlas/api.
 */

import { Hono } from "hono";
import type { PluginLogger } from "@useatlas/plugin-sdk";
import { verifySlackSignature } from "./verify";
import { postMessage, updateMessage, postEphemeral, slackAPI } from "./api";
import {
  formatQueryResponse,
  formatErrorResponse,
  formatActionApproval,
  formatActionResult,
} from "./format";
import type { SlackQueryResult, PendingAction } from "./format";
import { getBotToken, saveInstallation } from "./store";
import type { PluginDB } from "./store";
import { getConversationId, setConversationId } from "./threads";

// ---------------------------------------------------------------------------
// Runtime dependency interfaces
// ---------------------------------------------------------------------------

export interface ConversationCallbacks {
  create(opts: {
    id?: string;
    title?: string | null;
    surface?: string;
  }): Promise<{ id: string } | null>;
  addMessage(opts: {
    conversationId: string;
    role: "user" | "assistant";
    content: string;
  }): void;
  get(id: string): Promise<{
    messages: Array<{ role: string; content: unknown }>;
  } | null>;
  generateTitle(question: string): string;
}

export interface ActionCallbacks {
  approve(actionId: string, approverId: string): Promise<{
    status: string;
    error?: string | null;
  } | null>;
  deny(actionId: string, denierId: string): Promise<Record<string, unknown> | null>;
  get(actionId: string): Promise<{
    id: string;
    action_type: string;
    target: string;
    summary: string;
  } | null>;
}

export interface SlackRuntimeDeps {
  signingSecret: string;
  botToken?: string;
  clientId?: string;
  clientSecret?: string;
  db: PluginDB | null;
  log: PluginLogger;

  /** Run the Atlas agent on a question and return structured results. */
  executeQuery: (
    question: string,
    options?: {
      priorMessages?: Array<{ role: "user" | "assistant"; content: string }>;
    },
  ) => Promise<SlackQueryResult>;

  /** Optional rate limiting. When omitted, no rate limiting is applied. */
  checkRateLimit?: (key: string) => { allowed: boolean };

  /** Optional conversation persistence. When omitted, no history is maintained. */
  conversations?: ConversationCallbacks;

  /** Optional action framework. When omitted, action buttons are not shown. */
  actions?: ActionCallbacks;

  /** Optional error scrubbing. When omitted, generic error message is used. */
  scrubError?: (message: string) => string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function verifyRequest(
  c: { req: { raw: Request; header: (name: string) => string | undefined } },
  signingSecret: string,
  log: PluginLogger,
): Promise<{ valid: boolean; body: string }> {
  const body = await c.req.raw.clone().text();
  const signature = c.req.header("x-slack-signature") ?? null;
  const timestamp = c.req.header("x-slack-request-timestamp") ?? null;

  const result = verifySlackSignature(signingSecret, signature, timestamp, body);
  if (!result.valid) {
    log.warn({ error: result.error }, "Slack signature verification failed");
  }
  return { valid: result.valid, body };
}

function safeScrub(deps: SlackRuntimeDeps, message: string): string {
  if (deps.scrubError) return deps.scrubError(message);
  return "An internal error occurred. Check server logs for details.";
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

/**
 * Create Hono routes for the Slack integration. All runtime dependencies
 * are passed via the `deps` object.
 */
export function createSlackRoutes(deps: SlackRuntimeDeps): Hono {
  const slack = new Hono();
  const { signingSecret, db, log } = deps;

  // --- POST /commands ---

  slack.post("/commands", async (c) => {
    const { valid, body } = await verifyRequest(c, signingSecret, log);
    if (!valid) {
      return c.json({ error: "Invalid signature" }, 401);
    }

    const params = new URLSearchParams(body);
    const text = params.get("text") ?? "";
    const channelId = params.get("channel_id") ?? "";
    const userId = params.get("user_id") ?? "";
    const teamId = params.get("team_id") ?? "";
    const responseUrl = params.get("response_url") ?? "";

    if (!text.trim()) {
      return c.json({
        response_type: "ephemeral",
        text: "Usage: `/atlas <your question>`\nExample: `/atlas how many active users last month?`",
      });
    }

    log.info({ channelId, userId, teamId, question: text.slice(0, 100) }, "Slash command received");

    // Ack immediately — Slack requires response within 3 seconds
    const processAsync = async () => {
      try {
        const token = await getBotToken(teamId, db, deps.botToken, log);
        if (!token) {
          log.error({ teamId }, "No bot token available for team");
          if (responseUrl) {
            try {
              await fetch(responseUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ response_type: "ephemeral", text: "Atlas is not configured for this workspace. Ask an admin to install via /api/v1/slack/install." }),
                signal: AbortSignal.timeout(10_000),
              });
            } catch (urlErr) {
              log.error({ err: urlErr instanceof Error ? urlErr.message : String(urlErr) }, "Failed to send response_url fallback");
            }
          }
          return;
        }

        if (deps.checkRateLimit) {
          const rateCheck = deps.checkRateLimit(`slack:${teamId}:${userId}`);
          if (!rateCheck.allowed) {
            await postMessage(token, { channel: channelId, text: "Rate limit exceeded. Please wait before trying again." }, log);
            return;
          }
        }

        // Post initial "Thinking..." message to get a thread_ts
        const thinkingResult = await postMessage(token, {
          channel: channelId,
          text: `:hourglass_flowing_sand: Thinking about: _${text.slice(0, 150)}_...`,
        }, log);

        if (!thinkingResult.ok || !thinkingResult.ts) {
          log.error({ error: !thinkingResult.ok ? (thinkingResult as { error: string }).error : "no ts" }, "Failed to post thinking message");
          return;
        }

        const messageTs = thinkingResult.ts;

        // Look up or create conversation mapping
        let conversationId: string | null = null;
        if (deps.conversations) {
          conversationId = await getConversationId(channelId, messageTs, db, log);
          if (!conversationId) {
            conversationId = crypto.randomUUID();
            await setConversationId(channelId, messageTs, conversationId, db, log);
            try {
              await deps.conversations.create({
                id: conversationId,
                title: deps.conversations.generateTitle(text),
                surface: "slack",
              });
            } catch (convErr) {
              log.error({ err: convErr instanceof Error ? convErr.message : String(convErr), conversationId }, "Failed to create conversation");
              conversationId = null;
            }
          }
        }

        const queryResult = await deps.executeQuery(text);

        // Persist messages for thread history
        if (deps.conversations && conversationId) {
          try {
            await deps.conversations.addMessage({ conversationId, role: "user", content: text });
            await deps.conversations.addMessage({ conversationId, role: "assistant", content: queryResult.answer });
          } catch (msgErr) {
            log.error({ err: msgErr instanceof Error ? msgErr.message : String(msgErr), conversationId }, "Failed to persist conversation messages");
          }
        }

        const blocks = formatQueryResponse(queryResult);
        const updateResult = await updateMessage(token, {
          channel: channelId,
          ts: messageTs,
          text: queryResult.answer,
          blocks,
        }, log);
        if (!updateResult.ok) {
          log.error({ error: (updateResult as { error: string }).error, channel: channelId, ts: messageTs }, "Failed to update Slack message with query result");
        }

        // Post ephemeral approval prompts for pending actions
        if (deps.actions && queryResult.pendingActions?.length) {
          for (const action of queryResult.pendingActions) {
            const approvalBlocks = formatActionApproval(action);
            const ephResult = await postEphemeral(token, {
              channel: channelId,
              user: userId,
              text: `Action requires approval: ${action.summary}`,
              blocks: approvalBlocks,
              thread_ts: messageTs,
            }, log);
            if (!ephResult.ok) {
              log.error({ error: (ephResult as { error: string }).error, channel: channelId, userId, actionId: action.id }, "Failed to post ephemeral action approval prompt");
            }
          }
        }
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err : new Error(String(err)) },
          "Slack async command processing failed",
        );

        try {
          const token = await getBotToken(teamId, db, deps.botToken, log);
          if (token) {
            const errorMessage = safeScrub(
              deps,
              err instanceof Error ? err.message : "Unknown error",
            );
            await postMessage(token, {
              channel: channelId,
              text: errorMessage,
              blocks: formatErrorResponse(errorMessage),
            }, log);
          }
        } catch (innerErr) {
          log.error({ err: innerErr instanceof Error ? innerErr.message : String(innerErr) }, "Failed to send error message to Slack");
        }
      }
    };

    processAsync().catch((err) => {
      log.error(
        { err: err instanceof Error ? err : new Error(String(err)) },
        "Unhandled error in async Slack processing",
      );
    });

    return c.json({
      response_type: "in_channel",
      text: `:hourglass_flowing_sand: Processing your question...`,
    });
  });

  // --- POST /events ---

  slack.post("/events", async (c) => {
    const { valid, body } = await verifyRequest(c, signingSecret, log);

    if (!valid) {
      return c.json({ error: "Invalid signature" }, 401);
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body);
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "Slack events received non-JSON body");
      return c.json({ error: "Invalid JSON" }, 400);
    }

    // Handle url_verification challenge (signature verified above)
    if (payload.type === "url_verification") {
      return c.json({ challenge: payload.challenge });
    }

    if (payload.type === "event_callback") {
      const event = payload.event as Record<string, unknown> | undefined;
      if (!event) {
        return c.json({ ok: true });
      }

      // Ignore bot messages to prevent loops
      if (event.bot_id) {
        return c.json({ ok: true });
      }

      const eventType = event.type as string;
      const text = (event.text as string) ?? "";
      const channel = (event.channel as string) ?? "";
      const threadTs = (event.thread_ts as string) ?? "";
      const teamId = (payload.team_id as string) ?? "";

      // Only handle messages in threads (follow-up questions)
      if (eventType === "message" && threadTs && text.trim()) {
        log.info(
          { channel, threadTs, question: text.slice(0, 100) },
          "Thread follow-up received",
        );

        const processAsync = async () => {
          try {
            const token = await getBotToken(teamId, db, deps.botToken, log);
            if (!token) {
              log.error({ teamId }, "No bot token for thread follow-up");
              return;
            }

            if (deps.checkRateLimit) {
              const rateCheck = deps.checkRateLimit(`slack:${teamId}`);
              if (!rateCheck.allowed) {
                await postMessage(token, { channel, text: "Rate limit exceeded. Please wait before trying again.", thread_ts: threadTs }, log);
                return;
              }
            }

            // Check for existing conversation mapping
            let conversationId: string | null = null;
            let priorMessages: Array<{ role: "user" | "assistant"; content: string }> | undefined;

            if (deps.conversations) {
              conversationId = await getConversationId(channel, threadTs, db, log);

              if (conversationId) {
                log.debug({ conversationId, threadTs }, "Found existing conversation for thread");
                const conversation = await deps.conversations.get(conversationId);
                if (conversation?.messages.length) {
                  priorMessages = conversation.messages
                    .filter((m): m is typeof m & { role: "user" | "assistant" } =>
                      m.role === "user" || m.role === "assistant",
                    )
                    .map((m) => ({
                      role: m.role,
                      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
                    }));
                }
              }
            }

            const queryResult = await deps.executeQuery(
              text,
              priorMessages ? { priorMessages } : undefined,
            );

            // Persist new messages for future follow-ups
            if (deps.conversations && conversationId) {
              try {
                await deps.conversations.addMessage({ conversationId, role: "user", content: text });
                await deps.conversations.addMessage({ conversationId, role: "assistant", content: queryResult.answer });
              } catch (msgErr) {
                log.error({ err: msgErr instanceof Error ? msgErr.message : String(msgErr), conversationId }, "Failed to persist thread messages");
              }
            }
            const blocks = formatQueryResponse(queryResult);

            const postResult = await postMessage(token, {
              channel,
              text: queryResult.answer,
              blocks,
              thread_ts: threadTs,
            }, log);
            if (!postResult.ok) {
              log.error({ error: (postResult as { error: string }).error, channel, threadTs }, "Failed to post thread follow-up response");
            }

            // Post ephemeral approval prompts for pending actions
            const eventUserId = (event.user as string) ?? "";
            if (deps.actions && queryResult.pendingActions?.length && eventUserId) {
              for (const action of queryResult.pendingActions) {
                const approvalBlocks = formatActionApproval(action);
                const ephResult = await postEphemeral(token, {
                  channel,
                  user: eventUserId,
                  text: `Action requires approval: ${action.summary}`,
                  blocks: approvalBlocks,
                  thread_ts: threadTs,
                }, log);
                if (!ephResult.ok) {
                  log.error({ error: (ephResult as { error: string }).error, channel, userId: eventUserId, actionId: action.id }, "Failed to post ephemeral action approval prompt");
                }
              }
            }
          } catch (err) {
            log.error(
              { err: err instanceof Error ? err : new Error(String(err)) },
              "Thread follow-up processing failed",
            );

            try {
              const token = await getBotToken(teamId, db, deps.botToken, log);
              if (token) {
                const errorMessage = safeScrub(
                  deps,
                  err instanceof Error ? err.message : "Unknown error",
                );
                await postMessage(token, {
                  channel,
                  text: errorMessage,
                  blocks: formatErrorResponse(errorMessage),
                  thread_ts: threadTs,
                }, log);
              }
            } catch (innerErr) {
              log.error({ err: innerErr instanceof Error ? innerErr.message : String(innerErr) }, "Failed to send thread error message");
            }
          }
        };

        processAsync().catch((err) => {
          log.error(
            { err: err instanceof Error ? err : new Error(String(err)) },
            "Unhandled error in thread processing",
          );
        });
      }
    }

    return c.json({ ok: true });
  });

  // --- POST /interactions ---

  slack.post("/interactions", async (c) => {
    const { valid, body } = await verifyRequest(c, signingSecret, log);
    if (!valid) {
      return c.json({ error: "Invalid signature" }, 401);
    }

    const formParams = new URLSearchParams(body);
    const payloadStr = formParams.get("payload");
    if (!payloadStr) {
      return c.json({ error: "Missing payload" }, 400);
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(payloadStr);
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "Slack interaction received invalid payload JSON");
      return c.json({ error: "Invalid payload JSON" }, 400);
    }

    if (payload.type !== "block_actions") {
      log.debug({ type: payload.type }, "Acked non-block_actions Slack interaction type");
      return c.json({ ok: true });
    }

    const actions = payload.actions as Array<{
      action_id: string;
      value: string;
    }> | undefined;

    if (!actions?.length) {
      return c.json({ ok: true });
    }

    const responseUrl = (payload.response_url as string) ?? "";
    const userId = ((payload.user as Record<string, unknown>)?.id as string) ?? "";

    // Ack immediately — process asynchronously
    const processAsync = async () => {
      if (!deps.actions) {
        log.warn("Action interaction received but no actions callbacks configured");
        return;
      }

      for (const act of actions) {
        const actionId = act.value;
        const isApprove = act.action_id === "atlas_action_approve";
        const isDeny = act.action_id === "atlas_action_deny";

        if (!isApprove && !isDeny) {
          if (typeof act.action_id === "string" && act.action_id.startsWith("atlas_")) {
            log.warn({ actionId: act.action_id }, "Unrecognized Atlas action_id in Slack interaction");
          }
          continue;
        }

        try {
          const actionEntry = await deps.actions.get(actionId);
          if (!actionEntry) {
            log.warn({ actionId, userId }, "Slack interaction for unknown action");
            continue;
          }

          const pendingAction: PendingAction = {
            id: actionEntry.id,
            type: actionEntry.action_type,
            target: actionEntry.target,
            summary: actionEntry.summary,
          };

          if (isApprove) {
            const result = await deps.actions.approve(actionId, `slack:${userId}`);
            if (!result) {
              log.warn({ actionId, userId }, "Action already resolved when approve attempted");
              if (responseUrl) {
                const resp = await fetch(responseUrl, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    replace_original: true,
                    text: "This action has already been resolved.",
                  }),
                  signal: AbortSignal.timeout(10_000),
                });
                if (!resp.ok) {
                  log.warn({ actionId, status: resp.status }, "Slack response_url returned non-OK status");
                }
              }
              continue;
            }
            const status = result.status === "executed" ? "executed" : result.status === "failed" ? "failed" : "approved";
            const resultBlocks = formatActionResult(pendingAction, status, result.error ?? undefined);

            if (responseUrl) {
              const resp = await fetch(responseUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ replace_original: true, blocks: resultBlocks }),
                signal: AbortSignal.timeout(10_000),
              });
              if (!resp.ok) {
                log.warn({ actionId, status: resp.status }, "Slack response_url returned non-OK status");
              }
            }
          } else {
            const result = await deps.actions.deny(actionId, `slack:${userId}`);
            if (!result) {
              log.warn({ actionId }, "Action already resolved when deny attempted");
              continue;
            }
            const resultBlocks = formatActionResult(pendingAction, "denied");

            if (responseUrl) {
              const resp = await fetch(responseUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ replace_original: true, blocks: resultBlocks }),
                signal: AbortSignal.timeout(10_000),
              });
              if (!resp.ok) {
                log.warn({ actionId, status: resp.status }, "Slack response_url returned non-OK status");
              }
            }
          }
        } catch (err) {
          log.error(
            { err: err instanceof Error ? err : new Error(String(err)), actionId },
            "Failed to process Slack action interaction",
          );

          if (responseUrl) {
            try {
              const resp = await fetch(responseUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  replace_original: true,
                  text: ":warning: Failed to process action. Please try again or use the web UI.",
                }),
                signal: AbortSignal.timeout(10_000),
              });
              if (!resp.ok) {
                log.warn({ status: resp.status }, "Slack response_url returned non-OK status for error message");
              }
            } catch (innerErr) {
              log.error({ err: innerErr instanceof Error ? innerErr.message : String(innerErr) }, "Failed to send error via response_url");
            }
          }
        }
      }
    };

    processAsync().catch((err) => {
      log.error(
        { err: err instanceof Error ? err : new Error(String(err)) },
        "Unhandled error in Slack interaction processing",
      );
    });

    return c.json({ ok: true });
  });

  // --- OAuth CSRF state ---

  const pendingOAuthStates = new Map<string, number>();
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [state, expiry] of pendingOAuthStates) {
      if (now > expiry) pendingOAuthStates.delete(state);
    }
  }, 600_000);
  cleanupInterval.unref();

  // --- GET /install ---

  slack.get("/install", (c) => {
    if (!deps.clientId) {
      return c.json({ error: "OAuth not configured" }, 501);
    }

    const state = crypto.randomUUID();
    pendingOAuthStates.set(state, Date.now() + 600_000);

    const scopes = "commands,chat:write,app_mentions:read";
    const url = `https://slack.com/oauth/v2/authorize?client_id=${deps.clientId}&scope=${scopes}&state=${state}`;
    return c.redirect(url);
  });

  // --- GET /callback ---

  slack.get("/callback", async (c) => {
    if (!deps.clientId || !deps.clientSecret) {
      return c.json({ error: "OAuth not configured" }, 501);
    }

    const state = c.req.query("state");
    if (!state || !pendingOAuthStates.has(state)) {
      return c.json({ error: "Invalid or expired state parameter" }, 400);
    }
    pendingOAuthStates.delete(state);

    const code = c.req.query("code");
    if (!code) {
      return c.json({ error: "Missing code parameter" }, 400);
    }

    const result = await slackAPI("oauth.v2.access", "", {
      client_id: deps.clientId,
      client_secret: deps.clientSecret,
      code,
    }, log);

    if (!result.ok) {
      log.error({ error: (result as { error: string }).error }, "OAuth exchange failed");
      return c.json({ error: "OAuth failed" }, 400);
    }

    const data = result as unknown as Record<string, unknown>;
    const team = data.team as { id?: string } | undefined;
    const accessToken = (data.access_token as string) ?? "";
    const teamId = team?.id ?? "";

    if (teamId && accessToken) {
      try {
        await saveInstallation(teamId, accessToken, db);
        log.info({ teamId }, "Slack installation saved");
      } catch (saveErr) {
        log.error({ err: saveErr instanceof Error ? saveErr.message : String(saveErr), teamId }, "Failed to save Slack installation");
        return c.html("<html><body><h1>Installation Failed</h1><p>Could not save the installation. Please try again.</p></body></html>", 500);
      }
    } else {
      log.error({ hasTeamId: !!teamId, hasAccessToken: !!accessToken }, "OAuth response missing team_id or access_token");
      return c.html("<html><body><h1>Installation Failed</h1><p>The OAuth response was incomplete. Please try again.</p></body></html>", 500);
    }

    return c.html(
      "<html><body><h1>Atlas installed!</h1><p>You can now use /atlas in your Slack workspace.</p></body></html>",
    );
  });

  return slack;
}

/**
 * Get the OAuth cleanup interval reference (for teardown).
 * Not exported — the cleanup interval is internal to createSlackRoutes
 * and auto-unrefs to avoid keeping the process alive.
 */
