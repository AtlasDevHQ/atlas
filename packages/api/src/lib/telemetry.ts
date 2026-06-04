/**
 * OpenTelemetry SDK bootstrap (traces + metrics).
 *
 * Shared by the API server (via `TelemetryLive` in `lib/effect/layers.ts`) and
 * the standalone MCP process (via `@atlas/mcp`'s `startMcpTelemetry`, #3199).
 *
 * Only ever reached when OTEL_EXPORTER_OTLP_ENDPOINT is set — every caller
 * gates the dynamic `import()` of this module on the endpoint being present.
 * Importing the module is cheap (no side effects); the heavy
 * `@opentelemetry/sdk-node` graph is pulled in lazily inside `initTelemetry()`.
 * Without an init call, `@opentelemetry/api` returns no-op tracers/meters —
 * zero overhead.
 *
 * Keeping the `@opentelemetry/sdk-node` import dynamic (and out of any module's
 * STATIC graph) is load-bearing: Next.js's App Router tracer follows static
 * imports, so a request-path consumer that statically reached this module
 * would fail the create-atlas standalone scaffold build trying to resolve
 * `@opentelemetry/sdk-node` (see the notes in `lib/config.ts` /
 * `lib/effect/saas-guards.ts`).
 *
 * @example
 *   if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
 *     const { initTelemetry } = await import("@atlas/api/lib/telemetry");
 *     const shutdown = await initTelemetry();
 *     // ... later, during graceful shutdown:
 *     await shutdown();
 *   }
 */

import type { NodeSDK } from "@opentelemetry/sdk-node";

export interface InitTelemetryOptions {
  /**
   * Resource `service.name`. Defaults to `OTEL_SERVICE_NAME`, then
   * `"atlas-api"`. The standalone MCP process passes `"atlas-mcp"` so its
   * spans/metrics are attributed to the MCP service rather than the API.
   */
  serviceName?: string;
}

// Process-global singleton. The OTel NodeSDK installs global tracer/meter
// providers, so a second `start()` would double-register. An idempotent init
// lets multiple boot paths in one process (e.g. the API Effect layer, or a
// future in-process embed) call it without racing.
let sdk: NodeSDK | null = null;

/**
 * Start the OTel NodeSDK exporting traces + metrics to
 * `OTEL_EXPORTER_OTLP_ENDPOINT`. Idempotent — a second call is a no-op and
 * returns the same shutdown handle. Returns a shutdown function that flushes
 * pending spans/metrics and tears the SDK down.
 *
 * Callers are responsible for gating on the endpoint being set (so the heavy
 * SDK graph is never imported when telemetry is disabled).
 */
export async function initTelemetry(
  opts: InitTelemetryOptions = {},
): Promise<() => Promise<void>> {
  if (sdk) return shutdownTelemetry;

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  const { NodeSDK } = await import("@opentelemetry/sdk-node");
  const { OTLPTraceExporter } = await import(
    "@opentelemetry/exporter-trace-otlp-http"
  );
  const { OTLPMetricExporter } = await import(
    "@opentelemetry/exporter-metrics-otlp-http"
  );
  const { PeriodicExportingMetricReader } = await import(
    "@opentelemetry/sdk-metrics"
  );
  const { resourceFromAttributes } = await import("@opentelemetry/resources");
  const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = await import(
    "@opentelemetry/semantic-conventions"
  );

  const serviceName =
    opts.serviceName ?? process.env.OTEL_SERVICE_NAME ?? "atlas-api";

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? "0.0.0",
  });

  const traceExporter = new OTLPTraceExporter({
    url: `${endpoint}/v1/traces`,
  });

  // Metric reader — without this, every meter defined in metrics.ts
  // (atlas.abuse.*, atlas.mcp.*, atlas.oauth.*, atlas.rate_limit.*,
  // atlas.crm_outbox.*) feeds a no-op meter and is silently dropped even
  // when OTEL_EXPORTER_OTLP_ENDPOINT is set. Export to the same collector
  // as traces on a 60s cadence so dashboards/alerts built on those counters
  // actually receive data.
  const metricReader = new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: `${endpoint}/v1/metrics`,
    }),
    exportIntervalMillis: 60_000,
  });

  sdk = new NodeSDK({ resource, traceExporter, metricReader });
  sdk.start();

  return shutdownTelemetry;
}

/**
 * Flush pending spans/metrics and shut down the SDK. Idempotent — a no-op if
 * the SDK was never started. Called from each process's graceful-shutdown
 * sequence (the API Effect finalizer; the MCP SIGINT/SIGTERM handlers) — not a
 * standalone SIGTERM handler, to avoid racing with `process.exit()`.
 */
export async function shutdownTelemetry(): Promise<void> {
  if (!sdk) return;
  const current = sdk;
  sdk = null;
  await current.shutdown();
}
