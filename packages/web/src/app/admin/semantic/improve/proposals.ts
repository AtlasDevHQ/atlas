import { type UIMessage } from "@ai-sdk/react";
import { isToolUIPart, getToolName } from "ai";
import { getToolArgs, getToolResult } from "@/ui/lib/helpers";

// ---------------------------------------------------------------------------
// Proposal types + tool-result extraction for the semantic-improve page.
//
// Split out of page.tsx so `extractProposals` — the pure logic behind
// acceptance criterion #4 of #4484 (a `proposeAmendment` result that failed to
// persist must never render as an approvable card) — is unit-testable without a
// React harness.
// ---------------------------------------------------------------------------

export interface TestResult {
  success: boolean;
  rowCount: number;
  sampleRows: Record<string, unknown>[];
  error?: string;
}

export interface Proposal {
  index: number;
  entityName: string;
  category: string;
  amendmentType: string;
  amendment: Record<string, unknown>;
  rationale: string;
  diff?: string;
  testQuery?: string;
  testResult?: TestResult;
  confidence: number;
  impact?: number;
  score?: number;
  decision: "accepted" | "rejected" | "skipped" | null;
  /**
   * The proposal's `learned_patterns` row id — the key every review routes on.
   * Set for every rendered proposal: chat-streamed cards derive it from the
   * `proposeAmendment` tool result (see `extractProposals`), and pending-list
   * cards derive it from the DB row. A proposal without a `dbId` is
   * unreviewable and is never rendered.
   */
  dbId?: string;
}

/**
 * Parse approvable proposals from `proposeAmendment` tool results in the chat
 * message stream.
 *
 * Only results that carry a `proposalId` are surfaced. On the internal-DB path
 * (the admin web flow always has one) `proposeAmendment` persists each proposal
 * as a `learned_patterns` row and returns its id as `proposalId`; we carry it as
 * `dbId` so Approve/Reject route through the working `/amendments/{id}/review`
 * path (keyed on that exact row) rather than the dead in-memory
 * `/proposals/{index}` path. A result carrying `{ error }` (the tool failed —
 * bad/missing entity file, or a persist error — so no row exists) has no
 * `proposalId`, and an in-flight call has no result yet; both lack a `dbId` and
 * are skipped so no unapprovable card is rendered.
 */
export function extractProposals(messages: UIMessage[]): Proposal[] {
  const proposals: Proposal[] = [];
  let idx = 0;

  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const part of msg.parts) {
      if (isToolUIPart(part)) {
        let name: string;
        try { name = getToolName(part as Parameters<typeof getToolName>[0]); } catch { /* intentionally ignored: skip unrecognizable tool parts */ continue; }
        if (name !== "proposeAmendment") continue;
        const args = getToolArgs(part);
        if (args.entityName) {
          const result = getToolResult(part) as Record<string, unknown> | null;
          const dbId = typeof result?.proposalId === "string" ? result.proposalId : undefined;
          if (!dbId) continue;
          const diff = typeof result?.diff === "string" ? result.diff : undefined;
          const rawTR = result?.testResult;
          const testResult: Proposal["testResult"] | undefined =
            rawTR && typeof rawTR === "object" && !Array.isArray(rawTR) &&
            "success" in rawTR && typeof (rawTR as Record<string, unknown>).rowCount === "number"
              ? (rawTR as Proposal["testResult"])
              : undefined;
          proposals.push({
            index: idx++,
            entityName: String((args.entityName as string) ?? "unknown"),
            category: String((args.category as string) ?? ""),
            amendmentType: String((args.amendmentType as string) ?? ""),
            amendment: (args.amendment as Record<string, unknown>) ?? {},
            rationale: String((args.rationale as string) ?? ""),
            diff,
            testQuery: args.testQuery ? String(args.testQuery as string) : undefined,
            testResult,
            confidence: Number(args.confidence ?? 0.5),
            impact: Number(args.impact ?? 0.5),
            score: Number(args.score ?? 0.5),
            decision: null,
            dbId,
          });
        }
      }
    }
  }
  return proposals;
}
