/**
 * Postgres error classification shared across the write paths that recover
 * from a specific SQLSTATE rather than failing the whole pass.
 *
 * `PG_UNIQUE_VIOLATION` had SIX independent definitions when this module was
 * written (#5266) — `seed-builtin-knowledge-catalog.ts`, `admin-prompts.ts`,
 * `sub-processor-subscriptions.ts`, `routing-id-conflict.ts`,
 * `starter-prompts/favorite-store.ts` and `suggestions/approval-store.ts` —
 * one of them added by #5260 while fixing the very defect class this module
 * serves. Six spellings of one constant is six chances for one of them to
 * drift to a SQLSTATE that means something else, and nothing would catch it:
 * each site's tests pin its own copy.
 *
 * ⚠️ The first draft of this header said FOUR, because the sweep that produced
 * it grepped for the declaration and stopped at the sites the issue named. The
 * two it missed are cited BY PATH inside `sub-processor-subscriptions.ts` as
 * its own precedent — i.e. they were reachable from a file the same commit was
 * editing. A census in a header is a claim like any other; this one is now
 * `grep -rn 'const .* = "23505"'` over `packages/api/src` and `ee/`, which
 * returns two lines: the declaration below, and this line quoting the recipe.
 * (Constrained to DECLARATIONS on purpose — the unconstrained pattern also
 * matches seven test fixtures that build a rejection by hand.)
 *
 * ⚠️ **Only the CONSTANT is universal; the classification around it is not.**
 * `asUniqueViolation` below reads a FLAT `code`, which is right for the `pg`
 * driver and wrong for `@effect/sql` — that wrapper moves the driver error
 * under `.cause`, which is why `routing-id-conflict.ts` walks the chain
 * instead. It imports the constant and keeps its own walk. Do not "simplify"
 * the two into one helper: a chain walk applied to the seeders would classify
 * a wrapped violation from an unrelated layer as a benign collision, and a
 * flat read applied to the Effect path would classify every real collision as
 * an unhandled throw.
 *
 * ⚠️ **#5272 SETTLED — the four `internalQuery` consumers needed the second
 * classifier, and the shape is worse than "wrapped under `.cause`".** Measured
 * against real Postgres with a real `PgClient.layerFromPool` client
 * (`__tests__/internal-query-error-shape-pg.test.ts`), a promise-awaited
 * `internalQuery` rejects with:
 *
 *     FiberFailureImpl                      ← own props: message, name, stack
 *       [Symbol(effect/Runtime/FiberFailure/Cause)] = { _tag: "Fail", error }
 *           SqlError.cause = DatabaseError { code: "23505", constraint, … }
 *
 * There is no top-level `code` AND **no `.cause` on the FiberFailure** — the
 * cause hangs off a symbol. So both the flat read and a naive `.cause` walk
 * miss it, and every affected 409/duplicate arm surfaced a routine collision
 * as a 500. {@link asWrappedUniqueViolation} unwraps that; the four sites use
 * it now.
 */

import { Cause, Runtime } from "effect";

/** Postgres SQLSTATE for `unique_violation`. */
export const PG_UNIQUE_VIOLATION = "23505";

/**
 * The diagnostic fields of a flat `23505`, or `undefined` for any other
 * rejection.
 *
 * `pg` rejects with a `DatabaseError` carrying untyped `code`/`constraint`/
 * `detail`, so this narrows rather than casts. It reads the CODE and not the
 * message: matching on prose would classify an unrelated failure whose message
 * happened to say "duplicate key" as a benign collision, and demoting a real
 * outage to a warning is the failure this classification exists to avoid.
 *
 * ⚠️ Reads a TOP-LEVEL `code` only. An `@effect/sql`-backed client wraps the
 * driver error under `.cause`, so every collision would arrive here
 * unclassified — worse than no recovery, because the caller's catch would then
 * treat a routine squatted slug as a hard failure. Both seeders pass a raw
 * `Pool`; see their seam preconditions.
 */
export function asUniqueViolation(
  err: unknown,
): { readonly constraint?: string; readonly detail?: string } | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  if (!("code" in err) || err.code !== PG_UNIQUE_VIOLATION) return undefined;
  const constraint = "constraint" in err && typeof err.constraint === "string" ? err.constraint : undefined;
  const detail = "detail" in err && typeof err.detail === "string" ? err.detail : undefined;
  return { constraint, detail };
}

