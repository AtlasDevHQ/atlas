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
 * SDK initialization lives in telemetry.ts, which wires a
 * `PeriodicExportingMetricReader` + OTLP metrics exporter (60s cadence) into
 * the NodeSDK — metrics defined here are exported to the same collector as
 * traces whenever OTEL_EXPORTER_OTLP_ENDPOINT is set.
 */

import { metrics, type Counter, type Gauge, type Histogram } from "@opentelemetry/api";

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

/**
 * `atlas.rate_limit.audit_dropped` — incremented every time a per-OAuth-client
 * rate-limit denial audit row would have been written but was dropped
 * because the internal-DB fire-and-forget circuit breaker is open
 * (#2183 item 3). Pairs with a `log.error` line emitted at the same call
 * site so dashboards and the log stream both surface the visibility gap.
 *
 * Attributes:
 *   - `reason`        — currently always `circuit_open` (single drop
 *                       cause today; reserved for future drop modes).
 *   - `client.id`     — the OAuth client whose denial row was lost.
 *   - `tool.name`     — the dispatch tool — the per-client denial signal
 *                       is more actionable when split by tool.
 *   - `deploy.mode`   — `self-hosted` / `saas`. Operators of the SaaS
 *                       region care most about non-zero values here.
 */
export const rateLimitAuditDropped: Counter = meter.createCounter(
  "atlas.rate_limit.audit_dropped",
  {
    description:
      "Per-client rate-limit denial audit rows dropped by the internal-DB circuit breaker (#2183 item 3)",
  },
);

/**
 * `atlas.rate_limit.loader_failures` — incremented every time the
 * per-OAuth-client rate-limit DB loader (`oauth_client_rate_limits`
 * lookup) raises an error and the limiter falls back to its configured
 * disposition (#2183 item 4).
 *
 * Attributes:
 *   - `disposition`   — `fail_open` (the legacy default — caller served
 *                       at the workspace default quota) or `fail_closed`
 *                       (caller denied with `code: rate_limited`).
 *   - `deploy.mode`   — `self-hosted` / `saas`.
 *
 * Use this counter to alert when an override-DB outage is silently
 * widening the effective quota in a fail-open region.
 */
export const rateLimitLoaderFailures: Counter = meter.createCounter(
  "atlas.rate_limit.loader_failures",
  {
    description:
      "Per-client rate-limit override loader failures by disposition (fail_open / fail_closed)",
  },
);

/**
 * `atlas.mcp.prompts.calls` — every `prompts/list` and `prompts/get`
 * request, attributed to the resolving prompt source so operators can
 * tell which prompts library agents actually pull (#2076).
 *
 * Attributes:
 *   - `method`     — `list` / `get`.
 *   - `prompt`     — prompt name on `get`; `(none)` on `list`.
 *   - `source`     — `builtin` / `semantic` / `library` / `canonical`
 *                    on `get`; `(mixed)` on `list` (the dispatch covers
 *                    every source so a single label would be wrong).
 *   - `transport`  — `stdio` / `sse`.
 *   - `deploy.mode`— `self-hosted` / `saas`.
 *
 * `prompt` deliberately ships unhashed because the prompt ID space is
 * small and stable (built-in templates + canonical eval set + curated
 * library + per-workspace query_patterns). High-cardinality blowup
 * would require an exotic semantic-layer with thousands of patterns,
 * which doesn't exist today; if it does, drop the `prompt` attribute
 * downstream rather than at the source so the counter stays joinable
 * with other MCP series.
 */
export const mcpPromptCalls: Counter = meter.createCounter(
  "atlas.mcp.prompts.calls",
  {
    description:
      "MCP prompts surface dispatch count by method + prompt + source",
  },
);

/**
 * `atlas.crm_outbox.pending_count` — current `crm_outbox` rows in
 * `pending` status. Updated by the SaaS-CRM outbox flusher (#2734) on
 * every tick, BEFORE dispatch, so the value reflects the queue depth
 * an operator sees between ticks.
 *
 * No `workspace.id` attribute — the flusher is process-global and the
 * queue is single-tenant (SaaS-only; the self-hosted Noop SaasCrm
 * never starts a flusher fiber so no observations land here).
 *
 * A sustained value past `ATLAS_CRM_OUTBOX_WARN_THRESHOLD` (default
 * 100) also fires a rate-limited `log.warn` with the oldest pending
 * row's age — pair the two signals in dashboards.
 */
export const crmOutboxPendingCount: Gauge = meter.createGauge(
  "atlas.crm_outbox.pending_count",
  {
    description:
      "Current crm_outbox rows in pending status, observed per flusher tick (#2734)",
  },
);

