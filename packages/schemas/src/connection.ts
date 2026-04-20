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
 * `ConnectionHealth.status` kept at `z.string()` — the canonical
 * `HealthStatus` union lives in `@useatlas/types` but lacks a runtime
 * tuple; tightening requires adding one + republishing types. Out of scope
 * for this migration; tracked as a follow-up.
 *
 * `checkedAt` goes through `IsoTimestampSchema` (#1697).
 */
import { z } from "zod";
import {
  CONNECTION_STATUSES,
  type ConnectionHealth,
  type ConnectionInfo,
} from "@useatlas/types";
import { IsoTimestampSchema } from "./common";

export const ConnectionHealthSchema = z.object({
  status: z.string(),
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
}) satisfies z.ZodType<ConnectionInfo, unknown>;

// ---------------------------------------------------------------------------
// Composite response shape
// ---------------------------------------------------------------------------

export const ConnectionsResponseSchema = z
  .object({
    connections: z.array(ConnectionInfoSchema).optional(),
  })
  .transform((r) => r.connections ?? []);
