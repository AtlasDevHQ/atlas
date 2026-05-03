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

import { metrics, type Counter } from "@opentelemetry/api";

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
