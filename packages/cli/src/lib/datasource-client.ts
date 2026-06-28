/**
 * `atlas datasource` HTTP client (#4044 / ADR-0026 sub-decision 3).
 *
 * A thin, transport-only client over the EXISTING admin-connection REST routes
 * — there is no duplicated business logic here, the server owns it. The MCP
 * `datasource-tools.ts` reaches the same gated core over its in-process lib
 * seam; list/get/test/archive behave identically across both transports, but
 * `restore` and `delete` deliberately differ because each CLI subcommand maps
 * to its own REST route (see the command module's header for the divergence).
 * Each function maps one workspace CLI subcommand onto one existing route:
 *
 *   list     → GET    /api/v1/admin/connections
 *   get      → GET    /api/v1/admin/connections/{id}
 *   test     → POST   /api/v1/admin/connections/{id}/test
 *   archive  → POST   /api/v1/admin/archive-connection      { connectionId }
 *   restore  → POST   /api/v1/admin/restore-connection      { connectionId }
 *   delete   → DELETE /api/v1/admin/connections/{id}
 *
 * Authorization rides entirely on the `atlas login` workspace credential: the
 * stored Better Auth session bearer (stamped `origin='cli'` server-side) is
 * sent as `Authorization: Bearer <token>`. The routes resolve it live to
 * `{ orgId, role }` through the same gate chain a web admin session clears, so
 * the call operates on ONLY the bound workspace's datasources and is denied
 * (403) when the credential's role isn't admin. The CLI never re-derives any of
 * that — it just surfaces the typed outcome.
 *
 * `fetch` is injectable so the route mapping + status-code handling are
 * unit-testable without a live server (mirrors `device-flow.ts`). No function
 * here calls `process.exit` or `console`; the command handler owns presentation.
 */

type FetchImpl = typeof fetch;

/** The kinds of failure a datasource call can surface, each with an actionable message. */
export type DatasourceErrorKind =
  | "unauthorized" // 401 — bearer missing/expired
  | "forbidden" // 403 — role lacks admin
  | "mfa_required" // 403 — admin must enroll a second factor first
  | "no_workspace" // 400 — credential has no bound workspace
  | "not_found" // 404 — datasource id not in this workspace
  | "conflict" // 409 — e.g. referenced by a scheduled task
  | "request_failed" // other non-2xx
  | "network"; // fetch threw / timed out

/** A datasource call failure carrying a typed {@link DatasourceErrorKind}. */
export class DatasourceCliError extends Error {
  constructor(
    readonly kind: DatasourceErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "DatasourceCliError";
  }
}

export interface DatasourceClientOptions {
  /** Normalized Atlas API base URL (no trailing slash). */
  readonly baseUrl: string;
  /** The stored `atlas login` session bearer. */
  readonly token: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: FetchImpl;
  /** Per-request timeout in ms (default 30s). */
  readonly timeoutMs?: number;
}

interface RequestSpec {
  readonly method: "GET" | "POST" | "DELETE";
  readonly path: string;
  readonly body?: unknown;
  /** Human-readable operation label woven into error messages, e.g. "archive datasource". */
  readonly operation: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * Pull the server's actionable message off a JSON error body, falling back to
 * the HTTP status. Appends the server's `requestId` (Atlas error envelopes carry
 * one — always on 5xx, and on the 4xx envelopes these admin routes return) so a
 * user's bug report stays log-correlatable operator-side.
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
 * Issue one request against an admin-connection route and return its parsed
 * JSON body, mapping every documented failure status onto a typed
 * {@link DatasourceCliError} with an actionable message. The 403 branch
 * distinguishes the admin-role denial (the admin-role gate this surface is built
 * around — it fires for the read ops too, not just mutations) from the
 * admin-MFA-enrollment gate, since the remedies differ.
 */
