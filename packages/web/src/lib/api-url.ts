/**
 * Dynamic API URL resolution for regional data residency.
 *
 * Bootstrap flow:
 *   1. Page loads → getApiUrl() returns the default (build-time) URL
 *   2. User authenticates against the global API
 *   3. Settings load → regionApiUrl discovered → setRegionalApiUrl()
 *   4. All subsequent fetches use the regional URL
 *
 * Self-hosted deployments (no region config) are unaffected — getApiUrl()
 * always returns the build-time value when no regional override is set.
 */

const DEFAULT_API_URL = (process.env.NEXT_PUBLIC_ATLAS_API_URL ?? "").replace(/\/+$/, "");

/** Module-level regional override — set after settings fetch. */
let regionalApiUrl: string | null = null;

/** Returns the current API URL, preferring the regional override if set. */
export function getApiUrl(): string {
  return regionalApiUrl ?? DEFAULT_API_URL;
}

/** Whether an explicit API URL is configured (implying cross-origin deployment). */
export function isCrossOrigin(): boolean {
  return !!getApiUrl();
}

/**
 * Set the regional API URL override. Called after the settings response
 * includes a `regionApiUrl` that differs from the default.
 * Pass `null` to clear the override.
 */
export function setRegionalApiUrl(url: string | null): void {
  if (url === null) {
    regionalApiUrl = null;
    return;
  }
  const cleaned = url.replace(/\/+$/, "").trim();
  if (!cleaned) {
    regionalApiUrl = null;
    return;
  }
  try {
    new URL(cleaned);
    regionalApiUrl = cleaned;
  } catch {
    console.error(
      `setRegionalApiUrl: rejected invalid URL "${url}". Continuing with default API URL.`,
    );
  }
}

/** Reset to default (for testing). */
export function _resetApiUrl(): void {
  regionalApiUrl = null;
}
