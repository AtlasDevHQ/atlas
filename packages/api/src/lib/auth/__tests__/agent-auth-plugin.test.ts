/**
 * Agent Auth spine — plugin contract + JWT/grant verification + the Atlas-side
 * `onExecute` per-org binding (#4409, Slice 1).
 *
 * These drive the REAL `buildAgentAuthPlugin()` through a real `betterAuth()`
 * instance backed by the in-memory adapter (the same harness `server.test.ts`
 * uses). The agent-auth `before` hook does full agent-JWT verification
 * (signature against the registered Ed25519 key, `aud` binding, expiry, jti
 * replay) and the capability grant check before `onExecute` runs — so hitting
 * `/api/auth/capability/execute` with crafted JWTs exercises the actual security
 * surface, not a re-implementation.
 *
 * The two `onExecute` dependencies that need an internal DB — the workspace-
 * membership lookup (`listUserWorkspaceIds`) and the org-scoped read
 * (`listEntities`) — are mocked so the happy and cross-workspace paths run
 * without Postgres; every DENIAL case (wrong aud / expired / revoked / missing
 * capability claim) fails BEFORE `onExecute`, so those assertions exercise the
 * unmocked plugin verification directly.
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

// ── Mocks for the two internal-DB-backed onExecute dependencies ─────────────
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

// Spread the real semantic/entities module and override only `listEntities`,
// so "mock all exports" holds and the org-scoped read is deterministic.
import * as entitiesReal from "@atlas/api/lib/semantic/entities";
const defaultEntitiesForOrg = (orgId: string | undefined): entitiesReal.EntityListEntry[] =>
  orgId === "wsA"
    ? [{ name: "orders", table: "public.orders", description: "Orders fact", source: "default" }]
    : [];
let entitiesForOrg: (orgId: string | undefined) => entitiesReal.EntityListEntry[] = defaultEntitiesForOrg;
mock.module("@atlas/api/lib/semantic/entities", () => ({
  ...entitiesReal,
  listEntities: async (opts: { orgId?: string } = {}) => entitiesForOrg(opts.orgId),
}));

// Spread the real gate and override only the enable check, so onExecute's
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
  LIST_ENTITIES_CAPABILITY,
  AGENT_WORKSPACE_METADATA_KEY,
  AGENT_AUTH_CAPABILITIES,
} from "@atlas/api/lib/auth/agent-auth-plugin";

const BASE = "http://localhost:3000";
const ISSUER = `${BASE}/api/auth`;
const EXECUTE_URL = `${ISSUER}/capability/execute`;

// ── Contract pinning ────────────────────────────────────────────────────────

describe("agent-auth plugin contract (#4409)", () => {
  it("registers under id 'agent-auth' with the four spec tables", () => {
    const plugin = buildAgentAuthPlugin();
    expect(plugin.id).toBe("agent-auth");
    // The 0.6.2 schema names — pinned so a future bump that renames a table
    // (docs drifted between agent/host/grant and agentHost/capabilityGrant) goes
    // RED here rather than silently changing what auto-migrate creates.
    expect(Object.keys(plugin.schema ?? {}).sort()).toEqual([
      "agent",
      "agentCapabilityGrant",
      "agentHost",
      "approvalRequest",
    ]);
  });

  it("advertises exactly ONE hand-written capability (Slice 1 scope guard)", () => {
    // The real scope guard: exactly one capability, so Slice 2's OpenAPI adapter
    // can't silently expand the surface here. Reads the exported source list.
    expect(AGENT_AUTH_CAPABILITIES).toHaveLength(1);
    expect(AGENT_AUTH_CAPABILITIES[0].name).toBe(LIST_ENTITIES_CAPABILITY);
    expect(AGENT_AUTH_CAPABILITIES[0].name).toBe("list_semantic_entities");
    // …and the plugin exposes the execute + discovery endpoints it's built on.
    const plugin = buildAgentAuthPlugin();
    const paths = Object.values(plugin.endpoints ?? {})
      .map((e) => (e as { path?: string }).path)
      .filter(Boolean);
    expect(paths).toContain("/capability/execute");
    expect(paths).toContain("/agent-configuration");
  });
});

// ── JWT / grant verification + onExecute binding ────────────────────────────

describe("agent-auth capability execution (#4409)", () => {
  let privateKey: AgentPrivateKey;
  let publicJwk: Record<string, unknown>;
  const prevEnabled = process.env.ATLAS_AGENT_AUTH_ENABLED;

  beforeAll(async () => {
    process.env.ATLAS_AGENT_AUTH_ENABLED = "true";
    const kp = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
    privateKey = kp.privateKey;
    publicJwk = (await exportJWK(kp.publicKey)) as Record<string, unknown>;
  });

  // Reset the mutable stubs after EVERY test (not just once in afterAll) so a
  // test that repoints a stub can't bleed into a later one — the org-scoped read
  // path is order-sensitive otherwise.
  afterEach(() => {
    workspacesForUser = () => ["wsA"];
    enabledForWorkspace = () => true;
    entitiesForOrg = defaultEntitiesForOrg;
  });

  afterAll(() => {
    if (prevEnabled === undefined) delete process.env.ATLAS_AGENT_AUTH_ENABLED;
    else process.env.ATLAS_AGENT_AUTH_ENABLED = prevEnabled;
  });

  /**
   * Build a fresh in-memory auth instance seeded with a host, a user, and one
   * or more agents (each with its own workspace-metadata + grant status). Rows
   * are pre-seeded in the shape the plugin's read path expects (publicKey /
   * metadata as JSON strings), which the scratch harness verified round-trips.
   */
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
      id: `grant_${a.id}`, agentId: a.id, capability: LIST_ENTITIES_CAPABILITY,
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
      plugins: [buildAgentAuthPlugin()] as any[],
    });
  }

  async function mintJWT(opts: {
    agentId: string;
    aud?: string;
    capabilities?: string[];
    expired?: boolean;
  }): Promise<string> {
    const jwt = new SignJWT({
      ...(opts.capabilities !== undefined ? { capabilities: opts.capabilities } : { capabilities: [LIST_ENTITIES_CAPABILITY] }),
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
  ): Promise<{ status: number; body: { error?: string; data?: unknown } }> {
    const res = await instance.handler(
      new Request(EXECUTE_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ capability: LIST_ENTITIES_CAPABILITY, arguments: {} }),
      }),
    );
    const body = (await res.json().catch(() => ({}))) as { error?: string; data?: unknown };
    await instance.$context.catch(() => {});
    return { status: res.status, body };
  }

  it("happy path: valid aud + granted capability → 200, org-scoped result for the agent's workspace", async () => {
    workspacesForUser = () => ["wsA"];
    enabledForWorkspace = () => true;
    const instance = makeInstance([{ id: "agent_1", workspaceId: "wsA", grantStatus: "active" }]);
    const { status, body } = await execute(instance, await mintJWT({ agentId: "agent_1" }));
    expect(status).toBe(200);
    // onExecute returned the org-scoped listEntities projection for wsA, with the
    // exact field mapping (name/table/description ?? null).
    expect(body.data).toMatchObject({ workspaceId: "wsA", count: 1 });
    expect((body.data as { entities: unknown[] }).entities).toEqual([
      { name: "orders", table: "public.orders", description: "Orders fact" },
    ]);
  });

  it("workspace-override off: a workspace that opted out is denied even with the platform default on", async () => {
    // Defense-in-depth beyond the raw HTTP gate: onExecute re-checks the setting
    // for the RESOLVED workspace. wsA has it off (platform on) → denied, and the
    // org-scoped read is never reached.
    workspacesForUser = () => ["wsA"];
    enabledForWorkspace = (orgId) => orgId !== "wsA";
    const instance = makeInstance([{ id: "agent_1", workspaceId: "wsA", grantStatus: "active" }]);
    const { status, body } = await execute(instance, await mintJWT({ agentId: "agent_1" }));
    expect(status).toBe(404);
    expect(body.error).toBe("unauthorized");
    expect(body.data).toBeUndefined();
  });

  it("workspace-override isolation: with platform on, wsA off but wsB on, wsA is 404'd while wsB executes 200", async () => {
    // The cross-workspace half of the precedence matrix (#4419): a workspace
    // override tightens ONLY its own execution. user_1 is a member of both; the
    // override seals wsA and leaves wsB fully reachable.
    workspacesForUser = () => ["wsA", "wsB"];
    enabledForWorkspace = (orgId) => orgId !== "wsA"; // platform on; wsA opted out
    entitiesForOrg = (orgId) =>
      orgId === "wsB"
        ? [{ name: "events", table: "public.events", description: "Events fact", source: "default" }]
        : [];
    const instance = makeInstance([
      { id: "agent_a", workspaceId: "wsA", grantStatus: "active" },
      { id: "agent_b", workspaceId: "wsB", grantStatus: "active" },
    ]);

    const a = await execute(instance, await mintJWT({ agentId: "agent_a" }));
    expect(a.status).toBe(404); // wsA sealed by its own override
    expect(a.body.error).toBe("unauthorized");
    expect(a.body.data).toBeUndefined();

    const b = await execute(instance, await mintJWT({ agentId: "agent_b" }));
    expect(b.status).toBe(200); // wsB unaffected — override is per-org
    expect(b.body.data).toMatchObject({ workspaceId: "wsB", count: 1 });
  });

  it("wrong audience → 401 invalid_jwt (rejected before onExecute)", async () => {
    const instance = makeInstance([{ id: "agent_1", workspaceId: "wsA", grantStatus: "active" }]);
    const { status, body } = await execute(
      instance,
      await mintJWT({ agentId: "agent_1", aud: "https://attacker.example.com/execute" }),
    );
    expect(status).toBe(401);
    expect(body.error).toBe("invalid_jwt");
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
    // An empty `capabilities` claim scopes the session to zero grants — the
    // token does not assert the capability it is trying to execute.
    const { status, body } = await execute(instance, await mintJWT({ agentId: "agent_1", capabilities: [] }));
    expect(status).toBe(403);
    expect(body.error).toBe("capability_not_granted");
  });

  it("cross-workspace isolation: an agent bound to a workspace its owner is not a member of is denied", async () => {
    // user_1 is a member of wsA only. agent_b's metadata claims wsB.
    workspacesForUser = () => ["wsA"];
    const instance = makeInstance([{ id: "agent_b", workspaceId: "wsB", grantStatus: "active" }]);
    const { status, body } = await execute(instance, await mintJWT({ agentId: "agent_b" }));
    // The JWT + grant are valid, so the plugin admits and calls onExecute; the
    // Atlas-side membership check is what denies (403), NOT a JWT failure.
    expect(status).toBe(403);
    expect(body.error).toBe("unauthorized");
    // And it never reached the org-scoped read for wsB.
    expect(body.data).toBeUndefined();
  });
});
