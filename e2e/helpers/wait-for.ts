/**
 * Polling helpers for E2E tests.
 *
 * Wait for a URL to become healthy or a predicate to become true.
 */

/**
 * Poll a URL until it returns a 2xx status.
 *
 * @param url - URL to poll (e.g. "http://localhost:3099/api/health")
 * @param timeoutMs - Max wait time before throwing (default: 30000)
 * @param intervalMs - Time between polls (default: 500)
 */
export async function waitForHealthy(
  url: string,
  timeoutMs = 30_000,
  intervalMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: string | undefined;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.status >= 200 && res.status < 300) return;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await Bun.sleep(intervalMs);
  }

  throw new Error(`waitForHealthy(${url}) timed out after ${timeoutMs}ms: ${lastError}`);
}

/**
 * Poll a predicate function until it returns true.
 * Exceptions from the predicate are caught and treated as "not ready yet",
 * matching the retry semantics of waitForHealthy.
 *
 * @param fn - Async function that returns true when ready
 * @param timeoutMs - Max wait time (default: 10000)
 * @param intervalMs - Time between polls (default: 200)
 */
export async function waitFor(
  fn: () => Promise<boolean> | boolean,
  timeoutMs = 10_000,
  intervalMs = 200,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: string | undefined;

  while (Date.now() < deadline) {
    try {
      if (await fn()) return;
      lastError = "predicate returned false";
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await Bun.sleep(intervalMs);
  }

  throw new Error(`waitFor() timed out after ${timeoutMs}ms: ${lastError}`);
}
