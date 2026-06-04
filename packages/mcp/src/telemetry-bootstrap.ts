/**
 * OTel bootstrap for the standalone MCP process (#3199).
 *
 * The OTel SDK (NodeSDK: traces + metrics) is initialized in the API server
 * via `@atlas/api/lib/telemetry`. The standalone MCP process — `bin/serve.ts`
 * and the CLI's `atlas mcp` command — runs in its own process and imports none
 * of that, so every `atlas.mcp.*` instrument (`src/telemetry.ts`) feeds a
 * no-op meter and its spans/counters are silently dropped. This wires the same
 * bootstrap into the MCP process.
 *
 * Gating mirrors the API exactly: a no-op unless `OTEL_EXPORTER_OTLP_ENDPOINT`
 * is set. The dynamic import keeps `@opentelemetry/sdk-node` (resolved through
 * the `@atlas/api` workspace dependency) off the import path entirely when
 * telemetry is disabled.
 *
 * Telemetry lifecycle is owned by the PROCESS entry, not the SSE library: the
 * NodeSDK installs global providers, so the entry point inits once at boot and
 * shuts down on SIGINT/SIGTERM. `startSseServer` / `createAtlasMcpServer` stay
 * free of process-global state so they remain safe to embed (and to call from
 * tests).
 */

/** Resource `service.name` for spans/metrics emitted by the MCP process. */
export const MCP_OTEL_SERVICE_NAME = "atlas-mcp";

/**
 * Initialize OpenTelemetry for the standalone MCP process when
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
 *
 * @returns a shutdown function (flush + tear down the SDK) when telemetry was
 *   started, or `null` when it is disabled or initialization failed. Callers
 *   invoke the returned function during graceful shutdown and skip it on
 *   `null`.
 */
export async function startMcpTelemetry(): Promise<
  (() => Promise<void>) | null
> {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return null;

  try {
    const { initTelemetry } = await import("@atlas/api/lib/telemetry");
    return await initTelemetry({ serviceName: MCP_OTEL_SERVICE_NAME });
  } catch (err) {
    // Telemetry is best-effort — a failed exporter import or SDK start must
    // not stop the MCP server from serving. Log to stderr (the MCP package's
    // logging convention — stdout carries JSON-RPC on the stdio transport).
    process.stderr.write(
      `[atlas-mcp] Failed to initialize OpenTelemetry: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    return null;
  }
}
