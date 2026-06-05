import type { ShareMode } from "./share";

// ---------------------------------------------------------------------------
// Chart config (stored in dashboard_cards.chart_config JSONB)
// ---------------------------------------------------------------------------

export const CHART_TYPES = ["bar", "line", "pie", "area", "scatter", "table", "kpi"] as const;
export type ChartType = (typeof CHART_TYPES)[number];

/**
 * Formatting applied to a KPI card's big number (#3137). Drives the
 * client-side `formatKpiValue` formatter — `currency`/`percent` add the
 * symbol, `number` adds thousands grouping, `duration` renders seconds as a
 * compact `1h 2m`. Wire-type mirror of `dashboardKpiValueFormatSchema` in
 * `@useatlas/schemas`.
 */
export type DashboardKpiValueFormat = "currency" | "number" | "percent" | "duration";

/**
 * KPI / scorecard configuration (#3137), present only on a `kpi` chart card.
 * The card's primary `sql` returns the headline metric: `categoryColumn` names
 * the label column and `valueColumns[0]` the number. A single row is the common
 * case (a plain scorecard); a multi-row trend is also valid — the last row is
 * the headline and the value column drives an optional sparkline. `comparisonSql`
 * is an OPTIONAL second single-number query run through the SAME SQL guard
 * (validation + auto-LIMIT + statement timeout) at view time; the UI computes
 * the delta chip from the two values. Both queries bind the dashboard's
 * `:<param>` placeholders identically.
 */
export interface DashboardKpiConfig {
  /** How to format the headline number. Defaults to `number` when omitted. */
  valueFormat?: DashboardKpiValueFormat;
  /**
   * Second single-number query for the delta chip. Runs through the same SQL
   * guard as the primary query — never string-interpolated. Omit for a KPI
   * card with no comparison (big number only). Mutually exclusive with
   * {@link autoComparison}.
   */
  comparisonSql?: string;
  /**
   * Request an AUTOMATIC period-over-period comparison (#3207) without a
   * hand-written {@link comparisonSql}. When true, the render endpoint re-runs
   * the card's OWN `sql` with the bound date window shifted back exactly one
   * period — a `[date_from, date_to)` window of length N days is compared
   * against the immediately-preceding N-day window — through the same SQL guard
   * (parameterized, auto-LIMIT, timeout). Requires the card to bind the
   * dashboard's `:date_from` / `:date_to` params (or the pair named in
   * {@link comparisonDateParams}). Mutually exclusive with `comparisonSql`.
   */
  autoComparison?: boolean;
  /**
   * Override the two date parameters the automatic comparison shifts. Defaults
   * to `{ from: "date_from", to: "date_to" }`. Only meaningful with
   * {@link autoComparison}.
   */
  comparisonDateParams?: { from: string; to: string };
  /** Caption under the delta chip, e.g. "vs. last month". */
  comparisonLabel?: string;
  /**
   * Lower-is-better metric (#3207). Inverts the delta chip's colour so a
   * DECREASE renders green and an INCREASE red — for churn, latency, error
   * rate, cost. The direction arrow still follows the actual change; only the
   * colour flips. Defaults to false (higher-is-better).
   */
  inverse?: boolean;
}

export interface DashboardChartConfig {
  type: ChartType;
  categoryColumn: string;
  valueColumns: string[];
  /** Present only when `type === "kpi"` (#3137). */
  kpi?: DashboardKpiConfig;
}

/**
 * Card discriminator (#3138 — text / section blocks).
 *
 * `chart` is the original SQL-backed card (a query + a {@link DashboardChartConfig});
 * `text` is a markdown section block — a header or explainer with **no SQL, no
 * chart, and no data fetch** — used to group a wall of charts under section
 * headers. The discriminator is its own field rather than an entry in
 * {@link CHART_TYPES} because a text card has no `sql`/`chartConfig` to overload.
 *
 * Derived server-side from the presence of `content` (a text card always carries
 * markdown; a chart card never does), so there is no `kind` column on
 * `dashboard_cards` — see the read path in `@atlas/api/lib/dashboards`
 * (`rowToCard`). The runtime Zod mirror is `dashboardCardKindSchema` in
 * `@useatlas/schemas`.
 */
