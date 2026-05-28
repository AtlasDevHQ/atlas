/**
 * `openapi-client` — executes a single normalized operation over HTTP.
 *
 * `executeOperation(graph, operationId, params, resolvedAuth, opts)` builds the
 * request from the {@link OperationGraph} (path/query/header encoding per the
 * parameter's location, auth applied per the operation's security scheme),
 * fires one `fetch`, and returns `{ status, headers, body }`. It is a transport
 * primitive: NO agent logic, NO caching, NO pagination, NO retry. A non-2xx
 * response is returned as an {@link OperationResult}, not thrown — interpreting
 * status is the caller's job.
 *
 * Per-request timeout is enforced via `AbortSignal.timeout`. `Retry-After` is
 * parsed per RFC 9110 §10.2.3 and surfaced on the result (the client honors it
 * by reporting it; retry scheduling belongs to a later layer). The error
 * envelope + retry-after parsing mirror the Twenty client (`plugins/twenty/
 * src/client.ts`, PR #2865) — the well-understood prior art for this milestone.
 *
 * Auth: `bearer` / `basic` / `apiKey-header` / `apiKey-query` are applied.
 * `oauth2` / `openIdConnect` are normalized by `spec.ts` but their flows are
 * deferred to slice 6 — pass `{ kind: "bearer", token }` once a token is
 * obtained out of band.
 */
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  OpenApiClientError,
  type ExecuteOptions,
  type Operation,
  type OperationGraph,
  type OperationParams,
  type OperationResult,
  type ResolvedAuth,
} from "./types";

// ─────────────────────────────────────────────────────────────────────
//  Public entry point
// ─────────────────────────────────────────────────────────────────────

/**
 * Execute one operation from the graph against its target.
 *
 * @throws {OpenApiClientError} for client-side faults (unknown operation,
 *   missing base URL, missing path param, missing auth placement) and transport
 *   faults (timeout, network). A non-2xx HTTP response is NOT an error — it is
 *   returned as the result.
 */
export async function executeOperation(
  graph: OperationGraph,
  operationId: string,
  params: OperationParams,
  resolvedAuth: ResolvedAuth,
  opts: ExecuteOptions = {},
): Promise<OperationResult> {
  const operation = graph.operations.get(operationId);
  if (operation === undefined) {
    throw new OpenApiClientError({
      reason: "unknown-operation",
      operationId,
      status: 0,
      message:
        `Unknown operationId "${operationId}". It is not present in the probed operation graph ` +
        `(${graph.operations.size} operations available). Refusing to dispatch a fabricated operation.`,
    });
  }

  const baseUrl = opts.baseUrl ?? graph.servers[0]?.url;
  if (baseUrl === undefined || baseUrl.length === 0) {
    throw new OpenApiClientError({
      reason: "missing-base-url",
      operationId,
      status: 0,
      message:
        `No base URL for "${operationId}": the document declares no servers[0].url and no ` +
        `baseUrl override was provided. Pass { baseUrl } in the execute options.`,
    });
  }

  const url = buildUrl(baseUrl, operation, params, graph, resolvedAuth);
  const headers = buildHeaders(operation, params, graph, resolvedAuth);
  const { body, hasBody } = buildBody(operation, params, headers);

  const timeoutMs = opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      method: operation.method,
      headers,
      ...(hasBody ? { body } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw classifyTransportError(err, operationId, timeoutMs);
  }

  return readResult(response, operationId);
}

// ─────────────────────────────────────────────────────────────────────
//  URL + query building
// ─────────────────────────────────────────────────────────────────────

function buildUrl(
  baseUrl: string,
  operation: Operation,
  params: OperationParams,
  graph: OperationGraph,
  resolvedAuth: ResolvedAuth,
): URL {
  const resolvedPath = substitutePathParams(operation, params.path);
  const url = new URL(joinUrl(baseUrl, resolvedPath));

  if (params.query) {
    for (const [key, value] of Object.entries(params.query)) {
      appendQueryValue(url.searchParams, key, value);
    }
  }

  applyQueryAuth(url.searchParams, operation, graph, resolvedAuth);
  return url;
}

