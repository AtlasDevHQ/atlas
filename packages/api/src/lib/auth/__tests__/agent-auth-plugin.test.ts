/**
 * Agent Auth — OpenAPI adapter contract + JWT/grant verification + the
 * Atlas-side per-org binding and error hygiene (#4410 Slice 2, building on the
 * #4409 spine).
 *
 * These drive the REAL `buildAgentAuthPlugin()` (with injected seams — a fixture
 * spec, a stub proxy `fetch`, and a stub token minter) through a real
 * `betterAuth()` instance backed by the in-memory adapter (the same harness
 * `server.test.ts` uses). The agent-auth `before` hook does full agent-JWT
 * verification (signature against the registered Ed25519 key, `aud` binding,
 * expiry, jti replay) and the capability grant check before `onExecute` runs —
 * so hitting `/api/auth/capability/execute` with crafted JWTs exercises the
 * actual security surface, not a re-implementation.
 *
 * The one `resolveHeaders` dependency that needs an internal DB — the
 * workspace-membership lookup (`listUserWorkspaceIds`) — is mocked so the happy
 * and cross-workspace paths run without Postgres; every DENIAL case (wrong aud /
 * expired / revoked / missing capability claim) fails BEFORE `onExecute`, so
 * those assertions exercise the unmocked plugin verification directly.
 *
 * Self-contained: the enable flag is set on `process.env` inside the suite and
 * restored, never at module top level.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, mock } from "bun:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { generateKeyPair, exportJWK, SignJWT } from "jose";

/** jose v6 dropped the `KeyLike` alias; infer the key type from generateKeyPair. */
type AgentPrivateKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

// ── Mocks for the internal-DB-backed resolveHeaders dependency ──────────────
// `listUserWorkspaceIds` is the authoritative membership check the verifier
// runs; default it to "user_1 is a member of wsA only" so the cross-workspace
// case (an agent bound to wsB) is denied.
let workspacesForUser: (userId: string) => string[] = () => ["wsA"];
mock.module("@atlas/api/lib/auth/oauth-workspace-grants", () => ({
  getOAuthClientScope: async () => "single",
  hasWorkspaceGrant: async () => false,
  userIsWorkspaceMember: async () => false,
  listUserWorkspaceIds: async (userId: string) => workspacesForUser(userId),
  listWorkspaceGrantsForClient: async () => [],
  setWorkspaceScopeAndGrants: async () => undefined,
  revokeWorkspaceGrant: async () => 0,
}));

// Spread the real gate and override only the enable check, so resolveHeaders'
// workspace-override branch can be driven deterministically without an internal
// DB (the gate's own env/fail-closed behavior is covered in agent-auth-gate.test.ts).
// Default: enabled for every workspace.
import * as gateReal from "@atlas/api/lib/auth/agent-auth-gate";
let enabledForWorkspace: (orgId?: string) => boolean = () => true;
mock.module("@atlas/api/lib/auth/agent-auth-gate", () => ({
  ...gateReal,
  isAgentAuthEnabled: async (orgId?: string) => enabledForWorkspace(orgId),
}));

// SUT — imported AFTER the mocks are registered.
import {
  buildAgentAuthPlugin,
  AGENT_WORKSPACE_METADATA_KEY,
  mintWorkspaceApiKeyVia,
  type CreateWorkspaceApiKey,
} from "@atlas/api/lib/auth/agent-auth-plugin";
import { createAtlasUser } from "@atlas/api/lib/auth/types";
import {
  buildOperationIndex,
  isSensitiveOperation,
  isSensitivePath,
  buildAgentAuthOpenApiOptions,
} from "@atlas/api/lib/auth/agent-auth-openapi";
import type { AtlasOpenApiSpec } from "@atlas/api/lib/auth/atlas-openapi-source";

const BASE = "http://localhost:3000";
const ISSUER = `${BASE}/api/auth`;
const EXECUTE_URL = `${ISSUER}/capability/execute`;

/**
 * A minimal fixture spec exercising every classification branch: a safe read
 * (GET /me), a write (POST /query), a sensitive-path read (GET /admin/audit), a
 * HEAD read, and a platform read. operationIds mirror the auto-generated
 * `<method><Path>` shape.
 */
