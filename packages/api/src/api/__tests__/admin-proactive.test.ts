/**
 * Tests for the admin proactive-chat routes.
 *
 * Exercises the four wire endpoints (GET / PUT workspace, GET / POST /
 * DELETE channels) plus the enterprise gate. Internal-DB writes are
 * mocked at the `internalQuery` boundary — the real-Postgres migration
 * smoke (`migrate-pg.test.ts`) covers the SQL plan for the new tables
 * end-to-end, so this file is the route-shape regression net.
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";

// Real ADMIN_ACTIONS so audit-row assertions pin to canonical strings.
import { ADMIN_ACTIONS as REAL_ADMIN_ACTIONS } from "@atlas/api/lib/audit/actions";
import type { AnnouncementOutcome } from "@atlas/api/lib/proactive/types";

// --- Enterprise gate: flip the env var so the real `isEnterpriseEnabled`
//     resolves true without reshaping the @atlas/ee/index surface. Tests
//     that need the OFF path stash + restore the original value. ---
const ORIGINAL_EE_FLAG = process.env.ATLAS_ENTERPRISE_ENABLED;
// Module-top env setup — must be set before the dynamic imports below
// (the imported modules read env at module-load time). `??=` keeps the
// assignment hoisted; cross-file leakage under `bun test --parallel`
// (1.5.4 #2797) is bounded — the first file to load wins, no sibling
// overwrites. Files that need to restore env do so in their own
// afterAll; the `??=` here is the module-load contract, not teardown.
process.env.ATLAS_ENTERPRISE_ENABLED ??= "true";
// Pin self-hosted so the per-tier proactive entitlement gate (#4064) — which
// `admin-proactive.ts` now applies via `requireFeatureEntitlementOrThrow` after
// `gateEnterprise()` — is a no-op here: this file exercises workspace-config CRUD
// and the deployment-level enterprise gate, not the SaaS per-tier ladder (that is
// covered by `feature-entitlement-proactive.test.ts`). Without this, the env would
// auto-resolve to `saas` (enterprise enabled + internal DB, absent an
// `ATLAS_DEPLOY_ENV=development` short-circuit), and the guard's workspace-tier
// lookup — unsatisfied by this file's hand-rolled internal mock — would 403 every
// CRUD assertion. `??=` keeps the module-load contract hoistable.
process.env.ATLAS_DEPLOY_MODE ??= "self-hosted";

// --- Auth mock ---

const mockAuthenticateRequest: Mock<(req: Request) => Promise<unknown>> = mock(
  () =>
    Promise.resolve({
      authenticated: true,
      mode: "simple-key",
      user: {
        id: "admin-1",
        mode: "simple-key",
        label: "Admin",
        role: "admin",
        activeOrganizationId: "org-1",
      },
    }),
);

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mockAuthenticateRequest,
  checkRateLimit: mock(() => ({ allowed: true })),
  getClientIP: mock(() => null),
  resetRateLimits: mock(() => {}),
  rateLimitCleanupTick: mock(() => {}),
  _setValidatorOverrides: mock(() => {}),
}));

mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => "simple-key",
  resetAuthModeCache: () => {},
}));

// --- EE roles mock. The route uses `requirePermission("admin:settings")`,
//     which lazy-loads `@atlas/ee/auth/roles`. Default-allow keeps tests
//     focused on the proactive surface. ALL named exports must be stubbed:
//     admin-roles.ts (transitively loaded via the admin router) imports
//     the named exports statically and a partial mock surfaces as
//     "Export named 'X' not found" at module load, taking down every
//     admin route. ---
import { Effect as F53Effect, Layer as F53Layer } from "effect";
mock.module("@atlas/ee/auth/roles", () => ({
  PERMISSIONS: [
    "query",
    "query:raw_data",
    "admin:users",
    "admin:connections",
    "admin:settings",
    "admin:audit",
    "admin:roles",
    "admin:semantic",
  ] as const,
  isValidPermission: () => true,
  isValidRoleName: () => true,
  BUILTIN_ROLES: [],
  resolvePermissions: () => F53Effect.succeed(new Set()),
  hasPermission: () => F53Effect.succeed(true),
  checkPermission: () => F53Effect.succeed(null),
  listRoles: () => F53Effect.succeed([]),
  getRole: () => F53Effect.succeed(null),
  getRoleByName: () => F53Effect.succeed(null),
  createRole: () => F53Effect.die(new Error("not configured")),
  updateRole: () => F53Effect.die(new Error("not configured")),
  deleteRole: () => F53Effect.succeed(true),
  listRoleMembers: () => F53Effect.succeed([]),
  assignRole: () => F53Effect.die(new Error("not configured")),
  seedBuiltinRoles: () => F53Effect.succeed(undefined),
  RoleError: class extends Error {
    public readonly _tag = "RoleError" as const;
    public readonly code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = "RoleError";
      this.code = code;
    }
  },
}));

// --- IP allowlist mock. `createAdminRouter`'s middleware chain runs an
//     allowlist check on every request via `@atlas/ee/auth/ip-allowlist`. ---
mock.module("@atlas/ee/auth/ip-allowlist", () => ({
  checkIPAllowlist: () => F53Effect.succeed({ allowed: true }),
  listIPAllowlistEntries: () => F53Effect.succeed([]),
  addIPAllowlistEntry: () => F53Effect.succeed(null),
  removeIPAllowlistEntry: () => F53Effect.succeed(null),
  IPAllowlistError: class extends Error {
    public readonly code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = "IPAllowlistError";
      this.code = code;
    }
  },
  invalidateCache: () => {},
  _clearCache: () => {},
  parseCIDR: () => null,
  isIPInRange: () => false,
  isIPAllowed: () => true,
}));

// --- Internal DB mock. `internalQuery` is the route's only DB touchpoint;
//     reshape per-test via `mockInternalRows` to script the responses. ---

type InternalQueryCall = { sql: string; params: unknown[] };
let lastQueries: InternalQueryCall[] = [];
let mockInternalRows: unknown[][] = [];

const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<unknown[]>> = mock(
  async (sql: string, params?: unknown[]) => {
    lastQueries.push({ sql, params: params ?? [] });
    return mockInternalRows.shift() ?? [];
  },
);

let mockHasInternalDB = true;

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  getInternalDB: () => ({
    query: () => Promise.resolve({ rows: [] }),
    end: async () => {},
    on: () => {},
  }),
  internalQuery: mockInternalQuery,
  internalExecute: () => {},
  setWorkspaceRegion: mock(async () => {}),
  insertSemanticAmendment: mock(async () => "mock-amendment-id"),
  getPendingAmendmentCount: mock(async () => 0),
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
  getRequestContext: () => null,
}));

// --- Announcement coordinator mock (#2300). The PUT route calls
//     `announceActivation` after every false→true `enabled` transition;
//     the unit test for the coordinator itself covers DB idempotency,
//     so here we just want to assert (a) the route invokes it with the
//     right args and (b) failures inside the announcement path don't
//     fail the API call. ---

let mockAnnounceOutcome: AnnouncementOutcome = {
  posted: true,
  messageId: "m-1",
};
let mockAnnounceCalls: Array<{ workspaceId: string; channelId: string }> = [];
const mockAnnounceActivation: Mock<
  (input: { workspaceId: string; channelId: string }) => Promise<AnnouncementOutcome>
> = mock(async (input) => {
  mockAnnounceCalls.push({ workspaceId: input.workspaceId, channelId: input.channelId });
  return mockAnnounceOutcome;
});

// --- Audit mock ---

interface CapturedAuditEntry {
  actionType: string;
  targetType: string;
  targetId: string;
  metadata?: Record<string, unknown>;
}
const mockLogAdminAction: Mock<(entry: CapturedAuditEntry) => void> = mock(() => {});

mock.module("@atlas/api/lib/audit", () => ({
  logAdminAction: mockLogAdminAction,
  logAdminActionAwait: mock(async () => {}),
  ADMIN_ACTIONS: REAL_ADMIN_ACTIONS,
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  causeToError: () => undefined,
}));

// --- Channel-directory result (GET /channels/available). The route reads
//     the platform-neutral channel-directory port (#3463) — provider
//     resolution, Slack mapping, and the TTL cache (#3461) have their
//     own unit tests, so the route test scripts the port's result. ---

type DirectoryChannel = { id: string; name: string; isPrivate: boolean; isMember: boolean };
type DirectoryResult =
  | { ok: true; channels: DirectoryChannel[] }
  | { ok: false; reason: "no_chat_installation" | "missing_scope" | "platform_error"; detail?: string };
let mockDirectoryResult: DirectoryResult = {
  ok: true,
  channels: [],
};
const mockListWorkspaceChannels: Mock<(workspaceId: string) => Promise<DirectoryResult>> = mock(
  async () => mockDirectoryResult,
);

// --- Proactive seams (#3999). The route reaches `announceActivation` /
//     `listWorkspaceChannels` through the composite `ProactiveService`
//     Tag via `runEnterprise`. We mock EELayer to bind a fake
//     `ProactiveService` (the real EELayer's full Live DAG isn't wired in
//     this minimal sub-router test); the deployment enterprise gate is the
//     route's inline `gateEnterprise()` (env-driven), and the
//     permission/IP-allowlist checks fall through to their core Noop
//     layers (admin role → legacy allow). ---

mock.module("@atlas/ee/layers", () => ({
  EELayer: F53Layer.unwrapEffect(
    F53Effect.sync(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const services = require("@atlas/api/lib/effect/services") as typeof import("@atlas/api/lib/effect/services");
      return services.createProactiveServiceTestLayer({
        announceActivation: ({ workspaceId, channelId }) =>
          F53Effect.promise(() =>
            mockAnnounceActivation({ workspaceId, channelId }),
          ),
        listWorkspaceChannels: (workspaceId: string) =>
          F53Effect.promise(() => mockListWorkspaceChannels(workspaceId)),
      });
    }),
  ),
}));

// --- Import sub-router directly ---

const { adminProactive } = await import("../routes/admin-proactive");

// --- Helpers ---

function nowRow(overrides: Partial<Record<string, unknown>>) {
  const now = new Date("2026-05-17T12:00:00Z");
  return {
    workspace_id: "org-1",
    enabled: false,
    sensitivity: "balanced",
    classifier_mode: "regex-prefilter",
    announcement_channel_id: null,
    monthly_classifier_cap: null,
    announcement_posted_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function nowChannelRow(overrides: Partial<Record<string, unknown>>) {
  const now = new Date("2026-05-17T12:00:00Z");
  return {
    id: "uuid-1",
    workspace_id: "org-1",
    channel_id: "C0123456789",
    allow: true,
    sensitivity: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function resetMocks() {
  process.env.ATLAS_ENTERPRISE_ENABLED = "true";
  mockHasInternalDB = true;
  mockDirectoryResult = { ok: false, reason: "no_chat_installation" };
  mockListWorkspaceChannels.mockClear();
  lastQueries = [];
  mockInternalRows = [];
  mockInternalQuery.mockClear();
  mockLogAdminAction.mockClear();
  mockAnnounceActivation.mockClear();
  mockAnnounceCalls = [];
  mockAnnounceOutcome = { posted: true, messageId: "m-1" };
  mockAuthenticateRequest.mockImplementation(() =>
    Promise.resolve({
      authenticated: true,
      mode: "simple-key",
      user: {
        id: "admin-1",
        mode: "simple-key",
        label: "Admin",
        role: "admin",
        activeOrganizationId: "org-1",
      },
    }),
  );
}

async function request(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: {} };
  if (body !== undefined) {
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return adminProactive.request(`http://localhost${path}`, init);
}

// --- Tests ---

describe("GET /api/v1/admin/proactive/workspace", () => {
  beforeEach(resetMocks);

  it("returns the materialised default row on first read", async () => {
    mockInternalRows = [[nowRow({})]];
    const res = await request("GET", "/workspace");
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.enabled).toBe(false);
    expect(json.sensitivity).toBe("balanced");
    expect(json.classifierMode).toBe("regex-prefilter");
    expect(json.announcementChannelId).toBeNull();
    expect(json.monthlyClassifierCap).toBeNull();
  });

  it("returns 403 enterprise_required when EE is off", async () => {
    process.env.ATLAS_ENTERPRISE_ENABLED = "false";
    const res = await request("GET", "/workspace");
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("enterprise_required");
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: false,
        status: 401,
        error: "Not authenticated",
      }),
    );
    const res = await request("GET", "/workspace");
    expect(res.status).toBe(401);
  });

  it("returns 403 for a non-admin role", async () => {
    mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "managed",
        user: {
          id: "user-1",
          mode: "managed",
          label: "User",
          role: "member",
          activeOrganizationId: "org-1",
        },
      }),
    );
    const res = await request("GET", "/workspace");
    expect(res.status).toBe(403);
  });

  it("returns 404 when no internal DB is configured", async () => {
    mockHasInternalDB = false;
    const res = await request("GET", "/workspace");
    expect(res.status).toBe(404);
  });

  it("returns 500 with requestId when the DB throws", async () => {
    mockInternalQuery.mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    const res = await request("GET", "/workspace");
    expect(res.status).toBe(500);
    const json = (await res.json()) as { requestId: string; error: string };
    expect(json.requestId).toBeDefined();
    expect(json.error).toBe("internal_error");
  });
});

describe("PUT /api/v1/admin/proactive/workspace", () => {
  beforeEach(resetMocks);

  it("updates the workspace row and emits an audit entry", async () => {
    // Query order:
    //   0: INSERT … ON CONFLICT DO NOTHING (materialise)
    //   1: SELECT enabled (pre-update snapshot for the #2300 transition)
    //   2: partial UPDATE … RETURNING
    mockInternalRows = [
      [],
      [{ enabled: false }],
      [
        nowRow({
          enabled: true,
          sensitivity: "eager",
          classifier_mode: "classify-all",
          announcement_channel_id: "C-ann",
          monthly_classifier_cap: 5000,
        }),
      ],
    ];
    const res = await request("PUT", "/workspace", {
      enabled: true,
      sensitivity: "eager",
      classifierMode: "classify-all",
      announcementChannelId: "C-ann",
      monthlyClassifierCap: 5000,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.enabled).toBe(true);
    expect(json.sensitivity).toBe("eager");
    expect(json.classifierMode).toBe("classify-all");
    expect(json.announcementChannelId).toBe("C-ann");
    expect(json.monthlyClassifierCap).toBe(5000);

    // UPDATE SQL must list every touched column.
    const updateSql = lastQueries[2]?.sql ?? "";
    expect(updateSql).toContain("enabled =");
    expect(updateSql).toContain("sensitivity =");
    expect(updateSql).toContain("classifier_mode =");
    expect(updateSql).toContain("announcement_channel_id =");
    expect(updateSql).toContain("monthly_classifier_cap =");

    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const audit = mockLogAdminAction.mock.calls[0][0];
    expect(audit.actionType).toBe(REAL_ADMIN_ACTIONS.proactive.workspaceUpdate);
    expect(audit.targetId).toBe("org-1");
    expect(audit.metadata).toMatchObject({
      enabled: true,
      sensitivity: "eager",
      classifierMode: "classify-all",
      announcementChannelId: "C-ann",
      monthlyClassifierCap: 5000,
    });
  });

  it("supports clearing announcementChannelId via null", async () => {
    mockInternalRows = [[], [{ enabled: false }], [nowRow({ announcement_channel_id: null })]];
    const res = await request("PUT", "/workspace", {
      announcementChannelId: null,
    });
    expect(res.status).toBe(200);
    const updateSql = lastQueries[2]?.sql ?? "";
    expect(updateSql).toContain("announcement_channel_id =");
    // Param-1 should be the explicit null we just sent.
    expect(lastQueries[2]?.params[0]).toBeNull();
  });

  it("rejects an invalid sensitivity enum with 422", async () => {
    // 422 (not 400) because the shared `validationHook` maps Zod schema
    // failures to "Unprocessable Entity" — see validation-hook.ts.
    const res = await request("PUT", "/workspace", { sensitivity: "bogus" });
    expect(res.status).toBe(422);
  });

  it("rejects a negative monthlyClassifierCap with 422", async () => {
    const res = await request("PUT", "/workspace", {
      monthlyClassifierCap: -1,
    });
    expect(res.status).toBe(422);
  });

  it("returns 403 enterprise_required when EE is off", async () => {
    process.env.ATLAS_ENTERPRISE_ENABLED = "false";
    const res = await request("PUT", "/workspace", { enabled: true });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("enterprise_required");
  });

  // #2300 — activation announcement trigger.
  describe("activation announcement (#2300)", () => {
    it("invokes announceActivation on a false→true transition with channel set", async () => {
      mockInternalRows = [
        [],
        [{ enabled: false }],
        [nowRow({ enabled: true, announcement_channel_id: "C-ann" })],
      ];
      const res = await request("PUT", "/workspace", {
        enabled: true,
        announcementChannelId: "C-ann",
      });
      expect(res.status).toBe(200);
      expect(mockAnnounceActivation).toHaveBeenCalledTimes(1);
      expect(mockAnnounceCalls[0]).toMatchObject({
        workspaceId: "org-1",
        channelId: "C-ann",
      });
    });

    it("does NOT announce when enabled was already true (no transition)", async () => {
      mockInternalRows = [
        [],
        [{ enabled: true }],
        [nowRow({ enabled: true, announcement_channel_id: "C-ann" })],
      ];
      const res = await request("PUT", "/workspace", {
        enabled: true,
        sensitivity: "eager",
      });
      expect(res.status).toBe(200);
      expect(mockAnnounceActivation).not.toHaveBeenCalled();
    });

    it("does NOT announce when no announcement_channel_id is configured", async () => {
      mockInternalRows = [
        [],
        [{ enabled: false }],
        [nowRow({ enabled: true, announcement_channel_id: null })],
      ];
      const res = await request("PUT", "/workspace", { enabled: true });
      expect(res.status).toBe(200);
      expect(mockAnnounceActivation).not.toHaveBeenCalled();
    });

    it("does NOT announce when the request disables proactive mode", async () => {
      mockInternalRows = [
        [],
        [{ enabled: true }],
        [nowRow({ enabled: false, announcement_channel_id: "C-ann" })],
      ];
      const res = await request("PUT", "/workspace", { enabled: false });
      expect(res.status).toBe(200);
      expect(mockAnnounceActivation).not.toHaveBeenCalled();
    });

    it("still returns 200 when announceActivation throws (best-effort)", async () => {
      mockInternalRows = [
        [],
        [{ enabled: false }],
        [nowRow({ enabled: true, announcement_channel_id: "C-ann" })],
      ];
      mockAnnounceActivation.mockImplementationOnce(async () => {
        throw new Error("boom");
      });
      const res = await request("PUT", "/workspace", {
        enabled: true,
        announcementChannelId: "C-ann",
      });
      expect(res.status).toBe(200);
      // Pin that the announcer actually RAN and its throw was swallowed —
      // not that the route 200'd via a never-invoked Noop path.
      expect(mockAnnounceActivation).toHaveBeenCalledTimes(1);
    });

    it("still returns 200 when announceActivation reports posted: false", async () => {
      mockInternalRows = [
        [],
        [{ enabled: false }],
        [nowRow({ enabled: true, announcement_channel_id: "C-ann" })],
      ];
      mockAnnounceOutcome = { posted: false, reason: "already_posted" };
      const res = await request("PUT", "/workspace", {
        enabled: true,
        announcementChannelId: "C-ann",
      });
      expect(res.status).toBe(200);
      expect(mockAnnounceActivation).toHaveBeenCalledTimes(1);
    });
  });
});

describe("GET /api/v1/admin/proactive/channels", () => {
  beforeEach(resetMocks);

  it("returns the channel-override list", async () => {
    mockInternalRows = [
      [
        nowChannelRow({ channel_id: "C-a", allow: true }),
        nowChannelRow({ id: "uuid-2", channel_id: "C-b", allow: false, sensitivity: "cautious" }),
      ],
    ];
    const res = await request("GET", "/channels");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { channels: Array<Record<string, unknown>> };
    expect(json.channels).toHaveLength(2);
    expect(json.channels[0].channelId).toBe("C-a");
    expect(json.channels[1].allow).toBe(false);
    expect(json.channels[1].sensitivity).toBe("cautious");
  });

  it("returns 403 enterprise_required when EE is off", async () => {
    process.env.ATLAS_ENTERPRISE_ENABLED = "false";
    const res = await request("GET", "/channels");
    expect(res.status).toBe(403);
  });
});

describe("POST /api/v1/admin/proactive/channels", () => {
  beforeEach(resetMocks);

  it("upserts a channel override and emits an audit entry", async () => {
    mockInternalRows = [[nowChannelRow({ channel_id: "C-test", sensitivity: "eager" })]];
    const res = await request("POST", "/channels", {
      channelId: "C-test",
      allow: true,
      sensitivity: "eager",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.channelId).toBe("C-test");
    expect(json.allow).toBe(true);

    const insertSql = lastQueries[0]?.sql ?? "";
    expect(insertSql).toContain("INSERT INTO channel_proactive_config");
    expect(insertSql).toContain("ON CONFLICT (workspace_id, channel_id)");

    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    expect(mockLogAdminAction.mock.calls[0][0].actionType).toBe(
      REAL_ADMIN_ACTIONS.proactive.channelUpsert,
    );
  });

  it("accepts an upsert without a sensitivity override", async () => {
    mockInternalRows = [[nowChannelRow({ channel_id: "C-test", allow: false })]];
    const res = await request("POST", "/channels", {
      channelId: "C-test",
      allow: false,
    });
    expect(res.status).toBe(200);
    expect(lastQueries[0]?.params[3]).toBeNull();
    // Provided-flags: allow touched, sensitivity left alone.
    expect(lastQueries[0]?.params[4]).toBe(true);
    expect(lastQueries[0]?.params[5]).toBe(false);
  });

  it("partial sensitivity-only upsert leaves allow untouched", async () => {
    mockInternalRows = [[nowChannelRow({ channel_id: "C-test", sensitivity: "cautious" })]];
    const res = await request("POST", "/channels", {
      channelId: "C-test",
      sensitivity: "cautious",
    });
    expect(res.status).toBe(200);
    // allow omitted → value param null, provided flag false; the SQL CASE
    // keeps channel_proactive_config.allow on the conflict path.
    expect(lastQueries[0]?.params[2]).toBeNull();
    expect(lastQueries[0]?.params[4]).toBe(false);
    expect(lastQueries[0]?.params[5]).toBe(true);
    // Audit metadata records only the touched field — no phantom allow.
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const meta = mockLogAdminAction.mock.calls[0][0].metadata ?? {};
    expect("allow" in meta).toBe(false);
    expect(meta.sensitivity).toBe("cautious");
  });

  it("explicit sensitivity: null clears the override (distinct from omit)", async () => {
    mockInternalRows = [[nowChannelRow({ channel_id: "C-test", sensitivity: null })]];
    const res = await request("POST", "/channels", {
      channelId: "C-test",
      sensitivity: null,
    });
    expect(res.status).toBe(200);
    expect(lastQueries[0]?.params[3]).toBeNull();
    // null is an explicit clear → provided flag true.
    expect(lastQueries[0]?.params[5]).toBe(true);
  });

  it("rejects an empty channelId with 422", async () => {
    const res = await request("POST", "/channels", { channelId: "", allow: true });
    expect(res.status).toBe(422);
  });

  it("returns 403 enterprise_required when EE is off", async () => {
    process.env.ATLAS_ENTERPRISE_ENABLED = "false";
    const res = await request("POST", "/channels", {
      channelId: "C-test",
      allow: true,
    });
    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/v1/admin/proactive/channels/:channelId", () => {
  beforeEach(resetMocks);

  it("deletes a channel override", async () => {
    mockInternalRows = [[{ id: "uuid-1" }]];
    const res = await request("DELETE", "/channels/C-test");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean };
    expect(json.success).toBe(true);

    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    expect(mockLogAdminAction.mock.calls[0][0].actionType).toBe(
      REAL_ADMIN_ACTIONS.proactive.channelDelete,
    );
  });

  it("returns 404 when the override was already gone", async () => {
    mockInternalRows = [[]];
    const res = await request("DELETE", "/channels/C-test");
    expect(res.status).toBe(404);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it("returns 403 enterprise_required when EE is off", async () => {
    process.env.ATLAS_ENTERPRISE_ENABLED = "false";
    const res = await request("DELETE", "/channels/C-test");
    expect(res.status).toBe(403);
  });
});

describe("GET /api/v1/admin/proactive/channels/available", () => {
  beforeEach(resetMocks);

  it("soft-degrades with no_chat_installation when the workspace has no install", async () => {
    mockDirectoryResult = { ok: false, reason: "no_chat_installation" };
    const res = await request("GET", "/channels/available");
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.available).toBe(false);
    expect(json.reason).toBe("no_chat_installation");
    expect(json.channels).toEqual([]);
    // Per-workspace lookup — the active org id is the cache/tenant key.
    expect(mockListWorkspaceChannels).toHaveBeenCalledWith("org-1");
  });

  it("returns channels sorted member-first then by name", async () => {
    mockDirectoryResult = {
      ok: true,
      channels: [
        { id: "C3", name: "zebra", isPrivate: false, isMember: false },
        { id: "C2", name: "general", isPrivate: false, isMember: true },
        { id: "C1", name: "analytics", isPrivate: true, isMember: true },
      ],
    };
    const res = await request("GET", "/channels/available");
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      available: boolean;
      reason: string | null;
      channels: Array<{ id: string; name: string }>;
    };
    expect(json.available).toBe(true);
    expect(json.reason).toBeNull();
    expect(json.channels.map((ch) => ch.id)).toEqual(["C1", "C2", "C3"]);
  });

  it("soft-degrades with platform_error when the platform listing fails", async () => {
    mockDirectoryResult = { ok: false, reason: "platform_error", detail: "ratelimited" };
    const res = await request("GET", "/channels/available");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { available: boolean; reason: string | null };
    expect(json.available).toBe(false);
    expect(json.reason).toBe("platform_error");
  });

  it("surfaces missing_scope distinctly so the UI can offer the reconnect CTA (#3466)", async () => {
    mockDirectoryResult = { ok: false, reason: "missing_scope", detail: "missing_scope" };
    const res = await request("GET", "/channels/available");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { available: boolean; reason: string | null };
    expect(json.available).toBe(false);
    expect(json.reason).toBe("missing_scope");
  });

  it("returns 403 enterprise_required when EE is off", async () => {
    process.env.ATLAS_ENTERPRISE_ENABLED = "false";
    const res = await request("GET", "/channels/available");
    expect(res.status).toBe(403);
    expect(mockListWorkspaceChannels).not.toHaveBeenCalled();
  });
});

// Final restore so a flag flip in this file doesn't bleed into adjacent
// test files when the isolated-test runner reuses the process.
if (ORIGINAL_EE_FLAG === undefined) {
  delete process.env.ATLAS_ENTERPRISE_ENABLED;
} else {
  process.env.ATLAS_ENTERPRISE_ENABLED = ORIGINAL_EE_FLAG;
}
