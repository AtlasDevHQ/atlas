/**
 * `atlas metric run` HTTP client (#4048 / ADR-0027 shared gate-parity contract).
 *
 * A thin, transport-only client over the EXISTING metric-run REST route
 * (`POST /api/v1/metrics/{id}/run`) — no duplicated business logic; the server
 * owns metric resolution, group routing, the gate chain, and SQL validation.
 * This maps one workspace CLI subcommand onto one route and surfaces the typed
 * outcome.
 *
 * Authorization rides on the workspace credential — a `atlas login` device-flow
 * SESSION bearer (`Authorization: Bearer`) XOR a workspace-scoped API key for
 * unattended CI (#4046, `x-api-key`); see {@link CliCredential}. Either way the
 * route resolves it live to `{ orgId, role }`, runs billing gate-0, and executes
 * the metric's authoritative SQL against ONLY the bound workspace — the CLI never
 * re-derives any of that.
 *
 * `fetch` is injectable so the route mapping + status-code handling are
 * unit-testable without a live server (mirrors `datasource-client.ts`). No
 * function here calls `process.exit` or `console`; the command handler owns
 * presentation.
 */

import type { CliRestErrorCode, RunMetricRestResponse } from "@useatlas/types";
import { RunMetricRestResponseSchema } from "@useatlas/schemas";
import { type CliCredential } from "./credential";
import {
  defaultWorkspaceErrorInfo,
  serverMessage,
  workspaceRequest,
  type FetchImpl,
} from "./http";

/**
 * The server `error`-field discriminators this client branches on, pinned to the
 * shared `CliRestErrorCode` registry (`satisfies Record<…, CliRestErrorCode>`)
 * so the CLI's branch literals can't drift from the shared vocabulary — renaming
 * a registry code breaks this map at compile time.
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
  /**
   * The workspace credential — a session bearer XOR a workspace API key (never
   * both). See {@link CliCredential}.
   */
  readonly credential: CliCredential;
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
 * Map a non-2xx metric-run `(status, body)` onto a typed {@link MetricCliError}.
 * Only the statuses that diverge from the shared default are spelled out; 401
 * (re-login), 400 `bad_request` (no-workspace), and any other status fall
 * through to {@link defaultWorkspaceErrorInfo} so the byte-identical copy is
 * defined once (#4196). Closes over the metric `id` for the 404 copy.
 */
function toMetricError(id: string, status: number, body: Record<string, unknown>): MetricCliError {
  switch (status) {
    case 403:
      // Billing block, RLS-denied, or role — surface the server's message
      // (it carries the actionable remedy, e.g. trial-expired guidance).
      return new MetricCliError("forbidden", serverMessage(body, status));
    case 404:
      return new MetricCliError(
        "not_found",
        `Metric "${id}" not found in this workspace. Run \`atlas entities\` or check semantic/metrics/.`,
      );
    case 409:
      return new MetricCliError("approval_required", serverMessage(body, status));
    case 429:
      // Per-identity rate-limit bucket, a workspace throttle, or the pipeline's
      // concurrency cap — all 429. Surface the server's message (it names the
      // remedy / retry hint) under a distinct kind, parity with `atlas sql`.
      return new MetricCliError("rate_limited", serverMessage(body, status));
    case 503:
      // Datasource/enterprise subsystem unavailable, or a fail-closed billing
      // check (#3433) — a transient "try again", not an upgrade prompt. Distinct
      // kind, parity with `atlas sql`; the server message carries the detail.
      return new MetricCliError("unavailable", serverMessage(body, status));
    case 400:
      // A `bad_request` (no bound workspace) falls through to the shared
      // no-workspace default; every other 400 is an unsupported filter / wrong
      // connection — the server message names the cause.
      if (body.error !== ERR.badRequest) {
        return new MetricCliError("invalid_request", serverMessage(body, status));
      }
  }
  const info = defaultWorkspaceErrorInfo(status, body);
  return new MetricCliError(info.kind, info.message);
}

/**
 * Execute a canonical metric by id against the bound workspace via
 * `POST /api/v1/metrics/{id}/run`, mapping every documented failure status onto
 * a typed {@link MetricCliError} with an actionable message. Rides the shared
 * {@link workspaceRequest} transport (#4196); only the route, the response
 * schema, and the metric-specific status copy live here.
 */
export async function runMetric(
  opts: MetricClientOptions,
  args: RunMetricArgs,
): Promise<MetricRunResult> {
  const raw = await workspaceRequest(
    { ...opts, timeoutMs: opts.timeoutMs ?? 60_000 },
    {
      method: "POST",
      path: `/api/v1/metrics/${encodeURIComponent(args.id)}/run`,
      body: args.connectionId ? { connectionId: args.connectionId } : {},
    },
    {
      toError: (status, body) => toMetricError(args.id, status, body),
      toNetworkError: (message) => new MetricCliError("network", message),
      timeoutMessage: (seconds) => `Timed out after ${seconds}s running metric "${args.id}".`,
    },
  );

  // Validate the 200 against the shared wire schema (the SSOT). A shape mismatch
  // is a server bug / version skew — surface it rather than returning a
  // half-filled result.
  const parsed = RunMetricRestResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new MetricCliError(
      "request_failed",
      `The Atlas API returned an unexpected response shape for metric "${args.id}". Update the CLI, or check the server logs.`,
    );
  }
  return parsed.data;
}
