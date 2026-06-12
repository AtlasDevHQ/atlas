/**
 * Tests for the trial-expiry email engine (#3434).
 *
 * The engine queries trial workspaces, computes the effective trial end
 * (same fallback enforcement uses), and sends the due T-3d / T-1d / expiry
 * notice to each owner/admin once.
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";

const DAY = 86_400_000;
const NOW = new Date("2026-06-12T12:00:00.000Z");

// --- Mock internal DB ---

let mockHasDB = true;

interface OrgRow {
  id: string;
  trial_ends_at: string | null;
  createdAt: string;
}

let mockTrialOrgs: OrgRow[] = [];
let mockRecipients: Array<{ user_id: string; email: string }> = [];
let mockSentSteps: Array<{ step: string }> = [];
const recordedInserts: unknown[][] = [];

const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<unknown[]>> = mock(
  (sql: string, params?: unknown[]) => {
    if (sql.includes("FROM organization")) return Promise.resolve(mockTrialOrgs);
    if (sql.includes("FROM member")) return Promise.resolve(mockRecipients);
    if (sql.includes("SELECT step FROM onboarding_emails")) return Promise.resolve(mockSentSteps);
    if (sql.includes("INSERT INTO onboarding_emails")) {
      recordedInserts.push(params ?? []);
      return Promise.resolve([]);
    }
    if (sql.includes("FROM workspace_branding")) return Promise.resolve([]);
    return Promise.resolve([]);
  },
);

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasDB,
  internalQuery: mockInternalQuery,
  internalExecute: mock(() => {}),
  getInternalDB: () => ({ query: () => Promise.resolve({ rows: [] }), end: async () => {}, on: () => {} }),
  setWorkspaceRegion: mock(async () => {}),
  insertSemanticAmendment: mock(async () => "mock-amendment-id"),
  getPendingAmendmentCount: mock(async () => 0),
}));

// --- Mock email delivery ---

let mockDeliveryResult: { success: boolean; provider: "log"; error?: string } = {
  success: true,
  provider: "log",
};
const mockSendEmail: Mock<(msg: unknown, orgId?: string) => Promise<unknown>> = mock(() =>
  Promise.resolve(mockDeliveryResult),
);

mock.module("../delivery", () => ({
  sendEmail: mockSendEmail,
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

const { checkTrialExpiryEmails } = await import("../trial-expiry-engine");

function withProdEmailEnv(fn: () => Promise<void>): Promise<void> {
  const origEnabled = process.env.ATLAS_ONBOARDING_EMAILS_ENABLED;
  process.env.ATLAS_ONBOARDING_EMAILS_ENABLED = "true";
  return fn().finally(() => {
    if (origEnabled === undefined) delete process.env.ATLAS_ONBOARDING_EMAILS_ENABLED;
    else process.env.ATLAS_ONBOARDING_EMAILS_ENABLED = origEnabled;
  });
}

describe("checkTrialExpiryEmails", () => {
  beforeEach(() => {
    mockHasDB = true;
    mockTrialOrgs = [];
    mockRecipients = [];
    mockSentSteps = [];
    recordedInserts.length = 0;
    mockDeliveryResult = { success: true, provider: "log" };
    mockSendEmail.mockClear();
    mockInternalQuery.mockClear();
  });

  it("no-ops when emails are disabled", async () => {
    const origEnabled = process.env.ATLAS_ONBOARDING_EMAILS_ENABLED;
    process.env.ATLAS_ONBOARDING_EMAILS_ENABLED = "false";
    try {
      const result = await checkTrialExpiryEmails(NOW);
      expect(result).toEqual({ checked: 0, sent: 0 });
      expect(mockInternalQuery).not.toHaveBeenCalled();
    } finally {
      if (origEnabled === undefined) delete process.env.ATLAS_ONBOARDING_EMAILS_ENABLED;
      else process.env.ATLAS_ONBOARDING_EMAILS_ENABLED = origEnabled;
    }
  });

  it("sends the T-3d warning to every owner/admin of a trial workspace", () =>
    withProdEmailEnv(async () => {
      mockTrialOrgs = [
        {
          id: "org-1",
          trial_ends_at: new Date(NOW.getTime() + 2 * DAY).toISOString(),
          createdAt: new Date(NOW.getTime() - 12 * DAY).toISOString(),
        },
      ];
      mockRecipients = [
        { user_id: "u-owner", email: "owner@example.com" },
        { user_id: "u-admin", email: "admin@example.com" },
      ];

      const result = await checkTrialExpiryEmails(NOW);
      expect(result.checked).toBe(1);
      expect(result.sent).toBe(2);
      expect(mockSendEmail).toHaveBeenCalledTimes(2);
      const firstMsg = mockSendEmail.mock.calls[0][0] as { to: string; subject: string };
      expect(firstMsg.subject).toBe("Your Atlas trial ends in 3 days");
      // Sent record carries the trial step name
      expect(recordedInserts).toHaveLength(2);
      expect(recordedInserts[0]).toContain("trial_ending_3d");
    }));

  it("uses the createdAt + TRIAL_DAYS fallback when trial_ends_at is null", () =>
    withProdEmailEnv(async () => {
      // Created 14 days + 1h ago, no trial_ends_at → effectively expired.
      mockTrialOrgs = [
        {
          id: "org-1",
          trial_ends_at: null,
          createdAt: new Date(NOW.getTime() - 14 * DAY - 3_600_000).toISOString(),
        },
      ];
      mockRecipients = [{ user_id: "u-owner", email: "owner@example.com" }];

      const result = await checkTrialExpiryEmails(NOW);
      expect(result.sent).toBe(1);
      const msg = mockSendEmail.mock.calls[0][0] as { subject: string };
      expect(msg.subject).toBe("Your Atlas trial has expired");
      expect(recordedInserts[0]).toContain("trial_expired");
    }));

  it("skips recipients who already received the due step", () =>
    withProdEmailEnv(async () => {
      mockTrialOrgs = [
        {
          id: "org-1",
          trial_ends_at: new Date(NOW.getTime() + 2 * DAY).toISOString(),
          createdAt: new Date(NOW.getTime() - 12 * DAY).toISOString(),
        },
      ];
      mockRecipients = [{ user_id: "u-owner", email: "owner@example.com" }];
      mockSentSteps = [{ step: "trial_ending_3d" }];

      const result = await checkTrialExpiryEmails(NOW);
      expect(result.sent).toBe(0);
      expect(mockSendEmail).not.toHaveBeenCalled();
    }));

  it("sends nothing when the trial still has more than 3 days left", () =>
    withProdEmailEnv(async () => {
      mockTrialOrgs = [
        {
          id: "org-1",
          trial_ends_at: new Date(NOW.getTime() + 10 * DAY).toISOString(),
          createdAt: new Date(NOW.getTime() - 4 * DAY).toISOString(),
        },
      ];
      mockRecipients = [{ user_id: "u-owner", email: "owner@example.com" }];

      const result = await checkTrialExpiryEmails(NOW);
      expect(result.sent).toBe(0);
      expect(mockSendEmail).not.toHaveBeenCalled();
    }));

  it("does not record a send when delivery fails", () =>
    withProdEmailEnv(async () => {
      mockDeliveryResult = { success: false, provider: "log", error: "smtp down" };
      mockTrialOrgs = [
        {
          id: "org-1",
          trial_ends_at: new Date(NOW.getTime() - 3_600_000).toISOString(),
          createdAt: new Date(NOW.getTime() - 14 * DAY).toISOString(),
        },
      ];
      mockRecipients = [{ user_id: "u-owner", email: "owner@example.com" }];

      const result = await checkTrialExpiryEmails(NOW);
      expect(result.sent).toBe(0);
      expect(recordedInserts).toHaveLength(0);
    }));

  it("survives a per-org failure and keeps processing other orgs", () =>
    withProdEmailEnv(async () => {
      mockTrialOrgs = [
        { id: "org-bad", trial_ends_at: "not-a-date", createdAt: "garbage" },
        {
          id: "org-good",
          trial_ends_at: new Date(NOW.getTime() - 3_600_000).toISOString(),
          createdAt: new Date(NOW.getTime() - 14 * DAY).toISOString(),
        },
      ];
      mockRecipients = [{ user_id: "u-owner", email: "owner@example.com" }];

      const result = await checkTrialExpiryEmails(NOW);
      expect(result.checked).toBe(2);
      expect(result.sent).toBe(1);
    }));
});
