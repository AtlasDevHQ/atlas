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
 * A single parameter definition. `default` is intentionally a loose union —
 * `date` defaults may be ISO (`YYYY-MM-DD`) or a relative expression
 * (`now - 30 days`) resolved server-side; `text`/`number` defaults are
 * literals; `null` means "no default".
 */
export const dashboardParameterSchema = z.object({
  key: dashboardParameterKeySchema,
  type: dashboardParameterTypeSchema,
  default: z.union([z.string().max(200), z.number(), z.null()]).default(null),
  label: z.string().min(1).max(120),
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
