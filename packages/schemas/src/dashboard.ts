/**
 * Dashboard parameter wire-format schemas (#2267 — parameters slice).
 *
 * SSOT for validating dashboard parameter DEFINITIONS (the `dashboards.parameters`
 * JSONB column + the agent `createDashboard` surface) and the view-time RENDER
 * request (`POST /api/v1/dashboards/:id/cards/:cardId/render`).
 *
 * The runtime enum (`dashboardParameterTypeSchema`) is the canonical list of
 * supported parameter kinds; `@useatlas/types` mirrors it as the
 * `DashboardParameterType` union. We keep the enum here (not in
 * `@useatlas/types`) because `@useatlas/schemas` is source-bundled into the
 * scaffold while `@useatlas/types` is registry-installed — a new value export
 * in types would trip the publish-symbol gate before release.
 *
 * SECURITY: these schemas validate the SHAPE of parameter definitions/values.
 * The actual value→SQL binding (named `:placeholder` → `$N`/`?` + bound array)
 * happens server-side in `@atlas/api/lib/dashboard-parameters` — values are
 * NEVER interpolated into SQL text.
 */
import { z } from "zod";
import { CHART_TYPES } from "@useatlas/types";

/** Supported parameter value kinds. Mirrors `DashboardParameterType`. */
export const dashboardParameterTypeSchema = z.enum(["date", "text", "number"]);
export type DashboardParameterTypeWire = z.infer<typeof dashboardParameterTypeSchema>;

/**
 * Parameter key — referenced in card SQL as `:<key>`. Constrained to a
 * lower-snake identifier so the server-side placeholder scanner can match
 * `:<key>` unambiguously (no spaces, quotes, or characters that collide with
 * SQL tokenization). Max 64 chars.
 */
export const dashboardParameterKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z_][a-z0-9_]*$/,
    "Parameter key must be a lower-snake identifier (letters, digits, underscores; not starting with a digit).",
  );

/**
 * Accepted shapes for a `date` default — an ISO date / datetime, or a relative
 * expression resolved server-side. Kept in sync with `resolveDateExpression`
 * in `@atlas/api/lib/dashboard-parameters` (the runtime resolver); this regex
 * is the persist-time gate so a malformed default is rejected on save instead
 * of failing later at render/refresh.
 */
const DATE_DEFAULT_RE =
  /^(\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?.*)?|now\(?\)?|today|now\(?\)?\s*[+-]\s*\d+\s*(days?|weeks?|months?|years?))$/i;

/**
 * A single parameter definition. `default` is a loose union at the field level,
 * then refined to match `type`: a `number` parameter takes a numeric default, a
 * `date` parameter takes an ISO/relative string, `text` takes a string. `null`
 * means "no default". Rejecting cross-type defaults at parse time stops an
 * invalid definition (e.g. `{ type: "number", default: "abc" }`) from
 * persisting cleanly and then failing later when defaults are resolved.
 */
export const dashboardParameterSchema = z
  .object({
    key: dashboardParameterKeySchema,
    type: dashboardParameterTypeSchema,
    default: z.union([z.string().max(200), z.number(), z.null()]).default(null),
    label: z.string().min(1).max(120),
  })
  .superRefine((param, ctx) => {
    if (param.default === null) return;
    switch (param.type) {
      case "number":
        if (typeof param.default !== "number") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Parameter "${param.key}" is a number — its default must be a number.`,
            path: ["default"],
          });
        }
        break;
      case "date":
        if (typeof param.default !== "string" || !DATE_DEFAULT_RE.test(param.default.trim())) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Parameter "${param.key}" is a date — its default must be an ISO date (YYYY-MM-DD) or a relative expression like "now - 30 days".`,
            path: ["default"],
          });
        }
        break;
      case "text":
        if (typeof param.default !== "string") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Parameter "${param.key}" is text — its default must be a string.`,
            path: ["default"],
          });
        }
        break;
    }
  });
export type DashboardParameterWire = z.infer<typeof dashboardParameterSchema>;

/**
 * The full parameter list for a dashboard. Keys must be unique — duplicate
 * keys would make `:<key>` substitution ambiguous.
 */
export const dashboardParametersSchema = z
  .array(dashboardParameterSchema)
  .max(50)
  .superRefine((params, ctx) => {
    const seen = new Set<string>();
    for (let i = 0; i < params.length; i++) {
      const key = params[i].key;
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate parameter key "${key}".`,
          path: [i, "key"],
        });
      }
      seen.add(key);
    }
  });

