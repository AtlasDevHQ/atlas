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
 * ⚠️ FOUR of the six consumers are on exactly that Effect path today:
 * `admin-prompts.ts`, `sub-processor-subscriptions.ts`,
 * `starter-prompts/favorite-store.ts` and `suggestions/approval-store.ts` all
 * read this flat classification off an `internalQuery` result, where the shape
 * may be wrapped. Tracked in #5272; each site carries the same note. Do not
 * read "flat is right for the `pg` driver" as "flat is right at every call
 * site" — only the two seeders pass a raw `Pool`.
 */

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
