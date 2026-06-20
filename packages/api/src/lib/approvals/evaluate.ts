/**
 * Origin-scoping match predicate for approval rules (#2072; "surface"
 * renamed to "origin" in ADR-0015).
 *
 * The DB-side filter in `ee/governance/approval.ts` uses
 *   WHERE org_id = $1 AND enabled = true AND (origin = 'any' OR origin = $2)
 * with `$2` set to the request's origin (or NULL when unknown). This file
 * exists so the same matching contract lives in code we can unit-test
 * directly without a DB mock — and so post-fetch filtering (defense in
 * depth) shares one source of truth with the SQL filter.
 *
 * Semantics:
 *   - `origin = 'any'` rule  →  fires for every request (preserves
 *     pre-2072 behavior; this is the migration default).
 *   - `origin = '<value>'` rule  →  fires only when the request stamped
 *     that exact origin on its RequestContext.
 *   - Unknown request origin  →  only `'any'` rules match. A rule pinned
 *     to a specific origin (e.g. `'mcp'`) does NOT match an unknown-
 *     origin request. This is *scope isolation*, not the F-54/F-55
 *     governance fail-closed: if a route forgets to stamp an origin, an
 *     `'any'` rule still fires (so governance is preserved); only the
 *     origin-scoped rules become dormant for that caller. The true
 *     governance fail-closed lives in `checkApprovalRequired`'s
 *     `identityMissing` path.
 */

import type { ModelMessage } from "ai";
import {
  APPROVAL_RULE_ORIGINS,
  REQUEST_ORIGINS,
  type ApprovalRuleOrigin,
  type RequestOrigin,
} from "./types";

export { APPROVAL_RULE_ORIGINS, REQUEST_ORIGINS };
export type { ApprovalRuleOrigin, RequestOrigin };

/**
 * True when a rule with `ruleOrigin` matches a request originating from
 * `requestOrigin`. See module-level comment for the matching contract.
 */
export function originMatchesRule(
  ruleOrigin: ApprovalRuleOrigin,
  requestOrigin: RequestOrigin | undefined,
): boolean {
  if (ruleOrigin === "any") return true;
  return ruleOrigin === requestOrigin;
}

/**
 * Filter an in-memory rule array by origin. Mirrors the SQL-side filter
 * exactly so callers can post-verify or test the matching without
 * round-tripping the DB.
 */
export function selectMatchingRulesByOrigin<T extends { origin: ApprovalRuleOrigin }>(
  rules: readonly T[],
  requestOrigin: RequestOrigin | undefined,
): T[] {
  return rules.filter((rule) => originMatchesRule(rule.origin, requestOrigin));
}

// ── Approval-park transcript helpers (#3748, ADR-0020 phase 3) ──────────────
//
// When `executeSQL`'s approval gate fires, it returns a needs-approval result
// (`{ approval_required: true, approval_request_id, ... }`) instead of executing.
// The agent loop (`lib/agent.ts`) detects that result in the just-finished step,
// stops the turn (no further model calls), and checkpoints the run as `parked`
// carrying the approval-queue ref. When the queue decision lands, the resolver
// (`lib/durable-resume.ts`) REPLACES the needs-approval tool result in the stored
// transcript with a decision result — approved (re-run unblocked by
// `hasApprovedRequest`) or denied — and flips the run back to resumable.
//
// Both the loop's detection and the resolver's rewrite key off the same two
// result fields, so the contract lives here next to the rule-origin matcher
// rather than being re-derived at each site.

/** Result-shape key `executeSQL` stamps `true` on a needs-approval tool result. */
export const APPROVAL_REQUIRED_RESULT_KEY = "approval_required";
/** Result-shape key carrying the approval-queue request id on that result. */
export const APPROVAL_REQUEST_ID_RESULT_KEY = "approval_request_id";

/** A needs-approval tool result located in a transcript. */
export interface ApprovalParkSignal {
  /** The approval-queue request id the gate created — stored as `parked_reason`. */
  readonly approvalRequestId: string;
  /**
   * The tool-call id whose result is the needs-approval marker. Carried for
   * diagnostics / future transcript surgery (e.g. surfacing which call parked);
   * the loop and resolver key off {@link ApprovalParkSignal.approvalRequestId},
   * so this is intentionally not read on the hot path today.
   */
  readonly toolCallId: string;
}

/** The decision an approval-queue reviewer made on a parked request. */
export type ApprovalDecision = "approve" | "deny";

/**
 * Pull the decoded JSON value out of a tool-result `output`. Tool results are
 * stored as `{ type: "json", value }` (the executeSQL path) but a result that
 * was stringified (`{ type: "text", value }`) is parsed best-effort so the
 * detector is robust to either encoding. Anything else yields `undefined`.
 */
function decodeToolOutput(output: unknown): Record<string, unknown> | undefined {
  if (!output || typeof output !== "object") return undefined;
  const o = output as { type?: unknown; value?: unknown };
  if (o.type === "json" && o.value && typeof o.value === "object") {
    return o.value as Record<string, unknown>;
  }
  if (o.type === "text" && typeof o.value === "string") {
    try {
      const parsed = JSON.parse(o.value);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
    } catch {
      // intentionally ignored: a non-JSON text output simply isn't a park marker.
      return undefined;
    }
  }
  return undefined;
}

/** True when a decoded tool-result value is `executeSQL`'s needs-approval marker. */
function isNeedsApprovalValue(value: Record<string, unknown> | undefined): value is Record<string, unknown> {
  return (
    !!value &&
    value[APPROVAL_REQUIRED_RESULT_KEY] === true &&
    typeof value[APPROVAL_REQUEST_ID_RESULT_KEY] === "string"
  );
}

