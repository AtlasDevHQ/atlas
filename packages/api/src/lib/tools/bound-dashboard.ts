/**
 * Bound dashboard editor tools (#2363, #2365 destructive ops).
 *
 * Eight tools the bound agent gets when the chat is opened on a
 * dashboard. The factory function `createBoundDashboardTools` closes the
 * tools over the dashboardId + orgId resolved from the conversation's
 * `bound_dashboard_id` — the LLM cannot supply the dashboard id itself,
 * which is the whole point of binding (a turn cannot redirect mutations
 * at a different dashboard than the one the user opened).
 *
 * The six SAFE-op tools (`getDashboardState`, `getCardDetail`, `addCard`,
 * `updateCard`, `updateLayout`, `updateDashboardMeta`) commit immediately
 * (to the user's draft when `ATLAS_DASHBOARD_DRAFTS_ENABLED=true`, else
 * straight to published). The two NEW destructive tools (`removeCard` and
 * `updateCardSql`, added in #2365) do NOT mutate. They write a row to
 * `dashboard_stage_changes` and return a `stage_required` envelope; the
 * UI surfaces inline Accept / Discard affordances that hit the
 * `/dashboards/[id]/stage/[stageId]/accept|discard` routes.
 */

import * as crypto from "crypto";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { dashboardChartConfigSchema } from "@useatlas/schemas";
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
import type { DashboardCardKind, DashboardCardLayout } from "@atlas/api/lib/dashboard-types";
import { buildCardSummary } from "@atlas/api/lib/bound-chat-context";
import {
  screenshotDashboard,
  invalidateDashboardScreenshot,
} from "@atlas/api/lib/dashboard-screenshot";
import {
  isDashboardDraftsEnabled,
  forkOrLoadDraft,
  saveDraft,
  applyChangeToDraft,
  materializeDraftView,
  type DashboardSnapshotCard,
} from "@atlas/api/lib/dashboard-versioning";
import { stageChange } from "@atlas/api/lib/stage-tracker";

const log = createLogger("tool:bound-dashboard");

/** Shared chart/table/KPI config (#3137) — carries the optional `kpi` block so
 *  the bound editor's addCard doesn't strip it on the way to the draft. */
const ChartConfigSchema = dashboardChartConfigSchema;

