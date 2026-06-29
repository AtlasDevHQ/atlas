/**
 * `atlas sql` HTTP client (#4047 / ADR-0027).
 *
 * A thin, transport-only client over the raw-SQL REST route
 * (`POST /api/v1/execute-sql`) — no duplicated business logic. The server owns
 * the entire security boundary: the 4-layer validation pipeline, table
 * whitelist, RLS injection, auto-LIMIT, statement timeout, billing gate-0, and
 * the `origin=cli` audit. This maps one workspace CLI subcommand onto one route
 * and surfaces the typed outcome.
 *
 * Authorization rides on one of two workspace credential classes, never both:
 *  - the `atlas login` device-flow SESSION bearer (interactive / ambient reuse),
 *    sent as `Authorization: Bearer <token>`; OR
 *  - a workspace-scoped API key for UNATTENDED CI (#4046), sent as
 *    `x-api-key: <key>` (the Better Auth `apiKey()` plugin's header).
 * Either way the route resolves the credential live to its bound workspace org
 * (member floor — no role gating on this route), runs billing gate-0, and
 * executes the SQL against ONLY the bound workspace — the CLI never re-derives
 * any of that, and crucially never sends an org/workspace field (workspace
 * isolation derives from the credential, ADR-0027 §5).
 *
 * `fetch` is injectable so the route mapping + status-code handling are
 * unit-testable without a live server (mirrors `metric-client.ts`). No function
 * here calls `process.exit` or `console`; the command handler owns presentation.
 */

type FetchImpl = typeof fetch;

/** The kinds of failure a raw-SQL call can surface, each with an actionable message. */
export type SqlErrorKind =
  | "unauthorized" // 401 — bearer missing/expired
  | "forbidden" // 403 — billing block or RLS-denied
  | "no_workspace" // 400 — credential has no bound workspace
  | "workspace_not_found" // 404 — billing block: the workspace was deleted
  | "invalid_sql" // 400 — rejected by the validation pipeline (DML/whitelist/unparseable)
  | "approval_required" // 409 — the SQL tripped an approval rule
  | "rate_limited" // 429 — per-identity bucket or workspace throttle
  | "unavailable" // 503 — datasource/enterprise subsystem unavailable
  | "request_failed" // other non-2xx
  | "network"; // fetch threw / timed out

/** A raw-SQL failure carrying a typed {@link SqlErrorKind}. */
export class SqlCliError extends Error {
  constructor(
    readonly kind: SqlErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "SqlCliError";
  }
}

/** The successful raw-SQL result shape (mirrors the route's response). */
export interface SqlRunResult {
  readonly columns: string[];
  readonly rows: Record<string, unknown>[];
  readonly rowCount: number;
  /** True when the result hit the auto-LIMIT row cap (more rows exist upstream). */
  readonly truncated: boolean;
  readonly executionMs: number;
  readonly executedAt: string;
}

export interface SqlClientOptions {
  /** Normalized Atlas API base URL (no trailing slash). */
  readonly baseUrl: string;
  /**
   * The stored `atlas login` session bearer (`Authorization: Bearer`). Mutually
   * exclusive with {@link apiKey}; exactly one credential must be supplied.
   */
  readonly token?: string;
  /**
   * A workspace-scoped API key for unattended CI (#4046), sent as `x-api-key`.
   * Mutually exclusive with {@link token}.
   */
  readonly apiKey?: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: FetchImpl;
  /** Per-request timeout in ms (default 60s — a SQL query can be slower than metadata). */
  readonly timeoutMs?: number;
}

export interface RunSqlArgs {
  readonly sql: string;
  /** Optional explicit connection id; resolved against the bound workspace server-side. */
  readonly connectionId?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * Pull the server's actionable message off a JSON error body, falling back to
 * the HTTP status. Appends the server's `requestId` (Atlas error envelopes carry
 * one) so a bug report stays log-correlatable operator-side.
 */
function serverMessage(body: Record<string, unknown>, status: number): string {
  const base =
    typeof body.message === "string" && body.message.length > 0
      ? body.message
      : typeof body.error === "string" && body.error.length > 0
        ? body.error
        : `HTTP ${status}`;
  return typeof body.requestId === "string" && body.requestId.length > 0
    ? `${base} (request ${body.requestId})`
    : base;
}

