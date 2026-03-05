/**
 * Next.js instrumentation hook.
 *
 * Initializes the OpenTelemetry SDK when OTEL_EXPORTER_OTLP_ENDPOINT is set.
 * Runs once on server startup. When the env var is absent, this is a no-op
 * and the OTel API package returns no-op tracers (zero overhead).
 *
 * The actual OTel setup lives in otel.ts — a separate file so Turbopack's
 * Edge-compatibility static analysis doesn't flag Node.js APIs like process.on.
 */

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return;

  try {
    await import("./otel");
  } catch (err) {
    console.error(
      "[atlas] Failed to initialize OpenTelemetry:",
      err instanceof Error ? err.message : String(err),
      "— tracing disabled for this process",
    );
  }
}
