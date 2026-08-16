/**
 * Postgres error classification shared across the write paths that recover
 * from a specific SQLSTATE rather than failing the whole pass.
 *
 * `PG_UNIQUE_VIOLATION` had FOUR independent definitions when this module was
 * written (#5266) — `seed-builtin-knowledge-catalog.ts`, `admin-prompts.ts`,
 * `sub-processor-subscriptions.ts` and `routing-id-conflict.ts` — the fourth
 * added by #5260 while fixing the very defect class this module serves. Four
 * spellings of one constant is four chances for one of them to drift to a
 * SQLSTATE that means something else, and nothing would catch it: each site's
 * tests pin its own copy.
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
 * models (`0014_plugin_marketplace.sql`; mirrored in `db/schema.ts`).
 *
 * `plugin_catalog` has two unique constraints today — PK `id`, consumed by the
 * conflict target, and this one — so a 23505 reaching either seeder's catch is
 * almost certainly a slug collision. Naming it turns that inference into a
 * condition the code checks; an UNNAMED 23505 is still accepted, under the
 * hedge each seeder's warning carries.
 */
export const PG_PLUGIN_CATALOG_SLUG_CONSTRAINT = "plugin_catalog_slug_key";
