/**
 * Bound dashboard editor tools (#2363).
 *
 * Six safe-op tools the bound agent gets when the chat is opened on a
 * dashboard. The factory function `createBoundDashboardTools` closes the
 * tools over the dashboardId + orgId resolved from the conversation's
 * `bound_dashboard_id` — the LLM cannot supply the dashboard id itself,
 * which is the whole point of binding (a turn cannot redirect mutations
 * at a different dashboard than the one the user opened).
 *
 * Destructive ops (`removeCard`, `updateCardSql`) are intentionally OUT
 * of this slice — they ship in #2365 as `stage_required` envelopes with
 * ghost-overlay accept/discard. Including them here would defeat the
 * tracer-bullet scope; last-write-wins to published is tolerable for
 * the safe set but not for delete / SQL rewrite.
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { CHART_TYPES } from "@useatlas/types";
import { createLogger } from "@atlas/api/lib/logger";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { validateSQL } from "@atlas/api/lib/tools/sql";
import {
  addCard,
  updateCard,
  updateDashboard,
  getCard,
  getDashboard,
  CardLayoutSchema,
} from "@atlas/api/lib/dashboards";
import type { DashboardCardLayout } from "@atlas/api/lib/dashboard-types";
import { buildCardSummary } from "@atlas/api/lib/bound-chat-context";
import {
  screenshotDashboard,
  invalidateDashboardScreenshot,
} from "@atlas/api/lib/dashboard-screenshot";

const log = createLogger("tool:bound-dashboard");

const ChartConfigSchema = z.object({
  type: z.enum(CHART_TYPES),
  categoryColumn: z.string().min(1),
  valueColumns: z.array(z.string().min(1)).min(1),
});

export interface BoundDashboardToolContext {
  dashboardId: string;
  orgId: string | null | undefined;
  /**
   * Caller identity. Used by `screenshotDashboard` (#2367) as part of the
   * screenshot cache key so user A's draft view can never leak to user B
   * when #2364 (drafts foundation) lands. May be null/undefined in
   * unauthenticated dev paths — the tool will refuse to render.
   */
  userId?: string | null;
  /**
   * Forwarded `Cookie:` header from the original chat request. The
   * screenshot tool's headless browser uses it to reach the auth-gated
   * `/dashboards/[id]` page without a fresh sign-in. Optional — when
   * absent, the screenshot tool falls back to
   * `ATLAS_INTERNAL_SCREENSHOT_COOKIE` (only meaningful in dev/test).
   */
  cookieHeader?: string | null;
}

/**
 * Build the editor tool set for a specific bound dashboard. The
 * dashboardId / orgId are captured at request time and the tool
 * registry consuming this is built per-request via
 * `buildBoundDashboardRegistry`.
 */
