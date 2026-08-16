/**
 * Routing-id concurrent-install conflict detection (#3167).
 *
 * The five static-bot install handlers (Telegram, Discord, Teams,
 * WhatsApp, Google Chat) each run a cross-workspace ownership PRE-CHECK
 * (`assert*UnboundElsewhere`) before persisting their routing identifier.
 * That pre-check narrows — but does not eliminate — the window where two
 * DIFFERENT workspaces bind the SAME routing id concurrently: it isn't
 * transactionally fused with the cap-gate UPSERT (whose advisory lock is
 * keyed by `workspace_id`, and whose `workspace_plugins_singleton` index
 * is unique only on `(workspace_id, catalog_id)`).
 *
 * Migration 0120 closes that race with a partial unique index
 * ({@link CHAT_ROUTING_ID_UNIQUE_INDEX}) on the per-platform routing key.
 * The losing concurrent writer's UPSERT then fails with a Postgres
 * `unique_violation` (SQLSTATE 23505) naming that index. This helper
 * recognises exactly that error so each handler can re-surface the SAME
 * actionable "already connected elsewhere" message its pre-check returns —
 * rather than leaking a raw 500.
 *
 * The constraint-name check is deliberately tight: a 23505 on any OTHER
 * index (the `workspace_plugins_id_unique` id index, the singleton index)
 * is a genuinely different failure and must NOT be relabelled as a
 * cross-workspace routing conflict.
 *
 * ⚠️ The SQLSTATE constant is shared (#5266); the classification around it is
 * NOT. `pg-errors.ts`'s `asUniqueViolation` reads a FLAT top-level `code`,
 * which is wrong on this path — see the chain-walk rationale on
 * {@link isRoutingIdUniqueViolation}.
 */

import { PG_UNIQUE_VIOLATION, pgErrorLinks } from "@atlas/api/lib/db/pg-errors";

/**
 * Name of the partial unique index created by migration 0120 and mirrored
 * in `db/schema.ts`. Postgres reports it as the `constraint` field on the
 * `unique_violation` error when a concurrent install loses the race.
 */
export const CHAT_ROUTING_ID_UNIQUE_INDEX = "workspace_plugins_chat_routing_id_unique";

/**
 * Shape of the fields we read off an error link. `code` carries the SQLSTATE;
 * `constraint` carries the violated index/constraint name on a unique
 * violation. Both optional because the value reaching a `catch` is `unknown` —
 * a network/driver error won't have them.
 */
interface PgErrorLike {
  readonly code?: unknown;
  readonly constraint?: unknown;
}

/**
 * True iff `err` (or any link in its `.cause` chain) is a Postgres
 * unique-violation raised by the static-bot routing-id index
 * ({@link CHAT_ROUTING_ID_UNIQUE_INDEX}) — i.e. a second workspace lost the
 * concurrent-install race for the same routing id.
 *
 * The chain walk matters: the pg `DatabaseError` surfaces with top-level
 * `code`/`constraint` on the raw-pool transaction path (the common with-org
 * install via `getInternalDB().connect()`), but the no-org direct-insert path
 * and the generic marketplace config UPDATE both go through `@effect/sql`
 * (`internalQuery` / `queryEffect` → `_sqlClient.unsafe`), which wraps the pg
 * error inside a `SqlError` with NO top-level `code`.
 *
 * ⚠️ **The walk this function used to do was its OWN `.cause` loop, and that
 * loop was DEAD on exactly the two Effect paths the paragraph above cites.**
 * `Effect.runPromise` rejects with a `FiberFailure`, which exposes no `cause`
 * own-property — its `Cause` hangs off a symbol — so the loop read `undefined`
 * at depth 0 and returned `false` for every wrapped collision.
 *
 * The concrete route in: `persist-form-install.ts` catches with
 * `.catch(raiseWriteError)` on a promise, so what reaches here is the
 * `FiberFailure` rather than the `SqlError` an in-program catch would see. That
 * made #3167's "already connected elsewhere" message unreachable on that path
 * and handed the losing installer a raw 500. Measured in
 * #5272 against a real database with the index deliberately named
 * {@link CHAT_ROUTING_ID_UNIQUE_INDEX}, so the constraint check could not be
 * what failed: it returned `false` on the real error and `true` on the
 * hand-built fixture its tests use. {@link pgErrorLinks} unwraps the
 * `FiberFailure` before following `.cause`, which is the part the local loop
 * could not have gotten right by inspection.
 */
export function isRoutingIdUniqueViolation(err: unknown): boolean {
  for (const link of pgErrorLinks(err)) {
    if (typeof link !== "object" || link === null) continue;
    const e = link as PgErrorLike;
    if (e.code === PG_UNIQUE_VIOLATION && e.constraint === CHAT_ROUTING_ID_UNIQUE_INDEX) {
      return true;
    }
  }
  return false;
}
