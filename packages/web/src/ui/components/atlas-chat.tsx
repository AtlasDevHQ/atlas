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
import { ErrorBanner } from "./chat/error-banner";
import { ContextWarningBanner } from "./chat/context-warning-banner";
import { ResumeBanner } from "./chat/resume-banner";
import { useRunStatus } from "../hooks/use-run-status";
import { useResumeHandler } from "../hooks/use-resume-handler";
import { ApiKeyBar } from "./chat/api-key-bar";
import { TypingIndicator } from "./chat/typing-indicator";
import { ToolPart } from "./chat/tool-part";
import { Markdown } from "./chat/markdown";
import { FollowUpChips } from "./chat/follow-up-chips";
import { SuggestionChips } from "./chat/suggestion-chips";
import { DeveloperChatEmptyState } from "./chat/developer-empty-state";
import {
  ChatEnvPicker,
  shouldRenderEnvPicker,
  resolveConversationScope,
  resolveEnvSelection,
  useChatEnvGroups,
  type ConversationRoutingMode,
  type EnvSelectionProvenance,
} from "./chat/env-picker";
import { useDevModeNoDrafts } from "../hooks/use-dev-mode-no-drafts";
import type { QuerySuggestion } from "@/ui/lib/types";
import { ShareDialog } from "./chat/share-dialog";
import { ConversationSidebar } from "./conversations/conversation-sidebar";
import { ChangePasswordDialog } from "./admin/change-password-dialog";
import { usePasswordStatus } from "@/ui/hooks/use-password-status";
import { Star, TableProperties, BookOpen, Send, Pin } from "lucide-react";
import { SchemaExplorer } from "./schema-explorer/schema-explorer";
import { ConversationMemoryControl } from "./conversation-memory-control";
import { PromptLibrary } from "./chat/prompt-library";
import { StarterPromptList } from "./chat/starter-prompt-list";
import type { StarterPrompt } from "@useatlas/types/starter-prompt";
import { useContextWarnings } from "../hooks/use-context-warnings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { parseSuggestions } from "../lib/helpers";
import { ErrorBoundary } from "./error-boundary";
import { useUiStore } from "@/lib/stores/ui-store";
import { useChatRoutingPreferenceStore } from "@/lib/stores/chat-routing-preference-store";
import { chatSearchParams, resolveConversationUrlAction } from "./search-params";

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
  // In developer mode the chat talks to draft connections. If the admin
  // hasn't drafted one yet, surface a dedicated empty state instead of
  // letting the agent fail with a confusing "no datasource" error.
  const showDevChatEmpty = useDevModeNoDrafts(["connections"]);
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
  // #3749 — the latest durable run id captured from the `x-run-id` response
  // header (set on a fresh turn and on a resume). Captured for future
  // correlation/telemetry; the resume endpoint loads the latest non-terminal run
  // by conversation id, so this value is not used to target a resume.
  const runIdRef = useRef<string | null>(null);
  const [transientWarning, setTransientWarning] = useState("");
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [passwordDialogDismissed, setPasswordDialogDismissed] = useState(false);
  const setMobileSidebarOpen = useUiStore((s) => s.setMobileSidebarOpen);
  const schemaExplorerOpen = useUiStore((s) => s.schemaExplorerOpen);
  const setSchemaExplorerOpen = useUiStore((s) => s.setSchemaExplorerOpen);
  const promptLibraryOpen = useUiStore((s) => s.promptLibraryOpen);
  const setPromptLibraryOpen = useUiStore((s) => s.setPromptLibraryOpen);
  // Tracks the message text being pinned so the affordance disables
  // mid-flight — without this, a quick double-click fires two POSTs and
  // the second 409s after a visible success toast.
  const [pinningText, setPinningText] = useState<string | null>(null);
  const [relatedSuggestions, setRelatedSuggestions] = useState<QuerySuggestion[]>([]);
  // #2345 — chat-header env/member picker state. The connection-group
  // is the *content scope* (sticky to the conversation row across
  // turns); the connection id is the *execution target* (a per-turn
  // override that the agent honours for one turn only). Both default
  // to `null` so the legacy single-connection flow continues to render
  // without a picker.
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  // #2518 — three-state Auto/Pin/All cross-environment routing picker.
  const [selectedRoutingMode, setSelectedRoutingMode] =
    useState<ConversationRoutingMode | null>(null);
  // #3066 — per-conversation REST datasource exclude-set (excluded
  // `install_id`s). Empty = all in scope. Seeded from the sticky preference on
  // a fresh chat, restored from the row when a conversation is opened.
  const [selectedRestExcluded, setSelectedRestExcluded] = useState<string[]>([]);
  // #3067 — per-conversation REST-only focus (a single `install_id`, or null =
  // not focused). When set, the conversation targets only that datasource and
  // SQL is suspended. Seeded from the sticky preference on a fresh chat,
  // restored from the row when a conversation is opened.
  const [selectedRestFocus, setSelectedRestFocus] = useState<string | null>(null);
  // #3044 — persisted env-picker preference so a reload restores the user's
  // last selection instead of re-seeding from the first group. Select fields
  // individually so the store object identity doesn't churn effect deps.
  const prefWorkspaceId = useChatRoutingPreferenceStore((s) => s.workspaceId);
  const prefGroupId = useChatRoutingPreferenceStore((s) => s.groupId);
  const prefConnectionId = useChatRoutingPreferenceStore((s) => s.connectionId);
  const prefRoutingMode = useChatRoutingPreferenceStore((s) => s.routingMode);
  const prefRestExcluded = useChatRoutingPreferenceStore((s) => s.restExcludedDatasourceIds);
  const prefRestFocus = useChatRoutingPreferenceStore((s) => s.restFocusDatasourceId);
  const prefHasHydrated = useChatRoutingPreferenceStore((s) => s._hasHydrated);
  const setRoutingPreference = useChatRoutingPreferenceStore((s) => s.setPreference);
  // #3064 — how the current picker SQL scope (group / member / mode) was set, so
  // the seed/restore effect knows whether it may replace it. A ref (not state)
  // because it must update synchronously alongside a setSelected* call without
  // re-triggering the effect itself.
  const selectionProvenanceRef = useRef<EnvSelectionProvenance>("unset");
  // #3078 — the REST scope (exclude-set + focus) has its OWN provenance,
  // decoupled from the SQL `selectionProvenanceRef`. Opening a conversation
  // makes the row's REST scope authoritative ("explicit") even when its SQL
  // scope must be seeded (an all-null row), and a REST toggle marks it explicit
  // too. While it's explicit, `resolveEnvSelection` passes the current REST scope
  // through any SQL seed/restore instead of clobbering it — the seam that fixes
  // the all-null-SQL exclude-set data loss. `handleNewChat` resets it to "unset".
  const restScopeProvenanceRef = useRef<EnvSelectionProvenance>("unset");
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
    getConnectionId: () => selectedConnectionId,
    getConnectionGroupId: () => selectedGroupId,
    getRoutingMode: () => selectedRoutingMode,
    // #3066 — forward the REST exclude-set on every turn (always, even []).
    getRestExcludedDatasourceIds: () => selectedRestExcluded,
    // #3067 — forward the REST-only focus on every turn (always, even null) so
    // a clear actually nulls the row instead of inheriting the stale focus.
    getRestFocusDatasourceId: () => selectedRestFocus,
    // #3749 — onRunId: capture the active run id for correlation/telemetry only
    // (not used to target a resume). getResumeConversationId: a resume targets the
    // bound CONVERSATION (not the run id); the affordance only shows once a
    // conversation is mounted, so it's non-null whenever resume fires.
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

  // Whether the env/member picker has anything to show. In `embedded` mode the
  // header collapses to just the picker, so gate the header row on this to avoid
  // an empty bordered strip on a legacy 1×1 workspace. Standalone renders the
  // full header (logo / theme / user menu) regardless of this flag.
  //
  // #3081 — this MUST pass the same `restDatasources` the inner <ChatEnvPicker>
  // below receives, or the gate and the picker disagree: a zero-group REST-only
  // or 1×1-SQL + REST workspace has REST exclude/focus scope to show, the inner
  // picker would render it, but a gate computed without `restDatasources` returns
  // false and suppresses the whole header — making the REST scope controls
  // unreachable on the hosted (embedded) surface, the exact gap this unification
  // exists to close.
  const showEnvPicker = shouldRenderEnvPicker({
    groups: envGroupsQuery.groups,
    reason: envGroupsQuery.reason,
    error: envGroupsQuery.error,
    restDatasources: envGroupsQuery.restDatasources,
  });

  // Seed / restore the env-picker selection on a fresh chat. #3064 — the
  // decision is centralized in `resolveEnvSelection`: it waits until groups,
  // the persisted preference, and the workspace id are all ready (so a
  // default seed never pre-empts a restorable preference — the reset-on-reload
  // bug), restores a workspace-matching sticky preference over the default
  // seed, and never clobbers an explicit pick. Provenance is tracked in a ref
  // so a default-seeded value can still yield to a later-arriving match.
  useEffect(() => {
    const decision = resolveEnvSelection({
      groups: envGroupsQuery.groups,
      current: {
        groupId: selectedGroupId,
        connectionId: selectedConnectionId,
        routingMode: selectedRoutingMode,
        restExcludedDatasourceIds: selectedRestExcluded,
        restFocusDatasourceId: selectedRestFocus,
      },
      provenance: selectionProvenanceRef.current,
      // #3078 — REST scope provenance is independent of the SQL provenance. When
      // it's "explicit" (a conversation-open restore or a user toggle), the
      // resolver passes the current REST scope through instead of clobbering it
      // with the default seed / sticky preference while SQL seeds or restores.
      restProvenance: restScopeProvenanceRef.current,
      preference: {
        workspaceId: prefWorkspaceId,
        groupId: prefGroupId,
        connectionId: prefConnectionId,
        routingMode: prefRoutingMode,
        restExcludedDatasourceIds: prefRestExcluded,
        restFocusDatasourceId: prefRestFocus,
      },
      activeWorkspaceId,
      preferenceHydrated: prefHasHydrated,
      sessionResolved,
      // #3078 — a settled fetch means an empty `groups` is a real zero-group
      // (REST-only) workspace, not a cold start; lets the resolver seed the
      // sticky REST preference there instead of waiting forever.
      groupsLoaded: envGroupsQuery.hasLoaded,
    });

    switch (decision.kind) {
      case "restore":
        setSelectedGroupId(decision.groupId);
        setSelectedConnectionId(decision.connectionId);
        // Apply the stored mode faithfully, including an explicit null
        // (pre-#2518 back-compat → "pin"); a truthy guard here would drop it.
        setSelectedRoutingMode(decision.routingMode);
        // #3066 — seed the sticky preference's exclude-set onto this fresh chat.
        setSelectedRestExcluded(decision.restExcludedDatasourceIds);
        // #3067 — seed the sticky preference's REST-only focus too.
        setSelectedRestFocus(decision.restFocusDatasourceId);
        // A restored sticky preference is the user's deliberate prior choice —
        // mark it explicit so a later effect run can't seed over it.
        selectionProvenanceRef.current = "explicit";
        break;
      case "seed":
        setSelectedGroupId(decision.groupId);
        setSelectedConnectionId(decision.connectionId);
        // #3066 — a default seed excludes nothing.
        setSelectedRestExcluded(decision.restExcludedDatasourceIds);
        // #3067 — a default seed is not focused (SQL active).
        setSelectedRestFocus(decision.restFocusDatasourceId);
        // Record that this was auto-seeded: a workspace-matching preference
        // arriving later is still restored over it (the resolver re-runs), but
        // a second default seed is suppressed.
        selectionProvenanceRef.current = "default";
        break;
      case "wait":
      case "noop":
        // Inputs not ready yet, or the selection is already settled — do
        // nothing and let the effect re-run when a dependency changes.
        break;
      default: {
        // Exhaustiveness guard — a new EnvSelectionDecision variant (e.g. the
        // v0.0.4 REST-scope work on this branch's milestone) must add a branch.
        const _exhaustive: never = decision;
        void _exhaustive;
      }
    }
  }, [
    envGroupsQuery.groups,
    // #3078 — re-evaluate once the fetch settles, so the zero-group REST-only
    // path can seed the sticky preference instead of staying in `wait`.
    envGroupsQuery.hasLoaded,
    selectedGroupId,
    selectedConnectionId,
    // routingMode is part of `current` the resolver reads — keep it in deps so a
    // mode-only change re-evaluates restore-vs-noop rather than going stale.
    selectedRoutingMode,
    // #3066 — exclude-set is part of `current`; keep it in deps so a pref-only
    // exclude change re-evaluates restore-vs-noop rather than going stale.
    selectedRestExcluded,
    // #3067 — focus is part of `current` too; keep it in deps for the same reason.
    selectedRestFocus,
    prefWorkspaceId,
    prefGroupId,
    prefConnectionId,
    prefRoutingMode,
    prefRestExcluded,
    prefRestFocus,
    prefHasHydrated,
    activeWorkspaceId,
    sessionResolved,
  ]);

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
  const { messages, setMessages, sendMessage, regenerate, status, error } = useChat({
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
    onError: (message) => {
      setTransientWarning(message);
      setTimeout(() => setTransientWarning(""), 5000);
    },
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
  // handles 4xx/5xx fallback (5xx soft-fails to []) and is shared with
  // the notebook empty state via a stable queryKey so pins made here
  // reflect immediately when the user navigates between surfaces.
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
    setPinningText(text);
    try {
      const res = await fetch(`${apiUrl}/api/v1/starter-prompts/favorites`, {
        method: "POST",
        credentials,
        headers: { "Content-Type": "application/json", ...getHeaders() },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
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
          setTransientWarning("Already pinned — it'll show up in a new chat.");
          setTimeout(() => setTransientWarning(""), 4000);
          return;
        }
        const msg = body.message ?? "Failed to pin starter prompt.";
        console.warn("pin failed:", res.status, res.statusText, body.requestId, msg);
        setTransientWarning(msg);
        setTimeout(() => setTransientWarning(""), 5000);
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
      setTransientWarning("Pinned as starter prompt.");
      setTimeout(() => setTransientWarning(""), 3000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("pin request failed:", msg);
      setTransientWarning("Failed to pin starter prompt.");
      setTimeout(() => setTransientWarning(""), 5000);
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
        const body = (await res.json().catch(() => ({}))) as { requestId?: string };
        console.warn(
          "unpin failed:",
          res.status,
          res.statusText,
          body.requestId ?? "(no requestId — non-JSON body)",
        );
        setTransientWarning("Failed to unpin starter prompt.");
        setTimeout(() => setTransientWarning(""), 5000);
        return;
      }
      queryClient.setQueryData<StarterPrompt[]>(starterPromptsQueryKey, (prev) =>
        (prev ?? []).filter((p) => p.id !== favoriteId),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("unpin request failed:", msg);
      setTransientWarning("Failed to unpin starter prompt.");
      setTimeout(() => setTransientWarning(""), 5000);
    }
  }

  function handleSend(text: string) {
    if (!text.trim()) return;
    // #3068 — don't send while a conversation's history is still loading (a deep
    // link / sidebar open). Sending now would either append to the half-loaded
    // conversation or be clobbered when the in-flight load commits. The composer
    // is disabled too; this also guards the chip / starter-prompt send paths.
    if (loadingConversation) return;
    const saved = text;
    setInput("");
    // Drop any unattached warnings from a stalled earlier turn so they
    // cannot end up keyed onto the upcoming assistant message.
    warningCtl.resetPending();
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
      // currently-visible env groups. The SQL scope and the REST scope are
      // restored INDEPENDENTLY (#3078):
      //
      //   - REST scope (exclude-set + focus) is always restored from the row and
      //     marked `restProvenance: "explicit"` regardless of the SQL decision —
      //     it is not tied to SQL routing. Marking it explicit (before the
      //     setState calls, so the re-running seed/restore effect already sees
      //     it) is what stops that effect from clobbering a restored exclude-set
      //     when the SQL scope must be seeded. Before #3078 a `seed` cleared the
      //     exclude-set and the always-sent transport array then wiped it on the
      //     next turn (the data-loss bug).
      //   - SQL scope: a `restore` is authoritative (precedence row > sticky
      //     preference > default seed) — mark it `explicit` so the effect can't
      //     replace it. A `seed` means the row carried no usable SQL scope
      //     (all-null legacy row, or a group since archived): reset to `unset` so
      //     the effect seeds the default / restores the sticky preference,
      //     never sending stale-or-null routing the chip would misrepresent.
      const decision = resolveConversationScope(data, envGroupsQuery.groups);
      // REST scope — restored on BOTH decision kinds, made authoritative.
      restScopeProvenanceRef.current = "explicit";
      setSelectedRestExcluded(decision.restExcludedDatasourceIds);
      setSelectedRestFocus(decision.restFocusDatasourceId);
      // SQL scope — restore vs defer-to-seed.
      if (decision.kind === "restore") {
        selectionProvenanceRef.current = "explicit";
        setSelectedGroupId(decision.groupId);
        setSelectedConnectionId(decision.connectionId);
        setSelectedRoutingMode(decision.routingMode);
      } else {
        selectionProvenanceRef.current = "unset";
        setSelectedGroupId(null);
        setSelectedConnectionId(null);
        setSelectedRoutingMode(null);
      }
      setMobileSidebarOpen(false);
      // Loaded turns predate this session — no warning frames replay over
      // the wire, so any prior in-memory bucket is stale relative to the
      // freshly loaded message ids.
      warningCtl.reset();
    } catch (err: unknown) {
      console.warn("Failed to load conversation:", err instanceof Error ? err.message : String(err));
      setTransientWarning("Failed to load conversation. Please try again.");
      setTimeout(() => setTransientWarning(""), 5000);
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
    // #3065 — a new chat is not bound to any conversation's scope. Reset the
    // selection provenance and clear the picker so the seed/restore effect
    // re-runs from scratch — seeding from the sticky preference (or the
    // default), exactly as on a fresh page load. Without this, a
    // just-opened conversation's `explicit` scope would carry into the new
    // chat and the effect would no-op on it.
    selectionProvenanceRef.current = "unset";
    // #3078 — reset the REST scope provenance too, so a just-opened
    // conversation's `explicit` REST scope doesn't carry into the new chat and
    // block the seed/restore effect from seeding the sticky preference / default.
    restScopeProvenanceRef.current = "unset";
    setSelectedGroupId(null);
    setSelectedConnectionId(null);
    setSelectedRoutingMode(null);
    // #3066 — clear the exclude-set so the new chat re-seeds from the sticky
    // preference (or the empty default), matching the env reset above.
    setSelectedRestExcluded([]);
    // #3067 — clear focus too; the new chat re-seeds focus from the sticky
    // preference (or the not-focused default).
    setSelectedRestFocus(null);
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
        // branch (mirrors the EnvSelectionDecision consumer above).
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
            onConvertToNotebook={(id) => convos.convertToNotebook(id)}
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
                header to just the env-picker — and only when it has something to
                show, so a legacy 1×1 workspace doesn't render an empty row. */}
            {(!embedded || showEnvPicker) && (
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
                    activeGroupId={selectedGroupId}
                    activeConnectionId={selectedConnectionId}
                    activeRoutingMode={selectedRoutingMode}
                    restDatasources={envGroupsQuery.restDatasources}
                    restExcludedDatasourceIds={selectedRestExcluded}
                    onRestExcludedChange={(next) => {
                      // #3066 — a scope toggle is a deliberate pick: mark the
                      // selection explicit (so the seed/restore effect can't
                      // re-seed over it) and remember it in the sticky
                      // preference so new chats inherit it. The full next set
                      // (incl. []) is forwarded verbatim. #3078 — mark the REST
                      // scope's own provenance explicit too (keeping the SQL
                      // provenance explicit avoids a stray pref-restore of SQL as
                      // a side effect of a REST toggle).
                      selectionProvenanceRef.current = "explicit";
                      restScopeProvenanceRef.current = "explicit";
                      setSelectedRestExcluded(next);
                      setRoutingPreference({
                        workspaceId: activeWorkspaceId,
                        groupId: selectedGroupId,
                        connectionId: selectedConnectionId,
                        routingMode: selectedRoutingMode,
                        restExcludedDatasourceIds: next,
                        restFocusDatasourceId: selectedRestFocus,
                      });
                    }}
                    restFocusDatasourceId={selectedRestFocus}
                    onRestFocusChange={(next) => {
                      // #3067 — focusing / clearing is a deliberate pick: mark
                      // explicit and remember it in the sticky preference so new
                      // chats inherit it. `null` clears focus (re-enables SQL).
                      // #3078 — mark the REST scope's own provenance explicit too.
                      selectionProvenanceRef.current = "explicit";
                      restScopeProvenanceRef.current = "explicit";
                      setSelectedRestFocus(next);
                      setRoutingPreference({
                        workspaceId: activeWorkspaceId,
                        groupId: selectedGroupId,
                        connectionId: selectedConnectionId,
                        routingMode: selectedRoutingMode,
                        restExcludedDatasourceIds: selectedRestExcluded,
                        restFocusDatasourceId: next,
                      });
                    }}
                    onSelect={({ groupId, connectionId, routingMode }) => {
                      // #3064 — a user pick is authoritative; mark it explicit
                      // so the seed/restore effect never replaces it.
                      selectionProvenanceRef.current = "explicit";
                      setSelectedGroupId(groupId);
                      setSelectedConnectionId(connectionId);
                      setSelectedRoutingMode(routingMode);
                      // #3044 — remember this pick (scoped to the active
                      // workspace) so a reload restores it. #3066 — carry the
                      // current exclude-set so an env change doesn't drop it.
                      setRoutingPreference({
                        workspaceId: activeWorkspaceId,
                        groupId,
                        connectionId,
                        routingMode,
                        restExcludedDatasourceIds: selectedRestExcluded,
                        // #3067 — carry the current focus so an env change
                        // doesn't drop it from the sticky preference.
                        restFocusDatasourceId: selectedRestFocus,
                      });
                    }}
                  />
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
            )}

            {(healthWarning || transientWarning || convos.fetchError) && (
              <p className="mb-2 text-xs text-zinc-400 dark:text-zinc-500">{healthWarning || transientWarning || convos.fetchError}</p>
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
                    <div className="flex h-full flex-col items-center justify-center gap-6">
                      <div className="text-center">
                        <p className="text-lg font-medium text-zinc-500 dark:text-zinc-400">
                          What would you like to know?
                        </p>
                        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-500">
                          Ask a question about your data to get started
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
                    // #3068 — also disabled while a conversation's history loads
                    // (deep link / sidebar open) so a send can't race the load.
                    disabled={isLoading || loadingConversation}
                    aria-label="Chat message"
                  />
                  <Button
                    type="submit"
                    size="icon"
                    disabled={isLoading || loadingConversation}
                    aria-disabled={!isLoading && !input.trim() ? true : undefined}
                    aria-label="Send"
                    className="size-10 shrink-0"
                  >
                    <Send className="size-4" />
                  </Button>
                </form>
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
