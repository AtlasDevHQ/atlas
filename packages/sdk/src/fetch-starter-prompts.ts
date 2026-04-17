import type { StarterPrompt, StarterPromptsResponse } from "@useatlas/types";

const DEFAULT_LIMIT = 6;

/**
 * `fetch`-compatible credentials mode. Inlined as a literal union so the
 * helper can be consumed in Node environments that do not load the DOM
 * `RequestCredentials` global (SDK tsconfig has `lib: ["esnext"]`).
 */
export type FetchStarterPromptsCredentials = "omit" | "same-origin" | "include";

export interface FetchStarterPromptsConfig {
  /** Atlas API base URL. Pass `""` for same-origin. */
  apiUrl: string;
  /** `fetch` credentials policy. Pass `"include"` for cross-origin cookie auth. */
  credentials: FetchStarterPromptsCredentials;
  /** Request headers (e.g. `{ Authorization: "Bearer <apiKey>" }`). */
  headers: Record<string, string>;
  /** AbortSignal for cancellation — propagated to `fetch`. */
  signal?: AbortSignal;
  /** Max prompts to request. Defaults to 6. */
  limit?: number;
}

/**
 * Fetch the adaptive starter-prompt list for an empty-state surface.
 *
 * Distinct from `atlas.getStarterPrompts()` (on the typed `AtlasClient`):
 *   - `atlas.getStarterPrompts()` throws on every non-2xx response — correct
 *     for SDK callers that want to react to typed errors.
 *   - `fetchStarterPrompts()` soft-fails on 5xx by returning `[]` — correct
 *     for empty-state hooks where a red banner is worse than the cold-start
 *     CTA, while still throwing on 4xx so auth / rate-limit issues surface
 *     in React Query state + DevTools.
 *
 * Shared by the chat empty state (`packages/web`) and the widget empty state
 * (`packages/react`) so both surfaces encode identical discipline.
 */
export async function fetchStarterPrompts(
  config: FetchStarterPromptsConfig,
): Promise<StarterPrompt[]> {
  const { apiUrl, credentials, headers, signal, limit = DEFAULT_LIMIT } = config;

  let res: Response;
  try {
    res = await fetch(`${apiUrl}/api/v1/starter-prompts?limit=${limit}`, {
      credentials,
      headers,
      signal,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[Atlas] Starter prompts fetch failed:", msg);
    throw new Error(`Starter prompts fetch failed: ${msg}`, { cause: err });
  }

  if (!res.ok) {
    let bodyText: string;
    try {
      bodyText = await res.text();
    } catch (err) {
      bodyText = `<failed to read body: ${err instanceof Error ? err.message : String(err)}>`;
    }
    let requestId: string | undefined;
    try {
      requestId = (JSON.parse(bodyText) as { requestId?: string }).requestId;
    } catch {
      // intentionally ignored: body is not JSON (proxy error page, plain text, etc.)
    }
    const requestIdSuffix = requestId ? ` (requestId: ${requestId})` : "";
    const statusText = res.statusText || "(no status text)";

    // 5xx: transient backend fault. Soft-fail so the empty state renders its
    // cold-start CTA rather than a red banner.
    if (res.status >= 500) {
      console.warn(
        `[Atlas] Starter prompts ${res.status} ${statusText}${requestIdSuffix}; falling back to empty list`,
      );
      return [];
    }

    // 4xx: actionable client error (auth, rate limit, bad request). Throw so
    // React Query state + DevTools surface the signal to the caller.
    throw new Error(`Starter prompts ${res.status} ${statusText}${requestIdSuffix}`);
  }

  const data = (await res.json()) as Partial<StarterPromptsResponse>;
  return Array.isArray(data?.prompts) ? [...data.prompts] : [];
}