/** Replace every `{token}` in the path; an unfilled token is a fail-loud fault. */
function substitutePathParams(
  operation: Operation,
  pathParams: OperationParams["path"],
): string {
  return operation.path.replace(/\{([^}]+)\}/g, (_, token: string) => {
    const value = pathParams?.[token];
    if (value === undefined) {
      throw new OpenApiClientError({
        reason: "missing-path-param",
        operationId: operation.operationId,
        status: 0,
        message: `Operation "${operation.operationId}" requires path parameter "${token}" but it was not provided.`,
      });
    }
    return encodeURIComponent(String(value));
  });
}

/** Join a base URL and a path with exactly one slash between them. */
function joinUrl(baseUrl: string, pathSegment: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const segment = pathSegment.startsWith("/") ? pathSegment : `/${pathSegment}`;
  return `${base}${segment}`;
}

/** Append a query value; arrays explode (repeat the key); `undefined` is dropped. */
function appendQueryValue(
  search: URLSearchParams,
  key: string,
  value: string | number | boolean | ReadonlyArray<string | number | boolean> | undefined,
): void {
  if (value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) search.append(key, String(item));
    return;
  }
  search.append(key, String(value as string | number | boolean));
}

// ─────────────────────────────────────────────────────────────────────
//  Headers + auth
// ─────────────────────────────────────────────────────────────────────

function buildHeaders(
  operation: Operation,
  params: OperationParams,
  graph: OperationGraph,
  resolvedAuth: ResolvedAuth,
): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
  };

  // `in: cookie` parameters are normalized into the graph but not emitted by
  // this slice — there is no cookie bucket on OperationParams. A consumer that
  // needs cookie auth must supply it via a header param for now.
  if (params.header) {
    for (const [key, value] of Object.entries(params.header)) {
      headers[key] = String(value);
    }
  }

  applyHeaderAuth(headers, operation, graph, resolvedAuth);
  return headers;
}

function applyHeaderAuth(
  headers: Record<string, string>,
  operation: Operation,
  graph: OperationGraph,
  resolvedAuth: ResolvedAuth,
): void {
  switch (resolvedAuth.kind) {
    case "none":
      return;
    case "bearer":
      headers["Authorization"] = `Bearer ${resolvedAuth.token}`;
      return;
    case "basic": {
      const encoded = Buffer.from(
        `${resolvedAuth.username}:${resolvedAuth.password}`,
        "utf8",
      ).toString("base64");
      headers["Authorization"] = `Basic ${encoded}`;
      return;
    }
    case "apiKey": {
      const placement = resolveApiKeyPlacement(operation, graph, resolvedAuth);
      if (placement.in === "header") {
        headers[placement.name] = resolvedAuth.value;
      }
      return;
    }
  }
}

function applyQueryAuth(
  search: URLSearchParams,
  operation: Operation,
  graph: OperationGraph,
  resolvedAuth: ResolvedAuth,
): void {
  if (resolvedAuth.kind !== "apiKey") return;
  const placement = resolveApiKeyPlacement(operation, graph, resolvedAuth);
  if (placement.in === "query") {
    search.set(placement.name, resolvedAuth.value);
  }
}

/**
 * Decide where an apiKey credential goes. An explicit `placement` override wins
 * (slice 2 stores placement in config); otherwise the placement is read from the
 * operation's apiKey security scheme — `parameterName` is guaranteed present on
 * those scheme arms by the parse boundary, so no runtime presence check is
 * needed. If neither is available, fail loud — we will not guess a name.
 */
function resolveApiKeyPlacement(
  operation: Operation,
  graph: OperationGraph,
  auth: Extract<ResolvedAuth, { kind: "apiKey" }>,
): { in: "header" | "query"; name: string } {
  if (auth.placement !== undefined) {
    return auth.placement;
  }

  for (const schemeName of operation.security) {
    const scheme = graph.security.get(schemeName);
    if (scheme?.kind === "apiKey-header") {
      return { in: "header", name: scheme.parameterName };
    }
    if (scheme?.kind === "apiKey-query") {
      return { in: "query", name: scheme.parameterName };
    }
  }

  throw new OpenApiClientError({
    reason: "missing-auth-placement",
    operationId: operation.operationId,
    status: 0,
    message:
      `Cannot place the apiKey credential for "${operation.operationId}": the operation declares no ` +
      `apiKey security scheme and no { placement } override was supplied.`,
  });
}

