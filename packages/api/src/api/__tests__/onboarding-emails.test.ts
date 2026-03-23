/**
 * Tests for public onboarding email routes (unsubscribe/resubscribe).
 */

import { describe, it, expect, mock } from "bun:test";

// --- Internal DB mock ---

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  getInternalDB: () => ({ query: () => Promise.resolve({ rows: [] }), end: async () => {}, on: () => {} }),
  internalQuery: mock(() => Promise.resolve([])),
  internalExecute: mock(() => {}),
}));

// --- Email engine mock ---

const mockUnsubscribe = mock(() => Promise.resolve());
const mockResubscribe = mock(() => Promise.resolve());

mock.module("@atlas/api/lib/email/engine", () => ({
  unsubscribeUser: mockUnsubscribe,
  resubscribeUser: mockResubscribe,
  isOnboardingEmailEnabled: () => true,
}));

// --- Logger mock ---

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

// --- Import router after mocks ---

const { onboardingEmails } = await import("../routes/onboarding-emails");

describe("GET /unsubscribe", () => {
  it("returns 200 HTML page for valid userId", async () => {
    const res = await onboardingEmails.request("/unsubscribe?userId=u1");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Unsubscribed");
    expect(mockUnsubscribe).toHaveBeenCalledWith("u1");
  });

  it("returns 422 when userId missing (Zod validation)", async () => {
    const res = await onboardingEmails.request("/unsubscribe");
    expect(res.status).toBe(422);
  });
});

describe("POST /resubscribe", () => {
  it("returns 200 on success", async () => {
    const res = await onboardingEmails.request("/resubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "u1" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(mockResubscribe).toHaveBeenCalledWith("u1");
  });

  it("returns 422 when userId missing", async () => {
    const res = await onboardingEmails.request("/resubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
  });
});