export interface BoundDashboardToolContext {
  dashboardId: string;
  orgId: string | null | undefined;
  /**
   * Bound editor's user id. Two consumers:
   *
   *   1. Drafts foundation (#2364). When `ATLAS_DASHBOARD_DRAFTS_ENABLED=true`
   *      AND a userId is present, mutating tools route through the user's
   *      draft (forking from published on first touch). When unset OR the
   *      flag is off, mutations fall through to the legacy direct-published
   *      path — preserves #2363 behavior for anonymous + flag-off cases.
   *   2. Screenshot tool (#2367). Used as part of the screenshot cache key
   *      so user A's draft view can never leak to user B. The tool refuses
   *      to render when userId is null.
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
  const { dashboardId, orgId, userId, cookieHeader } = ctx;

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
    description: `Add a new card to the dashboard. Validates the SQL against the analytics datasource before persisting; if validation fails the card is NOT added and the error is returned so you can fix it and retry. Use AFTER \`executeSQL\` has confirmed the column names — \`chartConfig.categoryColumn\` and \`valueColumns\` must match the SQL output. The grid is 24 columns wide. Layout is optional — when omitted the card stages with no placement and the grid renderer auto-arranges it at view time. Pass a layout if you want a specific {x, y, w, h} on the 24-column grid.`,
    inputSchema: z.object({
      title: z.string().min(1).max(200).describe("Card title (visible to the user)"),
      sql: z.string().min(1).describe("Read-only SELECT query"),
      chartConfig: ChartConfigSchema.describe("Chart type + column mapping"),
      layout: CardLayoutSchema.optional().describe("Optional grid placement {x, y, w, h}"),
    }),
    execute: async ({ title, sql, chartConfig, layout }) => {
      try {
        // #3137 — a KPI card's comparisonSql runs through the SAME guard at
        // render time; validate it up front alongside the primary so the bound
        // editor rejects a bad comparison query the same way createDashboard
        // does (rather than silently degrading to a missing delta later). Both
        // validations run together — no waterfall.
        const comparisonSql = chartConfig.kpi?.comparisonSql;
        const [validation, comparisonValidation] = await Promise.all([
          validateSQL(sql, undefined),
          comparisonSql ? validateSQL(comparisonSql, undefined) : Promise.resolve(null),
        ]);
        if (!validation.valid) {
          return {
            kind: "err" as const,
            error: `SQL validation failed: ${validation.error}. Fix the query and retry.`,
          };
        }
        if (comparisonValidation && !comparisonValidation.valid) {
          return {
            kind: "err" as const,
            error: `KPI comparison SQL validation failed: ${comparisonValidation.error}. Fix the query and retry.`,
          };
        }
        // Drafts path: when on, mint a UUID for the new card and stage
        // it in the draft snapshot rather than INSERTing into
        // dashboard_cards. The id flows back to the agent so subsequent
        // updateCard / updateLayout calls in the same session resolve.
        const draftCard: DashboardSnapshotCard = {
          id: crypto.randomUUID(),
          // Position is left at 0 for the in-progress draft; the
          // dashboard renderer's auto-layout (`withAutoLayout`)
          // assigns a tile placement at view time, and the publish
          // path inserts the row with the post-merge position. The
          // agent should call `updateLayout` if it wants a specific
          // placement; the chat surface doesn't need positions to
          // disambiguate cards (the bound prompt's card summary uses
          // ids).
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
          // #2367 — user's draft view shifted, drop cached screenshots.
          invalidateDashboardScreenshot(dashboardId);
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

        // #3138: a text / section-block card has no chart. Reject a chartConfig
        // change on one rather than mutate the draft into a state publish would
        // silently discard (text-card equality ignores chartConfig). Title /
        // layout / position edits remain valid for text cards.
        if (updates.chartConfig !== undefined) {
          const current = await readCurrentCard(cardId);
          if (current.ok && current.kind === "text") {
            return {
              kind: "err" as const,
              error: `Card ${cardId} is a text / section card — it has no chart to configure.`,
            };
          }
          // #3137 — validate a new/changed KPI comparisonSql through the same
          // guard before persisting (parity with addCard / createDashboard).
          const comparisonSql = updates.chartConfig?.kpi?.comparisonSql;
          if (comparisonSql) {
            const comparisonValidation = await validateSQL(comparisonSql, undefined);
            if (!comparisonValidation.valid) {
              return {
                kind: "err" as const,
                error: `KPI comparison SQL validation failed: ${comparisonValidation.error}. Fix the query and retry.`,
              };
            }
          }
        }

        const routed = await maybeApplyToDraft(ctx, {
          kind: "updateCard",
          cardId,
          updates,
        });
        if (routed.routed) {
          if (!routed.ok) return { kind: "err" as const, error: routed.error };
          // #2367 — user's draft view shifted, drop cached screenshots.
          invalidateDashboardScreenshot(dashboardId);
          return { kind: "ok" as const, cardId, updated: Object.keys(updates) };
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
        // #2367 — any draft placement shifted the view, drop cached screenshots.
        if (parsed.length > 0) invalidateDashboardScreenshot(dashboardId);
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

      const routed = await maybeApplyToDraft(ctx, {
        kind: "updateMeta",
        ...(updates.title !== undefined && { title: updates.title }),
        ...(updates.description !== undefined && { description: updates.description }),
      });
      if (routed.routed) {
        if (!routed.ok) return { kind: "err" as const, error: routed.error };
        // #2367 — user's draft view shifted, drop cached screenshots.
        invalidateDashboardScreenshot(dashboardId);
        return { kind: "ok" as const, updated: Object.keys(updates) };
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

  // -------------------------------------------------------------------------
  // Destructive ops (#2365) — stage rather than mutate. Both tools return
  // `stage_required` envelopes the UI surfaces as inline ghost overlays.
  // The agent NEVER sees a direct mutation result for these — accept /
  // discard is the user's call.
  // -------------------------------------------------------------------------

  /**
   * Read the current card by id, preferring the draft view when drafts
   * are enabled + a userId is present. Used by the destructive tools to
   * snapshot `currentTitle` / `currentSql` into the stage payload so the
   * UI diff overlay doesn't drift if the card mutates between stage and
   * accept.
   */
  async function readCurrentCard(cardId: string): Promise<
    | { ok: true; title: string; sql: string; kind: DashboardCardKind }
    | { ok: false; error: string }
  > {
    if (isDashboardDraftsEnabled() && ctx.userId) {
      const dash = await getDashboard(dashboardId, { orgId: orgId ?? undefined });
      if (!dash.ok) {
        return { ok: false, error: `Could not read dashboard: ${dash.reason}` };
      }
      const draftRow = await forkOrLoadDraft(ctx.userId, dash.data);
      if (draftRow) {
        const sc = draftRow.snapshot.cards.find((c) => c.id === cardId);
        // #3138: snapshot cards have no stored `kind` — derive it from content.
        if (sc) return { ok: true, title: sc.title, sql: sc.sql, kind: sc.content != null ? "text" : "chart" };
        return { ok: false, error: `Card ${cardId} not found on this dashboard.` };
      }
    }
    const card = await getCard(cardId, dashboardId);
    if (!card.ok) {
      return { ok: false, error: `Could not read card ${cardId}: ${card.reason}` };
    }
    return { ok: true, title: card.data.title, sql: card.data.sql, kind: card.data.kind };
  }

