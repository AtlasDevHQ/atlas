/**
 * Shared HTTP transport helpers for the sandbox sidecar backends.
 *
 * The explore sidecar (`explore-sidecar.ts`) and the Python sidecar
 * (`python-sidecar.ts`, both the buffered and streaming paths) talk to the same
 * sidecar service over HTTP with the same auth scheme and the same fetch-error
 * classification. Before #4187 the connection/timeout classifiers and the
 * bearer-auth header were copy-pasted across three call sites; this module is
 * the single home for them so a change to how a down sidecar is detected can't
 * land in one path and miss another.
 */

/**
 * True when a fetch rejection detail indicates the sidecar is unreachable
 * (connection refused / DNS / socket failure) rather than a slow/timed-out or
 * HTTP-level error. Callers treat this as "the service is down": explore
 * invalidates its backend cache to fall back; Python surfaces an unreachable
 * error.
 */
export function isSidecarConnectionError(detail: string): boolean {
  return (
    detail.includes("ECONNREFUSED") ||
    detail.includes("fetch failed") ||
    detail.includes("Failed to connect")
  );
}

/**
 * True when a fetch rejection detail indicates the request timed out or was
 * aborted (as opposed to the connection being refused outright).
 */
export function isSidecarTimeoutError(detail: string): boolean {
  return (
    detail.includes("TimeoutError") ||
    detail.includes("timed out") ||
    detail.includes("aborted")
  );
}

/**
 * Request headers for a sidecar call: JSON content type plus an optional
 * `Authorization: Bearer <token>` when `SIDECAR_AUTH_TOKEN` is configured.
 * One statement of the auth scheme shared by every sidecar request.
 */
export function sidecarRequestHeaders(): Record<string, string> {
  const authToken = process.env.SIDECAR_AUTH_TOKEN;
  return {
    "Content-Type": "application/json",
    ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
  };
}
