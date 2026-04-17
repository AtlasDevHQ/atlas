"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchStarterPrompts } from "@useatlas/sdk";
import type { StarterPrompt } from "@useatlas/types/starter-prompt";

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
 * TanStack Query wrapper around the shared `fetchStarterPrompts` helper.
 *
 * Both the chat empty state and the notebook new-cell empty state call this
 * so they share a single query cache entry. 5xx soft-fail / 4xx throw
 * semantics live in the SDK helper — this hook is pure transport plumbing.
 */
export function useStarterPromptsQuery({
  apiUrl,
  isCrossOrigin,
  getHeaders,
  enabled,
}: UseStarterPromptsQueryOptions) {
  return useQuery<StarterPrompt[]>({
    queryKey: ["atlas", "starter-prompts", apiUrl],
    queryFn: ({ signal }) =>
      fetchStarterPrompts({
        apiUrl,
        credentials: isCrossOrigin ? "include" : "same-origin",
        headers: getHeaders(),
        signal,
        limit: STARTER_PROMPTS_LIMIT,
      }),
    enabled,
    retry: 1,
    staleTime: 60_000,
  });
}