/**
 * The one NAMED unique constraint the two `plugin_catalog` seeders' recovery
 * models. Postgres DERIVES this name from `slug TEXT NOT NULL UNIQUE` in
 * `0014_plugin_marketplace.sql` — the literal string appears in neither the
 * migration nor `db/schema.ts`, so grepping for it finds only this module and
 * its tests.
 *
 * `plugin_catalog` has two unique constraints today — PK `id`, consumed by the
 * conflict target, and this one — so a 23505 reaching either seeder's catch is
 * almost certainly a slug collision. Naming it turns that inference into a
 * condition the code checks; an UNNAMED 23505 is still accepted, under the
 * hedge each seeder's warning carries.
 */
export const PG_PLUGIN_CATALOG_SLUG_CONSTRAINT = "plugin_catalog_slug_key";

/**
 * Max `.cause` links to follow after unwrapping. The driver error is at most a
 * couple of links deep (`SqlError.cause` → pg `DatabaseError`); the cap is a
 * backstop against a cyclic chain, not a depth requirement.
 */
const MAX_CAUSE_DEPTH = 8;

/**
 * The diagnostic fields of a `23505` raised through an Effect-backed client, or
 * `undefined` for anything else.
 *
 * ⚠️ **THE SIBLING OF {@link asUniqueViolation}, NOT A REPLACEMENT — the two
 * model different transports and merging them breaks both.** A chain walk
 * applied to the raw-`Pool` seeders would classify a wrapped violation from an
 * unrelated layer as a benign collision; a flat read applied here classifies
 * every real collision as an unhandled throw. Pick by how the caller obtained
 * the error, not by taste:
 *
 * - `await pool.query(...)` / a raw `Pool` seam → {@link asUniqueViolation}
 * - `await internalQuery(...)` / anything through `Effect.runPromise` → this
 *
 * Two unwrapping steps, and BOTH are load-bearing (#5272, measured):
 *
 * 1. **The `FiberFailure` symbol.** `Effect.runPromise` rejects with a
 *    `FiberFailureImpl` whose only own properties are `message`, `name` and
 *    `stack`; the `Cause` is stored under `Runtime.FiberFailureCauseId`.
 *    `Cause.squash` reduces that to the underlying failure. Read through
 *    Effect's own API rather than the raw symbol so a runtime change surfaces
 *    as a type error rather than a silently-undefined lookup.
 * 2. **The `.cause` chain.** `SqlError` then holds the pg `DatabaseError` under
 *    an ordinary `.cause`.
 *
 * An error that is NOT a `FiberFailure` still gets the chain walk, because a
 * caller inside an Effect program (catching in the error channel rather than
 * after `runPromise`) sees the bare `SqlError` — same transport, one less
 * wrapper.
 */
export function asWrappedUniqueViolation(
  err: unknown,
): { readonly constraint?: string; readonly detail?: string } | undefined {
  let current: unknown = unwrapFiberFailure(err);

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    const flat = asUniqueViolation(current);
    if (flat !== undefined) return flat;
    if (typeof current !== "object" || current === null) return undefined;
    const next: unknown = (current as { cause?: unknown }).cause;
    if (next === current) return undefined; // self-referential guard
    current = next;
  }
  return undefined;
}

/**
 * Peel Effect's `FiberFailure` wrapper off a rejection, or return `err` as-is.
 *
 * `Effect.runPromise` rejects with a `FiberFailureImpl` whose only own
 * properties are `message`, `name` and `stack` — the `Cause` hangs off
 * `Runtime.FiberFailureCauseId`, so `.cause` is `undefined` and every ordinary
 * chain walk stops at the wrapper. Measured in
 * `__tests__/internal-query-error-shape-pg.test.ts` (#5272).
 *
 * Exported because TWO classifiers need this same first step and must not each
 * grow their own copy: this one, and
 * `integrations/install/routing-id-conflict.ts`, whose constraint-name walk was
 * equally blind to the wrapper. A caller that catches INSIDE an Effect program
 * sees the bare error and passes through untouched.
 */
export function unwrapFiberFailure(err: unknown): unknown {
  return Runtime.isFiberFailure(err)
    ? Cause.squash(err[Runtime.FiberFailureCauseId])
    : err;
}
