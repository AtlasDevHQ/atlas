/**
 * MCP-usage wire-format schemas — single source of truth for the
 * `/api/v1/me/mcp-usage` response shape (#2216), used by the route
 * layer (`packages/api/src/api/routes/me-mcp-usage.ts`) and the web
 * client (`packages/web/src/ui/lib/me-schemas.ts`).
 *
 * Why this lives in `@useatlas/schemas` and not in the route file: a
 * route-side definition + a parallel web-side definition is the
 * canonical drift surface — a route bound change that the web schema
 * doesn't follow renders as a "version mismatch" banner on a working
 * endpoint. Sourcing both sides from one Zod constant turns wire
 * drift into a TS error at the schemas package boundary instead of a
 * runtime parse failure on the user's screen. Mirrors the
 * `mcp-prompts` precedent in this package.
 *
 * The route's OpenAPI registration imports the same schema so the
 * generated `apps/docs/openapi.json` and the web client's parse
 * derive from one declaration.
 */
import { z } from "zod";

/**
 * One row of live per-OAuth-client weighted-request usage. Derived
 * server-side from the in-memory rate-limit bucket — `percentUsed`
 * is server-clamped (0..100, integer-rounded) so the chip's display
 * layer can rely on the wire shape never blowing past the visual cap.
 */
export const McpUsageEntrySchema = z.object({
  /** DCR-issued client id (e.g. `claude-desktop`, `cursor-abc123`). */
  clientId: z.string().min(1),
  /**
   * Sum of in-window weights for the calling user's bucket. Already
   * debited per tool weight (executeSQL and explore count 5×) so the
   * chip math matches what the limiter would charge on the next
   * dispatch.
   */
  currentMinuteWeightedRequests: z.number().int().nonnegative(),
  /** Resolved per-minute quota — admin override if present, else workspace default (60). */
  ceiling: z.number().int().positive(),
  /**
   * Percentage of the ceiling consumed (0..100, integer). Clamped at
   * the route layer so a hypothetical bucket-overshoot regression
   * still renders as a saturated chip rather than blowing past 100%.
   */
  percentUsed: z.number().int().min(0).max(100),
  /**
   * ISO-8601 wall-clock moment the oldest in-window entry rolls past
   * the window. `=== now` when the bucket is empty (UI shows
   * "available now" without subtracting from a stale anchor).
   */
  resetAt: z.string().datetime(),
});

export const MeMcpUsageResponseSchema = z.object({
  clients: z.array(McpUsageEntrySchema),
});

export type McpUsageEntry = z.infer<typeof McpUsageEntrySchema>;
export type MeMcpUsageResponse = z.infer<typeof MeMcpUsageResponseSchema>;
