/**
 * Slack integration routes.
 *
 * - POST /api/slack/commands  — slash command handler (/atlas)
 * - POST /api/slack/events   — Events API (thread follow-ups, url_verification)
 * - GET  /api/slack/install   — OAuth install redirect
 * - GET  /api/slack/callback  — OAuth callback
 *
 * POST routes verify Slack request signatures. OAuth routes use Slack's
 * server-to-server code exchange. The slash command acks within 3 seconds
 * and processes the query asynchronously.
 */

import { Hono } from "hono";
import { executeAgentQuery } from "@atlas/api/lib/agent-query";
import { createLogger } from "@atlas/api/lib/logger";
import { checkRateLimit } from "@atlas/api/lib/auth/middleware";
import { verifySlackSignature } from "@atlas/api/lib/slack/verify";
import { postMessage, updateMessage, postEphemeral, slackAPI } from "@atlas/api/lib/slack/api";
import { formatQueryResponse, formatErrorResponse, formatActionApproval, formatActionResult } from "@atlas/api/lib/slack/format";
import { approveAction, denyAction, getAction } from "@atlas/api/lib/tools/actions/handler";
import { getBotToken, saveInstallation } from "@atlas/api/lib/slack/store";
import { getConversationId, setConversationId } from "@atlas/api/lib/slack/threads";
import { createConversation, addMessage, getConversation, generateTitle } from "@atlas/api/lib/conversations";
import { SENSITIVE_PATTERNS } from "@atlas/api/lib/security";

const log = createLogger("slack");

const slack = new Hono();

// --- Verify Slack signature ---

async function verifyRequest(
  c: { req: { raw: Request; header: (name: string) => string | undefined } },
): Promise<{ valid: boolean; body: string }> {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    log.error("SLACK_SIGNING_SECRET not set — all Slack requests will be rejected");
    return { valid: false, body: "" };
  }

  const body = await c.req.raw.clone().text();
  const signature = c.req.header("x-slack-signature") ?? null;
  const timestamp = c.req.header("x-slack-request-timestamp") ?? null;

  const result = verifySlackSignature(signingSecret, signature, timestamp, body);
  if (!result.valid) {
    log.warn({ error: result.error }, "Slack signature verification failed");
  }
  return { valid: result.valid, body };
}

/**
 * Scrub sensitive info from error messages before sending to Slack.
 */
function scrubError(message: string): string {
  if (SENSITIVE_PATTERNS.test(message) || message.length > 200) {
    return "An internal error occurred. Check server logs for details.";
  }
  return message;
}

// --- POST /api/slack/commands ---

