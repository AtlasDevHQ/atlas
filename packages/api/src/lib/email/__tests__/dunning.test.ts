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
// `${user_id}:${step}` recorded via a prior INSERT this run, so the
// `alreadySent` SELECT reflects records the dispatcher itself wrote — letting a
// dedup-across-redelivery test exercise the real once-per-customer guard.
const sentSteps = new Set<string>();

const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<unknown[]>> = mock(
  (sql: string, params?: unknown[]) => {
    if (sql.includes("FROM member")) return Promise.resolve(mockRecipients);
    if (sql.includes("SELECT step FROM onboarding_emails")) {
      // An explicit preload (mockSentRows) wins; otherwise honour records this
      // dispatcher wrote earlier in the same run (Stripe redelivery path).
      if (mockSentRows.length > 0) return Promise.resolve(mockSentRows);
      const [userId, step] = (params ?? []) as [string, string];
      return Promise.resolve(sentSteps.has(`${userId}:${step}`) ? [{ step }] : []);
    }
    if (sql.includes("INSERT INTO onboarding_emails")) {
      recordedInserts.push(params ?? []);
      const [userId, , step] = (params ?? []) as [string, string, string];
      sentSteps.add(`${userId}:${step}`);
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
//
// Dunning routes through the DURABLE wrapper `sendTransactionalEmail` (#3680),
// which on a REAL transport failure enqueues the notice to `email_outbox` for
// retry. This faithful stand-in mirrors that contract: it returns the
// configured `DeliveryResult` and, when `shouldEnqueueFailedSend` is true,
// records an outbox enqueue — so the dunning durability + dedup behaviour is
// exercised without reaching the real outbox machinery (its own enqueue is
// covered by delivery.test.ts).

type Result = { success: boolean; provider: string; error?: string };
type Msg = { to: string; subject: string; html: string };
type Opts = { emailType: string; orgId?: string };

let mockDeliveryResult: Result = { success: true, provider: "log" };
const enqueuedOutbox: Array<{ to: string; emailType: string }> = [];

// Mirror of delivery.ts: only a REAL transport (provider !== "log") failure is
// durably enqueued; a log-provider failure has nowhere to deliver.
const realShouldEnqueue = (r: Result): boolean => !r.success && r.provider !== "log";

const mockSendTransactional: Mock<(msg: Msg, opts: Opts) => Promise<Result>> = mock(
  (msg: Msg, opts: Opts) => {
    const result = mockDeliveryResult;
    if (realShouldEnqueue(result)) {
      enqueuedOutbox.push({ to: msg.to, emailType: opts.emailType });
    }
    return Promise.resolve(result);
  },
);

// `sendEmail` is unused by the dunning dispatcher (it routes through the
// durable wrapper) but `engine.ts` — loaded transitively via dunning — imports
// it, so the mock must export it too or the whole graph fails to resolve.
const mockSendEmail: Mock<(msg: Msg, orgId?: string) => Promise<Result>> = mock(() =>
  Promise.resolve(mockDeliveryResult),
);

mock.module("../delivery", () => ({
  sendEmail: mockSendEmail,
  sendTransactionalEmail: mockSendTransactional,
  shouldEnqueueFailedSend: realShouldEnqueue,
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
  sentSteps.clear();
  enqueuedOutbox.length = 0;
  mockDeliveryResult = { success: true, provider: "log" };
  mockInternalQuery.mockClear();
  mockSendTransactional.mockClear();
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
      expect(mockSendTransactional).toHaveBeenCalledTimes(2);
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

      const [[message]] = mockSendTransactional.mock.calls;
      expect(message.subject).toMatch(/suspended/i);
      expect(message.html).toMatch(/Update payment method/);
    }));

  it("is idempotent — skips a recipient who already got this step (Stripe redelivery)", () =>
    withProdEmailEnv(async () => {
      mockRecipients = [{ user_id: "u1", email: "owner@example.com" }];
      mockSentRows = [{ step: "dunning_past_due" }]; // already sent

      const sent = await dispatchDunningEmail("org-1", "dunning_past_due");

      expect(sent).toBe(0);
      expect(mockSendTransactional).not.toHaveBeenCalled();
    }));

  it("no-ops when onboarding/dunning emails are disabled", () =>
    withDisabledEmailEnv(async () => {
      mockRecipients = [{ user_id: "u1", email: "owner@example.com" }];
      const sent = await dispatchDunningEmail("org-1", "dunning_unpaid");
      expect(sent).toBe(0);
      expect(mockSendTransactional).not.toHaveBeenCalled();
    }));

  it("no-ops (no throw) when there are no owner/admin recipients", () =>
    withProdEmailEnv(async () => {
      mockRecipients = [];
      const sent = await dispatchDunningEmail("org-1", "dunning_unpaid");
      expect(sent).toBe(0);
      expect(mockSendTransactional).not.toHaveBeenCalled();
    }));

  it("does not record (or enqueue) a no-transport failure — nowhere to deliver", () =>
    withProdEmailEnv(async () => {
      mockRecipients = [{ user_id: "u1", email: "owner@example.com" }];
      // provider "log" = no transport configured; the durable wrapper can't
      // queue it, so the step must stay unrecorded and retryable.
      mockDeliveryResult = { success: false, provider: "log", error: "no transport" };

      const sent = await dispatchDunningEmail("org-1", "dunning_recovered");

      expect(sent).toBe(0);
      expect(recordedInserts).toHaveLength(0);
      expect(enqueuedOutbox).toHaveLength(0);
    }));

  it("survives a transient transport failure — enqueues to the outbox and records the deferred send (#3680)", () =>
    withProdEmailEnv(async () => {
      mockRecipients = [{ user_id: "u1", email: "owner@example.com" }];
      // A REAL transport (resend) exhausted its in-process retries. Pre-fix
      // this was logged and dropped; now the durable wrapper queues it.
      mockDeliveryResult = { success: false, provider: "resend", error: "Resend 503" };

      const sent = await dispatchDunningEmail("org-1", "dunning_past_due");

      // Routed through the durable wrapper, which enqueued the notice for the
      // Scheduler-backed flusher to re-send — not dropped.
      expect(mockSendTransactional).toHaveBeenCalledTimes(1);
      expect(enqueuedOutbox).toEqual([{ to: "owner@example.com", emailType: "dunning_past_due" }]);
      // Recorded at dispatch time so the deferred send is tracked exactly once.
      expect(recordedInserts).toHaveLength(1);
      expect(recordedInserts[0]?.[2]).toBe("dunning_past_due");
      expect(sent).toBe(1);
    }));

  it("dedup holds across a deferred send — Stripe redelivery neither re-sends nor re-enqueues (#3680)", () =>
    withProdEmailEnv(async () => {
      mockRecipients = [{ user_id: "u1", email: "owner@example.com" }];
      // First webhook: a real transport failed, so the wrapper enqueued it.
      mockDeliveryResult = { success: false, provider: "resend", error: "Resend 503" };

      const first = await dispatchDunningEmail("org-1", "dunning_past_due");
      expect(first).toBe(1);
      expect(enqueuedOutbox).toHaveLength(1);
      expect(recordedInserts).toHaveLength(1);

      // Stripe redelivers the same event. The deferred send was already
      // recorded at dispatch time, so the (user_id, step) guard skips it — no
      // second transport attempt, no second outbox row, no double-send.
      const second = await dispatchDunningEmail("org-1", "dunning_past_due");
      expect(second).toBe(0);
      expect(mockSendTransactional).toHaveBeenCalledTimes(1);
      expect(enqueuedOutbox).toHaveLength(1);
      expect(recordedInserts).toHaveLength(1);
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
