"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, isToolUIPart } from "ai";
import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { useQuery, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AuthMode } from "../lib/types";
import type { ToolRenderers } from "../lib/tool-renderer-types";
import { AtlasUIProvider, useAtlasConfig, ActionAuthProvider, type AtlasAuthClient } from "../context";
import { DarkModeContext, useDarkMode, useThemeMode, setTheme, applyBrandColor, OKLCH_RE, type ThemeMode } from "../hooks/use-dark-mode";
import { useConversations } from "../hooks/use-conversations";
import { ErrorBanner } from "./chat/error-banner";
import { ApiKeyBar } from "./chat/api-key-bar";
import { ManagedAuthCard } from "./chat/managed-auth-card";
import { TypingIndicator } from "./chat/typing-indicator";
import { ToolPart } from "./chat/tool-part";
import { Markdown } from "./chat/markdown";
import { STARTER_PROMPTS } from "./chat/starter-prompts";
import { FollowUpChips } from "./chat/follow-up-chips";
import { ConversationSidebar } from "./conversations/conversation-sidebar";
import { ChangePasswordDialog } from "./admin/change-password-dialog";
import { useHealthQuery } from "../hooks/use-health-query";
import { Sun, Moon, Monitor, Star, TableProperties } from "lucide-react";
import { SchemaExplorer } from "./schema-explorer/schema-explorer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { ScrollArea } from "./ui/scroll-area";
import { parseSuggestions } from "../lib/helpers";
import { ErrorBoundary } from "./error-boundary";

const API_KEY_STORAGE_KEY = "atlas-api-key";

export interface AtlasChatProps {
  /** Atlas API server URL (e.g. "https://api.example.com" or "" for same-origin). */
  apiUrl: string;
  /** API key for simple-key auth mode. When provided, sent as Bearer token. */
  apiKey?: string;
  /** Theme preference. Defaults to "system". */
  theme?: ThemeMode;
  /** Enable conversation history sidebar. Defaults to false. */
  sidebar?: boolean;
  /** Enable schema explorer button. Defaults to false. */
  schemaExplorer?: boolean;
  /** Custom auth client for managed auth mode. */
  authClient?: AtlasAuthClient;
  /** Custom renderers for tool results. Keys are tool names (e.g. "executeSQL", "explore", "executePython"). */
  toolRenderers?: ToolRenderers;
  /** Custom chat API endpoint path. Defaults to "/api/v1/chat". */
  chatEndpoint?: string;
  /** Custom conversations API endpoint path. Defaults to "/api/v1/conversations". */
  conversationsEndpoint?: string;
}

/** No-op auth client for non-managed auth modes. */
const noopAuthClient: AtlasAuthClient = {
  signIn: { email: async () => ({ error: { message: "Not supported" } }) },
  signUp: { email: async () => ({ error: { message: "Not supported" } }) },
  signOut: async () => {},
  useSession: () => ({ data: null, isPending: false }),
};

/* Static SVG icons — hoisted to avoid recreation on every render */
const MenuIcon = (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
    <path fillRule="evenodd" d="M2 4.75A.75.75 0 0 1 2.75 4h14.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 4.75ZM2 10a.75.75 0 0 1 .75-.75h14.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 10Zm0 5.25a.75.75 0 0 1 .75-.75h14.5a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1-.75-.75Z" clipRule="evenodd" />
  </svg>
);

const AtlasLogo = (
  <svg data-atlas-logo viewBox="0 0 256 256" fill="none" className="h-7 w-7 shrink-0 text-primary" aria-hidden="true">
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
    } catch (err) {
      console.warn("Failed to update star:", err);
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

/**
 * Standalone Atlas chat component.
 *
 * Wraps itself in AtlasUIProvider so consumers only need to pass props.
 * For advanced usage (e.g. custom auth client), pass `authClient`.
 */
export function AtlasChat(props: AtlasChatProps) {
  const {
    apiUrl,
    apiKey: propApiKey,
    theme: propTheme = "system",
    sidebar = false,
    schemaExplorer: schemaExplorerEnabled = false,
    authClient = noopAuthClient,
    toolRenderers,
    chatEndpoint = "/api/v1/chat",
    conversationsEndpoint = "/api/v1/conversations",
  } = props;

  // Apply theme from props on mount and when it changes
  useEffect(() => {
    setTheme(propTheme);
  }, [propTheme]);

  // Standalone QueryClient for the widget — does not conflict with host app's QueryClient.
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: true, gcTime: 5 * 60 * 1000 },
    },
  }));

  return (
    <QueryClientProvider client={queryClient}>
      <AtlasUIProvider config={{ apiUrl, authClient }}>
        <AtlasChatInner
          propApiKey={propApiKey}
          sidebar={sidebar}
          schemaExplorerEnabled={schemaExplorerEnabled}
          toolRenderers={toolRenderers}
          chatEndpoint={chatEndpoint}
          conversationsEndpoint={conversationsEndpoint}
        />
      </AtlasUIProvider>
    </QueryClientProvider>
  );
}

