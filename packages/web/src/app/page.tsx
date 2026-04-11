"use client";

import { Suspense, useState, useRef, useEffect } from "react";
import dynamic from "next/dynamic";
import { useChat } from "@ai-sdk/react";
import { isToolUIPart } from "ai";
import { useQueryStates } from "nuqs";
import { chatSearchParams } from "./search-params";
import { useConversations, transformMessages } from "@/ui/hooks/use-conversations";
import { ConversationSidebar } from "@/ui/components/conversations/conversation-sidebar";
import { getApiUrl, isCrossOrigin } from "@/lib/api-url";
import { useAtlasTransport } from "@/ui/hooks/use-atlas-transport";
import { authClient } from "@/lib/auth/client";
import { NavBar } from "@/ui/components/tour/nav-bar";
import { IncidentBanner } from "@/ui/components/incident-banner";
import { ErrorBanner } from "@/ui/components/chat/error-banner";
import { FollowUpChips } from "@/ui/components/chat/follow-up-chips";
import { ToolPart } from "@/ui/components/chat/tool-part";
import { Markdown } from "@/ui/components/chat/markdown";
import { TypingIndicator } from "@/ui/components/chat/typing-indicator";
import { STARTER_PROMPTS } from "@/ui/components/chat/starter-prompts";
import { SchemaExplorer } from "@/ui/components/schema-explorer/schema-explorer";
import { ShareDialog } from "@/ui/components/chat/share-dialog";
import { PromptLibrary } from "@/ui/components/chat/prompt-library";
import { parseSuggestions } from "@/ui/lib/helpers";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Send, TableProperties, BookOpen, Menu } from "lucide-react";

const OPENSTATUS_SLUG = process.env.NEXT_PUBLIC_OPENSTATUS_SLUG;
const STATUS_URL = process.env.NEXT_PUBLIC_STATUS_URL;

const GuidedTour = dynamic(
  () => import("@/ui/components/tour/guided-tour").then((m) => m.GuidedTour),
  { ssr: false },
);

export default function Home() {
  return (
    <Suspense
      fallback={
        <div className="flex h-dvh items-center justify-center">
          <p className="text-sm text-zinc-500">Loading...</p>
        </div>
      }
    >
      <ChatPage />
    </Suspense>
  );
}

