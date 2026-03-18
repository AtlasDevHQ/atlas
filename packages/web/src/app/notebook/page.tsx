"use client";

import { Suspense, useState, useMemo, useRef, useEffect, useCallback } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useQueryStates } from "nuqs";
import { notebookSearchParams } from "./search-params";
import { useNotebook } from "@/ui/components/notebook/use-notebook";
import { NotebookShell } from "@/ui/components/notebook/notebook-shell";
import { ConversationSidebar } from "@/ui/components/conversations/conversation-sidebar";
import { useConversations } from "@/ui/hooks/use-conversations";
import { API_URL, IS_CROSS_ORIGIN } from "@/lib/api-url";
import { AUTH_MODES, type AuthMode } from "@/ui/lib/types";
import { Button } from "@/components/ui/button";

export default function NotebookPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-screen items-center justify-center">
          <p className="text-sm text-zinc-500">Loading notebook...</p>
        </div>
      }
    >
      <NotebookContent />
    </Suspense>
  );
}

function NotebookContent() {
  const [params, setParams] = useQueryStates(notebookSearchParams);
  const conversationId = params.id || undefined;
  const focusCellId = params.cell || undefined;

  // Auth bootstrap
  const [authMode, setAuthMode] = useState<AuthMode | null>(null);
  const [apiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const tempIdRef = useRef(`temp:${Date.now()}`);

  useEffect(() => {
    let cancelled = false;

    async function fetchHealth(attempt: number): Promise<void> {
      try {
        const res = await fetch(`${API_URL}/api/health`, {
          credentials: IS_CROSS_ORIGIN ? "include" : "same-origin",
        });
        if (!res.ok) {
          console.warn(`Health check returned ${res.status}`);
          if (attempt < 2) {
            await new Promise((r) => setTimeout(r, 2000));
            return fetchHealth(attempt + 1);
          }
          if (!cancelled) {
            setError("Health check failed — check server logs. Try refreshing the page.");
            setAuthMode("none");
          }
          return;
        }
        const data = await res.json();
        const mode = data?.checks?.auth?.mode;
        if (!cancelled) {
          if (typeof mode === "string" && AUTH_MODES.includes(mode as AuthMode)) {
            setAuthMode(mode as AuthMode);
          } else {
            console.warn("Health check succeeded but returned no valid auth mode:", data);
            setError("Server returned an unexpected authentication configuration.");
            setAuthMode("none");
          }
        }
      } catch (err: unknown) {
        console.warn("Health endpoint unavailable:", err);
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 2000));
          return fetchHealth(attempt + 1);
        }
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Unable to reach the API server.",
          );
          setAuthMode("none");
        }
      }
    }

    fetchHealth(1);
    return () => {
      cancelled = true;
    };
  }, []);

  // Conversation ID management
  const conversationIdRef = useRef(conversationId ?? null);
  useEffect(() => {
    conversationIdRef.current = conversationId ?? null;
  }, [conversationId]);

  const setConversationId = useCallback(
    (id: string) => {
      conversationIdRef.current = id;
      setParams({ id });
    },
    [setParams],
  );

  // Auth helpers
  const getHeaders = useCallback(() => {
    const headers: Record<string, string> = {};
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    return headers;
  }, [apiKey]);

  const getCredentials = useCallback(
    (): RequestCredentials => (IS_CROSS_ORIGIN ? "include" : "same-origin"),
    [],
  );

  // Conversations hook
  const convos = useConversations({
    apiUrl: API_URL,
    enabled: true,
    getHeaders,
    getCredentials,
  });

  const refreshConvosRef = useRef(convos.refresh);
  refreshConvosRef.current = convos.refresh;

  // Fetch conversation list after auth is resolved
  useEffect(() => {
    convos.fetchList();
  }, [authMode, convos.fetchList]);

  // Transport — mirrors atlas-chat.tsx pattern
  const transport = useMemo(() => {
    const headers: Record<string, string> = {};
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    return new DefaultChatTransport({
      api: `${API_URL}/api/v1/chat`,
      headers,
      credentials: IS_CROSS_ORIGIN ? "include" : undefined,
      body: () =>
        conversationIdRef.current
          ? { conversationId: conversationIdRef.current }
          : {},
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await globalThis.fetch(input, init);
        const convId = response.headers.get("x-conversation-id");
        if (convId && convId !== conversationIdRef.current) {
          setConversationId(convId);
          setTimeout(() => {
            refreshConvosRef.current().catch((err: unknown) => {
              console.warn(
                "Sidebar refresh failed:",
                err instanceof Error ? err.message : String(err),
              );
            });
          }, 500);
        }
        return response;
      }) as typeof fetch,
    });
  }, [apiKey, authMode, setConversationId]);

  // useChat
  const { messages, setMessages, sendMessage, status, error: chatError } = useChat({ transport });

  // Load conversation when ID changes
  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    async function load() {
      try {
        const uiMessages = await convos.loadConversation(conversationId!);
        if (cancelled) return;
        if (uiMessages) {
          setMessages(uiMessages);
        } else {
          setError("Could not load conversation. It may have been deleted.");
        }
      } catch (err: unknown) {
        if (!cancelled) {
          console.warn(
            "Failed to load conversation:",
            err instanceof Error ? err.message : String(err),
          );
          setError("Failed to load conversation. Please try again.");
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [conversationId]); // Only re-run when conversationId changes

  // useNotebook
  const notebook = useNotebook({
    chat: {
      messages,
      setMessages,
      sendMessage,
      status,
      error: chatError ?? null,
    },
    conversationId: conversationId ?? tempIdRef.current,
  });

  // New chat handler
  function handleNewChat() {
    setMessages([]);
    setParams({ id: "", cell: "" });
    convos.setSelectedId(null);
  }

  // Select conversation handler
  async function handleSelectConversation(id: string) {
    if (loadingConversation) return;
    setLoadingConversation(true);
    try {
      const uiMessages = await convos.loadConversation(id);
      if (uiMessages) {
        setMessages(uiMessages);
        setParams({ id, cell: "" });
        convos.setSelectedId(id);
        setMobileMenuOpen(false);
      } else {
        setError("Could not load conversation. It may have been deleted.");
      }
    } catch (err: unknown) {
      console.warn(
        "Failed to load conversation:",
        err instanceof Error ? err.message : String(err),
      );
      setError("Failed to load conversation. Please try again.");
    } finally {
      setLoadingConversation(false);
    }
  }

  // Error state
  if (error) {
    return (
      <div className="flex h-screen items-center justify-center p-8">
        <div className="text-center">
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          <Button className="mt-4" onClick={() => window.location.reload()}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  // Loading auth
  if (authMode === null) {
    return (
      <div className="flex h-screen items-center justify-center">
        <p className="text-sm text-zinc-500">Connecting...</p>
      </div>
    );
  }

  return (
    <div className="flex h-screen">
      {convos.available && (
        <ConversationSidebar
          conversations={convos.conversations}
          selectedId={conversationId ?? null}
          loading={convos.loading}
          onSelect={handleSelectConversation}
          onDelete={(id) => convos.deleteConversation(id)}
          onStar={(id, starred) => convos.starConversation(id, starred)}
          onNewChat={handleNewChat}
          mobileOpen={mobileMenuOpen}
          onMobileClose={() => setMobileMenuOpen(false)}
        />
      )}
      <main id="main" className="flex-1">
        <NotebookShell notebook={notebook} focusCellId={focusCellId} />
      </main>
    </div>
  );
}