async function request(
  opts: DatasourceClientOptions,
  spec: RequestSpec,
): Promise<unknown> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  let res: Response;
  try {
    res = await fetchImpl(`${opts.baseUrl}${spec.path}`, {
      method: spec.method,
      headers: {
        Authorization: `Bearer ${opts.token}`,
        ...(spec.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(spec.body !== undefined ? { body: JSON.stringify(spec.body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new DatasourceCliError(
        "network",
        `Timed out after ${Math.round(timeoutMs / 1000)}s trying to ${spec.operation}.`,
      );
    }
    throw new DatasourceCliError(
      "network",
      `Could not reach the Atlas API at ${opts.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (res.ok) {
    // intentionally ignored: a 2xx with an empty/non-JSON body degrades to {} —
    // callers tolerate missing optional fields rather than crashing on parse.
    return await res.json().catch(() => ({}));
  }

  // intentionally ignored: an error body that isn't JSON falls back to the
  // HTTP-status message below via the empty record.
  const body = asRecord(await res.json().catch(() => ({})));

  switch (res.status) {
    case 401:
      throw new DatasourceCliError(
        "unauthorized",
        "Your session is no longer valid. Run `atlas login` again.",
      );
    case 403: {
      if (body.error === "mfa_enrollment_required") {
        throw new DatasourceCliError(
          "mfa_required",
          "Admin actions require two-factor authentication. Enroll an authenticator or passkey in the Atlas console, then retry.",
        );
      }
      throw new DatasourceCliError(
        "forbidden",
        `Cannot ${spec.operation}: the workspace admin role is required. Your login does not carry it — ask a workspace admin to run this, or sign in with an admin account (\`atlas login\`).`,
      );
    }
    case 400:
      // requireOrgContext returns 400 bad_request when the credential has no
      // bound workspace (a multi-workspace login pending the picker slice).
      if (body.error === "bad_request") {
        throw new DatasourceCliError(
          "no_workspace",
          "Your login is not bound to a workspace. Single-workspace accounts bind automatically; in-flow workspace selection for multi-workspace accounts is coming soon (ADR-0026).",
        );
      }
      throw new DatasourceCliError("request_failed", serverMessage(body, res.status));
    case 404:
      throw new DatasourceCliError("not_found", serverMessage(body, res.status));
    case 409:
      throw new DatasourceCliError("conflict", serverMessage(body, res.status));
    default:
      throw new DatasourceCliError("request_failed", serverMessage(body, res.status));
  }
}

// ---------------------------------------------------------------------------
// One function per subcommand — each maps to exactly one existing REST route.
// ---------------------------------------------------------------------------

/** GET /api/v1/admin/connections — the bound workspace's datasources (credential-free metadata). */
export async function listDatasources(opts: DatasourceClientOptions): Promise<unknown[]> {
  const body = asRecord(
    await request(opts, { method: "GET", path: "/api/v1/admin/connections", operation: "list datasources" }),
  );
  return Array.isArray(body.connections) ? body.connections : [];
}

/** GET /api/v1/admin/connections/{id} — one datasource's detail (masked URL + schema). */
export async function getDatasource(
  opts: DatasourceClientOptions,
  id: string,
): Promise<Record<string, unknown>> {
  return asRecord(
    await request(opts, {
      method: "GET",
      path: `/api/v1/admin/connections/${encodeURIComponent(id)}`,
      operation: "get datasource",
    }),
  );
}

/** POST /api/v1/admin/connections/{id}/test — health-check an existing datasource. */
export async function testDatasource(
  opts: DatasourceClientOptions,
  id: string,
): Promise<Record<string, unknown>> {
  return asRecord(
    await request(opts, {
      method: "POST",
      path: `/api/v1/admin/connections/${encodeURIComponent(id)}/test`,
      operation: "test datasource",
    }),
  );
}

/** POST /api/v1/admin/archive-connection — soft-archive (reversible via restore). */
export async function archiveDatasource(
  opts: DatasourceClientOptions,
  id: string,
): Promise<Record<string, unknown>> {
  return asRecord(
    await request(opts, {
      method: "POST",
      path: "/api/v1/admin/archive-connection",
      body: { connectionId: id },
      operation: "archive datasource",
    }),
  );
}

/** POST /api/v1/admin/restore-connection — un-archive a previously archived datasource. */
export async function restoreDatasource(
  opts: DatasourceClientOptions,
  id: string,
): Promise<Record<string, unknown>> {
  return asRecord(
    await request(opts, {
      method: "POST",
      path: "/api/v1/admin/restore-connection",
      body: { connectionId: id },
      operation: "restore datasource",
    }),
  );
}

/** DELETE /api/v1/admin/connections/{id} — remove the datasource (the route soft-archives). */
export async function deleteDatasource(
  opts: DatasourceClientOptions,
  id: string,
): Promise<Record<string, unknown>> {
  return asRecord(
    await request(opts, {
      method: "DELETE",
      path: `/api/v1/admin/connections/${encodeURIComponent(id)}`,
      operation: "delete datasource",
    }),
  );
}
