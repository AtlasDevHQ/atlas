"use client";

import { useState, useRef, useCallback, useMemo } from "react";
import { useChat, type UIMessage } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useAtlasConfig } from "@/ui/context";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
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
  const confidenceColor =
    proposal.confidence >= 0.8
      ? "text-green-600 dark:text-green-400"
      : proposal.confidence >= 0.5
        ? "text-yellow-600 dark:text-yellow-400"
        : "text-red-600 dark:text-red-400";

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
      if (part.type === "tool-invocation" && part.toolInvocation.toolName === "proposeAmendment") {
        const args = part.toolInvocation.args as Record<string, unknown> | undefined;
        if (args) {
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
  const scrollRef = useRef<HTMLDivElement>(null);

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

  const { messages, sendMessage, status } = useChat({ transport });
  const isLoading = status === "streaming" || status === "submitted";

  // Mutations for approve/reject
  const { mutate: mutateApprove, isMutating: isApproving } = useAdminMutation({
    method: "POST",
  });
  const { mutate: mutateReject, isMutating: isRejecting } = useAdminMutation({
    method: "POST",
  });

  // Extract proposals from messages
  const proposals = extractProposals(messages).map((p) => ({
    ...p,
    decision: proposalDecisions.get(p.index) ?? p.decision,
  }));

  const handleSend = useCallback(() => {
    if (!inputValue.trim() || isLoading) return;
    sendMessage({ role: "user", parts: [{ type: "text" as const, text: inputValue }] });
    setInputValue("");
  }, [inputValue, isLoading, sendMessage]);

  const handleRunAnalysis = useCallback(() => {
    sendMessage({
      role: "user",
      parts: [
        {
          type: "text" as const,
          text: "Analyze my semantic layer and identify the highest-impact improvements. Start with the most-queried tables and check for missing measures, stale descriptions, and undocumented joins.",
        },
      ],
    });
  }, [sendMessage]);

  const handleApprove = useCallback(
    async (index: number) => {
      const result = await mutateApprove({
        path: `/api/v1/admin/semantic-improve/proposals/${index}/approve`,
        itemId: `approve-${index}`,
      });
      if (result.ok) {
        setProposalDecisions((prev) => new Map(prev).set(index, "accepted"));
      }
    },
    [mutateApprove],
  );

  const handleReject = useCallback(
    async (index: number) => {
      const result = await mutateReject({
        path: `/api/v1/admin/semantic-improve/proposals/${index}/reject`,
        itemId: `reject-${index}`,
      });
      if (result.ok) {
        setProposalDecisions((prev) => new Map(prev).set(index, "rejected"));
      }
    },
    [mutateReject],
  );

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
        <ResizablePanelGroup direction="horizontal">
          {/* Chat panel */}
          <ResizablePanel defaultSize={55} minSize={35}>
            <div className="flex h-full flex-col">
              <ScrollArea className="flex-1 p-4" ref={scrollRef}>
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
                          if (part.type === "tool-invocation") {
                            const { toolName, state } = part.toolInvocation;
                            return (
                              <div key={i} className="my-1 text-xs text-muted-foreground">
                                <Badge variant="outline" className="text-[10px]">
                                  {toolName}
                                </Badge>
                                {state === "result" && (
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
                  {proposals.length === 0 && (
                    <div className="py-12 text-center text-xs text-muted-foreground">
                      Proposals will appear here as the agent identifies improvements.
                    </div>
                  )}
                  {proposals.map((proposal) => (
                    <ProposalCard
                      key={proposal.index}
                      proposal={proposal}
                      onApprove={() => handleApprove(proposal.index)}
                      onReject={() => handleReject(proposal.index)}
                      approving={isApproving(`approve-${proposal.index}`)}
                      rejecting={isRejecting(`reject-${proposal.index}`)}
                    />
                  ))}
                </div>
              </ScrollArea>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}
