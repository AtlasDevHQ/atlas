/**
 * Host-side `executeQuery` for the `@useatlas/chat` plugin (slice 3 of #2607).
 *
 * Wires the chat plugin's `executeQuery` callback to Atlas's agent loop.
 * On SaaS the same Chat instance routes events from N tenants — this helper
 * resolves the inbound Slack `team_id` → `slack_installations.org_id` →
 * `botActorUser` before invoking {@link executeAgentQuery}. Without that
 * binding `checkApprovalRequired` short-circuits on a missing `orgId` and
 * the approval gate silently disables (F-55 regression).
 *
 * Mirrors what `packages/api/src/api/routes/slack.ts` does today for the
 * `app_mention` and `message + threadTs` branches:
 *
 *   - `getBotToken(teamId)` / `getInstallation(teamId)` for tenancy
 *   - `botActorUser({ platform: "slack", externalId: teamId, orgId, ... })`
 *     for the F-55 approval-gate identity
 *   - `executeAgentQuery(question, undefined, { actor, approvalSurface: "slack", priorMessages })`
 *   - `getConversationId` / `setConversationId` for thread → conversation mapping
 *   - `createConversation` / `addMessage` for multi-turn persistence
 *   - `checkRateLimit("slack:${teamId}")` for per-tenant rate limiting
 *   - `scrubError` for user-safe error surfacing
 *
 * Pending actions (`PendingAction[]`) are returned to the chat plugin bridge
 * so it can post per-action ephemeral approval prompts via Chat SDK's
 * native `postEphemeral`. The legacy `:lock:` pending-approval text is
 * surfaced via the returned `answer` field when the agent run hits an
 * approval rule (matches the slack.ts `pendingApproval` path).
 *
 * Layer hygiene: this module lives under `lib/` and never imports from
 * `api/routes/` (CLAUDE.md layer rule).
 *
 * @see packages/api/src/api/routes/slack.ts (legacy path, retired by #2611)
 * @see packages/api/src/lib/proactive/answer-adapter.ts (sister adapter for proactive flow)
 * @see packages/api/src/lib/proactive/workspace-id-resolver.ts (the
 *   precedent for `rawMessage.team_id` → org_id resolution)
 */

import type {
  ChatExecuteQueryContext,
  ChatQueryResult,
  ChatPluginConfig,
} from "@useatlas/chat";
import { executeAgentQuery } from "@atlas/api/lib/agent-query";
import { createLogger } from "@atlas/api/lib/logger";
import { checkRateLimit } from "@atlas/api/lib/auth/middleware";
import { botActorUser } from "@atlas/api/lib/auth/actor";
import { getInstallation } from "@atlas/api/lib/slack/store";
import { getConversationId, setConversationId } from "@atlas/api/lib/slack/threads";
import {
  createConversation,
  addMessage,
  getConversation,
  generateTitle,
} from "@atlas/api/lib/conversations";
import { SENSITIVE_PATTERNS } from "@atlas/api/lib/security";

const log = createLogger("chat-plugin:executeQuery");

/** User-safe scrubbed message returned in place of a real error.
 *
 * Mirrors `slack.ts:scrubError` — connection strings, stack traces, file
 * paths, and tokens all flatten to a generic "internal error" message
 * before they leave the process. The chat plugin bridge will additionally
 * route this through `config.scrubError` if wired (no double-redaction —
 * `SENSITIVE_PATTERNS` is idempotent), but we scrub here too so the
 * thrown error's `.message` is safe in tracking dashboards.
 */
function scrubError(message: string): string {
  if (SENSITIVE_PATTERNS.test(message) || message.length > 200) {
    return "An internal error occurred. Check server logs for details.";
  }
  return message;
}

/**
 * Minimum shape we read from the Slack raw event payload. The chat SDK
 * types this as `SlackEvent` (with `team_id`, `user`, `channel`,
 * `thread_ts`, `ts`, etc.) but the contract here is `unknown` — narrow
 * defensively. `team_id` is the primary tenant key; `team` is a legacy
 * alias seen on some webhook shapes. `user` is the asker's Slack user id.
 */
