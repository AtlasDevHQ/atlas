/**
 * Dispatch-time lazy credential resolution tests for SaasCrmLive
 * (#2847 follow-up). Covers behaviors that the original saas-crm
 * test file did not exercise:
 *
 *   • dispatcher re-reads twenty_integrations on every call
 *     (admin-UI install post-boot applies without restart)
 *   • dispatcher falls back to env when DB row is absent (Disconnect
 *     path)
 *   • dispatcher fails permanently when DB decrypt errors — no silent
 *     env fallback that would route leads to the wrong Twenty
 *   • ensureVerified caches per (apiKey, baseUrl) pair so a credential
 *     swap mid-run triggers exactly one extra metadata roundtrip
 *   • normalizeDbCredentials trims and strips trailing slashes from
 *     DB-sourced credentials (Codex P2)
 *   • envClientConfig is derived from env, NOT bootCreds, so Disconnect
 *     after a DB-only boot actually falls back to env (Codex P1)
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";

// ── Enterprise + logger + internal-DB mocks (shared with sibling test) ─

let enterpriseEnabled = true;
mock.module("../../index", () => ({
  isEnterpriseEnabled: () => enterpriseEnabled,
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

let internalDbAvailable = true;
mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => internalDbAvailable,
  internalQuery: async () => [],
}));

// ── Store mock — programmable per-test ──────────────────────────────

interface FakeRow {
  workspaceId: string;
  apiKey: string;
  baseUrl: string | null;
  updatedAt: string;
}

let storeRows: FakeRow[] = [];
let findLatestImpl: () => Promise<FakeRow | null> = async () => {
  // Default impl mirrors "ORDER BY updated_at DESC LIMIT 1".
  if (storeRows.length === 0) return null;
  return storeRows.reduce((a, b) => (a.updatedAt > b.updatedAt ? a : b));
};

mock.module("@atlas/api/lib/integrations/twenty/store", () => ({
  findLatestTwentyDbCredentials: async () => {
    const row = await findLatestImpl();
    if (!row) return null;
    return {
      workspaceId: row.workspaceId,
      apiKey: row.apiKey,
      baseUrl: row.baseUrl,
      updatedAt: row.updatedAt,
    };
  },
  // Other store exports are not consumed by saas-crm at runtime.
  saveTwentyIntegration: async () => {
    throw new Error("not used in dispatch tests");
  },
  deleteTwentyIntegration: async () => false,
  getTwentyIntegrationPublic: async () => null,
  getTwentyIntegrationWithSecret: async () => null,
}));

const {
  normalizeDbCredentials,
  resolveDispatchClientConfig,
  ensureVerified,
  verifiedCredentialCache,
  ATLAS_SAAS_TWENTY_BASE_URL,
} = await import("../index");
const { TwentyDecryptError } = await import("@useatlas/twenty");

function resetState(): void {
  enterpriseEnabled = true;
  internalDbAvailable = true;
  storeRows = [];
  findLatestImpl = async () => {
    if (storeRows.length === 0) return null;
    return storeRows.reduce((a, b) => (a.updatedAt > b.updatedAt ? a : b));
  };
  verifiedCredentialCache.clear();
}

// ── normalizeDbCredentials ─────────────────────────────────────────

describe("normalizeDbCredentials — Codex P2 (DB creds trimmed/normalized)", () => {
  beforeEach(resetState);

  test("trims surrounding whitespace on apiKey", () => {
    const result = normalizeDbCredentials({
      apiKey: "   abc-123\n",
      baseUrl: "https://crm.example.com",
    });
    expect(result?.apiKey).toBe("abc-123");
  });

  test("trims surrounding whitespace AND strips trailing slashes on baseUrl", () => {
    const result = normalizeDbCredentials({
      apiKey: "abc",
      baseUrl: "  https://crm.example.com//  ",
    });
    expect(result?.baseUrl).toBe("https://crm.example.com");
  });

  test("returns null for empty / whitespace-only apiKey", () => {
    expect(normalizeDbCredentials({ apiKey: "", baseUrl: "x" })).toBeNull();
    expect(normalizeDbCredentials({ apiKey: "   ", baseUrl: "x" })).toBeNull();
  });

  test("returns source: 'db' on every successful normalization", () => {
    const result = normalizeDbCredentials({
      apiKey: "abc",
      baseUrl: null,
    });
    expect(result?.source).toBe("db");
    expect(result?.baseUrl).toBeUndefined();
  });
});

// ── resolveDispatchClientConfig ─────────────────────────────────────

describe("resolveDispatchClientConfig — admin-UI lazy resolution", () => {
  beforeEach(resetState);

  test("DB row present → consumes DB creds (admin UI overrides env)", async () => {
    storeRows = [
      {
        workspaceId: "ws-1",
        apiKey: "db-key",
        baseUrl: "https://db.example.com",
        updatedAt: "2026-05-26T00:00:00Z",
      },
    ];
    const envFallback = {
      apiKey: "env-key",
      baseUrl: "https://env.example.com",
      timeoutMs: 5000,
    };
    const result = await resolveDispatchClientConfig(envFallback);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.clientConfig.apiKey).toBe("db-key");
      expect(result.clientConfig.baseUrl).toBe("https://db.example.com");
      expect(result.creds.source).toBe("db");
    }
  });

  test("DB row absent + env fallback present → env clientConfig (source: env)", async () => {
    storeRows = [];
    const envFallback = {
      apiKey: "env-key",
      baseUrl: "https://env.example.com",
      timeoutMs: 5000,
    };
    const result = await resolveDispatchClientConfig(envFallback);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.clientConfig).toEqual(envFallback);
      expect(result.creds.source).toBe("env");
    }
  });

  test("DB row absent + NO env fallback → fail_permanent (Codex P1 — Disconnect after DB-only boot)", async () => {
    storeRows = [];
    const result = await resolveDispatchClientConfig(null);
    expect(result.kind).toBe("fail_permanent");
    if (result.kind === "fail_permanent") {
      expect(result.message).toContain("Twenty credentials missing");
      expect(result.message).toContain("Admin");
    }
  });

  test("Transport-throw on lookup → falls back to env (fail-open)", async () => {
    findLatestImpl = async () => {
      throw new Error("pg connection refused");
    };
    const envFallback = {
      apiKey: "env-key",
      baseUrl: "https://env.example.com",
      timeoutMs: 5000,
    };
    const result = await resolveDispatchClientConfig(envFallback);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.clientConfig.apiKey).toBe("env-key");
    }
  });

  test("Decrypt-throw on lookup → fail_permanent (NO silent env fallback)", async () => {
    findLatestImpl = async () => {
      throw new TwentyDecryptError("key v2 missing from ATLAS_ENCRYPTION_KEYS");
    };
    const envFallback = {
      apiKey: "env-key",
      baseUrl: "https://env.example.com",
      timeoutMs: 5000,
    };
    const result = await resolveDispatchClientConfig(envFallback);
    expect(result.kind).toBe("fail_permanent");
    if (result.kind === "fail_permanent") {
      expect(result.message).toContain("decryption failed");
      expect(result.message).toContain("ATLAS_ENCRYPTION_KEYS");
    }
  });

  test("DB row with whitespace + trailing slashes is normalized before dispatch", async () => {
    storeRows = [
      {
        workspaceId: "ws-1",
        apiKey: "  trim-me  ",
        baseUrl: " https://crm.example.com///  ",
        updatedAt: "2026-05-26T00:00:00Z",
      },
    ];
    const envFallback = {
      apiKey: "env-key",
      baseUrl: ATLAS_SAAS_TWENTY_BASE_URL,
      timeoutMs: 5000,
    };
    const result = await resolveDispatchClientConfig(envFallback);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.clientConfig.apiKey).toBe("trim-me");
      expect(result.clientConfig.baseUrl).toBe("https://crm.example.com");
    }
  });

  test("re-resolves on each call (Codex P1 — no caching of stale boot creds)", async () => {
    let callCount = 0;
    findLatestImpl = async () => {
      callCount++;
      return null;
    };
    const envFallback = {
      apiKey: "env-key",
      baseUrl: "https://env.example.com",
      timeoutMs: 5000,
    };
    await resolveDispatchClientConfig(envFallback);
    await resolveDispatchClientConfig(envFallback);
    await resolveDispatchClientConfig(envFallback);
    expect(callCount).toBe(3);
  });
});

// ── ensureVerified caching ─────────────────────────────────────────

describe("ensureVerified — per-credential verification cache", () => {
  beforeEach(resetState);

  test("cache hit short-circuits verification", async () => {
    let metadataCalls = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      metadataCalls++;
      return new Response(
        JSON.stringify({
          data: {
            objects: {
              edges: [
                {
                  node: {
                    fields: {
                      edges: [
                        { node: { name: "atlasFirstSource" } },
                        { node: { name: "atlasLastSource" } },
                      ],
                    },
                  },
                },
              ],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;
    try {
      const creds = {
        apiKey: "k",
        baseUrl: "https://crm.test.local",
        source: "db" as const,
      };
      const first = await ensureVerified(creds);
      const second = await ensureVerified(creds);
      const third = await ensureVerified(creds);
      expect(first.kind).toBe("ok");
      expect(second.kind).toBe("ok");
      expect(third.kind).toBe("ok");
      expect(metadataCalls).toBe(1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("permanent verify failure → fail_permanent (dead-letter signal)", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ messages: ["Unauthorized"] }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof globalThis.fetch;
    try {
      const creds = {
        apiKey: "wrong-key",
        baseUrl: "https://crm.test.local",
        source: "db" as const,
      };
      const outcome = await ensureVerified(creds);
      expect(outcome.kind).toBe("fail_permanent");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("transient verify failure proceeds without caching", async () => {
    let metadataCalls = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      metadataCalls++;
      throw new Error("ECONNRESET");
    }) as unknown as typeof globalThis.fetch;
    try {
      const creds = {
        apiKey: "k",
        baseUrl: "https://crm.test.local",
        source: "db" as const,
      };
      const first = await ensureVerified(creds);
      const second = await ensureVerified(creds);
      expect(first.kind).toBe("ok");
      expect(second.kind).toBe("ok");
      // Both invocations should hit fetch because transient outcome
      // does NOT populate the cache.
      expect(metadataCalls).toBe(2);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("different (apiKey, baseUrl) pair triggers a new verification", async () => {
    let metadataCalls = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      metadataCalls++;
      return new Response(
        JSON.stringify({
          data: {
            objects: {
              edges: [
                {
                  node: {
                    fields: {
                      edges: [
                        { node: { name: "atlasFirstSource" } },
                        { node: { name: "atlasLastSource" } },
                      ],
                    },
                  },
                },
              ],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;
    try {
      const credsA = {
        apiKey: "key-A",
        baseUrl: "https://crm.test.local",
        source: "db" as const,
      };
      const credsB = {
        apiKey: "key-B",
        baseUrl: "https://crm.test.local",
        source: "db" as const,
      };
      await ensureVerified(credsA);
      await ensureVerified(credsB);
      await ensureVerified(credsA);
      await ensureVerified(credsB);
      expect(metadataCalls).toBe(2);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