/**
 * Render-request body. Values are keyed by parameter key. Each value is a
 * primitive (string / number) or `null`; the server coerces + validates each
 * against its parameter definition before binding, and falls back to the
 * definition's default for omitted keys.
 */
export const renderCardRequestSchema = z.object({
  parameters: z
    .record(z.string(), z.union([z.string(), z.number(), z.null()]))
    .optional(),
});
export type RenderCardRequestWire = z.infer<typeof renderCardRequestSchema>;

// ---------------------------------------------------------------------------
// Text / section cards (#3138 — text blocks slice)
//
// A dashboard card is one of two kinds: a SQL-backed `chart` card or a markdown
// `text` / section block. The enum is the runtime mirror of the
// `DashboardCardKind` union in `@useatlas/types` — it lives here (not in types)
// for the same reason as `dashboardParameterTypeSchema`: `@useatlas/schemas` is
// source-bundled into the scaffold while `@useatlas/types` is registry-installed,
// so a new value export in types would trip the publish-symbol gate before the
// npm release.
//
// SECURITY: `content` is markdown rendered SANITIZED on the client (react-markdown
// with no `rehype-raw`) — raw HTML is never evaluated. A text card never touches
// the SQL validation/execution pipeline.
// ---------------------------------------------------------------------------

/** Card kind discriminator. Mirrors `DashboardCardKind`. */
export const dashboardCardKindSchema = z.enum(["chart", "text"]);
export type DashboardCardKindWire = z.infer<typeof dashboardCardKindSchema>;

/** Upper bound on a text card's markdown — a section header/explainer, not an
 *  essay. Keeps a single oversized block from bloating the draft JSONB. */
export const DASHBOARD_TEXT_CARD_CONTENT_MAX = 5_000;

/**
 * Markdown body of a `text` card. Non-empty (an empty section block is
 * meaningless) and length-bounded. The agent `createDashboard` surface and the
 * persisted card both validate against this.
 */
export const dashboardTextCardContentSchema = z
  .string()
  .max(DASHBOARD_TEXT_CARD_CONTENT_MAX)
  // `.min(1)` would still accept "   " / "\n\n", which renders as a blank band.
  // Require at least one non-whitespace character.
  .refine((value) => value.trim().length > 0, "Text card content cannot be empty.");

/**
 * Standalone wire shape of a `text` card's discriminant fields — the
 * `kind` + `content` pair a chart card never carries. Available for any caller
 * that needs to validate a `{ kind, content }` pair; currently exercised by the
 * unit tests. The full persisted `DashboardCard` (with id/layout/timestamps) is
 * typed in `@useatlas/types`.
 */
export const dashboardTextCardSchema = z.object({
  kind: z.literal("text"),
  content: dashboardTextCardContentSchema,
});
export type DashboardTextCardWire = z.infer<typeof dashboardTextCardSchema>;

// ---------------------------------------------------------------------------
// Chart config + KPI / scorecard cards (#3137)
//
// The canonical Zod mirror of `DashboardChartConfig` / `DashboardKpiConfig` in
// `@useatlas/types`. The chart-type enum is built from the `CHART_TYPES` tuple
// imported from `@useatlas/types` so adding a chart type there (e.g. "kpi")
// fails THIS file at compile time if the mirror drifts — the same drift-guard
// pattern `connection.ts` / `backup.ts` use for their status tuples.
//
// `@atlas/api`'s create-dashboard tool, the dashboards REST route, and the
// bound editor all validate their `chartConfig` input against this single
// schema, so the optional `kpi` block round-trips through every persist path
// instead of being silently stripped at one boundary.
// ---------------------------------------------------------------------------

