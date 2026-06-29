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

import { asRecord, isAbortOrTimeout, serverMessage, unreachableMessage, type FetchImpl } from "./http";

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
    if (isAbortOrTimeout(err)) {
      throw new DatasourceCliError(
        "network",
        `Timed out after ${Math.round(timeoutMs / 1000)}s trying to ${spec.operation}.`,
      );
    }
    throw new DatasourceCliError("network", unreachableMessage(opts.baseUrl, err));
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

// ---------------------------------------------------------------------------
// profile — POST /api/v1/datasources/{id}/profile (#4052)
//
// The profile route is LONG-RUNNING and STREAMS newline-delimited JSON
// (application/x-ndjson): a `start` event, one `table` event per profiled
// table, then a terminal `result` or `error` event. Unlike the lifecycle
// subcommands above (which buffer a single JSON body), this consumer reads the
// stream line by line, forwards progress to an optional reporter so the CLI can
// render it live, and resolves with the terminal result. Pre-stream gate
// failures (auth/billing/role/not-found/reconnect) come back as ordinary HTTP
// statuses BEFORE the stream — mapped to a typed {@link DatasourceCliError}
// exactly like the lifecycle ops. A failure that surfaces AFTER the stream
// opened rides as a terminal `error` event and is mapped to the same error type.
//
// Cancellation: the caller passes an `AbortSignal` (wired to SIGINT in the
// command). Aborting closes the connection; the server observes the disconnect
// and cooperatively unwinds the profile. The consumer treats an abort as a
// clean stop, not a failure.
// ---------------------------------------------------------------------------

/** A per-table progress event surfaced to the reporter as the stream arrives. */
export interface ProfileTableEvent {
  readonly name: string;
  readonly index: number;
  readonly total: number;
  readonly status: "done" | "error";
  readonly error?: string;
}

/** Live progress sink — the command wires this to the shared progress tracker. */
export interface ProfileReporter {
  onStart(total: number): void;
  onTable(event: ProfileTableEvent): void;
}

/** The terminal `result` event — the generated (draft) semantic layer summary. */
export interface ProfileResult {
  readonly id: string;
  readonly queryable: boolean;
  readonly persisted: boolean;
  readonly persistedStatus?: string;
  readonly entitiesGenerated: number;
  readonly metricsGenerated: number;
  readonly tables: readonly string[];
  readonly profilingErrors: number;
  readonly incomplete: boolean;
  readonly incompleteTables?: readonly string[];
  readonly elapsedMs: number;
}

export interface ProfileDatasourceArgs {
  readonly id: string;
  /** Optional profiling schema/database/dataset override; omit for the connection's default. */
  readonly schema?: string;
  /** Live progress sink; omit to consume the stream silently. */
  readonly reporter?: ProfileReporter;
  /** Cancellation signal — aborting (Ctrl-C) stops the profile cleanly. */
  readonly signal?: AbortSignal;
}

function asProfileResult(e: Record<string, unknown>): ProfileResult {
  return {
    id: typeof e.id === "string" ? e.id : "",
    queryable: Boolean(e.queryable),
    persisted: Boolean(e.persisted),
    ...(typeof e.persistedStatus === "string" ? { persistedStatus: e.persistedStatus } : {}),
    entitiesGenerated: typeof e.entitiesGenerated === "number" ? e.entitiesGenerated : 0,
    metricsGenerated: typeof e.metricsGenerated === "number" ? e.metricsGenerated : 0,
    tables: Array.isArray(e.tables) ? (e.tables as string[]) : [],
    profilingErrors: typeof e.profilingErrors === "number" ? e.profilingErrors : 0,
    incomplete: Boolean(e.incomplete),
    ...(Array.isArray(e.incompleteTables) ? { incompleteTables: e.incompleteTables as string[] } : {}),
    elapsedMs: typeof e.elapsedMs === "number" ? e.elapsedMs : 0,
  };
}

/**
 * Profile a datasource over `POST /api/v1/datasources/{id}/profile`, consuming
 * the NDJSON progress stream and resolving with the terminal {@link ProfileResult}.
 * Pre-stream gate failures map to a typed {@link DatasourceCliError}; a terminal
 * `error` event (a failure after the stream opened) maps to one too.
 */
