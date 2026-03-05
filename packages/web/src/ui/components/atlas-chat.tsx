"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, isToolUIPart } from "ai";
import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { AUTH_MODES, type AuthMode } from "../lib/types";
import { useAtlasConfig, ActionAuthProvider } from "../context";
import { DarkModeContext } from "../hooks/use-dark-mode";
import { useDarkMode } from "../hooks/use-dark-mode";
import { useConversations } from "../hooks/use-conversations";
import { ErrorBanner } from "./chat/error-banner";
import { ApiKeyBar } from "./chat/api-key-bar";
import { ManagedAuthCard } from "./chat/managed-auth-card";
import { TypingIndicator } from "./chat/typing-indicator";
import { ToolPart } from "./chat/tool-part";
import { Markdown } from "./chat/markdown";
import { STARTER_PROMPTS } from "./chat/starter-prompts";
import { ConversationSidebar } from "./conversations/conversation-sidebar";
import { ChangePasswordDialog } from "./admin/change-password-dialog";

const API_KEY_STORAGE_KEY = "atlas-api-key";

/* Static SVG icons — hoisted to avoid recreation on every render */
const MenuIcon = (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
    <path fillRule="evenodd" d="M2 4.75A.75.75 0 0 1 2.75 4h14.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 4.75ZM2 10a.75.75 0 0 1 .75-.75h14.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 10Zm0 5.25a.75.75 0 0 1 .75-.75h14.5a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1-.75-.75Z" clipRule="evenodd" />
  </svg>
);

const AtlasLogo = (
  <svg viewBox="0 0 256 256" fill="none" className="h-7 w-7 shrink-0" aria-hidden="true">
    <path d="M128 24 L232 208 L24 208 Z" stroke="#23CE9E" strokeWidth="14" fill="none" strokeLinejoin="round"/>
    <circle cx="128" cy="28" r="16" fill="#23CE9E"/>
  </svg>
);

