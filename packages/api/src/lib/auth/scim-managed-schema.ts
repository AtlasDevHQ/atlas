/**
 * F-57 — Zod schema for the 409 SCIM_MANAGED response body.
 *
 * Lives in its own dependency-free module so both the lib helper
 * (`scim-provenance.ts`) and the route layer (`shared-schemas.ts`) can
 * import it without dragging in the full lib dependency graph (Effect /
 * EE / internal DB), which breaks partial `mock.module("effect", ...)`
 * fixtures in unrelated tests. The single import here is `z` from
 * `@hono/zod-openapi` so the schema can be referenced from `createRoute`
 * response declarations.
 *
 * The TS-side `SCIMManagedBlockBody` is derived from this schema in
 * `scim-provenance.ts` via `z.infer`, so adding a field to either side
 * surfaces as a compile error rather than a silent wire / OpenAPI drift.
 */

import { z } from "@hono/zod-openapi";

export const SCIMManagedSchema = z.object({
  error: z.literal("scim_managed"),
  code: z.literal("SCIM_MANAGED"),
  message: z.string(),
  requestId: z.string(),
});