/** Chart card type. Mirrors `ChartType` (the `CHART_TYPES` tuple in types). */
export const dashboardChartTypeSchema = z.enum(CHART_TYPES);
export type DashboardChartTypeWire = z.infer<typeof dashboardChartTypeSchema>;

/** KPI big-number formatting. Mirrors `DashboardKpiValueFormat`. */
export const dashboardKpiValueFormatSchema = z.enum(["currency", "number", "percent", "duration"]);
export type DashboardKpiValueFormatWire = z.infer<typeof dashboardKpiValueFormatSchema>;

/** Upper bound on a KPI comparison query — a single-number SELECT, not an essay. */
export const DASHBOARD_KPI_COMPARISON_SQL_MAX = 10_000;

/**
 * The two date parameters an automatic period-over-period comparison shifts
 * (#3207). Both keys are validated as parameter keys so they line up with the
 * dashboard's declared `:<key>` placeholders.
 */
export const dashboardComparisonDateParamsSchema = z.object({
  from: dashboardParameterKeySchema,
  to: dashboardParameterKeySchema,
});

/**
 * KPI / scorecard config (#3137, #3207). `.strict()` so a stray field (a typo'd
 * `comparison_sql`, or a future option the client doesn't yet read) is rejected
 * at the boundary rather than persisted and silently ignored.
 */
export const dashboardKpiConfigSchema = z
  .object({
    valueFormat: dashboardKpiValueFormatSchema.optional(),
    comparisonSql: z.string().min(1).max(DASHBOARD_KPI_COMPARISON_SQL_MAX).optional(),
    /**
     * #3207 — request an automatic prior-period comparison instead of a
     * hand-written `comparisonSql`. The render endpoint re-runs the card's own
     * SQL with the bound date window shifted back one period.
     */
    autoComparison: z.boolean().optional(),
    /** #3207 — override the date-param pair the auto comparison shifts. */
    comparisonDateParams: dashboardComparisonDateParamsSchema.optional(),
    comparisonLabel: z.string().min(1).max(120).optional(),
    /** #3207 — lower-is-better: invert the delta chip's colour. */
    inverse: z.boolean().optional(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    // `comparisonSql` and `autoComparison` are two ways to populate the SAME
    // delta chip. A card declares ONE comparison source, never both — having
    // both is ambiguous about which query feeds the delta.
    if (cfg.comparisonSql && cfg.autoComparison) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Set either comparisonSql or autoComparison, not both.",
        path: ["autoComparison"],
      });
    }
    // `comparisonLabel` captions the delta chip, which only renders when a
    // comparison value exists — from either source. A label with neither is
    // dead config; reject it rather than persisting a no-op.
    if (cfg.comparisonLabel && !cfg.comparisonSql && !cfg.autoComparison) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "comparisonLabel has no effect without comparisonSql or autoComparison.",
        path: ["comparisonLabel"],
      });
    }
    // `comparisonDateParams` only drives the AUTOMATIC comparison's window
    // shift — it's meaningless for a hand-written `comparisonSql`.
    if (cfg.comparisonDateParams && !cfg.autoComparison) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "comparisonDateParams only applies to autoComparison.",
        path: ["comparisonDateParams"],
      });
    }
    // The window's two bounds must be distinct parameters — shifting a window
    // whose start and end are the same key would bind one date twice.
    if (cfg.comparisonDateParams && cfg.comparisonDateParams.from === cfg.comparisonDateParams.to) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "comparisonDateParams.from and .to must be different parameters.",
        path: ["comparisonDateParams"],
      });
    }
  });