interface SlackRawEvent {
  team_id?: string;
  team?: string;
  user?: string;
  channel?: string;
  thread_ts?: string;
  ts?: string;
  text?: string;
}

/** Empty result skeleton the chat plugin expects when we can't answer. */
const EMPTY_RESULT: ChatQueryResult = {
  answer: "",
  sql: [],
  data: [],
  steps: 0,
  usage: { totalTokens: 0 },
};

/**
 * Build the chat plugin's `executeQuery` callback.
 *
 * Today only the Slack adapter is supported on SaaS. Other platforms
 * (Teams, Discord, ...) flow through the same callback when wired —
 * each gets its own tenant resolver branch as it comes online. The
 * `unsupported platform` branch returns a user-safe answer rather than
 * throwing so the plugin's `buildErrorCard` path stays graceful.
 *
 * The returned callback is plain async — no `Effect` / `ManagedRuntime`
 * dependency. `executeAgentQuery` resolves its own context internally.
 */
export function createChatPluginExecuteQuery(): ChatPluginConfig["executeQuery"] {
  return async (question, ctx) => {
    return runExecuteQuery(question, ctx);
  };
}

/** Internal — exported only for tests. */
export async function runExecuteQuery(
  question: string,
  ctx: ChatExecuteQueryContext,
): Promise<ChatQueryResult> {
  const requestId = crypto.randomUUID();
  const { threadId, priorMessages, adapter, rawMessage } = ctx;

  // 1. Dispatch by platform. Slack-only on SaaS today.
  if (adapter.name !== "slack") {
    log.warn(
      { adapterName: adapter.name, threadId, requestId },
      "Chat plugin executeQuery received unsupported platform — refusing",
    );
    throw new Error(
      `Chat platform '${adapter.name}' is not yet supported by this Atlas deployment.`,
    );
  }

  // 2. Resolve tenant from `rawMessage.team_id`. Mirrors
  //    `lib/proactive/workspace-id-resolver.ts:createSlackWorkspaceIdResolver`.
  const raw = (rawMessage ?? {}) as SlackRawEvent;
  const teamId = raw.team_id ?? raw.team;
  if (!teamId) {
    log.warn(
      { threadId, requestId },
      "Chat plugin executeQuery received Slack event without team_id — refusing",
    );
    throw new Error(
      "This Slack event is missing tenant context. Please try again.",
    );
  }

  // 3. Per-tenant rate limit. Key shape matches slack.ts so existing
  //    buckets keep their state across the migration.
  const rateCheck = checkRateLimit(`slack:${teamId}`);
  if (!rateCheck.allowed) {
    log.info(
      { teamId, threadId, requestId },
      "Chat plugin executeQuery rate-limited",
    );
    throw new Error("Rate limit exceeded. Please wait before trying again.");
  }

  // 4. F-55 actor — bind a workspace bot actor so approval rules apply.
  //    `getInstallation(teamId)` reads `slack_installations.org_id`.
  //    Without an Atlas org id, `checkApprovalRequired` short-circuits
  //    and any rule-matching query runs ungated.
  let orgId: string | null = null;
  try {
    const installation = await getInstallation(teamId);
    orgId = installation?.org_id ?? null;
  } catch (err) {
    log.warn(
      {
        teamId,
        threadId,
        requestId,
        err: err instanceof Error ? err.message : String(err),
      },
      "Failed to load Slack installation — proceeding without actor",
    );
  }
  const externalUserId = raw.user;
  const actor = orgId
    ? botActorUser({
        platform: "slack",
        externalId: teamId,
        orgId,
        ...(externalUserId ? { externalUserId } : {}),
      })
    : undefined;

  // 5. Multi-turn conversation persistence. The chat plugin's bridge
  //    already keeps its own thread-history cache (`MessageHistoryCache`),
  //    but Atlas's internal `conversations` table is the source of truth
  //    for cross-surface history (admin console + web chat + Slack thread
  //    reads). Mirror what slack.ts does: look up by (channel, thread_ts)
  //    and persist the user/assistant turns.
  const channelId = raw.channel ?? "";
  const slackThreadTs = raw.thread_ts ?? raw.ts ?? "";
  let conversationId: string | null = null;
  if (channelId && slackThreadTs) {
    try {
      conversationId = await getConversationId(channelId, slackThreadTs);
    } catch (err) {
      log.debug(
        {
          err: err instanceof Error ? err.message : String(err),
          channelId,
          slackThreadTs,
          requestId,
        },
        "getConversationId failed — proceeding without persisted history",
      );
    }
    if (!conversationId) {
      conversationId = crypto.randomUUID();
      try {
        await setConversationId(channelId, slackThreadTs, conversationId);
        createConversation({
          id: conversationId,
          title: generateTitle(question),
          surface: "slack",
        });
      } catch (err) {
        log.warn(
          {
            err: err instanceof Error ? err.message : String(err),
            channelId,
            slackThreadTs,
            requestId,
          },
          "Failed to persist new conversation — proceeding with in-memory only",
        );
      }
    }
  }

  // 6. If the bridge supplied `priorMessages`, prefer them (they're the
  //    chat SDK's MessageHistoryCache, which is closer to the live thread
  //    state than a stale DB row). Otherwise rehydrate from the Atlas
  //    `conversations` table — matches slack.ts's thread-followup branch.
  let history = priorMessages;
  if (!history && conversationId) {
    try {
      const result = await getConversation(conversationId);
      if (result.ok && result.data.messages.length) {
        history = result.data.messages
          .filter(
            (m): m is typeof m & { role: "user" | "assistant" } =>
              m.role === "user" || m.role === "assistant",
          )
          .map((m) => ({
            role: m.role,
            content:
              typeof m.content === "string"
                ? m.content
                : JSON.stringify(m.content),
          }));
      }
    } catch (err) {
      log.warn(
        {
          conversationId,
          err: err instanceof Error ? err.message : String(err),
          requestId,
        },
        "Failed to load conversation history — proceeding without context",
      );
    }
  }

  // 7. Run the agent. Approval-surface stamp is the chat-platform tag
  //    (#2072) — required for surface-scoped approval rules to fire.
  let queryResult;
  try {
    queryResult = await executeAgentQuery(question, requestId, {
      ...(history ? { priorMessages: history } : {}),
      ...(actor ? { actor } : {}),
      approvalSurface: "slack",
      ...(conversationId ? { conversationId } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      {
        err: err instanceof Error ? err : new Error(message),
        teamId,
        threadId,
        requestId,
      },
      "Chat plugin executeQuery agent run failed",
    );
    throw new Error(scrubError(message), { cause: err });
  }

  // 8. Persist messages so future follow-ups can load history. Best-effort.
  if (conversationId) {
    try {
      addMessage({ conversationId, role: "user", content: question });
      addMessage({
        conversationId,
        role: "assistant",
        content: queryResult.answer,
      });
    } catch (err) {
      log.debug(
        {
          err: err instanceof Error ? err.message : String(err),
          conversationId,
          requestId,
        },
        "Failed to persist conversation messages — non-fatal",
      );
    }
  }

  // 9. Approval-required path: replace the agent's free-form text with
  //    the canonical `:lock:` notice. The bridge renders this through
  //    `buildQueryResultCard` which calls `formatQueryResponse` — keeping
  //    the message on `answer` means it surfaces in-thread identically to
  //    the legacy slack.ts path.
  if (queryResult.pendingApproval) {
    log.info(
      {
        teamId,
        threadId,
        approvalRequestId: queryResult.pendingApproval.requestId,
        requestId,
      },
      "Chat plugin executeQuery held for approval",
    );
    return {
      ...EMPTY_RESULT,
      answer:
        `:lock: This query requires approval before it can run. ` +
        `Rule: *${queryResult.pendingApproval.ruleName}*. ` +
        `Approve via the Atlas admin console.`,
    };
  }

  // 10. Map AgentQueryResult → ChatQueryResult. The two shapes already
  //     line up almost 1:1; `pendingActions` flows through so the bridge
  //     posts per-action ephemeral approval prompts.
  return {
    answer: queryResult.answer,
    sql: queryResult.sql,
    data: queryResult.data,
    steps: queryResult.steps,
    usage: queryResult.usage,
    ...(queryResult.pendingActions && queryResult.pendingActions.length > 0
      ? { pendingActions: queryResult.pendingActions }
      : {}),
  };
}
