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

import * as crypto from "crypto";
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
  isDashboardDraftsEnabled,
  forkOrLoadDraft,
  saveDraft,
  applyChangeToDraft,
  materializeDraftView,
  type DashboardSnapshotCard,
} from "@atlas/api/lib/dashboard-versioning";

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
   * Bound editor's user id. When `ATLAS_DASHBOARD_DRAFTS_ENABLED=true`
   * AND a userId is present, mutating tools route through the user's
   * draft (forking from published on first touch). When unset OR the
   * flag is off, mutations fall through to the legacy direct-published
   * path — preserves #2363 behavior for anonymous + flag-off cases.
   */
  userId?: string | null;
}

/**
 * Apply a change to the user's draft snapshot when the drafts flag is
 * on and we have a userId; otherwise the caller falls through to the
 * direct-published path. Returns:
 *   - `{ routed: true, ok: true }`  → draft updated, the legacy path
 *     should NOT run.
 *   - `{ routed: true, ok: false, error }` → drafts path was selected
 *     but failed; surface the error and skip the legacy path so we
 *     don't double-write.
 *   - `{ routed: false }` → flag off or no userId; caller runs the
 *     legacy direct-published mutation.
 */
async function maybeApplyToDraft(
  ctx: BoundDashboardToolContext,
  change: import("@atlas/api/lib/dashboard-versioning").DraftChange,
): Promise<
  | { routed: true; ok: true }
  | { routed: true; ok: false; error: string }
  | { routed: false }
> {
  if (!isDashboardDraftsEnabled()) return { routed: false };
  if (!ctx.userId) return { routed: false };
  const published = await getDashboard(ctx.dashboardId, {
    orgId: ctx.orgId ?? undefined,
  });
  if (!published.ok) {
    return { routed: true, ok: false, error: `Could not read dashboard: ${published.reason}` };
  }
  const draftRow = await forkOrLoadDraft(ctx.userId, published.data);
  if (!draftRow) {
    return {
      routed: true,
      ok: false,
      error: "Could not load or create a draft for this dashboard. Internal DB unavailable.",
    };
  }
  const applied = applyChangeToDraft(draftRow.snapshot, change);
  if (!applied.ok) {
    return {
      routed: true,
      ok: false,
      error: `Could not apply change to draft: ${applied.reason} (cardId=${applied.cardId})`,
    };
  }
  const saved = await saveDraft(ctx.userId, ctx.dashboardId, applied.snapshot);
  if (!saved) {
    return { routed: true, ok: false, error: "Could not persist draft update." };
  }
  return { routed: true, ok: true };
}

/**
 * Build the editor tool set for a specific bound dashboard. The
 * dashboardId / orgId / userId are captured at request time and the
 * tool registry consuming this is built per-request via
 * `buildBoundDashboardRegistry`.
 */
