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
 * to the caller's private draft (unconditional as of #4324; a mutating tool
 * with no userId is rejected — an unattributable edit never touches
 * published). The two destructive tools (`removeCard` and `updateCardSql`)
 * now land in the caller's draft through the SAME apply path as every other
 * edit (ADR-0034 Decision 2, #4555 — reverses the #2365 stage tracker): no
 * staging, no accept/discard step. Each returns a lightweight inline-undo
 * envelope (`removed` / `sql_updated`) carrying the inverse draft edit; the
 * UI surfaces an Undo affordance that POSTs the inverse to
 * `/dashboards/[id]/draft/undo`. Nothing reads or writes
 * `dashboard_stage_changes` anymore — the draft is the single edit
 * mechanism; the table itself was dropped in migration 0176 (#4561,
 * phase 2 of the two-phase drop).
 */

import * as crypto from "crypto";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import {
  dashboardChartConfigSchema,
  dashboardCardAnnotationsSchema,
  dashboardCardInputSchema,
  dashboardTextCardContentSchema,
} from "@useatlas/schemas";
import { createLogger } from "@atlas/api/lib/logger";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { validateSQL } from "@atlas/api/lib/tools/sql";
import { deriveTextCardTitle } from "@atlas/api/lib/dashboard-text-card";
import {
  validateAutoComparison,
  resolveDashboardParameterValues,
} from "@atlas/api/lib/dashboard-parameters";
import {
  getCard,
  getDashboard,
  resolveCardConnectionId,
  NoGroupMembersError,
  TextCardLayoutSchema,
} from "@atlas/api/lib/dashboards";
import type { DashboardWithCards } from "@atlas/api/lib/dashboard-types";
import { seedDraftCards, type CardSeedOutcome } from "@atlas/api/lib/dashboard-seeding";
import type { DashboardCard, DashboardCardKind, DashboardCardLayout } from "@atlas/api/lib/dashboard-types";
import { buildCardSummary } from "@atlas/api/lib/bound-chat-context";
import {
  screenshotDashboard,
  invalidateDashboardScreenshot,
} from "@atlas/api/lib/dashboard-screenshot";
import {
  forkOrLoadDraft,
  saveDraft,
  applyChangeToDraft,
  materializeDraftView,
  type DashboardSnapshotCard,
} from "@atlas/api/lib/dashboard-versioning";
import {
  loadDraftCardCache,
  EMPTY_DRAFT_CARD_CACHE,
} from "@atlas/api/lib/dashboard-draft-cache";

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
   *   1. Drafts foundation (#2364, unconditional as of #4324). When a userId
   *      is present, mutating tools route through the user's draft (forking
   *      from published on first touch). When unset, a mutating tool is
   *      REJECTED — an unattributable bound edit must never write to the
   *      published dashboard (the closed ADR-0029 privacy hole, #4315).
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
  /**
   * #4322 — the conversation's content scope (its `connection_group_id`,
   * resolved by the chat route). A card `addCard` mints inherits this so
   * a card added inside a chat that was scoped to (say) the "prod" group
   * queries that group's database — not the workspace `default`. Without
   * it the draft card stamps `connectionGroupId: null` and the tile later
   * resolves against the default datasource, the exact bug this closes
   * (mirrors `createDashboard`'s `conversationGroupId` handling). `null`
   * for an unscoped conversation (legacy 1×1 workspaces).
   */
  connectionGroupId?: string | null;
}

/**
 * Apply a mutating change to the caller's draft snapshot. Drafts are
 * UNCONDITIONAL (#4324) — every mutating bound-editor tool routes here; there
 * is no legacy direct-published path left. Returns:
 *   - `{ ok: true }`  → draft updated.
 *   - `{ ok: false, error }` → the op failed OR was refused; surface the error.
 *     #4315: the no-userId case is a REJECTION — an unattributable bound edit
 *     must never write to the published dashboard (the closed ADR-0029 privacy
 *     hole).
 */
async function maybeApplyToDraft(
  ctx: BoundDashboardToolContext,
  change: import("@atlas/api/lib/dashboard-versioning").DraftChange,
): Promise<{ ok: true; dashboard: DashboardWithCards } | { ok: false; error: string }> {
  // #4315 — close the anonymous-bound bypass. An edit that can't be attributed
  // to a user can't land in a private draft, so we REJECT rather than write to
  // published (there is no direct-published fall-through anymore, #4324).
  if (!ctx.userId) {
    return {
      ok: false,
      error:
        "This edit can't be saved: dashboard edits land in your private draft, which requires a signed-in user. Sign in and retry — edits never write to the published dashboard.",
    };
  }
  const published = await getDashboard(ctx.dashboardId, {
    orgId: ctx.orgId ?? undefined,
    // #4320 — first-publish gate; the bound board is already gated at bind, this
    // keeps the tool read consistent (owner of a never-published board matches).
    viewerId: ctx.userId ?? undefined,
  });
  if (!published.ok) {
    return { ok: false, error: `Could not read dashboard: ${published.reason}` };
  }
  const draftRow = await forkOrLoadDraft(ctx.userId, published.data);
  if (!draftRow) {
    return {
      ok: false,
      error: "Could not load or create a draft for this dashboard. Internal DB unavailable.",
    };
  }
  const applied = applyChangeToDraft(draftRow.snapshot, change);
  if (!applied.ok) {
    return {
      ok: false,
      error: `Could not apply change to draft: ${applied.reason} (cardId=${applied.cardId})`,
    };
  }
  const saved = await saveDraft(ctx.userId, ctx.dashboardId, applied.snapshot);
  if (!saved) {
    return { ok: false, error: "Could not persist draft update." };
  }
  // Return the dashboard the fork read consumed so a caller that immediately
  // seeds the new card (#4558 `addCard`) reuses it — its `orgId` (to scope
  // connection resolution) + parameter defaults — instead of a second
  // getDashboard round-trip.
  return { ok: true, dashboard: published.data };
}

/**
 * Seed a single card `addCard` just staged into the draft (#4558, ADR-0034
 * Decision 1) — the bound-editor twin of `createDashboard`'s batch seeding.
 * Executes the card once through the full SQL pipeline and caches the result as
 * the card's draft data, returning a per-card outcome. NEVER throws: `addCard`
 * has already succeeded (the card is staged), so a seeding fault degrades to
 * `unseeded` (the canvas-mount render fills it in) rather than turning a
 * committed add into an error.
 */
async function seedAddedCard(
  ctx: BoundDashboardToolContext,
  cardId: string,
  title: string,
  sql: string,
  dashboard: DashboardWithCards,
): Promise<CardSeedOutcome> {
  const unseeded: CardSeedOutcome = { cardId, title, status: "unseeded" };
  // Unattributed edits never reach here (maybeApplyToDraft rejects a missing
  // userId first), but guard so seeding can't run without a draft owner.
  if (!ctx.userId) return unseeded;
  try {
    let connectionId: string | null;
    try {
      connectionId = await resolveCardConnectionId(
        { connectionGroupId: ctx.connectionGroupId ?? null },
        dashboard.orgId,
      );
    } catch (err) {
      // A group with zero members can't be seeded (the same fault a refresh
      // would hit) — leave the card staged-unseeded rather than failing.
      if (err instanceof NoGroupMembersError) {
        log.warn(
          { groupId: err.groupId, dashboardId: ctx.dashboardId, cardId },
          "addCard seeding: card's connection group has no members",
        );
        return unseeded;
      }
      throw err;
    }

    const parameters = resolveDashboardParameterValues(dashboard.parameters, undefined);
    const [outcome] = await seedDraftCards({
      userId: ctx.userId,
      dashboardId: ctx.dashboardId,
      cards: [{ cardId, title, sql, connectionId }],
      parameters,
    });
    return outcome ?? unseeded;
  } catch (err) {
    log.warn(
      { err: errorMessage(err), dashboardId: ctx.dashboardId, cardId },
      "addCard seeding failed — card left for canvas-mount render",
    );
    return unseeded;
  }
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

  // #4566 — the screenshot's base64 PNG must never ride in the tool result's
  // JSON envelope (audit L11): that envelope is streamed to the client and
  // persisted in the message history, so a ~1-2 MB image string bloats every
  // subsequent turn and leaks bytes the UI has no use for. Instead, `execute`
  // stashes the bytes in this per-request closure map under a short nonce and
  // returns only the nonce; `toModelOutput` (which runs in-process, same
  // closure, right after execute) reads and deletes them to assemble the real
  // multimodal image part. The wire envelope carries metadata only — the strip
  // is structural, not a prompt instruction.
  const screenshotPayloads = new Map<string, { data: string; mediaType: string }>();

  const getDashboardState = tool({
    description: `Read the current state of the dashboard you are editing. Returns the title, description, and a compact summary of every card (id, title, chart type, position, layout). Call this when you need a fresh read after several mutations. Card SQL is NOT returned — use \`getCardDetail\` for that.`,
    inputSchema: z.object({}).describe("No arguments"),
    execute: async () => {
      const dash = await getDashboard(dashboardId, { orgId: orgId ?? undefined, viewerId: userId ?? undefined });
      if (!dash.ok) {
        return { kind: "err" as const, error: `Could not read dashboard: ${dash.reason}` };
      }
      // Draft view overlay when a draft exists for this user — the agent's
      // mental model of "what cards exist" has to match what the user sees in
      // the chat-bound editor pane.
      let view = dash.data;
      if (ctx.userId) {
        const draftRow = await forkOrLoadDraft(ctx.userId, dash.data);
        if (draftRow) {
          // The compact summary carries no cached data (id/title/type/layout
          // only), so the draft-cache read is skipped (#4554).
          view = materializeDraftView(dash.data, draftRow.snapshot, EMPTY_DRAFT_CARD_CACHE);
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
      // Draft view overlay (same as getDashboardState): when the user has a
      // draft, a card's CURRENT state lives in the draft
      // snapshot, not the published row. This matters most for `annotations` —
      // it's REPLACE-ALL on updateCard, so returning the published markers here
      // would let the agent fetch a stale set and drop staged ones when it
      // sends back a "merged" array.
      const dash = await getDashboard(dashboardId, { orgId: orgId ?? undefined, viewerId: userId ?? undefined });
      if (!dash.ok) {
        return { kind: "err" as const, error: `Could not read dashboard: ${dash.reason}` };
      }
      let card: DashboardCard | undefined;
      if (ctx.userId) {
        const draftRow = await forkOrLoadDraft(ctx.userId, dash.data);
        if (draftRow) {
          // This detail read returns `cachedColumns`, so materialize with the
          // caller's DRAFT cache — the data home for a draft card (#4554).
          const draftCache = await loadDraftCardCache(ctx.userId, dashboardId);
          card = materializeDraftView(dash.data, draftRow.snapshot, draftCache).cards.find((c) => c.id === cardId);
        }
      }
      card ??= dash.data.cards.find((c) => c.id === cardId);
      if (!card) {
        return { kind: "err" as const, error: `Could not read card ${cardId}: not_found` };
      }
      return {
        kind: "ok" as const,
        card: {
          id: card.id,
          title: card.title,
          sql: card.sql,
          chartConfig: card.chartConfig,
          // #3209 — annotations is a REPLACE-ALL field on updateCard, so the
          // agent must see the current (draft) markers here to add/rename one
          // without dropping the rest.
          annotations: card.annotations,
          layout: card.layout,
          position: card.position,
          cachedColumns: card.cachedColumns,
        },
      };
    },
  });

  const addCardTool = tool({
    description: `Add a new card to the dashboard — a SQL-backed chart card or a markdown text / section card.

CHART CARD ({ title, sql, chartConfig }): validates the SQL against the analytics datasource before persisting; if validation fails the card is NOT added and the error is returned so you can fix it and retry. Use AFTER \`executeSQL\` has confirmed the column names — \`chartConfig.categoryColumn\` and \`valueColumns\` must match the SQL output. On success the result includes \`seed\` — the card's data outcome: \`rows\` (with a rowCount), \`empty\` (the query ran but returned nothing), \`error\` (the card WAS added but its query failed — \`message\` says why), or \`unseeded\` (added; data loads when the dashboard opens). If \`seed\` is \`empty\` or \`error\`, say so plainly and offer to fix it rather than claiming the card shows data.

TEXT / SECTION CARD ({ kind: "text", content: "## ..." }): a markdown header / explainer that organizes the grid — no SQL, no chart, no data. Use it to group related charts under a heading ("Top of funnel", "Cohorts"): add a full-width text card (w: 24) above a cluster of charts. Keep content short — a heading and at most a sentence. A text card is never seeded (nothing to run), so its result carries no \`seed\`.

The grid is 24 columns wide. Layout is optional — when omitted the card stages with no placement and the grid renderer auto-arranges it at view time. Pass a layout if you want a specific {x, y, w, h}.`,
    inputSchema: z.object({
      // #4562 — the shared card-input union (chart | text, + layout), declared
      // once in @useatlas/schemas and consumed verbatim by createDashboard too.
      // Nested under `card` (not a root union) so the tool's JSON schema keeps a
      // `type: object` root, which the Anthropic tool-calling API requires.
      card: dashboardCardInputSchema.describe(
        'The card to add — a chart card { title, sql, chartConfig, layout? } or a text / section card { kind: "text", content, layout? }.',
      ),
    }),
    execute: async ({ card }) => {
      try {
        // ---- text / section card (#4562) — no SQL, no chart, never seeded ----
        // A text card fetches no data, so it skips SQL validation and seeding
        // entirely; it stages with `sql: ""`, `chartConfig: null`, its markdown
        // in `content`, and no connection group (it never queries).
        if (card.kind === "text") {
          const textDraftCard: DashboardSnapshotCard = {
            id: crypto.randomUUID(),
            position: 0,
            title: card.title?.trim() || deriveTextCardTitle(card.content),
            sql: "",
            chartConfig: null,
            content: card.content,
            annotations: [],
            connectionGroupId: null,
            layout: card.layout ?? null,
          };
          const appliedText = await maybeApplyToDraft(ctx, { kind: "addCard", card: textDraftCard });
          if (!appliedText.ok) return { kind: "err" as const, error: appliedText.error };
          // #2367 — user's draft view shifted, drop cached screenshots.
          invalidateDashboardScreenshot(dashboardId);
          return {
            kind: "ok" as const,
            card: {
              id: textDraftCard.id,
              title: textDraftCard.title,
              chartType: "text" as const,
              position: textDraftCard.position,
            },
          };
        }

        // ---- chart card (behavior unchanged) ----
        const { title, sql, chartConfig, annotations, layout } = card;
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
        // #3207 — an autoComparison card must filter by both window params, or
        // the prior-period shift is a no-op. (Date-typing of the params is
        // enforced where the dashboard's parameter defs are loaded — the REST
        // routes + createDashboard; here we have the card SQL only.)
        const addAutoErr = validateAutoComparison(sql, chartConfig.kpi);
        if (addAutoErr) {
          return { kind: "err" as const, error: addAutoErr };
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
          annotations: annotations ?? [],
          // #4322 — inherit the conversation's content scope so the added
          // card queries the right database. `createDashboard` already does
          // this for its initial cards; a card added later via the bound
          // editor must land in the same group, not the workspace default.
          connectionGroupId: ctx.connectionGroupId ?? null,
          layout: layout ?? null,
        };
        const applied = await maybeApplyToDraft(ctx, { kind: "addCard", card: draftCard });
        if (!applied.ok) return { kind: "err" as const, error: applied.error };
        // #2367 — user's draft view shifted, drop cached screenshots.
        invalidateDashboardScreenshot(dashboardId);
        // #4558 — the card is now staged in the draft; seed its draft cache so
        // the tile shows real data the moment the user looks, and report the
        // outcome (rows / empty / error / unseeded) so the agent self-corrects
        // instead of claiming a card works when its query returned nothing.
        const seed = await seedAddedCard(ctx, draftCard.id, title, sql, applied.dashboard);
        return {
          kind: "ok" as const,
          card: {
            id: draftCard.id,
            title: draftCard.title,
            chartType: draftCard.chartConfig?.type ?? "table",
            position: draftCard.position,
          },
          seed,
        };
      } catch (err) {
        log.warn({ err: errorMessage(err), dashboardId }, "addCard tool failed unexpectedly");
        return { kind: "err" as const, error: "addCard failed unexpectedly. Try again or simplify the proposal." };
      }
    },
  });

  const updateCardTool = tool({
    description: `Update a card's title, chart type, layout, event annotations, or a text / section card's markdown content. Pass only the fields you want to change. \`content\` edits a TEXT card's markdown ("change the Cohorts header to say ..."); \`chartConfig\` edits a CHART card — the two are mutually exclusive per card kind. Does NOT change a chart card's SQL — use \`updateCardSql\` for that.`,
    inputSchema: z.object({
      cardId: z.string().min(1).describe("Card id"),
      title: z.string().min(1).max(200).optional(),
      chartConfig: ChartConfigSchema.nullable().optional(),
      content: dashboardTextCardContentSchema
        .optional()
        .describe(
          'New markdown body for a TEXT / section card (e.g. "## Cohorts"). Only valid on a text card — rejected on a chart card. Rendered sanitized, no raw HTML.',
        ),
      annotations: dashboardCardAnnotationsSchema
        .optional()
        .describe(
          "Replace the card's dated event markers ({ x, label, color? }). Pass [] to clear them. Vertical reference lines on a line/area card.",
        ),
      // #4687 — the bound editor addresses cards by id (no kind on the tool
      // input), so this seam is kind-blind; floor at the absolute TEXT_MIN_H (2)
      // so a text / section card validates as a banner. The taller chart floor
      // (MIN_H, 4) is NOT enforced here — it's a kind-aware authoring/UI concern
      // (the create/add-card paths + the grid's resize `minH`); a chart set
      // short via this agent tool renders short (valid geometry), never lost.
      layout: TextCardLayoutSchema.nullable().optional(),
      position: z.number().int().min(0).optional(),
    }),
    execute: async ({ cardId, title, chartConfig, content, annotations, layout, position }) => {
      try {
        const updates: {
          title?: string;
          chartConfig?: z.infer<typeof ChartConfigSchema> | null;
          content?: string;
          annotations?: z.infer<typeof dashboardCardAnnotationsSchema>;
          layout?: DashboardCardLayout | null;
          position?: number;
        } = {};
        if (title !== undefined) updates.title = title;
        if (chartConfig !== undefined) updates.chartConfig = chartConfig;
        if (content !== undefined) updates.content = content;
        if (annotations !== undefined) updates.annotations = annotations;
        if (layout !== undefined) updates.layout = layout;
        if (position !== undefined) updates.position = position;

        if (Object.keys(updates).length === 0) {
          return { kind: "err" as const, error: "No fields supplied — pass at least one of title, chartConfig, content, annotations, layout, position." };
        }

        // #3138 / #4562 — chart config and text content are kind-specific: a
        // text / section card has no chart to configure, and a chart card has no
        // markdown body to edit. Reject a cross-kind edit rather than mutate the
        // draft into a state publish would silently discard (card equality
        // ignores the field that doesn't belong to the kind). Title / layout /
        // position / annotations edits remain valid for both kinds. Read the
        // current card once when either kind-specific field is being changed.
        if (updates.chartConfig !== undefined || updates.content !== undefined) {
          const current = await readCurrentCard(cardId);
          if (updates.content !== undefined) {
            // A `content` edit must land ONLY on a CONFIRMED text card: writing
            // content onto a chart card would flip its kind at publish (a card
            // with non-null content reads as text). If the card can't be read,
            // refuse rather than risk that cross-kind corruption — stricter than
            // the chartConfig guard below, which can proceed on an unread card
            // because a stray chartConfig on a text card is dropped at publish.
            if (!current.ok) {
              return { kind: "err" as const, error: current.error };
            }
            if (current.kind !== "text") {
              return {
                kind: "err" as const,
                error: `Card ${cardId} is a chart card — it has no text content to edit. Use chartConfig / annotations to change a chart.`,
              };
            }
          }
          if (updates.chartConfig !== undefined) {
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
            // #3207 — turning on autoComparison must agree with the card's
            // EXISTING sql (updateCard never changes the query): it has to filter
            // by both window params.
            if (updates.chartConfig?.kpi?.autoComparison && current.ok) {
              const updateAutoErr = validateAutoComparison(current.sql, updates.chartConfig.kpi);
              if (updateAutoErr) {
                return { kind: "err" as const, error: updateAutoErr };
              }
            }
          }
        }

        const applied = await maybeApplyToDraft(ctx, {
          kind: "updateCard",
          cardId,
          updates,
        });
        if (!applied.ok) return { kind: "err" as const, error: applied.error };
        // #2367 — user's draft view shifted, drop cached screenshots.
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
        // #4687 — kind-blind (cards addressed by id); floors at the absolute
        // TEXT_MIN_H (2) so a text / section card can be placed as a banner. The
        // chart floor (MIN_H, 4) is not enforced on this kind-blind agent seam;
        // a chart placed short renders short (valid geometry), never discarded.
        const v = TextCardLayoutSchema.safeParse({ x, y, w, h });
        if (!v.success) {
          malformed.push({ cardId, reason: v.error.issues[0]?.message ?? "invalid layout" });
          continue;
        }
        parsed.push({ cardId, layout: v.data });
      }

      const applied = await maybeApplyToDraft(ctx, {
        kind: "updateLayout",
        layouts: parsed,
      });
      if (!applied.ok) {
        const errResults = [
          ...malformed.map((m) => ({ cardId: m.cardId, ok: false as const, reason: m.reason })),
          { cardId: "(draft)", ok: false as const, reason: applied.error },
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

      const applied = await maybeApplyToDraft(ctx, {
        kind: "updateMeta",
        ...(updates.title !== undefined && { title: updates.title }),
        ...(updates.description !== undefined && { description: updates.description }),
      });
      if (!applied.ok) return { kind: "err" as const, error: applied.error };
      // #2367 — user's draft view shifted, drop cached screenshots.
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
      // #4566 — structurally keep the base64 PNG OUT of the JSON envelope.
      // Stash the bytes in the closure map under a nonce; the envelope carries
      // only the nonce (`screenshotRef`) + metadata. `toModelOutput` reads the
      // bytes back and attaches them as a real multimodal image part, so the
      // LLM still sees the image but the wire result never contains it.
      const mediaType = "image/png" as const;
      const screenshotRef = crypto.randomUUID();
      screenshotPayloads.set(screenshotRef, {
        data: result.png.toString("base64"),
        mediaType,
      });
      return {
        kind: "ok" as const,
        mediaType,
        sizeBytes: result.png.length,
        cached: result.cached,
        durationMs: result.durationMs,
        // Opaque handle the same-request `toModelOutput` resolves the image
        // bytes from. NOT the bytes themselves — those never enter the envelope.
        screenshotRef,
      };
    },
    toModelOutput: ({ output }) => {
      const typed = output as {
        kind: "ok" | "err";
        screenshotRef?: string;
        error?: string;
      };
      // A genuine screenshot failure — the tool already sanitized the message.
      if (typed.kind !== "ok") {
        return {
          type: "error-text",
          value: typed.error ?? "screenshotDashboard failed",
        };
      }
      const ref = typed.screenshotRef;
      const payload = ref ? screenshotPayloads.get(ref) : undefined;
      if (!ref || !payload) {
        // Success envelope, but the side-channel bytes are gone: a re-conversion
        // of a persisted result (fresh, empty map on a later request) or a
        // duplicate `toModelOutput` after the one-shot delete. Don't misreport a
        // successful screenshot as failed — log so the drop is debuggable and
        // give the model an actionable re-shoot instruction.
        log.warn(
          { dashboardId, screenshotRef: ref },
          "screenshot payload missing from side-channel — image dropped from model turn (#4566)",
        );
        return {
          type: "error-text",
          value:
            "The dashboard screenshot could not be attached this turn. Call screenshotDashboard again.",
        };
      }
      // One-shot: drop the bytes once assembled into the model turn so the
      // closure map can't accumulate images across a long bound session.
      screenshotPayloads.delete(ref);
      return {
        type: "content",
        value: [
          {
            type: "image-data",
            data: payload.data,
            mediaType: payload.mediaType,
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
  // Destructive ops (ADR-0034 Decision 2, #4555) — apply directly to the
  // caller's draft like every other edit, then return a lightweight inline
  // undo (the inverse draft edit). No staging, no accept/discard: the draft
  // is the single edit mechanism, and publish promotes the removal / SQL edit
  // with everything else. The agent sees the edit as done; the user can Undo.
  // -------------------------------------------------------------------------

  /**
   * Read the current card by id, preferring the draft view when a userId
   * is present. Used by `updateCardSql` (for the card's title + prior SQL, which
   * feed the response and the `revert_sql` undo payload) and by `updateCard`'s
   * kind-specific guard (to confirm a card is text vs chart before editing).
   */
  async function readCurrentCard(cardId: string): Promise<
    | { ok: true; title: string; sql: string; kind: DashboardCardKind }
    | { ok: false; error: string }
  > {
    if (ctx.userId) {
      const dash = await getDashboard(dashboardId, { orgId: orgId ?? undefined, viewerId: userId ?? undefined });
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

  /**
   * Read the FULL draft snapshot card by id (#4555). `removeCard` captures
   * this before dropping the card so its inline-undo can restore the card
   * verbatim — same id, SQL, chartConfig, layout, content, annotations, and
   * connection group. Requires a userId (removeCard already enforces it): the
   * fork guarantees the draft snapshot mirrors every published card, so a card
   * the user can see is always found here.
   */
  async function readCurrentSnapshotCard(cardId: string): Promise<
    | { ok: true; card: DashboardSnapshotCard }
    | { ok: false; error: string }
  > {
    if (!ctx.userId) {
      return { ok: false, error: "removeCard requires an authenticated user — edits are per-user." };
    }
    const dash = await getDashboard(dashboardId, { orgId: orgId ?? undefined, viewerId: userId ?? undefined });
    if (!dash.ok) {
      return { ok: false, error: `Could not read dashboard: ${dash.reason}` };
    }
    const draftRow = await forkOrLoadDraft(ctx.userId, dash.data);
    if (!draftRow) {
      return { ok: false, error: "Could not load or create a draft for this dashboard. Internal DB unavailable." };
    }
    const sc = draftRow.snapshot.cards.find((c) => c.id === cardId);
    if (!sc) {
      return { ok: false, error: `Card ${cardId} not found on this dashboard.` };
    }
    return { ok: true, card: sc };
  }

  const removeCardTool = tool({
    description: `Remove a card from the dashboard. This applies immediately to the caller's private draft — the card disappears from the canvas at once (publish later promotes the removal to the live board). Use this when the user asks to delete / remove / drop a card.

The result is a \`removed\` envelope; the chat UI shows a one-click Undo that restores the card in the draft. Say plainly that you removed the card (and that the user can undo). After removing, you MAY call \`getDashboardState\` in the same turn to confirm the new card set — the removal is already applied, not pending.`,
    inputSchema: z.object({
      cardId: z.string().min(1).describe("Card id (from the compact summary)"),
    }),
    execute: async ({ cardId }) => {
      try {
        if (!ctx.userId) {
          return {
            kind: "err" as const,
            error: "removeCard requires an authenticated user — edits are per-user.",
          };
        }
        // Capture the full card BEFORE dropping it so the inline undo can
        // restore it verbatim (same id → its lingering draft-cache rows are
        // revived on restore, so undo brings the data back too).
        const snapshot = await readCurrentSnapshotCard(cardId);
        if (!snapshot.ok) {
          return { kind: "err" as const, error: snapshot.error };
        }
        const applied = await maybeApplyToDraft(ctx, { kind: "removeCard", cardId });
        if (!applied.ok) return { kind: "err" as const, error: applied.error };
        // #2367 — the user's draft view shifted, drop cached screenshots.
        invalidateDashboardScreenshot(dashboardId);
        return {
          kind: "removed" as const,
          cardId,
          title: snapshot.card.title,
          // The inverse draft edit the UI POSTs to `/draft/undo` on Undo.
          undo: { kind: "restore_card" as const, card: snapshot.card },
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
    description: `Rewrite a card's SQL. This applies immediately to the caller's private draft — the card keeps its existing cached data until it next refreshes / re-renders against the new query (publish later promotes the edit to the live board). Use this when the user asks to change a card's query or rewrite its SQL.

ALWAYS:
1. Call \`getCardDetail(cardId)\` first to read the current SQL.
2. Call \`executeSQL\` on the proposed new SQL to verify shape + correctness.
3. Then call \`updateCardSql(cardId, newSql)\` with the validated query.

The tool validates the new SQL against the analytics datasource before applying; if validation fails the draft is NOT changed and the error is returned so you can fix it and retry. Returns a \`sql_updated\` envelope; the chat UI shows a one-click Undo that restores the prior SQL in the draft.`,
    inputSchema: z.object({
      cardId: z.string().min(1).describe("Card id (from the compact summary)"),
      newSql: z.string().min(1).describe("Proposed replacement SELECT query"),
    }),
    execute: async ({ cardId, newSql }) => {
      try {
        if (!ctx.userId) {
          return {
            kind: "err" as const,
            error: "updateCardSql requires an authenticated user — edits are per-user.",
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
        // apply an editSql change that publish would silently discard (a text
        // card's draft↔baseline equality ignores sql). To change a header, edit
        // its markdown / remove + re-add.
        if (current.kind === "text") {
          return {
            kind: "err" as const,
            error: `Card ${cardId} is a text / section card — it has no SQL to edit.`,
          };
        }
        const applied = await maybeApplyToDraft(ctx, { kind: "editSql", cardId, newSql });
        if (!applied.ok) return { kind: "err" as const, error: applied.error };
        // #2367 — the user's draft view shifted, drop cached screenshots.
        invalidateDashboardScreenshot(dashboardId);
        return {
          kind: "sql_updated" as const,
          cardId,
          title: current.title,
          previousSql: current.sql,
          newSql,
          // The inverse draft edit the UI POSTs to `/draft/undo` on Undo.
          undo: { kind: "revert_sql" as const, cardId, sql: current.sql },
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

  addCard: `### Add a card (chart or text / section)
Use \`addCard\` to create a new card — either a SQL-backed chart card or a markdown text / section header.

CHART card — always:
1. Call \`explore\` + \`executeSQL\` first to confirm the SQL shape and column names.
2. Build a chartConfig whose \`categoryColumn\` and \`valueColumns\` match the SQL output exactly.
3. Optionally specify a layout {x, y, w, h} in the 24-col grid.
The tool validates the SQL against the analytics datasource before persisting; if validation fails the card is NOT created.

TEXT / SECTION card — pass \`{ kind: "text", content: "## Cohorts" }\` (optionally a layout). It has no SQL or chart and fetches no data; use it to group related charts under a heading. Emit a full-width text card (w: 24) above each cluster of charts and keep the copy short.`,

  updateCard: `### Rename / re-chart / re-place a card, or edit a section header
Use \`updateCard\` to change a card's title, chartConfig, layout, position, or a text / section card's markdown \`content\`. Pass only the fields you want to change. \`content\` edits a TEXT card's markdown; \`chartConfig\` edits a CHART card — the two are per-kind and mutually exclusive. Does NOT change a chart card's SQL — use \`updateCardSql\` for that.`,

  updateLayout: `### Rearrange the grid
Use \`updateLayout\` to move multiple cards at once. Supply the layouts array with one entry per card you want to place. Cards not listed stay where they are. Grid is 24 columns wide; (x + w) must be <= 24.`,

  updateDashboardMeta: `### Rename the dashboard / edit its description
Use \`updateDashboardMeta\` to change the dashboard's title or description. Pass only the fields you want to change.`,

  screenshotDashboard: `### See the dashboard with your own eyes (vision)
Use \`screenshotDashboard()\` to capture the dashboard as the user currently sees it and feed the PNG back to you as a multimodal image. Call this when the user asks about **spatial position** ("what's on the bottom-right?", "is the trend on the top row?") or about **visual layout** ("does this feel balanced?"). The card summary in your system prompt has ids and positions but not pixels — pixels are what this tool gives you.

- The screenshot is cached on a per-(dashboard, user) basis and short-TTL (60s); calling twice in a row without mutating is free.
- Card mutations (\`addCard\`, \`updateCard\`, \`updateLayout\`, \`updateDashboardMeta\`) invalidate the cache automatically — you'll get a fresh shot on the next call.
- Don't echo the base64 payload back to the user. The shot is for your eyes only.`,

  removeCard: `### Remove a card (applies to the draft; undoable)
Use \`removeCard(cardId)\` when the user asks to delete / remove / drop a card. This applies immediately to the caller's private draft — the card leaves the canvas at once. The chat shows a one-click Undo that restores it. Tell the user plainly that you removed the card (and that they can undo). The removal is already applied, so you MAY call \`getDashboardState\` in the same turn to confirm the new card set.`,

  updateCardSql: `### Rewrite a card's SQL (applies to the draft; undoable)
Use \`updateCardSql(cardId, newSql)\` when the user asks to change a card's query. This applies immediately to the caller's private draft; the chat shows a one-click Undo that restores the prior SQL.

ALWAYS:
1. Call \`getCardDetail(cardId)\` first to read the current SQL.
2. Call \`executeSQL\` on the new SQL to verify shape + correctness against the analytics datasource.
3. Then call \`updateCardSql\` with the validated query.

The tool re-validates the SQL before applying; invalid queries are rejected and the draft is left unchanged.`,
};
