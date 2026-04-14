"use client";

import { useState, useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Conversation, ConversationWithMessages, ShareStatus, ShareMode, ShareExpiryKey, NotebookStateWire, ForkBranchWire } from "../lib/types";
import type { UIMessage } from "@ai-sdk/react";
import { transformMessages } from "@useatlas/types/conversation";
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
  convertToNotebook: (sourceId: string) => Promise<{ id: string; messageCount: number }>;
  deleteBranch: (rootId: string, branchId: string) => Promise<void>;
  renameBranch: (rootId: string, branchId: string, label: string) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  starConversation: (id: string, starred: boolean) => Promise<void>;
  shareConversation: (id: string, opts?: { expiresIn?: ShareExpiryKey; shareMode?: ShareMode }) => Promise<{ token: string; url: string }>;
  unshareConversation: (id: string) => Promise<void>;
  getShareStatus: (id: string) => Promise<ShareStatus>;
  refresh: () => Promise<void>;
}

export { transformMessages } from "@useatlas/types/conversation";

interface ConversationListData {
  conversations: Conversation[];
  total: number;
  available: boolean;
}

export function useConversations(opts: UseConversationsOptions): UseConversationsReturn {
  const api = useMemo(
    () => createAtlasFetch(opts),
    [opts.apiUrl, opts.getHeaders, opts.getCredentials],
  );

  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Fetch conversation list via TanStack Query — automatic, cached, deduped.
  const listQuery = useQuery<ConversationListData>({
    queryKey: ["conversations", "list"],
    queryFn: async ({ signal }) => {
      let res: Response;
      try {
        res = await fetch(`${opts.apiUrl}/api/v1/conversations?limit=50`, {
          headers: opts.getHeaders(),
          credentials: opts.getCredentials(),
          signal,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn("fetchList: network error:", msg);
        throw new Error(`Failed to load conversations: ${msg}`, { cause: err });
      }

      if (!res.ok) {
        // Parse body to distinguish permanent "not_available" from transient errors.
        const errorBody = await res.json().catch(() => null);
        if (res.status === 404 && errorBody?.error === "not_available") {
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

  // Backward-compatible fetchList — triggers a refetch.
  // Propagates errors from refetch so callers that use try/catch get failures.
  const fetchList = useCallback(async () => {
    if (!opts.enabled || !available) return;
    const result = await listQuery.refetch();
    if (result.error) throw result.error;
  }, [opts.enabled, available, listQuery.refetch]);

  const loadConversation = useCallback(async (id: string): Promise<UIMessage[]> => {
    const data = await api.get<ConversationWithMessages>(`/api/v1/conversations/${id}`);
    return transformMessages(data.messages);
  }, [api]);

  const deleteConversation = useCallback(async (id: string): Promise<void> => {
    await api.del(`/api/v1/conversations/${id}`);
    // Update the query cache directly — removes the conversation without refetching.
    queryClient.setQueryData<ConversationListData>(["conversations", "list"], (old) => {
      if (!old) return old;
      return {
        ...old,
        conversations: old.conversations.filter((c) => c.id !== id),
        total: Math.max(0, old.total - 1),
      };
    });
    if (selectedId === id) setSelectedId(null);
  }, [api, queryClient, selectedId]);

  const starConversation = useCallback(async (id: string, starred: boolean): Promise<void> => {
    // Optimistic update via query cache
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
      await api.patch(`/api/v1/conversations/${id}/star`, { starred });
    } catch (err: unknown) {
      // Rollback optimistic update
      if (previousData) {
        queryClient.setQueryData(["conversations", "list"], previousData);
      }
      throw err;
    }
  }, [api, queryClient]);

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

  const deleteBranch = useCallback(async (
    rootId: string,
    branchId: string,
  ): Promise<void> => {
    await api.del(`/api/v1/conversations/${rootId}/branches/${branchId}`);
  }, [api]);

  const renameBranch = useCallback(async (
    rootId: string,
    branchId: string,
    label: string,
  ): Promise<void> => {
    await api.patch(`/api/v1/conversations/${rootId}/branches/${branchId}`, { label });
  }, [api]);

  const convertToNotebook = useCallback(async (
    sourceId: string,
  ): Promise<{ id: string; messageCount: number }> => {
    const data = await api.post<Record<string, unknown>>(`/api/v1/conversations/${sourceId}/convert-to-notebook`, {});
    if (!data.id || typeof data.id !== "string") {
      throw new Error("Convert response missing conversation ID");
    }
    return {
      id: data.id,
      messageCount: typeof data.messageCount === "number" ? data.messageCount : 0,
    };
  }, [api]);

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
    getConversationData,
    saveNotebookState,
    forkConversation,
    convertToNotebook,
    deleteBranch,
    renameBranch,
    deleteConversation,
    starConversation,
    shareConversation,
    unshareConversation,
    getShareStatus,
    refresh,
  };
}
