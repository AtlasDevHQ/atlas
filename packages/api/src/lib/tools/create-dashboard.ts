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
 * Why drafts-first: the chat-as-dashboard-editor PRD (#2362) calls out
 * that newly proposed cards should NEVER be visible to other org members
 * until the user explicitly publishes. Drafts are unconditional (#4324) —
 * `createDashboard` is the on-ramp to that flow, so it always uses the
 * drafts table when available.
 * When the internal DB is offline or the user is anonymous, the tool
 * returns a sanitized err rather than silently falling through to a
 * direct INSERT (CLAUDE.md "Prefer errors over silent fallbacks").
 */

import * as crypto from "crypto";
import { tool } from "ai";
import { z } from "zod";
import { CHART_TYPES } from "@useatlas/types";
import {
  dashboardParametersSchema,
  dashboardTextCardContentSchema,
  dashboardChartConfigSchema,
  dashboardCardAnnotationsSchema,
} from "@useatlas/schemas";
import { createLogger, getRequestContext } from "@atlas/api/lib/logger";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { validateSQL } from "@atlas/api/lib/tools/sql";
import {
  extractPlaceholderNames,
  validateAutoComparison,
  resolveDashboardParameterValues,
} from "@atlas/api/lib/dashboard-parameters";
import {
  CardLayoutSchema,
  resolveCardConnectionId,
  NoGroupMembersError,
} from "@atlas/api/lib/dashboards";
import { hasInternalDB, getInternalDB } from "@atlas/api/lib/db/internal";
import type { DashboardSnapshot, DashboardSnapshotCard } from "@atlas/api/lib/dashboard-versioning";
import {
  seedDraftCards,
  type CardSeedOutcome,
  type SeedCardInput,
} from "@atlas/api/lib/dashboard-seeding";

const log = createLogger("tool:create-dashboard");

/**
 * Given a just-committed dashboard id, return the URL the host's UI navigates
 * to so the "Continue editing" handoff lands on a REACHABLE dashboard route
 * (#4566, PRD #4553 L2). The workspace web app owns `/dashboards/[id]`; an
 * embed/SDK host that owns a different route supplies its own resolver, and a
 * host with no dashboards route opts out explicitly with `null` — in which case
 * `createDashboard` is never registered (see `buildRegistry` in
 * `tools/registry.ts`), so an unreachable draft is structurally impossible
 * rather than a hard-coded workspace path handed to a surface that can't open
 * it.
 */
export type DashboardUrlResolver = (dashboardId: string) => string;

/**
 * The workspace web app's resolver — the surface that owns `/dashboards/[id]`.
 * Returns a workspace-relative path; the chat handoff card decorates it with
 * the bound-editor `openChat` continuation. This is the default resolver for
 * every dashboards-owning surface (self-hosted single-tenant web + SaaS web).
 */
export const WORKSPACE_DASHBOARD_URL_RESOLVER: DashboardUrlResolver = (dashboardId) =>
  `/dashboards/${dashboardId}`;

/** Chart/table/KPI config. The canonical schema lives in @useatlas/schemas so
 *  the optional `kpi` block (#3137) round-trips through every persist path
 *  instead of being stripped at one boundary. */
const ChartConfigSchema = dashboardChartConfigSchema;

/** A SQL-backed chart/table card (the original kind). `kind` is optional and
 *  defaults to a chart so the long-standing `{ title, sql, chartConfig }` shape
 *  keeps working — only a text card has to name its kind. */
const ChartCardSchema = z
  .object({
    kind: z.literal("chart").optional(),
    title: z.string().min(1).max(200),
    sql: z.string().min(1),
    chartConfig: ChartConfigSchema,
    annotations: dashboardCardAnnotationsSchema
      .optional()
      .describe(
        "Optional dated event markers ({ x, label, color? }) drawn as vertical reference lines on a line/area card (e.g. a product launch). `x` must match a value on the card's time/category axis.",
      ),
    layout: CardLayoutSchema.optional(),
    connectionId: z
      .string()
      .min(1)
      .optional()
      .describe("Source connection — omit for the default datasource."),
  })
  // Strict so a text card's `content` (or any stray key) can't ride along on a
  // chart card and be silently dropped — fail fast instead.
  .strict();

/**
 * A markdown text / section-block card (#3138). No SQL, no chart — just a
 * header/explainer that groups the charts below it. `title` is optional (the
 * header usually lives in `content`); when omitted we derive a short row title
 * from the markdown for list/diff surfaces.
 */
const TextCardSchema = z
  .object({
    kind: z.literal("text"),
    title: z.string().min(1).max(200).optional(),
    content: dashboardTextCardContentSchema.describe(
      'Markdown section header / explainer, e.g. "## Top of funnel". Rendered sanitized — no raw HTML.',
    ),
    layout: CardLayoutSchema.optional(),
  })
  // Strict so a text card can't smuggle a `sql`/`chartConfig` past the
  // validation it skips — a mixed payload is a caller bug, reject it.
  .strict();

/**
 * A card is either a chart or a text block. We use a plain union (not a
 * discriminated one) because a chart card may omit `kind` entirely — a card
 * with `content` and no `sql` is a text card, everything else is a chart.
 */
const CardSchema = z.union([ChartCardSchema, TextCardSchema]);

type ChartCardInput = z.infer<typeof ChartCardSchema>;

/**
 * Derive a short row title for a text card whose `title` the agent left blank.
 * Takes the first non-empty line, strips a leading markdown block marker
 * (heading, list bullet, or blockquote), and caps the length. Used only for
 * list/diff surfaces — the tile renders the full markdown, not this label.
 */
export function deriveTextCardTitle(content: string): string {
  for (const rawLine of content.split("\n")) {
    const line = rawLine.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s+)/, "").trim();
    if (line.length > 0) return line.slice(0, 120);
  }
  return "Section";
}

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
      /**
       * Host-resolved URL for the "Continue editing" handoff (#4566). Produced
       * by the surface's {@link DashboardUrlResolver}, so the link always points
       * at a route the host actually owns — never a hard-coded workspace path.
       */
      dashboardUrl: string;
      /**
       * Per-card seeding outcomes (#4558) — one entry per CHART card (text /
       * section cards fetch no data and are omitted), in card order. Each staged
       * card's SQL is executed once inside this tool call and its result cached
       * as the draft card's initial data; a card that errored or hit the
       * wall-clock budget is still staged (the build succeeds) and reported here
       * so the agent can self-correct instead of announcing a broken board.
       */
      cardOutcomes: CardSeedOutcome[];
    }
  | {
      kind: "err";
      error: string;
      /** Populated only when the failure was per-card SQL validation; empty otherwise. */
      validationErrors?: CreateDashboardCardValidationError[];
    };

