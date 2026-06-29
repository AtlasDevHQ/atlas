/**
 * Shared primitives used across wire-format schemas.
 *
 * Grows with each family migration in #1648. Keep exports minimal — this
 * module is imported everywhere, so every addition should be something
 * reused by at least two schema families.
 */
import { z } from "zod";

/**
 * ISO-8601 timestamp string.
 *
 * Replaces bare `z.string()` for `createdAt` / `updatedAt` / `assignedAt` /
 * `requestedAt` / `completedAt` / `firedAt` / `resolvedAt` /
 * `acknowledgedAt` / `lastRequest` / `expiresAt` fields across the schema
 * families. Before this helper, every timestamp field accepted arbitrary
 * strings (including `"banana"`), which let server bugs leak through the
 * wire boundary silently. Apply progressively as each family is touched.
 */
export const IsoTimestampSchema = z.string().datetime();

/**
 * Result of {@link WireSchema.safeParse}. A trimmed mirror of zod's own
 * `safeParse` result — `error` is `unknown` because wire consumers only branch
 * on `success` and read `data`, never the issue tree.
 */
export type WireParseResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: unknown };

/**
 * A built zod schema viewed through its parse surface with an `unknown` INPUT —
 * the shape needed to validate untrusted wire JSON at a transport boundary.
 *
 * Why this exists: some composite schemas (a `z.discriminatedUnion`, a `.pipe`
 * chain) expose a `.safeParse()` whose argument is typed to the schema's own
 * members, so a raw `unknown` payload isn't assignable at the call site; and
 * zod's `ZodType<…>` generic arity resolves inconsistently across this repo's
 * toolchains (source vs. declaration resolution), so a `z.ZodType<T, unknown>`
 * cast can't reliably pin the input to `unknown`. Casting a finished schema to
 * `WireSchema<T>` fixes the parse input to `unknown` while preserving the
 * validated output type `T`. Use ONLY for schemas that parse untrusted input
 * (server responses, stream lines) and where the natural `.safeParse(unknown)`
 * doesn't already hold.
 */
export interface WireSchema<T> {
  safeParse(data: unknown): WireParseResult<T>;
  parse(data: unknown): T;
}
