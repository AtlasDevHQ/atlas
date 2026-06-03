/**
 * createDashboard agent tool (#2369).
 *
 * Reframes the #2265 `proposeDashboard` spike into a real persistence
 * step. The agent now COMMITS a dashboard row (owned by the calling user
 * and scoped to their active org) and stages the initial cards into
 * that user's per-user draft so the chat-as-dashboard-editor flow
 * (#2362, #2363, #2364) can take over from a working baseline.
 *
 * Carries over from the spike:
 *  - Per-card SQL validation via `validateSQL` (single source — same
 *    helper the bound editor `addCard` uses).
 *  - Sanitized error envelope (never leaks raw DB / connection-string
 *    strings to the agent or the user — CLAUDE.md "No secrets in
 *    responses").
 *
 * New in this slice:
 *  - All-or-nothing transaction. Any per-card SQL validation failure
 *    rolls back; the published dashboards table does NOT keep a
 *    half-empty dashboard around.
 *  - User-scoped persistence. `owner_id` comes from the resolved
 *    request user (via `getRequestContext()`), `org_id` from
 *    `user.activeOrganizationId`. The agent has NO say in those —
 *    skipping the request-context guard would let a turn create
 *    dashboards in arbitrary orgs.
 *  - Drafts-first persistence. Cards are staged into the calling
 *    user's draft (#2364's `dashboard_user_drafts`), not the live
 *    `dashboard_cards` table. After the tool returns, the published
 *    dashboard has zero cards and the user's draft has the staged
 *    set. The #2521 Publish UI promotes them later.
 *
 * Why drafts-first regardless of the flag: the chat-as-dashboard-editor
 * PRD (#2362) calls out that newly proposed cards should NEVER be
 * visible to other org members until the user explicitly publishes.
 * The `ATLAS_DASHBOARD_DRAFTS_ENABLED` gate controls whether the bound
 * editor tools route through drafts — `createDashboard` is the on-ramp
 * to that flow, so it always uses the drafts table when available.
 * When the internal DB is offline or the user is anonymous, the tool
 * returns a sanitized err rather than silently falling through to a
 * direct INSERT (CLAUDE.md "Prefer errors over silent fallbacks").
 */

import * as crypto from "crypto";
import { tool } from "ai";
import { z } from "zod";
import { CHART_TYPES } from "@useatlas/types";
import { dashboardParametersSchema } from "@useatlas/schemas";
import { createLogger, getRequestContext } from "@atlas/api/lib/logger";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { validateSQL } from "@atlas/api/lib/tools/sql";
import { extractPlaceholderNames } from "@atlas/api/lib/dashboard-parameters";
import { CardLayoutSchema } from "@atlas/api/lib/dashboards";
import { hasInternalDB, getInternalDB } from "@atlas/api/lib/db/internal";
import type { DashboardSnapshot, DashboardSnapshotCard } from "@atlas/api/lib/dashboard-versioning";

const log = createLogger("tool:create-dashboard");

const ChartConfigSchema = z.object({
  type: z.enum(CHART_TYPES),
  categoryColumn: z.string().min(1),
  valueColumns: z.array(z.string().min(1)).min(1),
});

const CardSchema = z.object({
  title: z.string().min(1).max(200),
  sql: z.string().min(1),
  chartConfig: ChartConfigSchema,
  layout: CardLayoutSchema.optional(),
  connectionId: z
    .string()
    .min(1)
    .optional()
    .describe("Source connection — omit for the default datasource."),
});

export type CreateDashboardCardValidationError = {
  cardIndex: number;
  cardTitle: string;
  error: string;
};

export type CreateDashboardResult =
  | {
      kind: "ok";
      dashboardId: string;
      title: string;
      description: string | null;
      cardCount: number;
      /** Always `true` for this slice — cards are staged in the user's draft. */
      draft: true;
    }
  | {
      kind: "err";
      error: string;
      /** Populated only when the failure was per-card SQL validation; empty otherwise. */
      validationErrors?: CreateDashboardCardValidationError[];
    };

