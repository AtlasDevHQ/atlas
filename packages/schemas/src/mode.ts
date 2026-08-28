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
import type { WithLooseOptionals } from "./exact-optional";
import type {
  PublishPromotedCounts,
  PublishRefusedDraft,
  PublishResult,
} from "@useatlas/types";

export const PublishPromotedCountsSchema = z.object({
  connections: z.number().int().nonnegative(),
  entities: z.number().int().nonnegative(),
  prompts: z.number().int().nonnegative(),
  starterPrompts: z.number().int().nonnegative(),
  // `.default(0)`: knowledge documents joined the promoted counts in v0.0.41;
  // an older API omits the field, and the CLI parsing that response must not
  // fail — absent means "that surface promoted nothing".
  knowledgeDocuments: z.number().int().nonnegative().default(0),
  // `.default(0)` for the same reason: company-brain facts joined the promoted
  // counts in #4769 (ADR-0036), and a CLI parsing an older API's response must
  // read "that surface promoted nothing", not fail.
  brainFacts: z.number().int().nonnegative().default(0),
}) satisfies z.ZodType<PublishPromotedCounts, unknown>;

/**
 * A draft the review gate declined to promote (#4769). Mirrors
 * {@link PublishRefusedDraft}. Not `.default([])`: absent must stay absent, so a
 * client can branch on presence rather than on an empty array it cannot tell
 * from "this API predates refusals".
 */
export const PublishRefusedDraftSchema = z.object({
  id: z.string(),
  surface: z.string(),
  reasons: z.array(z.string()),
  detail: z.string(),
}) satisfies z.ZodType<PublishRefusedDraft, unknown>;

export const PublishResultSchema = z.object({
  promoted: PublishPromotedCountsSchema,
  deleted: z.object({ entities: z.number().int().nonnegative() }),
  refusedDrafts: z.array(PublishRefusedDraftSchema).optional(),
  // Never capped — see `PublishResult.refusedDraftTotal`. A client counting
  // `refusedDrafts.length` under-reports exactly when the backlog is worst.
  refusedDraftTotal: z.number().int().nonnegative().optional(),
}) satisfies z.ZodType<WithLooseOptionals<PublishResult>, unknown>;