/**
 * Scan a transcript (or a single step's `response.messages`) for a needs-approval
 * `executeSQL` tool result and return its approval-queue ref + tool-call id.
 *
 * Returns the LAST such result so a turn that surfaced more than one (e.g. a
 * resumed turn that re-parked on a second gated query) reports the one the turn
 * actually parked on. Returns `undefined` when there is no needs-approval result
 * — the normal, non-parking case.
 */
export function findApprovalParkSignal(
  messages: readonly ModelMessage[] | undefined,
): ApprovalParkSignal | undefined {
  if (!messages) return undefined;
  let signal: ApprovalParkSignal | undefined;
  for (const msg of messages) {
    if (!msg || msg.role !== "tool" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (!part || typeof part !== "object") continue;
      const p = part as { type?: unknown; toolCallId?: unknown; output?: unknown };
      if (p.type !== "tool-result" || typeof p.toolCallId !== "string") continue;
      const value = decodeToolOutput(p.output);
      if (isNeedsApprovalValue(value)) {
        signal = { approvalRequestId: value[APPROVAL_REQUEST_ID_RESULT_KEY] as string, toolCallId: p.toolCallId };
      }
    }
  }
  return signal;
}

/**
 * Build the resolved tool-result value that REPLACES the needs-approval marker
 * once a reviewer approves/denies the parked request. The agent reads this on
 * resume: an approval tells it to re-run the gated query (now unblocked because
 * the approval flipped the queue row to `approved`, which `hasApprovedRequest`
 * reads), a denial tells it to surface the rejection to the user and not retry.
 */
function buildDecisionResult(
  approvalRequestId: string,
  decision: ApprovalDecision,
  opts?: { reviewerLabel?: string | null; comment?: string | null },
): Record<string, unknown> {
  const by = opts?.reviewerLabel ? ` by ${opts.reviewerLabel}` : "";
  const comment = opts?.comment ? ` Reviewer comment: ${opts.comment}` : "";
  if (decision === "approve") {
    return {
      // `success: false` is intentional even though the request was APPROVED: the
      // gated query did NOT execute here (the approval only unblocks it). This
      // result is not a terminal failure — `message` directs the model to re-run
      // the same call on resume, which now passes the gate (`hasApprovedRequest`
      // reads the queue row the approval flipped to `approved`).
      success: false,
      [APPROVAL_REQUIRED_RESULT_KEY]: false,
      approval_resolved: "approved",
      [APPROVAL_REQUEST_ID_RESULT_KEY]: approvalRequestId,
      message:
        `Approval request ${approvalRequestId} was APPROVED${by}.${comment} ` +
        `Re-run the same query now to retrieve the results.`,
      executionMs: 0,
    };
  }
  return {
    success: false,
    [APPROVAL_REQUIRED_RESULT_KEY]: false,
    approval_resolved: "denied",
    [APPROVAL_REQUEST_ID_RESULT_KEY]: approvalRequestId,
    message:
      `Approval request ${approvalRequestId} was DENIED${by}.${comment} ` +
      `Do not retry the query; tell the user it was not approved.`,
    executionMs: 0,
  };
}

/** Outcome of {@link applyApprovalDecision}: the rewritten transcript plus whether anything changed. */
export interface ApprovalDecisionRewrite {
  /**
   * A NEW transcript with the needs-approval result replaced — or the original
   * array unchanged when `changed` is false (the source is never mutated).
   */
  readonly transcript: ModelMessage[];
  /**
   * True iff a needs-approval result matching `approvalRequestId` was found and
   * rewritten. False means the transcript carried no such marker — the caller
   * MUST treat this as a fail-closed signal (do not arm a resume against a
   * transcript that still reads "needs approval"), not as a benign no-op.
   */
  readonly changed: boolean;
}

/**
 * Return a NEW transcript with the needs-approval tool result for
 * `approvalRequestId` replaced by a resolved decision result, plus a `changed`
 * flag reporting whether a matching marker was actually found. The original
 * transcript is not mutated (a fresh array is returned, and only the one changed
 * tool message is rebuilt). When no matching needs-approval result is found the
 * transcript is returned unchanged and `changed` is false — the resolver uses
 * that to fail closed (leave the run parked) rather than arm an un-rewritten turn.
 */
export function applyApprovalDecision(
  transcript: readonly ModelMessage[],
  approvalRequestId: string,
  decision: ApprovalDecision,
  opts?: { reviewerLabel?: string | null; comment?: string | null },
): ApprovalDecisionRewrite {
  const decisionValue = buildDecisionResult(approvalRequestId, decision, opts);
  let rewrote = false;
  const rewritten = transcript.map((msg) => {
    if (!msg || msg.role !== "tool" || !Array.isArray(msg.content)) return msg;
    let changed = false;
    const content = msg.content.map((part) => {
      if (!part || typeof part !== "object") return part;
      const p = part as { type?: unknown; output?: unknown };
      if (p.type !== "tool-result") return part;
      const value = decodeToolOutput(p.output);
      if (
        isNeedsApprovalValue(value) &&
        value[APPROVAL_REQUEST_ID_RESULT_KEY] === approvalRequestId
      ) {
        changed = true;
        rewrote = true;
        return { ...(part as object), output: { type: "json" as const, value: decisionValue } };
      }
      return part;
    });
    return changed ? ({ ...msg, content } as ModelMessage) : msg;
  });
  return { transcript: rewritten, changed: rewrote };
}
