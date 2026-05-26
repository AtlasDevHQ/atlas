/**
 * Permanent-vs-transient classification for outbox dispatch errors
 * (#2729). The outbox itself is generic — this module is also generic:
 * callers pass in a status (`number`) and we apply the HTTP-based
 * rules. The Twenty-specific extraction (mapping `TwentyClientError` →
 * status code) lives next to the dispatcher in
 * `ee/src/saas-crm/index.ts`, keeping `lib/lead-outbox/` free of any
 * `@useatlas/twenty` import. (Retry-After parsing is a separate concern
 * — the dispatcher reads it off the upstream error and surfaces it on
 * `DispatchOutcome.transient.retryAfterMs`; this module only buckets
 * the status into retry vs dead-letter.)
 */

export type Classification = "permanent" | "transient";

/** Retryable 4xx status codes per RFC 9110 + community convention. */
const RETRYABLE_4XX = new Set<number>([
  408, // Request Timeout — server closed idle connection / slow upstream
  425, // Too Early — used by CDNs to refuse TLS-replay-window requests
  429, // Too Many Requests — rate limited
]);

/**
 * HTTP status → permanent (dead-letter immediately) or transient
 * (retry with backoff).
 *
 * Rules per #2729 (extended by the slice-2 review to cover 408/425):
 *   - 4xx in `RETRYABLE_4XX` (408, 425, 429) → transient
 *   - Other 4xx → permanent (deterministic misconfig)
 *   - 5xx → transient (upstream outage)
 *   - 0 / network / timeout → transient (transport flake)
 *   - 2xx / 3xx are not failures and should never reach here, but if
 *     they do, classify as permanent to fail loud — a "successful"
 *     response that the caller still threw on indicates a code bug.
 */
export function classifyHttpStatus(status: number): Classification {
  if (!Number.isFinite(status)) return "transient";
  if (status === 0) return "transient";
  if (status >= 500 && status < 600) return "transient";
  if (RETRYABLE_4XX.has(status)) return "transient";
  if (status >= 400 && status < 500) return "permanent";
  return "permanent";
}
