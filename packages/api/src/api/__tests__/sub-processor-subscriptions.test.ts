/**
 * Route-level test for POST /api/v1/sub-processor-subscriptions (#1924).
 *
 * Covers the auth gate, validation (URL safety + token length), the
 * unique-violation 409 path, and the no-internal-DB 503 path. The
 * downstream encryption call is exercised in
 * src/lib/__tests__/create-subscription-encryption.test.ts; the
 * publisher tick is exercised in
 * src/lib/__tests__/sub-processor-publisher-tick.test.ts.
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
    createdByUserId: string | null;
    createdByLabel: string | null;
  }) => ({ id: input.id }),
);

// `mock.module` replaces ALL named exports with whatever this factory
// returns. Under `bun test` (single process) other test files that
// import from this module get the mocked surface, so we must list
// every export the publisher actually has — missing entries surface as
// `undefined is not a function` in unrelated sibling tests. CLAUDE.md
// "Mock all exports" rule. The CI runner (`scripts/test-isolated.ts`)
// forks each file so the leak doesn't bite, but we keep the file
// robust under both runners. If you add a new export to
// sub-processor-publisher, add a stub here.
mock.module("@atlas/api/lib/sub-processor-publisher", () => ({
  createSubscription: mockCreateSubscription,
  SUBPROCESSOR_PUBLISH_INTERVAL_MS: 21_600_000,
  subProcessorPublisherTick: async () => {},
  computeDiff: () => [],
  hashPayload: () => "stub-hash",
  signRequest: () => ({
    body: "",
    timestamp: 0,
    signature: "",
    headers: { "Content-Type": "application/json" },
  }),
  deliver: async () => ({
    kind: "ok" as const,
    subscriptionId: "stub",
    status: 200,
    attempts: 1,
  }),
  getSourceUrl: () => "https://www.useatlas.dev/sub-processors/data.json",
  SubProcessorSchema: {
    safeParse: (v: unknown) => ({ success: true, data: v }),
  },
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
    expect(arg.createdByLabel).toBe("user@example.com");
  });

  it("rejects malformed URLs with 400", async () => {
    const res = await jsonReq("POST", "/api/v1/sub-processor-subscriptions", {
      url: "not-a-url",
      token: "shared-secret-at-least-16",
    });
    expect(res.status).toBe(400);
    expect(mockCreateSubscription).not.toHaveBeenCalled();
  });

  it("rejects http:// URLs with 400 (SSRF guard requires https)", async () => {
    const res = await jsonReq("POST", "/api/v1/sub-processor-subscriptions", {
      url: "http://hooks.example.com/sp",
      token: "shared-secret-at-least-16",
    });
    expect(res.status).toBe(400);
    expect(mockCreateSubscription).not.toHaveBeenCalled();
  });

  it("rejects loopback URLs with 400 (SSRF guard)", async () => {
    const res = await jsonReq("POST", "/api/v1/sub-processor-subscriptions", {
      url: "https://127.0.0.1/sp",
      token: "shared-secret-at-least-16",
    });
    expect(res.status).toBe(400);
    expect(mockCreateSubscription).not.toHaveBeenCalled();
  });

  it("rejects RFC1918 URLs with 400 (SSRF guard)", async () => {
    const res = await jsonReq("POST", "/api/v1/sub-processor-subscriptions", {
      url: "https://10.0.0.5/sp",
      token: "shared-secret-at-least-16",
    });
    expect(res.status).toBe(400);
    expect(mockCreateSubscription).not.toHaveBeenCalled();
  });

  it("rejects 169.254 metadata-service URLs with 400 (SSRF guard)", async () => {
    const res = await jsonReq("POST", "/api/v1/sub-processor-subscriptions", {
      url: "https://169.254.169.254/latest/meta-data/iam/security-credentials/",
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

  it("returns 409 when the URL is already registered (matches by SQLSTATE 23505, not error message)", async () => {
    mockCreateSubscription.mockImplementationOnce(async () => {
      // Simulate the pg unique-violation shape — code field is what
      // the route matches on, message text is locale-dependent and
      // intentionally not relied on.
      const err = new Error("ignored — locale-dependent message");
      (err as { code?: string }).code = "23505";
      throw err;
    });
    const res = await jsonReq("POST", "/api/v1/sub-processor-subscriptions", {
      url: "https://hooks.example.com/sp",
      token: "shared-secret-at-least-16",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("subscription_already_exists");
  });

  it("does NOT mistake a non-23505 error for a duplicate (regression: regex would have matched)", async () => {
    mockCreateSubscription.mockImplementationOnce(async () => {
      // An unrelated error whose message happens to contain "duplicate
      // key" — the old regex would have wrongly returned 409 for this.
      throw new Error("decryption error: duplicate key version detected");
    });
    const res = await jsonReq("POST", "/api/v1/sub-processor-subscriptions", {
      url: "https://hooks.example.com/sp",
      token: "shared-secret-at-least-16",
    });
    expect(res.status).toBe(500);
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