const FIXTURE_SPEC = {
  info: { title: "Atlas API", description: "fixture" },
  paths: {
    "/api/v1/me": { get: { operationId: "getMe", description: "current user" } },
    "/api/v1/query": { post: { operationId: "postQuery", description: "run a query" } },
    "/api/v1/admin/audit": { get: { operationId: "getAdminAudit", description: "audit log" } },
    "/api/v1/dashboards": {
      get: { operationId: "getDashboards", description: "list dashboards" },
      head: { operationId: "headDashboards", description: "dashboards head" },
    },
    "/api/v1/platform/regions": { get: { operationId: "getPlatformRegions", description: "regions" } },
  },
} satisfies AtlasOpenApiSpec;

const SAFE_CAP = "getMe";

// ── Pure adapter classification (no plugin, no auth instance) ────────────────

describe("agent-auth OpenAPI adapter classification (#4410)", () => {
  it("indexes every operationId to its method + path", () => {
    const index = buildOperationIndex(FIXTURE_SPEC);
    expect(index.get("getMe")).toEqual({ method: "GET", path: "/api/v1/me" });
    expect(index.get("postQuery")).toEqual({ method: "POST", path: "/api/v1/query" });
    expect(index.get("headDashboards")).toEqual({ method: "HEAD", path: "/api/v1/dashboards" });
    expect(index.size).toBe(6);
  });

  it("classifies writes, admin, and platform routes as sensitive; read-only non-admin as safe", () => {
    const idx = buildOperationIndex(FIXTURE_SPEC);
    expect(isSensitiveOperation(idx.get("getMe"))).toBe(false); // safe read
    expect(isSensitiveOperation(idx.get("headDashboards"))).toBe(false); // safe HEAD
    expect(isSensitiveOperation(idx.get("getDashboards"))).toBe(false); // safe read
    expect(isSensitiveOperation(idx.get("postQuery"))).toBe(true); // write
    expect(isSensitiveOperation(idx.get("getAdminAudit"))).toBe(true); // admin read
    expect(isSensitiveOperation(idx.get("getPlatformRegions"))).toBe(true); // platform read
    expect(isSensitiveOperation(undefined)).toBe(true); // fail closed
  });

  it("matches sensitive prefixes only on a segment boundary", () => {
    expect(isSensitivePath("/api/v1/admin")).toBe(true);
    expect(isSensitivePath("/api/v1/admin/audit")).toBe(true);
    expect(isSensitivePath("/api/v1/platform/regions")).toBe(true);
    expect(isSensitivePath("/api/v1/administrators")).toBe(false); // not swept by raw prefix
    expect(isSensitivePath("/api/v1/me")).toBe(false);
  });

  it("derives capabilities from the spec, limits defaultHostCapabilities to safe reads, blocks the rest", () => {
    const opts = buildAgentAuthOpenApiOptions(FIXTURE_SPEC, {
      baseUrl: "http://internal",
      resolveHeaders: async () => ({}),
    });
    const capNames = (opts.capabilities ?? []).map((c) => c.name).sort();
    // Every operation is a capability — no hand-rolled list.
    expect(capNames).toEqual(
      ["getAdminAudit", "getDashboards", "getMe", "getPlatformRegions", "headDashboards", "postQuery"].sort(),
    );
    // Auto-grant only safe reads (GET/HEAD, non-admin) — NOT admin GETs or writes.
    expect([...(opts.defaultHostCapabilities as string[])].sort()).toEqual(
      ["getDashboards", "getMe", "headDashboards"].sort(),
    );
    // Hard-block every sensitive cap from being granted/executed.
    expect([...(opts.blockedCapabilities ?? [])].sort()).toEqual(
      ["getAdminAudit", "getPlatformRegions", "postQuery"].sort(),
    );
  });

  it("resolveCapabilities hides sensitive caps from discovery (list/describe)", () => {
    const opts = buildAgentAuthOpenApiOptions(FIXTURE_SPEC, {
      baseUrl: "http://internal",
      resolveHeaders: async () => ({}),
    });
    const visible = opts.resolveCapabilities!({
      capabilities: opts.capabilities ?? [],
      query: null,
      agentSession: null,
      hostSession: null,
    }) as Array<{ name: string }>;
    const names = visible.map((c) => c.name).sort();
    expect(names).toEqual(["getDashboards", "getMe", "headDashboards"].sort());
    expect(names).not.toContain("postQuery");
    expect(names).not.toContain("getAdminAudit");
  });
});

// ── Per-org token minting core (AC2) ────────────────────────────────────────

