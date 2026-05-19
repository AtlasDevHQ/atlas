/**
 * Tests for the proactive meter → admin_action_log dual-write (#2631).
 *
 * The AC for #2610 required that every meter row also emit an
 * `ADMIN_ACTIONS.proactive.{classify,react,answer,feedback}` audit row
 * so `/admin/proactive-chat` analytics that join on `admin_action_log`
 * stay in lockstep with `proactive_meter_events`. Originally only the
 * meter row was being written.
 *
 * These tests pin the dual-write: `logAdminAction` is mock-modded and
 * asserts the audit row goes out for every supported event type, with
 * the meter event's `workspaceId`/`channelId`/`outcome` etc. flowing
 * through to the audit `metadata` blob. The `offer` and
 * `public_refused` event types do not have a sibling admin action and
 * MUST NOT emit (they are meter-only by design).
 *
 * Uses sync `mock.module()` factories per CLAUDE.md.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

interface ObservedAuditCall {
  actionType: string;
  targetType: string;
  targetId: string;
  scope?: "platform" | "workspace";
  systemActor?: string;
  metadata?: Record<string, unknown>;
}
const observedAuditCalls: ObservedAuditCall[] = [];

mock.module("@atlas/api/lib/audit/admin", () => ({
  logAdminAction: (entry: ObservedAuditCall) => {
    observedAuditCalls.push(entry);
  },
}));

// `hasInternalDB` returns false so we exercise the dual-write logic
// without needing a real Postgres pool; the audit emit fires BEFORE
// the DB-skip return so the test still observes the call.
mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => false,
  internalQuery: async () => [],
}));

const { recordMeterEvent } = await import("../answer-meter");

beforeEach(() => {
  observedAuditCalls.length = 0;
});

describe("recordMeterEvent — admin_action_log dual-write (#2631)", () => {
  const baseEvent = {
    workspaceId: "ws-1",
    channelId: "C-1",
    messageId: "M-1",
  } as const;

  it("emits proactive.classify for a classify meter event", async () => {
    await recordMeterEvent({
      ...baseEvent,
      eventType: "classify",
      confidence: 0.84,
    });

    expect(observedAuditCalls).toHaveLength(1);
    expect(observedAuditCalls[0].actionType).toBe("proactive.classify");
    expect(observedAuditCalls[0].targetType).toBe("proactive");
    expect(observedAuditCalls[0].targetId).toBe("C-1");
    expect(observedAuditCalls[0].scope).toBe("workspace");
    expect(observedAuditCalls[0].systemActor).toBe("system:proactive-meter");
    expect(observedAuditCalls[0].metadata).toMatchObject({
      workspaceId: "ws-1",
      channelId: "C-1",
      messageId: "M-1",
      confidence: 0.84,
    });
  });

  it("emits proactive.react for a react meter event", async () => {
    await recordMeterEvent({ ...baseEvent, eventType: "react" });
    expect(observedAuditCalls).toHaveLength(1);
    expect(observedAuditCalls[0].actionType).toBe("proactive.react");
  });

  it("emits proactive.answer for an accept meter event (user accepted the offer)", async () => {
    // The meter's `accept` lifecycle stage IS the moment an answer was
    // delivered — map to ADMIN_ACTIONS.proactive.answer.
    await recordMeterEvent({ ...baseEvent, eventType: "accept" });
    expect(observedAuditCalls).toHaveLength(1);
    expect(observedAuditCalls[0].actionType).toBe("proactive.answer");
  });

  it("emits proactive.feedback with the outcome in metadata", async () => {
    await recordMeterEvent({
      ...baseEvent,
      eventType: "feedback",
      outcome: "not-helpful",
    });
    expect(observedAuditCalls).toHaveLength(1);
    expect(observedAuditCalls[0].actionType).toBe("proactive.feedback");
    expect(observedAuditCalls[0].metadata).toMatchObject({
      outcome: "not-helpful",
    });
  });

  it("does NOT emit an audit row for offer events (meter-only by design)", async () => {
    // `offer` is a tracer reaction stage with no forensic sibling —
    // adding an audit row would double-count engagement.
    await recordMeterEvent({ ...baseEvent, eventType: "offer" });
    expect(observedAuditCalls).toHaveLength(0);
  });

  it("does NOT emit an audit row for public_refused events", async () => {
    await recordMeterEvent({
      ...baseEvent,
      eventType: "public_refused",
    });
    expect(observedAuditCalls).toHaveLength(0);
  });

  it("threads custom metadata through to the audit row alongside fixed fields", async () => {
    await recordMeterEvent({
      ...baseEvent,
      eventType: "classify",
      actorUserId: "U-bot",
      metadata: { reason: "channel-not-allowed", classifierMode: "balanced" },
    });
    expect(observedAuditCalls).toHaveLength(1);
    expect(observedAuditCalls[0].metadata).toMatchObject({
      workspaceId: "ws-1",
      actorUserId: "U-bot",
      reason: "channel-not-allowed",
      classifierMode: "balanced",
    });
  });
});
