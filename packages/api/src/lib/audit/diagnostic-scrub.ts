/**
 * Driver DIAGNOSTIC fields — `code` and `constraint` — normalized for a log
 * line (#4941).
 *
 * These are what separate "the write failed" from "WHICH invariant rejected the
 * write": `23505` a unique violation, `23503` a foreign key, `42P01` a missing
 * relation, `53300` pool exhaustion. Two places lift them onto a log payload —
 * `scrubErrSerializer`'s whitelist in `lib/logger.ts`, and `pgErrorFields`'s
 * top-level lift in `lib/brain/correction.ts` — and they are two doors onto the
 * same log line. The normalization lives here once so they cannot drift into
 * two different disclosure rules; a duplicated bound is exactly how that
 * happens.
 *
 * ## Why this is not in `error-scrub.ts`
 *
 * It belongs there thematically, and `errorMessage` is imported FROM there. But
 * ten test files `mock.module("@atlas/api/lib/audit/error-scrub")` — eight under
 * `packages/api`, two under `ee/` — and nine of them reproduce its full
 * two-export surface exactly. That completeness is precisely what makes a THIRD
 * export a landmine: bun fails the whole import with "Export named 'X' not
 * found" the moment a consumer names a symbol a mock omits, and the failure
 * lands in an unrelated file on an unrelated PR. (Adding `diagnosticValue`
 * there broke `conversations-budget.test.ts`, the one file mocking only
 * `errorMessage`.) Adding a NEW module nobody mocks has no such blast radius,
 * and all ten mocks supply `errorMessage`, so this module's own import is safe
 * under every one of them.
 */

import { errorMessage } from "@atlas/api/lib/audit/error-scrub";

/**
 * Longest value accepted for a diagnostic field.
 *
 * A SQLSTATE is 5 characters and a Postgres identifier is capped at 63 bytes
 * (`NAMEDATALEN - 1`), so anything longer is not the field the disclosure
 * argument in `lib/logger.ts` reasoned about — it is some other library's
 * `code` carrying a payload.
 *
 * Measured in UTF-16 code units, not bytes, and both directions of that are
 * deliberate: it never rejects a legitimate 63-byte ASCII identifier, at the
 * cost of admitting up to ~3x the bytes for a multi-byte one. The bound is a
 * sanity check on field IDENTITY, not a byte budget — the disclosure guarantee
 * is carried by the whitelist of field NAMES, not by this number.
 */
export const DIAGNOSTIC_FIELD_MAX = 63;

/** Stands in for an over-length diagnostic value. See {@link diagnosticValue}. */
export const DIAGNOSTIC_OVERSIZED = "[dropped: oversized]";

/**
 * Normalize one diagnostic value, or `undefined` if it is not one.
 *
 *   - A number is coerced. Some SDKs put an integer in `code`; coercing keeps
 *     the serialized field's type from varying by thrower without throwing real
 *     signal away. (pg, mysql2 and Node all use a STRING `code` — `23505`,
 *     `ER_DUP_ENTRY`, `ENOENT` — and keep the integer in `errno`, which is
 *     deliberately not a diagnostic field.) Anything else is skipped, so the
 *     field's type never depends on who threw.
 *   - An over-length value becomes {@link DIAGNOSTIC_OVERSIZED} rather than
 *     vanishing: dropping it silently reads to an operator as "the driver set
 *     no code", which is a different — and wrong — diagnosis.
 *   - Whatever survives goes through `errorMessage`. These fields are already
 *     argued safe (a SQLSTATE and a schema identifier, never a row value);
 *     scrubbing anyway means a driver that ever stuffed a DSN into `constraint`
 *     cannot open a new credential door.
 *
 * Reading the value SAFELY off a thrown object — own, non-accessor, guarded —
 * is the caller's job, and both callers do it the same way. It is not folded in
 * here because the two differ in what they must do when the read traps.
 */
export function diagnosticValue(raw: unknown): string | undefined {
  const text = typeof raw === "string" || typeof raw === "number" ? String(raw) : undefined;
  if (text === undefined || text.length === 0) return undefined;
  return text.length <= DIAGNOSTIC_FIELD_MAX ? errorMessage(text) : DIAGNOSTIC_OVERSIZED;
}