slack.post("/commands", async (c) => {
  const { valid, body } = await verifyRequest(c);
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
  // Fire off async processing
  const processAsync = async () => {
    try {
      const token = await getBotToken(teamId);
      if (!token) {
        log.error({ teamId }, "No bot token available for team");
        if (responseUrl) {
          try {
            await fetch(responseUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ response_type: "ephemeral", text: "Atlas is not configured for this workspace. Ask an admin to install via /api/slack/install." }),
              signal: AbortSignal.timeout(10_000),
            });
          } catch (urlErr) {
            log.error({ err: urlErr instanceof Error ? urlErr.message : String(urlErr) }, "Failed to send response_url fallback");
          }
        }
        return;
      }

      const rateCheck = checkRateLimit(`slack:${teamId}:${userId}`);
      if (!rateCheck.allowed) {
        await postMessage(token, { channel: channelId, text: "Rate limit exceeded. Please wait before trying again." });
        return;
      }

      // Post initial "Thinking..." message to get a thread_ts
      const thinkingResult = await postMessage(token, {
        channel: channelId,
        text: `:hourglass_flowing_sand: Thinking about: _${text.slice(0, 150)}_...`,
      });

      if (!thinkingResult.ok || !thinkingResult.ts) {
        log.error({ error: thinkingResult.error }, "Failed to post thinking message");
        return;
      }

      const messageTs = thinkingResult.ts;

      // Look up or create conversation mapping
      const existingConversationId = await getConversationId(channelId, messageTs);
      const conversationId = existingConversationId ?? crypto.randomUUID();

      if (!existingConversationId) {
        setConversationId(channelId, messageTs, conversationId);
        // Persist conversation so thread follow-ups can load history
        createConversation({
          id: conversationId,
          title: generateTitle(text),
          surface: "slack",
        });
      }

      const queryResult = await executeAgentQuery(text);

      // Persist messages for thread history
      addMessage({ conversationId, role: "user", content: text });
      addMessage({ conversationId, role: "assistant", content: queryResult.answer });

      const blocks = formatQueryResponse(queryResult);
      const updateResult = await updateMessage(token, {
        channel: channelId,
        ts: messageTs,
        text: queryResult.answer,
        blocks,
      });
      if (!updateResult.ok) {
        log.error({ error: updateResult.error, channel: channelId, ts: messageTs }, "Failed to update Slack message with query result");
      }

      // Post ephemeral approval prompts for pending actions
      if (queryResult.pendingActions?.length) {
        for (const action of queryResult.pendingActions) {
          const approvalBlocks = formatActionApproval(action);
          const ephResult = await postEphemeral(token, {
            channel: channelId,
            user: userId,
            text: `Action requires approval: ${action.summary}`,
            blocks: approvalBlocks,
            thread_ts: messageTs,
          });
          if (!ephResult.ok) {
            log.error({ error: ephResult.error, channel: channelId, userId, actionId: action.id }, "Failed to post ephemeral action approval prompt");
          }
        }
      }
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err : new Error(String(err)) },
        "Slack async command processing failed",
      );

      // Try to post error message if we can
      try {
        const token = await getBotToken(teamId);
        if (token) {
          const errorMessage = scrubError(
            err instanceof Error ? err.message : "Unknown error",
          );
          await postMessage(token, {
            channel: channelId,
            text: errorMessage,
            blocks: formatErrorResponse(errorMessage),
          });
        }
      } catch (innerErr) {
        log.error({ err: innerErr instanceof Error ? innerErr.message : String(innerErr) }, "Failed to send error message to Slack");
      }
    }
  };

  // Fire-and-forget with error logging
  processAsync().catch((err) => {
    log.error(
      { err: err instanceof Error ? err : new Error(String(err)) },
      "Unhandled error in async Slack processing",
    );
  });

  // Immediate ack to Slack
  return c.json({
    response_type: "in_channel",
    text: `:hourglass_flowing_sand: Processing your question...`,
  });
});

// --- POST /api/slack/events ---

