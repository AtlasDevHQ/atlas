/**
 * OpenTelemetry SDK initialization — Node.js only.
 *
 * Separated from instrumentation.ts so Turbopack's Edge-compatibility
 * static analysis doesn't flag Node.js APIs (process.on, etc.).
 * Uses dynamic imports because OTel packages are optional dependencies.
 */

export {};

const { NodeSDK } = await import("@opentelemetry/sdk-node");
const { OTLPTraceExporter } = await import(
  "@opentelemetry/exporter-trace-otlp-http"
);
const { resourceFromAttributes } = await import("@opentelemetry/resources");
const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = await import(
  "@opentelemetry/semantic-conventions"
);

const resource = resourceFromAttributes({
  [ATTR_SERVICE_NAME]: "atlas",
  // npm_package_version is set by bun/npm during "bun run"; falls back in Docker or direct execution
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
      "[atlas] OTel SDK shutdown failed:",
      err instanceof Error ? err.message : String(err),
    );
  });
});
