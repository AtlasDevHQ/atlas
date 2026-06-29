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

import { asRecord, isAbortOrTimeout, serverMessage, unreachableMessage, type FetchImpl } from "./http";

/** The kinds of failure a metric-run call can surface, each with an actionable message. */
export type MetricErrorKind =
  | "unauthorized" // 401 — bearer missing/expired
  | "forbidden" // 403 — billing block, RLS-denied, or role
  | "no_workspace" // 400 — credential has no bound workspace
  | "not_found" // 404 — metric id not in this workspace
  | "approval_required" // 409 — the metric's SQL tripped an approval rule
  | "invalid_request" // 400 — unsupported filters / wrong connection
  | "rate_limited" // 429 — per-identity bucket, workspace throttle, or concurrency cap
  | "unavailable" // 503 — datasource/enterprise subsystem unavailable (or fail-closed billing)
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

/** The successful metric-run result shape (mirrors the route's response). */
export interface MetricRunResult {
  readonly id: string;
  readonly label: string | null;
  /** Scalar for a single-cell metric, else the full row set. */
  readonly value: unknown;
  readonly columns: string[];
  readonly rows: Record<string, unknown>[];
  readonly rowCount: number;
  readonly truncated: boolean;
  readonly sql: string;
  readonly executedAt: string;
}

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
    if (isAbortOrTimeout(err)) {
      throw new MetricCliError(
        "network",
        `Timed out after ${Math.round(timeoutMs / 1000)}s running metric "${args.id}".`,
      );
    }
    throw new MetricCliError("network", unreachableMessage(opts.baseUrl, err));
  }

  if (res.ok) {
    // intentionally ignored: a 2xx with a non-JSON body is unexpected from this
    // route, but degrade to an empty record rather than crash — the field reads
    // below tolerate missing values.
    const body = asRecord(await res.json().catch(() => ({})));
    return {
      id: typeof body.id === "string" ? body.id : args.id,
      label: typeof body.label === "string" ? body.label : null,
      value: body.value,
      columns: Array.isArray(body.columns) ? (body.columns as string[]) : [],
      rows: Array.isArray(body.rows) ? (body.rows as Record<string, unknown>[]) : [],
      rowCount: typeof body.rowCount === "number" ? body.rowCount : 0,
      truncated: Boolean(body.truncated),
      sql: typeof body.sql === "string" ? body.sql : "",
      executedAt: typeof body.executedAt === "string" ? body.executedAt : "",
    };
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
    case 429:
      // Per-identity rate-limit bucket, a workspace throttle, or the pipeline's
      // concurrency cap — all 429. Surface the server's message (it names the
      // remedy / retry hint) under a distinct kind, parity with `atlas sql`.
      throw new MetricCliError("rate_limited", serverMessage(body, res.status));
    case 400:
      if (body.error === "bad_request") {
        throw new MetricCliError(
          "no_workspace",
          "Your login is not bound to a workspace. Single-workspace accounts bind automatically; in-flow workspace selection for multi-workspace accounts is coming soon (ADR-0026).",
        );
      }
      throw new MetricCliError("invalid_request", serverMessage(body, res.status));
    case 503:
      // Datasource/enterprise subsystem unavailable, or a fail-closed billing
      // check (#3433) — a transient "try again", not an upgrade prompt. Distinct
      // kind, parity with `atlas sql`; the server message carries the detail.
      throw new MetricCliError("unavailable", serverMessage(body, res.status));
    default:
      throw new MetricCliError("request_failed", serverMessage(body, res.status));
  }
}
