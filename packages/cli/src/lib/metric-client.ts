/**
 * `atlas metric run` HTTP client (#4048 / ADR-0027 shared gate-parity contract).
 *
 * A thin, transport-only client over the EXISTING metric-run REST route
 * (`POST /api/v1/metrics/{id}/run`) — no duplicated business logic; the server
 * owns metric resolution, group routing, the gate chain, and SQL validation.
 * This maps one workspace CLI subcommand onto one route and surfaces the typed
 * outcome.
 *
 * Authorization rides entirely on the `atlas login` workspace credential: the
 * stored Better Auth session bearer (stamped `origin='cli'` server-side) is
 * sent as `Authorization: Bearer <token>`. The route resolves it live to
 * `{ orgId, role }`, runs billing gate-0, and executes the metric's
 * authoritative SQL against ONLY the bound workspace — the CLI never re-derives
 * any of that.
 *
 * `fetch` is injectable so the route mapping + status-code handling are
 * unit-testable without a live server (mirrors `datasource-client.ts`). No
 * function here calls `process.exit` or `console`; the command handler owns
 * presentation.
 */

import type { CliRestErrorCode, RunMetricRestResponse } from "@useatlas/types";
import { RunMetricRestResponseSchema } from "@useatlas/schemas";

type FetchImpl = typeof fetch;

/**
 * The server `error`-field discriminators this client branches on, pinned to the
 * shared registry (`satisfies Record<…, CliRestErrorCode>`) so a server-side
 * rename surfaces at compile time.
 */
const ERR = {
  badRequest: "bad_request",
} as const satisfies Record<string, CliRestErrorCode>;

/** The kinds of failure a metric-run call can surface, each with an actionable message. */
export type MetricErrorKind =
  | "unauthorized" // 401 — bearer missing/expired
  | "forbidden" // 403 — billing block, RLS-denied, or role
  | "no_workspace" // 400 — credential has no bound workspace
  | "not_found" // 404 — metric id not in this workspace
  | "approval_required" // 409 — the metric's SQL tripped an approval rule
  | "invalid_request" // 400 — unsupported filters / wrong connection
  | "request_failed" // other non-2xx
  | "network"; // fetch threw / timed out

/** A metric-run failure carrying a typed {@link MetricErrorKind}. */
export class MetricCliError extends Error {
  constructor(
    readonly kind: MetricErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "MetricCliError";
  }
}

/**
 * The successful metric-run result shape. Aliases the shared
 * {@link RunMetricRestResponse} wire type (the SSOT in `@useatlas/types`) so the
 * CLI and the route can't drift; kept under the local name so command-layer
 * imports stay stable.
 */
export type MetricRunResult = RunMetricRestResponse;

export interface MetricClientOptions {
  /** Normalized Atlas API base URL (no trailing slash). */
  readonly baseUrl: string;
  /** The stored `atlas login` session bearer. */
  readonly token: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: FetchImpl;
  /** Per-request timeout in ms (default 60s — a metric query can be slower than metadata). */
  readonly timeoutMs?: number;
}

export interface RunMetricArgs {
  readonly id: string;
  /** Optional explicit connection id; validated against the metric's group server-side. */
  readonly connectionId?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * Pull the server's actionable message off a JSON error body, falling back to
 * the HTTP status. Appends the server's `requestId` (Atlas error envelopes
 * carry one) so a bug report stays log-correlatable operator-side.
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
 * Execute a canonical metric by id against the bound workspace via
 * `POST /api/v1/metrics/{id}/run`, mapping every documented failure status onto
 * a typed {@link MetricCliError} with an actionable message.
 */
export async function runMetric(
  opts: MetricClientOptions,
  args: RunMetricArgs,
): Promise<MetricRunResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 60_000;

  let res: Response;
  try {
    res = await fetchImpl(
      `${opts.baseUrl}/api/v1/metrics/${encodeURIComponent(args.id)}/run`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(args.connectionId ? { connectionId: args.connectionId } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new MetricCliError(
        "network",
        `Timed out after ${Math.round(timeoutMs / 1000)}s running metric "${args.id}".`,
      );
    }
    throw new MetricCliError(
      "network",
      `Could not reach the Atlas API at ${opts.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (res.ok) {
    // intentionally ignored: a non-JSON 2xx body becomes `undefined` and fails
    // the schema parse below — surfaced as a typed error, never silent garbage.
    const raw = await res.json().catch(() => undefined);
    // Validate the 200 against the shared wire schema (the SSOT). A shape
    // mismatch is a server bug / version skew — surface it rather than returning
    // a half-filled result.
    const parsed = RunMetricRestResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new MetricCliError(
        "request_failed",
        `The Atlas API returned an unexpected response shape for metric "${args.id}". Update the CLI, or check the server logs.`,
      );
    }
    return parsed.data;
  }

  // intentionally ignored: an error body that isn't JSON falls back to the
  // HTTP-status message below via the empty record.
  const body = asRecord(await res.json().catch(() => ({})));

  switch (res.status) {
    case 401:
      throw new MetricCliError(
        "unauthorized",
        "Your session is no longer valid. Run `atlas login` again.",
      );
    case 403:
      // Billing block, RLS-denied, or role — surface the server's message
      // (it carries the actionable remedy, e.g. trial-expired guidance).
      throw new MetricCliError("forbidden", serverMessage(body, res.status));
    case 404:
      throw new MetricCliError(
        "not_found",
        `Metric "${args.id}" not found in this workspace. Run \`atlas entities\` or check semantic/metrics/.`,
      );
    case 409:
      throw new MetricCliError("approval_required", serverMessage(body, res.status));
    case 400:
      if (body.error === ERR.badRequest) {
        throw new MetricCliError(
          "no_workspace",
          "Your login is not bound to a workspace. Single-workspace accounts bind automatically; in-flow workspace selection for multi-workspace accounts is coming soon (ADR-0026).",
        );
      }
      throw new MetricCliError("invalid_request", serverMessage(body, res.status));
    default:
      throw new MetricCliError("request_failed", serverMessage(body, res.status));
  }
}