export function createBoundDashboardTools(
  ctx: BoundDashboardToolContext,
): ToolSet {
  const { dashboardId, orgId, userId, cookieHeader } = ctx;

  const getDashboardState = tool({
    description: `Read the current state of the dashboard you are editing. Returns the title, description, and a compact summary of every card (id, title, chart type, position, layout). Call this when you need a fresh read after several mutations. Card SQL is NOT returned — use \`getCardDetail\` for that.`,
    inputSchema: z.object({}).describe("No arguments"),
    execute: async () => {
      const dash = await getDashboard(dashboardId, { orgId: orgId ?? undefined });
      if (!dash.ok) {
        return { kind: "err" as const, error: `Could not read dashboard: ${dash.reason}` };
      }
      return {
        kind: "ok" as const,
        dashboard: {
          id: dash.data.id,
          title: dash.data.title,
          description: dash.data.description,
          cardCount: dash.data.cards.length,
        },
        summary: buildCardSummary(dash.data.cards),
      };
    },
  });

  const getCardDetail = tool({
    description: `Fetch the full detail (SQL, chartConfig, layout, cached columns) for a single card by its id. Use this when the user asks "what is this card counting?" or when you need to inspect the SQL before proposing a change. The compact card summary in your system prompt only shows id/title/chart-type/position.`,
    inputSchema: z.object({
      cardId: z.string().min(1).describe("Card id (from the compact summary)"),
    }),
    execute: async ({ cardId }) => {
      const card = await getCard(cardId, dashboardId);
      if (!card.ok) {
        return { kind: "err" as const, error: `Could not read card ${cardId}: ${card.reason}` };
      }
      return {
        kind: "ok" as const,
        card: {
          id: card.data.id,
          title: card.data.title,
          sql: card.data.sql,
          chartConfig: card.data.chartConfig,
          layout: card.data.layout,
          position: card.data.position,
          cachedColumns: card.data.cachedColumns,
        },
      };
    },
  });

  const addCardTool = tool({
    description: `Add a new card to the dashboard. Validates the SQL against the analytics datasource before persisting; if validation fails the card is NOT added and the error is returned so you can fix it and retry. Use AFTER \`executeSQL\` has confirmed the column names — \`chartConfig.categoryColumn\` and \`valueColumns\` must match the SQL output. The grid is 24 columns wide; layout is optional (auto-laid below the lowest existing card when omitted).`,
    inputSchema: z.object({
      title: z.string().min(1).max(200).describe("Card title (visible to the user)"),
      sql: z.string().min(1).describe("Read-only SELECT query"),
      chartConfig: ChartConfigSchema.describe("Chart type + column mapping"),
      layout: CardLayoutSchema.optional().describe("Optional grid placement {x, y, w, h}"),
    }),
    execute: async ({ title, sql, chartConfig, layout }) => {
      try {
        const validation = await validateSQL(sql, undefined);
        if (!validation.valid) {
          return {
            kind: "err" as const,
            error: `SQL validation failed: ${validation.error}. Fix the query and retry.`,
          };
        }
        const result = await addCard({
          dashboardId,
          title,
          sql,
          chartConfig,
          ...(layout && { layout }),
        });
        if (!result.ok) {
          return { kind: "err" as const, error: `Could not add card: ${result.reason}` };
        }
        // #2367 — published baseline shifted, drop cached screenshots.
        invalidateDashboardScreenshot(dashboardId);
        return {
          kind: "ok" as const,
          card: {
            id: result.data.id,
            title: result.data.title,
            chartType: result.data.chartConfig?.type ?? "table",
            position: result.data.position,
          },
        };
      } catch (err) {
        log.warn({ err: errorMessage(err), dashboardId }, "addCard tool failed unexpectedly");
        return { kind: "err" as const, error: "addCard failed unexpectedly. Try again or simplify the proposal." };
      }
    },
  });

  const updateCardTool = tool({
    description: `Update a card's title, chart type, or layout. Pass only the fields you want to change. Does NOT support changing the SQL — that is a destructive op and arrives as a staged ghost change in a later slice. To change the SQL today, ask the user to remove and re-add the card.`,
    inputSchema: z.object({
      cardId: z.string().min(1).describe("Card id"),
      title: z.string().min(1).max(200).optional(),
      chartConfig: ChartConfigSchema.nullable().optional(),
      layout: CardLayoutSchema.nullable().optional(),
      position: z.number().int().min(0).optional(),
    }),
    execute: async ({ cardId, title, chartConfig, layout, position }) => {
      try {
        const updates: {
          title?: string;
          chartConfig?: z.infer<typeof ChartConfigSchema> | null;
          layout?: DashboardCardLayout | null;
          position?: number;
        } = {};
        if (title !== undefined) updates.title = title;
        if (chartConfig !== undefined) updates.chartConfig = chartConfig;
        if (layout !== undefined) updates.layout = layout;
        if (position !== undefined) updates.position = position;

        if (Object.keys(updates).length === 0) {
          return { kind: "err" as const, error: "No fields supplied — pass at least one of title, chartConfig, layout, position." };
        }

        const result = await updateCard(cardId, dashboardId, updates);
        if (!result.ok) {
          return { kind: "err" as const, error: `Could not update card ${cardId}: ${result.reason}` };
        }
        // #2367 — published baseline shifted, drop cached screenshots.
        invalidateDashboardScreenshot(dashboardId);
        return { kind: "ok" as const, cardId, updated: Object.keys(updates) };
      } catch (err) {
        log.warn({ err: errorMessage(err), dashboardId, cardId }, "updateCard tool failed unexpectedly");
        return { kind: "err" as const, error: "updateCard failed unexpectedly. Try again." };
      }
    },
  });

  const updateLayoutTool = tool({
    description: `Rearrange cards on the grid by supplying a layout for each card you want to move. Cards not listed keep their current layout. The grid is 24 columns wide; (x + w) must be <= 24. Each item in \`layouts\` is { cardId, x, y, w, h }.`,
    inputSchema: z.object({
      layouts: z
        .array(
          z.object({
            cardId: z.string().min(1),
            x: z.number().int().min(0),
            y: z.number().int().min(0),
            w: z.number().int().min(1),
            h: z.number().int().min(1),
          }),
        )
        .min(1)
        .describe("Per-card grid placements"),
    }),
    execute: async ({ layouts }) => {
      const results: { cardId: string; ok: boolean; reason?: string }[] = [];
      for (const placement of layouts) {
        const { cardId, x, y, w, h } = placement;
        const parsed = CardLayoutSchema.safeParse({ x, y, w, h });
        if (!parsed.success) {
          results.push({ cardId, ok: false, reason: parsed.error.issues[0]?.message ?? "invalid layout" });
          continue;
        }
        const r = await updateCard(cardId, dashboardId, { layout: parsed.data });
        results.push(r.ok ? { cardId, ok: true } : { cardId, ok: false, reason: r.reason });
      }
      const failed = results.filter((r) => !r.ok);
      // #2367 — any successful placement shifts the published baseline.
      if (results.some((r) => r.ok)) invalidateDashboardScreenshot(dashboardId);
      if (failed.length > 0) {
        return { kind: "partial" as const, results, failedCount: failed.length };
      }
      return { kind: "ok" as const, results };
    },
  });

  const updateDashboardMetaTool = tool({
    description: `Update the dashboard's title or description. Pass only the fields you want to change.`,
    inputSchema: z.object({
      title: z.string().min(1).max(200).optional(),
      description: z.string().max(2000).nullable().optional(),
    }),
    execute: async ({ title, description }) => {
      const updates: { title?: string; description?: string | null } = {};
      if (title !== undefined) updates.title = title;
      if (description !== undefined) updates.description = description;

      if (Object.keys(updates).length === 0) {
        return { kind: "err" as const, error: "No fields supplied — pass title or description." };
      }

      const result = await updateDashboard(dashboardId, { orgId: orgId ?? undefined }, updates);
      if (!result.ok) {
        return { kind: "err" as const, error: `Could not update dashboard: ${result.reason}` };
      }
      // #2367 — title/description change is visible, drop cached screenshots.
      invalidateDashboardScreenshot(dashboardId);
      return { kind: "ok" as const, updated: Object.keys(updates) };
    },
  });

  const screenshotDashboardTool = tool({
    description: `Capture a PNG screenshot of the dashboard as the user currently sees it and feed it back to you as a multimodal image. Call this when the user asks about **spatial position** ("the card on the right", "the bottom row", "what's in the top-left corner?"), about **visual layout** ("does this look balanced?", "what colors are showing?"), or when textual card summaries can't answer the question. The screenshot is cached aggressively — calling it twice in a row without mutating is cheap. Mutations to cards invalidate the cache automatically.`,
    inputSchema: z.object({}).describe("No arguments — the dashboardId is bound to the conversation."),
    execute: async () => {
      if (!userId) {
        return {
          kind: "err" as const,
          error: "Screenshot tool requires an authenticated user.",
        };
      }
      const result = await screenshotDashboard({
        dashboardId,
        userId,
        orgId,
        cookieHeader: cookieHeader ?? null,
      });
      if (!result.ok) {
        return { kind: "err" as const, error: result.message };
      }
      // Compact JSON envelope alongside the image — the image-data part
      // is attached by `toModelOutput` below so the LLM sees a real
      // multimodal turn instead of a base64 string buried in JSON.
      return {
        kind: "ok" as const,
        mediaType: "image/png" as const,
        sizeBytes: result.png.length,
        cached: result.cached,
        durationMs: result.durationMs,
        // Base64 payload — pulled out by toModelOutput. Not exposed to
        // anything else (system prompt rules tell the agent not to
        // echo it back to the user).
        _base64: result.png.toString("base64"),
      };
    },
    toModelOutput: ({ output }) => {
      const typed = output as {
        kind: "ok" | "err";
        _base64?: string;
        mediaType?: string;
        error?: string;
      };
      if (typed.kind !== "ok" || !typed._base64) {
        return {
          type: "error-text",
          value: typed.error ?? "screenshotDashboard failed",
        };
      }
      return {
        type: "content",
        value: [
          {
            type: "image-data",
            data: typed._base64,
            mediaType: typed.mediaType ?? "image/png",
          },
          {
            type: "text",
            text: "Above: PNG screenshot of the current dashboard view. Cards are laid out on a 24-column grid. Use spatial references against this image when the user asks about position or layout.",
          },
        ],
      };
    },
  });

  return {
    getDashboardState,
    getCardDetail,
    addCard: addCardTool,
    updateCard: updateCardTool,
    updateLayout: updateLayoutTool,
    updateDashboardMeta: updateDashboardMetaTool,
    screenshotDashboard: screenshotDashboardTool,
  };
}

