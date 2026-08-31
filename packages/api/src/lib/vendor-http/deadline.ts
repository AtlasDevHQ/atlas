/**
 * Concern 3 of 4 — timeout/abort.
 *
 * One `isAbortError`, one deadline wrapper. Before this module the abort check
 * existed as three verbatim copies (linear, jira, github) and the
 * `AbortController` + `setTimeout` + `finally clearTimeout` dance as three
 * more — and the reason it mattered is that the FOURTH sibling written the
 * same week had neither: on a default deployment `executeWithTimeout(fn,
 * undefined)` returns `fn()` unguarded, so a hung vendor host hung the agent
 * turn. That parity gap is what fired ADR-0045's deferral trigger.
 *
 * @see ./index.ts — the spine's scope, and what it deliberately does NOT own.
 */

import type { VendorHttpResult, VendorTimeoutFailure } from "./result";

/**
 * An abort from a deadline. Duck-typed rather than `instanceof Error`:
 * `AbortController` rejects with a `DOMException`, which does not subclass
 * `Error` on every runtime, so an instanceof check would misreport a timeout
 * as an upstream failure.
 */
export function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "AbortError"
  );
}

/**
 * Run `send` under a deadline and classify the outcome.
 *
 * Returns `ok: false` with a `timeout` failure when the deadline fired;
 * anything else `send` throws propagates unchanged, because a transport error
 * is the caller's own vendor-specific business and wrapping it would only
 * bury the cause.
 *
 * ⚠️ **Scope the callback to what you want bounded.** A caller that wraps only
 * the `fetch` leaves the body read unbounded; one that wraps the whole
 * exchange bounds both. Both are legitimate, and the migration preserved each
 * caller's scope rather than silently widening a deadline: jira and github
 * bound the fetch alone, linear bounds its team lookup and create together.
 *
 * `salesforce.ts` is the FOURTH, and it arrived a step later: at extraction it
 * drove `jsforce`, which exposes no `AbortSignal`, so there was no signal to
 * hand it and its token request and record POST ran unbounded. #5572 took the
 * behaviour change that fixes it — the action path now hand-rolls its two
 * `fetch` calls, and threads ONE budget through both, the same scope choice
 * `linear.ts` makes. All four action clients are bounded.
 *
 * The signal is handed to the callback rather than owned by it, so a caller
 * making several requests inside one budget (Linear's team lookup then its
 * create) threads the same one through all of them.
 *
 * An `AbortError` raised for a reason OTHER than this deadline — a caller's
 * own signal, say — is reported as a timeout too. That is the behaviour every
 * migrated client already had, and no client passes a second signal.
 */
export async function withVendorDeadline<T>(
  timeoutMs: number,
  send: (signal: AbortSignal) => Promise<T>,
): Promise<VendorHttpResult<T, VendorTimeoutFailure>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return { ok: true, value: await send(controller.signal) };
  } catch (err) {
    if (isAbortError(err)) {
      return { ok: false, failure: { reason: "timeout", timeoutMs, cause: err } };
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
