/**
 * Teams integration routes — plugin version.
 *
 * - POST /messages — Bot Framework messaging endpoint
 *
 * All runtime dependencies (agent executor, rate limiting) are received
 * via the TeamsRuntimeDeps interface rather than imported from @atlas/api.
 */

import { Hono } from "hono";
import type { PluginLogger } from "@useatlas/plugin-sdk";
import { verifyBotToken } from "./verify";
import { getAccessToken, sendReply, isValidServiceUrl } from "./teams-client";
import type { ReplyActivity } from "./teams-client";
import {
  formatQueryResponse,
  formatErrorResponse,
  cardAttachment,
} from "./format";
import type { TeamsQueryResult } from "./format";

// ---------------------------------------------------------------------------
// Activity types
// ---------------------------------------------------------------------------

export interface TeamsActivity {
  type: string;
  id: string;
  timestamp?: string;
  serviceUrl: string;
  channelId: string;
  from: { id: string; name?: string; aadObjectId?: string };
  conversation: {
    id: string;
    conversationType?: string;
    tenantId?: string;
    isGroup?: boolean;
  };
  recipient: { id: string; name?: string };
  text?: string;
  entities?: Array<{
    type: string;
    mentioned?: { id: string; name?: string };
    text?: string;
  }>;
  channelData?: Record<string, unknown>;
  replyToId?: string;
}

// ---------------------------------------------------------------------------
// Runtime dependency interface
// ---------------------------------------------------------------------------

export interface TeamsRuntimeDeps {
  appId: string;
  appPassword: string;
  tenantId?: string;
  log: PluginLogger;

  /** Run the Atlas agent on a question and return structured results. */
  executeQuery: (question: string) => Promise<TeamsQueryResult>;

  /** Optional rate limiting. */
  checkRateLimit?: (key: string) => { allowed: boolean };

  /** Optional error scrubbing. */
  scrubError?: (message: string) => string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip @mention text from a Teams message.
 *
 * Teams includes `<at>BotName</at>` in the message text for @mentions.
 * We remove the bot's mention entity text to extract the actual query.
 */
export function stripBotMention(
  text: string,
  botId: string,
  entities?: TeamsActivity["entities"],
): string {
  if (!entities?.length) return text.trim();

  let cleaned = text;
  for (const entity of entities) {
    if (
      entity.type === "mention" &&
      entity.mentioned?.id === botId &&
      entity.text
    ) {
      cleaned = cleaned.replace(entity.text, "");
    }
  }
  return cleaned.trim();
}

function safeScrub(deps: TeamsRuntimeDeps, message: string): string {
  if (deps.scrubError) return deps.scrubError(message);
  return "An internal error occurred. Check server logs for details.";
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

/**
 * Create Hono routes for the Teams integration. All runtime dependencies
 * are passed via the `deps` object.
 */
export function createTeamsRoutes(deps: TeamsRuntimeDeps): Hono {
  const teams = new Hono();
  const { log } = deps;

  // --- POST /messages ---

  teams.post("/messages", async (c) => {
    // Verify Bot Framework JWT
    const authHeader = c.req.header("authorization") ?? null;
    const authResult = await verifyBotToken(
      authHeader,
      deps.appId,
      deps.tenantId,
      log,
    );

    if (!authResult.valid) {
      log.warn({ error: authResult.error }, "Bot Framework auth failed");
      return c.json({ error: "Unauthorized" }, 401);
    }

    let activity: TeamsActivity;
    try {
      activity = (await c.req.json()) as TeamsActivity;
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Teams /messages received unparseable body",
      );
      return c.json({ error: "Invalid JSON" }, 400);
    }

    // Validate serviceUrl to prevent SSRF — only allow known Microsoft endpoints
    if (!isValidServiceUrl(activity.serviceUrl ?? "")) {
      log.warn(
        { serviceUrl: activity.serviceUrl },
        "Rejected activity with invalid serviceUrl",
      );
      return c.json({ error: "Invalid serviceUrl" }, 400);
    }

    // Handle conversationUpdate (bot added to team) — ack silently
    if (activity.type === "conversationUpdate") {
      return c.json({ status: "ok" });
    }

    // Only process message activities
    if (activity.type !== "message") {
      log.debug(
        { activityType: activity.type, activityId: activity.id },
        "Ignoring unhandled activity type",
      );
      return c.json({ status: "ok" });
    }

    const rawText = activity.text ?? "";
    const botId = activity.recipient?.id ?? "";
    const query = stripBotMention(rawText, botId, activity.entities);

    if (!query) {
      return c.json({ status: "ok" });
    }

    const userId = activity.from?.aadObjectId ?? activity.from?.id ?? "";
    const conversationId = activity.conversation?.id ?? "";

    log.info(
      { userId, conversationId, question: query.slice(0, 100) },
      "Teams message received",
    );

    // Process asynchronously — Bot Framework expects a 200 within seconds
    const processAsync = async () => {
      try {
        // Rate limiting
        if (deps.checkRateLimit) {
          const rateCheck = deps.checkRateLimit(
            `teams:${conversationId}:${userId}`,
          );
          if (!rateCheck.allowed) {
            const token = await getAccessToken(
              deps.appId,
              deps.appPassword,
              log,
            );
            const rateLimitReply: ReplyActivity = {
              type: "message",
              text: "Rate limit exceeded. Please wait before trying again.",
            };
            await sendReply(
              activity.serviceUrl,
              conversationId,
              activity.id,
              rateLimitReply,
              token,
              log,
            );
            return;
          }
        }

        // Run the query
        const queryResult = await deps.executeQuery(query);

        // Format and send reply
        const card = formatQueryResponse(queryResult);
        const token = await getAccessToken(
          deps.appId,
          deps.appPassword,
          log,
        );
        const reply: ReplyActivity = {
          type: "message",
          text: queryResult.answer,
          attachments: [cardAttachment(card)],
        };

        const sent = await sendReply(
          activity.serviceUrl,
          conversationId,
          activity.id,
          reply,
          token,
          log,
        );

        if (!sent) {
          log.error(
            { conversationId, activityId: activity.id },
            "Failed to send Teams reply",
          );
        }
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err : new Error(String(err)) },
          "Teams async message processing failed",
        );

        try {
          const token = await getAccessToken(
            deps.appId,
            deps.appPassword,
            log,
          );
          const errorMessage = safeScrub(
            deps,
            err instanceof Error ? err.message : "Unknown error",
          );
          const errorCard = formatErrorResponse(errorMessage);
          const errorReply: ReplyActivity = {
            type: "message",
            text: errorMessage,
            attachments: [cardAttachment(errorCard)],
          };
          await sendReply(
            activity.serviceUrl,
            conversationId,
            activity.id,
            errorReply,
            token,
            log,
          );
        } catch (innerErr) {
          log.error(
            {
              err: innerErr instanceof Error
                ? innerErr.message
                : String(innerErr),
            },
            "Failed to send error message to Teams",
          );
        }
      }
    };

    processAsync().catch((err) => {
      log.error(
        { err: err instanceof Error ? err : new Error(String(err)) },
        "Unhandled error in async Teams processing",
      );
    });

    // Ack immediately — Bot Framework requires fast response
    return c.json({ status: "ok" });
  });

  return teams;
}
