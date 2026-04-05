import { describe, expect, test } from "bun:test";
import {
  createSession,
  nextProposal,
  recordDecision,
  addMessage,
  getSessionSummary,
  buildSessionContext,
} from "../session";
import { createAnalysisResult } from "../scoring";
import type { AnalysisResult } from "../types";

function makeProposal(entity: string, name: string): AnalysisResult {
  return createAnalysisResult({
    category: "missing_measures",
    entityName: entity,
    amendmentType: "add_measure",
    amendment: { name, sql: name, type: "sum" },
    rationale: `Add measure ${name}`,
    impact: 0.8,
    confidence: 0.7,
    staleness: 0,
  });
}

describe("createSession", () => {
  test("initializes with proposals and empty state", () => {
    const proposals = [makeProposal("orders", "total_amount")];
    const session = createSession(proposals);

    expect(session.proposals).toHaveLength(1);
    expect(session.currentIndex).toBe(0);
    expect(session.reviewed).toHaveLength(0);
    expect(session.messages).toHaveLength(0);
    expect(session.rejectedKeys.size).toBe(0);
    expect(session.startedAt).toBeInstanceOf(Date);
  });
});

describe("nextProposal", () => {
  test("returns first proposal initially", () => {
    const proposals = [makeProposal("orders", "total_amount")];
    const session = createSession(proposals);

    expect(nextProposal(session)).toBe(proposals[0]);
  });

  test("returns null when all proposals reviewed", () => {
    const proposals = [makeProposal("orders", "total_amount")];
    const session = createSession(proposals);

    recordDecision(session, "accepted");
    expect(nextProposal(session)).toBeNull();
  });
});

describe("recordDecision", () => {
  test("advances index and records accepted", () => {
    const proposals = [
      makeProposal("orders", "total_amount"),
      makeProposal("users", "total_logins"),
    ];
    const session = createSession(proposals);

    recordDecision(session, "accepted");

    expect(session.currentIndex).toBe(1);
    expect(session.reviewed).toHaveLength(1);
    expect(session.reviewed[0].decision).toBe("accepted");
    expect(session.rejectedKeys.size).toBe(0);
  });

  test("tracks rejection key when rejected", () => {
    const proposals = [makeProposal("orders", "total_amount")];
    const session = createSession(proposals);

    recordDecision(session, "rejected");

    expect(session.rejectedKeys.has("orders:add_measure:total_amount")).toBe(true);
  });

  test("skipped does not add to rejected keys", () => {
    const proposals = [makeProposal("orders", "total_amount")];
    const session = createSession(proposals);

    recordDecision(session, "skipped");

    expect(session.rejectedKeys.size).toBe(0);
    expect(session.reviewed[0].decision).toBe("skipped");
  });

  test("does nothing when no proposal at current index", () => {
    const session = createSession([]);
    recordDecision(session, "accepted");

    expect(session.reviewed).toHaveLength(0);
    expect(session.currentIndex).toBe(0);
  });
});

describe("addMessage", () => {
  test("appends messages to conversation history", () => {
    const session = createSession([]);

    addMessage(session, "assistant", "I found improvements.");
    addMessage(session, "user", "Show me.");

    expect(session.messages).toHaveLength(2);
    expect(session.messages[0]).toEqual({ role: "assistant", content: "I found improvements." });
    expect(session.messages[1]).toEqual({ role: "user", content: "Show me." });
  });
});

describe("getSessionSummary", () => {
  test("returns correct counts", () => {
    const proposals = [
      makeProposal("orders", "total_amount"),
      makeProposal("users", "total_logins"),
      makeProposal("products", "total_price"),
      makeProposal("invoices", "total_value"),
    ];
    const session = createSession(proposals);

    recordDecision(session, "accepted");
    recordDecision(session, "rejected");
    recordDecision(session, "skipped");

    const summary = getSessionSummary(session);
    expect(summary.total).toBe(4);
    expect(summary.accepted).toBe(1);
    expect(summary.rejected).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.remaining).toBe(1);
  });

  test("handles empty session", () => {
    const session = createSession([]);
    const summary = getSessionSummary(session);

    expect(summary.total).toBe(0);
    expect(summary.accepted).toBe(0);
    expect(summary.rejected).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.remaining).toBe(0);
  });
});

describe("buildSessionContext", () => {
  test("includes progress and rejection info", () => {
    const proposals = [
      makeProposal("orders", "total_amount"),
      makeProposal("users", "total_logins"),
    ];
    const session = createSession(proposals);

    recordDecision(session, "rejected");
    addMessage(session, "user", "I don't need that measure.");

    const context = buildSessionContext(session);

    expect(context).toContain("1/2 proposals reviewed");
    expect(context).toContain("Rejected: 1");
    expect(context).toContain("Remaining: 1");
    expect(context).toContain("orders:add_measure:total_amount");
    expect(context).toContain("I don't need that measure.");
  });

  test("truncates long messages", () => {
    const session = createSession([]);
    addMessage(session, "user", "x".repeat(300));

    const context = buildSessionContext(session);
    expect(context).toContain("...");
  });
});
