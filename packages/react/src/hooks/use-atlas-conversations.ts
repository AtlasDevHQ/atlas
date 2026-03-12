"use client";

import { useAtlasContext } from "./provider";
import { useConversations, type UseConversationsReturn } from "./use-conversations";

export interface UseAtlasConversationsOptions {
  /** Enable fetching conversations. Defaults to true. */
  enabled?: boolean;
}

export type UseAtlasConversationsReturn = UseConversationsReturn;

/**
 * Manage conversation history with auth automatically wired from AtlasProvider.
 *
 * Wraps the lower-level `useConversations` hook with context-derived
 * API URL and credentials.
 */
export function useAtlasConversations(
  options: UseAtlasConversationsOptions = {},
): UseAtlasConversationsReturn {
  const { apiUrl, apiKey, isCrossOrigin } = useAtlasContext();
  const { enabled = true } = options;

  return useConversations({
    apiUrl,
    enabled,
    getHeaders: () => {
      const headers: Record<string, string> = {};
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      return headers;
    },
    getCredentials: () => (isCrossOrigin ? "include" : "same-origin"),
  });
}
