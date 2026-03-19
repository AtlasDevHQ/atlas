"use client";

import { useState, useCallback, useRef } from "react";
import type { Conversation, ConversationWithMessages, Message, ShareStatus, ShareMode, ShareExpiryKey } from "../lib/types";
import type { UIMessage } from "@ai-sdk/react";

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
      const res = await fetch(`${opts.apiUrl}/api/v1/conversations?limit=50`, {
        headers: opts.getHeaders(),
        credentials: opts.getCredentials(),
      });

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
  }, [opts.apiUrl, opts.enabled, opts.getHeaders, opts.getCredentials, available]);

  const loadConversation = useCallback(async (id: string): Promise<UIMessage[]> => {
    const res = await fetch(`${opts.apiUrl}/api/v1/conversations/${id}`, {
      headers: opts.getHeaders(),
      credentials: opts.getCredentials(),
    });

    if (!res.ok) {
      console.warn(`loadConversation: HTTP ${res.status} for ${id}`);
      throw new Error(`Failed to load conversation (HTTP ${res.status})`);
    }

    const data: ConversationWithMessages = await res.json();
    return transformMessages(data.messages);
  }, [opts.apiUrl, opts.getHeaders, opts.getCredentials]);

  const deleteConversation = useCallback(async (id: string): Promise<void> => {
    const res = await fetch(`${opts.apiUrl}/api/v1/conversations/${id}`, {
      method: "DELETE",
      headers: opts.getHeaders(),
      credentials: opts.getCredentials(),
    });

    if (!res.ok) {
      console.warn(`deleteConversation: HTTP ${res.status} for ${id}`);
      throw new Error(`Failed to delete conversation (HTTP ${res.status})`);
    }

    setConversations((prev) => prev.filter((c) => c.id !== id));
    setTotal((prev) => Math.max(0, prev - 1));

    if (selectedId === id) setSelectedId(null);
  }, [opts.apiUrl, opts.getHeaders, opts.getCredentials, selectedId]);

  const starConversation = useCallback(async (id: string, starred: boolean): Promise<void> => {
    // Optimistic update
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, starred } : c)),
    );
    let rolledBack = false;
    try {
      const res = await fetch(`${opts.apiUrl}/api/v1/conversations/${id}/star`, {
        method: "PATCH",
        headers: { ...opts.getHeaders(), "Content-Type": "application/json" },
        credentials: opts.getCredentials(),
        body: JSON.stringify({ starred }),
      });

      if (!res.ok) {
        console.warn(`starConversation: HTTP ${res.status} for ${id}`);
        setConversations((prev) =>
          prev.map((c) => (c.id === id ? { ...c, starred: !starred } : c)),
        );
        rolledBack = true;
        throw new Error(`Failed to update star (HTTP ${res.status})`);
      }
    } catch (err: unknown) {
      if (!rolledBack) {
        setConversations((prev) =>
          prev.map((c) => (c.id === id ? { ...c, starred: !starred } : c)),
        );
      }
      throw err;
    }
  }, [opts.apiUrl, opts.getHeaders, opts.getCredentials]);

  const shareConversation = useCallback(async (id: string, shareOpts?: { expiresIn?: ShareExpiryKey; shareMode?: ShareMode }): Promise<{ token: string; url: string }> => {
    const res = await fetch(`${opts.apiUrl}/api/v1/conversations/${id}/share`, {
      method: "POST",
      headers: { ...opts.getHeaders(), "Content-Type": "application/json" },
      credentials: opts.getCredentials(),
      body: shareOpts ? JSON.stringify(shareOpts) : undefined,
    });
    if (!res.ok) {
      console.warn(`shareConversation: HTTP ${res.status} for ${id}`);
      throw new Error(`Failed to share conversation (HTTP ${res.status})`);
    }
    const data = await res.json();
    if (!data?.token || typeof data.token !== "string") {
      console.warn(`shareConversation: missing token in response for ${id}`);
      throw new Error("Share response missing token");
    }
    return {
      token: data.token,
      url: data.url ?? `${window.location.origin}/shared/${data.token}`,
    };
  }, [opts.apiUrl, opts.getHeaders, opts.getCredentials]);

  const unshareConversation = useCallback(async (id: string): Promise<void> => {
    const res = await fetch(`${opts.apiUrl}/api/v1/conversations/${id}/share`, {
      method: "DELETE",
      headers: opts.getHeaders(),
      credentials: opts.getCredentials(),
    });
    if (!res.ok) {
      console.warn(`unshareConversation: HTTP ${res.status} for ${id}`);
      throw new Error(`Failed to unshare conversation (HTTP ${res.status})`);
    }
  }, [opts.apiUrl, opts.getHeaders, opts.getCredentials]);

  const getShareStatus = useCallback(async (id: string): Promise<ShareStatus> => {
    const res = await fetch(`${opts.apiUrl}/api/v1/conversations/${id}/share`, {
      headers: opts.getHeaders(),
      credentials: opts.getCredentials(),
    });
    if (!res.ok) {
      console.warn(`getShareStatus: HTTP ${res.status} for ${id}`);
      throw new Error(`Failed to get share status (HTTP ${res.status})`);
    }
    const data: ShareStatus = await res.json();
    return data;
  }, [opts.apiUrl, opts.getHeaders, opts.getCredentials]);

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
    deleteConversation,
    starConversation,
    shareConversation,
    unshareConversation,
    getShareStatus,
    refresh,
  };
}
