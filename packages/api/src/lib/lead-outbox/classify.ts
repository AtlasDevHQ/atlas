/**
 * Permanent-vs-transient classification for outbox dispatch errors
 * (#2729). The outbox itself is generic — this module is also generic:
 * callers pass in a status (`number`) and we apply the HTTP-based
 * rules. The Twenty-specific extraction (mapping `TwentyClientError` →
 * status + retryAfter) lives next to the dispatcher in
 * `ee/src/saas-crm/index.ts`, keeping `lib/lead-outbox/` free of any
 * `@useatlas/twenty` import.
 */

export type Classification = "permanent" | "transient";

/**
 * HTTP status → permanent (dead-letter immediately) or transient
 * (retry with backoff).
 *
 * Rules per #2729:
 *   - 4xx other than 429 → permanent (deterministic misconfig)
 *   - 429 → transient (rate limited; backoff will spread the retry)
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
  if (status === 429) return "transient";
  if (status >= 400 && status < 500) return "permanent";
  return "permanent";
}
