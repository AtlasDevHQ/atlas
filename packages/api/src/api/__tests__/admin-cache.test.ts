/**
 * Tests for admin cache management routes.
 *
 * The cache router is mounted under /api/v1/admin/cache via admin.route()
 * and uses createAdminRouter() — admin/owner/platform_admin roles all have
 * access; regular members get 403 (#2167).
 *
 * #4549 — the cache seam here is a REAL `LRUCacheBackend` + the REAL org
 * stats registry (imported from their un-mocked submodules), not a wholesale
 * stub: org-scoped flush is proven by seeding real entries for two orgs and
 * asserting the co-tenant's survive, and the per-caller stats shape is proven
 * by seeding the registry through its public `recordCacheAccess` seam. The
 * singleton/settings glue from `lib/cache/index.ts` is re-implemented as
 * thin wrappers over the real backend (a controllable settings store stands
 * in for the registry reads — the real glue's behavior is covered by
 * `lib/cache/__tests__/index.test.ts`), plus audit is mocked (to drive the
 * #4533 ordering contract).
 *
 * Endpoints:
 * - GET  /cache/stats  — per-caller statistics (workspace bucket vs fleet)
 * - POST /cache/flush  — org-scoped by default; fleet scope platform-only
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterAll,
  mock,
} from "bun:test";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";
import { ADMIN_ACTIONS as REAL_ADMIN_ACTIONS } from "@atlas/api/lib/audit/actions";
import {
  errorMessage as realErrorMessage,
  causeToError as realCauseToError,
} from "@atlas/api/lib/audit/error-scrub";
import type { CacheBackend, CacheEntry } from "@atlas/api/lib/cache/types";
import { LRUCacheBackend } from "@atlas/api/lib/cache/lru";
import { buildCacheKey as realBuildCacheKey } from "@atlas/api/lib/cache/keys";
import { validateCacheBackend as realValidateCacheBackend } from "@atlas/api/lib/cache/validate";
import {
  recordCacheAccess as realRecordCacheAccess,
  getOrgCacheStats as realGetOrgCacheStats,
  getFleetCacheStats as realGetFleetCacheStats,
  resetCacheStatsRegistry as realResetCacheStatsRegistry,
} from "@atlas/api/lib/cache/stats-registry";

// --- Unified mocks ---

// Audit mock — override only the two log entry points so a test can drive the
// audit write into failure (#4533: flush attribution IS the security control,
// so the row must commit before the flush takes effect). ADMIN_ACTIONS and the
// error-scrub helpers stay real (imported from their own, un-mocked modules) so
// the rest of the app behaves identically.
const mockLogAdminAction = mock(() => {});
// Takes the audit entry so tests can assert targetId/metadata on calls.
const mockLogAdminActionAwait = mock((_entry?: unknown): Promise<void> => Promise.resolve());

const auditMockFactory = () => ({
  ADMIN_ACTIONS: REAL_ADMIN_ACTIONS,
  logAdminAction: mockLogAdminAction,
  logAdminActionAwait: mockLogAdminActionAwait,
  errorMessage: realErrorMessage,
  causeToError: realCauseToError,
});

void mock.module("@atlas/api/lib/audit", auditMockFactory);

// Controllable settings store: `key` = platform tier, `key::orgId` =
// workspace override. Mirrors getSetting's precedence for the two
// workspace-scoped cache keys, so tests toggle enabled/TTL the same way an
// admin settings write would.
const settingsStore = new Map<string, string>();
function settingsKey(key: string, orgId?: string): string {
  return orgId ? `${key}::${orgId}` : key;
}
function resolveSetting(key: string, orgId?: string): string | undefined {
  if (orgId && settingsStore.has(settingsKey(key, orgId))) return settingsStore.get(settingsKey(key, orgId));
  return settingsStore.get(key);
}

// The cache barrel mock: a REAL LRU + the REAL stats registry behind the
// same singleton surface `lib/cache/index.ts` exposes. `bun:test` has no
// require-actual, so the barrel (already mocked by createApiTestMocks) is
// re-mocked here with real submodule implementations wired to a swappable
// backend instance. Every value export of the real barrel is present.
let backend: CacheBackend = new LRUCacheBackend(1000, 300_000);

const cacheMockFactory = () => ({
  getCache: () => backend,
  cacheEnabled: (orgId?: string) => {
    const raw = resolveSetting("ATLAS_CACHE_ENABLED", orgId);
    return raw !== "false" && raw !== "0";
  },
  getDefaultTtl: (orgId?: string) => {
    const raw = Number(resolveSetting("ATLAS_CACHE_TTL", orgId) ?? "");
    return Number.isFinite(raw) && raw > 0 ? raw : 300_000;
  },
  setCacheBackend: async (b: CacheBackend) => {
    backend = b;
  },
  flushCache: async () => backend.flush(),
  flushCacheByOrg: async (orgId: string) => backend.flushByOrg(orgId),
  cacheOrgEntryCount: async (orgId: string) =>
    backend instanceof LRUCacheBackend ? backend.entryCountByOrg(orgId) : null,
  // #4550 — same owned-vs-plugin branching as the real index.ts glue.
  cacheListByOrg: async (orgId: string | undefined) =>
    backend instanceof LRUCacheBackend
      ? orgId !== undefined ? backend.listByOrg(orgId) : backend.listAll()
      : null,
  cacheDeleteEntry: async (orgId: string | undefined, key: string) =>
    backend instanceof LRUCacheBackend
      ? orgId !== undefined ? backend.deleteForOrg(orgId, key) : backend.delete(key)
      : null,
  recordCacheAccess: realRecordCacheAccess,
  getOrgCacheStats: realGetOrgCacheStats,
  getFleetCacheStats: realGetFleetCacheStats,
  resetCacheStatsRegistry: realResetCacheStatsRegistry,
  _resetCache: () => {
    backend = new LRUCacheBackend(1000, 300_000);
    realResetCacheStatsRegistry();
  },
  buildCacheKey: realBuildCacheKey,
  validateCacheBackend: realValidateCacheBackend,
});

const mocks = createApiTestMocks({
  authUser: {
    id: "platform-admin-1",
    mode: "managed",
    label: "platform@test.com",
    role: "platform_admin",
    activeOrganizationId: "org-test",
  },
  authMode: "managed",
});

// Re-mock AFTER createApiTestMocks so this factory wins over its stub.
// Both paths: route handlers dynamic-import "@atlas/api/lib/cache/index".
void mock.module("@atlas/api/lib/cache", cacheMockFactory);
void mock.module("@atlas/api/lib/cache/index", cacheMockFactory);

// --- Import app after mocks ---

const { app } = await import("../index");
const cacheApi = await import("@atlas/api/lib/cache/index");

// --- Helpers ---

function setPlatformAdmin(): void {
  mocks.setPlatformAdmin();
}

function setOrgAdmin(): void {
  mocks.setOrgAdmin("org-test");
}

function setMember(): void {
  mocks.setMember("org-test");
}

/**
 * Org owner — user-level role "owner" is admitted by `adminAuth` alongside
 * admin/platform_admin. Factory has no `setOwner` helper, so override
 * `mockAuthenticateRequest` directly. `twoFactorEnabled: true` keeps the
 * F-MFA gate happy.
 */