/**
 * `atlas.crm_outbox.dead_count` — current `crm_outbox` rows in `dead`
 * status. A monotonically-growing value means the dispatcher is
 * surfacing permanent failures (or exhausting the retry budget). For
 * per-row triage, join with the `lead_outbox.dead_letter_permanent` /
 * `_exhausted` log events emitted by slice 2 (#2729).
 */
export const crmOutboxDeadCount: Gauge = meter.createGauge(
  "atlas.crm_outbox.dead_count",
  {
    description:
      "Current crm_outbox rows in dead status, observed per flusher tick (#2734)",
  },
);

/**
 * `atlas.crm_outbox.flusher_wakes` — count of flusher tick cycles by what
 * triggered them (#2874). After eventizing the flusher, this is the
 * primary health signal: a healthy idle pod shows almost all `backstop`
 * wakes (≈1 per `ATLAS_CRM_OUTBOX_BACKSTOP_SWEEP_SECONDS`), while real
 * lead traffic shows `kick` wakes. A spike in `backstop` with no `kick`
 * under load means the inline enqueue kick isn't reaching the fiber;
 * `kick` wakes far above the lead rate means a retry storm.
 *
 * Attributes:
 *   - `trigger` — `boot` (first tick after recovery), `kick` (inline
 *     enqueue kick or a per-row retry timer), or `backstop` (the
 *     low-frequency safety-net sweep).
 */
export const crmOutboxFlusherWakes: Counter = meter.createCounter(
  "atlas.crm_outbox.flusher_wakes",
  {
    description:
      "CRM outbox flusher tick cycles by trigger (boot / kick / backstop) (#2874)",
  },
);

/**
 * `atlas.email_outbox.pending_count` — current `email_outbox` rows in
 * `pending` status. Updated by the transactional-email outbox flusher
 * (#2942) on every tick, BEFORE dispatch, so the value reflects the
 * queue depth an operator sees between ticks. A sustained value past
 * `ATLAS_EMAIL_OUTBOX_WARN_THRESHOLD` (default 50) also fires a
 * rate-limited `log.warn` — pair the two signals in dashboards.
 */
export const emailOutboxPendingCount: Gauge = meter.createGauge(
  "atlas.email_outbox.pending_count",
  {
    description:
      "Current email_outbox rows in pending status, observed per flusher tick (#2942)",
  },
);

/**
 * `atlas.email_outbox.dead_count` — current `email_outbox` rows in
 * `dead` status. A growing value means transactional sends are
 * exhausting the retry budget across a sustained provider outage (or a
 * permanent misconfig). Join with the `email_outbox.dead_letter_*` log
 * events for per-row triage.
 */
export const emailOutboxDeadCount: Gauge = meter.createGauge(
  "atlas.email_outbox.dead_count",
  {
    description:
      "Current email_outbox rows in dead status, observed per flusher tick (#2942)",
  },
);

/**
 * `atlas.claim_gate.decisions` — one increment per real SaaS claim-gate
 * decision on the Atlas-token Q&A path (#3651, #3796). The withhold path
 * (`claim_required`) and the serve path (`allowed`) are otherwise only
 * per-request logs, so the withheld-vs-served ratio isn't graphable and a
 * `claim_required` spike isn't alertable without this counter. The non-SaaS
 * short-circuit (self-hosted / CLI / no internal DB) is NOT counted — it isn't
 * a metering decision.
 *
 * Attributes:
 *   - `outcome` — `allowed` (served / claimed / non-metered tier),
 *                 `claim_required` (withheld pre-claim), or
 *                 `check_failed` (lookup errored → fail-closed 503).
 */
export const claimGateDecisions: Counter = meter.createCounter(
  "atlas.claim_gate.decisions",
  {
    description:
      "SaaS claim-gate decisions by outcome (allowed / claim_required / check_failed) (#3651)",
  },
);

/**
 * `atlas.trial_abuse.rejections` — one increment per `start_trial` attempt
 * rejected by the per-IP / per-email rate limiter (#3654, #3796). The
 * limiter's windows are in-memory `Map`s (per-replica), so a per-request
 * `log.warn` is the only on-call signal today; this counter aggregates at the
 * collector for a fleet-wide attack view and an alertable series.
 *
 * Attributes:
 *   - `limiter` — `ip` (per-IP attempt window tripped) or
 *                 `email` (per-email attempt window tripped).
 */
export const trialAbuseRejections: Counter = meter.createCounter(
  "atlas.trial_abuse.rejections",
  {
    description:
      "Self-serve start_trial attempts rejected by the per-IP / per-email rate limiter (#3654)",
  },
);
