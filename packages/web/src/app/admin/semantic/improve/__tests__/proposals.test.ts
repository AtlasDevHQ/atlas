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
import { extractProposals, buildProposalQueue, buildReviewBody, classifyReviewResult, toolPartStatus, type Proposal } from "../proposals";
import type { FetchError } from "@/ui/lib/fetch-error";
import type { MutateResult } from "@/ui/hooks/use-admin-mutation";

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

  it("carries a deferred testResult through (draft-only entity, #4614)", () => {
    // A draft-only entity's test query is deferred, not run: success:false but
    // deferred:true, so the card renders a neutral note, not a red failure.
    const deferred = extractProposals([
      assistantWithTool(baseInput, {
        proposalId: "amd-1",
        testResult: { success: false, rowCount: 0, sampleRows: [], deferred: true },
      }),
    ]);
    expect(deferred[0]?.testResult).toEqual({
      success: false,
      rowCount: 0,
      sampleRows: [],
      deferred: true,
    });
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

// ---------------------------------------------------------------------------
// classifyReviewResult — the review-interaction outcome (#4511)
// ---------------------------------------------------------------------------

function err(partial: Partial<FetchError>): MutateResult<unknown> {
  return { ok: false, error: { message: "x", ...partial } };
}

describe("classifyReviewResult (#4511)", () => {
  it("ok on a successful mutation", () => {
    expect(classifyReviewResult({ ok: true, data: undefined })).toEqual({ kind: "ok" });
  });

  it("stale when a 409 stale_baseline carries the fresh diff + hash", () => {
    const outcome = classifyReviewResult(
      err({ status: 409, code: "stale_baseline", stale: { diff: "--- a\n+++ b\n+x", baselineHash: "bh" } }),
    );
    expect(outcome).toEqual({ kind: "stale", diff: "--- a\n+++ b\n+x", baselineHash: "bh" });
  });

  it("falls back to error when stale_baseline is missing its payload (never a broken confirm)", () => {
    const outcome = classifyReviewResult(err({ status: 409, code: "stale_baseline" }));
    expect(outcome.kind).toBe("error");
  });

  it("ambiguous when a 409 entity_ambiguous carries candidate groups", () => {
    const outcome = classifyReviewResult(
      err({ status: 409, code: "entity_ambiguous", groups: ["us_prod", "eu_prod"] }),
    );
    expect(outcome).toEqual({ kind: "ambiguous", groups: ["us_prod", "eu_prod"] });
  });

  it("preserves a null candidate group (legacy / global) so the picker can offer it", () => {
    const outcome = classifyReviewResult(
      err({ status: 409, code: "entity_ambiguous", groups: [null, "eu_prod"] }),
    );
    expect(outcome).toEqual({ kind: "ambiguous", groups: [null, "eu_prod"] });
  });

  it("the picker never appears without candidate groups — an empty groups list is a plain error", () => {
    const outcome = classifyReviewResult(err({ status: 409, code: "entity_ambiguous", groups: [] }));
    expect(outcome.kind).toBe("error");
  });

  it("any other failure is a plain error surfaced through the banner", () => {
    const outcome = classifyReviewResult(err({ status: 500, code: "internal_error", message: "boom" }));
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") expect(outcome.error.message).toBe("boom");
  });
});

// ---------------------------------------------------------------------------
// buildReviewBody — the review request contract (#4511)
// ---------------------------------------------------------------------------

describe("buildReviewBody (#4511)", () => {
  it("approve carries the hash-carried claim", () => {
    expect(buildReviewBody("approved", { baselineHash: "bh" })).toEqual({
      decision: "approved",
      baselineHash: "bh",
    });
  });

  it("a confirm carries the FRESH hash it was given (not a stale one)", () => {
    // handleConfirmStale passes the fresh hash from the 409; the builder just
    // formats it — this pins that the fresh hash reaches the wire.
    expect(buildReviewBody("approved", { baselineHash: "fresh-hash" })).toMatchObject({
      baselineHash: "fresh-hash",
    });
  });

  it("a group pick carries the group, including an explicit null (legacy/flat scope)", () => {
    expect(buildReviewBody("approved", { group: "eu_prod" })).toEqual({
      decision: "approved",
      group: "eu_prod",
    });
    expect(buildReviewBody("approved", { group: null })).toEqual({
      decision: "approved",
      group: null,
    });
  });

  it("an omitted group stays absent (distinct from an explicit null)", () => {
    const body = buildReviewBody("approved", { baselineHash: "bh" });
    expect("group" in body).toBe(false);
  });

  it("a reject carries neither hash nor group — it never resolves a baseline", () => {
    expect(buildReviewBody("rejected", { baselineHash: "bh", group: "eu_prod" })).toEqual({
      decision: "rejected",
    });
  });

  it("a bare approve with no opts is just the decision", () => {
    expect(buildReviewBody("approved")).toEqual({ decision: "approved" });
  });
});

// #4517 — the AI SDK v5 tool-part state → activity status mapping. The pre-fix
// code gated its spinner on the LEGACY "call" state (which v5 parts never
// carry), so a running tool showed no activity and errors were invisible.
describe("toolPartStatus (#4517)", () => {
  it("output-available → done", () => {
    expect(toolPartStatus("output-available")).toBe("done");
  });

  it("output-error → failed", () => {
    expect(toolPartStatus("output-error")).toBe("failed");
  });

  it("the streaming states are 'working' (the spinner shows during execution)", () => {
    expect(toolPartStatus("input-streaming")).toBe("working");
    expect(toolPartStatus("input-available")).toBe("working");
  });

  it("the legacy 'call' state (the pre-fix gate) is treated as working, not silently idle", () => {
    // Regression guard: the old code only spun on "call"; now "call" is an
    // unrecognized value that still reads as in-flight rather than done.
    expect(toolPartStatus("call")).toBe("working");
  });

  it("an absent/unknown state defaults to working (a part that hasn't settled)", () => {
    expect(toolPartStatus(undefined)).toBe("working");
    expect(toolPartStatus("something-else")).toBe("working");
  });
});
