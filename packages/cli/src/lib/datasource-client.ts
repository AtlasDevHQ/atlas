/**
 * `atlas datasource` HTTP client (#4044 / ADR-0025 sub-decision 3).
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
  | "conflict" // 409 — datasource id already exists
  | "connection_failed" // 400 — pre-flight connection test failed
  | "plan_limit" // 429 — workspace plan's datasource cap reached
  | "billing_unavailable" // 503 — plan-limit check couldn't run (fail-closed)
  | "not_available" // 404 — connection management needs an internal DB
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
      // The create route's pre-flight test runs server-side and returns
      // `connection_failed` with the upstream driver error scrubbed of any DSN.
      // Surface it as a distinct kind so `create` exits with a fix-the-URL hint
      // rather than a generic request failure.
      if (body.error === "connection_failed") {
        throw new DatasourceCliError("connection_failed", serverMessage(body, res.status));
      }
      throw new DatasourceCliError("request_failed", serverMessage(body, res.status));
    case 404:
      // The create route 404s with `not_available` when the deployment has no
      // internal DB (DATABASE_URL) — datasource provisioning isn't possible
      // there. Distinct from the id-not-found 404 the lifecycle ops surface.
      if (body.error === "not_available") {
        throw new DatasourceCliError("not_available", serverMessage(body, res.status));
      }
      throw new DatasourceCliError("not_found", serverMessage(body, res.status));
    case 409:
      throw new DatasourceCliError("conflict", serverMessage(body, res.status));
    case 429:
      // The plan-limit denial (`plan_limit_exceeded`) shares the 429 status with
      // rate limiting. Distinguish it so the message points at the plan cap, not
      // "slow down". A bare 429 (rate limit) falls through to request_failed.
      if (body.error === "plan_limit_exceeded") {
        throw new DatasourceCliError("plan_limit", serverMessage(body, res.status));
      }
      throw new DatasourceCliError("request_failed", serverMessage(body, res.status));
    case 503:
      // Fail-closed billing/plan-limit check fault (#3433): a transient infra
      // problem verifying the cap, not an upgrade prompt — tell the user to retry.
      throw new DatasourceCliError("billing_unavailable", serverMessage(body, res.status));
    default:
      throw new DatasourceCliError("request_failed", serverMessage(body, res.status));
  }
}

// ---------------------------------------------------------------------------
// One function per subcommand — each maps to exactly one existing REST route.
// ---------------------------------------------------------------------------

/**
 * The non-secret shape of a `create` request. The connection `url` carries the
 * secret (it embeds the password) and is captured on stdin / from an env var by
 * the command layer — it is NEVER a member of this metadata struct and never
 * appears in argv, so a struct/log of these fields can't leak the credential.
 */
export interface CreateDatasourceMetadata {
  /** The datasource id (lowercase alphanumeric + hyphens/underscores). */
  readonly id: string;
  /** Optional human-readable description. */
  readonly description?: string;
  /** Optional schema (e.g. a Postgres schema name). */
  readonly schema?: string;
  /** Attach to an existing connection group/environment by id (mutually exclusive with newGroupName). */
  readonly connectionGroupId?: string;
  /** Create a new inline group/environment (mutually exclusive with connectionGroupId). */
  readonly newGroupName?: string;
}

/**
 * POST /api/v1/admin/connections — provision a new datasource (ADR-0025 §4).
 *
 * The secret-bearing `url` is passed separately from {@link CreateDatasourceMetadata}
 * to make it structurally impossible to log the credential alongside the
 * metadata. The route runs the pre-flight connection test, encrypts the url at
 * rest via `encryptSecretFields`, lands the row as a draft, and audits the write
 * as `origin=cli` (resolved server-side from the credential, never a request
 * field). Returns the created datasource detail (with a masked url) on 201.
 */
export async function createDatasource(
  opts: DatasourceClientOptions,
  metadata: CreateDatasourceMetadata,
  url: string,
): Promise<Record<string, unknown>> {
  // The url goes ONLY into the request body (sent over the authenticated
  // transport), never into a flag, a log line, or a thrown error message.
  const requestBody: Record<string, unknown> = {
    id: metadata.id,
    url,
    ...(metadata.description !== undefined ? { description: metadata.description } : {}),
    ...(metadata.schema !== undefined ? { schema: metadata.schema } : {}),
    ...(metadata.connectionGroupId !== undefined
      ? { connectionGroupId: metadata.connectionGroupId }
      : {}),
    ...(metadata.newGroupName !== undefined ? { newGroupName: metadata.newGroupName } : {}),
  };
  const result = asRecord(
    await request(opts, {
      method: "POST",
      path: "/api/v1/admin/connections",
      body: requestBody,
      operation: "create datasource",
    }),
  );
  // Defense in depth: the route returns a masked-url detail and MUST NOT echo
  // the plaintext `url`. Strip any `url` key here so a future server regression
  // can't leak the secret through this command's `--json` (verbatim) output or a
  // redirected log. The `maskedUrl` field the route does return is untouched.
  if ("url" in result) {
    delete result.url;
  }
  return result;
}

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