function ChatPage() {
  const [params, setParams] = useQueryStates(chatSearchParams);
  const conversationId = params.id || undefined;

  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [schemaExplorerOpen, setSchemaExplorerOpen] = useState(false);
  const [promptLibraryOpen, setPromptLibraryOpen] = useState(false);
  const [fetchErrorDismissed, setFetchErrorDismissed] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastLoadedIdRef = useRef<string | null>(null);

  // Client-side role check for nav display only — actual admin access is
  // enforced by the backend (which resolves org member roles).
  const session = authClient.useSession();
  const user = session.data?.user as
    | { email?: string; role?: string }
    | undefined;
  const isAdmin = user?.role === "admin" || user?.role === "owner" || user?.role === "platform_admin";
  const isSignedIn = !!user;

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

  const convos = useConversations({
    apiUrl: getApiUrl(),
    enabled: true,
    getHeaders,
    getCredentials,
  });

  const refreshConvosRef = useRef(convos.refresh);
  refreshConvosRef.current = convos.refresh;

  // Reset dismissed state when a new fetch error appears
  useEffect(() => { setFetchErrorDismissed(false); }, [convos.fetchError]);

  // Re-fetch conversation list when auth mode changes
  useEffect(() => {
    // TanStack Query manages error state via convos.fetchError
    convos.fetchList().catch(() => {
      // intentionally ignored: TanStack Query error state handles display
    });
  }, [authMode, convos.fetchList]);

  const { messages, setMessages, sendMessage, status, error: chatError } = useChat({ transport });

  const isLoading = status === "streaming" || status === "submitted";

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    if (isNearBottom) el.scrollTop = el.scrollHeight;
  }, [messages, status]);

  // Load conversation when ID changes via URL navigation (browser back/forward, shared links).
  // Sidebar clicks go through handleSelectConversation which sets lastLoadedIdRef to skip this.
  useEffect(() => {
    if (!conversationId) return;
    if (conversationId === lastLoadedIdRef.current) return;
    let cancelled = false;
    setError(null);
    setLoadingConversation(true);
    async function load() {
      try {
        const convData = await convos.getConversationData(conversationId!);
        if (cancelled) return;
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
      } finally {
        if (!cancelled) setLoadingConversation(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [conversationId]);

  function handleSend(text: string) {
    if (!text.trim()) return;
    const saved = text;
    setInput("");
    sendMessage({ text: saved }).catch((err: unknown) => {
      console.error(
        "Failed to send message:",
        err instanceof Error ? err.message : String(err),
      );
      setInput(saved);
      setError("Failed to send message. Please try again.");
    });
  }

  function handleNewChat() {
    setError(null);
    setMessages([]);
    setParams({ id: "" });
    convos.setSelectedId(null);
    setInput("");
  }

  async function handleSelectConversation(id: string) {
    if (loadingConversation) return;
    setError(null);
    setLoadingConversation(true);
    try {
      const convData = await convos.getConversationData(id);
      setMessages(transformMessages(convData.messages));
      lastLoadedIdRef.current = id;
      setParams({ id });
      convos.setSelectedId(id);
      setMobileMenuOpen(false);
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

  function handleShare(id: string, opts?: Parameters<typeof convos.shareConversation>[1]) {
    return convos.shareConversation(id, opts);
  }

  function handleUnshare(id: string) {
    return convos.unshareConversation(id);
  }

  function handleGetShareStatus(id: string) {
    return convos.getShareStatus(id);
  }

  if (healthWarning) {
    return (
      <div className="flex h-dvh items-center justify-center p-8">
        <div className="text-center">
          <p className="text-sm text-red-600 dark:text-red-400">{healthWarning}</p>
          <Button className="mt-4" onClick={() => window.location.reload()}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  if (!authResolved) {
    return (
      <div className="flex h-dvh items-center justify-center">
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
      <div className="flex h-dvh flex-col">
        <IncidentBanner slug={OPENSTATUS_SLUG} statusUrl={STATUS_URL} />
        <NavBar isAdmin={isAdmin} />
        <div className="flex flex-1 overflow-hidden">
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

          <main id="main" className="flex flex-1 flex-col overflow-hidden">
            <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col overflow-hidden px-4 pt-4">
              {/* Toolbar */}
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {convos.available && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setMobileMenuOpen(true)}
                      className="size-8 text-zinc-400 hover:text-zinc-700 md:hidden dark:hover:text-zinc-200"
                      aria-label="Open conversation history"
                    >
                      <Menu className="size-4" />
                    </Button>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  {conversationId && (
                    <ShareDialog
                      conversationId={conversationId}
                      onShare={handleShare}
                      onUnshare={handleUnshare}
                      onGetShareStatus={handleGetShareStatus}
                    />
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 text-zinc-500 dark:text-zinc-400"
                    onClick={() => setPromptLibraryOpen(true)}
                    aria-label="Prompt library"
                  >
                    <BookOpen className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 text-zinc-500 dark:text-zinc-400"
                    onClick={() => setSchemaExplorerOpen(true)}
                    aria-label="Open schema explorer"
                  >
                    <TableProperties className="size-4" />
                  </Button>
                </div>
              </div>

              {/* Error bar */}
              {(error || (convos.fetchError && !fetchErrorDismissed)) && (
                <div className="mb-2 flex items-center justify-between rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
                  <p>{error || convos.fetchError}</p>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setError(null);
                      setFetchErrorDismissed(true);
                    }}
                    className="shrink-0 text-red-600 dark:text-red-400"
                  >
                    Dismiss
                  </Button>
                </div>
              )}

              {/* Messages */}
              <ScrollArea viewportRef={scrollRef} className="min-h-0 flex-1">
                <div className="space-y-4 pb-4 pr-3">
                  {messages.length === 0 && !chatError && (
                    <div className="flex h-full flex-col items-center justify-center gap-6 pt-16">
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
                            className="h-auto whitespace-normal justify-start rounded-lg px-3 py-2.5 text-left text-sm"
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
                                <ToolPart part={part} />
                              </div>
                            );
                          }
                          return null;
                        })}
                        {isLastAssistant && !hasVisibleParts && !isLoading && chatError && (
                          <div className="max-w-[90%]">
                            <div className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-400">
                              {chatError.message
                                ? `Response generation failed: ${chatError.message}. Try sending your message again.`
                                : "Response generation failed. Try sending your message again."}
                            </div>
                          </div>
                        )}
                        {isLastAssistant && !isLoading && hasVisibleParts && (
                          <FollowUpChips
                            suggestions={suggestions}
                            onSelect={handleSend}
                          />
                        )}
                      </div>
                    );
                  })}

                  {isLoading && messages.length > 0 && <TypingIndicator />}
                </div>
              </ScrollArea>

              {/* Chat error banner */}
              {chatError && (
                <ErrorBanner
                  error={chatError}
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

              {/* Input */}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleSend(input);
                }}
                className="flex flex-none gap-2 border-t border-zinc-100 py-4 dark:border-zinc-800"
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
                  size="icon"
                  disabled={isLoading}
                  aria-disabled={!isLoading && !input.trim() ? true : undefined}
                  aria-label="Send"
                  className="size-10 shrink-0"
                >
                  <Send className="size-4" />
                </Button>
              </form>
            </div>
          </main>
        </div>
      </div>

      {/* Modals */}
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
    </GuidedTour>
  );
}