export function createBoundDashboardTools(
  ctx: BoundDashboardToolContext,
): ToolSet {
  const { dashboardId, orgId } = ctx;

  const getDashboardState = tool({
    description: `Read the current state of the dashboard you are editing. Returns the title, description, and a compact summary of every card (id, title, chart type, position, layout). Call this when you need a fresh read after several mutations. Card SQL is NOT returned — use \`getCardDetail\` for that.`,
    inputSchema: z.object({}).describe("No arguments"),
    execute: async () => {
      const dash = await getDashboard(dashboardId, { orgId: orgId ?? undefined });
      if (!dash.ok) {
        return { kind: "err" as const, error: `Could not read dashboard: ${dash.reason}` };
      }
      // Draft view overlay when the flag is on AND a draft exists for
      // this user — the agent's mental model of "what cards exist" has
      // to match what the user sees in the chat-bound editor pane.
      let view = dash.data;
      if (isDashboardDraftsEnabled() && ctx.userId) {
        const draftRow = await forkOrLoadDraft(ctx.userId, dash.data);
        if (draftRow) {
          view = materializeDraftView(dash.data, draftRow.snapshot);
        }
      }
      return {
        kind: "ok" as const,
        dashboard: {
          id: view.id,
          title: view.title,
          description: view.description,
          cardCount: view.cards.length,
        },
        summary: buildCardSummary(view.cards),
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
        // Drafts path: when on, mint a UUID for the new card and stage
        // it in the draft snapshot rather than INSERTing into
        // dashboard_cards. The id flows back to the agent so subsequent
        // updateCard / updateLayout calls in the same session resolve.
        const draftCard: DashboardSnapshotCard = {
          id: crypto.randomUUID(),
          // Position is recomputed at publish time when the merge runs;
          // for the in-progress draft, append at the end of the current
          // snapshot. The agent doesn't care about exact positions in
          // an editing session — only at view + publish time.
          position: 0,
          title,
          sql,
          chartConfig,
          connectionGroupId: null,
          layout: layout ?? null,
        };
        const routed = await maybeApplyToDraft(ctx, { kind: "addCard", card: draftCard });
        if (routed.routed) {
          if (!routed.ok) return { kind: "err" as const, error: routed.error };
          return {
            kind: "ok" as const,
            card: {
              id: draftCard.id,
              title: draftCard.title,
              chartType: draftCard.chartConfig?.type ?? "table",
              position: draftCard.position,
            },
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

        const routed = await maybeApplyToDraft(ctx, {
          kind: "updateCard",
          cardId,
          updates,
        });
        if (routed.routed) {
          if (!routed.ok) return { kind: "err" as const, error: routed.error };
          return { kind: "ok" as const, cardId, updated: Object.keys(updates) };
        }

        const result = await updateCard(cardId, dashboardId, updates);
        if (!result.ok) {
          return { kind: "err" as const, error: `Could not update card ${cardId}: ${result.reason}` };
        }
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
      // Validate every layout entry first — if any is malformed, surface
      // before touching state. This matches the legacy per-row loop's
      // per-card validation but as a single pre-pass so the draft path
      // can apply the whole batch atomically (the versioning module's
      // `updateLayout` change is all-or-nothing).
      const parsed: { cardId: string; layout: DashboardCardLayout }[] = [];
      const malformed: { cardId: string; reason: string }[] = [];
      for (const placement of layouts) {
        const { cardId, x, y, w, h } = placement;
        const v = CardLayoutSchema.safeParse({ x, y, w, h });
        if (!v.success) {
          malformed.push({ cardId, reason: v.error.issues[0]?.message ?? "invalid layout" });
          continue;
        }
        parsed.push({ cardId, layout: v.data });
      }

      const routed = await maybeApplyToDraft(ctx, {
        kind: "updateLayout",
        layouts: parsed,
      });
      if (routed.routed) {
        if (!routed.ok) {
          const errResults = [
            ...malformed.map((m) => ({ cardId: m.cardId, ok: false as const, reason: m.reason })),
            { cardId: "(draft)", ok: false as const, reason: routed.error },
          ];
          return { kind: "partial" as const, results: errResults, failedCount: errResults.length };
        }
        const okResults = parsed.map((p) => ({ cardId: p.cardId, ok: true as const }));
        if (malformed.length > 0) {
          return {
            kind: "partial" as const,
            results: [
              ...okResults,
              ...malformed.map((m) => ({ cardId: m.cardId, ok: false as const, reason: m.reason })),
            ],
            failedCount: malformed.length,
          };
        }
        return { kind: "ok" as const, results: okResults };
      }

      // Legacy path — per-row updateCard.
      const results: { cardId: string; ok: boolean; reason?: string }[] = malformed.map((m) => ({
        cardId: m.cardId,
        ok: false,
        reason: m.reason,
      }));
      for (const placement of parsed) {
        const r = await updateCard(placement.cardId, dashboardId, { layout: placement.layout });
        results.push(r.ok ? { cardId: placement.cardId, ok: true } : { cardId: placement.cardId, ok: false, reason: r.reason });
      }
      const failed = results.filter((r) => !r.ok);
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

      const routed = await maybeApplyToDraft(ctx, {
        kind: "updateMeta",
        ...(updates.title !== undefined && { title: updates.title }),
        ...(updates.description !== undefined && { description: updates.description }),
      });
      if (routed.routed) {
        if (!routed.ok) return { kind: "err" as const, error: routed.error };
        return { kind: "ok" as const, updated: Object.keys(updates) };
      }

      const result = await updateDashboard(dashboardId, { orgId: orgId ?? undefined }, updates);
      if (!result.ok) {
        return { kind: "err" as const, error: `Could not update dashboard: ${result.reason}` };
      }
      return { kind: "ok" as const, updated: Object.keys(updates) };
    },
  });

  return {
    getDashboardState,
    getCardDetail,
    addCard: addCardTool,
    updateCard: updateCardTool,
    updateLayout: updateLayoutTool,
    updateDashboardMeta: updateDashboardMetaTool,
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
};
