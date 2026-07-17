"use client";

/**
 * Bound chat drawer (#2363, History tab in #2368).
 *
 * Right-side Sheet that opens on `/dashboards/[id]` and runs a chat
 * conversation bound to that dashboard. Each drawer-open creates a
 * fresh conversation (a new `useChat` instance, new transport, new
 * conversation row on the server).
 *
 * Two tabs:
 *   - Chat: the live bound conversation (#2363 surface).
 *   - History: workspace-wide list of past bound sessions for this
 *     dashboard (#2368). Clicking a session opens a read-only
 *     transcript panel rendering messages with the same Markdown +
 *     ToolPart components used in the live drawer.
 *
 * Safe mutations (addCard, updateCard title/chartConfig/layout,
 * updateDashboardMeta) commit immediately to the user's draft. The
 * Publish UI on the dashboard page promotes the draft to published
 * via a diff-confirm modal. Destructive ops (removeCard, updateCardSql)
 * stage as ghost overlays the user accepts or discards inline.
 */

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Send, MessagesSquare, ArrowLeft, History, MessageCircle, User } from "lucide-react";
import { useAtlasConfig } from "@/ui/context";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { AgentTurn } from "@/ui/components/chat/agent-turn";
import { WorkingActivity, showPreStreamActivity } from "@/ui/components/chat/working-activity";
import { FollowUpChips } from "@/ui/components/chat/follow-up-chips";
import { BoundDraftProvider } from "@/ui/components/dashboards/bound-draft-context";
import { boundMutationSignature } from "@/ui/components/dashboards/bound-tool-invalidation";
import { parseSuggestions } from "@/ui/lib/helpers";
import { transformMessages } from "@useatlas/types/conversation";
import type { Message } from "@useatlas/types/conversation";

/** Stable empty parts array for the pre-stream feed (avoids a new [] per render). */
const NO_PARTS: [] = [];

/** Sentinel marking that a fresh (non-resume) open has cleared its transcript. */
const FRESH_SESSION = "__fresh__";

/** Pull the last set of parsed <suggestions> chips from an assistant turn. */
function suggestionsForMessage(message: UIMessage): string[] {
  if (message.role !== "assistant") return [];
  const parts = message.parts ?? [];
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (part.type === "text" && "text" in part) {
      const parsed = parseSuggestions(part.text);
      if (parsed.suggestions.length > 0) return parsed.suggestions;
    }
  }
  return [];
}

interface BoundChatDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dashboardId: string;
  dashboardTitle: string;
  /**
   * #4567 — called when a bound MUTATION tool completes SUCCESSFULLY (a new
   * card / updated title / new layout / staged change), so the dashboard view
   * re-fetches and the change shows up immediately. Surgical by design: a pure
   * read (`getDashboardState`, …) or a failed mutation does NOT fire this, so a
   * plain question in the drawer never flash-reloads the board. The read-vs-
   * write decision lives in `boundMutationSignature`.
   */
  onDashboardMutated?: () => void;
  /**
   * #4322 — creation-to-bound continuity. When the drawer is opened from a
   * `createDashboard` handoff, the originating conversation (with the SQL
   * and intent it just produced) carries into bound mode instead of a
   * reset-to-empty. The drawer pins this conversation id and hydrates its
   * transcript, so the next turn appends to the same conversation — which
   * the chat route then binds to this dashboard. `null`/undefined = the
   * default fresh-session-per-open behavior (opened from "Edit with chat").
   */
  resumeConversationId?: string | null;
}

// ---------------------------------------------------------------------------
// Wire types for the History tab (matches the API surface added in #2368)
// ---------------------------------------------------------------------------