export async function profileDatasource(
  opts: DatasourceClientOptions,
  args: ProfileDatasourceArgs,
): Promise<ProfileResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await fetchImpl(`${opts.baseUrl}/api/v1/datasources/${encodeURIComponent(args.id)}/profile`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args.schema ? { schema: args.schema } : {}),
      // No request timeout — profiling a large datasource is legitimately long.
      // Cancellation rides on the caller's AbortSignal (SIGINT), not a deadline.
      ...(args.signal ? { signal: args.signal } : {}),
    });
  } catch (err) {
    // No request timeout here (profiling is legitimately long), so an abort is
    // ALWAYS a caller cancellation (SIGINT), never a deadline — kept inline as a
    // distinct "cancelled" message rather than the shared timeout path.
    if (err instanceof Error && err.name === "AbortError") {
      throw new DatasourceCliError("network", `Profiling of "${args.id}" was cancelled.`);
    }
    throw new DatasourceCliError("network", unreachableMessage(opts.baseUrl, err));
  }

  // Pre-stream gate failure (auth/billing/role/not-found/unsupported/reconnect)
  // — an ordinary JSON error body, mapped exactly like the lifecycle ops.
  if (!res.ok) {
    // intentionally ignored: a non-JSON error body falls back to the HTTP-status message.
    const body = asRecord(await res.json().catch(() => ({})));
    switch (res.status) {
      case 401:
        throw new DatasourceCliError(
          "unauthorized",
          "Your session is no longer valid. Run `atlas login` again.",
        );
      case 403:
        if (body.error === "mfa_enrollment_required") {
          throw new DatasourceCliError(
            "mfa_required",
            "Admin actions require two-factor authentication. Enroll an authenticator or passkey in the Atlas console, then retry.",
          );
        }
        // A billing block also returns 403 (trial-expired etc.); surface the
        // server's actionable message for those. A bare role denial gets the
        // admin-role guidance the lifecycle ops use.
        if (body.error === "forbidden_role") {
          throw new DatasourceCliError(
            "forbidden",
            `Cannot profile datasource "${args.id}": the workspace admin role is required. Your login does not carry it — ask a workspace admin to run this, or sign in with an admin account (\`atlas login\`).`,
          );
        }
        throw new DatasourceCliError("forbidden", serverMessage(body, res.status));
      case 400:
        if (body.error === "bad_request") {
          throw new DatasourceCliError(
            "no_workspace",
            "Your login is not bound to a workspace. Single-workspace accounts bind automatically; in-flow workspace selection for multi-workspace accounts is coming soon (ADR-0026).",
          );
        }
        throw new DatasourceCliError("request_failed", serverMessage(body, res.status));
      case 404:
        throw new DatasourceCliError(
          "not_found",
          `Datasource "${args.id}" not found in this workspace. Run \`atlas datasource list\` to see configured datasources.`,
        );
      case 409:
        throw new DatasourceCliError("conflict", serverMessage(body, res.status));
      default:
        throw new DatasourceCliError("request_failed", serverMessage(body, res.status));
    }
  }

  if (!res.body) {
    throw new DatasourceCliError("request_failed", "The profile stream returned an empty body.");
  }

  // Consume the NDJSON stream line by line. `result` is the terminal success;
  // an `error` event is the terminal failure. We tolerate a partial trailing
  // line across chunk boundaries by buffering until a newline.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: ProfileResult | undefined;

  const handleLine = (line: string): void => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let event: Record<string, unknown>;
    try {
      event = asRecord(JSON.parse(trimmed));
    } catch {
      // intentionally ignored: a malformed line in the progress stream is
      // non-fatal — skip it rather than aborting a profile that may still
      // deliver its terminal result.
      return;
    }
    switch (event.type) {
      case "start":
        args.reporter?.onStart(typeof event.total === "number" ? event.total : 0);
        return;
      case "table":
        args.reporter?.onTable({
          name: typeof event.name === "string" ? event.name : "",
          index: typeof event.index === "number" ? event.index : 0,
          total: typeof event.total === "number" ? event.total : 0,
          status: event.status === "error" ? "error" : "done",
          ...(typeof event.error === "string" ? { error: event.error } : {}),
        });
        return;
      case "result":
        result = asProfileResult(event);
        return;
      case "error": {
        // A failure after the stream opened — map to the same typed error the
        // pre-stream branch produces so the command's handler renders it uniformly.
        // `reconnect_required` keeps its distinct `conflict` kind (the reconnect
        // remedy differs); every other terminal error (`profiling_failed`,
        // `internal_error`, anything future) is a `request_failed` the handler
        // surfaces with the server's message verbatim.
        const message = serverMessage(event, 0);
        const kind = event.error === "reconnect_required" ? "conflict" : "request_failed";
        throw new DatasourceCliError(kind, message);
      }
      default:
        // intentionally ignored: an unknown event type is forward-compatible —
        // a future server may add events this client version doesn't render.
        return;
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        handleLine(line);
      }
    }
    // Flush any trailing line without a final newline.
    if (buffer.length > 0) handleLine(buffer);
  } catch (err) {
    if (err instanceof DatasourceCliError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new DatasourceCliError("network", `Profiling of "${args.id}" was cancelled.`);
    }
    throw new DatasourceCliError(
      "network",
      `The profile stream failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    // Best-effort: release the reader so an aborted stream doesn't leak.
    reader.releaseLock();
  }

  if (!result) {
    throw new DatasourceCliError(
      "request_failed",
      `Profiling of "${args.id}" ended without a result. The server may have closed the stream early — check the server logs and retry.`,
    );
  }
  return result;
}
