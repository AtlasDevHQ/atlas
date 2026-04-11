"use client";

import { useState, useCallback, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Conversation, ConversationWithMessages, Message } from "../lib/types";
import type { UIMessage } from "@ai-sdk/react";

export interface UseConversationsOptions {
  apiUrl: string;
  enabled: boolean;
  getHeaders: () => Record<string, string>;
  getCredentials: () => RequestCredentials;
  /** Custom conversations API endpoint path. Defaults to "/api/v1/conversations". */
  conversationsEndpoint?: string;
}

export interface UseConversationsReturn {
  conversations: Conversation[];
  total: number;
  loading: boolean;
  available: boolean;
  fetchError: string | null;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  fetchList: () => Promise<void>;
  loadConversation: (id: string) => Promise<UIMessage[]>;
  deleteConversation: (id: string) => Promise<void>;
  starConversation: (id: string, starred: boolean) => Promise<void>;
  refresh: () => Promise<void>;
}

export function transformMessages(messages: Message[]): UIMessage[] {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => {
      const parts: UIMessage["parts"] = Array.isArray(m.content)
        ? (m.content as Record<string, unknown>[])
            .filter((p) => p.type === "text" || p.type === "tool-invocation")
            .map((p, idx) => {
              if (p.type === "tool-invocation") {
                const toolCallId = typeof p.toolCallId === "string" && p.toolCallId
                  ? p.toolCallId
                  : `unknown-${idx}`;
                return {
                  type: "dynamic-tool" as const,
                  toolName: typeof p.toolName === "string" ? p.toolName : "unknown",
                  toolCallId,
                  toolInvocationId: toolCallId,
                  state: "output-available" as const,
                  input: p.args,
                  output: p.result,
                };
              }
              return { type: "text" as const, text: String(p.text ?? "") };
            })
        : [{ type: "text" as const, text: String(m.content) }];

      return {
        id: m.id,
        role: m.role as "user" | "assistant",
        parts,
      };
    });
}

interface ConversationListData {
  conversations: Conversation[];
  total: number;
  available: boolean;
}

export function useConversations(opts: UseConversationsOptions): UseConversationsReturn {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const baseEndpoint = opts.conversationsEndpoint ?? "/api/v1/conversations";

  const listQuery = useQuery<ConversationListData>({
    queryKey: ["conversations", "list"],
    queryFn: async ({ signal }) => {
      let res: Response;
      try {
        res = await fetch(`${opts.apiUrl}${baseEndpoint}?limit=50`, {
          headers: opts.getHeaders(),
          credentials: opts.getCredentials(),
          signal,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn("fetchList: network error:", msg);
        throw new Error(`Failed to load conversations: ${msg}`, { cause: err });
      }

      if (res.status === 404) {
        // Widget context: bare 404 means the conversations API is not available.
        return { conversations: [], total: 0, available: false };
      }

      if (!res.ok) {
        const errorBody = await res.json().catch(() => null);
        if (errorBody?.error === "not_available") {
          return { conversations: [], total: 0, available: false };
        }
        console.warn(`fetchList: HTTP ${res.status}`, errorBody);
        throw new Error("Failed to load conversations. Please reload the page to try again.");
      }

      const data = await res.json();
      return {
        conversations: data.conversations ?? [],
        total: data.total ?? 0,
        available: true,
      };
    },
    enabled: opts.enabled,
  });

  const conversations = listQuery.data?.conversations ?? [];
  const total = listQuery.data?.total ?? 0;
  const available = listQuery.data?.available ?? true;
  const loading = listQuery.isPending && opts.enabled;
  const fetchError = listQuery.error
    ? (listQuery.error instanceof Error ? listQuery.error.message : "Failed to load conversations")
    : null;

  // Stable ref for refetch — listQuery.refetch changes identity each render.
  const refetchRef = useRef(listQuery.refetch);
  refetchRef.current = listQuery.refetch;

  const fetchList = useCallback(async () => {
    if (!opts.enabled || !available) return;
    const result = await refetchRef.current();
    if (result.error) throw result.error;
  }, [opts.enabled, available]);

  const loadConversation = useCallback(async (id: string): Promise<UIMessage[]> => {
    const res = await fetch(`${opts.apiUrl}${baseEndpoint}/${id}`, {
      headers: opts.getHeaders(),
      credentials: opts.getCredentials(),
    });
    if (!res.ok) {
      console.warn(`loadConversation: HTTP ${res.status} for ${id}`);
      throw new Error(`Failed to load conversation (HTTP ${res.status})`);
    }
    const data: ConversationWithMessages = await res.json();
    return transformMessages(data.messages);
  }, [opts.apiUrl, opts.getHeaders, opts.getCredentials, baseEndpoint]);

  const deleteConversation = useCallback(async (id: string): Promise<void> => {
    const res = await fetch(`${opts.apiUrl}${baseEndpoint}/${id}`, {
      method: "DELETE",
      headers: opts.getHeaders(),
      credentials: opts.getCredentials(),
    });
    if (!res.ok) {
      console.warn(`deleteConversation: HTTP ${res.status} for ${id}`);
      throw new Error(`Failed to delete conversation (HTTP ${res.status})`);
    }
    queryClient.setQueryData<ConversationListData>(["conversations", "list"], (old) => {
      if (!old) return old;
      return {
        ...old,
        conversations: old.conversations.filter((c) => c.id !== id),
        total: Math.max(0, old.total - 1),
      };
    });
    if (selectedId === id) setSelectedId(null);
  }, [opts.apiUrl, opts.getHeaders, opts.getCredentials, baseEndpoint, queryClient, selectedId]);

  const starConversation = useCallback(async (id: string, starred: boolean): Promise<void> => {
    const previousData = queryClient.getQueryData<ConversationListData>(["conversations", "list"]);
    queryClient.setQueryData<ConversationListData>(["conversations", "list"], (old) => {
      if (!old) return old;
      return {
        ...old,
        conversations: old.conversations.map((c) =>
          c.id === id ? { ...c, starred } : c,
        ),
      };
    });
    try {
      const res = await fetch(`${opts.apiUrl}${baseEndpoint}/${id}/star`, {
        method: "PATCH",
        headers: { ...opts.getHeaders(), "Content-Type": "application/json" },
        credentials: opts.getCredentials(),
        body: JSON.stringify({ starred }),
      });
      if (!res.ok) {
        console.warn(`starConversation: HTTP ${res.status} for ${id}`);
        throw new Error(`Failed to update star (HTTP ${res.status})`);
      }
    } catch (err) {
      if (previousData) {
        queryClient.setQueryData(["conversations", "list"], previousData);
      }
      throw err;
    }
  }, [opts.apiUrl, opts.getHeaders, opts.getCredentials, baseEndpoint, queryClient]);

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ["conversations", "list"] });
  }, [queryClient]);

  return {
    conversations,
    total,
    loading,
    available,
    fetchError,
    selectedId,
    setSelectedId,
    fetchList,
    loadConversation,
    deleteConversation,
    starConversation,
    refresh,
  };
}
