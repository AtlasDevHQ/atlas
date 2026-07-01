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

import type { CliRestErrorCode, ExecuteSqlRestResponse } from "@useatlas/types";
import { ExecuteSqlRestResponseSchema } from "@useatlas/schemas";
import { credentialHeaders, type CliCredential } from "./credential";
import { asRecord, isAbortOrTimeout, serverMessage, unreachableMessage, type FetchImpl } from "./http";

/**
 * The server `error`-field discriminators this client branches on, pinned to the
 * shared `CliRestErrorCode` registry (`satisfies Record<…, CliRestErrorCode>`)
 * so the CLI's branch literals can't drift from the shared vocabulary — renaming
 * a registry code breaks this map at compile time.
 */
const ERR = {
  badRequest: "bad_request",
} as const satisfies Record<string, CliRestErrorCode>;

/** The kinds of failure a raw-SQL call can surface, each with an actionable message. */
export type SqlErrorKind =
  | "unauthorized" // 401 — bearer missing/expired
  | "forbidden" // 403 — billing block, RLS-denied, or raw SQL disabled by a workspace admin (#4095)
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

/**
 * The successful raw-SQL result shape. Aliases the shared
 * {@link ExecuteSqlRestResponse} wire type (the SSOT in `@useatlas/types`) so
 * the CLI and the route can't drift; kept under the local name so command-layer
 * imports stay stable.
 */
export type SqlRunResult = ExecuteSqlRestResponse;

export interface SqlClientOptions {
  /** Normalized Atlas API base URL (no trailing slash). */
  readonly baseUrl: string;
  /**
   * The workspace credential — a session bearer XOR a workspace API key (never
   * both), modeled by {@link CliCredential} so it is structurally impossible to
   * construct with neither (the empty-`Bearer` footgun) or both.
   */
  readonly credential: CliCredential;
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

/**
 * Execute one validated SELECT against the bound workspace via
 * `POST /api/v1/execute-sql`, mapping every documented failure status onto a
 * typed {@link SqlCliError} with an actionable message.
 */
export async function runSql(opts: SqlClientOptions, args: RunSqlArgs): Promise<SqlRunResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 60_000;

  let res: Response;
  try {
    res = await fetchImpl(`${opts.baseUrl}/api/v1/execute-sql`, {
      method: "POST",
      headers: {
        ...credentialHeaders(opts.credential),
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
    if (isAbortOrTimeout(err)) {
      throw new SqlCliError(
        "network",
        `Timed out after ${Math.round(timeoutMs / 1000)}s running the query.`,
      );
    }
    throw new SqlCliError("network", unreachableMessage(opts.baseUrl, err));
  }

  if (res.ok) {
    // intentionally ignored: a non-JSON 2xx body becomes `undefined` and fails
    // the schema parse below — surfaced as a typed error, never silent garbage.
    const raw = await res.json().catch(() => undefined);
    // Validate the 200 against the shared wire schema (the SSOT). A shape
    // mismatch is a server bug / version skew — surface it rather than returning
    // a half-filled result the renderer would silently mangle.
    const parsed = ExecuteSqlRestResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new SqlCliError(
        "request_failed",
        "The Atlas API returned an unexpected response shape for the query result. Update the CLI, or check the server logs.",
      );
    }
    return parsed.data;
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
      // Billing block, RLS-denied, or raw SQL disabled for the workspace by an
      // admin (#4095) — surface the server's message (it carries the actionable
      // remedy, e.g. trial-expired guidance, the RLS reason, or "use `atlas
      // query`").
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
      if (body.error === ERR.badRequest) {
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
