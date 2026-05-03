/**
 * Route-level test for POST /api/v1/sub-processor-subscriptions (#1924).
 *
 * Exercises the auth gate and the round-trip into createSubscription. The
 * publisher's HMAC + diff logic has its own pure-helper tests in
 * src/lib/__tests__/sub-processor-publisher.test.ts.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, mock } from "bun:test";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";

const ORIGINAL_BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET;

beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = "test-secret-that-is-at-least-32-chars-long";
});

const mocks = createApiTestMocks();

const mockCreateSubscription = mock(
  async (input: {
    id: string;
    url: string;
    token: string;
    createdByUserId?: string | null;
    createdByEmail?: string | null;
  }) => ({ id: input.id }),
);

mock.module("@atlas/api/lib/sub-processor-publisher", () => ({
  createSubscription: mockCreateSubscription,
  // The route never imports the rest of the module, but mock.module replaces
  // the entire module — re-export the other named exports as no-ops so
  // sibling tests that pull them in are not affected when this file runs
  // first under the isolated runner.
  SUBPROCESSOR_PUBLISH_INTERVAL_MS: 21_600_000,
  subProcessorPublisherTick: async () => {},
  computeDiff: () => [],
  hashPayload: () => "stub-hash",
  signRequest: () => ({ body: "", timestamp: 0, signature: "", headers: {} }),
  deliver: async () => ({ subscriptionId: "stub", status: 200, ok: true, attempts: 1, error: null }),
  getSourceUrl: () => "https://www.useatlas.dev/sub-processors/data.json",
}));

const { app } = await import("../index");

function jsonReq(method: "POST", path: string, body?: unknown, headers: Record<string, string> = {}) {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        Authorization: "Bearer test",
        "Content-Type": "application/json",
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  );
}

afterAll(() => {
  mocks.cleanup();
  if (ORIGINAL_BETTER_AUTH_SECRET !== undefined) {
    process.env.BETTER_AUTH_SECRET = ORIGINAL_BETTER_AUTH_SECRET;
  } else {
    delete process.env.BETTER_AUTH_SECRET;
  }
});

beforeEach(() => {
  mocks.mockAuthenticateRequest.mockReset();
  mocks.mockAuthenticateRequest.mockImplementation(() =>
    Promise.resolve({
      authenticated: true,
      mode: "simple-key",
      user: {
        id: "user-1",
        mode: "simple-key",
        label: "user@example.com",
        role: "member",
        activeOrganizationId: "org-1",
      },
    }),
  );
  mocks.mockCheckRateLimit.mockImplementation(() => ({ allowed: true }));
  mocks.hasInternalDB = true;
  mockCreateSubscription.mockReset();
  mockCreateSubscription.mockImplementation(async (input) => ({ id: input.id }));
});

describe("POST /api/v1/sub-processor-subscriptions", () => {
  it("rejects unauthenticated callers with 401", async () => {
    mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
      Promise.resolve({ authenticated: false, error: "Invalid token", status: 401 }),
    );
    const res = await jsonReq("POST", "/api/v1/sub-processor-subscriptions", {
      url: "https://hooks.example.com/sp",
      token: "shared-secret-at-least-16",
    });
    expect(res.status).toBe(401);
  });

  it("creates a subscription and returns its id", async () => {
    const res = await jsonReq("POST", "/api/v1/sub-processor-subscriptions", {
      url: "https://hooks.example.com/sp",
      token: "shared-secret-at-least-16",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toMatch(/^subp_[0-9a-f]{24}$/);
    expect(mockCreateSubscription).toHaveBeenCalledTimes(1);
    const arg = mockCreateSubscription.mock.calls[0][0];
    expect(arg.url).toBe("https://hooks.example.com/sp");
    expect(arg.createdByUserId).toBe("user-1");
    expect(arg.createdByEmail).toBe("user@example.com");
  });

  it("rejects malformed URLs with 400", async () => {
    const res = await jsonReq("POST", "/api/v1/sub-processor-subscriptions", {
      url: "not-a-url",
      token: "shared-secret-at-least-16",
    });
    expect(res.status).toBe(400);
    expect(mockCreateSubscription).not.toHaveBeenCalled();
  });

  it("rejects tokens shorter than 16 chars with 400", async () => {
    const res = await jsonReq("POST", "/api/v1/sub-processor-subscriptions", {
      url: "https://hooks.example.com/sp",
      token: "short",
    });
    expect(res.status).toBe(400);
    expect(mockCreateSubscription).not.toHaveBeenCalled();
  });

  it("returns 409 when the URL is already registered", async () => {
    mockCreateSubscription.mockImplementationOnce(async () => {
      throw new Error("duplicate key value violates unique constraint");
    });
    const res = await jsonReq("POST", "/api/v1/sub-processor-subscriptions", {
      url: "https://hooks.example.com/sp",
      token: "shared-secret-at-least-16",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("subscription_already_exists");
  });

  it("returns 503 when the internal DB is not configured", async () => {
    mocks.hasInternalDB = false;
    const res = await jsonReq("POST", "/api/v1/sub-processor-subscriptions", {
      url: "https://hooks.example.com/sp",
      token: "shared-secret-at-least-16",
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("internal_db_unavailable");
  });
});