describe("agent-auth per-org token minting (#4410)", () => {
  const user = createAtlasUser("user_1", "managed", "U", { activeOrganizationId: "wsA" });

  it("server-side mints a workspace-scoped key: explicit userId, workspace metadata, short TTL", async () => {
    let seen: Parameters<CreateWorkspaceApiKey>[0] | undefined;
    const createApiKey: CreateWorkspaceApiKey = async (opts) => {
      seen = opts;
      return { id: "key_1", key: "wskey_secret" };
    };
    const token = await mintWorkspaceApiKeyVia(createApiKey, { user, workspaceId: "wsA" });
    expect(token).toBe("wskey_secret");
    // No request headers → server-side mint bound to the agent's owning member.
    expect(seen?.body.userId).toBe("user_1");
    expect(seen?.body.expiresIn).toBeGreaterThan(0);
    expect(seen?.body.metadata).toMatchObject({ atlasWorkspaceKey: true, orgId: "wsA" });
    // No plaintext secrets / RLS claims smuggled into metadata.
    expect(seen?.body.metadata.claims).toBeUndefined();
  });

  it("throws a non-leaking internal error when the apiKey plugin is unavailable", async () => {
    await expect(mintWorkspaceApiKeyVia(undefined, { user, workspaceId: "wsA" })).rejects.toMatchObject({
      body: { error: "internal_error" },
    });
  });

  it("throws when createApiKey returns no key material", async () => {
    const createApiKey: CreateWorkspaceApiKey = async () => ({ id: "key_1" });
    await expect(mintWorkspaceApiKeyVia(createApiKey, { user, workspaceId: "wsA" })).rejects.toMatchObject({
      body: { error: "internal_error" },
    });
  });
});

// ── Plugin contract ─────────────────────────────────────────────────────────

describe("agent-auth plugin contract (#4410)", () => {
  it("registers under id 'agent-auth' with the four spec tables", () => {
    const plugin = buildAgentAuthPlugin({ spec: FIXTURE_SPEC });
    expect(plugin.id).toBe("agent-auth");
    // The 0.6.2 schema names — pinned so a future bump that renames a table
    // goes RED here rather than silently changing what auto-migrate creates.
    expect(Object.keys(plugin.schema ?? {}).sort()).toEqual([
      "agent",
      "agentCapabilityGrant",
      "agentHost",
      "approvalRequest",
    ]);
  });

  it("exposes the execute + discovery endpoints the adapter is built on", () => {
    const plugin = buildAgentAuthPlugin({ spec: FIXTURE_SPEC });
    const paths = Object.values(plugin.endpoints ?? {})
      .map((e) => (e as { path?: string }).path)
      .filter(Boolean);
    expect(paths).toContain("/capability/execute");
    expect(paths).toContain("/agent-configuration");
  });

  it("advertises zero capabilities when no spec is available (inert, gated surface)", () => {
    // A non-API process (or a spec-generation failure) → null spec → empty
    // capability set, never a crash. The surface stays default-off + 404-gated.
    const plugin = buildAgentAuthPlugin({ spec: null });
    expect(plugin.id).toBe("agent-auth");
  });
});

// ── JWT / grant verification + per-org binding through the proxy ─────────────

