/**
 * Detect a running local Atlas instance for the init flow.
 *
 * Pings `${url}/api/v1/health` with a short timeout. Used so `init --local`
 * can prefer a locally running Atlas over the bundled fixture when the user
 * has one running (e.g. `bun run dev` in another terminal).
 */

const DEFAULT_URL = "http://localhost:3001";

export interface DetectOpts {
  url?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function detectLocalAtlas(opts: DetectOpts = {}): Promise<boolean> {
  const url = opts.url ?? DEFAULT_URL;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 1000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${url}/api/v1/health`, { signal: controller.signal });
    return res.ok;
  } catch (err) {
    // Expected on timeout or connection refused — Atlas isn't running. Log
    // to stderr behind ATLAS_DEBUG_INIT for diagnosis but never propagate;
    // a probe miss is not a fatal error for the init flow.
    if (process.env.ATLAS_DEBUG_INIT) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[atlas-mcp init] local-atlas probe failed: ${msg}`);
    }
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function resolveApiUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.ATLAS_API_URL ?? DEFAULT_URL;
}
