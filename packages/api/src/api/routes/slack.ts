/**
 * Slack runtime routes.
 *
 * - POST /api/v1/slack/commands  — slash command handler (/atlas)
 * - POST /api/v1/slack/events   — Events API (url_verification only)
 * - POST /api/v1/slack/interactions — Block action interactions
 *
 * POST routes verify Slack request signatures. The slash command acks
 * within 3 seconds and processes the query asynchronously.
 *
 * OAuth install + callback lifted to /api/v1/integrations/slack/{install,callback}
 * in #2653 (slice 5 of #2649) — see `lib/integrations/install/slack-oauth-handler.ts`.
 * The Slack App's redirect URI in api.slack.com/apps/<atlas-app-id>/oauth
 * must point at the new path for all SaaS regions.
 *
 * Channel-message events (`app_mention`, `message + thread_ts`) used to
 * live on this route. As of slice 3 of #2607 they are owned by the
 * `@useatlas/chat` plugin's webhook at
 * `/api/plugins/chat-interaction/webhooks/slack`.
 *
 * TODO(#2612 / slice 4 — HITL dogfood): the Slack app manifest MUST be
 * flipped from `/api/v1/slack/events` to
 * `/api/plugins/chat-interaction/webhooks/slack` during the slice-4
 * dogfood. Until that flip happens, this route silently drops all
 * `event_callback` types (it logs at warn — see `eventsRoute` handler
 * below — but @mentions and thread replies are not processed). The
 * `url_verification` branch is retained so re-verifying the URL after
 * the flip succeeds against either endpoint.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { validationHook } from "./validation-hook";
import { z } from "zod";
import { executeAgentQuery } from "@atlas/api/lib/agent-query";
import { createLogger } from "@atlas/api/lib/logger";
import { checkRateLimit } from "@atlas/api/lib/auth/middleware";
import { botActorUser } from "@atlas/api/lib/auth/actor";
import { verifySlackSignature } from "@atlas/api/lib/slack/verify";
import { postMessage, updateMessage, postEphemeral } from "@atlas/api/lib/slack/api";
import { formatQueryResponse, formatErrorResponse, formatActionApproval, formatActionResult } from "@atlas/api/lib/slack/format";
import { approveAction, denyAction, getAction } from "@atlas/api/lib/tools/actions/handler";
import { getBotToken, getInstallation } from "@atlas/api/lib/slack/store";
import { getConversationId, setConversationId } from "@atlas/api/lib/slack/threads";
import { createConversation, addMessage, generateTitle } from "@atlas/api/lib/conversations";
import { SENSITIVE_PATTERNS } from "@atlas/api/lib/security";
import { ErrorSchema } from "./shared-schemas";

const log = createLogger("slack");

const slack = new OpenAPIHono({ defaultHook: validationHook });

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

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const SlackCommandResponseSchema = z.object({
  response_type: z.string(),
  text: z.string(),
});

const SlackOkResponseSchema = z.object({
  ok: z.boolean(),
});

const SlackEventResponseSchema = z.record(z.string(), z.unknown());

const commandsRoute = createRoute({
  method: "post",
  path: "/commands",
  tags: ["Slack"],
  summary: "Slack slash command",
  description:
    "Handles Slack slash commands (/atlas). Acks within 3 seconds and processes the query asynchronously. " +
    "Requires SLACK_SIGNING_SECRET. Request signature is verified via x-slack-signature header.",
  responses: {
    200: {
      description: "Immediate acknowledgment (processing continues asynchronously)",
      content: { "application/json": { schema: SlackCommandResponseSchema } },
    },
    401: {
      description: "Invalid Slack signature",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const eventsRoute = createRoute({
  method: "post",
  path: "/events",
  tags: ["Slack"],
  summary: "Slack Events API",
  description:
    "Handles Slack Events API callbacks including url_verification challenges and thread follow-up messages. " +
    "Bot messages are ignored to prevent loops. Request signature is verified via x-slack-signature header.",
  responses: {
    200: {
      description: "Event acknowledged",
      content: { "application/json": { schema: SlackEventResponseSchema } },
    },
    400: {
      description: "Invalid JSON body",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Invalid Slack signature",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const interactionsRoute = createRoute({
  method: "post",
  path: "/interactions",
  tags: ["Slack"],
  summary: "Slack block action interactions",
  description:
    "Handles Slack block_actions interactions (approve/deny action prompts). " +
    "Acks immediately and processes the action asynchronously. " +
    "Request signature is verified via x-slack-signature header.",
  responses: {
    200: {
      description: "Interaction acknowledged",
      content: { "application/json": { schema: SlackOkResponseSchema } },
    },
    400: {
      description: "Missing or invalid payload",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Invalid Slack signature",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

// --- POST /api/v1/slack/commands ---

slack.openapi(commandsRoute, async (c) => {
  const { valid, body } = await verifyRequest(c);
  if (!valid) {
    return c.json({ error: "invalid_signature", message: "Invalid signature" }, 401);
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
    }, 200);
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
              body: JSON.stringify({ response_type: "ephemeral", text: "Atlas is not configured for this workspace. Ask an admin to install via /api/v1/integrations/slack/install." }),
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

      // F-55: bind a workspace bot actor so approval rules apply to chat
      // invocations. Without an Atlas org id, `checkApprovalRequired`
      // short-circuits and any rule-matching query runs ungated. The
      // installation row carries org_id for multi-workspace deployments;
      // single-workspace env-token deployments fall through to the
      // unauthenticated path (no rules can match without an org).
      const installation = await getInstallation(teamId);
      const orgId = installation?.org_id ?? null;
      // Guard `externalUserId` so an empty Slack `user_id` doesn't produce
      // a synthetic actor id ending in `:` (e.g. `slack-bot:T123:`). Matches
      // the thread-follow-up path's spread + truthy guard.
      const actor = orgId
        ? botActorUser({
            platform: "slack",
            externalId: teamId,
            orgId,
            ...(userId ? { externalUserId: userId } : {}),
          })
        : undefined;

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

      // #2072 — stamp 'slack' so surface-scoped approval rules can
      // distinguish Slack receivers from chat / mcp / scheduler.
      const queryResult = await executeAgentQuery(text, undefined, {
        ...(actor ? { actor } : {}),
        approvalSurface: "slack",
      });

      // Persist messages for thread history
      addMessage({ conversationId, role: "user", content: text });
      addMessage({ conversationId, role: "assistant", content: queryResult.answer });

      // F-55: when an approval rule matched, the SQL ran through the gate
      // and was queued rather than executed. Replace the agent's free-form
      // text with an unambiguous "approve via Atlas" message so the Slack
      // user knows where to act. The approval request itself is already
      // persisted by `executeSQL`.
      if (queryResult.pendingApproval) {
        const approvalText =
          `:lock: This query requires approval before it can run. ` +
          `Rule: *${queryResult.pendingApproval.ruleName}*. ` +
          `Approve via the Atlas admin console.`;
        log.info(
          { channelId, teamId, approvalRequestId: queryResult.pendingApproval.requestId },
          "Slack query held for approval",
        );
        const approvalUpdate = await updateMessage(token, {
          channel: channelId,
          ts: messageTs,
          text: approvalText,
          blocks: formatErrorResponse(approvalText),
        });
        if (!approvalUpdate.ok) {
          log.error(
            { error: approvalUpdate.error, channel: channelId, ts: messageTs },
            "Failed to update Slack message with approval-required notice",
          );
        }
        return;
      }

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

  // Immediate ack to Slack. Ephemeral so it only shows to the asker and
  // doesn't double up with the bot's in-channel "Thinking..." message that
  // gets updated in place with the final answer.
  return c.json({
    response_type: "ephemeral",
    text: `:hourglass_flowing_sand: Processing your question...`,
  }, 200);
});

// --- POST /api/v1/slack/events ---
//
// The legacy `app_mention` + `message + thread_ts` branches that used to
// live here have been migrated to the `@useatlas/chat` plugin (slice 3 of
// #2607). The host-side `executeQuery` helper at
// `packages/api/src/lib/chat-plugin/executeQuery.ts` preserves every
// behaviour the legacy branches had: F-55 actor binding via
// `botActorUser({ platform: "slack", externalId: teamId, orgId, ... })`,
// `approvalSurface: "slack"` stamp, `slack:${teamId}` rate-limit key,
// conversation persistence via `getConversationId` / `setConversationId`
// / `createConversation` / `addMessage`, the `:lock:` pending-approval
// path, per-action ephemeral approval prompts (now via Chat SDK's native
// `postEphemeral`), and `scrubError` formatting.
//
// This route is retained so a slow-rolling Slack-app-manifest flip
// doesn't break the existing endpoint-verification step:
//
//   - `url_verification` challenges still return `{ challenge }` so
//     re-verifying the URL after the flip succeeds against either
//     endpoint.
//   - `event_callback` types are acked 200 + ignored (logged at warn so
//     ops sees them in dashboards). Routing them here would double-fire
//     the agent once the manifest points at the chat plugin webhook.
//
// TODO(#2612 / slice 4 — HITL dogfood): in the Slack app admin console,
// update the Events API request URL from `/api/v1/slack/events` to
// `/api/plugins/chat-interaction/webhooks/slack`. Until this flip
// happens, the warn-level log below is the ONLY signal that @mentions
// are silently dropping — monitor it during the rollout.

slack.openapi(eventsRoute, async (c) => {
  const { valid, body } = await verifyRequest(c);
  if (!valid) {
    return c.json({ error: "invalid_signature", message: "Invalid signature" }, 401);
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body);
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "Slack events received non-JSON body");
    return c.json({ error: "invalid_json", message: "Invalid JSON" }, 400);
  }

  if (payload.type === "url_verification") {
    return c.json({ challenge: payload.challenge }, 200);
  }

  if (payload.type === "event_callback") {
    const event = payload.event as Record<string, unknown> | undefined;
    log.warn(
      {
        teamId: payload.team_id,
        eventType: event?.type,
        eventTs: event?.ts,
      },
      "Slack event_callback received on legacy route — ignored (chat plugin owns this path; flip the Slack manifest URL during #2612)",
    );
    return c.json({ ok: true }, 200);
  }

  return c.json({ ok: true }, 200);
});


// --- POST /api/v1/slack/interactions ---

slack.openapi(interactionsRoute, async (c) => {
  const { valid, body } = await verifyRequest(c);
  if (!valid) {
    return c.json({ error: "invalid_signature", message: "Invalid signature" }, 401);
  }

  // Slack sends interactions as URL-encoded form with a "payload" JSON field
  const params = new URLSearchParams(body);
  const payloadStr = params.get("payload");
  if (!payloadStr) {
    return c.json({ error: "missing_payload", message: "Missing payload" }, 400);
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(payloadStr);
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "Failed to parse block_actions payload JSON");
    return c.json({ error: "invalid_payload", message: "Invalid payload JSON" }, 400);
  }

  if (payload.type !== "block_actions") {
    log.debug({ type: payload.type }, "Acked non-block_actions Slack interaction type");
    return c.json({ ok: true }, 200);
  }

  const actions = payload.actions as Array<{
    action_id: string;
    value: string;
  }> | undefined;

  if (!actions?.length) {
    return c.json({ ok: true }, 200);
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

  return c.json({ ok: true }, 200);
});

export { slack };