export type DashboardKpiConfigWire = z.infer<typeof dashboardKpiConfigSchema>;

/**
 * Click-to-drilldown config (#3212). `.strict()` so a stray field is rejected
 * at the boundary rather than persisted and silently ignored — same discipline
 * as `dashboardKpiConfigSchema`. `targetParam` reuses the parameter-key schema:
 * it names a declared {@link dashboardParameterSchema} `key`, so it must be the
 * same lower-snake identifier the `:placeholder` scanner matches.
 */
export const dashboardDrilldownConfigSchema = z
  .object({
    targetParam: dashboardParameterKeySchema,
  })
  .strict();
export type DashboardDrilldownConfigWire = z.infer<typeof dashboardDrilldownConfigSchema>;

/**
 * Goal lines / thresholds (#3208).
 *
 * Upper bound on how many goal lines one card carries. A handful of reference
 * lines reads as "targets"; a dozen turns the chart into a ruled page. Bounded
 * here at the persist boundary so neither the agent surface nor the REST route
 * can stack an unreadable number. Mirrors `MAX_THRESHOLD_LINES` in the web
 * renderer (`chart-detection.ts`), which caps the rendered set as a second line
 * of defence over loosely-parsed cached config.
 */
export const DASHBOARD_THRESHOLDS_MAX = 5;

/**
 * Conservative CSS-colour validation for a threshold's `color`. Accepts a hex
 * colour, an `rgb()/rgba()/hsl()/hsla()` function, or a bare-alphabetic named
 * colour. The value lands in an SVG `stroke` / `fill` attribute — React escapes
 * attribute values so this isn't an injection gate. It rejects structurally-
 * malformed values (stray punctuation, embedded spaces); it does NOT validate a
 * named colour against the CSS keyword set, so a typo'd-but-well-formed name
 * (`bleu`) still passes. Length-bounded to a sane colour.
 */
const CSS_COLOR_RE = /^(#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla)\([\d\s.,%/]+\)|[a-zA-Z]+)$/;

/**
 * A single goal line / threshold. `value` is required + finite (the Y-axis
 * position); `color` / `label` are optional. `.strict()` so a stray field is
 * rejected at the boundary rather than persisted and silently ignored — same
 * discipline as `dashboardKpiConfigSchema` / `dashboardDrilldownConfigSchema`.
 */
export const dashboardThresholdSchema = z
  .object({
    value: z.number().finite(),
    color: z
      .string()
      .min(1)
      .max(40)
      .regex(CSS_COLOR_RE, "color must be a hex, rgb()/hsl(), or named CSS colour")
      .optional(),
    label: z.string().min(1).max(80).optional(),
  })
  .strict();
export type DashboardThresholdWire = z.infer<typeof dashboardThresholdSchema>;

/**
 * Full chart-config schema. `kpi` is optional and only meaningful when
 * `type === "kpi"`; the agent surface + REST routes carry it through as-is.
 * `categoryColumn` allows the empty string (a `table`/`kpi` card may not set a
 * label) — `valueColumns` must hold at least one column so a card always has a
 * metric to plot. `drilldown` is optional + back-compatible (#3212); absent →
 * the card is inert on click. `thresholds` is optional + back-compatible
 * (#3208); absent → the card renders exactly as before.
 */
export const dashboardChartConfigSchema = z.object({
  type: dashboardChartTypeSchema,
  categoryColumn: z.string(),
  valueColumns: z.array(z.string().min(1)).min(1),
  kpi: dashboardKpiConfigSchema.optional(),
  drilldown: dashboardDrilldownConfigSchema.optional(),
  thresholds: z.array(dashboardThresholdSchema).max(DASHBOARD_THRESHOLDS_MAX).optional(),
});
export type DashboardChartConfigWire = z.infer<typeof dashboardChartConfigSchema>;