interface SessionSummary {
  conversationId: string;
  userId: string | null;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

interface SessionListResponse {
  sessions: SessionSummary[];
}

interface SessionTranscriptResponse {
  conversationId: string;
  dashboardId: string;
  userId: string | null;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
}

export function BoundChatDrawer({
  open,
  onOpenChange,
  dashboardId,
  dashboardTitle,
  onDashboardMutated,
  resumeConversationId,
}: BoundChatDrawerProps) {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const [input, setInput] = useState("");
  // Tracks the active server-side conversation row. `null` on first
  // turn (the route creates one + binds it); subsequent turns pin to it.
  const conversationIdRef = useRef<string | null>(null);
  // Bumped whenever the user closes-and-reopens the drawer so each
  // session is a fresh `useChat` instance with its own message list +
  // its own server-side conversation row.
  const [sessionKey, setSessionKey] = useState(0);
  // Active tab + selected history session id (null = list view).
  const [activeTab, setActiveTab] = useState<"chat" | "history">("chat");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  // Reset session id + conversation pointer on every drawer open. This
  // matches the PRD's "fresh conversation per drawer-open" requirement
  // (each open starts a new bound conversation; history accessible via
  // the History tab).
  //
  // #4322 — EXCEPT when opened from a `createDashboard` handoff: then the
  // originating conversation carries in (pinned below + hydrated by the
  // resume effect) rather than resetting to empty.
  useEffect(() => {
    if (open) {
      conversationIdRef.current = resumeConversationId ?? null;
      setSessionKey((k) => k + 1);
      setActiveTab("chat");
      setSelectedSessionId(null);
      // The transcript itself (fresh-clear vs. resume-hydrate) is managed by
      // the seed effect below — it owns `setMessages`, which isn't in scope
      // until `useChat` is destructured.
    }
  }, [open, resumeConversationId]);

  const transport = useMemo(() => {
    return new DefaultChatTransport({
      api: `${apiUrl}/api/v1/chat`,
      credentials: isCrossOrigin ? "include" : undefined,
      body: () => {
        const body: Record<string, string> = {
          // #2363 — the route stamps this onto the conversation row on
          // the conversation-creating turn. Sent on every turn for
          // symmetry; the server ignores it once the row is bound.
          boundDashboardId: dashboardId,
        };
        if (conversationIdRef.current) {
          body.conversationId = conversationIdRef.current;
        }
        return body;
      },
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await globalThis.fetch(input, init);
        const convId = response.headers.get("x-conversation-id");
        if (convId && convId !== conversationIdRef.current) {
          conversationIdRef.current = convId;
        }
        return response;
      }) as typeof fetch,
    });
    // sessionKey forces a transport rebuild between sessions so the
    // `useChat` instance below picks up the cleared conversation ref.
  }, [apiUrl, isCrossOrigin, dashboardId, sessionKey]);

  // `bound_dashboard_unavailable` warnings are pushed by the chat route
  // when bind/resolve failed and the request had explicitly asked to be
  // bound. Without surfacing them the drawer would silently run the
  // default agent ("I'd love to help… but I can't see any dashboard")
  // and the user would never know their edits weren't being captured.
  const [boundUnavailable, setBoundUnavailable] = useState<{
    title: string;
    detail: string;
  } | null>(null);

  // #4322 — a failed resume GET must NOT masquerade as a fresh session. When
  // the originating conversation can't be loaded (403 on a stale/foreign
  // `?conversationId=`, 404 after deletion, 5xx, network error), the seed
  // effect falls back to a genuinely fresh session (un-pins the ref so the
  // next turn mints a new conversation the user can see) and flips this so the
  // banner explains why — rather than silently appending to an invisible one.
  const [resumeFailed, setResumeFailed] = useState(false);

  // Clear the bind-warning between sessions so a previous run's banner
  // doesn't leak into the new conversation. (`resumeFailed` is owned by the
  // seed effect below, which co-locates the whole resume lifecycle — resetting
  // it here would race that effect when `sessionKey` bumps.)
  useEffect(() => {
    if (open) setBoundUnavailable(null);
  }, [open, sessionKey]);

  const handleStreamData = useCallback((dataPart: { type: string; data: unknown }) => {
    if (dataPart.type !== "data-context-warning") return;
    const data = dataPart.data as
      | { code?: string; title?: string; detail?: string }
      | null
      | undefined;
    if (!data || data.code !== "bound_dashboard_unavailable") return;
    setBoundUnavailable({
      title: typeof data.title === "string" ? data.title : "Dashboard editing unavailable",
      detail:
        typeof data.detail === "string"
          ? data.detail
          : "Edits in this chat won't take effect. Reopen the drawer to retry.",
    });
  }, []);

  const { messages, setMessages, sendMessage, status, error } = useChat({
    transport,
    // Subscribe to the same `data-context-warning` channel the main
    // chat uses so the bound flow can surface bind/resolve failures.
    onData: handleStreamData as never,
  });

  const isLoading = status === "streaming" || status === "submitted";

  // #4322 — creation-to-bound continuity. When `resumeConversationId` is
  // set, hydrate the drawer with that conversation's transcript so the SQL +
  // intent it just produced carries in (no reset-to-empty). Fetched only
  // while the drawer is open AND a resume id is present; the creating user
  // owns the conversation, so the per-user `/conversations/:id` GET resolves.
  const resumeQuery = useAdminFetch<{ messages: Message[] }>(
    `/api/v1/conversations/${resumeConversationId}`,
    { enabled: open && !!resumeConversationId },
  );

  // Own the transcript lifecycle for an open: clear on a fresh open, hydrate
  // once on a resume open. Guarded by a ref so a later live turn is never
  // clobbered by a re-run of this effect. Reset on close so reopening re-runs.
  const seededConversationRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open) {
      seededConversationRef.current = null;
      return;
    }
    if (!resumeConversationId) {
      // Fresh open → empty transcript, exactly once per open.
      if (seededConversationRef.current !== FRESH_SESSION) {
        setMessages([]);
        setResumeFailed(false);
        seededConversationRef.current = FRESH_SESSION;
      }
      return;
    }
    if (seededConversationRef.current === resumeConversationId) return;
    // Resume GET failed — do NOT stay pinned to a conversation the user can't
    // see. Un-pin so the next turn mints a fresh, visible conversation, clear
    // any partial transcript, and flip the banner. Mark seeded so we don't
    // loop on the same failing id.
    if (resumeQuery.error) {
      conversationIdRef.current = null;
      setMessages([]);
      setResumeFailed(true);
      seededConversationRef.current = resumeConversationId;
      return;
    }
    const loaded = resumeQuery.data?.messages;
    if (!Array.isArray(loaded)) return;
    setMessages(transformMessages(loaded) as unknown as UIMessage[]);
    setResumeFailed(false);
    seededConversationRef.current = resumeConversationId;
  }, [open, resumeConversationId, resumeQuery.data, resumeQuery.error, setMessages]);

  // #4567 — refetch the board surgically: only when a MUTATION tool on the
  // latest assistant turn completed successfully. A pure read
  // (`getDashboardState`, `explore`, …) or a failed mutation changes nothing on
  // the canvas, so it must not flash-reload every tile. The signature is a pure
  // derived string (React Compiler memoizes; manual useMemo is forbidden by
  // CLAUDE.md for perf-only cases) that changes exactly when a new successful
  // mutation lands — see `boundMutationSignature`.
  const mutationSignature = boundMutationSignature(messages[messages.length - 1]);

  // Fire at most once per DISTINCT signature: without this, an `onDashboardMutated`
  // that changes identity between renders would re-run the effect and refetch the
  // board again for a mutation already handled.
  const lastFiredSignatureRef = useRef("");
  useEffect(() => {
    if (!onDashboardMutated || !mutationSignature) return;
    if (lastFiredSignatureRef.current === mutationSignature) return;
    lastFiredSignatureRef.current = mutationSignature;
    onDashboardMutated();
  }, [mutationSignature, onDashboardMutated]);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const text = input.trim();
    if (!text || isLoading) return;
    setInput("");
    await sendMessage({ text });
  }

  // #4322 — a follow-up chip sends its text as the next turn (parity with the
  // main chat's FollowUpChips). Guarded against firing mid-stream.
  const handleSuggestionSelect = useCallback(
    (text: string) => {
      if (isLoading || !text.trim()) return;
      void sendMessage({ text });
    },
    [isLoading, sendMessage],
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col p-0 sm:max-w-[560px] lg:max-w-[640px]"
      >
        <SheetHeader className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <div className="flex items-center gap-2">
            <MessagesSquare className="size-4 text-primary" aria-hidden="true" />
            <SheetTitle className="text-base font-semibold">Edit with chat</SheetTitle>
          </div>
          <SheetDescription className="text-xs text-zinc-500 dark:text-zinc-400">
            Bound to <span className="font-medium text-zinc-700 dark:text-zinc-300">{dashboardTitle}</span> — safe edits commit immediately.
          </SheetDescription>
        </SheetHeader>

        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as "chat" | "history")}
          className="flex min-h-0 flex-1 flex-col gap-0"
        >
          <TabsList variant="line" className="mx-4 mt-2 w-fit">
            <TabsTrigger value="chat">
              <MessageCircle className="size-3.5" aria-hidden="true" />
              Chat
            </TabsTrigger>
            <TabsTrigger value="history">
              <History className="size-3.5" aria-hidden="true" />
              History
            </TabsTrigger>
          </TabsList>

          <TabsContent
            value="chat"
            className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
          >
            <ScrollArea className="flex-1 px-4 py-3">
              {/* #4322 — resuming the originating conversation: hold the space
                  with a skeleton instead of flashing the fresh-session prompts
                  before the transcript pops in. */}
              {resumeConversationId && resumeQuery.loading && messages.length === 0 && (
                <div className="space-y-3 py-2" data-testid="resume-loading">
                  <Skeleton className="h-8 w-2/3" />
                  <Skeleton className="h-16 w-full" />
                  <Skeleton className="h-8 w-1/2" />
                </div>
              )}

              {/* #4322 — a failed resume GET falls back to a fresh session
                  (the seed effect un-pinned the conversation ref); tell the
                  user why rather than silently starting over. */}
              {resumeFailed && (
                <div
                  role="alert"
                  data-testid="resume-failed-banner"
                  className="my-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-300"
                >
                  Couldn&rsquo;t load the previous conversation — starting a fresh
                  editing session. Your earlier work is safe in its own
                  conversation.
                </div>
              )}

              {messages.length === 0 &&
                !(resumeConversationId && resumeQuery.loading) && (
                <div className="space-y-3 py-6 text-sm text-zinc-500 dark:text-zinc-400">
                  <p>Tell the agent what to change. Examples:</p>
                  <ul className="space-y-1 pl-4">
                    <li>&ldquo;Add a card showing weekly signups&rdquo;</li>
                    <li>&ldquo;Rename card 2 to &lsquo;Active Users&rsquo;&rdquo;</li>
                    <li>&ldquo;Make card 3 a bar chart&rdquo;</li>
                    <li>&ldquo;What is card 1 counting?&rdquo;</li>
                  </ul>
                </div>
              )}

              {messages.map((m: UIMessage, i) => {
                const isLastAssistant =
                  m.role === "assistant" && i === messages.length - 1;
                return (
                  <BoundChatTurn
                    key={m.id}
                    message={m}
                    // #4300 — only the last assistant turn is live; it renders
                    // the working feed and settles into the receipt as the
                    // answer streams. Earlier turns are finished (receipt →
                    // answer → promoted artifact).
                    streaming={isLastAssistant && isLoading}
                    // Follow-up chips only on the finished final assistant turn.
                    showSuggestions={isLastAssistant && !isLoading}
                    onSelectSuggestion={handleSuggestionSelect}
                  />
                );
              })}

              {/* #4300 — the working phase begins at send, before the assistant
                  message mounts: a standalone activity feed holds the spot the
                  streaming turn's own feed then takes over (same component, same
                  position), so the drawer never opens a turn with dead air. */}
              {showPreStreamActivity(isLoading, messages[messages.length - 1]?.role) && (
                <div className="my-2">
                  <WorkingActivity parts={NO_PARTS} />
                </div>
              )}

              {boundUnavailable && (
                <div
                  role="alert"
                  data-testid="bound-unavailable-banner"
                  className="my-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-300"
                >
                  <div className="font-medium">{boundUnavailable.title}</div>
                  <div className="mt-1">{boundUnavailable.detail}</div>
                </div>
              )}

              {error && (
                <div
                  role="alert"
                  className="my-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-400"
                >
                  {error.message || "The agent hit an error. Try again."}
                </div>
              )}
            </ScrollArea>

            <form
              onSubmit={handleSubmit}
              className="border-t border-zinc-200 px-4 py-3 dark:border-zinc-800"
            >
              <div className="flex items-center gap-2">
                <Input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Ask the agent to edit this dashboard…"
                  disabled={isLoading}
                  autoFocus
                  className="flex-1"
                  aria-label="Message"
                />
                <Button type="submit" size="icon" disabled={!input.trim() || isLoading}>
                  <Send className="size-4" aria-hidden="true" />
                  <span className="sr-only">Send</span>
                </Button>
              </div>
            </form>
          </TabsContent>

          <TabsContent
            value="history"
            className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
          >
            {selectedSessionId ? (
              <HistoryTranscriptPanel
                dashboardId={dashboardId}
                sessionId={selectedSessionId}
                onBack={() => setSelectedSessionId(null)}
              />
            ) : (
              <HistorySessionList
                dashboardId={dashboardId}
                onSelect={setSelectedSessionId}
                // Only fetch the list when the tab is actually visible —
                // keeps the drawer-open fast for users who never look at
                // history. `useAdminFetch`'s TanStack Query cache still
                // dedupes across tab toggles.
                enabled={activeTab === "history"}
              />
            )}
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// History tab — session list
// ---------------------------------------------------------------------------

