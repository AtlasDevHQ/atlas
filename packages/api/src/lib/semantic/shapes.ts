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

/** Core entity shape — validates table name and connection only. */
export const EntityShape = z
  .object({
    table: z.string(),
    connection: z.string().optional(),
  })
  .passthrough();

export type EntityShapeT = z.infer<typeof EntityShape>;