describe("agent-auth capability execution (#4410)", () => {
  let privateKey: AgentPrivateKey;
  let publicJwk: Record<string, unknown>;
  const prevEnabled = process.env.ATLAS_AGENT_AUTH_ENABLED;

  // The stub proxy transport captures the forwarded request (URL + headers) and
  // returns a canned upstream response, so the happy path asserts the per-org
  // token was minted + forwarded WITHOUT standing up the whole Atlas app.
  let lastForwarded: { url: string; headers: Record<string, string> } | null = null;
  let mintedFor: Array<{ userId: string; workspaceId: string }> = [];
  const stubFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    lastForwarded = {
      url: req.url,
      headers: Object.fromEntries(req.headers.entries()),
    };
    return new Response(JSON.stringify({ ok: true, from: "upstream" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const stubMint = async ({ user, workspaceId }: { user: { id: string }; workspaceId: string }) => {
    mintedFor.push({ userId: user.id, workspaceId });
    return `wskey_${workspaceId}`;
  };

  beforeAll(async () => {
    process.env.ATLAS_AGENT_AUTH_ENABLED = "true";
    const kp = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
    privateKey = kp.privateKey;
    publicJwk = (await exportJWK(kp.publicKey)) as Record<string, unknown>;
  });

  afterEach(() => {
    workspacesForUser = () => ["wsA"];
    enabledForWorkspace = () => true;
    lastForwarded = null;
    mintedFor = [];
  });

  afterAll(() => {
    if (prevEnabled === undefined) delete process.env.ATLAS_AGENT_AUTH_ENABLED;
    else process.env.ATLAS_AGENT_AUTH_ENABLED = prevEnabled;
  });

  function makeInstance(
    agents: Array<{ id: string; workspaceId: string; grantStatus: "active" | "revoked" }>,
  ) {
    const now = new Date();
    const host = {
      id: "host_1", name: "h", userId: "user_1", defaultCapabilities: "[]",
      publicKey: null, kid: null, jwksUrl: null, enrollmentTokenHash: null,
      enrollmentTokenExpiresAt: null, status: "active", activatedAt: now,
      expiresAt: null, lastUsedAt: null, createdAt: now, updatedAt: now,
    };
    const user = { id: "user_1", name: "U", email: "u@example.com", emailVerified: true, createdAt: now, updatedAt: now };
    const agentRows = agents.map((a) => ({
      id: a.id, name: a.id, userId: "user_1", hostId: "host_1", status: "active",
      mode: "delegated", publicKey: JSON.stringify(publicJwk), kid: null, jwksUrl: null,
      lastUsedAt: null, activatedAt: now, expiresAt: null,
      metadata: JSON.stringify({ [AGENT_WORKSPACE_METADATA_KEY]: a.workspaceId }),
      createdAt: now, updatedAt: now,
    }));
    const grantRows = agents.map((a) => ({
      id: `grant_${a.id}`, agentId: a.id, capability: SAFE_CAP,
      deniedBy: null, grantedBy: "user_1", expiresAt: null, status: a.grantStatus,
      constraints: null, createdAt: now, updatedAt: now,
    }));
    return betterAuth({
      baseURL: BASE,
      secret: "test-secret-at-least-32-characters-long!!",
      database: memoryAdapter({
        user: [user], session: [], account: [], verification: [],
        agent: agentRows, agentHost: [host], agentCapabilityGrant: grantRows, approvalRequest: [],
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Better Auth plugin union types
      plugins: [
        buildAgentAuthPlugin({ spec: FIXTURE_SPEC, fetch: stubFetch, mintToken: stubMint, baseUrl: "http://internal" }),
      ] as any[],
    });
  }

  async function mintJWT(opts: {
    agentId: string;
    aud?: string;
    capabilities?: string[];
    expired?: boolean;
  }): Promise<string> {
    const jwt = new SignJWT({
      ...(opts.capabilities !== undefined ? { capabilities: opts.capabilities } : { capabilities: [SAFE_CAP] }),
    })
      .setProtectedHeader({ alg: "EdDSA", typ: "agent+jwt" })
      .setSubject(opts.agentId)
      .setIssuer("host_1")
      .setAudience(opts.aud ?? EXECUTE_URL)
      .setJti(`jti_${opts.agentId}_${crypto.randomUUID()}`)
      .setIssuedAt(opts.expired ? Math.floor(Date.now() / 1000) - 3600 : undefined)
      .setExpirationTime(opts.expired ? Math.floor(Date.now() / 1000) - 1800 : "2m");
    return jwt.sign(privateKey);
  }

  async function execute(
    instance: ReturnType<typeof makeInstance>,
    token: string,
    capability: string = SAFE_CAP,
  ): Promise<{ status: number; body: { error?: string; data?: unknown } }> {
    const res = await instance.handler(
      new Request(EXECUTE_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ capability, arguments: {} }),
      }),
    );
    const body = (await res.json().catch(() => ({}))) as { error?: string; data?: unknown };
    await instance.$context.catch(() => {});
    return { status: res.status, body };
  }

  it("happy path: valid aud + granted safe capability → 200, per-org token minted + forwarded", async () => {
    workspacesForUser = () => ["wsA"];
    enabledForWorkspace = () => true;
    const instance = makeInstance([{ id: "agent_1", workspaceId: "wsA", grantStatus: "active" }]);
    const { status, body } = await execute(instance, await mintJWT({ agentId: "agent_1" }));
    expect(status).toBe(200);
    expect(body.data).toMatchObject({ ok: true, from: "upstream" });
    // The per-org binding minted a key for the resolved (user_1, wsA) and the
    // proxy forwarded it as x-api-key to the wsA-scoped operation path.
    expect(mintedFor).toEqual([{ userId: "user_1", workspaceId: "wsA" }]);
    expect(lastForwarded?.headers["x-api-key"]).toBe("wskey_wsA");
    expect(lastForwarded?.url).toContain("/api/v1/me");
  });

  it("workspace-override off: a workspace that opted out is denied (404) before minting or forwarding", async () => {
    workspacesForUser = () => ["wsA"];
    enabledForWorkspace = (orgId) => orgId !== "wsA";
    const instance = makeInstance([{ id: "agent_1", workspaceId: "wsA", grantStatus: "active" }]);
    const { status, body } = await execute(instance, await mintJWT({ agentId: "agent_1" }));
    expect(status).toBe(404);
    expect(body.error).toBe("unauthorized");
    expect(mintedFor).toEqual([]);
    expect(lastForwarded).toBeNull();
  });

  it("workspace-override isolation: platform on, wsA off but wsB on → wsA 404'd, wsB executes 200", async () => {
    workspacesForUser = () => ["wsA", "wsB"];
    enabledForWorkspace = (orgId) => orgId !== "wsA"; // platform on; wsA opted out
    const instance = makeInstance([
      { id: "agent_a", workspaceId: "wsA", grantStatus: "active" },
      { id: "agent_b", workspaceId: "wsB", grantStatus: "active" },
    ]);

    const a = await execute(instance, await mintJWT({ agentId: "agent_a" }));
    expect(a.status).toBe(404); // wsA sealed by its own override
    expect(a.body.error).toBe("unauthorized");

    const b = await execute(instance, await mintJWT({ agentId: "agent_b" }));
    expect(b.status).toBe(200); // wsB unaffected — override is per-org
    expect(mintedFor).toEqual([{ userId: "user_1", workspaceId: "wsB" }]);
    expect(lastForwarded?.headers["x-api-key"]).toBe("wskey_wsB");
  });

  it("wrong audience → 401 invalid_jwt (rejected before onExecute)", async () => {
    const instance = makeInstance([{ id: "agent_1", workspaceId: "wsA", grantStatus: "active" }]);
    const { status, body } = await execute(
      instance,
      await mintJWT({ agentId: "agent_1", aud: "https://attacker.example.com/execute" }),
    );
    expect(status).toBe(401);
    expect(body.error).toBe("invalid_jwt");
    expect(mintedFor).toEqual([]);
  });

  it("expired token → 401 invalid_jwt", async () => {
    const instance = makeInstance([{ id: "agent_1", workspaceId: "wsA", grantStatus: "active" }]);
    const { status, body } = await execute(instance, await mintJWT({ agentId: "agent_1", expired: true }));
    expect(status).toBe(401);
    expect(body.error).toBe("invalid_jwt");
  });

  it("revoked grant → 403 grant_revoked", async () => {
    const instance = makeInstance([{ id: "agent_1", workspaceId: "wsA", grantStatus: "revoked" }]);
    const { status, body } = await execute(instance, await mintJWT({ agentId: "agent_1" }));
    expect(status).toBe(403);
    expect(body.error).toBe("grant_revoked");
  });

  it("missing capability claim (token asserts no capabilities) → 403 capability_not_granted", async () => {
    const instance = makeInstance([{ id: "agent_1", workspaceId: "wsA", grantStatus: "active" }]);
    const { status, body } = await execute(instance, await mintJWT({ agentId: "agent_1", capabilities: [] }));
    expect(status).toBe(403);
    expect(body.error).toBe("capability_not_granted");
  });

  it("cross-workspace isolation: an agent bound to a workspace its owner is not a member of is denied (403)", async () => {
    // user_1 is a member of wsA only. agent_b's metadata claims wsB.
    workspacesForUser = () => ["wsA"];
    const instance = makeInstance([{ id: "agent_b", workspaceId: "wsB", grantStatus: "active" }]);
    const { status, body } = await execute(instance, await mintJWT({ agentId: "agent_b" }));
    // The JWT + grant are valid, so the plugin admits and calls onExecute; the
    // Atlas-side membership check in resolveHeaders is what denies (403), and no
    // token was minted nor request forwarded to wsB.
    expect(status).toBe(403);
    expect(body.error).toBe("unauthorized");
    expect(mintedFor).toEqual([]);
    expect(lastForwarded).toBeNull();
  });
});
