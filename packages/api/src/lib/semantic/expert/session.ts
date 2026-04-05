/**
 * Conversation session state for interactive semantic expert mode.
 *
 * Tracks conversation history, accepted/rejected proposals, and provides
 * context for multi-turn agent interactions.
 */

import type { AnalysisResult } from "./types";

/** A proposal that the user has acted on. */
export interface ReviewedProposal {
  readonly result: AnalysisResult;
  readonly decision: "accepted" | "rejected" | "skipped";
  readonly decidedAt: Date;
}

/** A message in the conversation history. */
export interface ConversationMessage {
  readonly role: "assistant" | "user";
  readonly content: string;
}

/** Session state for interactive improvement mode. */
export interface SessionState {
  /** Ranked analysis results from the initial analysis. */
  readonly proposals: readonly AnalysisResult[];
  /** Index of the next proposal to present (advances as user reviews). */
  currentIndex: number;
  /** Proposals the user has acted on. */
  readonly reviewed: ReviewedProposal[];
  /** Conversation history for multi-turn context. */
  readonly messages: ConversationMessage[];
  /** Rejected proposal keys — format: "entityName:amendmentType:name". Agent should not re-suggest. */
  readonly rejectedKeys: Set<string>;
  /** When the session started. */
  readonly startedAt: Date;
}

/** Create a new session from initial analysis results. */
export function createSession(proposals: readonly AnalysisResult[]): SessionState {
  return {
    proposals: [...proposals],
    currentIndex: 0,
    reviewed: [],
    messages: [],
    rejectedKeys: new Set(),
    startedAt: new Date(),
  };
}

/** Get the next unreviewed proposal, or null if exhausted. */
export function nextProposal(session: SessionState): AnalysisResult | null {
  if (session.currentIndex >= session.proposals.length) return null;
  return session.proposals[session.currentIndex];
}

/** Record a user decision on the current proposal and advance the index. */
export function recordDecision(
  session: SessionState,
  decision: "accepted" | "rejected" | "skipped",
): void {
  const proposal = session.proposals[session.currentIndex];
  if (!proposal) return;

  session.reviewed.push({
    result: proposal,
    decision,
    decidedAt: new Date(),
  });

  if (decision === "rejected") {
    const amendment = proposal.amendment as Record<string, unknown>;
    const key = `${proposal.entityName}:${proposal.amendmentType}:${String(amendment.name ?? "")}`;
    session.rejectedKeys.add(key);
  }

  session.currentIndex++;
}

/** Add a message to the conversation history. */
export function addMessage(
  session: SessionState,
  role: "assistant" | "user",
  content: string,
): void {
  session.messages.push({ role, content });
}

/** Get session summary statistics. */
export function getSessionSummary(session: SessionState): {
  total: number;
  accepted: number;
  rejected: number;
  skipped: number;
  remaining: number;
} {
  const accepted = session.reviewed.filter((r) => r.decision === "accepted").length;
  const rejected = session.reviewed.filter((r) => r.decision === "rejected").length;
  const skipped = session.reviewed.filter((r) => r.decision === "skipped").length;

  return {
    total: session.proposals.length,
    accepted,
    rejected,
    skipped,
    remaining: session.proposals.length - session.currentIndex,
  };
}

/**
 * Build a system prompt context string summarizing session state.
 * Used to feed conversation context back into the agent for follow-up suggestions.
 */
export function buildSessionContext(session: SessionState): string {
  const summary = getSessionSummary(session);
  const lines: string[] = [
    `Session progress: ${session.currentIndex}/${session.proposals.length} proposals reviewed.`,
    `Accepted: ${summary.accepted}, Rejected: ${summary.rejected}, Skipped: ${summary.skipped}, Remaining: ${summary.remaining}.`,
  ];

  if (session.rejectedKeys.size > 0) {
    lines.push(
      `Rejected proposals (do not re-suggest): ${[...session.rejectedKeys].join(", ")}`,
    );
  }

  // Include recent conversation context (last 6 messages)
  const recentMessages = session.messages.slice(-6);
  if (recentMessages.length > 0) {
    lines.push("", "Recent conversation:");
    for (const msg of recentMessages) {
      lines.push(`  ${msg.role}: ${msg.content.slice(0, 200)}${msg.content.length > 200 ? "..." : ""}`);
    }
  }

  return lines.join("\n");
}
