"use client";

import { useState, useMemo, useEffect } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, isToolUIPart, getToolName } from "ai";
import { extractProposals, buildProposalQueue, type Proposal, type QueueRow, type TestResult } from "./proposals";
import { useAtlasConfig } from "@/ui/context";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { MutationErrorSurface } from "@/ui/components/admin/mutation-error-surface";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import {
  Sparkles,
  Send,
  Check,
  X,
  Play,
  ArrowLeft,
  Loader2,
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
  diff: string | null;
  testQuery: string | null;
  testResult: TestResult | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// DiffViewer — color-coded unified diff
// ---------------------------------------------------------------------------

function diffLineStyle(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) {
    return "text-muted-foreground bg-muted font-semibold";
  }
  if (line.startsWith("@@")) {
    return "text-violet-600 dark:text-violet-400 bg-violet-50 dark:bg-violet-950/30";
  }
  if (line.startsWith("+")) {
    return "text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-950/30";
  }
  if (line.startsWith("-")) {
    return "text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/30";
  }
  return "text-muted-foreground";
}

function DiffViewer({ diff }: { diff: string }) {
  return (
    <pre className="rounded-md border text-xs font-mono p-0 m-0 whitespace-pre-wrap break-words">
      {diff.split("\n").map((line, i) => (
        <div key={i} className={`px-3 py-0.5 ${diffLineStyle(line)}`}>
          {line || "\u00A0"}
        </div>
      ))}
    </pre>
  );
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
}: {
  proposal: QueueRow;
  onApprove: () => void;
  onReject: () => void;
  approving: boolean;
  rejecting: boolean;
}) {
  let confidenceColor = "text-red-600 dark:text-red-400";
  if (proposal.confidence >= 0.8) {
    confidenceColor = "text-green-600 dark:text-green-400";
  } else if (proposal.confidence >= 0.5) {
    confidenceColor = "text-yellow-600 dark:text-yellow-400";
  }

  const decided = proposal.decision !== null;

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

        {/* Diff view when available, otherwise amendment preview */}
        {proposal.diff ? (
          <DiffViewer diff={proposal.diff} />
        ) : (
          <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs font-mono whitespace-pre-wrap">
            {formatAmendment(proposal.amendmentType, proposal.amendment)}
          </pre>
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

        {!decided && (
          <div className="flex items-center gap-2 pt-1">
            <Button
              size="sm"
              onClick={onApprove}
              disabled={approving || rejecting}
              className="gap-1.5 text-xs"
            >
              {approving ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Check className="size-3" />
              )}
              Approve
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

/** Format amendment data for display. */
function formatAmendment(type: string, amendment: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(amendment)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "object" && !Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        lines.push(`  ${k}: ${String(v as string)}`);
      }
    } else if (Array.isArray(value)) {
      lines.push(`${key}: [${value.join(", ")}]`);
    } else {
      lines.push(`${key}: ${String(value as string)}`);
    }
  }
  return lines.join("\n") || `(${type})`;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function SemanticImprovePage() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const [inputValue, setInputValue] = useState("");
  // Keyed by the proposal's DB row id (`dbId`) so a decision made on a
  // chat-streamed card survives re-renders and pending-list refetches — the
  // card is re-derived from the message stream each render, so an index-keyed
  // decision would drift as proposals stream in.
  const [proposalDecisions, setProposalDecisions] = useState<
    Map<string, "accepted" | "rejected">
  >(new Map());

  // Transport for the semantic expert agent endpoint. The conversation lives
  // entirely in this component's useChat state — there is no server-side
  // session resource to round-trip (#4503).
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: `${apiUrl}/api/v1/admin/semantic-improve/chat`,
        credentials: isCrossOrigin ? "include" : undefined,
      }),
    [apiUrl, isCrossOrigin],
  );

  const { messages, sendMessage, status, error: chatError } = useChat({ transport });
  const isLoading = status === "streaming" || status === "submitted";

  // Fetch pending amendments from the DB (created by earlier conversations
  // or the expert scheduler)
  const { data: pendingData, loading: pendingLoading, error: pendingError, refetch: refetchPending } =
    useAdminFetch<{ amendments: PendingAmendment[] }>("/api/v1/admin/semantic-improve/pending");

  // Single mutation hook for approve/reject
  const { mutate, isMutating, error: mutationError } = useAdminMutation({
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
    testQuery: a.testQuery ?? undefined,
    testResult: a.testResult ?? undefined,
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

  function handleRunAnalysis() {
    sendMessage({
      role: "user",
      parts: [
        {
          type: "text" as const,
          text: "Analyze my semantic layer and identify the highest-impact improvements. Start with the most-queried tables and check for missing measures, stale descriptions, and undocumented joins.",
        },
      ],
    }).catch((err: unknown) => {
      console.error("Failed to start analysis:", err instanceof Error ? err.message : String(err));
    });
  }

  async function handleReview(proposal: Proposal, decision: "approved" | "rejected") {
    // Every rendered proposal — chat-streamed or loaded from the pending list —
    // carries the `learned_patterns` row id, so all reviews go through the one
    // DB-backed review path.
    const dbId = proposal.dbId;
    if (!dbId) return;
    const label = decision === "approved" ? "approve" : "reject";
    const result = await mutate({
      path: `/api/v1/admin/semantic-improve/amendments/${dbId}/review`,
      itemId: `${label}-${dbId}`,
      body: { decision },
    });
    if (result.ok) {
      // Mark the card decided (chat cards persist across renders) and refresh
      // the pending list so a reviewed row drops out of it.
      setProposalDecisions((prev) =>
        new Map(prev).set(dbId, decision === "approved" ? "accepted" : "rejected"),
      );
      void refetchPending();
    }
  }

  return (
    <div className="flex h-[calc(100dvh-4rem)] flex-col overflow-hidden">
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
        {messages.length === 0 && (
          <Button onClick={handleRunAnalysis} className="gap-1.5">
            <Play className="size-4" />
            Run Analysis
          </Button>
        )}
      </div>

      {/* Split view */}
      <div className="min-h-0 flex-1 overflow-hidden">
        <ResizablePanelGroup orientation="horizontal">
          {/* Chat panel */}
          <ResizablePanel defaultSize={55} minSize={35}>
            <div className="flex h-full min-h-0 flex-col">
              <ScrollArea className="min-h-0 flex-1 p-4">
                <div className="space-y-4 pb-4">
                  {messages.length === 0 && (
                    <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground">
                      <Sparkles className="size-10 opacity-40 mb-3" />
                      <p className="text-sm font-medium">
                        Start an improvement session
                      </p>
                      <p className="mt-1 text-xs max-w-sm">
                        Click &ldquo;Run Analysis&rdquo; for autonomous mode, or type a message
                        to guide the expert agent toward specific improvements.
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
                            return <p key={i} className="whitespace-pre-wrap">{part.text}</p>;
                          }
                          if (isToolUIPart(part)) {
                            let toolName = "tool";
                            try { toolName = getToolName(part as Parameters<typeof getToolName>[0]); } catch { /* intentionally ignored: unknown tool */ }
                            const state = (part as Record<string, unknown>).state;
                            return (
                              <div key={i} className="my-1 text-xs text-muted-foreground">
                                <Badge variant="outline" className="text-[10px]">
                                  {toolName}
                                </Badge>
                                {state === "output-available" && (
                                  <span className="ml-1 text-green-600 dark:text-green-400">done</span>
                                )}
                                {state === "call" && (
                                  <Loader2 className="ml-1 inline size-3 animate-spin" />
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

              {/* Error display */}
              {chatError && (
                <div className="border-t bg-destructive/10 px-4 py-3 text-sm text-destructive">
                  <p className="font-medium">Analysis failed</p>
                  <p className="text-xs mt-1">
                    {chatError.message || "An error occurred while communicating with the expert agent."}
                  </p>
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
            <div className="flex h-full min-h-0 flex-col">
              <div className="shrink-0 border-b px-4 py-3">
                <h2 className="text-sm font-semibold">
                  Proposals
                  {proposals.length > 0 && (
                    <span className="ml-2 text-muted-foreground font-normal">
                      {/* Every row here is approvable, so this badge can never
                          disagree with the rendered queue (#4504). */}
                      ({proposals.length} pending)
                    </span>
                  )}
                </h2>
              </div>
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
                    return (
                      <ProposalCard
                        key={itemKey}
                        proposal={proposal}
                        onApprove={() => handleReview(proposal, "approved")}
                        onReject={() => handleReview(proposal, "rejected")}
                        approving={isMutating(`approve-${idSuffix}`)}
                        rejecting={isMutating(`reject-${idSuffix}`)}
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
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}
