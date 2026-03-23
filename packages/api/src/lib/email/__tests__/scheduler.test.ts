/**
 * Tests for onboarding email scheduler.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

// --- Mock engine ---

let mockEnabled = true;
const mockCheckFallbackEmails = mock(() => Promise.resolve({ checked: 0, sent: 0 }));

mock.module("../engine", () => ({
  isOnboardingEmailEnabled: () => mockEnabled,
  checkFallbackEmails: mockCheckFallbackEmails,
}));

// --- Mock logger ---

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

const { startOnboardingEmailScheduler, stopOnboardingEmailScheduler, _runTick } = await import("../scheduler");

describe("startOnboardingEmailScheduler", () => {
  afterEach(() => {
    stopOnboardingEmailScheduler();
    mockCheckFallbackEmails.mockClear();
  });

  it("is a no-op when feature disabled", () => {
    mockEnabled = false;
    startOnboardingEmailScheduler();
    // No error, no calls
    expect(mockCheckFallbackEmails).not.toHaveBeenCalled();
  });

  it("runs initial tick immediately when started", async () => {
    mockEnabled = true;
    startOnboardingEmailScheduler(60_000);
    // Wait for the immediate tick to fire
    await new Promise((r) => setTimeout(r, 50));
    expect(mockCheckFallbackEmails).toHaveBeenCalledTimes(1);
  });

  it("does not create duplicate intervals on double start", async () => {
    mockEnabled = true;
    startOnboardingEmailScheduler(60_000);
    startOnboardingEmailScheduler(60_000);
    await new Promise((r) => setTimeout(r, 50));
    // Should only have fired once from the first start's immediate tick
    expect(mockCheckFallbackEmails).toHaveBeenCalledTimes(1);
  });
});

describe("stopOnboardingEmailScheduler", () => {
  it("stops without error when not started", () => {
    // Should not throw
    stopOnboardingEmailScheduler();
  });

  it("stops a running scheduler", async () => {
    mockEnabled = true;
    startOnboardingEmailScheduler(60_000);
    await new Promise((r) => setTimeout(r, 50));
    stopOnboardingEmailScheduler();
    // No error
  });
});

describe("_runTick", () => {
  beforeEach(() => {
    mockCheckFallbackEmails.mockClear();
    mockCheckFallbackEmails.mockImplementation(() => Promise.resolve({ checked: 5, sent: 2 }));
  });

  it("calls checkFallbackEmails", async () => {
    await _runTick();
    expect(mockCheckFallbackEmails).toHaveBeenCalledTimes(1);
  });

  it("catches errors from checkFallbackEmails without throwing", async () => {
    mockCheckFallbackEmails.mockImplementation(() => Promise.reject(new Error("db down")));
    // Should not throw
    await _runTick();
  });
});
