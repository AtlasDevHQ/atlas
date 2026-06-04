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
 */

/**
 * Name of the partial unique index created by migration 0120 and mirrored
 * in `db/schema.ts`. Postgres reports it as the `constraint` field on the
 * `unique_violation` error when a concurrent install loses the race.
 */
export const CHAT_ROUTING_ID_UNIQUE_INDEX = "workspace_plugins_chat_routing_id_unique";

/** Postgres SQLSTATE for `unique_violation`. */
const PG_UNIQUE_VIOLATION = "23505";

/**
 * Max `.cause` links to follow. The pg error is at most a couple of links
 * deep (`SqlError.cause` → pg `DatabaseError`); the cap is a backstop against
 * a cyclic `cause` chain rather than a real depth requirement.
 */
const MAX_CAUSE_DEPTH = 8;

/**
 * Shape of the fields we read off an error link. `code` carries the SQLSTATE;
 * `constraint` carries the violated index/constraint name on a unique
 * violation; `cause` is the next link to inspect. All optional because the
 * value reaching a `catch` is `unknown` — a network/driver error won't have
 * them.
 */
interface PgErrorLike {
  readonly code?: unknown;
  readonly constraint?: unknown;
  readonly cause?: unknown;
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
 * error inside a `SqlError.cause` with NO top-level `code`. Inspecting each
 * link catches the 23505 regardless of how deeply the driver/Effect layer
 * wrapped it.
 */
export function isRoutingIdUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (typeof current !== "object" || current === null) return false;
    const e = current as PgErrorLike;
    if (e.code === PG_UNIQUE_VIOLATION && e.constraint === CHAT_ROUTING_ID_UNIQUE_INDEX) {
      return true;
    }
    if (e.cause === current) return false; // self-referential guard
    current = e.cause;
  }
  return false;
}
