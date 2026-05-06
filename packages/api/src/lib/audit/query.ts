/**
 * Audit-log filter builder shared by `/api/v1/admin/audit` list +
 * export endpoints. Lives here (not in the route file) so #2067's
 * filter shape — `actorKind`, `clientId`, `tool` — is testable in
 * isolation and reusable by any future surface that pivots on the
 * same audit dimensions (CSV export, OTel-driven dashboards, etc).
 *
 * Builds parameterized WHERE conditions. Every filter is optional and
 * AND-combined. The result is a single read-only SELECT — no DML, no
 * statement chaining — and the table-allowlist guard at the API
 * boundary ensures the only table reachable here is `audit_log` (plus
 * its `LEFT JOIN "user"` for the search filter). `org_id` is always
 * `$1` so callers can rely on a stable index.
 */

/**
 * Escape ILIKE special characters so they are matched literally. Inline
 * here (rather than importing from `api/routes/shared-schemas`) because
 * CLAUDE.md forbids `lib/*` from importing the route layer.
 */
function escapeIlike(s: string): string {
  return s.replace(/[%_\\]/g, "\\$&");
}

/**
 * Successful build result. `params` has `paramIdx - 1` entries when
 * `paramIdx` is the next $-placeholder the caller can use for any
 * trailing arguments (LIMIT/OFFSET on the list endpoint, LIMIT on
 * export). `conditions` always includes the `org_id` and soft-delete
 * predicates as the first two entries.
 */
export type AuditFilterOk = {
  ok: true;
  conditions: string[];
  params: unknown[];
  paramIdx: number;
};

/**
 * Failed build — invalid filter input from the caller. The route
 * propagates `error` / `message` / `status` straight into the JSON
 * response so every 400 carries actionable copy without a second
 * round-trip through the error mapper.
 */
export type AuditFilterErr = {
  ok: false;
  error: string;
  message: string;
  status: 400;
};

export type AuditFilterResult = AuditFilterOk | AuditFilterErr;

/**
 * Reader for query-string params. Routes pass `(k) => c.req.query(k)`;
 * tests can pass a plain Map adapter. Decoupling from Hono keeps this
 * module mock-free in unit tests.
 */
export type QueryReader = (key: string) => string | undefined;

/**
 * Build WHERE conditions for audit list + export endpoints. Returns
 * `ok: false` on the first invalid input so the caller can short-
 * circuit with a 400 — no partial filtering, no silent drops.
 *
 * Keep the order: `org_id` → soft-delete → caller-supplied filters.
 * The two leading predicates pin every row to the active workspace
 * and exclude retention-purged rows; reordering breaks the index hit
 * on `idx_audit_log_org`.
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

  // ── #2067 — MCP filter shape ────────────────────────────────────
  // `actorKind` is an open-ended discriminator (today: `mcp` is the
  // only writer; `human` / `agent` / `scheduler` are reserved). We
  // accept any non-empty string so future writers can opt in without
  // a route-level whitelist. The frontend renders the canonical four
  // options in the dropdown.
  const actorKind = query("actorKind");
  if (actorKind) {
    conditions.push(`a.actor_kind = $${paramIdx++}`);
    params.push(actorKind);
  }

  // `clientId` scopes to a specific OAuth client (e.g. `claude-desktop`
  // or a DCR UUID). Only meaningful when actorKind is `mcp`, but we
  // don't enforce the cross-field constraint server-side — pairing
  // them is a UI affordance.
  const clientId = query("clientId");
  if (clientId) {
    conditions.push(`a.client_id = $${paramIdx++}`);
    params.push(clientId);
  }

  // `tool` filters by the dispatched tool name (`executeSQL`,
  // `runMetric`, etc). `tool_name` was populated by the MCP path in
  // `tools.ts` / `semantic-tools.ts`; non-MCP rows have NULL and
  // won't match — that's the right semantics for a "scope to a tool"
  // filter.
  const tool = query("tool");
  if (tool) {
    conditions.push(`a.tool_name = $${paramIdx++}`);
    params.push(tool);
  }

  // ── End #2067 filters ───────────────────────────────────────────

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
