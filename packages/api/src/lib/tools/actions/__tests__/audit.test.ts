/**
 * Tests for logActionAudit — structured pino logs for action lifecycle events.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import type { ActionAuditEntry } from "../audit";

// --- Mock the logger ---

const mockInfo = mock(() => {});
const mockWarn = mock(() => {});
const mockError = mock(() => {});

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: mockInfo,
    warn: mockWarn,
    error: mockError,
    debug: mock(() => {}),
  }),
}));

// Import after mocks
const { logActionAudit } = await import("../audit");

beforeEach(() => {
  mockInfo.mockReset();
  mockWarn.mockReset();
  mockError.mockReset();
});

describe("logActionAudit()", () => {
  // -------------------------------------------------------------------------
  // Log level routing by status
  // -------------------------------------------------------------------------

  it("calls log.error for status 'failed'", () => {
    logActionAudit({
      actionId: "a1",
      actionType: "test:action",
      status: "failed",
    });

    expect(mockError).toHaveBeenCalledTimes(1);
    expect(mockInfo).not.toHaveBeenCalled();
    expect(mockWarn).not.toHaveBeenCalled();

    const [fields, message] = mockError.mock.calls[0] as unknown as [Record<string, unknown>, string];
    expect(message).toBe("action_failed");
    expect(fields.actionId).toBe("a1");
    expect(fields.status).toBe("failed");
  });

  it("calls log.warn for status 'denied'", () => {
    logActionAudit({
      actionId: "a2",
      actionType: "test:action",
      status: "denied",
    });

    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockInfo).not.toHaveBeenCalled();
    expect(mockError).not.toHaveBeenCalled();

    const [, message] = mockWarn.mock.calls[0] as unknown as [Record<string, unknown>, string];
    expect(message).toBe("action_denied");
  });

  it("calls log.info for status 'executed'", () => {
    logActionAudit({
      actionId: "a3",
      actionType: "test:action",
      status: "executed",
    });

    expect(mockInfo).toHaveBeenCalledTimes(1);
    expect(mockWarn).not.toHaveBeenCalled();
    expect(mockError).not.toHaveBeenCalled();

    const [, message] = mockInfo.mock.calls[0] as unknown as [Record<string, unknown>, string];
    expect(message).toBe("action_executed");
  });

  it("calls log.info for status 'pending'", () => {
    logActionAudit({
      actionId: "a4",
      actionType: "test:action",
      status: "pending",
    });

    expect(mockInfo).toHaveBeenCalledTimes(1);
    const [, message] = mockInfo.mock.calls[0] as unknown as [Record<string, unknown>, string];
    expect(message).toBe("action_pending");
  });

  it("calls log.info for status 'auto_approved'", () => {
    logActionAudit({
      actionId: "a5",
      actionType: "test:action",
      status: "auto_approved",
    });

    expect(mockInfo).toHaveBeenCalledTimes(1);
    const [, message] = mockInfo.mock.calls[0] as unknown as [Record<string, unknown>, string];
    expect(message).toBe("action_auto_approved");
  });

  it("calls log.info for status 'approved'", () => {
    logActionAudit({
      actionId: "a6",
      actionType: "test:action",
      status: "approved",
    });

    expect(mockInfo).toHaveBeenCalledTimes(1);
    const [, message] = mockInfo.mock.calls[0] as unknown as [Record<string, unknown>, string];
    expect(message).toBe("action_approved");
  });

  // -------------------------------------------------------------------------
  // Optional fields inclusion
  // -------------------------------------------------------------------------

  it("includes latencyMs when provided", () => {
    logActionAudit({
      actionId: "a7",
      actionType: "test:action",
      status: "executed",
      latencyMs: 150,
    });

    const [fields] = mockInfo.mock.calls[0] as unknown as [Record<string, unknown>, string];
    expect(fields.latencyMs).toBe(150);
  });

  it("includes userId when provided", () => {
    logActionAudit({
      actionId: "a8",
      actionType: "test:action",
      status: "pending",
      userId: "user-123",
    });

    const [fields] = mockInfo.mock.calls[0] as unknown as [Record<string, unknown>, string];
    expect(fields.userId).toBe("user-123");
  });

  it("includes approverId when provided", () => {
    logActionAudit({
      actionId: "a9",
      actionType: "test:action",
      status: "approved",
      approverId: "admin-1",
    });

    const [fields] = mockInfo.mock.calls[0] as unknown as [Record<string, unknown>, string];
    expect(fields.approverId).toBe("admin-1");
  });

  it("includes error when provided", () => {
    logActionAudit({
      actionId: "a10",
      actionType: "test:action",
      status: "failed",
      error: "Connection refused",
    });

    const [fields] = mockError.mock.calls[0] as unknown as [Record<string, unknown>, string];
    expect(fields.error).toBe("Connection refused");
  });

  it("omits optional fields when not provided", () => {
    logActionAudit({
      actionId: "a11",
      actionType: "test:action",
      status: "pending",
    });

    const [fields] = mockInfo.mock.calls[0] as unknown as [Record<string, unknown>, string];
    expect(fields.actionId).toBe("a11");
    expect(fields.actionType).toBe("test:action");
    expect(fields.status).toBe("pending");
    expect("latencyMs" in fields).toBe(false);
    expect("userId" in fields).toBe(false);
    expect("approverId" in fields).toBe(false);
    expect("error" in fields).toBe(false);
  });

  it("includes all optional fields when all are provided", () => {
    const entry: ActionAuditEntry = {
      actionId: "a12",
      actionType: "test:action",
      status: "failed",
      latencyMs: 250,
      userId: "user-456",
      approverId: "admin-2",
      error: "Timeout",
    };

    logActionAudit(entry);

    const [fields] = mockError.mock.calls[0] as unknown as [Record<string, unknown>, string];
    expect(fields.actionId).toBe("a12");
    expect(fields.actionType).toBe("test:action");
    expect(fields.status).toBe("failed");
    expect(fields.latencyMs).toBe(250);
    expect(fields.userId).toBe("user-456");
    expect(fields.approverId).toBe("admin-2");
    expect(fields.error).toBe("Timeout");
  });
});