export const createDashboard = tool({
  description: `Create a dashboard the user can keep editing in chat.

Use this AFTER you have used executeSQL to confirm each card's query shape (so you know its column names). The tool commits a real dashboard row owned by the calling user. Initial cards are staged in the user's draft — they're NOT visible to other org members until the user clicks Publish.

A typical flow:
1. Use explore + executeSQL to understand the data and run each card's query at least once.
2. Call createDashboard with a title and 1-12 cards. Each card needs: title, sql, chartConfig. Pass the same connectionId you used in executeSQL — omit only when the card targets the default datasource.
3. The chat surfaces a "Continue editing on the dashboard" link to the new dashboard. The same conversation re-opens there in bound mode so subsequent edits route to that one dashboard.

Layout is optional — the dashboard auto-arranges cards if you omit it. Grid is 24 columns wide; common widths are 12 (half) and 24 (full); common heights are 8 (chart) and 4 (KPI / small table). chartConfig.type is one of: ${CHART_TYPES.join(", ")}.

PARAMETERS (date ranges + filters): pass a \`parameters\` array to give the dashboard a top-level filter bar that every card binds to. Each parameter is { key, type, default, label } where type is "date" | "text" | "number". In card SQL, reference a parameter as \`:<key>\` (e.g. \`:date_from\`, \`:date_to\`, \`:region\`). For ANY "last N days" / "this quarter" / "year to date" query, declare \`date_from\` + \`date_to\` parameters and write \`WHERE created_at >= :date_from AND created_at < :date_to\` instead of hardcoding the dates — that keeps the dashboard useful for months instead of ageing in days. Date defaults accept ISO dates or relative expressions like "now - 30 days" / "now - 1 month" / "now". Every \`:placeholder\` a card uses MUST be declared in \`parameters\` (values are bound server-side as real query parameters, never interpolated).

If any card has invalid SQL or references an undeclared parameter, the whole call is rejected — no dashboard row is created. Fix the failing card and call again.`,

  inputSchema: z.object({
    title: z.string().min(1).max(200).describe("Dashboard title"),
    description: z
      .string()
      .max(2000)
      .optional()
      .describe("Optional one-line description of what the dashboard shows"),
    parameters: dashboardParametersSchema
      .optional()
      .describe(
        'Top-level dashboard parameters cards bind to via :<key> placeholders. Each is { key, type: "date"|"text"|"number", default, label }. Use :date_from / :date_to for any relative time range instead of hardcoding dates.',
      ),
    cards: z.array(CardSchema).min(1).max(12).describe("Cards to create"),
  }),

  execute: async ({ title, description, parameters, cards }): Promise<CreateDashboardResult> => {
    // ---- guard rails (resolve owner / org before opening a transaction) ----
    if (!hasInternalDB()) {
      // Same sanitized envelope as every other failure — agent gets a
      // retryable message, the operator gets the structured log.
      log.warn({ title }, "createDashboard called but internal DB is unavailable");
      return {
        kind: "err",
        error: "The dashboard tool failed unexpectedly. Try again or simplify the proposal.",
      };
    }

    const reqCtx = getRequestContext();
    const user = reqCtx?.user;
    if (!user?.id) {
      // Anonymous chat sessions can't own a dashboard. Return a
      // user-actionable message rather than silently dropping the work.
      log.warn({ title }, "createDashboard rejected: no authenticated user in request context");
      return {
        kind: "err",
        error:
          "Sign in to save a dashboard. The chat is anonymous right now, so the dashboard would have no owner.",
      };
    }
    const ownerId = user.id;
    const orgId = user.activeOrganizationId ?? null;
    // #2369 follow-up: honor the conversation's content scope so a
    // chat created in a specific environment (1.4.4) produces cards
    // bound to that environment. Without this, every chat-created
    // dashboard's cards default to the workspace `default` group view
    // regardless of which env the conversation was in.
    const conversationGroupId = reqCtx?.connectionGroupId ?? null;

    try {
      // ---- per-card SQL validation (BEFORE opening transaction) ----
      // Mirrors the spike's per-card pattern but treats ANY failure as
      // fatal so the agent doesn't get a half-built dashboard. The
      // bound editor's `addCard` accepts cards one at a time; here we
      // validate the full batch up front so the agent can fix the
      // failing card and retry the whole proposal.
      const validations = await Promise.all(
        cards.map(async (card, idx) => {
          const validation = await validateSQL(card.sql, card.connectionId);
          return { card, idx, validation };
        }),
      );

      const validationErrors: CreateDashboardCardValidationError[] = validations
        .filter(
          (v): v is typeof v & { validation: { valid: false; error: string } } =>
            !v.validation.valid,
        )
        .map((v) => ({
          cardIndex: v.idx,
          cardTitle: v.card.title,
          error: v.validation.error,
        }));

      if (validationErrors.length > 0) {
        log.warn(
          { invalid: validationErrors, title },
          "createDashboard rejecting — at least one card failed SQL validation",
        );
        return {
          kind: "err",
          error:
            validationErrors.length === 1
              ? `Card "${validationErrors[0].cardTitle}" failed SQL validation: ${validationErrors[0].error}. Fix it and call createDashboard again.`
              : `${validationErrors.length} cards failed SQL validation. Fix them and call createDashboard again.`,
          validationErrors,
        };
      }

      // ---- placeholder declaration check ----
      // Every `:placeholder` a card references must be declared in
      // `parameters` — values bind server-side, so an undeclared placeholder
      // would fail at render time. Reject up front with an actionable message
      // (#2267).
      const declaredKeys = new Set((parameters ?? []).map((p) => p.key));
      const placeholderErrors: CreateDashboardCardValidationError[] = [];
      for (let idx = 0; idx < cards.length; idx++) {
        const card = cards[idx];
        const undeclared = extractPlaceholderNames(card.sql).filter((name) => !declaredKeys.has(name));
        if (undeclared.length > 0) {
          placeholderErrors.push({
            cardIndex: idx,
            cardTitle: card.title,
            error: `references undeclared parameter(s): ${undeclared.map((n) => `:${n}`).join(", ")}. Add them to the dashboard's parameters.`,
          });
        }
      }
      if (placeholderErrors.length > 0) {
        log.warn(
          { invalid: placeholderErrors, title },
          "createDashboard rejecting — card references undeclared parameters",
        );
        return {
          kind: "err",
          error:
            placeholderErrors.length === 1
              ? `Card "${placeholderErrors[0].cardTitle}" ${placeholderErrors[0].error}`
              : `${placeholderErrors.length} cards reference undeclared parameters. Declare them and call createDashboard again.`,
          validationErrors: placeholderErrors,
        };
      }

      // ---- transactional persist ----
      // The transaction wraps: (1) INSERT dashboards (returning id), and
      // (2) INSERT dashboard_user_drafts (the staged card snapshot).
      // Both steps must succeed or neither lands. If the draft insert
      // fails the dashboard row is rolled back so the user doesn't end
      // up with an empty stub they didn't ask for.
      const pool = getInternalDB();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const dashRows = await client.query(
          `INSERT INTO dashboards (owner_id, org_id, title, description, parameters)
           VALUES ($1, $2, $3, $4, $5::jsonb)
           RETURNING id, title, description, updated_at`,
          [ownerId, orgId, title, description ?? null, JSON.stringify(parameters ?? [])],
        );
        if (dashRows.rows.length === 0) {
          throw new Error("dashboards INSERT returned no rows");
        }
        const dashboardId = dashRows.rows[0].id as string;
        const dashUpdatedAt = String(dashRows.rows[0].updated_at);

        // Build the snapshot the user's draft will hold. Each card gets
        // a UUID up front so subsequent bound `updateCard` / `addCard`
        // calls in the same session resolve. Position is assigned in
        // call order — the agent ordered the cards intentionally.
        const snapshotCards: DashboardSnapshotCard[] = validations.map((v, position) => ({
          id: crypto.randomUUID(),
          position,
          title: v.card.title,
          sql: v.card.sql,
          chartConfig: v.card.chartConfig,
          connectionGroupId: conversationGroupId,
          layout: v.card.layout ?? null,
        }));

        const snapshot: DashboardSnapshot = {
          dashboardId,
          title,
          description: description ?? null,
          cards: snapshotCards,
        };
        // Baseline is "what published looked like at fork time" — for a
        // brand-new dashboard that's the empty card list with the just-
        // committed title/description. Storing it now means the future
        // publish-merge compares against an empty baseline and produces
        // pure `insertCard` ops (no spurious conflicts).
        const baseline: DashboardSnapshot = {
          dashboardId,
          title,
          description: description ?? null,
          cards: [],
        };

        // ON CONFLICT DO NOTHING mirrors `forkOrLoadDraft`'s shape so
        // both write paths converge if a future code path ever calls
        // `createDashboard` against an existing dashboardId — today the
        // composite PK collision is impossible (brand-new UUID), but
        // the symmetry keeps a confusing PK violation from ever
        // bypassing the sanitized error envelope this tool returns.
        await client.query(
          `INSERT INTO dashboard_user_drafts
             (user_id, dashboard_id, draft, baseline, published_baseline_at)
           VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)
           ON CONFLICT (user_id, dashboard_id) DO NOTHING`,
          [
            ownerId,
            dashboardId,
            JSON.stringify(snapshot),
            JSON.stringify(baseline),
            dashUpdatedAt,
          ],
        );

        await client.query("COMMIT");

        log.info(
          { dashboardId, ownerId, orgId, cardCount: snapshotCards.length, title },
          "createDashboard committed — cards staged in user draft",
        );

        return {
          kind: "ok",
          dashboardId,
          title,
          description: description ?? null,
          cardCount: snapshotCards.length,
          draft: true,
        };
      } catch (txErr) {
        // Best-effort rollback. A rollback failure is logged but doesn't
        // override the original error envelope returned to the agent.
        try {
          await client.query("ROLLBACK");
        } catch (rollbackErr) {
          log.warn(
            { err: errorMessage(rollbackErr), title },
            "createDashboard ROLLBACK failed",
          );
        }
        throw txErr;
      } finally {
        client.release();
      }
    } catch (err) {
      // Log the raw error server-side; return a sanitized message to the
      // agent so we never leak stack traces / connection strings through
      // the tool result envelope (CLAUDE.md "No secrets in responses").
      log.warn(
        { err: errorMessage(err), title },
        "createDashboard failed unexpectedly",
      );
      return {
        kind: "err",
        error: "The dashboard tool failed unexpectedly. Try again or simplify the proposal.",
      };
    }
  },
});
