/**
 * Connection wire-format schemas — `ConnectionInfo` + `ConnectionHealth`.
 *
 * Powers the admin `/connections` surface and the schema-diff page. Replaces
 * the duplicate schemas in `packages/web/src/ui/lib/admin-schemas.ts`.
 *
 * `ConnectionInfo.status` tightens to `CONNECTION_STATUSES` from
 * `@useatlas/types` so mode-drift (published/draft/archived) fails parse
 * at the wire boundary instead of rendering a neutral fallback.
 *
 * `ConnectionHealth.status` uses `z.enum(HEALTH_STATUSES)` from
 * `@useatlas/types` so a new health-status variant added to the
 * tuple fails at the schema call site rather than silently parsing
 * through an inline enum.
 *
 * `ConnectionInfo.dbType` deliberately stays structurally typed via `as
 * z.ZodType<...>` (not `satisfies`) because plugins can register dbType
 * values outside the `DB_TYPES` tuple, and a strict `z.enum(DB_TYPES)`
 * would reject plugin-emitted connections at parse time. The TypeScript
 * type narrows to `DBType` for operator UX; the wire schema stays permissive.
 *
 * `checkedAt` goes through `IsoTimestampSchema` (#1697).
 */
import { z } from "zod";
import {
  CONNECTION_STATUSES,
  HEALTH_STATUSES,
  type ConnectionHealth,
  type ConnectionInfo,
} from "@useatlas/types";
import { IsoTimestampSchema } from "./common";

export const ConnectionHealthSchema = z.object({
  status: z.enum(HEALTH_STATUSES),
  latencyMs: z.number(),
  message: z.string().optional(),
  checkedAt: IsoTimestampSchema,
}) satisfies z.ZodType<ConnectionHealth, unknown>;

export const ConnectionInfoSchema = z.object({
  id: z.string(),
  dbType: z.string(),
  description: z.string().nullable().optional(),
  status: z.enum(CONNECTION_STATUSES).optional(),
  health: ConnectionHealthSchema.optional(),
}) as z.ZodType<ConnectionInfo>;

// ---------------------------------------------------------------------------
// Composite response shape
// ---------------------------------------------------------------------------

export const ConnectionsResponseSchema = z
  .object({
    connections: z.array(ConnectionInfoSchema).optional(),
  })
  .transform((r) => r.connections ?? []);
