"use client";

import { useChat } from "@ai-sdk/react";
import { isToolUIPart, getToolName } from "ai";
import { useState, useRef, useEffect, useCallback, type ReactNode } from "react";
import { useQueryStates } from "nuqs";
import { useQueryClient } from "@tanstack/react-query";
import type { PythonProgressData } from "./chat/python-result-card";
import { useAtlasConfig } from "../context";
import { ThemeToggle } from "./theme-toggle";
import { UserMenu } from "./user-menu";
import { useAtlasTransport } from "../hooks/use-atlas-transport";
import { useConversations, transformMessages } from "../hooks/use-conversations";
import { useStarterPromptsQuery } from "../hooks/use-starter-prompts-query";
import { ChatComposer } from "./chat/chat-composer";
import { ErrorBanner, ActionErrorBanner } from "./chat/error-banner";
import { useChatFailures } from "../hooks/use-chat-failures";
import { ContextWarningBanner } from "./chat/context-warning-banner";
import { ResumeBanner } from "./chat/resume-banner";
import { useRunStatus } from "../hooks/use-run-status";
import { useResumeHandler } from "../hooks/use-resume-handler";
import { useStopHandler } from "../hooks/use-stop-handler";
import { ApiKeyBar } from "./chat/api-key-bar";
import { AgentTurn } from "./chat/agent-turn";
import { WorkingActivity, showPreStreamActivity } from "./chat/working-activity";
import { FollowUpChips } from "./chat/follow-up-chips";
import { SuggestionChips } from "./chat/suggestion-chips";
import { ChatConversationProvider } from "./chat/chat-conversation-context";
import {
  DeveloperChatEmptyState,
  shouldShowDevChatEmpty,
} from "./chat/developer-empty-state";
import {
  ChatEnvPicker,
  useChatEnvGroups,
} from "./chat/env-picker";
import {
  AnswerStylePicker,
  isKnownAnswerStyle,
  type AnswerStyle,
} from "./chat/answer-style-picker";
import {
  useConversationScope,
  INITIAL_CONVERSATION_SCOPE,
  type ConversationScope,
} from "../hooks/use-conversation-scope";
import { useMode } from "@/ui/hooks/use-mode";
import type { QuerySuggestion } from "@/ui/lib/types";
import { ShareDialog } from "./chat/share-dialog";
import { ConversationSidebar } from "./conversations/conversation-sidebar";
import { ChangePasswordDialog } from "./admin/change-password-dialog";
import { usePasswordStatus } from "@/ui/hooks/use-password-status";
import { Star, TableProperties, BookOpen, Pin } from "lucide-react";
import { SchemaExplorer } from "./schema-explorer/schema-explorer";
import { ConversationMemoryControl } from "./conversation-memory-control";
import { PromptLibrary } from "./chat/prompt-library";
import { StarterPromptList } from "./chat/starter-prompt-list";
import type { StarterPrompt } from "@useatlas/types/starter-prompt";
import { useContextWarnings } from "../hooks/use-context-warnings";
import { useTransientNotice } from "../hooks/use-transient-notice";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { parseSuggestions } from "../lib/helpers";
import { ErrorBoundary } from "./error-boundary";
import { useUiStore } from "@/lib/stores/ui-store";
import { chatSearchParams, resolveConversationUrlAction } from "./search-params";
import type { TurnPart } from "./chat/turn-partitioner";

/* Stable empty parts for the pre-stream working feed (#4300) — a hoisted
   constant keeps the prop reference identical across renders, so React
   Compiler memoization of the container holds (empty parts render no keyed
   children; keying was never at stake). */
const NO_PARTS: readonly TurnPart[] = [];

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

interface AtlasChatProps {
  /**
   * Embedded inside a host app shell (the hosted `(workspace)` chat). When true,
   * suppress the built-in conversation sidebar, the app-identity header
   * (logo/tagline/ThemeToggle/UserMenu + the prompt-library / schema-explorer
   * buttons), and the `SchemaExplorer` / `PromptLibrary` / `ChangePasswordDialog`
   * mounts — the host shell mounts its own copies against the shared UI store, so
   * leaving ours on would double-mount them. The env-picker, message thread,
   * composer, and save/share (when a conversation is active) remain. Default
   * false: the scaffold / demo render the full standalone chrome.
   */
  embedded?: boolean;
  /**
   * Host-provided: the workspace has no queryable tables yet. The "connect data"
   * gate engages only when this is true AND `emptyStateOverride` is supplied —
   * then, on an empty thread, the composer is hidden and the override is shown so
   * the user connects data before the agent can run and fail confusingly. With no
   * override the flag is a no-op (normal chat renders) rather than a blank screen.
   */
  needsDataSetup?: boolean;
  /**
   * Empty-state node rendered on an empty thread when `needsDataSetup` is true
   * (the hosted "connect data" prompt). Required for the gate to engage; ignored
   * when `needsDataSetup` is false.
   */
  emptyStateOverride?: ReactNode;
}

