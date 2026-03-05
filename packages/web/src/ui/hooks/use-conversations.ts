"use client";

import { useState, useCallback, useRef } from "react";
import type { Conversation, ConversationWithMessages, Message } from "../lib/types";
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
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  fetchList: () => Promise<void>;
  loadConversation: (id: string) => Promise<UIMessage[] | null>;
  deleteConversation: (id: string) => Promise<boolean>;
  starConversation: (id: string, starred: boolean) => Promise<boolean>;
  refresh: () => Promise<void>;
}

export function transformMessages(messages: Message[]): UIMessage[] {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => {
      const content = typeof m.content === "string"
        ? m.content
        : JSON.stringify(m.content);

      return {
        id: m.id,
        role: m.role as "user" | "assistant",
        parts: [{ type: "text" as const, text: content }],
      };
    });
}

export function useConversations(opts: UseConversationsOptions): UseConversationsReturn {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [available, setAvailable] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const fetchedRef = useRef(false);

  const fetchList = useCallback(async () => {
    if (!opts.enabled || !available) return;
    setLoading(true);
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
        const errorBody = await res.json().catch(() => null);
        if (errorBody?.code === "not_available") {
          setAvailable(false);
          return;
        }
        console.warn(`fetchList: HTTP ${res.status}`, errorBody);
        return;
      }

      const data = await res.json();
      setConversations(data.conversations ?? []);
      setTotal(data.total ?? 0);
      fetchedRef.current = true;
    } catch (err) {
      console.warn("fetchList error:", err);
      // Network error on first attempt — permanently disable conversations for this session. A page reload resets this.
      if (!fetchedRef.current) setAvailable(false);
    } finally {
      setLoading(false);
    }
  }, [opts.apiUrl, opts.enabled, opts.getHeaders, opts.getCredentials, available]);

  const loadConversation = useCallback(async (id: string): Promise<UIMessage[] | null> => {
    try {
      const res = await fetch(`${opts.apiUrl}/api/v1/conversations/${id}`, {
        headers: opts.getHeaders(),
        credentials: opts.getCredentials(),
      });

      if (!res.ok) {
        console.warn(`loadConversation: HTTP ${res.status} for ${id}`);
        return null;
      }

      const data: ConversationWithMessages = await res.json();
      return transformMessages(data.messages);
    } catch (err) {
      console.warn("loadConversation error:", err);
      return null;
    }
  }, [opts.apiUrl, opts.getHeaders, opts.getCredentials]);

  const deleteConversation = useCallback(async (id: string): Promise<boolean> => {
    try {
      const res = await fetch(`${opts.apiUrl}/api/v1/conversations/${id}`, {
        method: "DELETE",
        headers: opts.getHeaders(),
        credentials: opts.getCredentials(),
      });

      if (!res.ok) {
        console.warn(`deleteConversation: HTTP ${res.status} for ${id}`);
        return false;
      }

      setConversations((prev) => prev.filter((c) => c.id !== id));
      setTotal((prev) => Math.max(0, prev - 1));

      if (selectedId === id) setSelectedId(null);

      return true;
    } catch (err) {
      console.warn("deleteConversation error:", err);
      return false;
    }
  }, [opts.apiUrl, opts.getHeaders, opts.getCredentials, selectedId]);

  const starConversation = useCallback(async (id: string, starred: boolean): Promise<boolean> => {
    // Optimistic update
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, starred } : c)),
    );
    try {
      const res = await fetch(`${opts.apiUrl}/api/v1/conversations/${id}/star`, {
        method: "PATCH",
        headers: { ...opts.getHeaders(), "Content-Type": "application/json" },
        credentials: opts.getCredentials(),
        body: JSON.stringify({ starred }),
      });

      if (!res.ok) {
        console.warn(`starConversation: HTTP ${res.status} for ${id}`);
        // Rollback
        setConversations((prev) =>
          prev.map((c) => (c.id === id ? { ...c, starred: !starred } : c)),
        );
        return false;
      }

      return true;
    } catch (err) {
      console.warn("starConversation error:", err);
      // Rollback
      setConversations((prev) =>
        prev.map((c) => (c.id === id ? { ...c, starred: !starred } : c)),
      );
      return false;
    }
  }, [opts.apiUrl, opts.getHeaders, opts.getCredentials]);

  const refresh = useCallback(async () => {
    await fetchList();
  }, [fetchList]);

  return {
    conversations,
    total,
    loading,
    available,
    selectedId,
    setSelectedId,
    fetchList,
    loadConversation,
    deleteConversation,
    starConversation,
    refresh,
  };
}