export type DashboardCardKind = "chart" | "text";

// ---------------------------------------------------------------------------
// Dashboard parameters (#2267 — parameters slice)
//
// A dashboard exposes a set of named parameters (a date range, a region
// filter, …) that every card's SQL can reference via `:<key>` placeholders
// (e.g. `:date_from`, `:date_to`, `:region`). At execution time the value is
// substituted server-side through a PARAMETERIZED query — bound, never
// string-concatenated — so the SQL injection surface stays closed.
//
// The runtime Zod validation for these shapes lives in `@useatlas/schemas`
// (`dashboardParameterSchema`); these are the wire-type mirrors. The value
// enum is intentionally NOT exported from this package — adding a new value
// export here trips the scaffold publish-symbol gate before the npm release.
// ---------------------------------------------------------------------------

/** Supported parameter value kinds. Drives the control rendered in the bar
 *  and the server-side coercion of incoming values + relative-date defaults. */
export type DashboardParameterType = "date" | "text" | "number";

export interface DashboardParameter {
  /** Placeholder name. Referenced in card SQL as `:<key>` (e.g. `date_from`
   *  → `:date_from`). Lower-snake identifier: `^[a-z_][a-z0-9_]*$`. */
  key: string;
  type: DashboardParameterType;
  /**
   * Default value used when the viewer hasn't supplied one (initial load,
   * cached snapshot refresh, scheduler). For `date`, either an ISO date
   * (`YYYY-MM-DD`) or a relative expression resolved server-side
   * (`now`, `now - 30 days`, `now - 3 months`, …) — never passed to SQL as
   * text. For `text` / `number`, a literal. `null` means "no default".
   */
  default: string | number | null;
  /** Human label shown above the control in the parameter bar. */
  label: string;
}

/** NULL on a card means not yet placed — client auto-lays out by `position`. */
export interface DashboardCardLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ---------------------------------------------------------------------------
// API shapes (camelCase)
// ---------------------------------------------------------------------------