function HistorySessionList({
  dashboardId,
  onSelect,
  enabled,
}: {
  dashboardId: string;
  onSelect: (sessionId: string) => void;
  enabled: boolean;
}) {
  const { data, loading, error } = useAdminFetch<SessionListResponse>(
    `/api/v1/dashboards/${dashboardId}/sessions`,
    { enabled },
  );

  if (loading) {
    return (
      <div className="space-y-2 px-4 py-3" data-testid="history-loading">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div
        role="alert"
        className="m-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-400"
      >
        Could not load session history. {error.message}
      </div>
    );
  }

  const sessions = data?.sessions ?? [];

  if (sessions.length === 0) {
    return (
      <div className="px-4 py-8 text-sm text-zinc-500 dark:text-zinc-400">
        <p>No previous chat sessions yet.</p>
        <p className="mt-1 text-xs">
          Every time you open this drawer, a new bound conversation appears
          here once you send a message.
        </p>
      </div>
    );
  }

  return (
    <ScrollArea className="flex-1 px-4 py-3">
      <ul className="space-y-2">
        {sessions.map((s) => (
          <li key={s.conversationId}>
            <button
              type="button"
              onClick={() => onSelect(s.conversationId)}
              className="block w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-left text-sm transition hover:border-primary/40 hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900"
            >
              <div className="truncate font-medium text-zinc-900 dark:text-zinc-100">
                {s.title?.trim() || "Untitled session"}
              </div>
              <div className="mt-1 flex items-center gap-3 text-xs text-zinc-500 dark:text-zinc-400">
                <span className="inline-flex items-center gap-1">
                  <User className="size-3" aria-hidden="true" />
                  {s.userId ?? "Unknown"}
                </span>
                <span>{formatStartedAt(s.createdAt)}</span>
                <span>
                  {s.messageCount} message{s.messageCount === 1 ? "" : "s"}
                </span>
              </div>
            </button>
          </li>
        ))}
      </ul>
    </ScrollArea>
  );
}

