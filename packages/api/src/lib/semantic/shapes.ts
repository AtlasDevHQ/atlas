/**
 * Shared Zod shapes for semantic-layer YAML rows.
 *
 * Lives outside `whitelist.ts` and `entities.ts` so both modules validate
 * row YAML through the same predicate. Without this shared module, the
 * caller-facing summary surface (`listEntities`) and the SQL whitelist
 * (`loadOrgWhitelist`) could drift on what counts as "valid enough to
 * surface to the agent" — exactly the #2142 class.
 */

import { z } from "zod";

/**
 * Core entity shape — validates the table name and the Connection-group
 * scope. `group` is the canonical scope field (ADR-0012); `connection` is
 * its deprecated alias, still parsed for back-compat.
 */
export const EntityShape = z
  .object({
    table: z.string(),
    group: z.string().optional(),
    connection: z.string().optional(),
    /**
     * How `table` is interpreted when deriving whitelist keys (#3317).
     * - `"sql"` (default when omitted) — a dot-qualified SQL identifier
     *   (`schema.table`); the loader also registers the unqualified last
     *   segment so `FROM orders` matches `public.orders`.
     * - `"opaque"` — a literal datasource identifier (e.g. an Elasticsearch
     *   index / alias / data-stream name) where `.` is an ordinary character;
     *   the loader registers the full name only and never dot-splits it.
     */
    identifier_style: z.enum(["sql", "opaque"]).optional(),
  })
  .passthrough();

export type EntityShapeT = z.infer<typeof EntityShape>;
