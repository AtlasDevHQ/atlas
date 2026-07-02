/**
 * Shared HTTP primitives for the workspace CLI clients (#4113 — milestone #77
 * sibling-consistency cleanup; finished in #4196).
 *
 * Each workspace CLI client (`sql-client`, `metric-client`, `datasource-client`,
 * and the `explore` command) is a thin, transport-only wrapper over one REST
 * route. The body-narrowing + error-shaping helpers below were byte-identical
 * copies pasted across them; consolidating here gives the wire contract ONE
 * definition, so a change to how a server error becomes user-facing copy (or how
 * a `requestId` is appended) can't drift between siblings.
 *
 * This module owns two shared pieces:
 *  - `workspaceRequest` — the ONE fetch → timeout → ok → error-map execution
 *    path the three lifecycle clients (`sql-client`, `metric-client`,
 *    `datasource-client`) ride for their buffered-body CRUD ops. It owns the
 *    transport invariants (the fetch, the `AbortSignal.timeout`, the
 *    network/timeout classification, the ok-body read) and delegates ALL error
 *    mapping to the client's `toError` hook — it never touches the status copy
 *    itself. (The streaming `profileDatasource` is a separate, un-timed NDJSON
 *    path that does NOT ride this.)
 *  - {@link defaultWorkspaceErrorInfo} — the byte-identical status copy (401
 *    re-login, the no-workspace guidance). Each client's `toError` mapper spells
 *    out only its OWN divergent statuses (a metric's 404 copy, a datasource's
 *    admin-role 403) and falls through to this default for the rest.
 * So the fetch block + the shared strings each exist exactly once, and per-client
 * divergence stays local to that client's `toError`.
 *
 * Nothing here calls `process.exit` or `console` — the clients inject `fetch`
 * and own presentation, keeping these pure + unit-testable.
 */

import { credentialHeaders, type CliCredential } from "./credential";

/** The global `fetch`, injectable so clients stay unit-testable without a live server. */
export type FetchImpl = typeof fetch;

/** Narrow an unknown parsed-JSON value to a record; non-objects (incl. `null`) → `{}`. */
export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * Pull the server's actionable message off a JSON error body, falling back to
 * the HTTP status. Appends the server's `requestId` (Atlas error envelopes carry
 * one) so a bug report stays log-correlatable operator-side.
 */
