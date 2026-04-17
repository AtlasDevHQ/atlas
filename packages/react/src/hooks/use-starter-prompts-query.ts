"use client";

import { useQuery } from "@tanstack/react-query";
import type { StarterPrompt, StarterPromptsResponse } from "@useatlas/types/starter-prompt";
import { useAtlasContext } from "../context";

const STARTER_PROMPTS_LIMIT = 6;

interface UseStarterPromptsQueryOptions {
  /** When `true`, the query is enabled and fetches from `/api/v1/starter-prompts`. */
  enabled: boolean;
  /** API key for simple-key auth — sent as `Authorization: Bearer <apiKey>`. */
  apiKey?: string;
}

/**
 * Fetch the adaptive starter-prompt list for the widget empty state.
 *
 * Disabled when the host application provides a static `starterPrompts` prop —
 * the widget must NOT identify the embedded user via this endpoint when an
 * override is in effect, so the query is gated rather than always-fetched.
 */
export function useStarterPromptsQuery({ enabled, apiKey }: UseStarterPromptsQueryOptions) {
  const { apiUrl, isCrossOrigin } = useAtlasContext();
  const credentials: "include" | "omit" | "same-origin" = isCrossOrigin ? "include" : "same-origin";

  return useQuery<StarterPrompt[]>({
    queryKey: ["atlas", "starter-prompts", apiUrl],
    queryFn: async ({ signal }) => {
      const headers: Record<string, string> = {};
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

      let res: Response;
      try {
        res = await fetch(`${apiUrl}/api/v1/starter-prompts?limit=${STARTER_PROMPTS_LIMIT}`, {
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
        // Distinguish 4xx (actionable client error — auth, rate limit) from
        // 5xx (transient server fault). For 5xx, soft-fail with [] so the
        // empty state stays usable. For 4xx, throw so the embedder can see
        // the failure in DevTools and React Query state.
        const statusText = res.statusText || "(no status text)";
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
          // intentionally ignored: body is not JSON (e.g. HTML proxy error page)
        }
        const requestIdSuffix = requestId ? ` (requestId: ${requestId})` : "";
        if (res.status >= 500) {
          console.warn(
            `[Atlas] Starter prompts ${res.status} ${statusText}${requestIdSuffix}; falling back to empty list`,
          );
          return [];
        }
        throw new Error(
          `Starter prompts ${res.status} ${statusText}${requestIdSuffix}`,
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
