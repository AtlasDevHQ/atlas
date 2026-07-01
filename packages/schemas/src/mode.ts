/**
 * Zod schemas for the content-mode publish operation.
 *
 * SSOT Zod mirror of the {@link PublishResult} wire type in `@useatlas/types`
 * (#4156). `satisfies z.ZodType<…>` keeps each schema locked to its type, so the
 * two cannot drift in shape. The `atlas datasource publish` CLI client
 * `.safeParse()`s the `POST /api/v1/admin/publish` response through
 * {@link PublishResultSchema}; the admin route keeps its own local hono-`z`
 * mirror (which additionally carries the REST-only `archived`/`warnings` blocks
 * and the `.openapi()` metadata `@useatlas/schemas` does not).
 */
import { z } from "zod";
import type { PublishPromotedCounts, PublishResult } from "@useatlas/types";

export const PublishPromotedCountsSchema = z.object({
  connections: z.number().int().nonnegative(),
  entities: z.number().int().nonnegative(),
  prompts: z.number().int().nonnegative(),
  starterPrompts: z.number().int().nonnegative(),
}) satisfies z.ZodType<PublishPromotedCounts, unknown>;

export const PublishResultSchema = z.object({
  promoted: PublishPromotedCountsSchema,
  deleted: z.object({ entities: z.number().int().nonnegative() }),
}) satisfies z.ZodType<PublishResult, unknown>;
