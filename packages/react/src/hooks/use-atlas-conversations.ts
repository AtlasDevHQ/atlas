"use client";

import type { UIMessage } from "@ai-sdk/react";
import { useAtlasContext } from "./provider";
import { useConversations } from "./use-conversations";
import type { Conversation } from "../lib/types";

export interface UseAtlasConversationsOptions {
  /** When false, refresh() becomes a no-op. Defaults to true. */
  enabled?: boolean;
}

export interface UseAtlasConversationsReturn {
  conversations: Conversation[];
  total: number;
  isLoading: boolean;
  available: boolean;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  refresh: () => Promise<void>;
  loadConversation: (id: string) => Promise<UIMessage[] | null>;
  deleteConversation: (id: string) => Promise<boolean>;
  starConversation: (id: string, starred: boolean) => Promise<boolean>;
}

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

  const inner = useConversations({
    apiUrl,
    enabled,
    getHeaders: () => {
      const headers: Record<string, string> = {};
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      return headers;
    },
    getCredentials: () => (isCrossOrigin ? "include" : "same-origin"),
  });

  return {
    conversations: inner.conversations,
    total: inner.total,
    isLoading: inner.loading,
    available: inner.available,
    selectedId: inner.selectedId,
    setSelectedId: inner.setSelectedId,
    refresh: inner.refresh,
    loadConversation: inner.loadConversation,
    deleteConversation: inner.deleteConversation,
    starConversation: inner.starConversation,
  };
}
