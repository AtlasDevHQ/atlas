"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchStarterPrompts } from "@useatlas/sdk";
import type { StarterPrompt } from "@useatlas/types/starter-prompt";
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

  return useQuery<StarterPrompt[]>({
    queryKey: ["atlas", "starter-prompts", apiUrl],
    queryFn: ({ signal }) =>
      fetchStarterPrompts({
        apiUrl,
        credentials: isCrossOrigin ? "include" : "same-origin",
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal,
        limit: STARTER_PROMPTS_LIMIT,
      }),
    enabled,
    retry: 1,
    staleTime: 60_000,
  });
}
