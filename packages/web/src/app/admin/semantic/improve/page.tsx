"use client";

import { useState, useRef, useMemo } from "react";
import { useChat, type UIMessage } from "@ai-sdk/react";
import { DefaultChatTransport, isToolUIPart, getToolName } from "ai";
import { getToolArgs } from "@/ui/lib/helpers";
import { useAtlasConfig } from "@/ui/context";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
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

interface Proposal {
  index: number;
  entityName: string;
  category: string;
  amendmentType: string;
  amendment: Record<string, unknown>;
  rationale: string;
  testQuery?: string;
  confidence: number;
  impact: number;
  score: number;
  decision: "accepted" | "rejected" | "skipped" | null;
  /** DB row id for pending amendments loaded from previous sessions. */
  dbId?: string;
}

interface PendingAmendment {
  id: string;
  entityName: string;
  description: string | null;
  confidence: number;
  amendmentType: string | null;
  amendment: Record<string, unknown> | null;
  rationale: string | null;
  testQuery: string | null;
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
}: {
  proposal: Proposal;
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
          </CardTitle>
          <div className="flex items-center gap-2">
            <span className={`text-xs font-medium ${confidenceColor}`}>
              {Math.round(proposal.confidence * 100)}% confidence
            </span>
            {decided && (
              <Badge
                variant={proposal.decision === "accepted" ? "default" : "secondary"}
                className="text-[10px]"
              >
                {proposal.decision}
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="py-2 space-y-3">
        <p className="text-sm text-muted-foreground">{proposal.rationale}</p>

        {/* Amendment preview */}
        <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs font-mono whitespace-pre-wrap">
          {formatAmendment(proposal.amendmentType, proposal.amendment)}
        </pre>

        {proposal.testQuery && (
          <div className="text-xs text-muted-foreground">
            <span className="font-medium">Test query:</span>{" "}
            <code className="rounded bg-muted px-1 py-0.5">{proposal.testQuery}</code>
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
        lines.push(`  ${k}: ${String(v)}`);
      }
    } else if (Array.isArray(value)) {
      lines.push(`${key}: [${value.join(", ")}]`);
    } else {
      lines.push(`${key}: ${String(value)}`);
    }
  }
  return lines.join("\n") || `(${type})`;
}

// ---------------------------------------------------------------------------
// Extract proposals from assistant messages
// ---------------------------------------------------------------------------

/** Try to parse proposals from tool call results in the messages. */
function extractProposals(messages: UIMessage[]): Proposal[] {
  const proposals: Proposal[] = [];
  let idx = 0;

  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const part of msg.parts) {
      if (isToolUIPart(part)) {
        let name: string;
        try { name = getToolName(part as Parameters<typeof getToolName>[0]); } catch { continue; }
        if (name !== "proposeAmendment") continue;
        const args = getToolArgs(part);
        if (args.entityName) {
          proposals.push({
            index: idx++,
            entityName: String(args.entityName ?? "unknown"),
            category: String(args.category ?? ""),
            amendmentType: String(args.amendmentType ?? ""),
            amendment: (args.amendment as Record<string, unknown>) ?? {},
            rationale: String(args.rationale ?? ""),
            testQuery: args.testQuery ? String(args.testQuery) : undefined,
            confidence: Number(args.confidence ?? 0.5),
            impact: Number(args.impact ?? 0.5),
            score: Number(args.score ?? 0.5),
            decision: null,
          });
        }
      }
    }
  }
  return proposals;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function SemanticImprovePage() {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const [inputValue, setInputValue] = useState("");
  const [proposalDecisions, setProposalDecisions] = useState<
    Map<number, "accepted" | "rejected">
  >(new Map());

  // Transport for the semantic expert agent endpoint
  const sessionIdRef = useRef<string | null>(null);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: `${apiUrl}/api/v1/admin/semantic-improve/chat`,
        credentials: isCrossOrigin ? "include" : undefined,
        body: () =>
          sessionIdRef.current
            ? { sessionId: sessionIdRef.current }
            : {},
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const response = await globalThis.fetch(input, init);
          const sid = response.headers.get("x-session-id");
          if (sid) sessionIdRef.current = sid;
          return response;
        }) as typeof fetch,
      }),
    [apiUrl, isCrossOrigin],
  );

  const { messages, sendMessage, status, error: chatError } = useChat({ transport });
  const isLoading = status === "streaming" || status === "submitted";

  // Fetch pending amendments from the DB (created by previous sessions)
  const { data: pendingData, loading: pendingLoading, refetch: refetchPending } =
    useAdminFetch<{ amendments: PendingAmendment[] }>("/api/v1/admin/semantic-improve/pending");

  // Mutations for approve/reject
  const { mutate: mutateApprove, isMutating: isApproving, error: approveError } = useAdminMutation({
    method: "POST",
  });
  const { mutate: mutateReject, isMutating: isRejecting, error: rejectError } = useAdminMutation({
    method: "POST",
  });
  const mutationError = approveError || rejectError;

  // Convert DB pending amendments to Proposal shape for display
  const pendingAmendments: Proposal[] = (pendingData?.amendments ?? []).map((a, i) => ({
    index: i,
    entityName: a.entityName,
    category: "",
    amendmentType: a.amendmentType ?? "unknown",
    amendment: a.amendment ?? {},
    rationale: a.rationale ?? a.description ?? "",
    testQuery: a.testQuery ?? undefined,
    confidence: a.confidence,
    impact: 0.5,
    score: a.confidence,
    decision: null,
    dbId: a.id,
  }));

  // Extract proposals from current chat session messages
  const chatProposals = extractProposals(messages).map((p) => ({
    ...p,
    decision: proposalDecisions.get(p.index) ?? p.decision,
  }));

  // Show chat proposals when a session is active, otherwise show DB pending
  const proposals = chatProposals.length > 0 ? chatProposals : pendingAmendments;

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

  async function handleApprove(proposal: Proposal) {
    if (proposal.dbId) {
      const result = await mutateApprove({
        path: `/api/v1/admin/semantic-improve/amendments/${proposal.dbId}/review`,
        itemId: `approve-${proposal.dbId}`,
        body: { decision: "approved" },
      });
      if (result.ok) refetchPending();
    } else {
      const result = await mutateApprove({
        path: `/api/v1/admin/semantic-improve/proposals/${proposal.index}/approve`,
        itemId: `approve-${proposal.index}`,
      });
      if (result.ok) {
        setProposalDecisions((prev) => new Map(prev).set(proposal.index, "accepted"));
      }
    }
  }

  async function handleReject(proposal: Proposal) {
    if (proposal.dbId) {
      const result = await mutateReject({
        path: `/api/v1/admin/semantic-improve/amendments/${proposal.dbId}/review`,
        itemId: `reject-${proposal.dbId}`,
        body: { decision: "rejected" },
      });
      if (result.ok) refetchPending();
    } else {
      const result = await mutateReject({
        path: `/api/v1/admin/semantic-improve/proposals/${proposal.index}/reject`,
        itemId: `reject-${proposal.index}`,
      });
      if (result.ok) {
        setProposalDecisions((prev) => new Map(prev).set(proposal.index, "rejected"));
      }
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 border-b px-6 py-4">
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
      <div className="flex-1 overflow-hidden">
        <ResizablePanelGroup orientation="horizontal">
          {/* Chat panel */}
          <ResizablePanel defaultSize={55} minSize={35}>
            <div className="flex h-full flex-col">
              <ScrollArea className="flex-1 p-4">
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
                    className="min-h-[40px] max-h-[120px] resize-none text-sm"
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
            <div className="flex h-full flex-col">
              <div className="border-b px-4 py-3">
                <h2 className="text-sm font-semibold">
                  Proposals
                  {proposals.length > 0 && (
                    <span className="ml-2 text-muted-foreground font-normal">
                      ({proposals.filter((p) => p.decision === null).length} pending)
                    </span>
                  )}
                </h2>
              </div>
              <ScrollArea className="flex-1 p-4">
                <div className="space-y-3">
                  {mutationError && (
                    <ErrorBanner message={mutationError} />
                  )}
                  {proposals.length === 0 && !pendingLoading && (
                    <div className="py-12 text-center text-xs text-muted-foreground">
                      {messages.length === 0
                        ? "No pending improvements. Run an analysis to identify opportunities."
                        : "Proposals will appear here as the agent identifies improvements."}
                    </div>
                  )}
                  {pendingLoading && proposals.length === 0 && (
                    <div className="flex items-center justify-center py-12 text-xs text-muted-foreground">
                      <Loader2 className="size-3 animate-spin mr-2" />
                      Loading pending amendments...
                    </div>
                  )}
                  {proposals.map((proposal) => {
                    const itemKey = proposal.dbId ?? `chat-${proposal.index}`;
                    return (
                      <ProposalCard
                        key={itemKey}
                        proposal={proposal}
                        onApprove={() => handleApprove(proposal)}
                        onReject={() => handleReject(proposal)}
                        approving={isApproving(proposal.dbId ? `approve-${proposal.dbId}` : `approve-${proposal.index}`)}
                        rejecting={isRejecting(proposal.dbId ? `reject-${proposal.dbId}` : `reject-${proposal.index}`)}
                      />
                    );
                  })}
                </div>
              </ScrollArea>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}
