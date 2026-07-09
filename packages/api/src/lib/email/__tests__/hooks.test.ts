/**
 * Tests for onboarding email milestone hooks.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

// --- Mock engine ---

let mockEnabled = true;
const mockSendOnboardingEmail = mock(() => Promise.resolve(true));
const mockOnMilestoneReached = mock(() => Promise.resolve());
const mockMarkStepSatisfied = mock(() => Promise.resolve(true));

void mock.module("../engine", () => ({
  isOnboardingEmailEnabled: () => mockEnabled,
  sendOnboardingEmail: mockSendOnboardingEmail,
  onMilestoneReached: mockOnMilestoneReached,
  markStepSatisfied: mockMarkStepSatisfied,
}));

// --- Mock logger ---

const mockLogWarn = mock(() => {});

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: mockLogWarn,
    error: () => {},
    debug: () => {},
  }),
}));

const {
  onUserSignup,
  onDatabaseConnected,
  onDemoActivated,
  onFirstQueryExecuted,
  onTeamMemberInvited,
  onFeatureExplored,
} = await import("../hooks");

const USER = { userId: "u1", email: "test@example.com", orgId: "org1" };

describe("onUserSignup", () => {
  beforeEach(() => {
    mockEnabled = true;
    mockSendOnboardingEmail.mockClear();
  });

  it("calls sendOnboardingEmail with welcome step", async () => {
    onUserSignup(USER);
    // Fire-and-forget — wait for the async chain to resolve
    await new Promise((r) => setTimeout(r, 10));
    expect(mockSendOnboardingEmail).toHaveBeenCalledWith("u1", "test@example.com", "org1", "welcome", "signup_completed");
  });

  it("is a no-op when feature disabled", async () => {
    mockEnabled = false;
    onUserSignup(USER);
    await new Promise((r) => setTimeout(r, 10));
    expect(mockSendOnboardingEmail).not.toHaveBeenCalled();
  });
});

describe("onDatabaseConnected", () => {
  beforeEach(() => {
    mockEnabled = true;
    mockOnMilestoneReached.mockClear();
  });

  it("calls onMilestoneReached with database_connected", async () => {
    onDatabaseConnected(USER);
    await new Promise((r) => setTimeout(r, 10));
    expect(mockOnMilestoneReached).toHaveBeenCalledWith("database_connected", "u1", "org1");
  });

  it("is a no-op when feature disabled", async () => {
    mockEnabled = false;
    onDatabaseConnected(USER);
    await new Promise((r) => setTimeout(r, 10));
    expect(mockOnMilestoneReached).not.toHaveBeenCalled();
  });
});

describe("onDemoActivated (#3949)", () => {
  beforeEach(() => {
    mockEnabled = true;
    mockMarkStepSatisfied.mockClear();
    mockOnMilestoneReached.mockClear();
    mockSendOnboardingEmail.mockClear();
  });

  it("marks the connect_database step satisfied with the demo_activated trigger", async () => {
    onDemoActivated(USER);
    await new Promise((r) => setTimeout(r, 10));
    expect(mockMarkStepSatisfied).toHaveBeenCalledWith("u1", "org1", "connect_database", "demo_activated");
  });

  it("does NOT fire the database_connected milestone (no 'connect your database' email)", async () => {
    onDemoActivated(USER);
    await new Promise((r) => setTimeout(r, 10));
    // The demo path must never send the BYO connect_database email.
    expect(mockOnMilestoneReached).not.toHaveBeenCalled();
    expect(mockSendOnboardingEmail).not.toHaveBeenCalled();
  });

  it("is a no-op when feature disabled", async () => {
    mockEnabled = false;
    onDemoActivated(USER);
    await new Promise((r) => setTimeout(r, 10));
    expect(mockMarkStepSatisfied).not.toHaveBeenCalled();
  });

  it("catches errors and logs a warning (never silently swallows)", async () => {
    mockLogWarn.mockClear();
    mockMarkStepSatisfied.mockImplementation(() => Promise.reject(new Error("boom")));
    onDemoActivated(USER);
    await new Promise((r) => setTimeout(r, 10));
    // The rejection was caught AND logged — not silently swallowed.
    expect(mockLogWarn).toHaveBeenCalled();
    mockMarkStepSatisfied.mockImplementation(() => Promise.resolve(true));
  });
});

describe("onFirstQueryExecuted", () => {
  beforeEach(() => {
    mockEnabled = true;
    mockOnMilestoneReached.mockClear();
  });

  it("calls onMilestoneReached with first_query_executed", async () => {
    onFirstQueryExecuted(USER);
    await new Promise((r) => setTimeout(r, 10));
    expect(mockOnMilestoneReached).toHaveBeenCalledWith("first_query_executed", "u1", "org1");
  });
});

describe("onTeamMemberInvited", () => {
  beforeEach(() => {
    mockEnabled = true;
    mockOnMilestoneReached.mockClear();
  });

  it("calls onMilestoneReached with team_member_invited", async () => {
    onTeamMemberInvited(USER);
    await new Promise((r) => setTimeout(r, 10));
    expect(mockOnMilestoneReached).toHaveBeenCalledWith("team_member_invited", "u1", "org1");
  });
});

describe("onFeatureExplored", () => {
  beforeEach(() => {
    mockEnabled = true;
    mockOnMilestoneReached.mockClear();
  });

  it("calls onMilestoneReached with feature_explored", async () => {
    onFeatureExplored(USER);
    await new Promise((r) => setTimeout(r, 10));
    expect(mockOnMilestoneReached).toHaveBeenCalledWith("feature_explored", "u1", "org1");
  });
});

describe("error handling", () => {
  beforeEach(() => {
    mockEnabled = true;
  });

  it("catches errors without throwing", async () => {
    mockOnMilestoneReached.mockImplementation(() => Promise.reject(new Error("boom")));
    // Should not throw
    onDatabaseConnected(USER);
    await new Promise((r) => setTimeout(r, 10));
    // If we get here, the error was caught
  });
});
