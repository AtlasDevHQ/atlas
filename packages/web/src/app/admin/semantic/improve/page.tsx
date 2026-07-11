"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, isToolUIPart, getToolName } from "ai";
import { extractProposals, buildProposalQueue, buildReviewBody, classifyReviewResult, toolPartStatus, type Proposal, type QueueRow, type TestResult } from "./proposals";
import { RejectedCard, type RejectedAmendment } from "./rejected";
import { DiffViewer, formatAmendment } from "./amendment-display";
import {
  buildImproveChatBody,
  describeAnchor,
  entityKickoffMessage,
  groupKickoffMessage,
  SWEEP_KICKOFF_MESSAGE,
  type ImproveAnchor,
} from "./anchor";
import { useAtlasConfig } from "@/ui/context";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { MutationErrorSurface } from "@/ui/components/admin/mutation-error-surface";
// Parity with the main chat surface (#4517): shared markdown for agent prose and
// the shared billing/permission ErrorBanner (CTA + Retry-After countdown).
import { Markdown } from "@/ui/components/chat/markdown";
import { ErrorBanner } from "@/ui/components/chat/error-banner";
import { useIsMobile } from "@/hooks/use-mobile";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import {
  Sparkles,
  Send,
  Check,
  X,
  Play,
  ArrowLeft,
  Loader2,
  ChevronDown,
  Database,
  Table2,
} from "lucide-react";
import Link from "next/link";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PendingAmendment {
  id: string;
  entityName: string;
  description: string | null;
  confidence: number;
  amendmentType: string | null;
  amendment: Record<string, unknown> | null;
  rationale: string | null;
  /** The LIVE diff, recomputed against the current baseline server-side (#4511). */
  diff: string | null;
  /** Hash of the baseline the live diff was computed against (#4511). */
  baselineHash: string | null;
  /** #4517 — a `draft` sibling of this entity exists (published-baseline caveat). */
  draftExists: boolean;
  testQuery: string | null;
  testResult: TestResult | null;
  applyError: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// ProposalCard
// ---------------------------------------------------------------------------

function ProposalCard({
  proposal,
  onApprove,
  onReject,
  approving,
  rejecting,
  staleUpdate,
  onConfirmStale,
  pickerGroups,
  onPickGroup,
}: {
  proposal: QueueRow;
  onApprove: () => void;
  onReject: () => void;
  approving: boolean;
  rejecting: boolean;
  /** #4511 — a fresh live diff to confirm after a mid-review baseline change. */
  staleUpdate?: { diff: string; baselineHash: string };
  onConfirmStale?: () => void;
  /** #4511 — candidate groups for a legacy cross-group-ambiguous row. */
  pickerGroups?: ReadonlyArray<string | null>;
  onPickGroup?: (group: string | null) => void;
}) {
  let confidenceColor = "text-red-600 dark:text-red-400";
  if (proposal.confidence >= 0.8) {
    confidenceColor = "text-green-600 dark:text-green-400";
  } else if (proposal.confidence >= 0.5) {
    confidenceColor = "text-yellow-600 dark:text-yellow-400";
  }

  const decided = proposal.decision !== null;
  // #4511 — after a mid-review baseline change the panel renders the FRESH diff
  // (the stored/live one it opened with is superseded), so approving-what-you-see
  // holds through the confirm.
  const diffToShow = staleUpdate?.diff ?? proposal.diff;

  return (
    <Card className="shadow-none border">
      <CardHeader className="py-3 pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm">
            <span className="font-mono">{proposal.entityName}</span>
            <Badge variant="outline" className="text-[10px]">
              {proposal.amendmentType.replace(/_/g, " ")}
            </Badge>
            {/* Presentation marker — this row was created in the live
                conversation (#4504): a mark on the one-queue model, not a
                parallel list. Also renders on the recently-decided strip. */}
            {proposal.fromConversation && (
              <Badge variant="secondary" className="gap-1 text-[10px]">
                <Sparkles className="size-2.5" />
                this conversation
              </Badge>
            )}
          </CardTitle>
          <div className="flex items-center gap-2">
            <span className={`text-xs font-medium ${confidenceColor}`}>
              {Math.round(proposal.confidence * 100)}% confidence
            </span>
            {decided && (
              <Badge
                variant={
                  proposal.decision === "accepted" || proposal.decision === "applied"
                    ? "default"
                    : "secondary"
                }
                className="text-[10px]"
              >
                {/* "applied" = auto-approved in-flow, already live (#4499) */}
                {proposal.decision === "applied" ? "auto-approved" : proposal.decision}
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="py-2 space-y-3">
        <p className="text-sm text-muted-foreground">{proposal.rationale}</p>

        {/* #4511 — a mid-review baseline change: show WHY the diff changed
            before the fresh diff, so Confirm is an informed continuation. */}
        {staleUpdate && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            <span className="font-medium">This entity changed while you were reviewing.</span>{" "}
            Review the updated change below and confirm.
          </p>
        )}

        {/* Diff view when available, otherwise amendment preview */}
        {diffToShow ? (
          <DiffViewer diff={diffToShow} />
        ) : (
          <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs font-mono whitespace-pre-wrap">
            {formatAmendment(proposal.amendmentType, proposal.amendment)}
          </pre>
        )}

        {/* #4517 — the entity has a draft. The live diff is against the PUBLISHED
            version (approval is the publish gate); note that approving mirrors the
            change onto the draft so a later publish can't clobber it. */}
        {proposal.draftExists && (
          <p className="text-xs text-muted-foreground">
            <span className="font-medium">A draft of this entity exists.</span>{" "}
            This diff is against the published version — approving publishes the
            change and mirrors it onto the draft, so a later publish keeps it.
          </p>
        )}

        {proposal.testQuery && (
          <div className="text-xs text-muted-foreground space-y-1">
            <span className="font-medium">Test query:</span>{" "}
            <code className="rounded bg-muted px-1 py-0.5">{proposal.testQuery}</code>
            {proposal.testResult && (
              <p className={proposal.testResult.success ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}>
                {proposal.testResult.success
                  ? `Passed — ${proposal.testResult.rowCount} row${proposal.testResult.rowCount === 1 ? "" : "s"}`
                  : `Failed${proposal.testResult.error ? ` — ${proposal.testResult.error}` : ""}`}
              </p>
            )}
          </div>
        )}

        {/* A previous approval failed to apply — the decide seam returned the
            row to pending with the reason (#4506). Show it so retrying isn't
            blind. */}
        {proposal.applyError && (
          <p className="text-xs text-red-600 dark:text-red-400">
            <span className="font-medium">Last approval failed:</span> {proposal.applyError}
          </p>
        )}

        {/* #4511 — a legacy cross-group-ambiguous row: pick the environment to
            apply to. The picker appears ONLY when the server demanded it. */}
        {!decided && pickerGroups && pickerGroups.length > 0 && (
          <div className="space-y-2 pt-1">
            <p className="text-xs text-muted-foreground">
              This entity exists in multiple environments. Pick the one to apply to:
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {pickerGroups.map((g) => (
                <Button
                  key={g ?? "__legacy__"}
                  size="sm"
                  variant="outline"
                  onClick={() => onPickGroup?.(g)}
                  disabled={approving || rejecting}
                  className="gap-1.5 text-xs"
                >
                  {approving ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Check className="size-3" />
                  )}
                  {g === null ? "Legacy / global" : g.replace(/^g_/, "")}
                </Button>
              ))}
              <Button
                variant="ghost"
                size="sm"
                onClick={onReject}
                disabled={approving || rejecting}
                className="gap-1.5 text-xs"
              >
                {rejecting ? <Loader2 className="size-3 animate-spin" /> : <X className="size-3" />}
                Reject
              </Button>
            </div>
          </div>
        )}

        {!decided && !(pickerGroups && pickerGroups.length > 0) && (
          <div className="flex items-center gap-2 pt-1">
            <Button
              size="sm"
              onClick={staleUpdate ? onConfirmStale : onApprove}
              disabled={approving || rejecting}
              className="gap-1.5 text-xs"
            >
              {approving ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Check className="size-3" />
              )}
              {staleUpdate ? "Confirm" : "Approve"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={onReject}
              disabled={approving || rejecting}
              className="gap-1.5 text-xs"
            >
              {rejecting ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <X className="size-3" />
              )}
              Reject
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Anchor launchers (#4519)
// ---------------------------------------------------------------------------

/** The active anchor plus its friendly display label (the wire anchor carries ids). */
interface ActiveAnchor {
  value: ImproveAnchor;
  label: string;
}

interface LauncherGroup {
  id: string;
  name: string;
}

interface LauncherEntity {
  /** Routing/storage key — matches the entity's `name` on the server. */
  name: string;
  /** Friendly display label (may differ from `name` when a YAML display name exists). */
  label: string;
  /** Connection group id, or null for an unscoped/default-group entity. */
  group: string | null;
}

/**
 * The entry launchers that replace the vanishing "Run Analysis" button (#4519):
 * anchor to a connection group, anchor to an entity, or start an anchorless
 * sweep. Always rendered — regardless of conversation state — so an admin can
 * re-anchor or sweep at any point. Group/entity menus appear only once their
 * lists load; the sweep is always available.
 */
export function AnchorLaunchers({
  groups,
  entities,
  onGroup,
  onEntity,
  onSweep,
  disabled,
}: {
  groups: LauncherGroup[];
  entities: LauncherEntity[];
  onGroup: (g: LauncherGroup) => void;
  onEntity: (e: LauncherEntity) => void;
  onSweep: () => void;
  disabled: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      {groups.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="gap-1.5" disabled={disabled}>
              <Database className="size-4" />
              Group
              <ChevronDown className="size-3 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
            <DropdownMenuLabel>Improve a connection group</DropdownMenuLabel>
            {groups.map((g) => (
              <DropdownMenuItem key={g.id} onSelect={() => onGroup(g)}>
                {g.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {entities.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="gap-1.5" disabled={disabled}>
              <Table2 className="size-4" />
              Entity
              <ChevronDown className="size-3 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
            <DropdownMenuLabel>Improve an entity</DropdownMenuLabel>
            {entities.map((e) => (
              <DropdownMenuItem key={`${e.group ?? ""}:${e.name}`} onSelect={() => onEntity(e)}>
                <span className="font-mono text-xs">{e.label}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <Button onClick={onSweep} disabled={disabled} size="sm" className="gap-1.5">
        <Play className="size-4" />
        Sweep
      </Button>
    </div>
  );
}

/**
 * The active-anchor chip shown in the conversation UI (#4519 AC3) — a launcher,
 * not a cage: Clear drops the scope without touching the transcript. Extracted so
 * the "anchor is visible" behavior is unit-testable without driving the launcher
 * dropdowns.
 */
export function ActiveAnchorChip({ anchor, onClear }: { anchor: ActiveAnchor; onClear: () => void }) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b bg-muted/40 px-4 py-2 text-xs">
      <Badge variant="secondary" className="gap-1">
        <Sparkles className="size-3" />
        {describeAnchor(anchor.value, anchor.label)}
      </Badge>
      <span className="text-muted-foreground">Scoping this conversation</span>
      <Button variant="ghost" size="sm" className="ml-auto h-6 gap-1 px-2 text-xs" onClick={onClear}>
        <X className="size-3" />
        Clear
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function SemanticImprovePage() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  // Stack the chat + proposals panels below the mobile breakpoint (#4517) so the
  // side-by-side split doesn't crush both panes on a narrow viewport.
  const isMobile = useIsMobile();
  const [inputValue, setInputValue] = useState("");
  // Keyed by the proposal's DB row id (`dbId`) so a decision made on a
  // chat-streamed card survives re-renders and pending-list refetches — the
  // card is re-derived from the message stream each render, so an index-keyed
  // decision would drift as proposals stream in.
  const [proposalDecisions, setProposalDecisions] = useState<
    Map<string, "accepted" | "rejected">
  >(new Map());
  // Which review list the proposals panel shows: the Pending queue or the
  // Rejected view (#4512). Rejected is where an admin lifts a rejection.
  const [view, setView] = useState<"pending" | "rejected">("pending");
  // #4511 — mid-review outcomes keyed by the proposal's dbId. `stale` swaps a
  // fresh live diff into the card with a Confirm (the entity changed since
  // render); `picker` renders a group picker for a legacy cross-group-ambiguous
  // row. Both are continuations of review, never error dead-ends.
  const [staleByDbId, setStaleByDbId] = useState<
    Map<string, { diff: string; baselineHash: string }>
  >(new Map());
  const [pickerByDbId, setPickerByDbId] = useState<Map<string, ReadonlyArray<string | null>>>(
    new Map(),
  );

  // #4519 — the anchor this conversation is scoped to (group/entity), or null
  // for an anchorless sweep. `anchorRef` mirrors the wire value so the transport
  // can read the latest at fetch time WITHOUT rebuilding (re-anchoring
  // mid-conversation then reaches the next turn); the state drives the chip.
  const [anchor, setAnchor] = useState<ActiveAnchor | null>(null);
  const anchorRef = useRef<ImproveAnchor | null>(null);

  // Transport for the semantic expert agent endpoint. The conversation lives
  // entirely in this component's useChat state — there is no server-side
  // session resource to round-trip (#4503).
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: `${apiUrl}/api/v1/admin/semantic-improve/chat`,
        credentials: isCrossOrigin ? "include" : undefined,
        // #4519 — ride the active anchor on every turn so the briefing stays
        // scoped. Read from a ref at fetch time (not a memo dep) so re-anchoring
        // mid-conversation reaches the next turn without rebuilding the
        // transport. `messages` is set explicitly because supplying
        // `prepareSendMessagesRequest` replaces the SDK's default body (the
        // auto-merged `{ id, messages, trigger, messageId }`) with exactly what
        // we return here — the improve route reads only `messages` + `anchor`, so
        // dropping the SDK's extra fields is a no-op server-side. The anchor key
        // is omitted entirely when null, so an anchorless turn carries no anchor.
        prepareSendMessagesRequest: ({ messages }) => ({
          body: buildImproveChatBody(messages, anchorRef.current),
        }),
      }),
    [apiUrl, isCrossOrigin],
  );

  const { messages, sendMessage, status, error: chatError } = useChat({ transport });
  const isLoading = status === "streaming" || status === "submitted";

  // Fetch pending amendments from the DB (created by earlier conversations
  // or the expert scheduler)
  const { data: pendingData, loading: pendingLoading, error: pendingError, refetch: refetchPending } =
    useAdminFetch<{ amendments: PendingAmendment[] }>("/api/v1/admin/semantic-improve/pending");

  // Fetch the org's rejected amendments — the Rejected view offers Reconsider
  // on each (#4512). Fetched eagerly so the tab badge shows a count without
  // opening the tab; it's a cheap org-scoped read.
  const { data: rejectedData, loading: rejectedLoading, error: rejectedError, refetch: refetchRejected } =
    useAdminFetch<{ amendments: RejectedAmendment[] }>("/api/v1/admin/semantic-improve/rejected");
  const rejectedAmendments = rejectedData?.amendments ?? [];

  // #4519 — the launcher lists. Connection groups (for the group anchor) and
  // entities (for the entity anchor) populate the entry launchers. Both are
  // best-effort with per-row resilience: a malformed row is skipped (a
  // `transform` flatMap, not a Zod `schema` that would reject the whole list on
  // one bad row and blank the launcher). A top-level shape drift (the array
  // key renamed/absent) can't be salvaged per-row, so it's console.warn'd —
  // otherwise the launcher would vanish with no breadcrumb. The sweep always
  // remains regardless. The anchor's wire value carries ids; the menu shows
  // friendly labels.
  const { data: groupsData } = useAdminFetch<LauncherGroup[]>("/api/v1/me/connection-groups", {
    transform: (json) => {
      const raw = (json as { groups?: unknown }).groups;
      if (!Array.isArray(raw)) {
        console.warn("Semantic-improve: /me/connection-groups returned no `groups` array — group launcher hidden (response shape drift?)");
        return [];
      }
      const projected = raw.flatMap((g) => {
        const rec = g as Record<string, unknown>;
        return typeof rec.id === "string" && typeof rec.name === "string"
          ? [{ id: rec.id, name: rec.name }]
          : [];
      });
      // A non-empty array that projects to nothing is a per-row field drift
      // (e.g. `id` renamed) — same "launcher vanished" symptom as key drift, so
      // warn here too. An honestly-empty list stays silent (no groups yet).
      if (raw.length > 0 && projected.length === 0) {
        console.warn("Semantic-improve: /me/connection-groups rows all failed projection — group launcher hidden (per-row field drift?)");
      }
      return projected;
    },
  });
  const launcherGroups = groupsData ?? [];

  const { data: entitiesData } = useAdminFetch<LauncherEntity[]>("/api/v1/admin/semantic/entities", {
    transform: (json) => {
      const raw = (json as { entities?: unknown }).entities;
      if (!Array.isArray(raw)) {
        console.warn("Semantic-improve: /admin/semantic/entities returned no `entities` array — entity launcher hidden (response shape drift?)");
        return [];
      }
      const projected = raw.flatMap((e) => {
        const rec = e as Record<string, unknown>;
        const name = typeof rec.name === "string" && rec.name ? rec.name : null;
        if (!name) return [];
        // `connectionId` is the server's group-id slot for entities (named that
        // way because the response shape predates the group rename, #2412).
        const group = typeof rec.connectionId === "string" && rec.connectionId ? rec.connectionId : null;
        const label = typeof rec.displayName === "string" && rec.displayName ? rec.displayName : name;
        return [{ name, label, group }];
      });
      // Non-empty rows projecting to nothing ⇒ per-row field drift (e.g. `name`
      // renamed) — warn so the vanished launcher leaves a breadcrumb; an honestly
      // empty schema stays silent.
      if (raw.length > 0 && projected.length === 0) {
        console.warn("Semantic-improve: /admin/semantic/entities rows all failed projection — entity launcher hidden (per-row field drift?)");
      }
      return projected;
    },
  });
  const launcherEntities = entitiesData ?? [];

  // Single mutation hook for approve/reject/reconsider
  const { mutate, isMutating, error: mutationError, clearErrorFor } = useAdminMutation({
    method: "POST",
  });

  // Convert DB pending amendments to Proposal shape for display
  const pendingAmendments: Proposal[] = (pendingData?.amendments ?? []).map((a, i) => ({
    index: i,
    entityName: a.entityName,
    category: "",
    amendmentType: a.amendmentType ?? "unknown",
    amendment: a.amendment ?? {},
    rationale: a.rationale ?? a.description ?? "",
    diff: a.diff ?? undefined,
    baselineHash: a.baselineHash ?? undefined,
    draftExists: a.draftExists,
    testQuery: a.testQuery ?? undefined,
    testResult: a.testResult ?? undefined,
    applyError: a.applyError ?? undefined,
    confidence: a.confidence,
    decision: null,
    dbId: a.id,
  }));

  // The live conversation's proposals — supply markers on the one Pending
  // queue plus the already-decided rows in the strip below, never a second
  // source of approvable rows (#4504).
  const chatProposals = extractProposals(messages);

  // The one Pending queue: pre-existing pending Amendments and this
  // conversation's rows together, conversation rows marked and sorted to the
  // top. Decided/auto-applied rows drop to the presentation-only strip below.
  const { pending: proposals, recentlyDecided } = buildProposalQueue({
    pending: pendingAmendments,
    conversation: chatProposals,
    decisions: proposalDecisions,
  });

  // A new proposeAmendment result must surface in the queue: refetch /pending
  // when the set of conversation-created rows changes. `refetchPending`
  // (TanStack Query) is referentially stable, so this fires only on new rows,
  // not every render.
  const conversationIdsKey = chatProposals.map((p) => p.dbId ?? "").join(",");
  useEffect(() => {
    if (conversationIdsKey) void refetchPending();
  }, [conversationIdsKey, refetchPending]);

  function handleSend() {
    if (!inputValue.trim() || isLoading) return;
    const saved = inputValue;
    setInputValue("");
    sendMessage({ role: "user", parts: [{ type: "text" as const, text: saved }] }).catch(
      (err: unknown) => {
        console.error("Failed to send message:", err instanceof Error ? err.message : String(err));
        setInputValue(saved);
      },
    );
  }

  // #4517 — retry the failed turn by replaying the last user message (mirrors the
  // main chat surface). Feeds ErrorBanner's manual "Try again" and its auto-retry
  // when a rate-limit Retry-After countdown elapses.
  function handleRetryChat() {
    const lastUser = messages.toReversed().find((m) => m.role === "user");
    const text = lastUser?.parts
      ?.filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join(" ");
    if (!text?.trim()) return;
    sendMessage({ role: "user", parts: [{ type: "text" as const, text }] }).catch((err: unknown) => {
      console.error("Failed to retry message:", err instanceof Error ? err.message : String(err));
    });
  }

  // #4519 — set the active anchor. Write the ref synchronously (before the
  // sendMessage that follows) so the transport's fetch-time read sees it; the
  // state drives the chip. Clearing (null) leaves the conversation intact — the
  // anchor is a launcher, not a cage.
  function applyAnchor(next: ActiveAnchor | null) {
    anchorRef.current = next?.value ?? null;
    setAnchor(next);
  }

  function launch(next: ActiveAnchor | null, text: string) {
    if (isLoading) return;
    applyAnchor(next);
    sendMessage({ role: "user", parts: [{ type: "text" as const, text }] }).catch((err: unknown) => {
      console.error("Failed to start conversation:", err instanceof Error ? err.message : String(err));
    });
  }

  function launchGroup(g: LauncherGroup) {
    launch({ value: { kind: "group", group: g.id }, label: g.name }, groupKickoffMessage(g.name));
  }

  function launchEntity(e: LauncherEntity) {
    const value: ImproveAnchor = e.group
      ? { kind: "entity", entity: e.name, group: e.group }
      : { kind: "entity", entity: e.name };
    launch({ value, label: e.label }, entityKickoffMessage(e.label));
  }

  function launchSweep() {
    // A sweep is the anchorless start — clear any active anchor.
    launch(null, SWEEP_KICKOFF_MESSAGE);
  }

  function clearMidReview(dbId: string) {
    setStaleByDbId((prev) => {
      if (!prev.has(dbId)) return prev;
      const next = new Map(prev);
      next.delete(dbId);
      return next;
    });
    setPickerByDbId((prev) => {
      if (!prev.has(dbId)) return prev;
      const next = new Map(prev);
      next.delete(dbId);
      return next;
    });
  }

  async function submitReview(
    proposal: Proposal,
    decision: "approved" | "rejected",
    opts?: { baselineHash?: string; group?: string | null },
  ) {
    // Every rendered proposal — chat-streamed or loaded from the pending list —
    // carries the `learned_patterns` row id, so all reviews go through the one
    // DB-backed review path.
    const dbId = proposal.dbId;
    if (!dbId) return;
    const label = decision === "approved" ? "approve" : "reject";
    const itemId = `${label}-${dbId}`;

    const result = await mutate({
      path: `/api/v1/admin/semantic-improve/amendments/${dbId}/review`,
      itemId,
      // The hash-carried claim + disambiguation group only ride an approve
      // (#4511) — the pure builder encodes that rule so it stays testable.
      body: buildReviewBody(decision, opts),
    });

    const outcome = classifyReviewResult(result);
    if (outcome.kind === "ok") {
      // Decided — clear any mid-review affordance, mark the card decided (chat
      // cards persist across renders), and refresh the pending list.
      clearMidReview(dbId);
      clearErrorFor(itemId);
      setProposalDecisions((prev) =>
        new Map(prev).set(dbId, decision === "approved" ? "accepted" : "rejected"),
      );
      void refetchPending();
    } else if (outcome.kind === "stale") {
      // The entity changed since render — swap in the fresh diff + Confirm.
      // Not an error: suppress the generic banner for this row.
      setStaleByDbId((prev) =>
        new Map(prev).set(dbId, { diff: outcome.diff, baselineHash: outcome.baselineHash }),
      );
      setPickerByDbId((prev) => {
        if (!prev.has(dbId)) return prev;
        const next = new Map(prev);
        next.delete(dbId);
        return next;
      });
      clearErrorFor(itemId);
    } else if (outcome.kind === "ambiguous") {
      // Legacy cross-group row — render the group picker. Not an error.
      setPickerByDbId((prev) => new Map(prev).set(dbId, outcome.groups));
      setStaleByDbId((prev) => {
        if (!prev.has(dbId)) return prev;
        const next = new Map(prev);
        next.delete(dbId);
        return next;
      });
      clearErrorFor(itemId);
    }
    // outcome.kind === "error": leave the mutation error banner to surface it.
  }

  function handleReview(proposal: Proposal, decision: "approved" | "rejected") {
    void submitReview(proposal, decision, { baselineHash: proposal.baselineHash });
  }

  function handleConfirmStale(proposal: Proposal) {
    const dbId = proposal.dbId;
    if (!dbId) return;
    const stale = staleByDbId.get(dbId);
    if (!stale) return;
    // Confirm the reviewed-fresh change: re-approve carrying the FRESH baseline
    // hash, which now matches — one extra click completes the flow.
    void submitReview(proposal, "approved", { baselineHash: stale.baselineHash });
  }

  function handlePickGroup(proposal: Proposal, group: string | null) {
    // Disambiguate a legacy cross-group row: re-approve at the picked group.
    void submitReview(proposal, "approved", { group });
  }

  async function handleReconsider(id: string) {
    // Lift the rejection: the row returns to pending and its identity leaves
    // rejection memory (#4512). Refetch BOTH lists so the row leaves Rejected
    // and appears in the Pending queue with a live diff, like any other.
    const result = await mutate({
      path: `/api/v1/admin/semantic-improve/amendments/${id}/reconsider`,
      itemId: `reconsider-${id}`,
    });
    if (result.ok) {
      void refetchRejected();
      void refetchPending();
    }
  }

  return (
    // Fill the admin content area exactly (#4517) — the old `calc(100dvh-4rem)`
    // hardcoded a top-bar height that no longer matches and double-counted inside
    // the admin layout's own scroll area, drifting the page height.
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 border-b px-6 py-4">
        <Link href="/admin/semantic">
          <Button variant="ghost" size="sm" className="gap-1.5">
            <ArrowLeft className="size-4" />
            Back
          </Button>
        </Link>
        <div className="flex-1">
          <h1 className="text-lg font-semibold tracking-tight flex items-center gap-2">
            <Sparkles className="size-5" />
            Semantic Layer Improvement
          </h1>
          <p className="text-xs text-muted-foreground">
            AI-powered analysis and improvement of your semantic layer
          </p>
        </div>
        {/* #4519 — entry launchers replace the vanishing single button. They
            stay available regardless of conversation state so an admin can
            anchor to a group/entity or run an anchorless sweep at any point. */}
        <AnchorLaunchers
          groups={launcherGroups}
          entities={launcherEntities}
          onGroup={launchGroup}
          onEntity={launchEntity}
          onSweep={launchSweep}
          disabled={isLoading}
        />
      </div>

      {/* Split view */}
      <div className="min-h-0 flex-1 overflow-hidden">
        <ResizablePanelGroup orientation={isMobile ? "vertical" : "horizontal"}>
          {/* Chat panel */}
          <ResizablePanel defaultSize={55} minSize={35}>
            <div className="flex h-full min-h-0 flex-col">
              {/* #4519 — the active anchor, visible in the conversation UI.
                  Free typing still works anchored; Clear drops the scope
                  without touching the transcript. */}
              {anchor && <ActiveAnchorChip anchor={anchor} onClear={() => applyAnchor(null)} />}
              <ScrollArea className="min-h-0 flex-1 p-4">
                <div className="space-y-4 pb-4">
                  {messages.length === 0 && (
                    <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground">
                      <Sparkles className="size-10 opacity-40 mb-3" />
                      <p className="text-sm font-medium">
                        Start an improvement conversation
                      </p>
                      <p className="mt-1 text-xs max-w-sm">
                        Anchor to a group or entity from the launchers above, run a
                        &ldquo;Sweep&rdquo; to find improvements anywhere, or just type a
                        message to guide the expert agent.
                      </p>
                    </div>
                  )}

                  {messages.map((msg) => (
                    <div
                      key={msg.id}
                      className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                    >
                      <div
                        className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                          msg.role === "user"
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted"
                        }`}
                      >
                        {msg.parts.map((part, i) => {
                          if (part.type === "text") {
                            // Agent prose renders markdown like the main chat
                            // surface (#4517); the user's own text stays plain.
                            return msg.role === "assistant" ? (
                              <Markdown key={i} content={part.text} />
                            ) : (
                              <p key={i} className="whitespace-pre-wrap">{part.text}</p>
                            );
                          }
                          // Reasoning parts render as muted, quoted sub-prose (#4517).
                          if (part.type === "reasoning") {
                            const reasoning = part.text;
                            if (!reasoning.trim()) return null;
                            return (
                              <div
                                key={i}
                                className="my-1 border-l-2 border-muted-foreground/30 pl-2 text-xs italic text-muted-foreground"
                              >
                                <Markdown content={reasoning} />
                              </div>
                            );
                          }
                          if (isToolUIPart(part)) {
                            let toolName = "tool";
                            try { toolName = getToolName(part as Parameters<typeof getToolName>[0]); } catch { /* intentionally ignored: unknown tool */ }
                            // Map the CURRENT AI SDK v5 tool-part states (#4517)
                            // via the shared, unit-tested `toolPartStatus`. The old
                            // code gated the spinner on "call", a legacy state
                            // these parts never carry, so a running tool showed no
                            // activity and errors were invisible.
                            const status = toolPartStatus(part.state);
                            return (
                              <div key={i} className="my-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                                <Badge variant="outline" className="text-[10px]">
                                  {toolName}
                                </Badge>
                                {status === "done" && (
                                  <Check className="size-3 text-green-600 dark:text-green-400" />
                                )}
                                {status === "failed" && (
                                  <span className="text-red-600 dark:text-red-400">failed</span>
                                )}
                                {status === "working" && (
                                  <Loader2 className="inline size-3 animate-spin" />
                                )}
                              </div>
                            );
                          }
                          return null;
                        })}
                      </div>
                    </div>
                  ))}

                  {isLoading && messages.length > 0 && (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Loader2 className="size-3 animate-spin" />
                      Analyzing...
                    </div>
                  )}
                </div>
              </ScrollArea>

              {/* Error display — the shared chat ErrorBanner (#4517): billing /
                  permission (429/403) errors render with an upgrade/Retry-After
                  countdown and a Try-again CTA, not a flat "Analysis failed" box.
                  The admin console is always managed (cookie) auth. */}
              {chatError && (
                <div className="border-t px-4 pt-3">
                  <ErrorBanner error={chatError} authMode="managed" onRetry={handleRetryChat} />
                </div>
              )}

              {/* Input area */}
              <div className="border-t p-3">
                <div className="flex gap-2">
                  <Textarea
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        handleSend();
                      }
                    }}
                    placeholder="Ask the expert agent to improve specific areas..."
                    className="min-h-10 max-h-30 resize-none text-sm"
                    rows={1}
                  />
                  <Button
                    onClick={handleSend}
                    disabled={!inputValue.trim() || isLoading}
                    size="icon"
                    className="shrink-0"
                  >
                    <Send className="size-4" />
                  </Button>
                </div>
              </div>
            </div>
          </ResizablePanel>

          <ResizableHandle withHandle />

          {/* Proposals panel */}
          <ResizablePanel defaultSize={45} minSize={25}>
            <Tabs
              value={view}
              onValueChange={(v) => setView(v as "pending" | "rejected")}
              className="flex h-full min-h-0 flex-col gap-0"
            >
              <div className="shrink-0 border-b px-4 py-3">
                <TabsList>
                  <TabsTrigger value="pending">
                    Pending
                    {/* Every row in the pending queue is approvable, so this
                        count can never disagree with it (#4504). */}
                    {proposals.length > 0 && (
                      <span className="ml-1 text-muted-foreground font-normal">
                        {proposals.length}
                      </span>
                    )}
                  </TabsTrigger>
                  <TabsTrigger value="rejected">
                    Rejected
                    {rejectedAmendments.length > 0 && (
                      <span className="ml-1 text-muted-foreground font-normal">
                        {rejectedAmendments.length}
                      </span>
                    )}
                  </TabsTrigger>
                </TabsList>
              </div>
              <TabsContent value="pending" className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <ScrollArea className="min-h-0 flex-1 p-4">
                <div className="space-y-3">
                  <MutationErrorSurface error={pendingError} feature="Semantic Layer" onRetry={refetchPending} />
                  <MutationErrorSurface error={mutationError} feature="Semantic Layer" />
                  {proposals.length === 0 && recentlyDecided.length === 0 && !pendingLoading && (
                    <div className="py-12 text-center text-xs text-muted-foreground">
                      {messages.length === 0
                        ? "No pending improvements. Run an analysis to identify opportunities."
                        : "Proposals will appear here as the agent identifies improvements."}
                    </div>
                  )}
                  {pendingLoading && proposals.length === 0 && recentlyDecided.length === 0 && (
                    <div className="flex items-center justify-center py-12 text-xs text-muted-foreground">
                      <Loader2 className="size-3 animate-spin mr-2" />
                      Loading pending amendments...
                    </div>
                  )}
                  {proposals.map((proposal) => {
                    const itemKey = proposal.dbId ?? `chat-${proposal.index}`;
                    const idSuffix = proposal.dbId ?? String(proposal.index);
                    const staleUpdate = proposal.dbId ? staleByDbId.get(proposal.dbId) : undefined;
                    const pickerGroups = proposal.dbId ? pickerByDbId.get(proposal.dbId) : undefined;
                    return (
                      <ProposalCard
                        key={itemKey}
                        proposal={proposal}
                        onApprove={() => handleReview(proposal, "approved")}
                        onReject={() => handleReview(proposal, "rejected")}
                        approving={isMutating(`approve-${idSuffix}`)}
                        rejecting={isMutating(`reject-${idSuffix}`)}
                        staleUpdate={staleUpdate}
                        onConfirmStale={() => handleConfirmStale(proposal)}
                        pickerGroups={pickerGroups}
                        onPickGroup={(group) => handlePickGroup(proposal, group)}
                      />
                    );
                  })}

                  {/* Recently decided — presentation-only. These rows are
                      auto-applied or reviewed this session; they're not in the
                      pending queue and are clearly not approvable (#4504). */}
                  {recentlyDecided.length > 0 && (
                    <div className="space-y-3 pt-2">
                      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        Recently decided
                      </p>
                      {recentlyDecided.map((proposal) => (
                        <ProposalCard
                          key={proposal.dbId ?? `decided-${proposal.index}`}
                          proposal={proposal}
                          onApprove={() => {}}
                          onReject={() => {}}
                          approving={false}
                          rejecting={false}
                        />
                      ))}
                    </div>
                  )}
                </div>
                </ScrollArea>
              </TabsContent>

              <TabsContent value="rejected" className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <ScrollArea className="min-h-0 flex-1 p-4">
                  <div className="space-y-3">
                    <MutationErrorSurface error={rejectedError} feature="Semantic Layer" onRetry={refetchRejected} />
                    <MutationErrorSurface error={mutationError} feature="Semantic Layer" />
                    {rejectedAmendments.length === 0 && !rejectedLoading && (
                      <div className="py-12 text-center text-xs text-muted-foreground">
                        No rejected amendments. When you reject a proposal it appears here — Reconsider brings it back to the pending queue.
                      </div>
                    )}
                    {rejectedLoading && rejectedAmendments.length === 0 && (
                      <div className="flex items-center justify-center py-12 text-xs text-muted-foreground">
                        <Loader2 className="size-3 animate-spin mr-2" />
                        Loading rejected amendments...
                      </div>
                    )}
                    {rejectedAmendments.map((a) => (
                      <RejectedCard
                        key={a.id}
                        amendment={a}
                        onReconsider={() => handleReconsider(a.id)}
                        reconsidering={isMutating(`reconsider-${a.id}`)}
                      />
                    ))}
                  </div>
                </ScrollArea>
              </TabsContent>
            </Tabs>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}