  const removeCardTool = tool({
    description: `Stage removal of a card from the dashboard. This is a DESTRUCTIVE operation — it does NOT mutate immediately. Instead it queues a ghost change the user accepts or discards inline. Use this when the user asks to delete / remove / drop a card. The dashboard view renders the targeted card with a strikethrough overlay until the user resolves the stage.

Returns a \`stage_required\` envelope with the stage id; the chat UI renders Accept / Discard affordances alongside your message. Do NOT call \`removeCard\` and then try to verify the card is gone via \`getDashboardState\` in the same turn — the stage is still pending until the user acts.`,
    inputSchema: z.object({
      cardId: z.string().min(1).describe("Card id (from the compact summary)"),
    }),
    execute: async ({ cardId }) => {
      try {
        if (!ctx.userId) {
          return {
            kind: "err" as const,
            error: "removeCard requires an authenticated user — stages are per-user.",
          };
        }
        const current = await readCurrentCard(cardId);
        if (!current.ok) {
          return { kind: "err" as const, error: current.error };
        }
        const result = await stageChange({
          dashboardId,
          userId: ctx.userId,
          payload: { kind: "remove_card", cardId },
        });
        if (!result.ok) {
          return {
            kind: "err" as const,
            error:
              result.reason === "no_db"
                ? "Stage tracker requires an internal database."
                : "Could not queue the stage. Try again.",
          };
        }
        return {
          kind: "stage_required" as const,
          stageId: result.stage.id,
          stageKind: "remove_card" as const,
          target: { cardId, currentTitle: current.title },
        };
      } catch (err) {
        log.warn(
          { err: errorMessage(err), dashboardId, cardId },
          "removeCard tool failed unexpectedly",
        );
        return {
          kind: "err" as const,
          error: "removeCard failed unexpectedly. Try again.",
        };
      }
    },
  });

