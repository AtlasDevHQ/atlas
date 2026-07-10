/**
 * Tests for extractProposals — the tool-result → approvable-card logic of the
 * semantic-improve page (#4484).
 *
 * The load-bearing invariant (acceptance criterion #4): a proposal is only
 * surfaced as an approvable card when its `proposeAmendment` tool result
 * carries a `proposalId` (⇒ a `learned_patterns` row exists). Results that
 * came back as `{ error }` (no row) and in-flight calls (no result yet) are
 * dropped so the UI never renders a card that would 404 on Approve/Reject.
 */

import { describe, it, expect } from "bun:test";
import type { UIMessage } from "@ai-sdk/react";
import { extractProposals } from "../proposals";

// Build an assistant message carrying a single proposeAmendment tool part.
// `output === undefined` models an in-flight call (no result yet).
function assistantWithTool(
  input: Record<string, unknown>,
  output?: Record<string, unknown>,
): UIMessage {
  return {
    id: "m1",
    role: "assistant",
    parts: [
      {
        type: "tool-proposeAmendment",
        toolCallId: "call-1",
        state: output ? "output-available" : "input-available",
        input,
        ...(output ? { output } : {}),
      },
    ],
  } as unknown as UIMessage;
}

const baseInput = {
  entityName: "orders",
  category: "measures",
  amendmentType: "add_measure",
  amendment: { name: "total_revenue" },
  rationale: "Frequently aggregated.",
  confidence: 0.9,
  impact: 0.8,
  score: 0.85,
};

describe("extractProposals", () => {
  it("surfaces a proposal with dbId when the tool result carries a proposalId", () => {
    const proposals = extractProposals([
      assistantWithTool(baseInput, { proposalId: "amd-1", diff: "--- a\n+++ b" }),
    ]);

    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      index: 0,
      entityName: "orders",
      amendmentType: "add_measure",
      dbId: "amd-1",
      diff: "--- a\n+++ b",
      decision: null,
    });
  });

  it("drops a result that came back as { error } (no proposalId ⇒ no DB row ⇒ unapprovable)", () => {
    const proposals = extractProposals([
      assistantWithTool(baseInput, { error: "Entity file not found: orders" }),
    ]);

    expect(proposals).toEqual([]);
  });

  it("drops an in-flight call that has no result yet", () => {
    const proposals = extractProposals([assistantWithTool(baseInput)]);

    expect(proposals).toEqual([]);
  });

  it("keeps only the persisted proposals and re-indexes them densely", () => {
    const proposals = extractProposals([
      assistantWithTool({ ...baseInput, entityName: "ok1" }, { proposalId: "amd-1" }),
      assistantWithTool({ ...baseInput, entityName: "failed" }, { error: "boom" }),
      assistantWithTool({ ...baseInput, entityName: "inflight" }),
      assistantWithTool({ ...baseInput, entityName: "ok2" }, { proposalId: "amd-2" }),
    ]);

    expect(proposals.map((p) => ({ index: p.index, entityName: p.entityName, dbId: p.dbId }))).toEqual([
      { index: 0, entityName: "ok1", dbId: "amd-1" },
      { index: 1, entityName: "ok2", dbId: "amd-2" },
    ]);
  });

  it("ignores non-assistant messages and non-proposeAmendment tool parts", () => {
    const userMsg = {
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "improve orders" }],
    } as unknown as UIMessage;
    const otherTool = {
      id: "a2",
      role: "assistant",
      parts: [
        { type: "tool-profileTable", toolCallId: "c", state: "output-available", input: { entityName: "orders" }, output: { proposalId: "not-a-proposal" } },
      ],
    } as unknown as UIMessage;

    expect(extractProposals([userMsg, otherTool])).toEqual([]);
  });

  // #4499 — a card must not offer a decision the server cannot accept. An
  // `auto_approved` result was already applied in-flow (its `learned_patterns`
  // row is `approved`), so `/amendments/{id}/review` — which claims
  // `WHERE status='pending'` — would 404 on it.
  it("renders an auto_approved result as already applied (no review actions)", () => {
    const proposals = extractProposals([
      assistantWithTool(baseInput, { proposalId: "amd-1", status: "auto_approved" }),
    ]);

    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ dbId: "amd-1", decision: "applied" });
  });

  it("renders a queued result as approvable (decision null)", () => {
    const proposals = extractProposals([
      assistantWithTool(baseInput, { proposalId: "amd-1", status: "queued" }),
    ]);

    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ dbId: "amd-1", decision: null });
  });

  it("renders a result with no status field as approvable (decision null)", () => {
    const proposals = extractProposals([
      assistantWithTool(baseInput, { proposalId: "amd-1" }),
    ]);

    expect(proposals[0]?.decision).toBeNull();
  });

  it("preserves a valid testResult and drops a malformed one", () => {
    const good = extractProposals([
      assistantWithTool(baseInput, {
        proposalId: "amd-1",
        testResult: { success: true, rowCount: 3, sampleRows: [] },
      }),
    ]);
    expect(good[0]?.testResult).toEqual({ success: true, rowCount: 3, sampleRows: [] });

    const bad = extractProposals([
      assistantWithTool(baseInput, { proposalId: "amd-2", testResult: { success: true } }),
    ]);
    expect(bad[0]?.testResult).toBeUndefined();
  });
});
