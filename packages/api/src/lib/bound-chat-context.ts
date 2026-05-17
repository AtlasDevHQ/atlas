/**
 * Bound chat context — conversation↔dashboard relationship for #2363.
 *
 * The chat-as-dashboard-editor drawer (PRD #2362) creates a fresh
 * conversation bound to a dashboard. This module owns:
 *
 *   1. `bindConversationToDashboard` — stamps `conversations.bound_dashboard_id`
 *      after verifying the dashboard belongs to the caller's org.
 *   2. `resolveBoundDashboard` — reads the current bound dashboard for a
 *      conversation, returning the dashboard row + cards. Used by chat.ts
 *      to swap to the bound-mode tool registry and inject a per-turn card
 *      summary.
 *   3. `buildCardSummary` — pure helper. Compact id/title/chartType/position
 *      string the system prompt injects so the agent can reason about cards
 *      by natural reference ("the third card", "the bar chart") without a
 *      round trip through `getDashboardState`.
 *   4. `BOUND_AGENT_PROMPT_GUIDANCE` — system-prompt swap. The bound agent
 *      is composing a dashboard, not answering an arbitrary question; the
 *      generic data-analyst suffix gets replaced by composition rules
 *      (grid is 24 wide; KPI rows tall=4; trend cards w=12/24, h=8;
 *      chart-type heuristics).
 *
 * No HTTP / Hono concepts — the route layer wires this into chat.ts and
 * `/api/v1/dashboards/[id]/sessions` (#2368).
 */

import { createLogger } from "@atlas/api/lib/logger";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { getDashboard } from "@atlas/api/lib/dashboards";
import type {
  DashboardCard,
  DashboardWithCards,
} from "@atlas/api/lib/dashboard-types";

const log = createLogger("bound-chat-context");

/** Failure reasons callers may need to distinguish. */
export type BindFailReason = "no_db" | "dashboard_not_found" | "conversation_not_found" | "error";

export type BindResult = { ok: true } | { ok: false; reason: BindFailReason };

export type ResolveResult =
  | { ok: true; dashboard: DashboardWithCards }
  | { ok: false; reason: "no_db" | "not_bound" | "dashboard_missing" | "error" };

/**
 * Bind a conversation row to a dashboard. Verifies the dashboard exists
 * and belongs to `orgId` BEFORE writing — the FK in 0073 enforces dashboard
 * existence at the row level, but the org check has to live here because
 * `dashboards` and `conversations` share no org-scoping FK and a stale
 * client could otherwise stamp a cross-org pointer.
 */
export async function bindConversationToDashboard(
  conversationId: string,
  dashboardId: string,
  opts: { orgId?: string | null },
): Promise<BindResult> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };

  // Org-scoped dashboard existence check (mirrors #2424's connectionGroupId
  // pre-write gate in the chat route).
  const dash = await getDashboard(dashboardId, { orgId: opts.orgId ?? undefined });
  if (!dash.ok) {
    if (dash.reason === "not_found") return { ok: false, reason: "dashboard_not_found" };
    if (dash.reason === "no_db") return { ok: false, reason: "no_db" };
    return { ok: false, reason: "error" };
  }

  try {
    const rows = await internalQuery<{ id: string }>(
      `UPDATE conversations
          SET bound_dashboard_id = $1
        WHERE id = $2
      RETURNING id`,
      [dashboardId, conversationId],
    );
    if (rows.length === 0) return { ok: false, reason: "conversation_not_found" };
    return { ok: true };
  } catch (err) {
    log.error(
      { err: errorMessage(err), conversationId, dashboardId },
      "bindConversationToDashboard failed",
    );
    return { ok: false, reason: "error" };
  }
}

/**
 * Read the dashboard a conversation is currently bound to, including
 * its cards. Returns `not_bound` for conversations without a binding
 * (the default for non-drawer chats) and `dashboard_missing` if the
 * binding points at a dashboard that was deleted or no longer belongs
 * to the caller's org (the latter is the cross-tenant safety net the
 * route handler relies on — even though the FK enforces existence at
 * the row level, ON DELETE SET NULL means the column eventually
 * NULLs out and 'not_bound' is the expected state once it does).
 */
