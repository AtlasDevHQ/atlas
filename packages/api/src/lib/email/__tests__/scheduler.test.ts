/**
 * Tests for onboarding email scheduler (#1276).
 *
 * Tests the runTick function and isEmailSchedulerEnabled check.
 * The periodic timer is managed by the SchedulerLayer Effect fiber
 * in lib/effect/layers.ts — only the tick function is tested here.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

// --- Mock engine ---

let mockEnabled = true;
const mockCheckFallbackEmails = mock(() => Promise.resolve({ checked: 0, sent: 0 }));

void mock.module("../engine", () => ({
  isOnboardingEmailEnabled: () => mockEnabled,
  checkFallbackEmails: mockCheckFallbackEmails,
}));

// --- Mock trial-expiry engine (#3434) ---

const mockCheckTrialExpiryEmails = mock(() => Promise.resolve({ checked: 0, sent: 0 }));

void mock.module("../trial-expiry-engine", () => ({
  checkTrialExpiryEmails: mockCheckTrialExpiryEmails,
}));

// --- Mock logger ---

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

const { _runTick, isEmailSchedulerEnabled } = await import("../scheduler");

describe("isEmailSchedulerEnabled", () => {
  it("returns true when onboarding emails are enabled", () => {
    mockEnabled = true;
    expect(isEmailSchedulerEnabled()).toBe(true);
  });

  it("returns false when onboarding emails are disabled", () => {
    mockEnabled = false;
    expect(isEmailSchedulerEnabled()).toBe(false);
  });
});

describe("_runTick", () => {
  beforeEach(() => {
    mockCheckFallbackEmails.mockClear();
    mockCheckFallbackEmails.mockImplementation(() => Promise.resolve({ checked: 5, sent: 2 }));
    mockCheckTrialExpiryEmails.mockClear();
    mockCheckTrialExpiryEmails.mockImplementation(() => Promise.resolve({ checked: 3, sent: 1 }));
  });

  it("calls checkFallbackEmails", async () => {
    await _runTick();
    expect(mockCheckFallbackEmails).toHaveBeenCalledTimes(1);
  });

  it("calls checkTrialExpiryEmails (#3434)", async () => {
    await _runTick();
    expect(mockCheckTrialExpiryEmails).toHaveBeenCalledTimes(1);
  });

  it("catches errors from checkFallbackEmails without throwing", async () => {
    mockCheckFallbackEmails.mockImplementation(() => Promise.reject(new Error("db down")));
    // Should not throw
    await _runTick();
  });

  it("still runs the trial-expiry check when the onboarding check fails", async () => {
    mockCheckFallbackEmails.mockImplementation(() => Promise.reject(new Error("db down")));
    await _runTick();
    expect(mockCheckTrialExpiryEmails).toHaveBeenCalledTimes(1);
  });

  it("catches errors from checkTrialExpiryEmails without throwing", async () => {
    mockCheckTrialExpiryEmails.mockImplementation(() => Promise.reject(new Error("db down")));
    await _runTick();
  });
});