function setOrgOwner(): void {
  mocks.mockAuthenticateRequest.mockImplementation(() =>
    Promise.resolve({
      authenticated: true,
      mode: "managed",
      user: {
        id: "owner-1",
        mode: "managed",
        label: "owner@test.com",
        role: "owner",
        activeOrganizationId: "org-test",
        claims: { twoFactorEnabled: true },
      },
    }),
  );
}

/**
 * Org admin without an enrolled second factor — exercises the
 * `mfaRequired` gate that `createAdminRouter()` wires in front of every
 * admin route.
 */
function setOrgAdminNoMfa(): void {
  mocks.mockAuthenticateRequest.mockImplementation(() =>
    Promise.resolve({
      authenticated: true,
      mode: "managed",
      user: {
        id: "admin-no-mfa-1",
        mode: "managed",
        label: "admin@test.com",
        role: "admin",
        activeOrganizationId: "org-test",
        claims: { twoFactorEnabled: false },
      },
    }),
  );
}

function cacheRequest(
  urlPath: string,
  method: "GET" | "POST" = "GET",
  body?: Record<string, unknown>,
): Request {
  return new Request(`http://localhost${urlPath}`, {
    method,
    headers: {
      Authorization: "Bearer test-key",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/**
 * A POST with a NON-JSON content type — skips zod-openapi's request
 * validation entirely, so it exercises the handler's own text-based parse
 * (present-but-invalid body → 422, valid body → honored).
 */
function rawBodyRequest(urlPath: string, rawBody: string): Request {
  return new Request(`http://localhost${urlPath}`, {
    method: "POST",
    headers: { Authorization: "Bearer test-key", "Content-Type": "text/plain" },
    body: rawBody,
  });
}

/** An admin with NO active organization (auth mode "none" / single-tenant). */
function setNoOrgAdmin(): void {
  mocks.mockAuthenticateRequest.mockImplementation(() =>
    Promise.resolve({
      authenticated: true,
      mode: "managed",
      user: {
        id: "no-org-admin-1",
        mode: "managed",
        label: "solo@test.com",
        role: "admin",
        claims: { twoFactorEnabled: true },
      },
    }),
  );
}

/** A plugin-style (non-LRU) backend whose per-org count is unavailable. */
function pluginBackend(overrides?: Partial<CacheBackend>): CacheBackend {
  return {
    get: async () => null,
    set: async () => {},
    delete: async () => false,
    flush: async () => {},
    flushByOrg: async () => 5,
    stats: async () => ({ hits: 0, misses: 0, entryCount: 7, maxSize: 100, ttl: 1000 }),
    ...overrides,
  };
}

function makeEntry(overrides?: Partial<CacheEntry>): CacheEntry {
  return {
    columns: ["id"],
    rows: [{ id: 1 }],
    cachedAt: Date.now(),
    ttl: 300_000,
    ...overrides,
  };
}

/** Seed real LRU entries: 2 owned by org-test, 1 by a co-tenant. */
async function seedEntries(): Promise<void> {
  const backend = cacheApi.getCache();
  await backend.set("key-a1", makeEntry(), { orgId: "org-test", connectionId: "default" });
  await backend.set("key-a2", makeEntry(), { orgId: "org-test", connectionId: "default" });
  await backend.set("key-b1", makeEntry(), { orgId: "org-other", connectionId: "default" });
}

async function liveEntryCount(): Promise<number> {
  return (await cacheApi.getCache().stats()).entryCount;
}

// --- Cleanup ---

afterAll(() => {
  mocks.cleanup();
  cacheApi._resetCache();
});

// --- Tests ---

describe("admin cache routes", () => {
  beforeEach(() => {
    settingsStore.clear();
    cacheApi._resetCache(); // fresh backend AND a cleared stats registry
    mockLogAdminAction.mockClear();
    mockLogAdminActionAwait.mockClear();
    mockLogAdminActionAwait.mockImplementation(() => Promise.resolve());
    setPlatformAdmin();
  });

  describe("GET /cache/stats", () => {
    it("returns 403 for non-admin members (#2167 — admin gate, not member)", async () => {
      setMember();
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/stats"));
      expect(res.status).toBe(403);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe("forbidden_role");
    });

    it("returns 403 mfa_enrollment_required when admin has no second factor", async () => {
      setOrgAdminNoMfa();
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/stats"));
      expect(res.status).toBe(403);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe("mfa_enrollment_required");
    });

    it("returns the workspace bucket for an org admin — never fleet-wide counters (audit L13)", async () => {
      // Activity for the caller's org AND a co-tenant; entries for both.
      cacheApi.recordCacheAccess("org-test", true);
      cacheApi.recordCacheAccess("org-test", true);
      cacheApi.recordCacheAccess("org-test", false);
      cacheApi.recordCacheAccess("org-other", false);
      cacheApi.recordCacheAccess("org-other", false);
      await seedEntries();

      setOrgAdmin();
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/stats"));
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.scope).toBe("workspace");
      expect(body.enabled).toBe(true);
      // ONLY org-test's bucket — the co-tenant's misses are invisible.
      expect(body.hits).toBe(2);
      expect(body.misses).toBe(1);
      expect(body.hitRate).toBeCloseTo(2 / 3, 5);
      expect(typeof body.since).toBe("number");
      expect(body.windowHitRate).toBeCloseTo(2 / 3, 5);
      expect(body.windowTotal).toBe(3);
      // Entry count is the org's live entries, not the whole backend's.
      expect(body.entryCount).toBe(2);
      // Fleet capacity framing is withheld from tenants.
      expect(body.maxSize).toBeNull();
    });

    it("returns 200 with the workspace bucket for an org owner (#2167)", async () => {
      setOrgOwner();
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/stats"));
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.scope).toBe("workspace");
    });

    it("returns fleet totals + capacity for a platform admin", async () => {
      cacheApi.recordCacheAccess("org-test", true);
      cacheApi.recordCacheAccess("org-other", false);
      await seedEntries();

      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/stats"));
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.scope).toBe("platform");
      // Fleet aggregate across every org's bucket.
      expect(body.hits).toBe(1);
      expect(body.misses).toBe(1);
      expect(body.hitRate).toBeCloseTo(0.5, 5);
      expect(body.entryCount).toBe(3);
      expect(body.maxSize).toBe(1000); // resolved default capacity
    });

    it("reports the warming state honestly: since null + null rates, never fake zeros", async () => {
      setOrgAdmin();
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/stats"));
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.enabled).toBe(true);
      expect(body.since).toBeNull();
      expect(body.hitRate).toBeNull();
      expect(body.windowHitRate).toBeNull();
      expect(body.windowTotal).toBe(0);
    });

    it("reports honest disabled state (no placeholder telemetry) with the resolved TTL", async () => {
      settingsStore.set("ATLAS_CACHE_ENABLED", "false");
      settingsStore.set("ATLAS_CACHE_TTL", "77777");
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/stats"));
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.enabled).toBe(false);
      expect(body.since).toBeNull();
      expect(body.hitRate).toBeNull();
      expect(body.windowHitRate).toBeNull();
      expect(body.entryCount).toBe(0);
      expect(body.maxSize).toBeNull();
      // The TTL that WOULD apply once re-enabled is still resolved + reported.
      expect(body.ttl).toBe(77777);
    });

    it("resolves TTL through the workspace tier (#4545 — override beats platform)", async () => {
      settingsStore.set("ATLAS_CACHE_TTL", "60000");
      settingsStore.set(settingsKey("ATLAS_CACHE_TTL", "org-test"), "77777");
      setOrgAdmin();
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/stats"));
      const body = await res.json() as Record<string, unknown>;
      expect(body.ttl).toBe(77777);
    });

    it("honors a per-workspace disable for that workspace's admin", async () => {
      settingsStore.set(settingsKey("ATLAS_CACHE_ENABLED", "org-test"), "false");
      setOrgAdmin();
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/stats"));
      const body = await res.json() as Record<string, unknown>;
      expect(body.enabled).toBe(false);
    });

    it("no-org admin (single-tenant): entry count is the whole backend's", async () => {
      await seedEntries();
      setNoOrgAdmin();
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/stats"));
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.scope).toBe("workspace");
      // The whole cache belongs to this one tenant.
      expect(body.entryCount).toBe(3);
      expect(body.maxSize).toBeNull();
    });

    it("plugin backend: workspace entry count is null (unavailable), never a confident 0", async () => {
      await cacheApi.setCacheBackend(pluginBackend());
      setOrgAdmin();
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/stats"));
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.entryCount).toBeNull();
    });

    it("returns 500 with requestId when the backend's stats() throws", async () => {
      const broken: CacheBackend = {
        get: async () => null,
        set: async () => {},
        delete: async () => false,
        flush: async () => {},
        flushByOrg: async () => 0,
        stats: async () => { throw new Error("Redis connection refused"); },
      };
      await cacheApi.setCacheBackend(broken);
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/stats"));
      expect(res.status).toBe(500);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe("internal_error");
      expect(body.requestId).toBeDefined();
    });
  });

  describe("POST /cache/flush", () => {
    it("returns 403 for non-admin members (#2167 — admin gate, not member)", async () => {
      setMember();
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/flush", "POST"));
      expect(res.status).toBe(403);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe("forbidden_role");
    });

    it("returns 403 mfa_enrollment_required when admin has no second factor", async () => {
      await seedEntries();
      setOrgAdminNoMfa();
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/flush", "POST"));
      expect(res.status).toBe(403);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe("mfa_enrollment_required");
      expect(await liveEntryCount()).toBe(3); // nothing flushed
    });

    it("workspace flush (default scope) removes ONLY the caller's org's entries", async () => {
      await seedEntries();
      setOrgAdmin();
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/flush", "POST"));
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(true);
      expect(body.flushed).toBe(2); // org-test's two entries, not the fleet's 3
      // The co-tenant's warm entry survives.
      expect(await liveEntryCount()).toBe(1);
      expect(await cacheApi.getCache().get("key-b1")).not.toBeNull();
      // Audit row targets the org, with scope + count in metadata.
      expect(mockLogAdminActionAwait).toHaveBeenCalledTimes(1);
      const audit = mockLogAdminActionAwait.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(audit.targetId).toBe("org-test");
      expect(audit.metadata).toEqual({ scope: "workspace", orgId: "org-test", flushed: 2 });
    });

    it("explicit scope: workspace behaves identically", async () => {
      await seedEntries();
      setOrgAdmin();
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/flush", "POST", { scope: "workspace" }));
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.flushed).toBe(2);
      expect(await liveEntryCount()).toBe(1);
    });

    it("workspace flush works for an org owner (#2167)", async () => {
      await seedEntries();
      setOrgOwner();
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/flush", "POST"));
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(true);
      expect(body.flushed).toBe(2);
    });

    it("fleet scope is refused for a workspace admin (403, nothing flushed)", async () => {
      await seedEntries();
      setOrgAdmin();
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/flush", "POST", { scope: "fleet" }));
      expect(res.status).toBe(403);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe("forbidden_scope");
      expect(body.requestId).toBeDefined();
      expect(await liveEntryCount()).toBe(3);
      expect(mockLogAdminActionAwait).not.toHaveBeenCalled();
    });

    it("fleet scope clears every workspace's entries for a platform admin", async () => {
      await seedEntries();
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/flush", "POST", { scope: "fleet" }));
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(true);
      expect(body.flushed).toBe(3);
      expect(await liveEntryCount()).toBe(0);
      const audit = mockLogAdminActionAwait.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(audit.targetId).toBe("default");
      expect(audit.metadata).toEqual({ scope: "fleet", flushed: 3 });
    });

    it("a platform admin's DEFAULT flush is still workspace-scoped (fleet is opt-in)", async () => {
      await seedEntries();
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/flush", "POST"));
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      // platform-admin-1's activeOrganizationId is org-test → 2 entries.
      expect(body.flushed).toBe(2);
      expect(await liveEntryCount()).toBe(1);
    });

    it("returns 409 (never a 200 body flag) when caching is disabled", async () => {
      await seedEntries();
      settingsStore.set("ATLAS_CACHE_ENABLED", "false");
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/flush", "POST"));
      expect(res.status).toBe(409);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe("cache_disabled");
      expect(body.requestId).toBeDefined();
      expect(await liveEntryCount()).toBe(3); // refused = nothing removed
      expect(mockLogAdminActionAwait).not.toHaveBeenCalled();
    });

    it("rejects an invalid scope value with 422 (request validation)", async () => {
      await seedEntries();
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/flush", "POST", { scope: "everything" }));
      expect(res.status).toBe(422);
      expect(await liveEntryCount()).toBe(3); // rejected before any flush logic
    });

    it("no-org admin (single-tenant): workspace flush degenerates to a full flush", async () => {
      await seedEntries();
      setNoOrgAdmin();
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/flush", "POST"));
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.flushed).toBe(3);
      expect(await liveEntryCount()).toBe(0);
      const audit = mockLogAdminActionAwait.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(audit.targetId).toBe("default");
      expect(audit.metadata).toEqual({ scope: "workspace", flushed: 3 });
    });

    it("plugin backend: audit records flushed null (unknown), response reports the real removal count", async () => {
      await cacheApi.setCacheBackend(pluginBackend());
      setOrgAdmin();
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/flush", "POST"));
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      // flushByOrg's actual removal count reaches the caller...
      expect(body.flushed).toBe(5);
      // ...while the pre-flush audit row records the count honestly as
      // unknown, never a fake 0 that reads as a no-op in forensics.
      const audit = mockLogAdminActionAwait.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(audit.metadata).toEqual({ scope: "workspace", orgId: "org-test", flushed: null });
    });

    it("a present-but-invalid body with a non-JSON content type is a 422, never a silent workspace downgrade", async () => {
      await seedEntries();
      const res = await app.fetch(rawBodyRequest("/api/v1/admin/cache/flush", '{"scope":"Fleet"}'));
      expect(res.status).toBe(422);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe("invalid_request");
      expect(body.requestId).toBeDefined();
      expect(await liveEntryCount()).toBe(3); // nothing flushed
    });

    it("unparseable non-JSON-content-type body is a 422", async () => {
      await seedEntries();
      const res = await app.fetch(rawBodyRequest("/api/v1/admin/cache/flush", "not json at all"));
      expect(res.status).toBe(422);
      expect(await liveEntryCount()).toBe(3);
    });

    it("a VALID body under a non-JSON content type is still honored (fleet scope enforced)", async () => {
      await seedEntries();
      setOrgAdmin();
      // The handler's own parse must see the fleet scope and 403 it — not
      // silently downgrade to a workspace flush.
      const res = await app.fetch(rawBodyRequest("/api/v1/admin/cache/flush", '{"scope":"fleet"}'));
      expect(res.status).toBe(403);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe("forbidden_scope");
      expect(await liveEntryCount()).toBe(3);
    });

    // #4533 — attribution IS the security control on this shared surface.
    it("commits the audit row before the flush takes effect", async () => {
      await seedEntries();
      setOrgAdmin();
      let entriesDuringAudit = -1;
      mockLogAdminActionAwait.mockImplementation(async () => {
        // Count the caller's org entries at audit time via the REAL backend —
        // still present, because the flush must not have run yet.
        entriesDuringAudit = (await cacheApi.cacheOrgEntryCount("org-test")) ?? -1;
      });
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/flush", "POST"));
      expect(res.status).toBe(200);
      expect(entriesDuringAudit).toBe(2);
      expect(await cacheApi.cacheOrgEntryCount("org-test")).toBe(0);
    });

    // #4533 — a flush must NOT silently succeed when its attribution row can't
    // commit (e.g. audit circuit-breaker open / internal DB down).
    it("does not silently succeed when the audit write fails", async () => {
      await seedEntries();
      setOrgAdmin();
      mockLogAdminActionAwait.mockImplementation(() =>
        Promise.reject(new Error("admin_action_log insert failed")),
      );
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/flush", "POST"));
      expect(res.status).toBe(500);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe("internal_error");
      expect(body.requestId).toBeDefined();
      // The flush is gated on the committed audit row — it never took effect.
      expect(await liveEntryCount()).toBe(3);
    });

    it("returns 500 with requestId when the backend flush throws", async () => {
      const broken: CacheBackend = {
        get: async () => null,
        set: async () => {},
        delete: async () => false,
        flush: async () => { throw new Error("Redis flush failed"); },
        flushByOrg: async () => { throw new Error("Redis flush failed"); },
        stats: async () => ({ hits: 0, misses: 0, entryCount: 1, maxSize: 10, ttl: 1000 }),
      };
      await cacheApi.setCacheBackend(broken);
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/flush", "POST", { scope: "fleet" }));
      expect(res.status).toBe(500);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe("internal_error");
      expect(body.requestId).toBeDefined();
    });
  });

  // ── #4550 — entry inspection + per-entry delete ─────────────────────────

  describe("GET /cache/entries", () => {
    it("lists ONLY the caller's org's live entries, metadata-only (no rows blob)", async () => {
      const backend = cacheApi.getCache();
      await backend.set("key-a1", makeEntry({ sqlPreview: "SELECT * FROM companies", rows: [{ id: 1 }, { id: 2 }] }), { orgId: "org-test", connectionId: "conn-1" });
      await backend.set("key-b1", makeEntry({ sqlPreview: "SELECT secret FROM cotenant" }), { orgId: "org-other", connectionId: "conn-2" });

      setOrgAdmin();
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/entries"));
      expect(res.status).toBe(200);
      const body = await res.json() as { entries: Array<Record<string, unknown>> };
      expect(body.entries).toHaveLength(1);
      const entry = body.entries[0]!;
      expect(entry.key).toBe("key-a1");
      expect(entry.sqlPreview).toBe("SELECT * FROM companies");
      expect(entry.connectionId).toBe("conn-1");
      expect(entry.rowCount).toBe(2);
      expect(typeof entry.ageMs).toBe("number");
      // The cached rows themselves never cross this surface.
      expect(entry.rows).toBeUndefined();
      expect(entry.columns).toBeUndefined();
      // The co-tenant's SQL never appears anywhere in the payload.
      expect(JSON.stringify(body)).not.toContain("cotenant");
    });

    it("expired entries never appear in the list", async () => {
      const backend = cacheApi.getCache();
      await backend.set("live", makeEntry({ sqlPreview: "SELECT 1" }), { orgId: "org-test", connectionId: "default" });
      await backend.set("dead", makeEntry({ sqlPreview: "SELECT 2", cachedAt: Date.now() - 400_000, ttl: 300_000 }), { orgId: "org-test", connectionId: "default" });

      setOrgAdmin();
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/entries"));
      const body = await res.json() as { entries: Array<{ key: string }> };
      expect(body.entries.map((e) => e.key)).toEqual(["live"]);
    });

    it("a workspace admin may NOT inspect another org via ?orgId= (403)", async () => {
      await seedEntries();
      setOrgAdmin();
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/entries?orgId=org-other"));
      expect(res.status).toBe(403);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe("forbidden_scope");
    });

    it("a platform admin MAY inspect a specific org via ?orgId=", async () => {
      await seedEntries();
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/entries?orgId=org-other"));
      expect(res.status).toBe(200);
      const body = await res.json() as { entries: Array<{ key: string }> };
      expect(body.entries.map((e) => e.key)).toEqual(["key-b1"]);
    });

    it("a workspace admin naming their OWN org via ?orgId= is fine", async () => {
      await seedEntries();
      setOrgAdmin();
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/entries?orgId=org-test"));
      expect(res.status).toBe(200);
      const body = await res.json() as { entries: unknown[] };
      expect(body.entries).toHaveLength(2);
    });

    it("no-org admin (single-tenant): lists every live entry", async () => {
      await seedEntries();
      setNoOrgAdmin();
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/entries"));
      const body = await res.json() as { entries: unknown[] };
      expect(body.entries).toHaveLength(3);
    });

    it("disabled cache lists as empty (read-only surface — no 409)", async () => {
      await seedEntries();
      settingsStore.set("ATLAS_CACHE_ENABLED", "false");
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/entries"));
      const body = await res.json() as { entries: unknown[] };
      expect(body.entries).toEqual([]);
    });

    it("plugin backend: entries is null (unavailable), never a confident empty table", async () => {
      await cacheApi.setCacheBackend(pluginBackend());
      setOrgAdmin();
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/entries"));
      expect(res.status).toBe(200);
      const body = await res.json() as { entries: unknown };
      expect(body.entries).toBeNull();
    });

    it("returns 403 for non-admin members", async () => {
      setMember();
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/entries"));
      expect(res.status).toBe(403);
    });
  });

  describe("DELETE /cache/entries/:key", () => {
    const del = (key: string) =>
      new Request(`http://localhost/api/v1/admin/cache/entries/${encodeURIComponent(key)}`, {
        method: "DELETE",
        headers: { Authorization: "Bearer test-key" },
      });

    it("removes exactly the caller's org's entry and keeps the index consistent", async () => {
      await seedEntries();
      setOrgAdmin();
      const res = await app.fetch(del("key-a1"));
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.deleted).toBe(true);
      // Exactly one entry gone; sibling + co-tenant intact.
      expect(await cacheApi.getCache().get("key-a1")).toBeNull();
      expect(await cacheApi.getCache().get("key-a2")).not.toBeNull();
      expect(await cacheApi.getCache().get("key-b1")).not.toBeNull();
      // Org index stays consistent: the org's live count reflects the delete.
      expect(await cacheApi.cacheOrgEntryCount("org-test")).toBe(1);
      // Audit row: deleteEntry action, truncated key, org target.
      expect(mockLogAdminActionAwait).toHaveBeenCalledTimes(1);
      const audit = mockLogAdminActionAwait.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(audit.actionType).toBe("cache.delete_entry");
      expect(audit.targetId).toBe("org-test");
      expect(audit.metadata).toEqual({ orgId: "org-test", key: "key-a1".slice(0, 12) });
    });

    it("a co-tenant's key 404s and the entry survives (indistinguishable from missing)", async () => {
      await seedEntries();
      setOrgAdmin();
      const res = await app.fetch(del("key-b1"));
      expect(res.status).toBe(404);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe("not_found");
      expect(await cacheApi.getCache().get("key-b1")).not.toBeNull();
    });

    it("a missing key 404s with the same shape as a co-tenant's key", async () => {
      await seedEntries();
      setOrgAdmin();
      const res = await app.fetch(del("no-such-key"));
      expect(res.status).toBe(404);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe("not_found");
    });

    it("no-org admin (single-tenant): plain delete of any entry", async () => {
      await seedEntries();
      setNoOrgAdmin();
      const res = await app.fetch(del("key-b1"));
      expect(res.status).toBe(200);
      expect(await liveEntryCount()).toBe(2);
    });

    it("disabled cache refuses with 409", async () => {
      await seedEntries();
      settingsStore.set("ATLAS_CACHE_ENABLED", "false");
      setOrgAdmin();
      const res = await app.fetch(del("key-a1"));
      expect(res.status).toBe(409);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe("cache_disabled");
      expect(await liveEntryCount()).toBe(3);
    });

    it("plugin backend: 409 unsupported_backend (no trustworthy org index to authorize against)", async () => {
      await cacheApi.setCacheBackend(pluginBackend());
      setOrgAdmin();
      const res = await app.fetch(del("some-key"));
      expect(res.status).toBe(409);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe("unsupported_backend");
    });

    it("returns 403 for non-admin members", async () => {
      setMember();
      const res = await app.fetch(del("key-a1"));
      expect(res.status).toBe(403);
    });
  });
});
