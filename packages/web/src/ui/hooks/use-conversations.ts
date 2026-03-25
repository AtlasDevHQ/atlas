"use client";

import { useState, useCallback, useRef, useMemo } from "react";
import type { Conversation, ConversationWithMessages, Message, ShareStatus, ShareMode, ShareExpiryKey, NotebookStateWire, ForkBranchWire } from "../lib/types";
import type { UIMessage } from "@ai-sdk/react";
import { createAtlasFetch } from "../lib/fetch-client";

export interface UseConversationsOptions {
  apiUrl: string;
  enabled: boolean;
  getHeaders: () => Record<string, string>;
  getCredentials: () => RequestCredentials;
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
  getConversationData: (id: string) => Promise<ConversationWithMessages>;
  saveNotebookState: (id: string, state: NotebookStateWire) => Promise<void>;
  forkConversation: (sourceId: string, forkPointMessageId: string, label?: string) => Promise<{ id: string; branches: ForkBranchWire[]; warning?: string }>;
  deleteConversation: (id: string) => Promise<void>;
  starConversation: (id: string, starred: boolean) => Promise<void>;
  shareConversation: (id: string, opts?: { expiresIn?: ShareExpiryKey; shareMode?: ShareMode }) => Promise<{ token: string; url: string }>;
  unshareConversation: (id: string) => Promise<void>;
  getShareStatus: (id: string) => Promise<ShareStatus>;
  refresh: () => Promise<void>;
}

export function transformMessages(messages: Message[]): UIMessage[] {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => {
      const parts: UIMessage["parts"] = Array.isArray(m.content)
        ? m.content
            .filter((p: { type?: string }) => p.type === "text")
            .map((p: { text?: string }) => ({ type: "text" as const, text: p.text ?? "" }))
        : [{ type: "text" as const, text: String(m.content) }];

      return {
        id: m.id,
        role: m.role as "user" | "assistant",
        parts,
      };
    });
}

export function useConversations(opts: UseConversationsOptions): UseConversationsReturn {
  const api = useMemo(
    () => createAtlasFetch(opts),
    [opts.apiUrl, opts.getHeaders, opts.getCredentials],
  );

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [available, setAvailable] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const fetchedRef = useRef(false);

  const fetchList = useCallback(async () => {
    if (!opts.enabled || !available) return;
    setLoading(true);
    setFetchError(null);
    try {
      const res = await api.raw("GET", "/api/v1/conversations?limit=50");

      if (res.status === 404) {
        setAvailable(false);
        return;
      }

      if (!res.ok) {
        // intentionally ignored: response may not be JSON
        const errorBody = await res.json().catch(() => null);
        if (errorBody?.code === "not_available") {
          setAvailable(false);
          return;
        }
        console.warn(`fetchList: HTTP ${res.status}`, errorBody);
        setFetchError("Failed to load conversations. Please reload the page to try again.");
        return;
      }

      const data = await res.json();
      setConversations(data.conversations ?? []);
      setTotal(data.total ?? 0);
      fetchedRef.current = true;
    } catch (err: unknown) {
      console.warn("fetchList error:", err instanceof Error ? err.message : String(err));
      setFetchError("Failed to load conversations. Please reload the page to try again.");
    } finally {
      setLoading(false);
    }
  }, [api, opts.enabled, available]);

  const loadConversation = useCallback(async (id: string): Promise<UIMessage[]> => {
    const data = await api.get<ConversationWithMessages>(`/api/v1/conversations/${id}`);
    return transformMessages(data.messages);
  }, [api]);

  const deleteConversation = useCallback(async (id: string): Promise<void> => {
    await api.del(`/api/v1/conversations/${id}`);
    setConversations((prev) => prev.filter((c) => c.id !== id));
    setTotal((prev) => Math.max(0, prev - 1));
    if (selectedId === id) setSelectedId(null);
  }, [api, selectedId]);

  const starConversation = useCallback(async (id: string, starred: boolean): Promise<void> => {
    // Optimistic update
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, starred } : c)),
    );
    try {
      await api.patch(`/api/v1/conversations/${id}/star`, { starred });
    } catch (err: unknown) {
      setConversations((prev) =>
        prev.map((c) => (c.id === id ? { ...c, starred: !starred } : c)),
      );
      throw err;
    }
  }, [api]);

  const shareConversation = useCallback(async (id: string, shareOpts?: { expiresIn?: ShareExpiryKey; shareMode?: ShareMode }): Promise<{ token: string; url: string }> => {
    const data = await api.post<Record<string, unknown>>(`/api/v1/conversations/${id}/share`, shareOpts);
    if (!data?.token || typeof data.token !== "string") {
      console.warn(`shareConversation: missing token in response for ${id}`);
      throw new Error("Share response missing token");
    }
    return {
      token: data.token,
      url: typeof data.url === "string" ? data.url : `${window.location.origin}/shared/${data.token}`,
    };
  }, [api]);

  const unshareConversation = useCallback(async (id: string): Promise<void> => {
    await api.del(`/api/v1/conversations/${id}/share`);
  }, [api]);

  const getShareStatus = useCallback(async (id: string): Promise<ShareStatus> => {
    return api.get<ShareStatus>(`/api/v1/conversations/${id}/share`);
  }, [api]);

  const getConversationData = useCallback(async (id: string): Promise<ConversationWithMessages> => {
    return api.get<ConversationWithMessages>(`/api/v1/conversations/${id}`);
  }, [api]);

  const saveNotebookState = useCallback(async (id: string, state: NotebookStateWire): Promise<void> => {
    try {
      await api.patch(`/api/v1/conversations/${id}/notebook-state`, state);
    } catch (err: unknown) {
      // Non-fatal — localStorage is still the backup
      console.warn(
        "saveNotebookState error:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }, [api]);

  const forkConversation = useCallback(async (
    sourceId: string,
    forkPointMessageId: string,
    label?: string,
  ): Promise<{ id: string; branches: ForkBranchWire[]; warning?: string }> => {
    const data = await api.post<Record<string, unknown>>(`/api/v1/conversations/${sourceId}/fork`, { forkPointMessageId, label });
    if (!data.id || typeof data.id !== "string") {
      throw new Error("Fork response missing conversation ID");
    }
    return {
      id: data.id,
      branches: (data.branches ?? []) as ForkBranchWire[],
      warning: typeof data.warning === "string" ? data.warning : undefined,
    };
  }, [api]);

  const refresh = useCallback(async () => {
    await fetchList();
  }, [fetchList]);

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
    getConversationData,
    saveNotebookState,
    forkConversation,
    deleteConversation,
    starConversation,
    shareConversation,
    unshareConversation,
    getShareStatus,
    refresh,
  };
}
