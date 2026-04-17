"use client";

import { useQuery } from "@tanstack/react-query";
import type { StarterPrompt, StarterPromptsResponse } from "@useatlas/types/starter-prompt";

const STARTER_PROMPTS_LIMIT = 6;

export interface UseStarterPromptsQueryOptions {
  /** Atlas API base URL. Pass `""` for same-origin. */
  apiUrl: string;
  /** When true, send credentials on the fetch (cookies / managed auth). */
  isCrossOrigin: boolean;
  /** Returns the request headers to attach (Authorization for simple-key auth). */
  getHeaders: () => Record<string, string>;
  /** Gates the query off until auth / transport are resolved. */
  enabled: boolean;
}

/**
 * TanStack Query wrapper around `GET /api/v1/starter-prompts`.
 *
 * Shared by the chat empty state and the notebook new-cell empty state so
 * both surfaces render the same adaptive list without re-implementing
 * fetch / retry / cache semantics. Cross-surface re-mounts (e.g. leaving
 * notebook → entering chat) are deduplicated by the shared query cache.
 */
export function useStarterPromptsQuery({
  apiUrl,
  isCrossOrigin,
  getHeaders,
  enabled,
}: UseStarterPromptsQueryOptions) {
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";

  return useQuery<StarterPrompt[]>({
    queryKey: ["atlas", "starter-prompts", apiUrl],
    queryFn: async ({ signal }) => {
      let res: Response;
      try {
        res = await fetch(
          `${apiUrl}/api/v1/starter-prompts?limit=${STARTER_PROMPTS_LIMIT}`,
          {
            credentials,
            headers: getHeaders(),
            signal,
          },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn("[Atlas] Starter prompts fetch failed:", msg);
        throw new Error(`Starter prompts fetch failed: ${msg}`, { cause: err });
      }

      if (!res.ok) {
        // 5xx = transient backend fault. Soft-fail with [] so the empty
        // state still renders its cold-start CTA rather than a red banner.
        // 4xx throws so admin DevTools + React Query state surface the
        // auth / rate-limit signal that the caller should react to.
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
          // intentionally ignored: body is not JSON (proxy error page etc.)
        }
        const requestIdSuffix = requestId ? ` (requestId: ${requestId})` : "";
        if (res.status >= 500) {
          console.warn(
            `[Atlas] Starter prompts ${res.status} ${res.statusText}${requestIdSuffix}; falling back to empty list`,
          );
          return [];
        }
        throw new Error(
          `Starter prompts ${res.status} ${res.statusText || "(no status text)"}${requestIdSuffix}`,
        );
      }

      const data = (await res.json()) as Partial<StarterPromptsResponse>;
      return Array.isArray(data?.prompts) ? [...data.prompts] : [];
    },
    enabled,
    retry: 1,
    staleTime: 60_000,
  });
}
