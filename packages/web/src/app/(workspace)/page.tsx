"use client";

import { Suspense, useState, useRef, useEffect } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useChat } from "@ai-sdk/react";
import { isToolUIPart, getToolName } from "ai";
import { cn } from "@/lib/utils";
import { computeSqlFailureDedup } from "@/ui/lib/sql-failure-dedup";
import { useQueryStates } from "nuqs";
import { chatSearchParams } from "./search-params";
import { useConversations, transformMessages } from "@/ui/hooks/use-conversations";
import { useDatasourceSummary } from "@/ui/hooks/use-datasource-summary";
import { getApiUrl, isCrossOrigin } from "@/lib/api-url";
import { useAtlasTransport } from "@/ui/hooks/use-atlas-transport";
import { useDefaultLanding } from "@/ui/hooks/use-default-landing";
import { authClient } from "@/lib/auth/client";
import { IncidentBanner } from "@/ui/components/incident-banner";
import { AssistantTurn } from "@/ui/components/chat/assistant-turn";
import { ErrorBanner } from "@/ui/components/chat/error-banner";
import { FollowUpChips } from "@/ui/components/chat/follow-up-chips";
import { ToolPart } from "@/ui/components/chat/tool-part";
import { Markdown } from "@/ui/components/chat/markdown";
import { TypingIndicator } from "@/ui/components/chat/typing-indicator";
import { ShareDialog } from "@/ui/components/chat/share-dialog";
import {
  ChatEnvPicker,
  shouldRenderEnvPicker,
  useChatEnvGroups,
  type ConversationRoutingMode,
} from "@/ui/components/chat/env-picker";
import { parseSuggestions } from "@/ui/lib/helpers";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { AskComposer } from "@/ui/components/ask-composer";
import { ConnectDataPrompt } from "@/ui/components/connect-data-prompt";
import { EmptyAskHero } from "@/ui/components/empty-ask-hero";
import { useDashboardCanvasStore, type ProposedDashboardSpec } from "@/lib/stores/dashboard-canvas-store";
import { DashboardCanvas } from "@/ui/components/dashboards/dashboard-canvas";
import { getToolResult, isToolComplete } from "@/ui/lib/helpers";

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
        <div className="flex h-full items-center justify-center">
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
  const [fetchErrorDismissed, setFetchErrorDismissed] = useState(false);
  // #2345 / #2504 — chat env/member picker state, client-side. Group id
  // is the content scope the server later persists on the conversation
  // row; connection id is a per-turn execution-target override the
  // server reads off the request body and does not persist. Both start
  // `null` so an un-picked workspace sends an unset body and the server
  // applies default routing.
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  // #2518 — three-state Auto/Pin/All cross-environment routing picker.
  // `null` until the user (or the server, on conversation load) picks a
  // mode; the transport omits the field when `null` so the server
  // applies its NULL→"pin" back-compat default for legacy
  // conversations.
  const [selectedRoutingMode, setSelectedRoutingMode] =
    useState<ConversationRoutingMode | null>(null);
  // Adaptive empty-chat starter surface — backend composes the ranked
  // prompt list from favorites / popular / library tiers (#1474).
  const [starterPrompts, setStarterPrompts] = useState<
    Array<{ id: string; text: string; provenance: string }>
  >([]);
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

  // Wait for the session to resolve before fetching the landing preference —
  // a 401 here silently falls through to chat and the admin opt-out never
  // takes effect on first paint.
  const router = useRouter();
  const { defaultLanding, loading: landingLoading } = useDefaultLanding(
    isSignedIn && !session.isPending,
  );
  const redirectingToAdmin = isAdmin && defaultLanding === "admin";
  useEffect(() => {
    if (landingLoading) return;
    if (!redirectingToAdmin) return;
    router.replace("/admin");
  }, [landingLoading, redirectingToAdmin, router]);

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
    // #2345 / #2504 — forward picker selection on every chat request.
    // The transport reads these refs at fetch time so a selection change
    // reaches the agent on the next turn without rebuilding the
    // transport.
    getConnectionId: () => selectedConnectionId,
    getConnectionGroupId: () => selectedGroupId,
    getRoutingMode: () => selectedRoutingMode,
  });

  const convos = useConversations({
    apiUrl: getApiUrl(),
    enabled: true,
    getHeaders,
    getCredentials,
  });

  // Datasource summary for the empty-state transparency line. Gated until
  // auth resolves to avoid a guaranteed-401 round trip on first paint.
  const datasource = useDatasourceSummary({
    apiUrl: getApiUrl(),
    isCrossOrigin: isCrossOrigin(),
    getHeaders,
    enabled: authResolved && isSignedIn,
  });

  // True only when the summary has resolved (not in-flight, not an error
  // soft-fail to null) AND there are zero queryable tables. The composer
  // and starter prompts are hidden in this state so the user is funneled
  // into setting up a connection before the agent gets a chance to run
  // and fail confusingly downstream.
  const needsDataSetup = datasource.data?.tableCount === 0;

  // #2345 / #2504 — env/member picker feed. Gated on auth so the request
  // doesn't 401 on first paint. The picker self-hides for legacy
  // single-connection workspaces, so leaving the hook always-on is safe.
  const envGroupsQuery = useChatEnvGroups({
    apiUrl: getApiUrl(),
    enabled: authResolved && isSignedIn,
    getHeaders,
    getCredentials,
  });

  // Collapse the wrapper row's hairline border when the picker hides
  // itself on a legacy 1×1 workspace.
  const showEnvPicker = shouldRenderEnvPicker({
    groups: envGroupsQuery.groups,
    reason: envGroupsQuery.reason,
    error: envGroupsQuery.error,
  });

  const refreshConvosRef = useRef(convos.refresh);
  refreshConvosRef.current = convos.refresh;

  // Reset dismissed state when a new fetch error appears
  useEffect(() => { setFetchErrorDismissed(false); }, [convos.fetchError]);

  // Re-fetch conversation list when auth mode changes
  useEffect(() => {
    convos.fetchList().catch((err: unknown) => {
      // TanStack Query owns the user-visible error state via convos.fetchError;
      // log here only so a console scrub picks up the underlying failure shape
      // when convos.fetchError itself misbehaves.
      console.debug(
        "[chat] convos.fetchList rejected:",
        err instanceof Error ? err.message : String(err),
      );
    });
  }, [authMode, convos.fetchList]);

  const { messages, setMessages, sendMessage, status, error: chatError } = useChat({ transport });

  const setCanvasSpec = useDashboardCanvasStore((s) => s.setSpec);
  const canvasOpen = useDashboardCanvasStore((s) => s.view.kind === "open");
  // Tracks tool-invocation ids we've already pushed into the canvas. A Set
  // (vs. a single ref) means an older proposal re-rendering after a newer one
  // can never overwrite the newer one — both ids stay marked consumed.
  const consumedProposalsRef = useRef<Set<string>>(new Set());

  // Push the latest completed, well-formed proposeDashboard result into the
  // canvas store. Parts without a stable `toolInvocationId` are skipped (and
  // logged) — synthesizing one from message indices would silently match
  // unrelated parts after list mutations.
  useEffect(() => {
    for (let m = messages.length - 1; m >= 0; m--) {
      const msg = messages[m];
      if (msg.role !== "assistant" || !msg.parts) continue;
      for (let p = msg.parts.length - 1; p >= 0; p--) {
        const part = msg.parts[p];
        if (!isToolUIPart(part)) continue;
        if (getToolName(part) !== "proposeDashboard") continue;
        if (!isToolComplete(part)) continue;

        const invocationId = (part as { toolInvocationId?: unknown }).toolInvocationId;
        if (typeof invocationId !== "string" || invocationId.length === 0) {
          console.warn("[chat] proposeDashboard part missing toolInvocationId — skipping canvas push");
          return;
        }
        if (consumedProposalsRef.current.has(invocationId)) return;

        const raw = getToolResult(part) as unknown;
        if (
          typeof raw === "object" &&
          raw !== null &&
          (raw as { kind?: unknown }).kind === "ok" &&
          typeof (raw as { spec?: unknown }).spec === "object" &&
          (raw as { spec?: unknown }).spec !== null
        ) {
          consumedProposalsRef.current.add(invocationId);
          setCanvasSpec((raw as { spec: ProposedDashboardSpec }).spec);
        }
        return; // most recent proposal found — even if it was an error, don't push older ones
      }
    }
  }, [messages, setCanvasSpec]);

  const isLoading = status === "streaming" || status === "submitted";

  // When a caller deep-links with `?prompt=...` (wizard Done, signup success
  // starters) or the workspace shell delivers a schema-explorer / prompt-
  // library pick, prefill the input. Auto-submit would race with auth /
  // transport readiness; users press Enter or click Send.
  //
  // Key on the dispatched value, not a once-per-mount flag — the page now
  // stays mounted across sibling navigations (the workspace shell keeps it
  // alive), and a second pick on the same surface must re-fire.
  const lastPrefilledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!params.prompt) return;
    if (params.prompt === lastPrefilledRef.current) return;
    const text = params.prompt;
    lastPrefilledRef.current = text;
    setInput(text);
    setParams({ prompt: "" }).catch((err: unknown) => {
      console.warn("[chat] failed to clear prompt param:", err instanceof Error ? err.message : String(err));
    });
  }, [params.prompt, setParams]);

  // Fetch adaptive starter prompts for the empty state (#1474)
  useEffect(() => {
    if (messages.length > 0) return;
    let cancelled = false;
    const apiUrl = getApiUrl();
    const credentials: RequestCredentials = isCrossOrigin() ? "include" : "same-origin";
    fetch(`${apiUrl}/api/v1/starter-prompts?limit=6`, {
      credentials,
      headers: getHeaders(),
    })
      .then(async (res) => {
        if (res.ok) return res.json();
        // Backend 5xx (e.g. settings read failure propagated per #1470) —
        // log the correlation id so operators can trace. UI still falls
        // through to the cold-start CTA.
        const body = (await res.json().catch(() => ({}))) as { requestId?: string };
        console.warn(
          "starter-prompts endpoint returned",
          res.status,
          "requestId:",
          body.requestId,
        );
        return null;
      })
      .then((data) => {
        if (!cancelled && Array.isArray(data?.prompts)) {
          setStarterPrompts(data.prompts);
        }
      })
      .catch((err: unknown) => {
        // HTTP 5xx is logged above with requestId. Network/parse/abort
        // failures land here — keep them at debug since an empty starter
        // list collapses the grid back to the bare cold-start headline,
        // but surface the shape so "why is my empty state bare?" stays
        // debuggable.
        console.debug(
          "[starter-prompts] fetch failed:",
          err instanceof Error ? err.message : String(err),
        );
      });
    return () => { cancelled = true; };
  }, [messages.length, getHeaders]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    if (isNearBottom) el.scrollTop = el.scrollHeight;
  }, [messages, status]);

  // The workspace shell drives conversation selection through `?id=...`. This
  // surface follows the URL: load on a new id, clear on an empty id after one
  // was loaded.
  useEffect(() => {
    // Clear first — when the page stays mounted across navigations (the
    // workspace shell keeps it alive), a stale load failure for B would
    // otherwise persist when the user returns to A.
    setError(null);
    if (!conversationId) {
      if (lastLoadedIdRef.current !== null) {
        setMessages([]);
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
    setInput("");
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

  if (!authResolved) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-zinc-500">Connecting...</p>
      </div>
    );
  }

  // Suppress the chat render during the one-frame window between the
  // preference fetch resolving as `admin` and the router landing on /admin.
  // Without this, the user sees a flash of the chat surface before the
  // redirect commits.
  if (redirectingToAdmin) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-zinc-500">Loading admin console...</p>
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
        <IncidentBanner slug={OPENSTATUS_SLUG} statusUrl={STATUS_URL} />
        <div className="flex flex-1 overflow-hidden">
          <div
            className={cn(
              "flex flex-1 flex-col overflow-hidden",
              canvasOpen && "min-w-0",
            )}
          >
            <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col overflow-hidden px-4 pt-4">
              {/* Top control row — env picker (left) + share dialog (right).
                  Renders only when at least one child is visible so the
                  hairline border doesn't appear on a legacy 1×1 workspace.
                  The picker is how the user re-scopes a conversation on
                  the next turn (#2345); restoring it here is #2504. */}
              {(showEnvPicker || conversationId) && (
                <div className="mb-3 flex items-center justify-between gap-2 border-b border-zinc-100 pb-2 dark:border-zinc-800/60">
                  <div className="flex items-center gap-2">
                    <ChatEnvPicker
                      groups={envGroupsQuery.groups}
                      emptyReason={envGroupsQuery.reason}
                      transportError={envGroupsQuery.error}
                      activeGroupId={selectedGroupId}
                      activeConnectionId={selectedConnectionId}
                      activeRoutingMode={selectedRoutingMode}
                      onSelect={({ groupId, connectionId, routingMode }) => {
                        setSelectedGroupId(groupId);
                        setSelectedConnectionId(connectionId);
                        setSelectedRoutingMode(routingMode);
                      }}
                    />
                  </div>
                  {conversationId && (
                    <ShareDialog
                      conversationId={conversationId}
                      onShare={handleShare}
                      onUnshare={handleUnshare}
                      onGetShareStatus={handleGetShareStatus}
                    />
                  )}
                </div>
              )}

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
                <div className="space-y-4 pb-4">
                  {messages.length === 0 && !chatError && (
                    needsDataSetup ? (
                      <ConnectDataPrompt isAdmin={isAdmin} />
                    ) : (
                      <EmptyAskHero
                        heading="Ask Atlas about your data."
                        subhead={
                          datasource.data && datasource.data.tableCount > 0 ? (
                            <>
                              Grounded in your semantic layer —{" "}
                              <span className="font-medium text-primary">
                                {datasource.data.tableCount} table
                                {datasource.data.tableCount === 1 ? "" : "s"}
                              </span>{" "}
                              ready to query.
                            </>
                          ) : (
                            "Every answer cites the table it queried."
                          )
                        }
                      >
                        {starterPrompts.length > 0 && (
                          <div className="grid w-full max-w-lg grid-cols-1 gap-2 sm:grid-cols-2">
                            {starterPrompts.map((prompt) => (
                              <Button
                                key={prompt.id}
                                variant="outline"
                                onClick={() => handleSend(prompt.text)}
                                className="h-auto whitespace-normal justify-start rounded-lg px-3 py-2.5 text-left text-sm"
                              >
                                {prompt.text}
                              </Button>
                            ))}
                          </div>
                        )}
                      </EmptyAskHero>
                    )
                  )}

                  {messages.map((m, msgIndex) => {
                    if (m.role === "user") {
                      return (
                        <div key={m.id} className="flex justify-end" role="article" aria-label="Message from you">
                          <div className="max-w-[85%] rounded-xl bg-primary px-4 py-3 text-sm text-primary-foreground">
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

                    const { failureRuns, skipFailureIndex } = computeSqlFailureDedup(m.parts);

                    return (
                      <AssistantTurn
                        key={m.id}
                        role="article"
                        aria-label="Message from Atlas"
                      >
                        {m.parts?.map((part, i) => {
                          if (skipFailureIndex.has(i)) return null;

                          const prevPart = i > 0 ? m.parts?.[i - 1] : undefined;
                          const isExplore =
                            isToolUIPart(part) && getToolName(part) === "explore";
                          const prevIsExplore =
                            prevPart && isToolUIPart(prevPart) &&
                            getToolName(prevPart) === "explore";
                          // Consecutive explore rows sit flush; everything else gets breathing room.
                          const spacing =
                            i === 0 ? "" : isExplore && prevIsExplore ? "mt-0" : "mt-2";

                          if (part.type === "text" && part.text.trim()) {
                            const displayText = parseSuggestions(part.text).text;
                            if (!displayText.trim()) return null;
                            return (
                              <div key={i} className={cn("max-w-[90%]", spacing)}>
                                <div className="rounded-xl bg-zinc-100 px-4 py-3 text-sm text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200">
                                  <Markdown content={displayText} />
                                </div>
                              </div>
                            );
                          }
                          if (isToolUIPart(part)) {
                            return (
                              <div key={i} className={cn("max-w-[95%]", spacing)}>
                                <ToolPart part={part} repeatedCount={failureRuns.get(i)} />
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
                        {isLastAssistant && isLoading && !hasVisibleParts && (
                          <TypingIndicator />
                        )}
                        {isLastAssistant && !isLoading && hasVisibleParts && (
                          <FollowUpChips
                            suggestions={suggestions}
                            onSelect={handleSend}
                          />
                        )}
                      </AssistantTurn>
                    );
                  })}

                  {/* Anchor the typing indicator inside an AssistantTurn so it
                      sits in the gutter rather than floating loose below. */}
                  {isLoading &&
                    messages.length > 0 &&
                    messages[messages.length - 1].role === "user" && (
                      <AssistantTurn>
                        <TypingIndicator />
                      </AssistantTurn>
                    )}
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
                  onStartNewConversation={handleNewChat}
                />
              )}

              {/* Input — hidden when the workspace has no data so the user
                   sets up a connection before the agent can run. */}
              {!(needsDataSetup && messages.length === 0) && (
                <AskComposer
                  value={input}
                  onChange={setInput}
                  onSubmit={() => handleSend(input)}
                  disabled={isLoading}
                  placeholder="Ask a question about your data… ⌘K for commands"
                  inputAriaLabel="Chat message"
                />
              )}
            </div>
          </div>

          <DashboardCanvas
            apiUrl={getApiUrl()}
            getHeaders={getHeaders}
            getCredentials={getCredentials}
          />
        </div>
      </div>
    </GuidedTour>
  );
}
