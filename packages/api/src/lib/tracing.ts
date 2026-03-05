/**
 * Lightweight tracing helper.
 *
 * Wraps async functions in OpenTelemetry spans. When the OTel SDK is not
 * initialized (no OTEL_EXPORTER_OTLP_ENDPOINT), @opentelemetry/api returns
 * a no-op tracer — zero overhead, no conditional imports needed.
 */

import { trace, SpanStatusCode, type Attributes } from "@opentelemetry/api";

const tracer = trace.getTracer("atlas");

/**
 * Execute `fn` inside an OTel span. Sets span status and records exceptions
 * on failure. When OTel is not initialized the span is a no-op.
 */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: () => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      span.recordException(
        err instanceof Error ? err : new Error(String(err)),
      );
      throw err;
    } finally {
      span.end();
    }
  });
}