slack.post("/events", async (c) => {
  const { valid, body } = await verifyRequest(c);

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body);
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "Slack events received non-JSON body");
    return c.json({ error: "Invalid JSON" }, 400);
  }

  if (!valid) {
    return c.json({ error: "Invalid signature" }, 401);
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

      // Process async — ack immediately
      const processAsync = async () => {
        try {
          const token = await getBotToken(teamId);
          if (!token) {
            log.error({ teamId }, "No bot token for thread follow-up");
            return;
          }

          const rateCheck = checkRateLimit(`slack:${teamId}`);
          if (!rateCheck.allowed) {
            await postMessage(token, { channel, text: "Rate limit exceeded. Please wait before trying again.", thread_ts: threadTs });
            return;
          }

          // Check for existing conversation mapping
          const conversationId = await getConversationId(channel, threadTs);

          // Load conversation history for multi-turn context
          let priorMessages: Array<{ role: "user" | "assistant"; content: string }> | undefined;
          if (conversationId) {
            log.debug({ conversationId, threadTs }, "Found existing conversation for thread");
            const result = await getConversation(conversationId);
            if (result.ok && result.data.messages.length) {
              priorMessages = result.data.messages
                .filter((m): m is typeof m & { role: "user" | "assistant" } =>
                  m.role === "user" || m.role === "assistant",
                )
                .map((m) => ({
                  role: m.role,
                  content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
                }));
            } else if (!result.ok && result.reason === "error") {
              log.warn({ conversationId, threadTs }, "Failed to load conversation history — proceeding without context");
            }
          }

          const queryResult = await executeAgentQuery(text, undefined, priorMessages ? { priorMessages } : undefined);

          // Persist new messages for future follow-ups
          if (conversationId) {
            addMessage({ conversationId, role: "user", content: text });
            addMessage({ conversationId, role: "assistant", content: queryResult.answer });
          }
          const blocks = formatQueryResponse(queryResult);

          const postResult = await postMessage(token, {
            channel,
            text: queryResult.answer,
            blocks,
            thread_ts: threadTs,
          });
          if (!postResult.ok) {
            log.error({ error: postResult.error, channel, threadTs }, "Failed to post thread follow-up response");
          }

          // Post ephemeral approval prompts for pending actions
          const eventUserId = (event.user as string) ?? "";
          if (queryResult.pendingActions?.length && eventUserId) {
            for (const action of queryResult.pendingActions) {
              const approvalBlocks = formatActionApproval(action);
              const ephResult = await postEphemeral(token, {
                channel,
                user: eventUserId,
                text: `Action requires approval: ${action.summary}`,
                blocks: approvalBlocks,
                thread_ts: threadTs,
              });
              if (!ephResult.ok) {
                log.error({ error: ephResult.error, channel, userId: eventUserId, actionId: action.id }, "Failed to post ephemeral action approval prompt");
              }
            }
          }
        } catch (err) {
          log.error(
            { err: err instanceof Error ? err : new Error(String(err)) },
            "Thread follow-up processing failed",
          );

          try {
            const token = await getBotToken(teamId);
            if (token) {
              const errorMessage = scrubError(
                err instanceof Error ? err.message : "Unknown error",
              );
              await postMessage(token, {
                channel,
                text: errorMessage,
                blocks: formatErrorResponse(errorMessage),
                thread_ts: threadTs,
              });
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

// --- POST /api/slack/interactions ---

slack.post("/interactions", async (c) => {
  const { valid, body } = await verifyRequest(c);
  if (!valid) {
    return c.json({ error: "Invalid signature" }, 401);
  }

  // Slack sends interactions as URL-encoded form with a "payload" JSON field
  const params = new URLSearchParams(body);
  const payloadStr = params.get("payload");
  if (!payloadStr) {
    return c.json({ error: "Missing payload" }, 400);
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(payloadStr);
  } catch {
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
        const actionEntry = await getAction(actionId);
        if (!actionEntry) {
          log.warn({ actionId, userId }, "Slack interaction for unknown action");
          continue;
        }

        const pendingAction = {
          id: actionEntry.id,
          type: actionEntry.action_type,
          target: actionEntry.target,
          summary: actionEntry.summary,
        };

        if (isApprove) {
          const result = await approveAction(actionId, `slack:${userId}`);
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
          const result = await denyAction(actionId, `slack:${userId}`);
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
setInterval(() => {
  const now = Date.now();
  for (const [state, expiry] of pendingOAuthStates) {
    if (now > expiry) pendingOAuthStates.delete(state);
  }
}, 600_000).unref();

// --- GET /api/slack/install ---

slack.get("/install", (c) => {
  const clientId = process.env.SLACK_CLIENT_ID;
  if (!clientId) {
    return c.json({ error: "OAuth not configured" }, 501);
  }

  const state = crypto.randomUUID();
  pendingOAuthStates.set(state, Date.now() + 600_000);

  const scopes = "commands,chat:write,app_mentions:read";
  const url = `https://slack.com/oauth/v2/authorize?client_id=${clientId}&scope=${scopes}&state=${state}`;
  return c.redirect(url);
});

// --- GET /api/slack/callback ---

slack.get("/callback", async (c) => {
  const clientId = process.env.SLACK_CLIENT_ID;
  const clientSecret = process.env.SLACK_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
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
    client_id: clientId,
    client_secret: clientSecret,
    code,
  });

  if (!result.ok) {
    log.error({ error: result.error }, "OAuth exchange failed");
    return c.json({ error: "OAuth failed" }, 400);
  }

  const data = result as unknown as Record<string, unknown>;
  const team = data.team as { id?: string } | undefined;
  const accessToken = (data.access_token as string) ?? "";
  const teamId = team?.id ?? "";

  if (teamId && accessToken) {
    try {
      await saveInstallation(teamId, accessToken);
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

export { slack };
