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
 * {@link asUniqueViolation} reads a FLAT `code`, which is right for the `pg`
 * driver and wrong for `@effect/sql` — that wrapper moves the driver error
 * down a chain, which is what {@link asWrappedUniqueViolation} traverses. Do
 * not "simplify" the two into one helper: a chain walk applied to the seeders
 * would classify a wrapped violation from an unrelated layer as a benign
 * collision, and a flat read applied to the Effect path would classify every
 * real collision as an unhandled throw.
 *
 * ⚠️ The TRAVERSAL, unlike the classification, is now shared —
 * `routing-id-conflict.ts` used to keep its own `.cause` loop and that loop was
 * dead on the very paths its docstring cited (#5272). It keeps its own
 * constraint-name check, which is the part that is genuinely local to it, and
 * takes {@link pgErrorLinks} for the part that is not.
 *
 * ⚠️ FOUR of the six consumers were on exactly that Effect path and were
 * therefore DEAD — `admin-prompts.ts`, `sub-processor-subscriptions.ts`,
 * `starter-prompts/favorite-store.ts` and `suggestions/approval-store.ts` each
 * read the flat classification off an `internalQuery` result. #5272 settled it
 * against a real database and they now call {@link asWrappedUniqueViolation}.
 * Do not read "flat is right for the `pg` driver" as "flat is right at every
 * call site" — only the two seeders pass a raw `Pool`.
 */

// ⚠️ SUBPATH imports, not the `effect` barrel, and deliberately so. Importing
// `{ Cause, Runtime }` from `"effect"` raises a runtime `SyntaxError: Export
// named 'Cause' not found` when a suite that partially mocks the barrel links a
// graph reaching this file — `admin-marketplace.test.ts` is one. It is not a
// type error and this module's own tests did not see it, so the barrel form
// looked correct right up to the point another suite red. Other modules here do
// use the barrel; they are not reached from a partially-mocked graph.
import * as Cause from "effect/Cause";
import * as Runtime from "effect/Runtime";

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
 * Max links to follow. Measured depth on the Effect path is 2
 * (`SqlError` → pg `DatabaseError`); the cap is a backstop against a cyclic
 * `cause` chain rather than a real depth requirement.
 */
const MAX_CAUSE_DEPTH = 8;

/**
 * One `FiberFailure` unwrapped to the error its `Cause` carries, or `err`
 * unchanged when it is not one.
 *
 * ⚠️ **A `FiberFailure` exposes NO `cause` own-property, and that is why a
 * plain `.cause` walk does not reach the driver error.** #5272 proposed exactly
 * such a walk, and the settling experiment falsified it: the rejection from
 * `Effect.runPromise` is a `FiberFailureImpl` whose only own property names are
 * `message`, `name` and `stack`. The `Cause` hangs off the symbol below, so any
 * walk that starts with `err.cause` reads `undefined` and stops at depth 0 —
 * which is precisely how `routing-id-conflict.ts`'s walk was failing on the two
 * `internalQuery`/`queryEffect` paths its own docstring claimed to cover.
 *
 * Uses Effect's own `isFiberFailure` guard rather than testing for the symbol
 * by hand, so a runtime change to how the wrapper is marked surfaces as a type
 * error instead of a silently-undefined lookup that would make every collision
 * unclassified again — which is the exact failure mode this function exists to
 * end. (Adopted from the parallel fix in #5276, which reached this module
 * independently.)
 */
function unwrapFiberFailure(err: unknown): unknown {
  return Runtime.isFiberFailure(err) ? Cause.squash(err[Runtime.FiberFailureCauseId]) : err;
}

/**
 * Every error link worth classifying, outermost first.
 *
 * Unwraps a `FiberFailure` at each step before following `.cause`, so one
 * traversal covers both shapes a caller can be handed: the raw pg
 * `DatabaseError` from a `Pool`, and the `FiberFailure` → `SqlError` → pg
 * `DatabaseError` stack that `internalQuery` produces once the Effect Layer has
 * booted.
 *
 * **The measured chain (#5272, real Postgres, Layer booted):**
 * `FiberFailureImpl` (no `code`) → `Cause.squash` → `SqlError` (no `code`,
 * `_tag` its only own key) → `.cause` → pg `DatabaseError` carrying
 * `code: "23505"`, `constraint` and `detail`.
 *
 * Exported so a classifier for a DIFFERENT SQLSTATE reuses the traversal rather
 * than re-deriving it — the six-spellings problem this module's header opens
 * with, one level up from the constant.
 */
export function pgErrorLinks(err: unknown): readonly unknown[] {
  const links: unknown[] = [];
  let current = unwrapFiberFailure(err);
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    links.push(current);
    if (typeof current !== "object" || current === null) break;
    const next = (current as { readonly cause?: unknown }).cause;
    if (next === undefined || next === null) break;
    if (next === current) break; // self-referential guard
    current = unwrapFiberFailure(next);
  }
  return links;
}

/**
 * The diagnostic fields of a `23505` found anywhere in `err`'s chain, or
 * `undefined`.
 *
 * The classifier for every caller that writes through `internalQuery` or
 * `queryEffect`. {@link asUniqueViolation} is its flat counterpart and stays
 * separate deliberately — this module's header carries that argument, and it is
 * unchanged by #5272: a chain walk applied to the two seeders, which hold a raw
 * `Pool`, would classify a wrapped violation from an unrelated layer as a
 * benign slug collision.
 *
 * ⚠️ It reads the SQLSTATE only. A caller that must distinguish WHICH
 * constraint was violated has to check `constraint` itself — see
 * `integrations/install/routing-id-conflict.ts`, whose whole point is that a
 * `23505` on any other index is a different failure.
 */
export function asWrappedUniqueViolation(
  err: unknown,
): { readonly constraint?: string; readonly detail?: string } | undefined {
  for (const link of pgErrorLinks(err)) {
    const flat = asUniqueViolation(link);
    if (flat !== undefined) return flat;
  }
  return undefined;
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
