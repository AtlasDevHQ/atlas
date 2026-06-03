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