// ---------------------------------------------------------------------------
// Workflow descriptions — concatenated into the bound system prompt by
// `ToolRegistry.describe()` (see registry.ts).
// ---------------------------------------------------------------------------

export const BOUND_DASHBOARD_TOOL_DESCRIPTIONS: Record<string, string> = {
  getDashboardState: `### Read the dashboard
Use \`getDashboardState\` for a fresh read of the dashboard's title/description and a compact card summary. The summary lists every card by id, title, chart type, position, and layout — match natural references against this list.`,

  getCardDetail: `### Inspect a card in detail
Use \`getCardDetail(cardId)\` to fetch a card's full SQL, chartConfig, layout, and cached columns. The compact card summary in your system prompt only shows id/title/chart-type/position — call \`getCardDetail\` whenever you need the SQL or chartConfig to reason about, explain, or change a card.`,

  addCard: `### Add a card
Use \`addCard\` to create a new card. Always:
1. Call \`explore\` + \`executeSQL\` first to confirm the SQL shape and column names.
2. Build a chartConfig whose \`categoryColumn\` and \`valueColumns\` match the SQL output exactly.
3. Optionally specify a layout {x, y, w, h} in the 24-col grid.

The tool validates the SQL against the analytics datasource before persisting; if validation fails the card is NOT created.`,

  updateCard: `### Rename / re-chart / re-place a card
Use \`updateCard\` to change a card's title, chartConfig, layout, or position. Pass only the fields you want to change. Does NOT support SQL changes — those are destructive ops that arrive as staged ghost changes in a later slice.`,

  updateLayout: `### Rearrange the grid
Use \`updateLayout\` to move multiple cards at once. Supply the layouts array with one entry per card you want to place. Cards not listed stay where they are. Grid is 24 columns wide; (x + w) must be <= 24.`,

  updateDashboardMeta: `### Rename the dashboard / edit its description
Use \`updateDashboardMeta\` to change the dashboard's title or description. Pass only the fields you want to change.`,

  screenshotDashboard: `### See the dashboard with your own eyes (vision)
Use \`screenshotDashboard()\` to capture the dashboard as the user currently sees it and feed the PNG back to you as a multimodal image. Call this when the user asks about **spatial position** ("what's on the bottom-right?", "is the trend on the top row?") or about **visual layout** ("does this feel balanced?"). The card summary in your system prompt has ids and positions but not pixels — pixels are what this tool gives you.

- The screenshot is cached on a per-(dashboard, user) basis and short-TTL (60s); calling twice in a row without mutating is free.
- Card mutations (\`addCard\`, \`updateCard\`, \`updateLayout\`, \`updateDashboardMeta\`) invalidate the cache automatically — you'll get a fresh shot on the next call.
- Don't echo the base64 payload back to the user. The shot is for your eyes only.`,
};