export interface Dashboard {
  id: string;
  orgId: string | null;
  ownerId: string;
  title: string;
  description: string | null;
  shareToken: string | null;
  shareExpiresAt: string | null;
  shareMode: ShareMode;
  refreshSchedule: string | null;
  lastRefreshAt: string | null;
  nextRefreshAt: string | null;
  /** Top-level parameters every card can bind to via `:<key>` placeholders.
   *  Empty array when the dashboard has no parameters. */
  parameters: DashboardParameter[];
  cardCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardCard {
  id: string;
  dashboardId: string;
  position: number;
  title: string;
  /**
   * Discriminates a SQL-backed `chart` card from a markdown `text` /
   * section-block card (#3138). Derived server-side from `content` presence;
   * always populated on the wire so the renderer can branch without inspecting
   * `sql`/`chartConfig`.
   */
  kind: DashboardCardKind;
  /**
   * SQL query for a `chart` card. A `text` card has no query — it carries the
   * empty string here (`content` holds its markdown instead) and never reaches
   * the SQL validation/execution pipeline.
   */
  sql: string;
  chartConfig: DashboardChartConfig | null;
  /**
   * Markdown body for a `text` card (#3138), rendered SANITIZED (no raw HTML).
   * `null` for a `chart` card. A text card renders with no data fetch and no
   * SQL-guard involvement.
   */
  content: string | null;
  cachedColumns: string[] | null;
  cachedRows: Record<string, unknown>[] | null;
  cachedAt: string | null;
  /**
   * Group-scoped execution target (1.4.4). Resolves to a physical
   * connection at view time via the group's primary member, or the
   * first member by `(created_at, id)` when no primary is set.
   */
  connectionGroupId: string | null;
  layout: DashboardCardLayout | null;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardWithCards extends Omit<Dashboard, "cardCount"> {
  cards: DashboardCard[];
}

// ---------------------------------------------------------------------------
// AI-suggested cards
// ---------------------------------------------------------------------------

export interface DashboardSuggestion {
  title: string;
  sql: string;
  chartConfig: DashboardChartConfig;
  reason: string;
}

// ---------------------------------------------------------------------------
// Proposed dashboards (chat-side canvas — agent emits, user previews + saves)
// ---------------------------------------------------------------------------

export interface ProposedCard {
  title: string;
  sql: string;
  chartConfig: DashboardChartConfig;
  layout?: DashboardCardLayout;
  connectionId?: string;
}

export interface ProposedDashboardSpec {
  title: string;
  description?: string;
  /** Optional parameters the proposed cards bind to via `:<key>` placeholders. */
  parameters?: DashboardParameter[];
  cards: ProposedCard[];
}

export interface ProposedCardValidationError {
  cardIndex: number;
  cardTitle: string;
  error: string;
}

export type ProposeDashboardResult =
  | {
      kind: "ok";
      spec: ProposedDashboardSpec;
      validation: { allValid: boolean; errors: ProposedCardValidationError[] };
    }
  | { kind: "err"; error: string };

/** Wire shape returned by POST /api/v1/dashboards/preview-card. */
export interface PreviewCardResponse {
  columns: string[];
  rows: Record<string, unknown>[];
  truncated: boolean;
  rowCount: number;
  executionMs: number;
}

/**
 * Request body for POST /api/v1/dashboards/:id/cards/:cardId/render — the
 * view-time, parameter-aware execution of a saved card. Values are keyed by
 * parameter key (`{ date_from: "2026-01-01", region: "us" }`); omitted keys
 * fall back to the parameter's server-resolved default. The result is NOT
 * persisted to the card cache — it's an ephemeral, per-viewer render.
 */
export interface RenderCardRequest {
  parameters?: Record<string, string | number | null>;
}

/**
 * Result of a KPI card's comparison query (#3137) — the second single-number
 * query run alongside the primary at render time. Carries the raw
 * `{ columns, rows }` (same shape as the primary result) so the client extracts
 * the comparison number with the exact same logic it uses for the headline
 * value. `null` when the card has no `comparisonSql` or the comparison query
 * failed (the delta chip is then simply omitted — a broken comparison never
 * breaks the primary KPI render).
 */
export interface KpiComparisonResult {
  columns: string[];
  rows: Record<string, unknown>[];
}

/** Wire shape returned by the card render endpoint (extends {@link PreviewCardResponse}). */
export interface RenderCardResponse extends PreviewCardResponse {
  /**
   * KPI comparison query result (#3137). Present (possibly `null`) only for a
   * `kpi` card; omitted entirely for every other card type.
   */
  comparison?: KpiComparisonResult | null;
}

/**
 * Per-user destructive-op staging (#2365, PRD #2362).
 *
 * The bound chat agent's `removeCard` and `updateCardSql` tools enqueue
 * a `StagedChange` row instead of mutating immediately. The dashboard
 * renders staged cards with a ghost overlay (strikethrough for removal,
 * side-by-side SQL diff for edits) until the user accepts or discards
 * the stage inline.
 */
export type StageKind = "remove_card" | "edit_sql";
export type StageStatus = "pending" | "applied" | "discarded";

export type StagePayload =
  | { kind: "remove_card"; cardId: string }
  | { kind: "edit_sql"; cardId: string; newSql: string; currentSql: string };

export interface StagedChange {
  id: string;
  dashboardId: string;
  userId: string;
  kind: StageKind;
  payload: StagePayload;
  status: StageStatus;
  createdAt: string;
  updatedAt: string;
  appliedAt: string | null;
  discardedAt: string | null;
}
