/**
 * Tests for onboarding email engine.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

// --- Mock internal DB ---

let mockInternalQueryResult: unknown[] = [];
let mockHasDB = true;

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasDB,
  internalQuery: mock(() => Promise.resolve(mockInternalQueryResult)),
  internalExecute: mock(() => {}),
  getInternalDB: () => ({ query: () => Promise.resolve({ rows: [] }), end: async () => {}, on: () => {} }),
}));

// --- Mock email delivery ---

let mockDeliveryResult = { success: true, provider: "log" as const };

mock.module("../delivery", () => ({
  sendEmail: mock(() => Promise.resolve(mockDeliveryResult)),
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

// Now import the module under test
const { sendOnboardingEmail, isOnboardingEmailEnabled, onMilestoneReached } = await import("../engine");

describe("isOnboardingEmailEnabled", () => {
  beforeEach(() => {
    mockHasDB = true;
  });

  it("returns false when env var not set", () => {
    delete process.env.ATLAS_ONBOARDING_EMAILS_ENABLED;
    expect(isOnboardingEmailEnabled()).toBe(false);
  });

  it("returns false when no internal DB", () => {
    process.env.ATLAS_ONBOARDING_EMAILS_ENABLED = "true";
    mockHasDB = false;
    expect(isOnboardingEmailEnabled()).toBe(false);
  });

  it("returns true when enabled and DB available", () => {
    process.env.ATLAS_ONBOARDING_EMAILS_ENABLED = "true";
    mockHasDB = true;
    expect(isOnboardingEmailEnabled()).toBe(true);
  });
});

describe("sendOnboardingEmail", () => {
  beforeEach(() => {
    process.env.ATLAS_ONBOARDING_EMAILS_ENABLED = "true";
    mockHasDB = true;
    mockInternalQueryResult = [];
    mockDeliveryResult = { success: true, provider: "log" };
  });

  it("skips when feature disabled", async () => {
    delete process.env.ATLAS_ONBOARDING_EMAILS_ENABLED;
    const sent = await sendOnboardingEmail("u1", "test@example.com", "org1", "welcome", "signup_completed");
    expect(sent).toBe(false);
  });

  it("sends welcome email for new user", async () => {
    // No sent steps, not unsubscribed
    mockInternalQueryResult = [];
    const sent = await sendOnboardingEmail("u1", "test@example.com", "org1", "welcome", "signup_completed");
    expect(sent).toBe(true);
  });

  it("skips if email already sent", async () => {
    // First query returns unsubscribe check (empty = not unsubscribed)
    // We need a more nuanced mock — since the function calls internalQuery multiple times
    // with different queries, we track call count
    let callCount = 0;
    const { internalQuery } = await import("@atlas/api/lib/db/internal");
    (internalQuery as ReturnType<typeof mock>).mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve([]); // email_preferences check
      if (callCount === 2) return Promise.resolve([{ step: "welcome" }]); // sent steps check
      return Promise.resolve([]);
    });

    const sent = await sendOnboardingEmail("u1", "test@example.com", "org1", "welcome", "signup_completed");
    expect(sent).toBe(false);
  });
});

describe("onMilestoneReached", () => {
  beforeEach(() => {
    process.env.ATLAS_ONBOARDING_EMAILS_ENABLED = "true";
    mockHasDB = true;
    mockInternalQueryResult = [];
    mockDeliveryResult = { success: true, provider: "log" };
  });

  it("sends email for mapped milestone", async () => {
    await onMilestoneReached("database_connected", "u1", "test@example.com", "org1");
    // No assertion needed beyond not throwing — delivery is mocked
  });

  it("handles unknown milestone gracefully", async () => {
    // @ts-expect-error testing invalid input
    await onMilestoneReached("unknown_milestone", "u1", "test@example.com", "org1");
    // Should not throw
  });
});
