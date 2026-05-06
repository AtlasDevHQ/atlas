/**
 * Audit-log WHERE-clause builder. Pure function over a `QueryReader`;
 * emits parameterized predicates and tracks the next free `$N` so
 * callers can append LIMIT/OFFSET. Lives outside the route layer
 * because `lib/*` cannot import from `api/routes/*` (CLAUDE.md).
 *
 * Every value is parameterized; the function never emits identifiers,
 * so a single SELECT is safe to construct from the returned conditions.
 * The `u.*` references in the search predicate assume the caller's
 * outer SQL has already joined `LEFT JOIN "user" u ON a.user_id = u.id`.
 */

import { ACTOR_KINDS, type ActorKind } from "@atlas/api/lib/logger";

/** Inlined; `lib/` cannot import the route layer. */
function escapeIlike(s: string): string {
  return s.replace(/[%_\\]/g, "\\$&");
}

const ACTOR_KIND_SET = new Set<string>(ACTOR_KINDS);

function isActorKind(value: string): value is ActorKind {
  return ACTOR_KIND_SET.has(value);
}

export type AuditFilterOk = {
  ok: true;
  conditions: string[];
  params: unknown[];
  /** Next free `$N` placeholder — caller appends LIMIT/OFFSET starting here. */
  paramIdx: number;
};

export type AuditFilterErr = {
  ok: false;
  error: string;
  message: string;
  status: 400;
};

export type AuditFilterResult = AuditFilterOk | AuditFilterErr;

export type QueryReader = (key: string) => string | undefined;

/**
 * Build WHERE conditions for audit list + export endpoints. Returns
 * `ok: false` on the first invalid input so the caller can short-
 * circuit with a 400 — no partial filtering, no silent drops.
 *
 * `org_id` is always `$1` so callers + tests can rely on a stable
 * parameter index. The soft-delete predicate goes second so the first
 * two conditions are always present (callers slicing or asserting on
 * shape don't need length checks).
 */
export function buildAuditFilters(
  orgId: string,
  query: QueryReader,
): AuditFilterResult {
  const conditions: string[] = ["a.deleted_at IS NULL", "a.org_id = $1"];
  const params: unknown[] = [orgId];
  let paramIdx = 2;

  const user = query("user");
  if (user) {
    conditions.push(`a.user_id = $${paramIdx++}`);
    params.push(user);
  }

  const success = query("success");
  if (success === "true" || success === "false") {
    conditions.push(`a.success = $${paramIdx++}`);
    params.push(success === "true");
  }

  const from = query("from");
  if (from) {
    if (isNaN(Date.parse(from))) {
      return {
        ok: false,
        error: "invalid_request",
        message: `Invalid 'from' date format: "${from}". Use ISO 8601 (e.g. 2026-01-01).`,
        status: 400,
      };
    }
    conditions.push(`a.timestamp >= $${paramIdx++}`);
    params.push(from);
  }

  const to = query("to");
  if (to) {
    if (isNaN(Date.parse(to))) {
      return {
        ok: false,
        error: "invalid_request",
        message: `Invalid 'to' date format: "${to}". Use ISO 8601 (e.g. 2026-03-03).`,
        status: 400,
      };
    }
    conditions.push(`a.timestamp <= $${paramIdx++}`);
    params.push(to);
  }

  const connection = query("connection");
  if (connection) {
    conditions.push(`a.source_id = $${paramIdx++}`);
    params.push(connection);
  }

  const table = query("table");
  if (table) {
    conditions.push(`a.tables_accessed ? $${paramIdx++}`);
    params.push(table.toLowerCase());
  }

  const column = query("column");
  if (column) {
    conditions.push(`a.columns_accessed ? $${paramIdx++}`);
    params.push(column.toLowerCase());
  }

  // `actorKind` is whitelisted against the canonical ActorKind set.
  // An invalid value is a 400 rather than a silent zero-row match —
  // mirrors the date validation contract above so callers see drift
  // immediately instead of suspecting a permissions bug.
  const actorKind = query("actorKind");
  if (actorKind) {
    if (!isActorKind(actorKind)) {
      return {
        ok: false,
        error: "invalid_request",
        message: `Invalid 'actorKind' value: "${actorKind}". Allowed: ${ACTOR_KINDS.join(", ")}.`,
        status: 400,
      };
    }
    conditions.push(`a.actor_kind = $${paramIdx++}`);
    params.push(actorKind);
  }

  // `clientId` scopes to a specific OAuth client. Only meaningful when
  // actorKind is `mcp`, but we don't enforce that cross-field constraint
  // server-side — pairing them is a UI affordance.
  const clientId = query("clientId");
  if (clientId) {
    conditions.push(`a.client_id = $${paramIdx++}`);
    params.push(clientId);
  }

  // `tool` scopes to a dispatched tool name. Non-MCP rows have NULL
  // `tool_name` and won't match — intentional for a "scope to a tool"
  // filter.
  const tool = query("tool");
  if (tool) {
    conditions.push(`a.tool_name = $${paramIdx++}`);
    params.push(tool);
  }

  const search = query("search");
  if (search) {
    const term = `%${escapeIlike(search)}%`;
    conditions.push(
      `(a.sql ILIKE $${paramIdx} OR u.email ILIKE $${paramIdx} OR a.error ILIKE $${paramIdx})`,
    );
    params.push(term);
    paramIdx++;
  }

  return { ok: true, conditions, params, paramIdx };
}
