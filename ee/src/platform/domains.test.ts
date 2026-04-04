import { describe, it, expect, beforeEach, mock } from "bun:test";
import { Effect } from "effect";
import { createEEMock } from "../__mocks__/internal";

// ── Mocks ───────────────────────────────────────────────────────────

const ee = createEEMock();

mock.module("../index", () => ee.enterpriseMock);
const hasDB = () => (ee.internalDBMock.hasInternalDB as () => boolean)();
mock.module("../lib/db-guard", () => ({
  requireInternalDB: (label: string, factory?: () => Error) => {
    if (!hasDB()) {
      if (factory) throw factory();
      throw new Error(`Internal database required for ${label}.`);
    }
  },
  requireInternalDBEffect: (label: string, factory?: () => Error) => {
    return hasDB()
      ? Effect.void
      : Effect.fail(factory?.() ?? new Error(`Internal database required for ${label}.`));
  },
}));
mock.module("@atlas/api/lib/db/internal", () => ee.internalDBMock);
mock.module("@atlas/api/lib/logger", () => ee.loggerMock);

// Mock Railway GraphQL API via global fetch
const mockFetchResponses: Array<{ ok: boolean; status: number; json: unknown }> = [];
let fetchCallCount = 0;
const capturedFetches: Array<{ url: string; body: unknown }> = [];

const originalFetch = globalThis.fetch;
// @ts-expect-error — mock fetch for Railway API calls only; preconnect not needed in tests
globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.includes("railway.com")) {
    const body = init?.body ? JSON.parse(init.body as string) : {};
    capturedFetches.push({ url, body });
    const response = mockFetchResponses[fetchCallCount] ?? { ok: true, status: 200, json: { data: {} } };
    fetchCallCount++;
    return {
      ok: response.ok,
      status: response.status,
      json: async () => response.json,
      text: async () => JSON.stringify(response.json),
    } as Response;
  }
  return originalFetch(input, init);
};

// Import after mocks
const {
  registerDomain,
  verifyDomain,
  listDomains,
  listAllDomains,
  deleteDomain,
  resolveWorkspaceByHost,
  _resetHostCache,
  DomainError,
} = await import("./domains");

// ── Helpers ─────────────────────────────────────────────────────────

/** Run an Effect, converting failures to rejected promises for test assertions. */
const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect as Effect.Effect<A, never>);

function resetMocks() {
  ee.reset();
  mockFetchResponses.length = 0;
  fetchCallCount = 0;
  capturedFetches.length = 0;
  _resetHostCache();

  // Set Railway env vars
  process.env.RAILWAY_API_TOKEN = "test-token";
  process.env.RAILWAY_PROJECT_ID = "proj-123";
  process.env.RAILWAY_ENVIRONMENT_ID = "env-456";
  process.env.RAILWAY_WEB_SERVICE_ID = "svc-789";
}

function cleanupEnv() {
  delete process.env.RAILWAY_API_TOKEN;
  delete process.env.RAILWAY_PROJECT_ID;
  delete process.env.RAILWAY_ENVIRONMENT_ID;
  delete process.env.RAILWAY_WEB_SERVICE_ID;
}

const MOCK_NOW = new Date("2026-03-23T12:00:00Z");

function makeDomainRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "dom-1",
    workspace_id: "org-1",
    domain: "data.acme.com",
    status: "pending",
    railway_domain_id: "rw-abc",
    cname_target: "abc.up.railway.app",
    certificate_status: "PENDING",
    created_at: MOCK_NOW,
    verified_at: null,
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("domains", () => {
  beforeEach(resetMocks);

  describe("registerDomain", () => {
    it("registers a valid domain via Railway", async () => {
      // Check for existing → no results
      ee.queueMockRows([]);
      // Railway availability check
      mockFetchResponses.push({
        ok: true,
        status: 200,
        json: { data: { customDomainAvailable: { available: true, message: "" } } },
      });
      // Railway domain create
      mockFetchResponses.push({
        ok: true,
        status: 200,
        json: {
          data: {
            customDomainCreate: {
              id: "rw-abc",
              domain: "data.acme.com",
              status: {
                dnsRecords: [{ requiredValue: "abc.up.railway.app", currentValue: null, status: "PENDING" }],
                certificateStatus: "PENDING",
              },
            },
          },
        },
      });
      // INSERT → returning
      ee.queueMockRows([makeDomainRow()]);

      const result = await run(registerDomain("org-1", "data.acme.com"));
      expect(result.domain).toBe("data.acme.com");
      expect(result.workspaceId).toBe("org-1");
      expect(result.railwayDomainId).toBe("rw-abc");
      expect(result.cnameTarget).toBe("abc.up.railway.app");
      expect(result.status).toBe("pending");
      expect(capturedFetches).toHaveLength(2);
    });

    it("rejects invalid domain format", async () => {
      await expect(run(registerDomain("org-1", "not a domain"))).rejects.toThrow("Invalid domain");
    });

    it("rejects IP addresses", async () => {
      await expect(run(registerDomain("org-1", "192.168.1.1"))).rejects.toThrow("Invalid domain");
    });

    it("rejects duplicate domain in local DB", async () => {
      ee.queueMockRows([{ id: "existing" }]); // existing domain found
      await expect(run(registerDomain("org-1", "data.acme.com"))).rejects.toThrow("already registered");
    });

    it("rejects domain unavailable on Railway", async () => {
      ee.queueMockRows([]); // no existing
      mockFetchResponses.push({
        ok: true,
        status: 200,
        json: { data: { customDomainAvailable: { available: false, message: "Domain is already in use" } } },
      });
      await expect(run(registerDomain("org-1", "data.acme.com"))).rejects.toThrow("not available");
    });

    it("normalizes domain to lowercase", async () => {
      ee.queueMockRows([]);
      mockFetchResponses.push({
        ok: true,
        status: 200,
        json: { data: { customDomainAvailable: { available: true, message: "" } } },
      });
      mockFetchResponses.push({
        ok: true,
        status: 200,
        json: {
          data: {
            customDomainCreate: {
              id: "rw-abc",
              domain: "data.acme.com",
              status: {
                dnsRecords: [{ requiredValue: "abc.up.railway.app", currentValue: null, status: "PENDING" }],
                certificateStatus: "PENDING",
              },
            },
          },
        },
      });
      ee.queueMockRows([makeDomainRow()]);

      await run(registerDomain("org-1", "DATA.ACME.COM"));
      // The INSERT query should use lowercase domain
      const insertQuery = ee.capturedQueries.find((q) => q.sql.includes("INSERT"));
      expect(insertQuery?.params?.[1]).toBe("data.acme.com");
    });

    it("throws when Railway is not configured", async () => {
      cleanupEnv();
      ee.queueMockRows([]); // no existing
      await expect(run(registerDomain("org-1", "data.acme.com"))).rejects.toThrow("Railway API is not configured");
    });

    it("throws on Railway GraphQL errors (200 with errors array)", async () => {
      ee.queueMockRows([]); // no existing
      mockFetchResponses.push({
        ok: true,
        status: 200,
        json: { data: { customDomainAvailable: { available: true, message: "" } } },
      });
      // Railway create returns GraphQL errors
      mockFetchResponses.push({
        ok: true,
        status: 200,
        json: { errors: [{ message: "Permission denied" }] },
      });
      await expect(run(registerDomain("org-1", "data.acme.com"))).rejects.toThrow("Railway API error");
    });

    it("throws on Railway missing data field", async () => {
      ee.queueMockRows([]); // no existing
      mockFetchResponses.push({
        ok: true,
        status: 200,
        json: { data: { customDomainAvailable: { available: true, message: "" } } },
      });
      // Railway returns 200 but no data
      mockFetchResponses.push({
        ok: true,
        status: 200,
        json: {},
      });
      await expect(run(registerDomain("org-1", "data.acme.com"))).rejects.toThrow("Railway API returned no data");
    });

    it("throws on Railway network error", async () => {
      ee.queueMockRows([]); // no existing
      // Override fetch to throw network error for railway calls
      const prevFetch = globalThis.fetch;
      // @ts-expect-error — mock fetch for network failure test
      globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
      try {
        await expect(run(registerDomain("org-1", "data.acme.com"))).rejects.toThrow("Could not reach Railway API");
      } finally {
        globalThis.fetch = prevFetch;
      }
    });
  });

  describe("verifyDomain", () => {
    it("marks domain as verified when Railway says cert is ISSUED and DNS is valid", async () => {
      // SELECT domain
      ee.queueMockRows([makeDomainRow()]);
      // Railway status check
      mockFetchResponses.push({
        ok: true,
        status: 200,
        json: {
          data: {
            customDomain: {
              id: "rw-abc",
              domain: "data.acme.com",
              status: {
                dnsRecords: [{ requiredValue: "abc.up.railway.app", currentValue: "abc.up.railway.app", status: "VALID" }],
                certificateStatus: "ISSUED",
              },
            },
          },
        },
      });
      // UPDATE → returning
      ee.queueMockRows([makeDomainRow({ status: "verified", certificate_status: "ISSUED", verified_at: MOCK_NOW })]);

      const result = await run(verifyDomain("dom-1"));
      expect(result.status).toBe("verified");
      expect(result.certificateStatus).toBe("ISSUED");
    });

    it("keeps domain pending when cert is still PENDING", async () => {
      ee.queueMockRows([makeDomainRow()]);
      mockFetchResponses.push({
        ok: true,
        status: 200,
        json: {
          data: {
            customDomain: {
              id: "rw-abc",
              domain: "data.acme.com",
              status: {
                dnsRecords: [{ requiredValue: "abc.up.railway.app", currentValue: null, status: "PENDING" }],
                certificateStatus: "PENDING",
              },
            },
          },
        },
      });
      ee.queueMockRows([makeDomainRow({ status: "pending", certificate_status: "PENDING" })]);

      const result = await run(verifyDomain("dom-1"));
      expect(result.status).toBe("pending");
    });

    it("marks domain as failed when cert is FAILED", async () => {
      ee.queueMockRows([makeDomainRow()]);
      mockFetchResponses.push({
        ok: true,
        status: 200,
        json: {
          data: {
            customDomain: {
              id: "rw-abc",
              domain: "data.acme.com",
              status: {
                dnsRecords: [{ requiredValue: "abc.up.railway.app", currentValue: null, status: "PENDING" }],
                certificateStatus: "FAILED",
              },
            },
          },
        },
      });
      ee.queueMockRows([makeDomainRow({ status: "failed", certificate_status: "FAILED" })]);

      const result = await run(verifyDomain("dom-1"));
      expect(result.status).toBe("failed");
    });

    it("stays pending when cert is ISSUED but DNS is not valid", async () => {
      ee.queueMockRows([makeDomainRow()]);
      mockFetchResponses.push({
        ok: true,
        status: 200,
        json: {
          data: {
            customDomain: {
              id: "rw-abc",
              domain: "data.acme.com",
              status: {
                dnsRecords: [{ requiredValue: "abc.up.railway.app", currentValue: null, status: "PENDING" }],
                certificateStatus: "ISSUED",
              },
            },
          },
        },
      });
      ee.queueMockRows([makeDomainRow({ status: "pending", certificate_status: "ISSUED" })]);

      const result = await run(verifyDomain("dom-1"));
      expect(result.status).toBe("pending");
    });

    it("throws for nonexistent domain", async () => {
      ee.queueMockRows([]); // no results
      await expect(run(verifyDomain("dom-999"))).rejects.toThrow("not found");
    });

    it("throws when domain has no Railway ID", async () => {
      ee.queueMockRows([makeDomainRow({ railway_domain_id: null })]);
      await expect(run(verifyDomain("dom-1"))).rejects.toThrow("no Railway domain ID");
    });
  });

  describe("listDomains", () => {
    it("returns domains for workspace", async () => {
      ee.queueMockRows([
        makeDomainRow(),
        makeDomainRow({ id: "dom-2", domain: "api.acme.com", status: "verified" }),
      ]);

      const result = await run(listDomains("org-1"));
      expect(result).toHaveLength(2);
      expect(result[0].domain).toBe("data.acme.com");
      expect(result[1].domain).toBe("api.acme.com");
    });

    it("returns empty array when workspace has no domains", async () => {
      ee.queueMockRows([]);
      const result = await run(listDomains("org-1"));
      expect(result).toHaveLength(0);
    });
  });

  describe("listAllDomains", () => {
    it("returns all domains across workspaces", async () => {
      ee.queueMockRows([
        makeDomainRow(),
        makeDomainRow({ id: "dom-2", workspace_id: "org-2", domain: "api.other.com" }),
      ]);

      const result = await run(listAllDomains());
      expect(result).toHaveLength(2);
    });
  });

  describe("deleteDomain", () => {
    it("deletes domain from both Railway and local DB", async () => {
      // SELECT domain
      ee.queueMockRows([makeDomainRow()]);
      // Railway delete
      mockFetchResponses.push({
        ok: true,
        status: 200,
        json: { data: { customDomainDelete: true } },
      });
      // DELETE
      ee.queueMockRows([]);

      await run(deleteDomain("dom-1"));
      expect(capturedFetches).toHaveLength(1); // Railway delete called
      expect(ee.capturedQueries).toHaveLength(2); // SELECT + DELETE
    });

    it("throws for nonexistent domain", async () => {
      ee.queueMockRows([]); // no results
      await expect(run(deleteDomain("dom-999"))).rejects.toThrow("not found");
    });

    it("proceeds with local delete even if Railway delete fails", async () => {
      ee.queueMockRows([makeDomainRow()]);
      // Railway delete fails
      mockFetchResponses.push({
        ok: false,
        status: 500,
        json: { errors: [{ message: "Internal error" }] },
      });
      // Local DELETE still runs
      ee.queueMockRows([]);

      // Should not throw
      await run(deleteDomain("dom-1"));
      expect(ee.capturedQueries).toHaveLength(2); // SELECT + DELETE
    });

    it("skips Railway delete when no railway_domain_id", async () => {
      ee.queueMockRows([makeDomainRow({ railway_domain_id: null })]);
      ee.queueMockRows([]); // DELETE

      await run(deleteDomain("dom-1"));
      expect(capturedFetches).toHaveLength(0); // No Railway call
    });
  });

  describe("resolveWorkspaceByHost", () => {
    it("resolves verified domain to workspace ID", async () => {
      ee.queueMockRows([{ workspace_id: "org-1" }]);
      const result = await run(resolveWorkspaceByHost("data.acme.com"));
      expect(result).toBe("org-1");
    });

    it("returns null for unknown domain", async () => {
      ee.queueMockRows([]);
      const result = await run(resolveWorkspaceByHost("unknown.example.com"));
      expect(result).toBeNull();
    });

    it("uses cache on second lookup", async () => {
      ee.queueMockRows([{ workspace_id: "org-1" }]);
      await run(resolveWorkspaceByHost("data.acme.com"));
      // Second call should not hit DB
      const result = await run(resolveWorkspaceByHost("data.acme.com"));
      expect(result).toBe("org-1");
      expect(ee.capturedQueries).toHaveLength(1); // Only one DB query
    });

    it("normalizes hostname to lowercase", async () => {
      ee.queueMockRows([{ workspace_id: "org-1" }]);
      await run(resolveWorkspaceByHost("DATA.ACME.COM"));
      const query = ee.capturedQueries[0];
      expect(query.params?.[0]).toBe("data.acme.com");
    });

    it("returns null gracefully on DB error", async () => {
      ee.queueMockRows([]);
      const result = await run(resolveWorkspaceByHost("unknown.example.com"));
      expect(result).toBeNull();
      // Verify negative cache prevents second DB hit
      const result2 = await run(resolveWorkspaceByHost("unknown.example.com"));
      expect(result2).toBeNull();
      expect(ee.capturedQueries).toHaveLength(1); // Only one DB query — negative cache worked
    });
  });

  describe("DomainError", () => {
    it("has correct name and code", () => {
      const err = new DomainError("test", "invalid_domain");
      expect(err.name).toBe("DomainError");
      expect(err.code).toBe("invalid_domain");
      expect(err.message).toBe("test");
    });
  });
});
