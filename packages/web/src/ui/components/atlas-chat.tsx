"use client";

import { useChat } from "@ai-sdk/react";
import { isToolUIPart, getToolName } from "ai";
import { useState, useRef, useEffect, useCallback } from "react";
import type { PythonProgressData } from "./chat/python-result-card";
import { useAtlasConfig, ActionAuthProvider } from "../context";
import { DarkModeContext, useDarkMode, useThemeMode, setTheme, type ThemeMode } from "../hooks/use-dark-mode";
import { useAtlasTransport } from "../hooks/use-atlas-transport";
import { useConversations } from "../hooks/use-conversations";
import { ErrorBanner } from "./chat/error-banner";
import { ApiKeyBar } from "./chat/api-key-bar";
import { ManagedAuthCard } from "./chat/managed-auth-card";
import { TypingIndicator } from "./chat/typing-indicator";
import { ToolPart } from "./chat/tool-part";
import { Markdown } from "./chat/markdown";
import { STARTER_PROMPTS } from "./chat/starter-prompts";
import { FollowUpChips } from "./chat/follow-up-chips";
import { SuggestionChips } from "./chat/suggestion-chips";
import type { QuerySuggestion } from "@/ui/lib/types";
import { ShareDialog } from "./chat/share-dialog";
import { ConversationSidebar } from "./conversations/conversation-sidebar";
import { ChangePasswordDialog } from "./admin/change-password-dialog";
import { Sun, Moon, Monitor, Star, TableProperties, BookOpen } from "lucide-react";
import { SchemaExplorer } from "./schema-explorer/schema-explorer";
import { PromptLibrary } from "./chat/prompt-library";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { parseSuggestions } from "../lib/helpers";
import { ErrorBoundary } from "./error-boundary";

/* Static SVG icons — hoisted to avoid recreation on every render */
const MenuIcon = (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
    <path fillRule="evenodd" d="M2 4.75A.75.75 0 0 1 2.75 4h14.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 4.75ZM2 10a.75.75 0 0 1 .75-.75h14.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 10Zm0 5.25a.75.75 0 0 1 .75-.75h14.5a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1-.75-.75Z" clipRule="evenodd" />
  </svg>
);

const AtlasLogo = (
  <svg viewBox="0 0 256 256" fill="none" className="h-7 w-7 shrink-0 text-primary" aria-hidden="true">
    <path d="M128 24 L232 208 L24 208 Z" stroke="currentColor" strokeWidth="14" fill="none" strokeLinejoin="round"/>
    <circle cx="128" cy="28" r="16" fill="currentColor"/>
  </svg>
);

const THEME_OPTIONS = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const satisfies readonly { value: ThemeMode; label: string; icon: typeof Sun }[];

