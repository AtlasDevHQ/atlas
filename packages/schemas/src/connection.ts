/**
 * Connection wire-format schemas — `ConnectionInfo` + `ConnectionHealth`.
 *
 * Powers the admin `/connections` surface and the semantic-page connection
 * picker. Replaces the duplicate schemas in
 * `packages/web/src/ui/lib/admin-schemas.ts`.
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
  // `groupId` + `groupName` come from the admin connections list endpoint
  // (LEFT JOIN connection_groups) so the table can render an Environment
  // badge without a second round-trip. Both are nullable+optional: older
  // API responses predate the fields, and a connection assigned to no
  // group serializes them as explicit nulls. Without these here, Zod's
  // default object strip drops the keys at parse time.
  groupId: z.string().nullable().optional(),
  groupName: z.string().nullable().optional(),
  // Per-connection mirror of the billing usage-panel SQL predicate
  // (`status != 'archived'` rows in the per-org `connections` table).
  // Optional so older API responses still parse; absence is treated as
  // "count it" by consumers to preserve pre-#2490 behavior. See
  // `ConnectionInfo.billable` for full semantics.
  billable: z.boolean().optional(),
}) as z.ZodType<ConnectionInfo>;

// ---------------------------------------------------------------------------
// Composite response shape
// ---------------------------------------------------------------------------

export const ConnectionsResponseSchema = z
  .object({
    connections: z.array(ConnectionInfoSchema).optional(),
  })
  .transform((r) => r.connections ?? []);

// ---------------------------------------------------------------------------
// Connection-group Source-catalog descriptions (ADR-0022 §4, #3894)
// ---------------------------------------------------------------------------

/** Provenance of a group description: auto-generated from entities vs admin-refined. */
export const CONNECTION_GROUP_DESCRIPTION_SOURCES = ["auto", "manual"] as const;

/**
 * Max stored/edited length of a group description. Single source for the DB
 * write-boundary truncation, the admin PATCH validation, and the web editor's
 * `maxLength`, so all three can't drift.
 */
export const MAX_GROUP_DESCRIPTION_CHARS = 2000;

/** One Connection group's Source-catalog description, as served to the admin UI. */
export const ConnectionGroupDescriptionSchema = z.object({
  groupId: z.string(),
  description: z.string(),
  source: z.enum(CONNECTION_GROUP_DESCRIPTION_SOURCES),
  updatedAt: z.string(),
});

export type ConnectionGroupDescription = z.infer<typeof ConnectionGroupDescriptionSchema>;

/** Response shape of `GET /api/v1/admin/connection-groups`. */
export const ConnectionGroupDescriptionsResponseSchema = z.object({
  descriptions: z.array(ConnectionGroupDescriptionSchema),
});
