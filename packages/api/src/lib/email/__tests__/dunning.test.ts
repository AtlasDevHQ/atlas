/**
 * Tests for the dunning (payment-failure) email dispatch (#3424).
 *
 * `dispatchDunningEmail` resolves a workspace's owners/admins and sends each
 * the rendered dunning notice once (idempotent on the shared
 * `onboarding_emails` table under the `dunning_` step prefix).
 * `clearDunningSteps` wipes the delinquency rungs on recovery so the ladder
 * can re-fire on a future failure.
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";
// Mock ALL db/internal exports (docs/development/testing.md): a partial mock
// makes a sibling test that imports a different db/internal symbol crash. The
// defaults builder gives the full surface; we override only the two the dunning
// dispatcher actually drives (internalQuery + hasInternalDB).
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";

// --- Mock internal DB ---

let mockHasDB = true;
let mockRecipients: Array<{ user_id: string; email: string }> = [];
let mockSentRows: Array<{ step: string }> = [];
const recordedInserts: unknown[][] = [];
const recordedDeletes: unknown[][] = [];

const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<unknown[]>> = mock(
  (sql: string, params?: unknown[]) => {
    if (sql.includes("FROM member")) return Promise.resolve(mockRecipients);
    if (sql.includes("SELECT step FROM onboarding_emails")) return Promise.resolve(mockSentRows);
    if (sql.includes("INSERT INTO onboarding_emails")) {
      recordedInserts.push(params ?? []);
      return Promise.resolve([]);
    }
    if (sql.includes("DELETE FROM onboarding_emails")) {
      recordedDeletes.push(params ?? []);
      return Promise.resolve([]);
    }
    if (sql.includes("FROM workspace_branding")) return Promise.resolve([]);
    return Promise.resolve([]);
  },
);

mock.module("@atlas/api/lib/db/internal", () => ({
  ...buildInternalDbMockDefaults({
    internalQuery: mockInternalQuery,
    hasInternalDB: () => mockHasDB,
  }),
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

const { dispatchDunningEmail, clearDunningSteps } = await import("../dunning");

function withEmailEnv(value: "true" | "false", fn: () => Promise<void>): Promise<void> {
  const orig = process.env.ATLAS_ONBOARDING_EMAILS_ENABLED;
  process.env.ATLAS_ONBOARDING_EMAILS_ENABLED = value;
  return fn().finally(() => {
    if (orig === undefined) delete process.env.ATLAS_ONBOARDING_EMAILS_ENABLED;
    else process.env.ATLAS_ONBOARDING_EMAILS_ENABLED = orig;
  });
}

function withProdEmailEnv(fn: () => Promise<void>): Promise<void> {
  return withEmailEnv("true", fn);
}

function withDisabledEmailEnv(fn: () => Promise<void>): Promise<void> {
  return withEmailEnv("false", fn);
}

beforeEach(() => {
  mockHasDB = true;
  mockRecipients = [];
  mockSentRows = [];
  recordedInserts.length = 0;
  recordedDeletes.length = 0;
  mockDeliveryResult = { success: true, provider: "log" };
  mockInternalQuery.mockClear();
  mockSendEmail.mockClear();
});

describe("dispatchDunningEmail", () => {
  it("sends the dunning email to every owner/admin and records the step", () =>
    withProdEmailEnv(async () => {
      mockRecipients = [
        { user_id: "u1", email: "owner@example.com" },
        { user_id: "u2", email: "admin@example.com" },
      ];

      const sent = await dispatchDunningEmail("org-1", "dunning_past_due");

      expect(sent).toBe(2);
      expect(mockSendEmail).toHaveBeenCalledTimes(2);
      // Each send recorded the once-per-customer step.
      expect(recordedInserts).toHaveLength(2);
      for (const params of recordedInserts) {
        expect(params[2]).toBe("dunning_past_due");
        expect(params[3]).toBe("payment_failure");
      }
    }));

  it("renders the correct subject for the suspended rung", () =>
    withProdEmailEnv(async () => {
      mockRecipients = [{ user_id: "u1", email: "owner@example.com" }];

      await dispatchDunningEmail("org-1", "dunning_suspended");

      const [[message]] = mockSendEmail.mock.calls as Array<[{ subject: string; html: string }]>;
      expect(message.subject).toMatch(/suspended/i);
      expect(message.html).toMatch(/Update payment method/);
    }));

  it("is idempotent — skips a recipient who already got this step (Stripe redelivery)", () =>
    withProdEmailEnv(async () => {
      mockRecipients = [{ user_id: "u1", email: "owner@example.com" }];
      mockSentRows = [{ step: "dunning_past_due" }]; // already sent

      const sent = await dispatchDunningEmail("org-1", "dunning_past_due");

      expect(sent).toBe(0);
      expect(mockSendEmail).not.toHaveBeenCalled();
    }));

  it("no-ops when onboarding/dunning emails are disabled", () =>
    withDisabledEmailEnv(async () => {
      mockRecipients = [{ user_id: "u1", email: "owner@example.com" }];
      const sent = await dispatchDunningEmail("org-1", "dunning_unpaid");
      expect(sent).toBe(0);
      expect(mockSendEmail).not.toHaveBeenCalled();
    }));

  it("no-ops (no throw) when there are no owner/admin recipients", () =>
    withProdEmailEnv(async () => {
      mockRecipients = [];
      const sent = await dispatchDunningEmail("org-1", "dunning_unpaid");
      expect(sent).toBe(0);
      expect(mockSendEmail).not.toHaveBeenCalled();
    }));

  it("does not record the step when delivery fails", () =>
    withProdEmailEnv(async () => {
      mockRecipients = [{ user_id: "u1", email: "owner@example.com" }];
      mockDeliveryResult = { success: false, provider: "log", error: "no transport" };

      const sent = await dispatchDunningEmail("org-1", "dunning_recovered");

      expect(sent).toBe(0);
      expect(recordedInserts).toHaveLength(0);
    }));

  it("never throws — a DB failure is swallowed and logged", () =>
    withProdEmailEnv(async () => {
      mockInternalQuery.mockImplementationOnce(() => Promise.reject(new Error("pg down")));
      // Must resolve, not reject.
      const sent = await dispatchDunningEmail("org-1", "dunning_past_due");
      expect(sent).toBe(0);
    }));
});

describe("clearDunningSteps", () => {
  it("deletes the delinquency steps for the org on recovery", () =>
    withProdEmailEnv(async () => {
      await clearDunningSteps("org-1");

      expect(recordedDeletes).toHaveLength(1);
      const [params] = recordedDeletes;
      expect(params[0]).toBe("org-1");
      const steps = params[1] as string[];
      expect(steps).toContain("dunning_past_due");
      expect(steps).toContain("dunning_unpaid");
      expect(steps).toContain("dunning_suspended");
      // The recovery confirmation is NOT cleared — it's once-per-recovery.
      expect(steps).not.toContain("dunning_recovered");
    }));

  it("no-ops when emails are disabled", () =>
    withDisabledEmailEnv(async () => {
      await clearDunningSteps("org-1");
      expect(recordedDeletes).toHaveLength(0);
    }));
});