export function AtlasChat({
  embedded = false,
  needsDataSetup = false,
  emptyStateOverride,
}: AtlasChatProps = {}) {
  const { apiUrl, isCrossOrigin, authClient } = useAtlasConfig();
  const { mode } = useMode();
  // #3081 — the host "connect data" gate engages only when BOTH a zero-table
  // workspace is signalled AND the host supplied a node to show. Without an
  // override we'd render `undefined` into the empty slot AND still hide the
  // composer, stranding the user on a blank, unrecoverable screen — so require
  // both. The lone production caller always passes both; this guards future ones.
  const showDataSetupGate = needsDataSetup && emptyStateOverride != null;
  const [input, setInput] = useState("");
  // #3068 — the active conversation lives in the URL (`?id=`) so a reload or a
  // deep link reopens it (combined with #3065 the conversation's scope comes
  // back too). nuqs-backed; `conversationId` keeps the same string|null shape
  // every existing call site already expects.
  const [chatUrlParams, setChatUrlParams] = useQueryStates(chatSearchParams);
  const conversationId = chatUrlParams.id || null;
  const setConversationId = useCallback(
    (id: string | null, history: "push" | "replace" = "push") => {
      // `push` for deliberate navigations (sidebar select, new chat) so
      // back/forward step through conversations; `replace` when the agent mints
      // a conversation id mid-chat — that's a continuation of the current empty
      // chat, not a new navigation entry the back button should land on.
      void setChatUrlParams({ id: id ?? "" }, { history });
    },
    [setChatUrlParams],
  );
  // #3068 — the conversation the message thread is currently bound to (loaded,
  // streaming, or load-in-flight). The URL-driven open effect dedupes against
  // this so it never re-loads the active conversation (which would clobber a
  // live stream) nor retries a failed deep-link load on every render.
  const openedConversationIdRef = useRef<string | null>(null);
  // #3068 — the conversation the user most recently asked for (updated up-front
  // by handleSelectConversation, even when its in-flight guard defers the load).
  // An in-flight load checks this after its await and bails if it no longer
  // matches, so a quick back/forward mid-load can't commit the wrong
  // conversation over the newer one. Distinct from `openedConversationIdRef`,
  // which tracks what's actually loading (they diverge during a deferred nav).
  const latestRequestedConversationIdRef = useRef<string | null>(null);
  // #3068 — the conversation whose messages are actually mounted (committed on a
  // successful load, on the agent minting an id for the in-flight chat, and
  // cleared on a new chat). This — NOT the URL id — is what the transport sends:
  // a deep link sets the URL id immediately, but until that conversation's
  // history has loaded a send must not append to it with only the current
  // (empty) client messages. While the load is pending this stays null so a
  // quick send starts a fresh conversation instead of corrupting the target.
  const boundConversationIdRef = useRef<string | null>(null);
  // #3749 / #4294 — the latest durable run id captured from the `x-run-id`
  // response header (set on a fresh turn and on a resume). Targets the explicit
  // stop endpoint (`useStopHandler`); cleared on each send so it always means
  // "the active turn". The resume endpoint loads the latest non-terminal run by
  // conversation id, so this value is NOT used to target a resume.
  const runIdRef = useRef<string | null>(null);
  // #4297 — real failures (send / load / pin / unpin / resume) surface as a
  // persistent structured banner (`ActionErrorBanner`). The clear-scoping
  // policy — deliberate attempts supersede unscoped, machine-initiated /
  // implicit clears are kind-scoped — lives (documented and unit-tested) in
  // `useChatFailures`. Genuinely informational transients (pin success /
  // already-pinned) go through `useTransientNotice` — successes may whisper;
  // failures must not.
  const failures = useChatFailures();
  const { notice: transientNotice, showNotice: showTransientNotice } = useTransientNotice();
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [passwordDialogDismissed, setPasswordDialogDismissed] = useState(false);
  const setMobileSidebarOpen = useUiStore((s) => s.setMobileSidebarOpen);
  const schemaExplorerOpen = useUiStore((s) => s.schemaExplorerOpen);
  const setSchemaExplorerOpen = useUiStore((s) => s.setSchemaExplorerOpen);
  const promptLibraryOpen = useUiStore((s) => s.promptLibraryOpen);
  const setPromptLibraryOpen = useUiStore((s) => s.setPromptLibraryOpen);
  // Tracks the message text being pinned so the affordance disables
  // mid-flight — without this, a quick double-click fires two POSTs and
  // the second 409s right after a visible success notice.
  const [pinningText, setPinningText] = useState<string | null>(null);
  const [relatedSuggestions, setRelatedSuggestions] = useState<QuerySuggestion[]>([]);
  // #2345 / #4189 — the conversation's env/member/REST/reach scope lives in the
  // `useConversationScope` hook (one owning module for the three (value,
  // provenance) axes + sticky preference). Its inputs only settle below the
  // transport: `sessionResolved` (via `authResolved`) and `envGroupsQuery` (whose
  // fetch is gated on `authResolved`), plus the session-derived `activeWorkspaceId`
  // — so the hook is called below them. But the transport's chat-request getters
  // need to read the LATEST scope. This mirror ref bridges that: the getters read
  // `scopeRef.current` (lazy, at fetch time), and the hook's `scope` is synced
  // into it on every render right after the hook call (the same latest-value ref
  // pattern as `refreshConvosRef`).
  const scopeRef = useRef<ConversationScope>(INITIAL_CONVERSATION_SCOPE);
  // #4302 — the conversation's answer style (the header picker). `null` = no
  // explicit choice: the trigger shows the web default ("Analyst") and the
  // transport omits the field so the server inherits the row / applies the
  // live default (workspace default #4303, else surface default).
  // Deliberately NOT part of `useConversationScope`: it has
  // no sticky preference, no group validation, and no provenance races — a
  // plain state + latest-value ref (for the transport's fetch-time getter)
  // covers restore-on-open and reset-on-new-chat at the same two call sites
  // the scope hook uses.
  const [answerStyle, setAnswerStyle] = useState<AnswerStyle | null>(null);
  const answerStyleRef = useRef<AnswerStyle | null>(null);
  answerStyleRef.current = answerStyle;
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
    // #3068 — send the conversation whose messages are mounted, NOT the URL id.
    // A deep link makes the URL id non-null before its history loads; sending
    // that id would append a turn to the conversation with only the current
    // client messages. `boundConversationIdRef` is null until the load commits.
    getConversationId: () => boundConversationIdRef.current,
    onNewConversationId: (id) => {
      // #3068 — the agent minted a conversation id for the in-flight chat. Mark
      // it bound (and most-recently-requested) BEFORE writing the URL so the
      // URL-driven open effect treats it as already-loaded and never re-fetches
      // over the live stream. `replace` (not push) — this is a continuation of
      // the current empty chat. The mounted messages now belong to this id, so
      // it's the bound (transport) conversation too.
      openedConversationIdRef.current = id;
      latestRequestedConversationIdRef.current = id;
      boundConversationIdRef.current = id;
      setConversationId(id, "replace");
      setTimeout(() => {
        refreshConvosRef.current().catch((err: unknown) => {
          console.warn(
            "Sidebar refresh failed:",
            err instanceof Error ? err.message : String(err),
          );
        });
      }, 500);
    },
    // #2345 — forward the picker's selection on every chat request.
    // Refs inside `useAtlasTransport` snapshot these at fetch time so
    // a picker change mid-conversation reaches the agent on the very
    // next turn without rebuilding the transport.
    getConnectionId: () => scopeRef.current.connectionId,
    getConnectionGroupId: () => scopeRef.current.groupId,
    getRoutingMode: () => scopeRef.current.routingMode,
    // #3066 — forward the REST exclude-set on every turn (always, even []).
    getRestExcludedDatasourceIds: () => scopeRef.current.restExcludedDatasourceIds,
    // #3067 — forward the REST-only focus on every turn (always, even null) so
    // a clear actually nulls the row instead of inheriting the stale focus.
    getRestFocusDatasourceId: () => scopeRef.current.restFocusDatasourceId,
    // #3895 — forward the Group reach on every turn (always, even null) so a
    // widen back to All sources nulls the row instead of inheriting stale Focus.
    getGroupReach: () => scopeRef.current.groupReach,
    // #4302 — forward the picker's answer style (omitted when null — the
    // server inherits the row's stored style / applies the live default:
    // workspace default #4303, else surface default).
    getAnswerStyle: () => answerStyleRef.current,
    // #3749 / #4294 — onRunId: capture the active run id; it targets the
    // explicit stop endpoint (not a resume — a resume targets the bound
    // CONVERSATION, and the affordance only shows once a conversation is
    // mounted, so getResumeConversationId is non-null whenever resume fires).
    onRunId: (id) => {
      runIdRef.current = id;
    },
    getResumeConversationId: () => boundConversationIdRef.current,
  });

  const managedSession = authClient.useSession();
  const isManaged = authMode === "managed";
  const isSignedIn = isManaged && !!managedSession.data?.user;
  // #3044 — the active workspace, used to scope the persisted routing preference
  // so a different workspace (SaaS org switch / shared browser) can't seed a new
  // chat with this one's environment. `null` for self-hosted / no active org.
  const activeWorkspaceId = managedSession.data?.session?.activeOrganizationId ?? null;
  // #3064 — `activeWorkspaceId` is only final once the session has resolved.
  // For managed auth that means the session is no longer pending; self-hosted
  // has no session so it is always resolved (workspace id stays null). Gating
  // the seed on this stops a default seed from being committed while the
  // workspace id is still null-because-loading and then locked in.
  const sessionResolved =
    authResolved && (!isManaged || !managedSession.isPending);

  // #2345 — populate the env/member picker from the user-facing
  // `/api/v1/me/connection-groups` route. Fetched only once auth has
  // resolved; the picker hides itself when fewer than two members
  // are available, so the legacy single-connection deploy renders
  // the same header it always has.
  const envGroupsQuery = useChatEnvGroups({
    apiUrl,
    enabled: authResolved && isSignedIn,
    getHeaders,
    getCredentials,
  });

  // #4302 — the `showEnvPicker` header-row gate (#3081) that lived here is
  // gone: the header now renders unconditionally (see the JSX comment at the
  // <header> below).

  // #3883 — in developer mode, show the "no connections" empty state only when
  // the workspace has *zero* connections the chat can reach (SQL groups + REST
  // datasources), NOT when there are merely zero drafts. Dev mode resolves
  // published + draft connections, and this env-groups query already reflects
  // that superset — so keying off it (the same query the <ChatEnvPicker>
  // below consumes) stops a fully-published workspace from being wrongly
  // blocked. The previous `useDevModeNoDrafts(["connections"])` gate fired on
  // draft-count and showed a misleading "No connection configured" prompt.
  const showDevChatEmpty = shouldShowDevChatEmpty({ mode, ...envGroupsQuery });

  // #4189 — the conversation's scope (SQL group/member/mode + REST exclude/focus
  // + Group reach) and its sticky-preference seeding live in one owning hook. It
  // runs the fresh-chat seed/restore effect internally (the #3064 precedence:
  // wait for groups + preference + workspace id, restore a matching sticky
  // preference over the default seed, never clobber an explicit pick), owns the
  // three (value, provenance) axes, and persists picks back to the preference.
  const {
    scope,
    restore: restoreConversationScope,
    applySelection: applyScopeSelection,
    applyRestExcluded: applyScopeRestExcluded,
    applyRestFocus: applyScopeRestFocus,
    resetForNewChat: resetScopeForNewChat,
  } = useConversationScope({
    groups: envGroupsQuery.groups,
    groupsLoaded: envGroupsQuery.hasLoaded,
    activeWorkspaceId,
    sessionResolved,
  });
  // Mirror the latest scope into the ref the transport getters read at fetch
  // time (declared above the transport; see `scopeRef`). Assigning during render
  // is the same latest-value pattern as `refreshConvosRef` below.
  scopeRef.current = scope;

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
    // fire-and-forget: background fetch of the conversation list; the effect
    // doesn't await it and errors are handled inside the hook.
    void convos.fetchList();
  }, [authMode, convos.fetchList]);

  // Check if managed auth user needs to change their default password.
  // Shared with AdminLayout — TanStack deduplicates to a single request.
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";
  const { data: passwordData } = usePasswordStatus(isManaged && !!managedSession.data?.user);

  // Python streaming progress — keyed by tool invocation ID
  const [pythonProgress, setPythonProgress] = useState<Map<string, PythonProgressData[]>>(new Map());

  // The warnings hook must be called after `useChat` so it can observe
  // `messages` and drain pending frames onto the latest assistant id.
  // We route `onData` (captured stably by `useChat`) through a ref so
  // the hook's `handleData` reference can change between renders without
  // forcing `useChat` to rebuild its transport. The first frame an SDK
  // delivers should never arrive before commit (frames are emitted on a
  // microtask after `sendMessage`), but we log if it does so the
  // theoretical race becomes audible instead of silently dropping.
  const warningHandlerRef = useRef<((part: { type: string; data: unknown }) => boolean) | null>(
    null,
  );

  const onData = useCallback(
    (dataPart: { type: string; id?: string; data: unknown }) => {
      if (warningHandlerRef.current) {
        if (warningHandlerRef.current(dataPart)) return;
      } else if (dataPart.type === "data-context-warning") {
        console.warn(
          "[atlas-chat] data-context-warning arrived before warnings hook initialized; dropping",
          dataPart,
        );
        return;
      }
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
    },
    [],
  );

  // The AI SDK's onData expects DataUIPart<UIDataTypes> which structurally accepts
  // { type: `data-${string}`; id?: string; data: unknown } — our callback matches.
  // The cast is needed because the default UIMessage generic doesn't declare our custom
  // data part type at compile time.
  const { messages, setMessages, sendMessage, regenerate, status, error, stop } = useChat({
    transport,
    onData: onData as never,
  });

  const warningCtl = useContextWarnings(messages);
  const contextWarningsByMessage = warningCtl.byMessage;
  // Wire the hook's stable handler into the onData ref AFTER commit.
  // Mutating a ref during render is a React anti-pattern (the render
  // can be discarded under concurrent rendering, leaving the ref stale).
  useEffect(() => {
    warningHandlerRef.current = warningCtl.handleData;
  }, [warningCtl.handleData]);

  const isLoading = status === "streaming" || status === "submitted";

  // #3749 — auto-resume hook seam. `useRunStatus` (below) must call the resume
  // handler when a poll sees a parked turn re-armed to `running`, but the handler
  // is produced AFTER it (it depends on `runStatusCtl`). A ref breaks the cycle:
  // `useRunStatus` fires this stable wrapper, which dispatches to the latest
  // `handleResume` (kept current by the effect below it).
  const handleResumeRef = useRef<() => void>(() => {});
  const handleParkedResolved = useCallback(() => handleResumeRef.current(), []);

  // #3749 — durable run status for the open conversation. Fetched once its
  // history has committed (not mid-load) so the affordance reflects the mounted
  // thread, and only for a signed-in managed session (self-hosted/no-DB returns
  // `none` and renders nothing anyway). Drives the resume / waiting-on-approval
  // banner below the message thread. While parked it polls for the server's
  // approval-park re-arm and auto-resumes on the parked→running flip (AC3).
  const runStatusCtl = useRunStatus({
    apiUrl,
    getHeaders,
    getCredentials,
    conversationId: loadingConversation ? null : conversationId,
    enabled: authResolved && isSignedIn,
    onParkedResolved: handleParkedResolved,
  });

  // #3749 — resume orchestration lives in `useResumeHandler` (unit-tested): the
  // re-entrancy guard, the `regenerate`-with-marker call (no phantom user
  // message), the optimistic banner clear, and the refetch-on-settle that clears
  // a completed resume / restores a still-resumable affordance on failure.
  const { resuming, resume: handleResume } = useResumeHandler({
    regenerate,
    clearRunStatus: runStatusCtl.clear,
    refetchRunStatus: runStatusCtl.refetch,
    isLoading,
    resetPendingWarnings: warningCtl.resetPending,
    // #4297 — fires only when a resume actually begins (after the hook's
    // re-entrancy guard), so a guarded no-op click can never erase the banner
    // without retrying. Kind-scoped because auto-resume is machine-initiated:
    // it must not clear an unrelated failure the user hasn't seen.
    onStart: () => {
      failures.clearKind("resume");
    },
    onError: (message, detail) => {
      // #4297 — a failed resume is a real failure: persistent banner, not a
      // fading whisper. Retry through the ref — this callback is constructed
      // before `handleResume` exists (same seam as `handleParkedResolved`).
      failures.report({
        kind: "resume",
        title: message,
        detail,
        retry: () => {
          handleResumeRef.current();
        },
      });
    },
  });
  // #4294 — the Stop control's orchestration lives in `useStopHandler`
  // (unit-tested): client abort first (composer unlocks immediately), then a
  // fire-and-forget server-side stop against the run id captured from the
  // `x-run-id` header so generation stops consuming tokens too.
  const { stopTurn } = useStopHandler({
    stop,
    getRunId: () => runIdRef.current,
    apiUrl,
    getHeaders,
    getCredentials,
  });

  // Point the auto-resume seam at the freshly-built handler (see the ref above).
  // In an effect, not during render: a render the React scheduler discards must
  // not leave the ref pointing at a stale `handleResume` (the same concurrent-
  // rendering guard the `warningHandlerRef` seam uses above).
  useEffect(() => {
    handleResumeRef.current = handleResume;
  }, [handleResume]);

  // Adaptive empty-chat starter surface — backend composes the ranked
  // prompt list from favorites / popular / library tiers. TanStack Query
  // handles 4xx/5xx fallback (5xx soft-fails to []).
  const queryClient = useQueryClient();
  const starterPromptsQueryKey = ["atlas", "starter-prompts", apiUrl] as const;
  const starterPromptsQuery = useStarterPromptsQuery({
    apiUrl,
    isCrossOrigin,
    getHeaders,
    enabled: messages.length === 0 && authResolved,
  });
  const starterPrompts = starterPromptsQuery.data ?? [];

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
      credentials,
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
  }, [messages.length, isLoading, apiUrl, credentials, getHeaders]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    if (isNearBottom) el.scrollTop = el.scrollHeight;
  }, [messages, status]);

  async function handlePin(text: string) {
    if (!text.trim()) return;
    // A fresh attempt supersedes any earlier failure banner (#4297).
    failures.supersede();
    setPinningText(text);
    try {
      const res = await fetch(`${apiUrl}/api/v1/starter-prompts/favorites`, {
        method: "POST",
        credentials,
        headers: { "Content-Type": "application/json", ...getHeaders() },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        const body = (await res
          .json()
          // intentionally ignored: non-JSON error body — status/statusText logged below
          .catch(() => ({}))) as {
          error?: string;
          message?: string;
          requestId?: string;
        };
        if (res.status === 409) {
          // Duplicate: the pin already exists server-side, so our cache
          // is stale. Invalidate so the next empty-state render refetches
          // the authoritative list.
          console.warn("pin duplicate:", body.requestId);
          await queryClient.invalidateQueries({ queryKey: starterPromptsQueryKey });
          showTransientNotice("Already pinned — it'll show up in a new chat.", 4000);
          return;
        }
        // Narrow at the seam: the cast above is unvalidated, and these values
        // render as JSX outside the transcript's ErrorBoundary — a non-string
        // (proxy error page, envelope drift) must not take down the surface.
        const detail = typeof body.message === "string" ? body.message : undefined;
        const requestId = typeof body.requestId === "string" ? body.requestId : undefined;
        console.warn(
          "pin failed:",
          res.status,
          res.statusText,
          requestId ?? "(no requestId — non-JSON body)",
          detail,
        );
        failures.report({
          kind: "pin",
          title: "Couldn't pin starter prompt",
          detail,
          requestId,
          retry: () => {
            void handlePin(text);
          },
        });
        return;
      }
      const body = (await res.json()) as {
        favorite: { id: string; text: string; position: number };
      };
      // Optimistic insert: prepend favorite at the top of the empty-state
      // grid so the user sees it immediately without a refetch. The next
      // empty-state re-entry reconciles via the hook's own refetch
      // semantics.
      queryClient.setQueryData<StarterPrompt[]>(starterPromptsQueryKey, (prev) => {
        const base = prev ?? [];
        return [
          {
            id: `favorite:${body.favorite.id}`,
            text: body.favorite.text,
            provenance: "favorite",
          },
          ...base.filter((p) => !(p.provenance === "favorite" && p.text === body.favorite.text)),
        ];
      });
      showTransientNotice("Pinned as starter prompt.", 3000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("pin request failed:", msg);
      failures.report({
        kind: "pin",
        title: "Couldn't pin starter prompt",
        retry: () => {
          void handlePin(text);
        },
      });
    } finally {
      setPinningText(null);
    }
  }

  async function handleUnpin(favoriteId: string) {
    // Strip the "favorite:" namespace the resolver prepends — tiers can
    // share raw UUID space so the wire id is prefixed for React keys,
    // but the DELETE endpoint takes the unprefixed DB id.
    const raw = favoriteId.startsWith("favorite:")
      ? favoriteId.slice("favorite:".length)
      : favoriteId;
    // A fresh attempt supersedes any earlier failure banner (#4297).
    failures.supersede();
    try {
      const res = await fetch(
        `${apiUrl}/api/v1/starter-prompts/favorites/${encodeURIComponent(raw)}`,
        {
          method: "DELETE",
          credentials,
          headers: getHeaders(),
        },
      );
      if (!res.ok && res.status !== 404) {
        // 404 is fine — the pin is gone either way.
        const body = (await res
          .json()
          // intentionally ignored: non-JSON error body — status/statusText logged below
          .catch(() => ({}))) as {
          requestId?: string;
          message?: string;
        };
        // Same seam-narrowing as the pin path — see the comment there.
        const detail = typeof body.message === "string" ? body.message : undefined;
        const requestId = typeof body.requestId === "string" ? body.requestId : undefined;
        console.warn(
          "unpin failed:",
          res.status,
          res.statusText,
          requestId ?? "(no requestId — non-JSON body)",
          detail,
        );
        failures.report({
          kind: "unpin",
          title: "Couldn't unpin starter prompt",
          detail,
          requestId,
          retry: () => {
            void handleUnpin(favoriteId);
          },
        });
        return;
      }
      queryClient.setQueryData<StarterPrompt[]>(starterPromptsQueryKey, (prev) =>
        (prev ?? []).filter((p) => p.id !== favoriteId),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("unpin request failed:", msg);
      failures.report({
        kind: "unpin",
        title: "Couldn't unpin starter prompt",
        retry: () => {
          void handleUnpin(favoriteId);
        },
      });
    }
  }

  function handleSend(text: string) {
    if (!text.trim()) return;
    // #3068 — don't send while a conversation's history is still loading (a deep
    // link / sidebar open). Sending now would either append to the half-loaded
    // conversation or be clobbered when the in-flight load commits. The composer
    // is disabled too; this also guards the chip / starter-prompt send paths.
    if (loadingConversation) return;
    // #4297 — the composer is stream-disabled, but the failure banner's
    // "Try again" is not: a retry clicked mid-stream must not erase the
    // banner, null the live run's id (degrading Stop to client-only), or
    // race a second stream. Guard BEFORE the clear, like every other path.
    if (isLoading) return;
    // A fresh attempt supersedes any earlier failure banner (#4297).
    failures.supersede();
    const saved = text;
    setInput("");
    // Drop any unattached warnings from a stalled earlier turn so they
    // cannot end up keyed onto the upcoming assistant message.
    warningCtl.resetPending();
    // #4294 — clear the previous turn's run id so a Stop in the pre-header
    // sliver of THIS turn is a client-only stop, never a POST against the
    // prior (already settled) run.
    runIdRef.current = null;
    sendMessage({ text: saved }).catch((err: unknown) => {
      console.error("Failed to send message:", err instanceof Error ? err.message : String(err));
      setInput(saved);
      failures.report({
        kind: "send",
        title: "Message failed to send",
        detail: "Your message was put back in the composer.",
        // Safe only while the draft is untouched: editing the restored text
        // clears this failure (see the composer's onValueChange), so a stale
        // "Try again" can never clobber an edit with the original text.
        // Through the ref so the retry evaluates the CURRENT render's guards —
        // a closure-captured handleSend would freeze isLoading /
        // loadingConversation at the failing render's (false) values, making
        // the guards above no-ops on exactly this path.
        retry: () => handleSendRef.current(saved),
      });
    });
  }
  // Latest-value ref for the banner retry above — the same render-phase
  // assignment pattern as handleSelectConversationRef below.
  const handleSendRef = useRef(handleSend);
  handleSendRef.current = handleSend;

  function handleSuggestionSelect(text: string, id: string) {
    fetch(`${apiUrl}/api/v1/suggestions/${id}/click`, {
      method: "POST",
      credentials,
      headers: getHeaders(),
    }).catch(() => {
      // intentionally ignored: click tracking is non-critical
    });
    handleSend(text);
  }

  async function handleSelectConversation(id: string) {
    // #3068 — record the requested conversation and reflect it in the URL up
    // front, BEFORE the in-flight guard, so a navigation that arrives mid-load
    // (a sidebar click or browser back/forward while another conversation is
    // still loading) is never lost and the URL always shows what the user last
    // asked for. The post-await stale check below reads this ref.
    latestRequestedConversationIdRef.current = id;
    setConversationId(id);
    // A load is already in flight; bail. The URL effect re-drives this once the
    // in-flight load settles (`loadingConversation` is one of its deps), and the
    // stale check below stops that in-flight load from committing over this one.
    if (loadingConversation) return;
    // A fresh attempt supersedes any earlier failure banner (#4297).
    failures.supersede();
    // Mark bound for the open effect's dedup once we actually begin loading: a
    // redundant dispatch is then a no-op, and a load that fails below isn't
    // retried on every render.
    openedConversationIdRef.current = id;
    setLoadingConversation(true);
    try {
      // #3065 — fetch the full row (not just the messages) so the
      // conversation's own scope can be restored into the picker. One fetch
      // covers both: `getConversationData` returns the same payload
      // `loadConversation` transforms, plus the persisted scope columns.
      const data = await convos.getConversationData(id);
      // #3068 — the user navigated away while this was fetching: discard the
      // stale result instead of committing the wrong conversation over the newer
      // navigation (which would also flip the URL back to this id). The URL
      // effect loads whatever the latest `?id=` now points at. Reset the dedup
      // ref to the still-mounted conversation first: this load never committed,
      // so leaving `openedConversationIdRef` on `id` would let a later back-nav
      // to `id` be skipped (urlId === loadedId → noop) and show stale content.
      if (latestRequestedConversationIdRef.current !== id) {
        openedConversationIdRef.current = boundConversationIdRef.current;
        return;
      }
      // A 200 with a malformed body (no `messages` array) would otherwise
      // throw a bare TypeError inside `transformMessages` and surface as a
      // generic "try again" — distinguish the structural defect in the log.
      if (!Array.isArray(data.messages)) {
        throw new Error(
          `Conversation ${id} returned no messages array (got ${typeof data.messages})`,
        );
      }
      setMessages(transformMessages(data.messages));
      // The conversation's history is now mounted — bind the transport to it so
      // the next turn appends here (with full context), not to a fresh chat.
      boundConversationIdRef.current = id;
      convos.setSelectedId(id);
      // Restore the conversation's persisted scope, validated against the
      // currently-visible env groups (#3065 / #3078 / #3895). The hook owns the
      // per-axis restore-vs-seed precedence (row > sticky preference > default
      // seed) and the (value, provenance) bookkeeping — REST scope + Group reach
      // are always restored from the row and made authoritative regardless of the
      // SQL decision, while an all-null SQL scope defers to the seed effect.
      restoreConversationScope(data, envGroupsQuery.groups);
      // #4302 — restore the conversation's persisted answer style alongside
      // its scope (null = no explicit choice → the picker shows the default).
      // Guarded like the server's own read seam (rowToConversation): the GET
      // is a typed cast, not runtime validation, so a version-skewed API
      // sending a style this bundle doesn't know must degrade to the default
      // — knowingly, with a breadcrumb — rather than commit a value the
      // picker can't display: it would be silently re-sent every turn, and
      // 422-loop if the echo lands on an older instance mid-deploy.
      const restoredStyle = data.answerStyle ?? null;
      const knownStyle = isKnownAnswerStyle(restoredStyle) ? restoredStyle : null;
      if (restoredStyle !== null && knownStyle === null) {
        console.debug(
          `Unknown answerStyle "${String(restoredStyle)}" on conversation ${id} — showing the default`,
        );
      }
      setAnswerStyle(knownStyle);
      setMobileSidebarOpen(false);
      // Loaded turns predate this session — no warning frames replay over
      // the wire, so any prior in-memory bucket is stale relative to the
      // freshly loaded message ids.
      warningCtl.reset();
    } catch (err: unknown) {
      console.warn("Failed to load conversation:", err instanceof Error ? err.message : String(err));
      failures.report({
        kind: "load",
        title: "Couldn't load the conversation",
        // Retry through the ref so a later attempt uses the freshest handler
        // (this closure would otherwise pin the env groups it saw at failure).
        retry: () => {
          void handleSelectConversationRef.current(id);
        },
      });
      // #3068 — the open failed and never committed. Reset the dedup ref to the
      // still-mounted conversation so the failed id isn't treated as loaded. If
      // no newer navigation superseded this attempt, roll the URL + requested id
      // back to the mounted conversation too, so the URL, the displayed thread,
      // and the transport id stay consistent (and the URL effect doesn't loop
      // retrying the failed id). A newer navigation is left for the effect to
      // open once `loadingConversation` clears.
      openedConversationIdRef.current = boundConversationIdRef.current;
      if (latestRequestedConversationIdRef.current === id) {
        latestRequestedConversationIdRef.current = boundConversationIdRef.current;
        setConversationId(boundConversationIdRef.current);
      }
    } finally {
      setLoadingConversation(false);
    }
  }

  function handleNewChat() {
    setMessages([]);
    // #4297 — a fresh chat supersedes any failure banner (e.g. a "Couldn't
    // load the conversation" whose retry targets the just-abandoned id).
    failures.supersede();
    // #3068 — clear the bound + most-recently-requested refs and the URL
    // (`?id=`) so the open effect re-seeds a fresh chat instead of treating the
    // just-left conversation as still loaded. Clearing the requested ref also
    // makes any conversation load still in flight bail instead of committing
    // over this new chat. The transport is unbound so the next turn starts a
    // fresh conversation.
    openedConversationIdRef.current = null;
    latestRequestedConversationIdRef.current = null;
    boundConversationIdRef.current = null;
    setConversationId(null);
    convos.setSelectedId(null);
    setInput("");
    setMobileSidebarOpen(false);
    setPythonProgress(new Map());
    warningCtl.reset();
    // #3065 — a new chat is not bound to any conversation's scope. Reset every
    // axis (value + provenance) to `unset` so the hook's seed/restore effect
    // re-runs from scratch — seeding from the sticky preference (or the default),
    // exactly as on a fresh page load. Without this, a just-opened conversation's
    // `explicit` scope would carry into the new chat and the effect would no-op.
    resetScopeForNewChat();
    // #4302 — a new chat starts at the default voice (AC: "new conversations
    // use the default"); the just-left conversation's style must not carry.
    setAnswerStyle(null);
  }

  // #3068 — the single bridge from URL → conversation state. A deep link / page
  // reload, a sidebar select (which writes the URL), and browser back/forward
  // all flow through here: open the conversation named in `?id=` (restoring its
  // scope via handleSelectConversation → #3065) or, when the id clears while one
  // is loaded, reset to a fresh chat. The decision (including the self-hosted
  // carve-out that must NOT wait on a groups fetch that never runs) lives in the
  // unit-tested `resolveConversationUrlAction`. handleSelectConversation /
  // handleNewChat are recreated each render, so reach them through refs (as
  // refreshConvosRef does) to keep the effect deps minimal.
  const handleSelectConversationRef = useRef(handleSelectConversation);
  handleSelectConversationRef.current = handleSelectConversation;
  const handleNewChatRef = useRef(handleNewChat);
  handleNewChatRef.current = handleNewChat;
  useEffect(() => {
    const action = resolveConversationUrlAction({
      urlId: chatUrlParams.id,
      loadedId: openedConversationIdRef.current,
      // sessionResolved (not authResolved) — for managed auth, isSignedIn isn't
      // final until the session resolves; opening before then would misread a
      // signed-in user as self-hosted and skip the wait-for-groups gate. Also
      // require the simple-key credential to be present, else the deep-link
      // fetch goes out without an Authorization header and 401s; entering the
      // key later re-drives this effect via the `apiKey` dep (#3068).
      authSettled:
        sessionResolved && (authMode !== "simple-key" || !!apiKey),
      isSignedIn,
      envGroupsHasLoaded: envGroupsQuery.hasLoaded,
    });
    switch (action.kind) {
      case "open":
        void handleSelectConversationRef.current(action.id);
        break;
      case "clear":
        handleNewChatRef.current();
        break;
      case "noop":
        // Inputs not ready, already bound, or waiting on the groups fetch.
        break;
      default: {
        // Exhaustiveness guard — a new ConversationUrlAction variant must add a
        // branch (same `never`-checked pattern as the scope hook's decision consumers).
        const _exhaustive: never = action;
        void _exhaustive;
      }
    }
    // `loadingConversation` is a dep so a navigation that arrives mid-load (e.g.
    // browser back/forward to B while A is still loading) isn't silently dropped
    // by handleSelectConversation's in-flight guard: when the A-load settles and
    // the flag clears, this re-evaluates and opens B — otherwise the URL would
    // say `?id=B` while A stays on screen, desynced until the next navigation.
    // authMode + apiKey: a simple-key deep link must wait for the key to hydrate
    // (above), and entering it later must re-drive the open.
  }, [chatUrlParams.id, sessionResolved, isSignedIn, envGroupsQuery.hasLoaded, loadingConversation, authMode, apiKey]);

  // `?prompt=` deep-link prefill. The hosted `WorkspaceShell` delivers a query
  // through this param (`deliverPrompt`) when the user picks from the prompt
  // library / schema explorer, and /wizard's Done step + /signup/success
  // starters use it too. Key on the dispatched value (not a once-per-mount flag)
  // so a second delivery of the same text re-fires — this surface stays mounted
  // across sibling navigations. Prefill only (no auto-submit; that would race
  // transport readiness); clearing only `prompt` leaves `?id=` intact since nuqs
  // merges keys. Standalone (scaffold/demo) has no shell, so `prompt` stays "".
  const lastPrefilledRef = useRef<string | null>(null);
  useEffect(() => {
    const text = chatUrlParams.prompt;
    if (!text) return;
    if (text === lastPrefilledRef.current) return;
    lastPrefilledRef.current = text;
    setInput(text);
    void setChatUrlParams({ prompt: "" }).catch((err: unknown) => {
      console.warn(
        "[atlas-chat] failed to clear prompt param:",
        err instanceof Error ? err.message : String(err),
      );
    });
  }, [chatUrlParams.prompt, setChatUrlParams]);

  // Wait for auth mode detection before rendering — prevents flash of chat UI
  // when managed auth is active but session hasn't been checked yet.
  if (!authResolved || (isManaged && managedSession.isPending)) {
    return (
      <div className="flex h-dvh items-center justify-center bg-white dark:bg-zinc-950" />
    );
  }

  // #3081 — in `embedded` mode the host shell already provides the page's single
  // <main id="main"> landmark (its <SidebarInset> renders a <main>), so render a
  // plain <div> here to avoid nesting a second <main> — duplicate main landmarks
  // make skip-to-content + screen-reader landmark navigation ambiguous.
  // Standalone owns the only <main>.
  const ChatRegion = embedded ? "div" : "main";

  return (
    <>
      {/* `embedded` fills the host shell's <SidebarInset> (h-full/flex-1)
          instead of claiming the viewport (h-dvh). The inner region also drops
          its <main>/`id="main"` in embedded mode — see `ChatRegion` above. */}
      <div className={embedded ? "flex min-h-0 flex-1" : "flex h-dvh"}>
        {!embedded && convos.available && (
          <ConversationSidebar
            conversations={convos.conversations}
            selectedId={convos.selectedId}
            loading={convos.loading}
            onSelect={handleSelectConversation}
            onDelete={(id) => convos.deleteConversation(id)}
            onStar={(id, starred) => convos.starConversation(id, starred)}
            onNewChat={handleNewChat}
          />
        )}

        <ChatRegion
          id={embedded ? undefined : "main"}
          tabIndex={embedded ? undefined : -1}
          className="flex flex-1 flex-col overflow-hidden"
        >
          <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col overflow-hidden p-4">
            {/* In `embedded` mode the host shell owns the app-identity header
                (logo, theme, user menu) + the sidebar/modals, so collapse this
                header to just the pickers. #4302 — the header row renders
                unconditionally now: the answer-style picker applies to every
                workspace (every conversation has a voice), so even a legacy
                1×1 whose env-picker hides itself no longer collapses the row
                (the PRD's open question, resolved). The env-picker below
                self-gates via `shouldRenderEnvPicker` internally. */}
            <header className="mb-4 flex-none border-b border-zinc-100 pb-3 dark:border-zinc-800">
              <div className="flex items-center justify-between gap-2">
                {!embedded && (
                <div className="flex items-center gap-3">
                  {convos.available && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setMobileSidebarOpen(true)}
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
                )}
                <div className="flex items-center gap-2">
                  {/* #2345 — env/member picker. Hides itself when only
                      one member is configured (legacy single-connection
                      deploy) so the header is byte-identical pre-1.4.4. */}
                  <ChatEnvPicker
                    groups={envGroupsQuery.groups}
                    emptyReason={envGroupsQuery.reason}
                    transportError={envGroupsQuery.error}
                    activeGroupId={scope.groupId}
                    activeConnectionId={scope.connectionId}
                    activeRoutingMode={scope.routingMode}
                    activeGroupReach={scope.groupReach}
                    restDatasources={envGroupsQuery.restDatasources}
                    restExcludedDatasourceIds={scope.restExcludedDatasourceIds}
                    // #3066 — a scope toggle is a deliberate pick: the hook marks
                    // it explicit (so the seed/restore effect can't re-seed over
                    // it) and persists it back to the sticky preference so new
                    // chats inherit it. The full next set (incl. []) is verbatim.
                    onRestExcludedChange={applyScopeRestExcluded}
                    restFocusDatasourceId={scope.restFocusDatasourceId}
                    // #3067 — focusing / clearing is a deliberate pick; `null`
                    // clears focus (re-enables SQL). The hook persists it.
                    onRestFocusChange={applyScopeRestFocus}
                    // #3064 / #3895 — a user pick (group / member / mode / reach)
                    // is authoritative; the hook marks it explicit and persists it.
                    onSelect={applyScopeSelection}
                  />
                  {/* #4302 — per-conversation answer style. Always renders
                      (every conversation has a voice), which is what keeps
                      this header row populated on a legacy 1×1 workspace
                      where the env-picker above hides itself. A pick takes
                      effect on the next turn and persists onto the row. */}
                  <AnswerStylePicker value={answerStyle} onChange={setAnswerStyle} />
                  {!embedded && (
                  <>
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
                  {/* #3758 — view + reset this conversation's durable working
                      memory. Only once the conversation is persisted (has an
                      id); a brand-new chat has nothing remembered yet. */}
                  {conversationId && (
                    <ConversationMemoryControl
                      conversationId={conversationId}
                      className="size-11 sm:size-8 text-zinc-500 dark:text-zinc-400"
                    />
                  )}
                  <ThemeToggle className="size-11 sm:size-8 text-zinc-500 dark:text-zinc-400" />
                  {isSignedIn && <UserMenu />}
                  </>
                  )}
                </div>
              </div>
            </header>

            {/* #4297 — the quiet line is for informational transients ONLY
                (pin success / already-pinned). Failures render as structured
                banners and never auto-dismiss unseen. */}
            {transientNotice && (
              <p role="status" className="mb-2 text-xs text-zinc-500 dark:text-zinc-400">
                {transientNotice}
              </p>
            )}
            {healthWarning && (
              <ActionErrorBanner
                failure={{ title: "Connection problem", detail: healthWarning }}
              />
            )}
            {convos.fetchError && (
              <ActionErrorBanner
                failure={{
                  title: "Couldn't load conversation history",
                  detail: convos.fetchError,
                  retry: () => {
                    convos.fetchList().catch((err: unknown) => {
                      // The failure re-surfaces via `convos.fetchError`; log for correlation.
                      console.warn(
                        "Conversation list refetch failed:",
                        err instanceof Error ? err.message : String(err),
                      );
                    });
                  },
                }}
              />
            )}

            {isManaged && !isSignedIn ? (
              null /* proxy redirects unauthenticated users to /signup */
            ) : (
              <>
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
                {/* #4322 — expose the conversation id to CreateDashboardCard's
                    handoff link (deeply nested under AgentTurn/ToolPart) so the
                    bound drawer resumes THIS conversation on "Continue editing". */}
                <ChatConversationProvider conversationId={conversationId}>
                <div className="space-y-4 pb-4 pr-3">
                  {messages.length === 0 && !error && (
                    // #3081 — host-gated "connect data" empty state takes
                    // precedence: a zero-table workspace funnels into setup
                    // before the agent can run and fail confusingly. Gated on
                    // `showDataSetupGate` (needs both the flag and an override).
                    showDataSetupGate ? (
                      emptyStateOverride
                    ) : showDevChatEmpty ? (
                      <DeveloperChatEmptyState />
                    ) : (
                    <div
                      className="flex h-full flex-col items-center justify-center gap-6"
                      data-testid="chat-empty-state"
                    >
                      {/* #4297 — one value proposition across the surface: this
                          heading and the standalone header tagline share the
                          brand phrasing (www hero / metadata) verbatim. */}
                      <div className="text-center">
                        <p className="text-lg font-medium text-zinc-500 dark:text-zinc-400">
                          Ask your data anything
                        </p>
                        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-500">
                          Start with a question about your data
                        </p>
                      </div>
                      <StarterPromptList
                        prompts={starterPrompts}
                        onSelect={handleSend}
                        onUnpin={(id) => { void handleUnpin(id); }}
                        isLoading={starterPromptsQuery.isLoading}
                      />
                      <Button
                        variant="link"
                        onClick={() => setPromptLibraryOpen(true)}
                        className="text-xs text-zinc-400 dark:text-zinc-500"
                      >
                        <BookOpen className="mr-1.5 size-3.5" />
                        Browse prompt library
                      </Button>
                    </div>
                    )
                  )}

                  {messages.map((m, msgIndex) => {
                    if (m.role === "user") {
                      const userText = m.parts
                        ?.filter((p): p is { type: "text"; text: string } => p.type === "text")
                        .map((p) => p.text)
                        .join("\n")
                        .trim() ?? "";
                      const canPin = userText.length > 0;
                      const pinDisabled = pinningText === userText;
                      return (
                        <div key={m.id} className="group flex justify-end" role="article" aria-label="Message from you">
                          <div className="flex items-start gap-1.5">
                            {canPin && (
                              <button
                                type="button"
                                onClick={() => { void handlePin(userText); }}
                                disabled={pinDisabled}
                                className="mt-1.5 rounded-md p-1.5 text-zinc-400 opacity-0 transition-opacity hover:bg-zinc-100 hover:text-primary focus-visible:opacity-100 group-hover:opacity-100 disabled:pointer-events-none dark:hover:bg-zinc-800"
                                aria-label="Pin as starter prompt"
                                data-testid="pin-user-message"
                              >
                                <Pin className="size-3.5" />
                              </button>
                            )}
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
                        </div>
                      );
                    }

                    const isLastAssistant =
                      m.role === "assistant" &&
                      msgIndex === messages.length - 1;

                    // #4298 / #4300 — every assistant turn renders through the
                    // one lifecycle-aware AgentTurn: the actively-streaming
                    // turn gets the live working feed → settles into the
                    // receipt as the answer streams; completed turns render
                    // answer-first (receipt → answer → promoted artifact).
                    // Keeping the component identity stable across the flip
                    // preserves receipt/card state at stream end.
                    const isStreamingTurn = isLastAssistant && isLoading;

                    // Skip rendering assistant messages with no visible content
                    // (happens when stream errors before producing any text).
                    // A message with attached context warnings is still
                    // worth rendering — the banner is the only signal the
                    // user gets when a degraded stream produced nothing.
                    const hasVisibleParts = m.parts?.some(
                      (p) => (p.type === "text" && p.text.trim()) || isToolUIPart(p),
                    );
                    const warningBucket = contextWarningsByMessage.get(m.id);
                    const hasWarnings = !!warningBucket && warningBucket.warnings.length > 0;
                    if (!hasVisibleParts && !isLastAssistant && !hasWarnings) return null;

                    // Extract suggestions from the last text part that contains them
                    const lastTextWithSuggestions = m.parts
                      ?.filter((p): p is typeof p & { type: "text"; text: string } => p.type === "text" && !!p.text.trim())
                      .findLast((p) => parseSuggestions(p.text).suggestions.length > 0);
                    const suggestions = lastTextWithSuggestions
                      ? parseSuggestions(lastTextWithSuggestions.text).suggestions
                      : [];

                    return (
                      <div key={m.id} className="space-y-2" role="article" aria-label="Message from Atlas">
                        {hasWarnings && warningBucket && (
                          <ContextWarningBanner warnings={warningBucket.warnings} />
                        )}
                        <AgentTurn
                          parts={m.parts}
                          pythonProgress={pythonProgress}
                          streaming={isStreamingTurn}
                        />
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
                            {/* #3068 — hide Save/Share while a conversation
                                load is pending: `conversationId` is the URL id,
                                which already points at the conversation being
                                opened while the previous thread is still
                                displayed, so acting on it would star/share the
                                wrong conversation. Once the load commits (or
                                rolls back on failure) the URL id matches the
                                mounted thread again. */}
                            {conversationId && !loadingConversation && convos.available && (
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

                  {/* #4300 — the working phase begins at send, not at first
                      stream part: until the assistant message mounts, a
                      standalone activity container holds the spot the
                      streaming turn's feed then takes over — same component,
                      same position, so it reads as one element ticking. No
                      message-count gate: the very first send shows it too. */}
                  {showPreStreamActivity(isLoading, messages[messages.length - 1]?.role) && (
                    <WorkingActivity parts={NO_PARTS} />
                  )}
                </div>
                </ChatConversationProvider>
                </ErrorBoundary>
                </ScrollArea>

                {/* #4297 — failed action (send / load / pin / unpin / resume).
                    Composer-adjacent so it sits where the user is looking
                    after acting; persistent until retried, superseded, or
                    dismissed. Distinct from the ErrorBanner below, which owns
                    errors from the chat turn itself (request + stream failures
                    surfaced by useChat). */}
                {failures.failure && (
                  <ActionErrorBanner
                    failure={failures.failure}
                    onDismiss={failures.dismiss}
                  />
                )}

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

                {/* #3749 — durability affordance: an interrupted turn offers a
                    one-click Resume; a parked turn shows a waiting-on-approval
                    state. Suppressed while an error banner is up (the error path
                    owns recovery then) and on a fresh chat (no run to resume). */}
                {!error && !loadingConversation && (
                  <ResumeBanner
                    runStatus={runStatusCtl.runStatus}
                    onResume={handleResume}
                    resuming={resuming}
                  />
                )}

                {/* #3081 — hide the composer on a zero-table workspace's empty
                    thread (emptyStateOverride shows above) so the user connects
                    data before the agent runs. Same `showDataSetupGate` as the
                    empty state above, so the two never disagree (composer hidden
                    ⇔ override shown). */}
                {!(showDataSetupGate && messages.length === 0) && (
                  <ChatComposer
                    value={input}
                    onValueChange={(v) => {
                      setInput(v);
                      // #4297 — editing the restored draft makes the composer
                      // the retry vehicle; clearing here keeps the banner's
                      // stale "Try again" (which resends the ORIGINAL text)
                      // from clobbering the edit. Send-kind only — typing must
                      // not dismiss an unrelated pin/load/resume failure.
                      failures.clearKind("send");
                    }}
                    onSend={handleSend}
                    streaming={isLoading}
                    loadingConversation={loadingConversation}
                    onStop={stopTurn}
                  />
                )}
              </>
            )}
          </div>
        </ChatRegion>
      </div>
      {/* In `embedded` mode the host shell mounts its own SchemaExplorer /
          PromptLibrary against the shared UI store, so suppress this component's
          copies to avoid a double mount; ChangePasswordDialog isn't part of the
          hosted chat. */}
      {!embedded && (
        <>
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
            open={
              !passwordDialogDismissed &&
              passwordData?.kind === "allowed" &&
              passwordData.passwordChangeRequired
            }
            onComplete={() => setPasswordDialogDismissed(true)}
          />
        </>
      )}
    </>
  );
}
