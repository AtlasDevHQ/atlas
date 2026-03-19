"use client";

import { Suspense, useState, useRef, useEffect } from "react";
import { useChat } from "@ai-sdk/react";
import { useQueryStates } from "nuqs";
import { notebookSearchParams } from "./search-params";
import { useNotebook } from "@/ui/components/notebook/use-notebook";
import { NotebookShell } from "@/ui/components/notebook/notebook-shell";
import { ConversationSidebar } from "@/ui/components/conversations/conversation-sidebar";
import { useConversations } from "@/ui/hooks/use-conversations";
import { API_URL, IS_CROSS_ORIGIN } from "@/lib/api-url";
import { useAtlasTransport } from "@/ui/hooks/use-atlas-transport";
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

  const [error, setError] = useState<string | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const tempIdRef = useRef(`temp:${Date.now()}`);

  const {
    transport,
    authMode,
    getHeaders,
    getCredentials,
    healthWarning,
    authResolved,
  } = useAtlasTransport({
    apiUrl: API_URL,
    isCrossOrigin: IS_CROSS_ORIGIN,
    getConversationId: () => conversationId ?? null,
    onNewConversationId: (id) => {
      setParams({ id });
      setTimeout(() => {
        refreshConvosRef.current().catch((err: unknown) => {
          console.warn(
            "Sidebar refresh failed:",
            err instanceof Error ? err.message : String(err),
          );
        });
      }, 500);
    },
  });

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
          setError("Could not load conversation. The server may be unavailable, or the conversation may no longer exist.");
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
    setError(null);
    setMessages([]);
    setParams({ id: "", cell: "" });
    convos.setSelectedId(null);
  }

  // Select conversation handler
  async function handleSelectConversation(id: string) {
    if (loadingConversation) return;
    setError(null);
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

  // Health warning — blocks the entire page until resolved (requires reload)
  if (healthWarning) {
    return (
      <div className="flex h-screen items-center justify-center p-8">
        <div className="text-center">
          <p className="text-sm text-red-600 dark:text-red-400">{healthWarning}</p>
          <Button className="mt-4" onClick={() => window.location.reload()}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  // Loading auth
  if (!authResolved) {
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
      <main id="main" className="flex-1 flex flex-col">
        {error && (
          <div className="mx-4 mt-4 flex items-center justify-between rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
            <p>{error}</p>
            <Button variant="ghost" size="sm" onClick={() => setError(null)} className="shrink-0 text-red-600 dark:text-red-400">
              Dismiss
            </Button>
          </div>
        )}
        <NotebookShell notebook={notebook} focusCellId={focusCellId} />
      </main>
    </div>
  );
}
