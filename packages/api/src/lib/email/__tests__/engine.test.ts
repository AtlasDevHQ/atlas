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
  setWorkspaceRegion: mock(async () => {}),
  insertSemanticAmendment: mock(async () => "mock-amendment-id"),
  getPendingAmendmentCount: mock(async () => 0),
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
const { sendOnboardingEmail, isOnboardingEmailEnabled, onMilestoneReached, markStepSatisfied, checkFallbackEmails, getOnboardingStatuses } = await import("../engine");

describe("isOnboardingEmailEnabled", () => {
  beforeEach(() => {
    mockHasDB = true;
  });

  it("returns false in staging/dev profile when env var not set", () => {
    // Migrated to env-profile (env-profile.ts): production defaults to
    // enabled, staging/dev default to disabled. The "env var unset → false"
    // semantic is now profile-driven; assert against the staging profile.
    delete process.env.ATLAS_ONBOARDING_EMAILS_ENABLED;
    const origDeployEnv = process.env.ATLAS_DEPLOY_ENV;
    process.env.ATLAS_DEPLOY_ENV = "staging";
    try {
      expect(isOnboardingEmailEnabled()).toBe(false);
    } finally {
      if (origDeployEnv === undefined) delete process.env.ATLAS_DEPLOY_ENV;
      else process.env.ATLAS_DEPLOY_ENV = origDeployEnv;
    }
  });

  it("returns false when env var explicitly disabled even in production profile", () => {
    process.env.ATLAS_ONBOARDING_EMAILS_ENABLED = "false";
    const origDeployEnv = process.env.ATLAS_DEPLOY_ENV;
    process.env.ATLAS_DEPLOY_ENV = "production";
    try {
      expect(isOnboardingEmailEnabled()).toBe(false);
    } finally {
      if (origDeployEnv === undefined) delete process.env.ATLAS_DEPLOY_ENV;
      else process.env.ATLAS_DEPLOY_ENV = origDeployEnv;
    }
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

  it("skips when feature disabled (env var explicit false beats production profile default)", async () => {
    // Pre-migration: deleting the env var was enough — undefined meant
    // "feature off". Post-migration the env-profile production default
    // says "on", so we must explicitly set the env var to false to
    // disable. The check we want here is the disable path, not the
    // unset-default behavior (covered in isOnboardingEmailEnabled tests).
    process.env.ATLAS_ONBOARDING_EMAILS_ENABLED = "false";
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

describe("onMilestoneReached (#3962 — action milestones suppress the nudge, no in-turn email)", () => {
  beforeEach(() => {
    process.env.ATLAS_ONBOARDING_EMAILS_ENABLED = "true";
    mockHasDB = true;
    mockInternalQueryResult = [];
    mockDeliveryResult = { success: true, provider: "log" };
  });

  it("records the step satisfied WITHOUT dispatching the nudge email", async () => {
    const { internalQuery } = await import("@atlas/api/lib/db/internal");
    const { sendEmail } = await import("../delivery");
    (internalQuery as ReturnType<typeof mock>).mockClear();
    (sendEmail as ReturnType<typeof mock>).mockClear();
    // Not unsubscribed.
    (internalQuery as ReturnType<typeof mock>).mockImplementation(() => Promise.resolve([]));

    await onMilestoneReached("first_query_executed", "u1", "org1");

    // The "ask your first question" nudge is NOT mailed back in the same turn.
    expect(sendEmail as ReturnType<typeof mock>).not.toHaveBeenCalled();

    // The first_query step was recorded with the milestone as its trigger so the
    // 72h fallback nudge is suppressed.
    const insertCall = (internalQuery as ReturnType<typeof mock>).mock.calls.find(
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("INSERT INTO onboarding_emails"),
    );
    expect(insertCall).toBeDefined();
    const params = insertCall![1] as unknown[];
    expect(params[2]).toBe("first_query");
    expect(params[3]).toBe("first_query_executed");
  });

  it("handles unknown milestone gracefully", async () => {
    // @ts-expect-error testing invalid input
    await onMilestoneReached("unknown_milestone", "u1", "org1");
    // Should not throw
  });
});

describe("markStepSatisfied (#3949 — demo suppresses connect_database without sending)", () => {
  beforeEach(() => {
    process.env.ATLAS_ONBOARDING_EMAILS_ENABLED = "true";
    mockHasDB = true;
    mockInternalQueryResult = [];
    mockDeliveryResult = { success: true, provider: "log" };
  });

  it("records the step in onboarding_emails WITHOUT dispatching an email", async () => {
    const { internalQuery } = await import("@atlas/api/lib/db/internal");
    const { sendEmail } = await import("../delivery");
    (internalQuery as ReturnType<typeof mock>).mockClear();
    (sendEmail as ReturnType<typeof mock>).mockClear();
    // Not unsubscribed.
    (internalQuery as ReturnType<typeof mock>).mockImplementation(() => Promise.resolve([]));

    const ok = await markStepSatisfied("u1", "org1", "connect_database", "demo_activated");
    expect(ok).toBe(true);

    // No email was ever rendered/dispatched.
    expect(sendEmail as ReturnType<typeof mock>).not.toHaveBeenCalled();

    // A row was recorded with the demo trigger and the connect_database step.
    const insertCall = (internalQuery as ReturnType<typeof mock>).mock.calls.find(
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("INSERT INTO onboarding_emails"),
    );
    expect(insertCall).toBeDefined();
    const params = insertCall![1] as unknown[];
    // recordSentEmail params: [userId, orgId, step, triggeredBy]
    expect(params[0]).toBe("u1");
    expect(params[1]).toBe("org1");
    expect(params[2]).toBe("connect_database");
    expect(params[3]).toBe("demo_activated");
  });

  it("is a no-op when the feature is disabled", async () => {
    process.env.ATLAS_ONBOARDING_EMAILS_ENABLED = "false";
    const { internalQuery } = await import("@atlas/api/lib/db/internal");
    (internalQuery as ReturnType<typeof mock>).mockClear();

    const ok = await markStepSatisfied("u1", "org1", "connect_database", "demo_activated");
    expect(ok).toBe(false);
    const insertCall = (internalQuery as ReturnType<typeof mock>).mock.calls.find(
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("INSERT INTO onboarding_emails"),
    );
    expect(insertCall).toBeUndefined();
  });

  it("does not write a row for an unsubscribed user", async () => {
    const { internalQuery } = await import("@atlas/api/lib/db/internal");
    (internalQuery as ReturnType<typeof mock>).mockClear();
    // First call is the unsubscribe check — return a row with onboarding_emails=false.
    (internalQuery as ReturnType<typeof mock>).mockImplementation((sql: string) => {
      if (typeof sql === "string" && sql.includes("email_preferences")) {
        return Promise.resolve([{ onboarding_emails: false }]);
      }
      return Promise.resolve([]);
    });

    const ok = await markStepSatisfied("u1", "org1", "connect_database", "demo_activated");
    expect(ok).toBe(false);
    const insertCall = (internalQuery as ReturnType<typeof mock>).mock.calls.find(
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("INSERT INTO onboarding_emails"),
    );
    expect(insertCall).toBeUndefined();
  });
});

describe("checkFallbackEmails skips a connect_database step satisfied by demo (#3949)", () => {
  beforeEach(() => {
    process.env.ATLAS_ONBOARDING_EMAILS_ENABLED = "true";
    mockHasDB = true;
    mockDeliveryResult = { success: true, provider: "log" };
  });

  it("does NOT send the 24h connect_database nudge once the step is recorded (demo_activated)", async () => {
    // A user who signed up 48h ago (so the 24h connect_database fallback is due),
    // whose connect_database step is ALREADY recorded — exactly the state
    // markStepSatisfied("...", "demo_activated") leaves behind. The fallback
    // scheduler must skip it and not send the misleading email.
    const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const { internalQuery } = await import("@atlas/api/lib/db/internal");
    const { sendEmail } = await import("../delivery");
    (internalQuery as ReturnType<typeof mock>).mockClear();
    (sendEmail as ReturnType<typeof mock>).mockClear();
    (internalQuery as ReturnType<typeof mock>).mockImplementation((sql: string) => {
      if (typeof sql === "string" && sql.includes('FROM "user"')) {
        return Promise.resolve([{ id: "u1", email: "demo@example.com", created_at: fortyEightHoursAgo }]);
      }
      if (typeof sql === "string" && sql.includes("FROM member")) {
        return Promise.resolve([{ organizationId: "org1" }]);
      }
      if (typeof sql === "string" && sql.includes("FROM onboarding_emails")) {
        // welcome (immediate) + connect_database (the demo-satisfied step).
        return Promise.resolve([{ step: "welcome" }, { step: "connect_database" }]);
      }
      if (typeof sql === "string" && sql.includes("email_preferences")) {
        return Promise.resolve([]); // not unsubscribed
      }
      return Promise.resolve([]);
    });

    const result = await checkFallbackEmails();
    expect(result.checked).toBe(1);

    // No connect_database email was dispatched — the recorded step suppressed it.
    const sentSteps = (sendEmail as ReturnType<typeof mock>).mock.calls.map(
      (call: unknown[]) => (call[0] as { subject?: string }).subject ?? "",
    );
    expect(sentSteps.some((s: string) => s.includes("Connect your database"))).toBe(false);
  });
});

describe("getOnboardingStatuses distinguishes suppressed steps from sent (#3949, #3962)", () => {
  beforeEach(() => {
    process.env.ATLAS_ONBOARDING_EMAILS_ENABLED = "true";
    mockHasDB = true;
  });

  it("classifies by trigger: welcome/time_based = sent; demo + action milestones = suppressed", async () => {
    const { internalQuery } = await import("@atlas/api/lib/db/internal");
    (internalQuery as ReturnType<typeof mock>).mockImplementation((sql: string) => {
      if (typeof sql === "string" && sql.includes("COUNT(DISTINCT")) {
        return Promise.resolve([{ count: "1" }]);
      }
      if (typeof sql === "string" && sql.includes('SELECT m."userId" as user_id')) {
        return Promise.resolve([{ user_id: "u1", email: "demo@example.com", created_at: "2026-03-20T00:00:00Z" }]);
      }
      // isDemoOnlySignup probe (LIMIT 1) — only matters for send-time copy, harmless here.
      if (typeof sql === "string" && sql.includes("LIMIT 1") && sql.includes("'demo_activated'")) {
        return Promise.resolve([{ one: 1 }]);
      }
      // getSentSteps + getSuppressedSteps now both read `SELECT step, triggered_by …`
      // (no triggered_by filter); the suppressed/sent split is computed in JS from
      // the trigger. welcome (signup_completed) + an invite_team fallback nudge
      // (time_based) are sent; connect_database (demo_activated) + first_query
      // (the action milestone) are suppressed.
      if (typeof sql === "string" && sql.includes("FROM onboarding_emails")) {
        return Promise.resolve([
          { step: "welcome", triggered_by: "signup_completed" },
          { step: "connect_database", triggered_by: "demo_activated" },
          { step: "first_query", triggered_by: "first_query_executed" },
          { step: "invite_team", triggered_by: "time_based" },
        ]);
      }
      if (typeof sql === "string" && sql.includes("email_preferences")) {
        return Promise.resolve([]); // not unsubscribed
      }
      return Promise.resolve([]);
    });

    const { statuses, total } = await getOnboardingStatuses("org1");
    expect(total).toBe(1);
    expect(statuses).toHaveLength(1);
    const s = statuses[0];
    // welcome + invite_team had emails dispatched; connect_database (demo) and
    // first_query (action milestone) were satisfied without a send.
    expect(s.sentSteps.toSorted()).toEqual(["invite_team", "welcome"]);
    expect(s.suppressedSteps.toSorted()).toEqual(["connect_database", "first_query"]);
    // All four are "completed", so none appear in pendingSteps.
    for (const completed of ["welcome", "connect_database", "first_query", "invite_team"]) {
      expect(s.pendingSteps).not.toContain(completed);
    }
    expect(s.pendingSteps).toContain("explore_features");
  });
});