/**
 * Seed the just-staged chart cards (#4558). Resolves the batch's physical
 * connection from the conversation's group and the dashboard's parameter
 * DEFAULTS once (both shared by every card — every seed card carries the same
 * group), then runs the batch through {@link seedDraftCards}. Never throws — a
 * seeding failure must not turn a committed dashboard into an error envelope,
 * so a connection-resolution, parameter-resolution, or batch-level fault
 * degrades to "every card unseeded" (the canvas-mount render fills them in)
 * rather than propagating.
 */
async function seedStagedCards(
  ctx: {
    ownerId: string;
    dashboardId: string;
    orgId: string | null;
    connectionGroupId: string | null;
  },
  seedCards: SeedCardInput[],
  parameters: z.infer<typeof dashboardParametersSchema> | undefined,
  title: string,
): Promise<CardSeedOutcome[]> {
  const { ownerId, dashboardId, orgId, connectionGroupId } = ctx;
  if (seedCards.length === 0) return [];
  const unseeded = (): CardSeedOutcome[] =>
    seedCards.map((s) => ({ cardId: s.cardId, title: s.title, status: "unseeded" as const }));
  try {
    // Resolve the group's primary member — the exact connection a later refresh
    // runs against, so the seeded rows and the first refresh agree. A group
    // with no members can't be seeded (the same fault a refresh would hit).
    let connectionId: string | null;
    try {
      connectionId = await resolveCardConnectionId({ connectionGroupId }, orgId);
    } catch (err) {
      if (err instanceof NoGroupMembersError) {
        log.warn(
          { groupId: err.groupId, dashboardId, title },
          "createDashboard: card connection group has no members — cards left unseeded",
        );
        return unseeded();
      }
      throw err;
    }

    let paramValues: Record<string, string | number | null>;
    try {
      paramValues = resolveDashboardParameterValues(parameters ?? null, undefined);
    } catch (err) {
      // A malformed parameter default (rare — the render path resolves the same
      // way) can't be seeded against; leave the cards for the canvas render
      // rather than reporting spurious per-card binding errors.
      log.warn(
        { err: errorMessage(err), dashboardId, title },
        "createDashboard: could not resolve parameter defaults for seeding",
      );
      return unseeded();
    }

    return await seedDraftCards({
      userId: ownerId,
      dashboardId,
      cards: seedCards.map((s) => ({ ...s, connectionId })),
      parameters: paramValues,
    });
  } catch (err) {
    log.warn(
      { err: errorMessage(err), dashboardId, title },
      "createDashboard: seeding batch failed — cards left for canvas-mount render",
    );
    return unseeded();
  }
}