export async function resolveBoundDashboard(
  conversationId: string,
  opts: { orgId?: string | null },
): Promise<ResolveResult> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  try {
    const rows = await internalQuery<{ bound_dashboard_id: string | null }>(
      `SELECT bound_dashboard_id FROM conversations WHERE id = $1`,
      [conversationId],
    );
    if (rows.length === 0) return { ok: false, reason: "not_bound" };
    const boundId = rows[0]?.bound_dashboard_id ?? null;
    if (!boundId) return { ok: false, reason: "not_bound" };

    const dash = await getDashboard(boundId, { orgId: opts.orgId ?? undefined });
    if (!dash.ok) {
      // Dashboard either deleted between bind and read (FK SET NULL hasn't
      // propagated through cache) OR no longer belongs to the caller's org.
      // Either way the right surface to the caller is "treat as unbound" —
      // the chat falls back to the default agent without the editor tools.
      if (dash.reason === "not_found") return { ok: false, reason: "dashboard_missing" };
      return { ok: false, reason: "error" };
    }
    return { ok: true, dashboard: dash.data };
  } catch (err) {
    log.error(
      { err: errorMessage(err), conversationId },
      "resolveBoundDashboard failed",
    );
    return { ok: false, reason: "error" };
  }
}

/**
 * List archived bound conversations for a dashboard, org-scoped.
 *
 * Powers the History tab in the drawer (#2368). Workspace-wide visibility
 * matches the current dashboard ACL — anyone in the workspace who can
 * view the dashboard sees the same sessions list.
 */
