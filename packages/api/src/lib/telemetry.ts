/**
 * OpenTelemetry SDK initialization for the Atlas API server.
 *
 * Separated from tracing.ts (span helpers) so the SDK is only loaded when
 * OTEL_EXPORTER_OTLP_ENDPOINT is set. Without this import, @opentelemetry/api
 * returns no-op tracers — zero overhead.
 *
 * Import this module once during server startup:
 *   if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) await import("./telemetry");
 */

const { NodeSDK } = await import("@opentelemetry/sdk-node");
const { OTLPTraceExporter } = await import(
  "@opentelemetry/exporter-trace-otlp-http"
);
const { resourceFromAttributes } = await import("@opentelemetry/resources");
const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = await import(
  "@opentelemetry/semantic-conventions"
);

const resource = resourceFromAttributes({
  [ATTR_SERVICE_NAME]: "atlas-api",
  [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? "0.0.0",
});

const traceExporter = new OTLPTraceExporter({
  url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces`,
});

const sdk = new NodeSDK({ resource, traceExporter });
sdk.start();

process.on("SIGTERM", () => {
  sdk.shutdown().catch((err) => {
    console.error(
      "[atlas-api] OTel SDK shutdown failed:",
      err instanceof Error ? err.message : String(err),
    );
  });
});