// ─────────────────────────────────────────────────────────────────────
//  Request body
// ─────────────────────────────────────────────────────────────────────

function buildBody(
  operation: Operation,
  params: OperationParams,
  headers: Record<string, string>,
): { body?: string; hasBody: boolean } {
  if (params.body === undefined) return { hasBody: false };
  // GET / HEAD cannot carry a body per the fetch spec; skip rather than throw.
  if (operation.method === "GET" || operation.method === "HEAD") {
    return { hasBody: false };
  }
  if (!hasHeader(headers, "content-type")) {
    headers["Content-Type"] = "application/json";
  }
  return { body: JSON.stringify(params.body), hasBody: true };
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const target = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === target);
}

// ─────────────────────────────────────────────────────────────────────
//  Response reading
// ─────────────────────────────────────────────────────────────────────

async function readResult(
  response: Response,
  operationId: string,
): Promise<OperationResult> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
  const contentType = response.headers.get("content-type") ?? "";

  let raw: string;
  try {
    raw = await response.text();
  } catch (err) {
    throw new OpenApiClientError({
      reason: "unparseable-response",
      operationId,
      status: response.status,
      message: `Failed to read response body for "${operationId}": ${errMessage(err)}`,
    });
  }

  let body: unknown = null;
  let bodyIsRaw = false;
  if (raw.length > 0) {
    if (isJsonContentType(contentType)) {
      try {
        body = JSON.parse(raw);
      } catch (err) {
        throw new OpenApiClientError({
          reason: "unparseable-response",
          operationId,
          status: response.status,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          message: `Response for "${operationId}" declared JSON but did not parse: ${errMessage(err)}`,
        });
      }
    } else {
      body = raw;
      bodyIsRaw = true;
    }
  }

  return {
    status: response.status,
    headers,
    body,
    bodyIsRaw,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

function isJsonContentType(contentType: string): boolean {
  const lowered = contentType.toLowerCase();
  return lowered.includes("application/json") || lowered.includes("+json");
}

// ─────────────────────────────────────────────────────────────────────
//  Transport-error classification
// ─────────────────────────────────────────────────────────────────────

function classifyTransportError(
  err: unknown,
  operationId: string,
  timeoutMs: number,
): OpenApiClientError {
  const name = err instanceof Error ? err.name : "";
  // `AbortSignal.timeout()` aborts with a `TimeoutError`; the `AbortError` arm
  // is defensive (future caller-supplied signals / runtime variance). The
  // message stays accurate for both — it does not assert the limit was
  // definitely reached, only what the per-request limit was.
  if (name === "TimeoutError" || name === "AbortError") {
    return new OpenApiClientError({
      reason: "timeout",
      operationId,
      status: 0,
      message: `Operation "${operationId}" was aborted (per-request timeout ${timeoutMs}ms).`,
    });
  }
  return new OpenApiClientError({
    reason: "network",
    operationId,
    status: 0,
    message: `Network error executing "${operationId}": ${errMessage(err)}`,
  });
}

// ─────────────────────────────────────────────────────────────────────
//  Retry-After (mirrors plugins/twenty/src/client.ts:parseRetryAfterMs)
// ─────────────────────────────────────────────────────────────────────

/**
 * Parse `Retry-After` per RFC 9110 §10.2.3. Two valid forms:
 *  - `delta-seconds` (e.g. `120`) — non-negative integer.
 *  - `HTTP-date` (e.g. `Wed, 21 Oct 2015 07:28:00 GMT`) — `Date.parse`able.
 *
 * Returns the wait in milliseconds, or `undefined` when absent / unparseable.
 * Clamped non-negative so server clock skew can't ask us to retry "in the past".
 */
export function parseRetryAfterMs(headerValue: string | null | undefined): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  if (trimmed.length === 0) return undefined;

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(seconds)) return undefined;
    return Math.max(0, seconds * 1000);
  }

  const target = Date.parse(trimmed);
  if (!Number.isFinite(target)) return undefined;
  return Math.max(0, target - Date.now());
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