export interface BoundSessionSummary {
  conversationId: string;
  userId: string | null;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export async function listSessionsForDashboard(
  dashboardId: string,
  orgId: string | null | undefined,
): Promise<BoundSessionSummary[]> {
  if (!hasInternalDB()) return [];
  try {
    // org_id is allowed to be NULL on conversations (legacy / self-hosted
    // single-tenant). Match the conventions in `scopeClause` from
    // conversations.ts: `(org_id = $N OR org_id IS NULL)`.
    const orgClause = orgId ? "AND (c.org_id = $2 OR c.org_id IS NULL)" : "";
    const params: unknown[] = [dashboardId];
    if (orgId) params.push(orgId);

    const rows = await internalQuery<{
      id: string;
      user_id: string | null;
      title: string | null;
      created_at: Date | string;
      updated_at: Date | string;
      message_count: number | string;
    }>(
      `SELECT c.id, c.user_id, c.title, c.created_at, c.updated_at,
              COALESCE(m.message_count, 0) AS message_count
         FROM conversations c
         LEFT JOIN (
           SELECT conversation_id, COUNT(*) AS message_count
             FROM messages
            GROUP BY conversation_id
         ) m ON m.conversation_id = c.id
        WHERE c.bound_dashboard_id = $1
          AND c.deleted_at IS NULL
          ${orgClause}
        ORDER BY c.created_at DESC
        LIMIT 200`,
      params,
    );

    return rows.map((r) => ({
      conversationId: r.id,
      userId: r.user_id,
      title: r.title,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
      messageCount: typeof r.message_count === "number"
        ? r.message_count
        : parseInt(r.message_count, 10) || 0,
    }));
  } catch (err) {
    log.error(
      { err: errorMessage(err), dashboardId, orgId },
      "listSessionsForDashboard failed",
    );
    return [];
  }
}

// ---------------------------------------------------------------------------
// Pure helpers — system prompt + per-turn card summary
// ---------------------------------------------------------------------------

/**
 * Build the compact per-turn card summary the bound agent sees in its
 * system prompt. One line per card: id, title, chart type, grid position.
 * Keeps the prompt small for dashboards with many cards — the agent
 * calls `getCardDetail(id)` for the full SQL / chartConfig only when
 * it needs to.
 *
 * Pure: takes cards in, returns a string. No DB, no Effect, no logger.
 */
export function buildCardSummary(cards: readonly DashboardCard[]): string {
  if (cards.length === 0) {
    return "## Current dashboard state\n\nThis dashboard has no cards yet. Use `addCard` to create the first one.";
  }
  const lines = cards.map((c) => {
    const chartType = c.chartConfig?.type ?? "table";
    const layout = c.layout
      ? `x=${c.layout.x},y=${c.layout.y},w=${c.layout.w},h=${c.layout.h}`
      : "auto-laid";
    return `- [${c.id}] "${c.title}" — ${chartType} — pos=${c.position} — ${layout}`;
  });
  return [
    "## Current dashboard state",
    "",
    `${cards.length} card${cards.length === 1 ? "" : "s"} — id, title, chart type, position, layout:`,
    "",
    ...lines,
    "",
    "Refer to cards by id when calling tools. The user may reference them naturally (\"the third card\", \"the bar chart\", \"the signups one\") — match against this list.",
  ].join("\n");
}

/**
 * Dashboard-composition guidance — replaces the generic
 * data-analyst suffix when the agent is bound to a dashboard.
 *
 * The grid constants here mirror `DASHBOARD_GRID` in
 * `packages/api/src/lib/dashboard-types.ts`. Hand-duplicated rather
 * than imported to keep this string purely declarative — if the
 * grid changes, this prompt has to be re-tuned anyway.
 */
export const BOUND_AGENT_PROMPT_GUIDANCE = `You are editing a saved dashboard, not answering an ad-hoc question. The user opened a chat drawer on this dashboard; every conversation turn should make a concrete edit (add a card, rename, change chart type, rearrange) or explain an existing card.

## Editing Workflow

1. **Identify what the user wants changed.** Use the compact card summary in the system prompt to map natural references ("card 3", "the bar chart", "the signups one") to card ids. If ambiguous, ask a short clarifying question before mutating.
2. **For new cards:** use \`explore\` + \`executeSQL\` to verify the query shape against the semantic layer, THEN call \`addCard\` with title + sql + chartConfig. Never call \`addCard\` with SQL you haven't validated — the tool rejects invalid queries but the failure surfaces in the user's UI.
3. **For changes to existing cards:** call \`getCardDetail(id)\` first to read the current SQL / chartConfig if you need them. Then call \`updateCard\` with only the fields that change.
4. **For layout changes:** call \`updateLayout\` with the full set of card placements you want. The grid is 24 columns wide and uses (x, y, w, h) per card.
5. **For "what is this card?" questions:** call \`getCardDetail(id)\` and explain in plain language. Don't mutate.

## Grid Layout

- Grid is 24 columns wide. Heights are unlimited but the canvas only renders rows the cards occupy.
- **KPI / small metric cards:** width 6–8, height 4.
- **Trend / time-series charts:** width 12 (half row) or 24 (full row), height 8.
- **Tables:** width 12–24, height 8–12.
- Stack KPIs across a row at y=0 to give the dashboard a strong top.
- New cards default to position 0,0 with auto-layout — call \`updateLayout\` explicitly if you want a specific arrangement.

## Chart Type Heuristics

- **bar**: comparison across discrete categories (top regions, top accounts).
- **line / area**: change over time. Always require a time-typed category column.
- **pie**: parts of a whole — use sparingly, only when the count of categories is small (<= 6).
- **scatter**: relationships between two numeric columns.
- **table**: detail-level rows, or when the user asks for a raw breakdown.

## Semantic Layer

Treat \`semantic/metrics/*.yml\` as authoritative. If a measure exists, use its SQL verbatim — do NOT hand-craft an aggregate that duplicates a named metric. Use \`explore\` to find metrics before writing custom SQL.

## Tool Rules

- \`getDashboardState\` returns the current dashboard meta + the same compact card summary the system prompt injects. Use it when you need a fresh read mid-conversation (e.g. after several mutations).
- \`getCardDetail(id)\` is the only way to fetch a card's SQL / chartConfig — keep it scoped to the cards you actually need.
- \`addCard\` / \`updateCard\` / \`updateLayout\` / \`updateDashboardMeta\` commit immediately to the dashboard. There is no undo in this tracer-bullet slice.
- Do NOT call \`executeSQL\` to mutate data — it is read-only. Use it to validate a card's query before calling \`addCard\`.

## Suggested Follow-ups

After each substantive edit, end your response with a <suggestions> block containing 2–3 next-step suggestions the user might want. Format:
<suggestions>
Add a regional breakdown card
Stack the KPIs across the top
Make the trend cards into a single row
</suggestions>`;