// ---------------------------------------------------------------------------
// History tab — read-only transcript panel
// ---------------------------------------------------------------------------

function HistoryTranscriptPanel({
  dashboardId,
  sessionId,
  onBack,
}: {
  dashboardId: string;
  sessionId: string;
  onBack: () => void;
}) {
  const { data, loading, error } = useAdminFetch<SessionTranscriptResponse>(
    `/api/v1/dashboards/${dashboardId}/sessions/${sessionId}`,
  );

  const transformed = data ? transformMessages(data.messages) : [];
  // Index of the last assistant turn — the only one whose suggestion chips
  // we surface (the session's closing follow-ups).
  let lastAssistantIndex = -1;
  for (let i = transformed.length - 1; i >= 0; i--) {
    if (transformed[i].role === "assistant") {
      lastAssistantIndex = i;
      break;
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="h-7 gap-1 px-2 text-xs"
        >
          <ArrowLeft className="size-3.5" aria-hidden="true" />
          All sessions
        </Button>
        {data?.title && (
          <span className="truncate text-xs text-zinc-500 dark:text-zinc-400">
            {data.title}
          </span>
        )}
      </div>

      <ScrollArea className="flex-1 px-4 py-3">
        {loading && (
          <div className="space-y-3" data-testid="transcript-loading">
            <Skeleton className="h-10 w-3/4" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-10 w-2/3" />
          </div>
        )}

        {error && !loading && (
          <div
            role="alert"
            className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-400"
          >
            Could not load transcript. {error.message}
          </div>
        )}

        {!loading && !error && transformed.length === 0 && (
          <div className="py-6 text-sm text-zinc-500 dark:text-zinc-400">
            This session has no messages.
          </div>
        )}

        {/* #4322 — the transcript is INERT history. The read-only bound-draft
            context makes any replayed destructive-edit card drop its live Undo
            (a finished session's undo would act on the current draft, not this
            stale receipt), and `BoundChatTurn` renders every turn as finished
            (receipt → answer) with its suggestion chips shown but
            non-interactive. */}
        <BoundDraftProvider
          value={{ dashboardId, onDraftChanged: () => {}, readOnly: true }}
        >
          {transformed.map((m, i) => (
            <BoundChatTurn
              key={m.id}
              message={m as unknown as UIMessage}
              streaming={false}
              // Show the final assistant turn's parsed suggestions inert.
              showSuggestions={i === lastAssistantIndex}
              readOnly
            />
          ))}
        </BoundDraftProvider>

        {data && !loading && (
          <div className="mt-6 border-t border-dashed border-zinc-200 pt-3 text-[10px] uppercase tracking-wide text-zinc-400 dark:border-zinc-800">
            Read-only transcript — started {formatStartedAt(data.createdAt)}
            {data.userId ? ` by ${data.userId}` : ""}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared turn renderer (used by both live chat + read-only transcript)
// ---------------------------------------------------------------------------

/**
 * #4322 — the bound drawer renders a turn through the SAME shared partitioner
 * the main chat uses (`AgentTurn`): the activity feed settles into a collapsed
 * receipt, the answer streams as the dominant element, and the building tools
 * (`addCard`, `getDashboardState`, `updateLayout`, …) get first-class receipt
 * cards instead of gray "Tool: addCard" boxes. This retires the drawer's old
 * divergent renderer (full-weight inline tool cards, no receipt, no live feed).
 */
function BoundChatTurn({
  message,
  streaming,
  showSuggestions,
  onSelectSuggestion,
  readOnly = false,
}: {
  message: UIMessage;
  streaming: boolean;
  showSuggestions: boolean;
  onSelectSuggestion?: (text: string) => void;
  readOnly?: boolean;
}) {
  if (message.role === "user") {
    const text = (message.parts ?? [])
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
    return (
      <div className="my-3 flex justify-end">
        <div
          className={
            readOnly
              ? "max-w-[80%] rounded-2xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200"
              : "max-w-[80%] rounded-2xl bg-primary px-3 py-2 text-sm text-primary-foreground"
          }
        >
          {text}
        </div>
      </div>
    );
  }

  const suggestions = showSuggestions ? suggestionsForMessage(message) : [];

  return (
    <div className="my-3 space-y-2" role="article" aria-label="Message from Atlas">
      <AgentTurn parts={message.parts} streaming={streaming} />
      {suggestions.length > 0 && (
        <FollowUpChips
          suggestions={suggestions}
          // In the read-only History transcript the chips render but don't act
          // (no live composer); the live drawer wires them to the next turn.
          onSelect={onSelectSuggestion ?? (() => {})}
          disabled={readOnly || !onSelectSuggestion}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatStartedAt(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    // intentionally ignored: bad date string falls back to the raw ISO string.
    return iso;
  }
}