function AtlasChatInner({
  propApiKey,
  sidebar,
  schemaExplorerEnabled,
  toolRenderers,
  chatEndpoint,
  conversationsEndpoint,
}: {
  propApiKey?: string;
  sidebar: boolean;
  schemaExplorerEnabled: boolean;
  toolRenderers?: ToolRenderers;
  chatEndpoint: string;
  conversationsEndpoint: string;
}) {
  const { apiUrl, isCrossOrigin, authClient } = useAtlasConfig();
  const dark = useDarkMode();
  const [input, setInput] = useState("");
  // authMode and healthFailed are derived from healthQuery below.
  const [healthWarning, setHealthWarning] = useState("");
  const [apiKey, setApiKey] = useState(propApiKey ?? "");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [loadingConversation, setLoadingConversation] = useState(false);
  // passwordChangeRequired state removed — derived from passwordQuery.data below
  const [schemaExplorerOpen, setSchemaExplorerOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Sync prop API key changes
  useEffect(() => {
    if (propApiKey !== undefined) setApiKey(propApiKey);
  }, [propApiKey]);

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
    enabled: sidebar,
    getHeaders,
    getCredentials,
    conversationsEndpoint,
  });

  const refreshConvosRef = useRef(convos.refresh);
  refreshConvosRef.current = convos.refresh;

  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;

  // Load API key from sessionStorage on mount
  useEffect(() => {
    if (!propApiKey) {
      try {
        const stored = sessionStorage.getItem(API_KEY_STORAGE_KEY);
        if (stored) setApiKey(stored);
      } catch (err) {
        console.warn("Cannot read API key from sessionStorage:", err);
      }
    }
  }, [propApiKey]);

  // Shared health query — deduped with useAtlasAuth via ["atlas", "health"] key.
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";
  const healthQuery = useHealthQuery();

  // Derive auth mode directly from query data — no useEffect sync delay.
  const authMode: AuthMode | null = healthQuery.isError ? "none" : (healthQuery.data?.authMode ?? null);
  const healthFailed = healthQuery.isError;

  // Sync health error + brand color as side effects.
  useEffect(() => {
    if (healthQuery.isError) {
      setHealthWarning("Unable to reach the API server. Try refreshing the page.");
    }
    if (healthQuery.data?.brandColor && OKLCH_RE.test(healthQuery.data.brandColor)) {
      applyBrandColor(healthQuery.data.brandColor);
    }
  }, [healthQuery.data, healthQuery.isError]);

  // Fetch conversation list after auth is resolved
  useEffect(() => {
    if (sidebar) convos.fetchList();
  }, [authMode, sidebar, convos.fetchList]);

  // Check if managed auth user needs to change their default password.
  const passwordQuery = useQuery<{ passwordChangeRequired?: boolean }>({
    queryKey: ["admin", "me", "password-status"],
    queryFn: async ({ signal }) => {
      let res: Response;
      try {
        res = await fetch(`${apiUrl}/api/v1/admin/me/password-status`, {
          credentials,
          signal,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn("[Atlas] Password status check failed:", msg);
        throw new Error(`Password status check failed: ${msg}`, { cause: err });
      }
      // 404 = endpoint not available in this deployment
      if (res.status === 404) return {};
      if (!res.ok) {
        console.warn(`Password status check returned HTTP ${res.status}`);
        throw new Error(`Password status check failed (HTTP ${res.status})`);
      }
      return res.json();
    },
    enabled: isManaged && !!managedSession.data?.user,
    retry: 1,
  });
  const [passwordDialogDismissed, setPasswordDialogDismissed] = useState(false);

  const handleSaveApiKey = useCallback((key: string) => {
    setApiKey(key);
    try {
      sessionStorage.setItem(API_KEY_STORAGE_KEY, key);
    } catch (err) {
      console.warn("Could not persist API key to sessionStorage:", err);
    }
  }, []);

  const transport = useMemo(() => {
    const headers: Record<string, string> = {};
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
    return new DefaultChatTransport({
      api: `${apiUrl}${chatEndpoint}`,
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
  }, [apiKey, apiUrl, isCrossOrigin, chatEndpoint]);

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
      setMessages(uiMessages);
      setConversationId(id);
      convos.setSelectedId(id);
      setMobileMenuOpen(false);
    } catch (err: unknown) {
      console.warn("Failed to load conversation:", err instanceof Error ? err.message : String(err));
      setHealthWarning("Failed to load conversation. Please try again.");
      setTimeout(() => setHealthWarning(""), 5000);
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

  if (!authResolved || (isManaged && managedSession.isPending)) {
    return (
      <DarkModeContext.Provider value={dark}>
        <div className="atlas-root flex h-dvh items-center justify-center bg-white dark:bg-zinc-950" />
      </DarkModeContext.Provider>
    );
  }

  const showSidebar = sidebar && convos.available;

  return (
    <DarkModeContext.Provider value={dark}>
      <div className="atlas-root flex h-dvh">
        {showSidebar && (
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
                  {showSidebar && (
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
                  {schemaExplorerEnabled && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-11 sm:size-8 text-zinc-500 dark:text-zinc-400"
                      onClick={() => setSchemaExplorerOpen(true)}
                      aria-label="Open schema explorer"
                    >
                      <TableProperties className="size-4" />
                    </Button>
                  )}
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
                            console.error("Sign out failed:", err);
                            setHealthWarning("Sign out failed. Please try again.");
                            setTimeout(() => setHealthWarning(""), 5000);
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

            {(healthWarning || convos.fetchError) && (
              <p className="mb-2 text-xs text-zinc-400 dark:text-zinc-500">{healthWarning || convos.fetchError}</p>
            )}

            {isManaged && !isSignedIn ? (
              <ManagedAuthCard />
            ) : (
              <ActionAuthProvider getHeaders={getHeaders} getCredentials={getCredentials}>
                {authMode === "simple-key" && !propApiKey && (
                  <div className="mb-3 flex-none">
                    <ApiKeyBar apiKey={apiKey} onSave={handleSaveApiKey} />
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
                <div data-atlas-messages className="space-y-4 pb-4 pr-3">
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
                                <ToolPart part={part} toolRenderers={toolRenderers} />
                              </div>
                            );
                          }
                          return null;
                        })}
                        {/* Show inline error when the last assistant message is empty (stream failed before producing content) */}
                        {isLastAssistant && !hasVisibleParts && !isLoading && error && (
                          <div className="max-w-[90%]">
                            <div className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-400">
                              {error.message
                                ? `Something went wrong generating a response: ${error.message}. Try sending your message again.`
                                : "Something went wrong generating a response. Try sending your message again."}
                            </div>
                          </div>
                        )}
                        {isLastAssistant && !isLoading && hasVisibleParts && (
                          <>
                            <FollowUpChips
                              suggestions={suggestions}
                              onSelect={handleSend}
                            />
                            {conversationId && sidebar && convos.available && (
                              <SaveButton
                                conversationId={conversationId}
                                conversations={convos.conversations}
                                onStar={convos.starConversation}
                              />
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
                  data-atlas-form
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleSend(input);
                  }}
                  className="flex flex-none gap-2 border-t border-zinc-100 pt-4 dark:border-zinc-800"
                >
                  <Input
                    data-atlas-input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="Ask a question about your data..."
                    className="min-w-0 flex-1 py-3 text-base sm:text-sm"
                    disabled={isLoading || healthFailed}
                    aria-label="Chat message"
                  />
                  <Button
                    type="submit"
                    disabled={isLoading || healthFailed}
                    aria-disabled={!(isLoading || healthFailed) && !input.trim() ? true : undefined}
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
      {schemaExplorerEnabled && (
        <SchemaExplorer
          open={schemaExplorerOpen}
          onOpenChange={setSchemaExplorerOpen}
          onInsertQuery={(text) => setInput(text)}
          getHeaders={getHeaders}
          getCredentials={getCredentials}
        />
      )}
      <ChangePasswordDialog
        open={!passwordDialogDismissed && (passwordQuery.data?.passwordChangeRequired ?? false)}
        onComplete={() => setPasswordDialogDismissed(true)}
      />
    </DarkModeContext.Provider>
  );
}
