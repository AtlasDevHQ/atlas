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
import { extractProposals, buildProposalQueue, type Proposal } from "../proposals";

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

// ---------------------------------------------------------------------------
// buildProposalQueue — the one Pending queue (#4504)
//
// A live conversation must never hide pre-existing pending Amendments; the
// approvable list is exactly the DB queue, the conversation only marks and
// decorates. These tests pin the queue merge + markers at the pure seam.
// ---------------------------------------------------------------------------

function mkProposal(dbId: string, overrides: Partial<Proposal> = {}): Proposal {
  return {
    index: 0,
    entityName: "orders",
    category: "",
    amendmentType: "add_measure",
    amendment: {},
    rationale: "",
    confidence: 0.8,
    decision: null,
    dbId,
    ...overrides,
  };
}

describe("buildProposalQueue", () => {
  it("returns two empty lists for empty inputs (initial render)", () => {
    const q = buildProposalQueue({ pending: [], conversation: [], decisions: new Map() });
    expect(q).toEqual({ pending: [], recentlyDecided: [] });
  });

  it("renders the pending queue as-is when there is no conversation", () => {
    const q = buildProposalQueue({
      pending: [mkProposal("a"), mkProposal("b")],
      conversation: [],
      decisions: new Map(),
    });

    expect(q.pending.map((p) => p.dbId)).toEqual(["a", "b"]);
    expect(q.pending.every((p) => !p.fromConversation)).toBe(true);
    expect(q.recentlyDecided).toEqual([]);
  });

  it("keeps pre-existing pending Amendments visible alongside conversation-created ones, marking and sorting the conversation row to the top", () => {
    // "b" was proposed this conversation and has landed in /pending (post-refetch).
    const q = buildProposalQueue({
      pending: [mkProposal("a"), mkProposal("b")],
      conversation: [mkProposal("b")],
      decisions: new Map(),
    });

    // Conversation row sorts to the top; the pre-existing one stays visible.
    expect(q.pending.map((p) => p.dbId)).toEqual(["b", "a"]);
    expect(q.pending.find((p) => p.dbId === "b")?.fromConversation).toBe(true);
    expect(q.pending.find((p) => p.dbId === "a")?.fromConversation).toBe(false);
  });

  it("sorts marked rows to the top in /pending order (not conversation order) and keeps each group's relative order", () => {
    // a and c were created this conversation; the conversation array is in a
    // different order than /pending to prove marked rows follow the DB queue's
    // order, not the extraction order (the stable-sort contract #4504 relies on).
    const q = buildProposalQueue({
      pending: [mkProposal("a"), mkProposal("b"), mkProposal("c"), mkProposal("d")],
      conversation: [mkProposal("c"), mkProposal("a")],
      decisions: new Map(),
    });

    expect(q.pending.map((p) => p.dbId)).toEqual(["a", "c", "b", "d"]);
    expect(q.pending.map((p) => p.fromConversation)).toEqual([true, true, false, false]);
  });

  it("treats the marker as presentation state, not a data source — a proposal not yet in /pending is not approvable until the refetch lands it", () => {
    const q = buildProposalQueue({
      pending: [mkProposal("a")],
      conversation: [mkProposal("b")], // just proposed; refetch pending
      decisions: new Map(),
    });

    expect(q.pending.map((p) => p.dbId)).toEqual(["a"]);
    expect(q.recentlyDecided).toEqual([]);
  });

  it("dedups by dbId — a conversation proposal already in /pending is marked once, not duplicated", () => {
    const q = buildProposalQueue({
      pending: [mkProposal("b")],
      conversation: [mkProposal("b")],
      decisions: new Map(),
    });

    expect(q.pending).toHaveLength(1);
    expect(q.pending[0]?.fromConversation).toBe(true);
  });

  it("keeps the pending badge and the panel in agreement — every approvable row is undecided", () => {
    const q = buildProposalQueue({
      pending: [mkProposal("a"), mkProposal("b"), mkProposal("c")],
      conversation: [mkProposal("b")],
      decisions: new Map([["a", "accepted"]]),
    });

    // The rendered approvable list is exactly the undecided pending rows
    // (the decided "a" dropped out), conversation-marked "b" sorted to the top.
    expect(q.pending.every((p) => p.decision === null)).toBe(true);
    expect(q.pending.map((p) => p.dbId)).toEqual(["b", "c"]);
  });

  it("moves a decided row out of the approvable queue into the recently-decided strip", () => {
    const q = buildProposalQueue({
      pending: [mkProposal("a"), mkProposal("b")],
      conversation: [],
      decisions: new Map([["a", "accepted"]]), // admin just approved a
    });

    expect(q.pending.map((p) => p.dbId)).toEqual(["b"]);
    expect(q.recentlyDecided.map((p) => ({ id: p.dbId, decision: p.decision }))).toEqual([
      { id: "a", decision: "accepted" },
    ]);
  });

  it("surfaces an auto-applied conversation proposal only in the recently-decided strip, never as approvable", () => {
    const q = buildProposalQueue({
      pending: [mkProposal("a")], // pre-existing pending, untouched
      conversation: [mkProposal("x", { decision: "applied" })], // auto-approved in-flow, never in /pending
      decisions: new Map(),
    });

    expect(q.pending.map((p) => p.dbId)).toEqual(["a"]);
    expect(
      q.recentlyDecided.map((p) => ({ id: p.dbId, decision: p.decision, marked: p.fromConversation })),
    ).toEqual([{ id: "x", decision: "applied", marked: true }]);
  });

  it("moves a locally-decided conversation row still in /pending to the strip, marked", () => {
    const q = buildProposalQueue({
      pending: [mkProposal("b")],
      conversation: [mkProposal("b")],
      decisions: new Map([["b", "rejected"]]),
    });

    expect(q.pending).toEqual([]);
    expect(
      q.recentlyDecided.map((p) => ({ id: p.dbId, decision: p.decision, marked: p.fromConversation })),
    ).toEqual([{ id: "b", decision: "rejected", marked: true }]);
  });

  it("keeps a decided conversation row in the strip after the refetch drops it from /pending", () => {
    // Steady state after approving a conversation-created row: the refetch has
    // removed it from /pending, but it's still in the message stream and the
    // session `decisions` map — it must linger in the strip, marked, never
    // approvable (the literal AC4 "lingering display" case).
    const q = buildProposalQueue({
      pending: [],
      conversation: [mkProposal("b")],
      decisions: new Map([["b", "accepted"]]),
    });

    expect(q.pending).toEqual([]);
    expect(
      q.recentlyDecided.map((p) => ({ id: p.dbId, decision: p.decision, marked: p.fromConversation })),
    ).toEqual([{ id: "b", decision: "accepted", marked: true }]);
  });

  it("ignores a stale decision whose row is in neither input — no phantom card", () => {
    // After a refetch drops a decided pre-existing row, its id lingers in the
    // session `decisions` map. It must not resurrect a card from nothing.
    const q = buildProposalQueue({
      pending: [],
      conversation: [],
      decisions: new Map([["ghost", "accepted"]]),
    });

    expect(q).toEqual({ pending: [], recentlyDecided: [] });
  });
});
