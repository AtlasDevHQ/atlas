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
 * Shape of the fields we read off a `pg` `DatabaseError`. `code` carries
 * the SQLSTATE; `constraint` carries the violated index/constraint name on
 * a unique violation. Both are optional because the value reaching a
 * `catch` is `unknown` — a network/driver error won't have them.
 */
interface PgErrorLike {
  readonly code?: unknown;
  readonly constraint?: unknown;
}

/**
 * True iff `err` is a Postgres unique-violation raised by the static-bot
 * routing-id index ({@link CHAT_ROUTING_ID_UNIQUE_INDEX}) — i.e. a second
 * workspace lost the concurrent-install race for the same routing id.
 */
export function isRoutingIdUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as PgErrorLike;
  return e.code === PG_UNIQUE_VIOLATION && e.constraint === CHAT_ROUTING_ID_UNIQUE_INDEX;
}
