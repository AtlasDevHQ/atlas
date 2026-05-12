"use client";

import { Suspense, useState, useRef, useEffect, useCallback } from "react";
import dynamic from "next/dynamic";
import { useChat } from "@ai-sdk/react";
import { useQueryStates } from "nuqs";
import { notebookSearchParams } from "./search-params";
import { useNotebook } from "@/ui/components/notebook/use-notebook";
import { NotebookShell } from "@/ui/components/notebook/notebook-shell";
import { useConversations, transformMessages } from "@/ui/hooks/use-conversations";
import { getApiUrl, isCrossOrigin } from "@/lib/api-url";
import { useAtlasTransport } from "@/ui/hooks/use-atlas-transport";
import { authClient } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import type { NotebookStateWire, ForkBranchWire } from "@/ui/lib/types";
import type { ForkInfo } from "@/ui/components/notebook/types";

const GuidedTour = dynamic(
  () => import("@/ui/components/tour/guided-tour").then((m) => m.GuidedTour),
  { ssr: false },
);

export default function NotebookPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center">
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
  const tempIdRef = useRef(`temp:${Date.now()}`);

  // Auth for tour
  const session = authClient.useSession();
  const user = session.data?.user as
    | { email?: string; role?: string }
    | undefined;
  const isAdmin = user?.role === "admin" || user?.role === "owner" || user?.role === "platform_admin";
  const isSignedIn = !!user;

  // Server-side notebook state
  const [serverNotebookState, setServerNotebookState] = useState<NotebookStateWire | null>(null);
  const [forkInfo, setForkInfo] = useState<ForkInfo | null>(null);

  const {
    transport,
    authMode,
    getHeaders,
    getCredentials,
    healthWarning,
    authResolved,
  } = useAtlasTransport({
    apiUrl: getApiUrl(),
    isCrossOrigin: isCrossOrigin(),
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
    apiUrl: getApiUrl(),
    enabled: true,
    getHeaders,
    getCredentials,
  });

  const refreshConvosRef = useRef(convos.refresh);
  refreshConvosRef.current = convos.refresh;

  // Fetch conversation list after auth is resolved
  useEffect(() => {
    convos.fetchList().catch((err: unknown) => {
      console.debug(
        "[notebook] convos.fetchList rejected:",
        err instanceof Error ? err.message : String(err),
      );
    });
  }, [authMode, convos.fetchList]);

  // useChat
  const { messages, setMessages, sendMessage, status, error: chatError } = useChat({ transport });

  // Build fork info from notebook state
  const buildForkInfo = useCallback((
    convId: string,
    state: NotebookStateWire | null | undefined,
  ): ForkInfo | null => {
    if (!state) return null;

    // If this conversation IS the root and has branches
    if (state.branches && state.branches.length > 0) {
      return {
        rootId: convId,
        currentId: convId,
        branches: state.branches,
      };
    }

    // If this conversation is a fork (has forkRootId), we need to load the root's branches
    // For now, show minimal info — the root's branches are loaded asynchronously
    if (state.forkRootId) {
      return {
        rootId: state.forkRootId,
        currentId: convId,
        branches: [],
      };
    }

    return null;
  }, []);

  // Load fork info from root conversation when viewing a branch
  useEffect(() => {
    if (!serverNotebookState?.forkRootId || !conversationId) return;
    const rootId = serverNotebookState.forkRootId;
    if (rootId === conversationId) return;

    let cancelled = false;
    async function loadRootBranches() {
      try {
        const rootConv = await convos.getConversationData(rootId);
        if (cancelled) return;
        const rootState = rootConv.notebookState;
        if (rootState?.branches) {
          setForkInfo({
            rootId,
            currentId: conversationId!,
            branches: rootState.branches as ForkBranchWire[],
          });
        }
      } catch (err: unknown) {
        console.warn(
          "Failed to load root conversation for fork info:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    loadRootBranches();
    return () => { cancelled = true; };
  }, [serverNotebookState?.forkRootId, conversationId, convos.getConversationData]);

  // The workspace shell drives selection via `?id=...`. Load on a new id, or
  // clear notebook state when the param goes empty (shell's "New chat").
  const lastLoadedIdRef = useRef<string | null>(null);
  useEffect(() => {
    // Clear first — the page now stays mounted across sibling navigations, so
    // a stale failure on B would otherwise persist when the user returns to A.
    setError(null);
    if (!conversationId) {
      if (lastLoadedIdRef.current !== null) {
        setMessages([]);
        setServerNotebookState(null);
        setForkInfo(null);
        lastLoadedIdRef.current = null;
      }
      return;
    }
    if (conversationId === lastLoadedIdRef.current) return;
    let cancelled = false;
    async function load() {
      try {
        const convData = await convos.getConversationData(conversationId!);
        if (cancelled) return;

        // Extract notebook state and messages from a single fetch
        const state = convData.notebookState as NotebookStateWire | null ?? null;
        setServerNotebookState(state);
        setForkInfo(buildForkInfo(conversationId!, state));
        setMessages(transformMessages(convData.messages));
        lastLoadedIdRef.current = conversationId!;
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

  // Server save callback (passed to useNotebook for debounced persistence)
  const saveToServer = useCallback((state: NotebookStateWire) => {
    if (!conversationId || conversationId.startsWith("temp:")) return;
    convos.saveNotebookState(conversationId, state);
  }, [conversationId, convos.saveNotebookState]);

  // Fork navigation callback
  const handleNavigateToBranch = useCallback((branchId: string) => {
    setParams({ id: branchId, cell: "" }).catch((err: unknown) => {
      console.warn(
        "[notebook] failed to set branch id param:",
        err instanceof Error ? err.message : String(err),
      );
    });
    // Refresh sidebar to show new conversation
    setTimeout(() => {
      refreshConvosRef.current().catch((err: unknown) => {
        console.warn(
          "Sidebar refresh after fork failed:",
          err instanceof Error ? err.message : String(err),
        );
      });
    }, 500);
  }, [setParams]);

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
    initialServerState: serverNotebookState,
    saveToServer,
    forkConversation: convos.forkConversation,
    onNavigateToBranch: handleNavigateToBranch,
    forkInfo,
    deleteBranch: convos.deleteBranch,
    renameBranch: convos.renameBranch,
    onForkInfoChanged: setForkInfo,
  });

  // Share as Report — creates a share link and returns the token
  const handleShareAsReport =
    !conversationId || conversationId.startsWith("temp:")
      ? undefined
      : async (): Promise<string> => {
          const result = await convos.shareConversation(conversationId);
          return result.token;
        };

  // Workspace shell delivers schema-explorer / prompt-library picks via the
  // `prompt` URL param. Send the message, then clear the param so a refresh
  // doesn't replay it. Key on the dispatched value (not a once-per-mount
  // flag) — the page stays mounted across sibling navigations, and a second
  // pick on the same surface must re-fire.
  const lastDispatchedPromptRef = useRef<string | null>(null);
  useEffect(() => {
    if (!params.prompt) return;
    if (params.prompt === lastDispatchedPromptRef.current) return;
    const text = params.prompt;
    lastDispatchedPromptRef.current = text;
    setParams({ prompt: "" }).catch((err: unknown) => {
      console.warn(
        "[notebook] failed to clear prompt param:",
        err instanceof Error ? err.message : String(err),
      );
    });
    sendMessage({ text }).catch((err: unknown) => {
      console.warn(
        "[notebook] sendMessage from workspace prompt failed:",
        err instanceof Error ? err.message : String(err),
      );
      setError("Failed to send prompt. Please try again.");
    });
  }, [params.prompt, sendMessage, setParams]);

  // Health warning — blocks the entire page until resolved (requires reload)
  if (healthWarning) {
    return (
      <div className="flex h-full items-center justify-center p-8">
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
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-zinc-500">Connecting...</p>
      </div>
    );
  }

  return (
    <GuidedTour
      apiUrl={getApiUrl()}
      isCrossOrigin={isCrossOrigin()}
      isAdmin={isAdmin}
      serverTrackingEnabled={isSignedIn}
    >
      <div className="flex h-full flex-1 flex-col overflow-hidden">
        {(error || convos.fetchError) && (
          <div className="mx-4 mt-4 flex items-center justify-between rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
            <p>{error || convos.fetchError}</p>
            <Button variant="ghost" size="sm" onClick={() => setError(null)} className="shrink-0 text-red-600 dark:text-red-400">
              Dismiss
            </Button>
          </div>
        )}
        <NotebookShell
          notebook={notebook}
          focusCellId={focusCellId}
          onShareAsReport={handleShareAsReport}
          starterPrompts={{
            apiUrl: getApiUrl(),
            isCrossOrigin: isCrossOrigin(),
            getHeaders,
            enabled: authResolved,
          }}
        />
      </div>
    </GuidedTour>
  );
}
