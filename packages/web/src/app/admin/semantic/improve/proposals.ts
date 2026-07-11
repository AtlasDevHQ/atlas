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

// ---------------------------------------------------------------------------
// buildProposalQueue — the one Pending queue (#4504)
//
// The proposals panel renders a single data source: the org's Pending queue
// (per CONTEXT.md). A live conversation must never hide pre-existing pending
// Amendments — including ones the scheduler queued. So the approvable list is
// exactly `/pending`; the conversation only supplies *markers* (which rows it
// created, so they badge + sort to the top) and *decided rows* that never
// entered the queue (an auto-approved amendment is already live). The marker is
// presentation state, not a second data source — a proposal streamed this turn
// becomes approvable only once the refetch lands it in `/pending`.
// ---------------------------------------------------------------------------

export interface QueueRow extends Proposal {
  /**
   * True when this row's `dbId` was created by a `proposeAmendment` in the live
   * conversation. A presentation marker (badge + sort-to-top) only — the row's
   * approvability comes solely from the pending queue.
   */
  fromConversation: boolean;
}

/**
 * A queue row that is approvable. Approvable rows are undecided by construction,
 * so `ProposalQueue.pending.length` is the pending badge and the two can never
 * disagree (#4504) — the type, not just a runtime branch, holds that guarantee.
 */
export interface ApprovableRow extends QueueRow {
  decision: null;
}

export interface ProposalQueue {
  /**
   * The approvable Pending queue, conversation-created rows sorted to the top.
   * Its length is the pending badge; every row is `decision: null`.
   */
  pending: ApprovableRow[];
  /**
   * Presentation-only strip of rows decided this session (approve/reject) or
   * auto-applied in-flow. Never approvable; shown so the admin sees what just
   * happened.
   */
  recentlyDecided: QueueRow[];
}

/**
 * Merge the DB Pending queue with the live conversation into the panel's two
 * lists. `pending` is the sole source of approvable rows; `conversation` (from
 * {@link extractProposals}) contributes markers and auto-applied rows; and
 * `decisions` reflects approve/reject clicks this session so a decided row
 * leaves the approvable list immediately, before the refetch drops it.
 */
export function buildProposalQueue(args: {
  pending: Proposal[];
  conversation: Proposal[];
  decisions: Map<string, "accepted" | "rejected">;
}): ProposalQueue {
  const { pending, conversation, decisions } = args;

  const conversationIds = new Set(
    conversation.map((p) => p.dbId).filter((id): id is string => Boolean(id)),
  );

  // One entry per dbId. The pending queue is the sole source of approvable
  // rows; the conversation only adds rows not yet in it — an auto-applied one
  // surfaces in the decided strip, a just-streamed undecided one waits for the
  // refetch.
  interface Entry {
    id: string;
    row: Proposal;
    inPending: boolean;
    fromConversation: boolean;
  }
  const byId = new Map<string, Entry>();
  for (const row of pending) {
    if (!row.dbId) continue;
    byId.set(row.dbId, { id: row.dbId, row, inPending: true, fromConversation: conversationIds.has(row.dbId) });
  }
  for (const row of conversation) {
    if (!row.dbId || byId.has(row.dbId)) continue;
    byId.set(row.dbId, { id: row.dbId, row, inPending: false, fromConversation: true });
  }

  const pendingQueue: ApprovableRow[] = [];
  const recentlyDecided: QueueRow[] = [];
  for (const { id, row, inPending, fromConversation } of byId.values()) {
    // A session approve/reject wins over the row's own decision so the click
    // reflects before the refetch; otherwise a chat-streamed row carries its
    // `applied` (auto-approved) status.
    const decision = decisions.get(id) ?? row.decision;
    if (decision === null) {
      // Only rows actually in the pending queue are approvable — a proposal
      // streamed this turn but not yet refetched into `/pending` waits. The
      // narrowed `decision: null` makes each pushed row an `ApprovableRow`.
      if (inPending) pendingQueue.push({ ...row, decision, fromConversation });
    } else {
      recentlyDecided.push({ ...row, decision, fromConversation });
    }
  }

  return {
    pending: pendingQueue.toSorted(
      (a, b) => Number(b.fromConversation) - Number(a.fromConversation),
    ),
    recentlyDecided,
  };
}