export function serverMessage(body: Record<string, unknown>, status: number): string {
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
 * Whether a thrown `fetch` rejection is an abort/timeout rather than a genuine
 * transport failure. `AbortSignal.timeout(...)` rejects with a `TimeoutError`; a
 * caller-driven abort (Ctrl-C) rejects with an `AbortError`. The clients map
 * both to their `network` error kind with a deadline-specific message.
 */
export function isAbortOrTimeout(err: unknown): boolean {
  const name = err instanceof Error ? err.name : "";
  return name === "TimeoutError" || name === "AbortError";
}

/** The "couldn't reach the API" message shared verbatim across the clients. */
export function unreachableMessage(baseUrl: string, err: unknown): string {
  return `Could not reach the Atlas API at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`;
}

// ---------------------------------------------------------------------------
// Shared error copy + status→kind default table (#4196).
//
// The 401 re-login string and the no-workspace guidance were pasted verbatim
// across `sql-client`, `metric-client`, `datasource-client`, and the streaming
// `profileDatasource` — a change to either could silently drift between the
// siblings. They live here once; every client references these constants.
// ---------------------------------------------------------------------------

/** The 401 re-login hint every workspace client surfaces verbatim. */
export const SESSION_INVALID_MESSAGE =
  "Your session is no longer valid. Run `atlas login` again.";

/**
 * The 400 `bad_request` (no active org) guidance every workspace client
 * surfaces verbatim — a multi-workspace login pending the picker slice
 * (ADR-0026). The server's `requireOrgContext` returns 400 `bad_request` here.
 */
export const NO_WORKSPACE_MESSAGE =
  "Your login is not bound to a workspace. Single-workspace accounts bind automatically; in-flow workspace selection for multi-workspace accounts is coming soon (ADR-0026).";

/**
 * The subset of failure kinds every workspace client shares under IDENTICAL
 * names — the ones the default status→kind table below resolves. Each client's
 * own kind union is a superset (it adds `forbidden`, `rate_limited`, etc.), so a
 * `{ kind, message }` produced here is always assignable to that client's error
 * constructor.
 */
export type SharedWorkspaceErrorKind = "unauthorized" | "no_workspace" | "request_failed";

/** A resolved `{ kind, message }` a client feeds straight into its typed-error constructor. */
export interface WorkspaceErrorInfo {
  readonly kind: SharedWorkspaceErrorKind;
  readonly message: string;
}

/**
 * The DEFAULT status→kind mapping shared across the lifecycle clients: the two
 * byte-identical branches (401 → re-login, 400 `bad_request` → no-workspace) plus
 * the catch-all (`request_failed` with the server's message). Each client calls
 * this for the statuses it does NOT special-case, so the shared copy is defined
 * once and a client's `toError` mapper only spells out its genuine divergences.
 */
export function defaultWorkspaceErrorInfo(
  status: number,
  body: Record<string, unknown>,
): WorkspaceErrorInfo {
  if (status === 401) return { kind: "unauthorized", message: SESSION_INVALID_MESSAGE };
  if (status === 400 && body.error === "bad_request") {
    return { kind: "no_workspace", message: NO_WORKSPACE_MESSAGE };
  }
  return { kind: "request_failed", message: serverMessage(body, status) };
}

// ---------------------------------------------------------------------------
// The one workspace-REST execution path (#4196).
//
// `datasource-client` already had this as a private `request(opts, spec)`; its
// siblings re-inlined the whole fetch → timeout → ok → switch block. Lifted here
// so the transport invariants live once and each client supplies only its
// route (method/path/body) + its status→error mapping.
// ---------------------------------------------------------------------------

/** The connection target a workspace request runs against (a client-options subset). */
export interface WorkspaceRequestTarget {
  /** Normalized Atlas API base URL (no trailing slash). */
  readonly baseUrl: string;
  /** The workspace credential — a session bearer XOR a workspace API key. */
  readonly credential: CliCredential;
  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: FetchImpl;
  /** Per-request timeout in ms (default 30s). */
  readonly timeoutMs?: number;
}

/** One REST route: the method, path (appended to `baseUrl`), and optional JSON body. */
export interface WorkspaceRequestSpec {
  readonly method: "GET" | "POST" | "DELETE";
  readonly path: string;
  /** Sent as a JSON body when present; a `Content-Type` header is added only then. */
  readonly body?: unknown;
}

/**
 * The per-client error hooks: how to turn a non-2xx `(status, body)` into the
 * client's typed error, how to build its `network`-kind error, and the
 * timeout-copy subject (which varies — "running the query" vs `trying to
 * ${operation}`). `E extends Error` so the caller keeps its concrete error type.
 */
export interface WorkspaceRequestHandlers<E extends Error> {
  /** Map a non-2xx `(status, body)` → the client's typed error. */
  readonly toError: (status: number, body: Record<string, unknown>) => E;
  /** Build the client's `network`-kind error (shared by the timeout + unreachable paths). */
  readonly toNetworkError: (message: string) => E;
  /** The client-specific timeout copy, e.g. `Timed out after ${s}s running the query.` */
  readonly timeoutMessage: (timeoutSeconds: number) => string;
}

/**
 * Issue ONE workspace-REST request and return its raw parsed-JSON body (a `{}`
 * fallback on an empty/non-JSON 2xx — callers schema-validate or narrow it),
 * mapping every documented failure onto the client's typed error via
 * {@link WorkspaceRequestHandlers}. This is the single fetch → timeout → ok →
 * error-map path the lifecycle clients share (#4196).
 */
export async function workspaceRequest<E extends Error>(
  target: WorkspaceRequestTarget,
  spec: WorkspaceRequestSpec,
  handlers: WorkspaceRequestHandlers<E>,
): Promise<unknown> {
  const fetchImpl = target.fetchImpl ?? fetch;
  const timeoutMs = target.timeoutMs ?? 30_000;

  let res: Response;
  try {
    res = await fetchImpl(`${target.baseUrl}${spec.path}`, {
      method: spec.method,
      headers: {
        ...credentialHeaders(target.credential),
        ...(spec.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(spec.body !== undefined ? { body: JSON.stringify(spec.body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (isAbortOrTimeout(err)) {
      throw handlers.toNetworkError(handlers.timeoutMessage(Math.round(timeoutMs / 1000)));
    }
    throw handlers.toNetworkError(unreachableMessage(target.baseUrl, err));
  }

  if (res.ok) {
    // intentionally ignored: a 2xx with an empty/non-JSON body degrades to {} —
    // callers tolerate missing optional fields (or fail their own schema parse)
    // rather than crashing here.
    return await res.json().catch(() => ({}));
  }

  // intentionally ignored: an error body that isn't JSON falls back to the
  // HTTP-status message via the empty record.
  const body = asRecord(await res.json().catch(() => ({})));
  throw handlers.toError(res.status, body);
}