/**
 * Build a `createDashboard` tool bound to a host's {@link DashboardUrlResolver}
 * (#4566). The resolver is the surface's opt-in: only a host that owns a
 * dashboards route supplies one, and the handoff link the tool returns
 * (`dashboardUrl`) is that host's route — so the tool is never registered on a
 * surface where its output would be unreachable.
 */
export function makeCreateDashboardTool(resolveDashboardUrl: DashboardUrlResolver) {
  return tool({
  description: `Create a dashboard the user can keep editing in chat.

Use this AFTER you have used executeSQL to confirm each card's query shape (so you know its column names). The tool commits a real dashboard row owned by the calling user. Initial cards are staged in the user's draft — they're NOT visible to other org members until the user clicks Publish.

A typical flow:
1. Use explore + executeSQL to understand the data and run each card's query at least once.
2. Call createDashboard with a title and 1-12 cards. Each card needs: title, sql, chartConfig. Pass the same connectionId you used in executeSQL — omit only when the card targets the default datasource.
3. The chat surfaces a "Continue editing on the dashboard" link to the new dashboard. The same conversation re-opens there in bound mode so subsequent edits route to that one dashboard.

Layout is optional — the dashboard auto-arranges cards if you omit it. Grid is 24 columns wide; common widths are 12 (half) and 24 (full); common heights are 8 (a chart) and 4 (a KPI card). chartConfig.type is one of: ${CHART_TYPES.join(", ")}.

KPI / SCORECARD CARDS: a \`kpi\` card is a big-number scorecard — the first thing a reader looks at. Lead a dashboard with 2-3 KPI cards summarizing the top metrics (revenue, active users, conversion), then put the trend charts below them. A KPI card's \`sql\` returns either a SINGLE headline row or a time-ordered multi-row trend (which also draws a compact sparkline under the number); either way \`chartConfig.categoryColumn\` names the label/time column and \`chartConfig.valueColumns[0]\` the metric column (the last row is the headline). Add \`chartConfig.kpi\` to control it:
  - \`valueFormat\`: "currency" | "number" | "percent" | "duration" (how the big number renders; "percent" expects a ready figure like 12.3, not 0.12; "duration" expects seconds).
  - \`autoComparison\`: true → an AUTOMATIC period-over-period delta chip. PREFER this whenever the dashboard has \`:date_from\` / \`:date_to\` parameters and the card filters by them: it re-runs the card's OWN sql with the date window shifted back one period (no second query to write). The card MUST reference both window params (e.g. \`WHERE created_at >= :date_from AND created_at < :date_to\`) or the call is rejected. Pair with \`comparisonLabel: "vs. prior period"\`.
  - \`comparisonSql\`: the MANUAL alternative — an OPTIONAL second single-number query for the delta chip when the prior period isn't a simple window shift (e.g. same week last year). Runs through the same SQL guard and binds the same \`:<param>\` placeholders. Mutually exclusive with \`autoComparison\`. Omit both for a plain big number.
  - \`comparisonLabel\`: caption under the chip, e.g. "vs. last month".
  - \`inverse\`: true → lower-is-better. The delta chip turns GREEN on a DECREASE (and red on an increase) — set it for churn, latency, error rate, cost, refunds. Leave it off (default) for higher-is-better metrics like revenue or signups.
Example (preferred — automatic comparison): { title: "Revenue", sql: "SELECT 'Revenue' AS label, SUM(amount) AS total FROM orders WHERE created_at >= :date_from AND created_at < :date_to", chartConfig: { type: "kpi", categoryColumn: "label", valueColumns: ["total"], kpi: { valueFormat: "currency", autoComparison: true, comparisonLabel: "vs. prior period" } } }. Every \`:placeholder\` — INCLUDING those in a manual \`comparisonSql\` — must be declared in \`parameters\`, or the whole call is rejected.

SECTION HEADERS (text cards): a card can be a markdown text block instead of a chart — pass { kind: "text", content: "## Top of funnel", layout: { x: 0, y: <row>, w: 24, h: 4 } }. A text card has NO sql/chartConfig and fetches no data; it just renders a sanitized-markdown header or explainer to organize the grid. For ANY dashboard with 4+ cards, group them under section headers — emit a full-width text card (w: 24) above each cluster of related charts ("Top of funnel", "Conversion", "Cohorts"). Keep content short — a heading and at most a sentence.

GOAL LINES (thresholds): for any GOAL-BEARING metric — one with a target, budget, quota, or SLA — add a target line via \`chartConfig.thresholds\`, an array of { value, color?, label? } (value required; up to 5 per card). On a bar/line/area card each threshold draws a horizontal reference line at \`value\`; on a \`kpi\` card the FIRST threshold colours the big number green/red above/below target and shows a target callout. Set one whenever the user names a target ("are we hitting our $1M revenue goal?", "keep error rate under 2%", "95% SLA"): e.g. revenue chart → \`thresholds: [{ value: 1000000, label: "Target" }]\`; a lower-is-better KPI (error rate, latency, cost) → pair the threshold with \`kpi.inverse: true\` so below-target reads as the GOOD (green) outcome. Omit \`thresholds\` entirely when the metric has no meaningful target — don't invent one.

PARAMETERS (date ranges + filters): pass a \`parameters\` array to give the dashboard a top-level filter bar that every card binds to. Each parameter is { key, type, default, label } where type is "date" | "text" | "number". In card SQL, reference a parameter as \`:<key>\` (e.g. \`:date_from\`, \`:date_to\`, \`:region\`). For ANY "last N days" / "this quarter" / "year to date" query, declare \`date_from\` + \`date_to\` parameters and write \`WHERE created_at >= :date_from AND created_at < :date_to\` instead of hardcoding the dates — that keeps the dashboard useful for months instead of ageing in days. Date defaults accept ISO dates or relative expressions like "now - 30 days" / "now - 1 month" / "now". Every \`:placeholder\` a card uses MUST be declared in \`parameters\` (values are bound server-side as real query parameters, never interpolated).

If any card has invalid SQL or references an undeclared parameter, the whole call is rejected — no dashboard row is created. Fix the failing card and call again.

The tool EXECUTES each chart card once as it builds the dashboard and returns \`cardOutcomes\` — a per-card result of \`rows\` (with a rowCount), \`empty\` (zero rows), \`error\` (the card is still created, but its query failed — the \`message\` says why), or \`unseeded\` (the card is created; its data loads when the dashboard opens). Read \`cardOutcomes\` after a successful call: if a card came back \`empty\` or \`error\`, tell the user plainly and offer to fix it — don't describe a card as showing data it didn't return.`,

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
    cards: z
      .array(CardSchema)
      .min(1)
      .max(12)
      .describe(
        'Cards to create. A chart card is { title, sql, chartConfig }; a section header is { kind: "text", content: "## ...", layout }. Group 4+ cards under full-width text headers.',
      ),
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
      //
      // Only chart cards carry SQL — text / section blocks (#3138) have no
      // query, so they skip validation + the placeholder check entirely. We
      // keep each chart card's ORIGINAL index so error envelopes still point
      // at the right card position in a mixed list.
      const chartCards = cards
        .map((card, idx) => ({ card, idx }))
        .filter(
          (c): c is { card: ChartCardInput; idx: number } => c.card.kind !== "text",
        );

      // #3137 — a KPI card's `comparisonSql` runs through the SAME guard at
      // render time, so validate it up front alongside the primary query.
      // Both validations run together (no waterfall) per card.
      const validations = await Promise.all(
        chartCards.map(async ({ card, idx }) => {
          const comparisonSql = card.chartConfig.kpi?.comparisonSql;
          const [validation, comparisonValidation] = await Promise.all([
            validateSQL(card.sql, card.connectionId),
            comparisonSql ? validateSQL(comparisonSql, card.connectionId) : Promise.resolve(null),
          ]);
          return { card, idx, validation, comparisonValidation };
        }),
      );

      const validationErrors: CreateDashboardCardValidationError[] = [];
      for (const v of validations) {
        if (!v.validation.valid) {
          validationErrors.push({ cardIndex: v.idx, cardTitle: v.card.title, error: v.validation.error });
        } else if (v.comparisonValidation && !v.comparisonValidation.valid) {
          // Surface the comparison query's failure distinctly so the agent
          // knows which of the card's two queries to fix.
          validationErrors.push({
            cardIndex: v.idx,
            cardTitle: v.card.title,
            error: `KPI comparison query — ${v.comparisonValidation.error}`,
          });
        }
      }

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
      for (const { card, idx } of chartCards) {
        // A KPI card's comparisonSql binds the same parameters as its primary
        // query (#3137), so its placeholders must be declared too.
        const referenced = new Set(extractPlaceholderNames(card.sql));
        const comparisonSql = card.chartConfig.kpi?.comparisonSql;
        if (comparisonSql) {
          for (const name of extractPlaceholderNames(comparisonSql)) referenced.add(name);
        }
        const undeclared = [...referenced].filter((name) => !declaredKeys.has(name));
        if (undeclared.length > 0) {
          placeholderErrors.push({
            cardIndex: idx,
            cardTitle: card.title,
            error: `references undeclared parameter(s): ${undeclared.map((n) => `:${n}`).join(", ")}. Add them to the dashboard's parameters.`,
          });
        }

        // #3207 — autoComparison shifts the card's bound date window back one
        // period and re-runs the SAME sql. Validate (via the shared helper used
        // by every persistence path) that the card filters by both window params
        // AND that those params are declared as `date` — otherwise the
        // prior-period query is a no-op or can't be shifted, and the promised
        // delta silently vanishes.
        const autoErr = validateAutoComparison(card.sql, card.chartConfig.kpi, parameters);
        if (autoErr) {
          placeholderErrors.push({ cardIndex: idx, cardTitle: card.title, error: autoErr });
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
        //
        // #3138: a text / section block has no SQL or chart — it stores
        // `sql: ""`, `chartConfig: null`, and its markdown in `content`. It
        // carries no connection group (it never queries). Chart cards keep
        // the conversation's environment scope.
        // Collected alongside the snapshot so tool-side seeding (#4558) can run
        // each chart card's SQL once after COMMIT and cache the result as the
        // card's initial draft data. Text / section cards fetch no data, so
        // they never become seed specs. Every chart card is stamped with the
        // conversation's group, so the batch resolves one physical connection
        // (below) — the SAME resolution a later refresh uses.
        const seedCards: SeedCardInput[] = [];
        const snapshotCards: DashboardSnapshotCard[] = cards.map((card, position) => {
          const id = crypto.randomUUID();
          if (card.kind === "text") {
            return {
              id,
              position,
              title: card.title?.trim() || deriveTextCardTitle(card.content),
              sql: "",
              chartConfig: null,
              content: card.content,
              connectionGroupId: null,
              layout: card.layout ?? null,
            };
          }
          seedCards.push({ cardId: id, title: card.title, sql: card.sql });
          return {
            id,
            position,
            title: card.title,
            sql: card.sql,
            chartConfig: card.chartConfig,
            content: null,
            // #3209 — carry dated event markers through to the draft snapshot.
            annotations: card.annotations ?? [],
            connectionGroupId: conversationGroupId,
            layout: card.layout ?? null,
          };
        });

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

        // ---- tool-side seeding (#4558, ADR-0034 Decision 1) ----
        // The cards are now staged in the user's draft (the FK anchor the
        // draft-cache write needs). Execute each chart card once, concurrently,
        // bounded by a wall clock, fail-soft per card — persisting each result
        // as the card's initial draft cache and reporting per-card outcomes so
        // the agent sees rows / empty / error / unseeded instead of announcing a
        // board it never validated. Seeding runs AFTER COMMIT so a failing card
        // can never roll the committed dashboard back.
        const cardOutcomes = await seedStagedCards(
          { ownerId, dashboardId, orgId, connectionGroupId: conversationGroupId },
          seedCards,
          parameters,
          title,
        );

        return {
          kind: "ok",
          dashboardId,
          title,
          description: description ?? null,
          cardCount: snapshotCards.length,
          draft: true,
          dashboardUrl: resolveDashboardUrl(dashboardId),
          cardOutcomes,
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
}

/**
 * Workspace-web-bound `createDashboard` instance — the default the
 * dashboards-owning surface registers. Kept as a named export so the
 * `defaultRegistry` (and direct-import tests) resolve a ready tool without
 * re-supplying the built-in resolver each time.
 */
export const createDashboard = makeCreateDashboardTool(WORKSPACE_DASHBOARD_URL_RESOLVER);