export function AtlasChat() {
  const { apiUrl, isCrossOrigin, authClient } = useAtlasConfig();
  const dark = useDarkMode();
  const [input, setInput] = useState("");
  const [authMode, setAuthMode] = useState<AuthMode | null>(null);
  const [healthWarning, setHealthWarning] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [passwordChangeRequired, setPasswordChangeRequired] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const managedSession = authClient.useSession();
  const authResolved = authMode !== null;
  const isManaged = authMode === "managed";
  const isSignedIn = isManaged && !!managedSession.data?.user;

  const getHeaders = useCallback(() => {
    const headers: Record<string, string> = {};
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    return headers;
  }, [apiKey]);

  const getCredentials = useCallback((): RequestCredentials => {
    return isCrossOrigin ? "include" : "same-origin";
  }, [isCrossOrigin]);

  const convos = useConversations({
    apiUrl,
    enabled: true,
    getHeaders,
    getCredentials,
  });

  const refreshConvosRef = useRef(convos.refresh);
  refreshConvosRef.current = convos.refresh;

  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;

  // Load API key from sessionStorage on mount + fetch auth mode + conversations
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(API_KEY_STORAGE_KEY);
      if (stored) setApiKey(stored);
    } catch (err) {
      console.warn("Cannot read API key from sessionStorage:", err);
    }

    async function fetchHealth(attempt: number): Promise<void> {
      try {
        const res = await fetch(`${apiUrl}/api/health`, {
          credentials: isCrossOrigin ? "include" : "same-origin",
        });
        if (!res.ok) {
          console.warn(`Health check returned ${res.status}`);
          if (attempt < 2) {
            await new Promise((r) => setTimeout(r, 2000));
            return fetchHealth(attempt + 1);
          }
          setHealthWarning("Health check failed — check server logs. Try refreshing the page.");
          setAuthMode("none");
          return;
        }
        const data = await res.json();
        const mode = data?.checks?.auth?.mode;
        if (typeof mode === "string" && AUTH_MODES.includes(mode as AuthMode)) {
          setAuthMode(mode as AuthMode);
        }
      } catch (err) {
        console.warn("Health endpoint unavailable:", err);
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 2000));
          return fetchHealth(attempt + 1);
        }
        setHealthWarning("Unable to reach the API server. Try refreshing the page.");
        setAuthMode("none");
      }
    }
    fetchHealth(1);
  }, [apiUrl]);

  // Fetch conversation list after auth is resolved
  useEffect(() => {
    convos.fetchList();
  }, [authMode, convos.fetchList]);

  // Check if managed auth user needs to change their default password
  useEffect(() => {
    if (!isManaged || !managedSession.data?.user) return;

    async function checkPasswordStatus() {
      try {
        const res = await fetch(`${apiUrl}/api/v1/admin/me/password-status`, {
          credentials: isCrossOrigin ? "include" : "same-origin",
        });
        if (!res.ok) return;
        const data = await res.json();
        if (data.passwordChangeRequired) setPasswordChangeRequired(true);
      } catch {
        // Non-critical — skip silently
      }
    }
    checkPasswordStatus();
  }, [isManaged, managedSession.data?.user, apiUrl, isCrossOrigin]);

  const handleSaveApiKey = useCallback((key: string) => {
    setApiKey(key);
    try {
      sessionStorage.setItem(API_KEY_STORAGE_KEY, key);
    } catch (err) {
      console.warn("Could not persist API key to sessionStorage:", err);
    }
  }, []);

  // Dynamic transport — captures x-conversation-id from response.
  // conversationId is accessed via ref to avoid recreating the transport mid-stream
  // (which causes an infinite re-render loop in useChat).
  const transport = useMemo(() => {
    const headers: Record<string, string> = {};
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
    return new DefaultChatTransport({
      api: `${apiUrl}/api/chat`,
      headers,
      credentials: isCrossOrigin ? "include" : undefined,
      body: () => (conversationIdRef.current ? { conversationId: conversationIdRef.current } : {}),
      fetch: (async (input, init) => {
        const response = await globalThis.fetch(input, init);
        const convId = response.headers.get("x-conversation-id");
        if (convId && convId !== conversationIdRef.current) {
          setConversationId(convId);
          setTimeout(() => {
            refreshConvosRef.current().catch((err) => {
              console.warn("Sidebar refresh failed:", err);
            });
          }, 500);
        }
        return response;
      }) as typeof fetch,
    });
  }, [apiKey, authMode, apiUrl, isCrossOrigin]);

  const { messages, setMessages, sendMessage, status, error } = useChat({ transport });

  const isLoading = status === "streaming" || status === "submitted";

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    if (isNearBottom) el.scrollTop = el.scrollHeight;
  }, [messages, status]);

  function handleSend(text: string) {
    if (!text.trim()) return;
    const saved = text;
    setInput("");
    sendMessage({ text: saved }).catch((err) => {
      console.error("Failed to send message:", err);
      setInput(saved);
      setHealthWarning("Failed to send message. Please try again.");
      setTimeout(() => setHealthWarning(""), 5000);
    });
  }

  async function handleSelectConversation(id: string) {
    if (loadingConversation) return;
    setLoadingConversation(true);
    try {
      const uiMessages = await convos.loadConversation(id);
      if (uiMessages) {
        setMessages(uiMessages);
        setConversationId(id);
        convos.setSelectedId(id);
        setMobileMenuOpen(false);
      } else {
        setHealthWarning("Could not load conversation. It may have been deleted.");
        setTimeout(() => setHealthWarning(""), 5000);
      }
    } finally {
      setLoadingConversation(false);
    }
  }

  function handleNewChat() {
    setMessages([]);
    setConversationId(null);
    convos.setSelectedId(null);
    setInput("");
    setMobileMenuOpen(false);
  }

  // Wait for auth mode detection before rendering — prevents flash of chat UI
  // when managed auth is active but session hasn't been checked yet.
  if (!authResolved || (isManaged && managedSession.isPending)) {
    return (
      <DarkModeContext.Provider value={dark}>
        <div className="flex h-dvh items-center justify-center bg-white dark:bg-zinc-950" />
      </DarkModeContext.Provider>
    );
  }

  return (
    <DarkModeContext.Provider value={dark}>
      <div className="flex h-dvh">
        {convos.available && (
          <ConversationSidebar
            conversations={convos.conversations}
            selectedId={convos.selectedId}
            loading={convos.loading}
            onSelect={handleSelectConversation}
            onDelete={(id) => convos.deleteConversation(id)}
            onStar={(id, starred) => convos.starConversation(id, starred)}
            onNewChat={handleNewChat}
            mobileOpen={mobileMenuOpen}
            onMobileClose={() => setMobileMenuOpen(false)}
          />
        )}

        <main className="flex flex-1 flex-col overflow-hidden">
          <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col p-4">
            <header className="mb-4 flex-none border-b border-zinc-100 pb-3 dark:border-zinc-800">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {convos.available && (
                    <button
                      onClick={() => setMobileMenuOpen(true)}
                      className="rounded p-1 text-zinc-400 hover:text-zinc-700 md:hidden dark:hover:text-zinc-200"
                      aria-label="Open conversation history"
                    >
                      {MenuIcon}
                    </button>
                  )}
                  <div className="flex items-center gap-2.5">
                    {AtlasLogo}
                    <div>
                      <h1 className="text-xl font-semibold tracking-tight">Atlas</h1>
                      <p className="text-sm text-zinc-500">Ask your data anything</p>
                    </div>
                  </div>
                </div>
                {isSignedIn && (
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">
                      {managedSession.data?.user?.email}
                    </span>
                    <button
                      onClick={() => {
                        authClient.signOut().catch((err: unknown) => {
                          console.error("Sign out failed:", err);
                          setHealthWarning("Sign out failed. Please try again.");
                          setTimeout(() => setHealthWarning(""), 5000);
                        });
                      }}
                      className="rounded border border-zinc-200 px-2 py-1 text-xs text-zinc-500 transition-colors hover:border-zinc-400 hover:text-zinc-800 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-zinc-500 dark:hover:text-zinc-200"
                    >
                      Sign out
                    </button>
                  </div>
                )}
              </div>
            </header>

            {healthWarning && (
              <p className="mb-2 text-xs text-zinc-400 dark:text-zinc-500">{healthWarning}</p>
            )}

            {isManaged && !isSignedIn ? (
              <ManagedAuthCard />
            ) : (
              <ActionAuthProvider getHeaders={getHeaders} getCredentials={getCredentials}>
                {authMode === "simple-key" && (
                  <div className="mb-3 flex-none">
                    <ApiKeyBar apiKey={apiKey} onSave={handleSaveApiKey} />
                  </div>
                )}

                <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto pb-4">
                  {messages.length === 0 && !error && (
                    <div className="flex h-full flex-col items-center justify-center gap-6">
                      <div className="text-center">
                        <p className="text-lg font-medium text-zinc-500 dark:text-zinc-400">
                          What would you like to know?
                        </p>
                        <p className="mt-1 text-sm text-zinc-400 dark:text-zinc-600">
                          Ask a question about your data to get started
                        </p>
                      </div>
                      <div className="grid w-full max-w-lg grid-cols-2 gap-2">
                        {STARTER_PROMPTS.map((prompt) => (
                          <button
                            key={prompt}
                            onClick={() => handleSend(prompt)}
                            className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-left text-sm text-zinc-500 transition-colors hover:border-zinc-400 hover:bg-zinc-100 hover:text-zinc-800 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:border-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                          >
                            {prompt}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {messages.map((m) => {
                    if (m.role === "user") {
                      return (
                        <div key={m.id} className="flex justify-end">
                          <div className="max-w-[85%] rounded-xl bg-blue-600 px-4 py-3 text-sm text-white">
                            {m.parts?.map((part, i) =>
                              part.type === "text" ? (
                                <p key={i} className="whitespace-pre-wrap">
                                  {part.text}
                                </p>
                              ) : null,
                            )}
                          </div>
                        </div>
                      );
                    }

                    return (
                      <div key={m.id} className="space-y-2">
                        {m.parts?.map((part, i) => {
                          if (part.type === "text" && part.text.trim()) {
                            return (
                              <div key={i} className="max-w-[90%]">
                                <div className="rounded-xl bg-zinc-100 px-4 py-3 text-sm text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200">
                                  <Markdown content={part.text} />
                                </div>
                              </div>
                            );
                          }
                          if (isToolUIPart(part)) {
                            return (
                              <div key={i} className="max-w-[95%]">
                                <ToolPart part={part} />
                              </div>
                            );
                          }
                          return null;
                        })}
                      </div>
                    );
                  })}

                  {isLoading && messages.length > 0 && <TypingIndicator />}
                </div>

                {error && <ErrorBanner error={error} authMode={authMode} />}

                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleSend(input);
                  }}
                  className="flex flex-none gap-2 border-t border-zinc-100 pt-4 dark:border-zinc-800"
                >
                  <input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="Ask a question about your data..."
                    className="flex-1 rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-900 placeholder-zinc-400 outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder-zinc-600"
                    disabled={isLoading}
                  />
                  <button
                    type="submit"
                    disabled={isLoading || !input.trim()}
                    className="rounded-lg bg-blue-600 px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-40"
                  >
                    Ask
                  </button>
                </form>
              </ActionAuthProvider>
            )}
          </div>
        </main>
      </div>
      <ChangePasswordDialog
        open={passwordChangeRequired}
        onComplete={() => setPasswordChangeRequired(false)}
      />
    </DarkModeContext.Provider>
  );
}
