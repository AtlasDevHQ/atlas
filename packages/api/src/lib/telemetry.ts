/**
 * OpenTelemetry SDK initialization for the Atlas API server.
 *
 * Separated from tracing.ts (span helpers) so the SDK is only loaded when
 * OTEL_EXPORTER_OTLP_ENDPOINT is set. Without this import, @opentelemetry/api
 * returns no-op tracers — zero overhead.
 *
 * Import this module once during server startup:
 *   if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) await import("@atlas/api/lib/telemetry");
 */

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

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

const resource = resourceFromAttributes({
  [ATTR_SERVICE_NAME]: "atlas-api",
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

const sdk = new NodeSDK({ resource, traceExporter, metricReader });
sdk.start();

/**
 * Flush pending spans and shut down the SDK.
 * Called from the server's graceful shutdown sequence — not a standalone
 * SIGTERM handler, to avoid racing with process.exit().
 */
export async function shutdownTelemetry(): Promise<void> {
  await sdk.shutdown();
}
