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
  /**
   * `null` = awaiting review (Approve/Reject shown). `accepted`/`rejected` =
   * decided by the admin in this session. `applied` = the tool auto-approved
   * and applied the amendment in-flow (#4499) — already live, nothing to
   * review. `skipped` is reserved (legacy in-memory flow).
   */
  decision: "accepted" | "rejected" | "skipped" | "applied" | null;
  /**
   * The proposal's `learned_patterns` row id — the key every review routes on.
   * Set for every rendered proposal: chat-streamed cards derive it from the
   * `proposeAmendment` tool result (see `extractProposals`), and pending-list
   * cards derive it from the DB row. A proposal without a `dbId` is
   * unreviewable and is never rendered.
   */
  dbId?: string;
  /**
   * Reason the last approve-apply failed (#4506). The decide seam returns a
   * failed approval to pending with this reason attached, so the card can
   * tell the admin WHY the amendment bounced instead of silently re-listing.
   * Only pending-list cards carry it (chat-streamed cards are pre-review).
   */
  applyError?: string;
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
 *
 * A result with `status: "auto_approved"` was already applied in-flow — its
 * `learned_patterns` row is `approved`, so `/amendments/{id}/review` (which
 * claims `WHERE status='pending'`) would 404 on it. It surfaces as
 * `decision: "applied"` — a decided card with no review actions (#4499).
 * `status: "queued"` (or a legacy result with no status) stays approvable.
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
            decision: result?.status === "auto_approved" ? "applied" : null,
            dbId,
          });
        }
      }
    }
  }
  return proposals;
}