/**
 * Execute one validated SELECT against the bound workspace via
 * `POST /api/v1/execute-sql`, mapping every documented failure status onto a
 * typed {@link SqlCliError} with an actionable message.
 */
export async function runSql(opts: SqlClientOptions, args: RunSqlArgs): Promise<SqlRunResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 60_000;

  // Exactly one credential class. A workspace API key (#4046) goes on `x-api-key`
  // (the apiKey() plugin header); a device-flow session goes on `Authorization:
  // Bearer`. Never send both — the server resolves whichever it sees.
  const authHeader: Record<string, string> = opts.apiKey
    ? { "x-api-key": opts.apiKey }
    : { Authorization: `Bearer ${opts.token ?? ""}` };

  let res: Response;
  try {
    res = await fetchImpl(`${opts.baseUrl}/api/v1/execute-sql`, {
      method: "POST",
      headers: {
        ...authHeader,
        "Content-Type": "application/json",
      },
      // ONLY sql (+ optional connectionId) — never an org/workspace field. The
      // server derives the workspace from the credential (ADR-0027 §5).
      body: JSON.stringify(
        args.connectionId ? { sql: args.sql, connectionId: args.connectionId } : { sql: args.sql },
      ),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new SqlCliError(
        "network",
        `Timed out after ${Math.round(timeoutMs / 1000)}s running the query.`,
      );
    }
    throw new SqlCliError(
      "network",
      `Could not reach the Atlas API at ${opts.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (res.ok) {
    // intentionally ignored: a 2xx with a non-JSON body is unexpected from this
    // route, but degrade to an empty record rather than crash — the field reads
    // below tolerate missing values.
    const body = asRecord(await res.json().catch(() => ({})));
    return {
      columns: Array.isArray(body.columns) ? (body.columns as string[]) : [],
      rows: Array.isArray(body.rows) ? (body.rows as Record<string, unknown>[]) : [],
      rowCount: typeof body.rowCount === "number" ? body.rowCount : 0,
      truncated: Boolean(body.truncated),
      executionMs: typeof body.executionMs === "number" ? body.executionMs : 0,
      executedAt: typeof body.executedAt === "string" ? body.executedAt : "",
    };
  }

  // intentionally ignored: an error body that isn't JSON falls back to the
  // HTTP-status message below via the empty record.
  const body = asRecord(await res.json().catch(() => ({})));

  switch (res.status) {
    case 401:
      throw new SqlCliError(
        "unauthorized",
        "Your session is no longer valid. Run `atlas login` again.",
      );
    case 403:
      // Billing block or RLS-denied — surface the server's message (it carries
      // the actionable remedy, e.g. trial-expired guidance or the RLS reason).
      throw new SqlCliError("forbidden", serverMessage(body, res.status));
    case 404:
      // The ONLY 404 this route emits is a billing-gate block for a deleted
      // workspace (`workspace_deleted`). Distinct from a 403 billing/RLS block:
      // the remedy is "this workspace no longer exists", not "fix billing".
      // Surface the gate's verbatim message.
      throw new SqlCliError("workspace_not_found", serverMessage(body, res.status));
    case 409:
      throw new SqlCliError("approval_required", serverMessage(body, res.status));
    case 429:
      throw new SqlCliError("rate_limited", serverMessage(body, res.status));
    case 400:
      if (body.error === "bad_request") {
        throw new SqlCliError(
          "no_workspace",
          "Your login is not bound to a workspace. Single-workspace accounts bind automatically; in-flow workspace selection for multi-workspace accounts is coming soon (ADR-0026).",
        );
      }
      // invalid_sql / plugin_rejected / query_failed — the validation pipeline
      // (or the datasource) rejected the SQL. The server message names the cause.
      throw new SqlCliError("invalid_sql", serverMessage(body, res.status));
    case 503:
      throw new SqlCliError("unavailable", serverMessage(body, res.status));
    default:
      throw new SqlCliError("request_failed", serverMessage(body, res.status));
  }
}