function ThemeToggle() {
  const mode = useThemeMode();
  const CurrentIcon = mode === "dark" ? Moon : mode === "light" ? Sun : Monitor;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-11 sm:size-8 text-zinc-500 dark:text-zinc-400">
          <CurrentIcon className="size-4" />
          <span className="sr-only">Toggle theme</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
          <DropdownMenuItem
            key={value}
            onClick={() => setTheme(value)}
            className={mode === value ? "bg-accent" : ""}
          >
            <Icon className="mr-2 size-4" />
            {label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SaveButton({
  conversationId,
  conversations,
  onStar,
}: {
  conversationId: string;
  conversations: { id: string; starred: boolean }[];
  onStar: (id: string, starred: boolean) => Promise<void>;
}) {
  const isStarred = conversations.find((c) => c.id === conversationId)?.starred ?? false;
  const [pending, setPending] = useState(false);

  async function handleToggle() {
    setPending(true);
    try {
      await onStar(conversationId, !isStarred);
    } catch (err: unknown) {
      console.warn("Failed to update star:", err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Button
      variant="ghost"
      size="xs"
      onClick={handleToggle}
      disabled={pending}
      className={
        isStarred
          ? "text-amber-500 hover:text-amber-600 dark:text-amber-400 dark:hover:text-amber-300"
          : "text-zinc-400 hover:text-amber-500 dark:text-zinc-500 dark:hover:text-amber-400"
      }
      aria-label={isStarred ? "Unsave conversation" : "Save conversation"}
    >
      <Star className="h-3.5 w-3.5" fill={isStarred ? "currentColor" : "none"} />
      <span>{isStarred ? "Saved" : "Save"}</span>
    </Button>
  );
}

export function AtlasChat() {
  const { apiUrl, isCrossOrigin, authClient } = useAtlasConfig();
  const dark = useDarkMode();
  const [input, setInput] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [transientWarning, setTransientWarning] = useState("");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [passwordChangeRequired, setPasswordChangeRequired] = useState(false);
  const [schemaExplorerOpen, setSchemaExplorerOpen] = useState(false);
  const [promptLibraryOpen, setPromptLibraryOpen] = useState(false);
  const [popularSuggestions, setPopularSuggestions] = useState<QuerySuggestion[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [relatedSuggestions, setRelatedSuggestions] = useState<QuerySuggestion[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  const {
    transport,
    authMode,
    apiKey,
    setApiKey,
    getHeaders,
    getCredentials,
    healthWarning,
    authResolved,
  } = useAtlasTransport({
    apiUrl,
    isCrossOrigin,
    getConversationId: () => conversationId,
    onNewConversationId: (id) => {
      setConversationId(id);
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

  const managedSession = authClient.useSession();
  const isManaged = authMode === "managed";
  const isSignedIn = isManaged && !!managedSession.data?.user;

  const convos = useConversations({
    apiUrl,
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

  // Check if managed auth user needs to change their default password
  useEffect(() => {
    if (!isManaged || !managedSession.data?.user) return;

    async function checkPasswordStatus() {
      try {
        const res = await fetch(`${apiUrl}/api/v1/admin/me/password-status`, {
          credentials: isCrossOrigin ? "include" : "same-origin",
        });
        if (!res.ok) {
          console.warn("Password status check failed:", res.status, res.statusText);
          return;
        }
        const data = await res.json();
        if (data.passwordChangeRequired) setPasswordChangeRequired(true);
      } catch (err: unknown) {
        console.warn("Failed to check password status:", err instanceof Error ? err.message : String(err));
      }
    }
    checkPasswordStatus();
  }, [isManaged, managedSession.data?.user, apiUrl, isCrossOrigin]);

  // Python streaming progress — keyed by tool invocation ID
  const [pythonProgress, setPythonProgress] = useState<Map<string, PythonProgressData[]>>(new Map());

  const onData = useCallback((dataPart: { type: string; id?: string; data: unknown }) => {
    if (dataPart.type === "data-python-progress" && dataPart.id && dataPart.data) {
      const d = dataPart.data as Record<string, unknown>;
      // Minimal runtime validation — ensure the event has a known type
      if (typeof d.type !== "string" || !["stdout", "chart", "recharts"].includes(d.type)) return;
      const event = d as unknown as PythonProgressData;
      setPythonProgress((prev) => {
        const next = new Map(prev);
        const events = next.get(dataPart.id!) ?? [];
        next.set(dataPart.id!, [...events, event]);
        return next;
      });
    }
  }, []);

  // The AI SDK's onData expects DataUIPart<UIDataTypes> which structurally accepts
  // { type: `data-${string}`; id?: string; data: unknown } — our callback matches.
  // The cast is needed because the default UIMessage generic doesn't declare our custom
  // data part type at compile time.
  const { messages, setMessages, sendMessage, status, error } = useChat({
    transport,
    onData: onData as never,
  });

  const isLoading = status === "streaming" || status === "submitted";

  // Fetch popular suggestions for the empty state
  useEffect(() => {
    if (messages.length > 0) return;
    let cancelled = false;
    setSuggestionsLoading(true);
    fetch(`${apiUrl}/api/v1/suggestions/popular?limit=6`, {
      credentials: isCrossOrigin ? "include" : "same-origin",
      headers: getHeaders(),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data?.suggestions) {
          setPopularSuggestions(data.suggestions);
        }
      })
      .catch(() => {
        // intentionally ignored: suggestions are non-critical
      })
      .finally(() => {
        if (!cancelled) setSuggestionsLoading(false);
      });
    return () => { cancelled = true; };
  }, [messages.length, apiUrl, isCrossOrigin, getHeaders]);

  // Fetch related suggestions after a completed query with SQL results
  useEffect(() => {
    if (messages.length === 0 || isLoading) return;
    const lastMsg = messages[messages.length - 1];
    if (lastMsg.role !== "assistant") return;

    // Extract tables from executeSQL tool invocations
    const tables: string[] = [];
    for (const part of lastMsg.parts ?? []) {
      if (!isToolUIPart(part)) continue;
      try {
        const name = getToolName(part as Parameters<typeof getToolName>[0]);
        if (name !== "executeSQL") continue;
      } catch {
        // intentionally ignored: getToolName throws if the part lacks a recognized toolName property
        continue;
      }
      if ("result" in part && part.result != null) {
        const result = part.result as Record<string, unknown>;
        if (Array.isArray(result.tablesAccessed)) {
          tables.push(...(result.tablesAccessed as string[]));
        }
      }
    }

    if (tables.length === 0) {
      setRelatedSuggestions([]);
      return;
    }

    const uniqueTables = [...new Set(tables)];
    const params = uniqueTables.map((t) => `table=${encodeURIComponent(t)}`).join("&");

    let cancelled = false;
    fetch(`${apiUrl}/api/v1/suggestions?${params}&limit=3`, {
      credentials: isCrossOrigin ? "include" : "same-origin",
      headers: getHeaders(),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data?.suggestions) {
          setRelatedSuggestions(data.suggestions);
        }
      })
      .catch(() => {
        // intentionally ignored: suggestions are non-critical
      });
    return () => { cancelled = true; };
  }, [messages.length, isLoading, apiUrl, isCrossOrigin, getHeaders]);

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
    sendMessage({ text: saved }).catch((err: unknown) => {
      console.error("Failed to send message:", err instanceof Error ? err.message : String(err));
      setInput(saved);
      setTransientWarning("Failed to send message. Please try again.");
      setTimeout(() => setTransientWarning(""), 5000);
    });
  }

  function handleSuggestionSelect(text: string, id: string) {
    fetch(`${apiUrl}/api/v1/suggestions/${id}/click`, {
      method: "POST",
      credentials: isCrossOrigin ? "include" : "same-origin",
      headers: getHeaders(),
    }).catch(() => {
      // intentionally ignored: click tracking is non-critical
    });
    handleSend(text);
  }

  async function handleSelectConversation(id: string) {
    if (loadingConversation) return;
    setLoadingConversation(true);
    try {
      const uiMessages = await convos.loadConversation(id);
      setMessages(uiMessages);
      setConversationId(id);
      convos.setSelectedId(id);
      setMobileMenuOpen(false);
    } catch (err: unknown) {
      console.warn("Failed to load conversation:", err instanceof Error ? err.message : String(err));
      setTransientWarning("Failed to load conversation. Please try again.");
      setTimeout(() => setTransientWarning(""), 5000);
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
    setPythonProgress(new Map());
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

        <main id="main" tabIndex={-1} className="flex flex-1 flex-col overflow-hidden">
          <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col overflow-hidden p-4">
            <header className="mb-4 flex-none border-b border-zinc-100 pb-3 dark:border-zinc-800">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {convos.available && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setMobileMenuOpen(true)}
                      className="size-11 text-zinc-400 hover:text-zinc-700 md:hidden dark:hover:text-zinc-200"
                      aria-label="Open conversation history"
                    >
                      {MenuIcon}
                    </Button>
                  )}
                  <div className="flex items-center gap-2.5">
                    {AtlasLogo}
                    <div>
                      <h1 className="text-xl font-semibold tracking-tight">Atlas</h1>
                      <p className="text-sm text-zinc-500">Ask your data anything</p>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-11 sm:size-8 text-zinc-500 dark:text-zinc-400"
                    onClick={() => setPromptLibraryOpen(true)}
                    aria-label="Open prompt library"
                  >
                    <BookOpen className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-11 sm:size-8 text-zinc-500 dark:text-zinc-400"
                    onClick={() => setSchemaExplorerOpen(true)}
                    aria-label="Open schema explorer"
                  >
                    <TableProperties className="size-4" />
                  </Button>
                  <ThemeToggle />
                  {isSignedIn && (
                    <>
                      <span className="hidden text-xs text-zinc-500 sm:inline dark:text-zinc-400">
                        {managedSession.data?.user?.email}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          authClient.signOut().catch((err: unknown) => {
                            console.error("Sign out failed:", err instanceof Error ? err.message : String(err));
                            setTransientWarning("Sign out failed. Please try again.");
                            setTimeout(() => setTransientWarning(""), 5000);
                          });
                        }}
                        className="text-xs text-zinc-500 dark:text-zinc-400"
                      >
                        Sign out
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </header>

            {(healthWarning || transientWarning || convos.fetchError) && (
              <p className="mb-2 text-xs text-zinc-400 dark:text-zinc-500">{healthWarning || transientWarning || convos.fetchError}</p>
            )}

            {isManaged && !isSignedIn ? (
              <ManagedAuthCard />
            ) : (
              <ActionAuthProvider getHeaders={getHeaders} getCredentials={getCredentials}>
                {authMode === "simple-key" && (
                  <div className="mb-3 flex-none">
                    <ApiKeyBar apiKey={apiKey} onSave={setApiKey} />
                  </div>
                )}

                <ScrollArea viewportRef={scrollRef} className="min-h-0 flex-1">
                <ErrorBoundary
                  fallbackRender={(_error, reset) => (
                    <div className="flex flex-col items-center justify-center gap-2 p-6 text-sm text-red-600 dark:text-red-400">
                      <p>Failed to render messages.</p>
                      <Button variant="link" size="sm" onClick={reset} className="text-xs">Try again</Button>
                    </div>
                  )}
                >
                <div className="space-y-4 pb-4 pr-3">
                  {messages.length === 0 && !error && (
                    <div className="flex h-full flex-col items-center justify-center gap-6">
                      <div className="text-center">
                        <p className="text-lg font-medium text-zinc-500 dark:text-zinc-400">
                          What would you like to know?
                        </p>
                        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-500">
                          Ask a question about your data to get started
                        </p>
                      </div>
                      <SuggestionChips
                        suggestions={popularSuggestions}
                        onSelect={handleSuggestionSelect}
                        loading={suggestionsLoading}
                        label="Popular queries"
                      />
                      <div className="grid w-full max-w-lg grid-cols-1 gap-2 sm:grid-cols-2">
                        {STARTER_PROMPTS.map((prompt) => (
                          <Button
                            key={prompt}
                            variant="outline"
                            onClick={() => handleSend(prompt)}
                            className="h-auto whitespace-normal justify-start rounded-lg bg-zinc-50 px-3 py-2.5 text-left text-sm text-zinc-500 hover:text-zinc-800 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200"
                          >
                            {prompt}
                          </Button>
                        ))}
                      </div>
                      <Button
                        variant="link"
                        onClick={() => setPromptLibraryOpen(true)}
                        className="text-xs text-zinc-400 dark:text-zinc-500"
                      >
                        <BookOpen className="mr-1.5 size-3.5" />
                        Browse prompt library
                      </Button>
                    </div>
                  )}

                  {messages.map((m, msgIndex) => {
                    if (m.role === "user") {
                      return (
                        <div key={m.id} className="flex justify-end" role="article" aria-label="Message from you">
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

                    const isLastAssistant =
                      m.role === "assistant" &&
                      msgIndex === messages.length - 1;

                    // Skip rendering assistant messages with no visible content
                    // (happens when stream errors before producing any text)
                    const hasVisibleParts = m.parts?.some(
                      (p) => (p.type === "text" && p.text.trim()) || isToolUIPart(p),
                    );
                    if (!hasVisibleParts && !isLastAssistant) return null;

                    // Extract suggestions from the last text part that contains them
                    const lastTextWithSuggestions = m.parts
                      ?.filter((p): p is typeof p & { type: "text"; text: string } => p.type === "text" && !!p.text.trim())
                      .findLast((p) => parseSuggestions(p.text).suggestions.length > 0);
                    const suggestions = lastTextWithSuggestions
                      ? parseSuggestions(lastTextWithSuggestions.text).suggestions
                      : [];

                    return (
                      <div key={m.id} className="space-y-2" role="article" aria-label="Message from Atlas">
                        {m.parts?.map((part, i) => {
                          if (part.type === "text" && part.text.trim()) {
                            const displayText = parseSuggestions(part.text).text;
                            if (!displayText.trim()) return null;
                            return (
                              <div key={i} className="max-w-[90%]">
                                <div className="rounded-xl bg-zinc-100 px-4 py-3 text-sm text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200">
                                  <Markdown content={displayText} />
                                </div>
                              </div>
                            );
                          }
                          if (isToolUIPart(part)) {
                            return (
                              <div key={i} className="max-w-[95%]">
                                <ToolPart part={part} pythonProgress={pythonProgress} />
                              </div>
                            );
                          }
                          return null;
                        })}
                        {/* Show inline error when the last assistant message is empty (stream failed before producing content) */}
                        {isLastAssistant && !hasVisibleParts && !isLoading && error && (
                          <div className="max-w-[90%]">
                            <div className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-400">
                              The response stream was interrupted before producing content. Try sending your message again.
                            </div>
                          </div>
                        )}
                        {isLastAssistant && !isLoading && hasVisibleParts && (
                          <>
                            <FollowUpChips
                              suggestions={suggestions}
                              onSelect={handleSend}
                            />
                            {relatedSuggestions.length > 0 && (
                              <SuggestionChips
                                suggestions={relatedSuggestions}
                                onSelect={handleSuggestionSelect}
                                label="Related queries"
                              />
                            )}
                            {conversationId && convos.available && (
                              <div className="flex items-center gap-1">
                                <SaveButton
                                  conversationId={conversationId}
                                  conversations={convos.conversations}
                                  onStar={convos.starConversation}
                                />
                                <ShareDialog
                                  key={conversationId}
                                  conversationId={conversationId}
                                  onShare={convos.shareConversation}
                                  onUnshare={convos.unshareConversation}
                                  onGetShareStatus={convos.getShareStatus}
                                />
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    );
                  })}

                  {isLoading && messages.length > 0 && <TypingIndicator />}
                </div>
                </ErrorBoundary>
                </ScrollArea>

                {error && (
                  <ErrorBanner
                    error={error}
                    authMode={authMode ?? "none"}
                    onRetry={
                      messages.some((m) => m.role === "user")
                        ? () => {
                            const lastUserMsg = messages.toReversed().find((m) => m.role === "user");
                            const text = lastUserMsg?.parts
                              ?.filter((p): p is { type: "text"; text: string } => p.type === "text")
                              .map((p) => p.text)
                              .join(" ");
                            if (text) handleSend(text);
                          }
                        : undefined
                    }
                  />
                )}

                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleSend(input);
                  }}
                  className="flex flex-none gap-2 border-t border-zinc-100 pt-4 dark:border-zinc-800"
                >
                  <Input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="Ask a question about your data..."
                    className="min-w-0 flex-1 py-3 text-base sm:text-sm"
                    disabled={isLoading}
                    aria-label="Chat message"
                  />
                  <Button
                    type="submit"
                    disabled={isLoading}
                    aria-disabled={!isLoading && !input.trim() ? true : undefined}
                    className="shrink-0 px-5"
                  >
                    Ask
                  </Button>
                </form>
              </ActionAuthProvider>
            )}
          </div>
        </main>
      </div>
      <SchemaExplorer
        open={schemaExplorerOpen}
        onOpenChange={setSchemaExplorerOpen}
        onInsertQuery={(text) => setInput(text)}
        getHeaders={getHeaders}
        getCredentials={getCredentials}
      />
      <PromptLibrary
        open={promptLibraryOpen}
        onOpenChange={setPromptLibraryOpen}
        onSendPrompt={handleSend}
        getHeaders={getHeaders}
        getCredentials={getCredentials}
      />
      <ChangePasswordDialog
        open={passwordChangeRequired}
        onComplete={() => setPasswordChangeRequired(false)}
      />
    </DarkModeContext.Provider>
  );
}
