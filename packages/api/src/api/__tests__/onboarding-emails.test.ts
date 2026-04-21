/**
 * Tests for public onboarding email routes (unsubscribe/resubscribe).
 *
 * Both endpoints require a signed token bound to the userId (F-03 fix).
 * Invalid/missing/expired tokens MUST NOT flip `email_preferences.onboarding_emails`.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll, mock } from "bun:test";

// --- Internal DB mock ---

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  getInternalDB: () => ({ query: () => Promise.resolve({ rows: [] }), end: async () => {}, on: () => {} }),
  internalQuery: mock(() => Promise.resolve([])),
  internalExecute: mock(() => {}),
  setWorkspaceRegion: mock(async () => {}),
  insertSemanticAmendment: mock(async () => "mock-amendment-id"),
  getPendingAmendmentCount: mock(async () => 0),
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
const { signUnsubscribeToken } = await import("@atlas/api/lib/email/unsubscribe-token");

const ORIGINAL_SECRET = process.env.BETTER_AUTH_SECRET;

beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = "test-secret-with-enough-entropy-1234567890";
});

afterAll(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = ORIGINAL_SECRET;
});

function validTokenFor(userId: string, ttlMs = 60_000): string {
  return signUnsubscribeToken(userId, Date.now() + ttlMs)!;
}

describe("GET /unsubscribe", () => {
  beforeEach(() => {
    mockUnsubscribe.mockClear();
    mockUnsubscribe.mockImplementation(() => Promise.resolve());
  });

  it("returns 200 HTML and unsubscribes when token is valid", async () => {
    const token = validTokenFor("u1");
    const res = await onboardingEmails.request(
      `/unsubscribe?userId=u1&token=${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Unsubscribed");
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
    expect(mockUnsubscribe).toHaveBeenCalledWith("u1");
  });

  it("returns 200 neutral HTML but SKIPS the DB write when token is missing", async () => {
    const res = await onboardingEmails.request("/unsubscribe?userId=u1");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Unsubscribed");
    expect(mockUnsubscribe).not.toHaveBeenCalled();
  });

  it("returns 200 neutral HTML but SKIPS the DB write when token is tampered", async () => {
    const token = validTokenFor("u1");
    const tampered = `${token.split(".")[0]}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    const res = await onboardingEmails.request(
      `/unsubscribe?userId=u1&token=${encodeURIComponent(tampered)}`,
    );
    expect(res.status).toBe(200);
    expect(mockUnsubscribe).not.toHaveBeenCalled();
  });

  it("returns 200 neutral HTML but SKIPS the DB write when token is expired", async () => {
    const token = signUnsubscribeToken("u1", Date.now() - 1_000)!;
    const res = await onboardingEmails.request(
      `/unsubscribe?userId=u1&token=${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(200);
    expect(mockUnsubscribe).not.toHaveBeenCalled();
  });

  it("returns 200 neutral HTML but SKIPS the DB write when token is for a different user", async () => {
    const token = validTokenFor("someone-else");
    const res = await onboardingEmails.request(
      `/unsubscribe?userId=u1&token=${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(200);
    expect(mockUnsubscribe).not.toHaveBeenCalled();
  });

  it("returns 422 when userId missing (Zod validation)", async () => {
    const res = await onboardingEmails.request("/unsubscribe");
    expect(res.status).toBe(422);
    expect(mockUnsubscribe).not.toHaveBeenCalled();
  });

  it("returns 500 error page when unsubscribe DB call fails (valid token)", async () => {
    mockUnsubscribe.mockImplementation(() => Promise.reject(new Error("db down")));
    const token = validTokenFor("u1");
    const res = await onboardingEmails.request(
      `/unsubscribe?userId=u1&token=${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(500);
    const html = await res.text();
    expect(html).toContain("Unsubscribe Failed");
  });
});

describe("POST /resubscribe", () => {
  beforeEach(() => {
    mockResubscribe.mockClear();
    mockResubscribe.mockImplementation(() => Promise.resolve());
  });

  it("returns 200 on success with valid token", async () => {
    const token = validTokenFor("u1");
    const res = await onboardingEmails.request("/resubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "u1", token }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(mockResubscribe).toHaveBeenCalledWith("u1");
  });

  it("returns 403 when token is missing", async () => {
    const res = await onboardingEmails.request("/resubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "u1" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; requestId: string };
    expect(body.error).toBe("forbidden");
    expect(body.requestId).toBeTruthy();
    expect(mockResubscribe).not.toHaveBeenCalled();
  });

  it("returns 403 when token is tampered", async () => {
    const token = validTokenFor("u1");
    const tampered = `${token.split(".")[0]}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    const res = await onboardingEmails.request("/resubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "u1", token: tampered }),
    });
    expect(res.status).toBe(403);
    expect(mockResubscribe).not.toHaveBeenCalled();
  });

  it("returns 403 when token is expired", async () => {
    const token = signUnsubscribeToken("u1", Date.now() - 1_000)!;
    const res = await onboardingEmails.request("/resubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "u1", token }),
    });
    expect(res.status).toBe(403);
    expect(mockResubscribe).not.toHaveBeenCalled();
  });

  it("returns 403 when token is for a different user", async () => {
    const token = validTokenFor("someone-else");
    const res = await onboardingEmails.request("/resubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "u1", token }),
    });
    expect(res.status).toBe(403);
    expect(mockResubscribe).not.toHaveBeenCalled();
  });

  it("returns 422 when userId missing", async () => {
    const res = await onboardingEmails.request("/resubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
  });

  it("returns 500 when resubscribe DB call fails (valid token)", async () => {
    mockResubscribe.mockImplementation(() => Promise.reject(new Error("db down")));
    const token = validTokenFor("u1");
    const res = await onboardingEmails.request("/resubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "u1", token }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; requestId: string };
    expect(body.error).toBe("internal_error");
    expect(body.requestId).toBeTruthy();
  });
});