  const updateCardSqlTool = tool({
    description: `Stage a SQL rewrite for a card. This is a DESTRUCTIVE operation — it does NOT mutate immediately. Instead it queues a ghost change with a side-by-side SQL diff overlay the user accepts or discards inline. Use this when the user asks to change a card's query or rewrite its SQL.

ALWAYS:
1. Call \`getCardDetail(cardId)\` first to read the current SQL.
2. Call \`executeSQL\` on the proposed new SQL to verify shape + correctness.
3. Then call \`updateCardSql(cardId, newSql)\` with the validated query.

The tool validates the new SQL against the analytics datasource before staging; if validation fails the stage is NOT created and the error is returned so you can fix it and retry. Returns a \`stage_required\` envelope; the chat UI renders the diff + Accept / Discard.`,
    inputSchema: z.object({
      cardId: z.string().min(1).describe("Card id (from the compact summary)"),
      newSql: z.string().min(1).describe("Proposed replacement SELECT query"),
    }),
    execute: async ({ cardId, newSql }) => {
      try {
        if (!ctx.userId) {
          return {
            kind: "err" as const,
            error: "updateCardSql requires an authenticated user — stages are per-user.",
          };
        }
        const validation = await validateSQL(newSql, undefined);
        if (!validation.valid) {
          return {
            kind: "err" as const,
            error: `SQL validation failed: ${validation.error}. Fix the query and retry.`,
          };
        }
        const current = await readCurrentCard(cardId);
        if (!current.ok) {
          return { kind: "err" as const, error: current.error };
        }
        // #3138: a text / section-block card has no SQL. Reject rather than
        // stage an edit_sql change that publish would silently discard (a text
        // card's draft↔baseline equality ignores sql). To change a header, edit
        // its markdown / remove + re-add.
        if (current.kind === "text") {
          return {
            kind: "err" as const,
            error: `Card ${cardId} is a text / section card — it has no SQL to edit.`,
          };
        }
        const result = await stageChange({
          dashboardId,
          userId: ctx.userId,
          payload: {
            kind: "edit_sql",
            cardId,
            newSql,
            currentSql: current.sql,
          },
        });
        if (!result.ok) {
          return {
            kind: "err" as const,
            error:
              result.reason === "no_db"
                ? "Stage tracker requires an internal database."
                : "Could not queue the stage. Try again.",
          };
        }
        return {
          kind: "stage_required" as const,
          stageId: result.stage.id,
          stageKind: "edit_sql" as const,
          target: {
            cardId,
            currentTitle: current.title,
            currentSql: current.sql,
            newSql,
          },
        };
      } catch (err) {
        log.warn(
          { err: errorMessage(err), dashboardId, cardId },
          "updateCardSql tool failed unexpectedly",
        );
        return {
          kind: "err" as const,
          error: "updateCardSql failed unexpectedly. Try again.",
        };
      }
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
    removeCard: removeCardTool,
    updateCardSql: updateCardSqlTool,
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

  removeCard: `### Stage card removal (destructive — requires user accept)
Use \`removeCard(cardId)\` when the user asks to delete / remove / drop a card. This does NOT mutate immediately — it queues a ghost change the user accepts or discards inline. The dashboard renders the staged card with a strikethrough overlay. After calling \`removeCard\`, surface a short confirmation to the user ("Staged removal of <title> — accept to confirm or discard to keep it"). Do NOT loop back to \`getDashboardState\` to verify removal in the same turn; the stage is still pending until the user resolves it.`,

  updateCardSql: `### Stage a SQL rewrite (destructive — requires user accept)
Use \`updateCardSql(cardId, newSql)\` when the user asks to change a card's query. This does NOT mutate immediately — it queues a ghost change with a side-by-side SQL diff overlay the user accepts or discards inline.

ALWAYS:
1. Call \`getCardDetail(cardId)\` first to read the current SQL.
2. Call \`executeSQL\` on the new SQL to verify shape + correctness against the analytics datasource.
3. Then call \`updateCardSql\` with the validated query.

The tool re-validates the SQL before staging; invalid queries are rejected without queueing.`,
};
