/**
 * Lightweight OTel metrics helpers.
 *
 * Mirrors the tracing.ts pattern: when the OTel SDK is not initialized
 * (no OTEL_EXPORTER_OTLP_ENDPOINT), @opentelemetry/api returns a no-op
 * meter — zero overhead, no conditional imports needed.
 *
 * Metrics surface counters/histograms that aren't naturally captured by
 * the trace waterfall — e.g. abuse escalations are scheduled state changes
 * with no enclosing HTTP request, so they need a Meter to feed dashboards
 * and alerting hooks.
 *
 * SDK initialization lives in telemetry.ts. Adding a metric here without
 * also wiring a `metricReader` into the NodeSDK means the value is
 * collected but not exported — operators who want abuse counters in their
 * Grafana board need to extend telemetry.ts with an OTLP metrics exporter.
 */

import { metrics, type Counter, type Histogram } from "@opentelemetry/api";

const meter = metrics.getMeter("@atlas/api");

/**
 * `atlas.abuse.escalations` — incremented every time a workspace's abuse
 * level changes (warning, throttled, suspended, or none on reinstate).
 * Attributes:
 *   - `level`   — the new level after the transition.
 *   - `trigger` — what tripped the escalation (query_rate, error_rate,
 *                 unique_tables, manual).
 */
export const abuseEscalations: Counter = meter.createCounter(
  "atlas.abuse.escalations",
  {
    description:
      "Workspace abuse level transitions (warn / throttle / suspend / reinstate)",
  },
);

/**
 * `atlas.mcp.tool.calls` — count of MCP tool dispatches by tool name +
 * outcome. Mirrors the abuse counter pattern; the same `@atlas/api` Meter
 * is used so a single OTel exporter configuration handles MCP signals.
 *
 * Attributes:
 *   - `tool.name`  — `explore` / `executeSQL` / `listEntities` /
 *                    `describeEntity` / `searchGlossary` / `runMetric`.
 *   - `outcome`    — `success` / `error`.
 *   - `transport`  — `stdio` / `sse`.
 *   - `deploy.mode`— `self-hosted` / `saas`.
 */
export const mcpToolCalls: Counter = meter.createCounter(
  "atlas.mcp.tool.calls",
  {
    description:
      "MCP tool dispatch count by tool name + outcome (success / error)",
  },
);

/**
 * `atlas.mcp.tool.latency` — raw per-dispatch latency in milliseconds.
 * Downstream collectors derive p50 / p95 / p99 — the histogram buckets
 * stay defaulted so dashboards aren't pinned to one set of cutoffs.
 *
 * Attributes match `atlas.mcp.tool.calls` so the two series can be joined.
 */
export const mcpToolLatency: Histogram = meter.createHistogram(
  "atlas.mcp.tool.latency",
  {
    description: "MCP tool dispatch latency in milliseconds (raw observations)",
    unit: "ms",
  },
);

/**
 * `atlas.mcp.activations` — incremented exactly once per workspace per
 * MCP process on the first observed tool call. Lets us measure 1.4.0 MCP
 * adoption without a parallel telemetry path.
 *
 * Attributes:
 *   - `workspace.id` — the bound `activeOrganizationId` (or
 *                      `system:mcp` in trusted-transport mode).
 *   - `transport`    — `stdio` / `sse`.
 *   - `deploy.mode`  — `self-hosted` / `saas`.
 */
export const mcpActivations: Counter = meter.createCounter(
  "atlas.mcp.activations",
  {
    description:
      "Workspace first-MCP-tool-call observed in this process (process-local dedup)",
  },
);

/**
 * `atlas.oauth.token_refresh` — incremented every time Better Auth's
 * `oauthProvider` issues a fresh access token via the `refresh_token`
 * grant (#2066). Sibling to `atlas.abuse.escalations`: gives operators a
 * dashboard signal for "agents are quietly rotating their JWTs"
 * separate from the noisier `atlas.mcp.tool.calls` series.
 *
 * Attributes:
 *   - `client.id`   — the OAuth client_id presenting the refresh, when
 *                     the hook can surface it. In v1.4.1 the production
 *                     hook collapses to `"unknown"` because Better
 *                     Auth's `customTokenResponseFields` does not pass
 *                     the `oauthClient.clientId` column to user code.
 *                     The attribute is in place so a future hook
 *                     upgrade lights up the per-agent split without
 *                     a metric-rename migration.
 *   - `deploy.mode` — `self-hosted` / `saas`. SaaS-only growth in this
 *                     series with self-hosted flat is the expected
 *                     shape (hosted MCP is SaaS-only).
 */
export const oauthTokenRefresh: Counter = meter.createCounter(
  "atlas.oauth.token_refresh",
  {
    description:
      "OAuth 2.1 refresh_token grants completed (Better Auth oauthProvider)",
  },
);
