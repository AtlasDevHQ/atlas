/**
 * Error-message hygiene for audit metadata.
 *
 * `admin_action_log.metadata` is JSONB that compliance reviewers read
 * directly. Two hazards to close:
 *
 *   1. pg / better-auth error text sometimes echoes the connection string,
 *      so the DB password lands in the audit row verbatim. `errorMessage`
 *      scrubs `scheme://user:pass@host` userinfo.
 *   2. An oversized error (full stack as `.message`) bloats the JSONB column
 *      and pushes structured fields off the end of log-aggregation size
 *      limits. Truncated to 512 chars with an ellipsis suffix.
 *
 * When NOT to use `errorMessage` (mark the raw ternary with
 * `// @atlas-ok-ternary: <reason>` instead):
 *
 *   - The string is substring-matched or parsed to branch control flow
 *     (`msg.includes("does not exist")`, regex extraction) — scrubbing +
 *     truncation could alter match semantics.
 *   - The string is concatenated into a thrown `new Error(...)` message —
 *     per #1829, `throw` constructors are out of scope for the hygiene
 *     sweep so the original error remains inspectable.
 *   - It's an `Effect.tryPromise` catch normalizer that returns an
 *     `Error` instance — the pino `err` serializer handles those with
 *     full stack preservation.
 *
 * `causeToError` walks an Effect `Cause` and returns the first underlying
 * error — typed failure, defect, or `undefined` for pure-interrupt causes.
 * Interrupts represent fiber cancellation (client disconnect, request
 * timeout, shutdown) where the operation's outcome is indeterminate; the
 * call site decides whether to emit a "status: failure" audit row or skip.
 */

import { Cause, Option } from "effect";

const ERROR_MESSAGE_MAX = 512;

export function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const scrubbed = raw.replace(/\b([a-z][a-z0-9+.-]*):\/\/[^\s@/]*@/gi, "$1://***@");
  return scrubbed.length > ERROR_MESSAGE_MAX
    ? `${scrubbed.slice(0, ERROR_MESSAGE_MAX - 3)}...`
    : scrubbed;
}

export function causeToError(cause: Cause.Cause<unknown>): unknown | undefined {
  if (Cause.isInterruptedOnly(cause)) return undefined;
  const failure = Cause.failureOption(cause);
  if (Option.isSome(failure)) return failure.value;
  for (const defect of Cause.defects(cause)) return defect;
  return undefined;
}
