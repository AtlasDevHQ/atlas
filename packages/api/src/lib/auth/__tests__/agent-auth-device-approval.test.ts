/**
 * Agent Auth device-authorization approval round-trip (#4411 Slice 3).
 *
 * Drives the REAL `buildAgentAuthPlugin()` through a real `betterAuth()`
 * instance (in-memory adapter, the same harness `agent-auth-plugin.test.ts`
 * uses) to prove the browser-approval half of the device flow end-to-end:
 *
 *   - APPROVE: a signed-in human POSTs `/agent/approve-capability` with the
 *     device `user_code` + `action: "approve"` → the pending capability grant
 *     transitions to `active` (the capability is now executable). This is the
 *     "request → approve → grant active" acceptance path.
 *   - DENY: the same POST with `action: "deny"` transitions the pending grant
 *     to `denied` and never activates it → the grant is left UNUSABLE. This is
 *     the "deny leaves the grant unusable" acceptance path.
 *   - USER-CODE BINDING: an approve with the WRONG code is rejected
 *     (`invalid_user_code`) and the grant stays pending — the device round-trip
 *     can't be completed without the code shown to the human.
 *
 * The approval endpoint is the plugin's own (`use: [sessionMiddleware]`), so a
 * genuine Better Auth session is minted via `signUpEmail` and its cookie is
 * forwarded — this exercises the real ownership + user-code checks, not a
 * re-implementation. The agent/host/grant/approval rows are created through the
 * live adapter AFTER signup so they reference the freshly-minted user id.
 *
 * Self-contained: `ATLAS_AGENT_AUTH_ENABLED` is not touched (the plugin's
 * approval handler is not gated by it — the HTTP router is, and that
 * setting-off→404 fail-closed gate is covered by
 * `src/api/__tests__/agent-auth-live-toggle.test.ts` +
 * `agent-auth-gate.test.ts`).
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createHash } from "node:crypto";
import { buildAgentAuthPlugin } from "@atlas/api/lib/auth/agent-auth-plugin";
import type { AtlasOpenApiSpec } from "@atlas/api/lib/auth/atlas-openapi-source";

const BASE = "http://localhost:3000";
const APPROVE_URL = `${BASE}/api/auth/agent/approve-capability`;
const WEB_APPROVAL_PAGE = "http://localhost:4000/agent/approve";

/** A safe (non-blocked) read capability the pending grant targets. */
const SAFE_CAP = "getMe";

const FIXTURE_SPEC = {
  info: { title: "Atlas API", description: "fixture" },
  paths: {
    "/api/v1/me": { get: { operationId: "getMe", description: "current user" } },
  },
} satisfies AtlasOpenApiSpec;

/**
 * The plugin stores `hashToken(userCode)` = base64url(SHA-256(userCode)) with no
 * padding — identical to Node's `digest("base64url")`. Seeding the same hash
 * lets us submit the plaintext code and hit the real match path.
 */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

/** Matches the plugin's `generateUserCode()` shape (`XXXX-XXXX`), stable for the seed. */
const USER_CODE = "ABCD-2345";

interface SignedUpUser {
  userId: string;
  cookie: string;
}

/** Build a fresh instance so each test gets an isolated in-memory store. */
function makeInstance() {
  const plugin = buildAgentAuthPlugin({
    spec: FIXTURE_SPEC,
    fetch: async () => new Response("{}", { status: 200 }),
    mintToken: async () => "unused-token",
    baseUrl: "http://internal",
    deviceAuthorizationPage: WEB_APPROVAL_PAGE,
  });
  return betterAuth({
    baseURL: BASE,
    secret: "test-secret-at-least-32-characters-long!!",
    emailAndPassword: { enabled: true },
    database: memoryAdapter({
      user: [], session: [], account: [], verification: [],
      agent: [], agentHost: [], agentCapabilityGrant: [], approvalRequest: [],
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Better Auth plugin union types
    plugins: [plugin] as any[],
  });
}

type Instance = ReturnType<typeof makeInstance>;

/** Sign up a user and return its id + a forwardable Cookie header. */
async function signUp(instance: Instance, email: string): Promise<SignedUpUser> {
  const { headers, response } = await instance.api.signUpEmail({
    body: { email, password: "password123", name: "Approver" },
    returnHeaders: true,
  });
  const cookie = headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return { userId: response.user.id, cookie };
}

/**
 * Seed a device-authorization approval scenario for `userId`: an active
 * delegated agent, its host, a PENDING grant for {@link SAFE_CAP}, and a pending
 * `device_authorization` approval request whose `userCodeHash` matches
 * {@link USER_CODE}. Returns the agent id.
 */
async function seedPendingApproval(instance: Instance, userId: string): Promise<string> {
  const ctx = await instance.$context;
  const now = new Date();
  const host = await ctx.adapter.create<Record<string, unknown>>({
    model: "agentHost",
    data: {
      name: "h", userId, defaultCapabilities: "[]", publicKey: null, kid: null,
      jwksUrl: null, enrollmentTokenHash: null, enrollmentTokenExpiresAt: null,
      status: "active", activatedAt: now, expiresAt: null, lastUsedAt: null,
      createdAt: now, updatedAt: now,
    },
  });
  const hostId = host.id as string;
  const agent = await ctx.adapter.create<Record<string, unknown>>({
    model: "agent",
    data: {
      name: "reporting-agent", userId, hostId, status: "active", mode: "delegated",
      publicKey: "{}", kid: null, jwksUrl: null, lastUsedAt: null, activatedAt: now,
      expiresAt: null, metadata: null, createdAt: now, updatedAt: now,
    },
  });
  const agentId = agent.id as string;
  await ctx.adapter.create({
    model: "agentCapabilityGrant",
    data: {
      agentId, capability: SAFE_CAP, deniedBy: null, grantedBy: userId,
      expiresAt: null, status: "pending", constraints: null, createdAt: now, updatedAt: now,
    },
  });
  await ctx.adapter.create({
    model: "approvalRequest",
    data: {
      method: "device_authorization", agentId, hostId, userId, capabilities: null,
      status: "pending", userCodeHash: hashToken(USER_CODE), loginHint: null,
      bindingMessage: null, clientNotificationToken: null, clientNotificationEndpoint: null,
      deliveryMode: null, interval: 5, lastPolledAt: null,
      expiresAt: new Date(now.getTime() + 300_000), createdAt: now, updatedAt: now,
    },
  });
  return agentId;
}

/** GET the signed-in user's pending approvals (device + CIBA). */
async function getPending(
  instance: Instance,
  cookie: string,
): Promise<{ status: number; requests: Array<Record<string, unknown>> }> {
  const res = await instance.handler(
    new Request(`${BASE}/api/auth/agent/ciba/pending`, {
      method: "GET",
      headers: { cookie },
    }),
  );
  const parsed = (await res.json().catch(() => ({}))) as { requests?: Array<Record<string, unknown>> };
  await instance.$context.catch(() => {});
  return { status: res.status, requests: parsed.requests ?? [] };
}

async function grantStatus(instance: Instance, agentId: string): Promise<string | undefined> {
  const ctx = await instance.$context;
  const grant = await ctx.adapter.findOne<{ status?: string }>({
    model: "agentCapabilityGrant",
    where: [{ field: "agentId", value: agentId }],
  });
  return grant?.status;
}

async function postApproval(
  instance: Instance,
  cookie: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: { status?: string; error?: string } }> {
  const res = await instance.handler(
    new Request(APPROVE_URL, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    }),
  );
  const parsed = (await res.json().catch(() => ({}))) as { status?: string; error?: string };
  await instance.$context.catch(() => {});
  return { status: res.status, body: parsed };
}

describe("Agent Auth device-approval round-trip (#4411)", () => {
  let instance: Instance;
  let approver: SignedUpUser;

  beforeAll(() => {
    // Sanity: the plugin defaults the page to /device/capabilities; we inject
    // the Atlas web page so the whole surface points at src/app/agent/approve.
    expect(WEB_APPROVAL_PAGE).toContain("/agent/approve");
  });

  it("GET /agent/ciba/pending returns the device request in the snake_case shape the web resolver reads", async () => {
    // Pins the wire contract `resolvePendingApproval` (packages/web) depends on:
    // the field NAMES + the `method: "device_authorization"` discriminant.
    // A @better-auth/agent-auth bump that renamed any of these would go RED here
    // instead of silently making the approval page show "no pending request".
    instance = makeInstance();
    approver = await signUp(instance, "pending@example.com");
    const agentId = await seedPendingApproval(instance, approver.userId);

    const { status, requests } = await getPending(instance, approver.cookie);
    expect(status).toBe(200);
    const req = requests.find((r) => r.agent_id === agentId);
    expect(req).toBeDefined();
    expect(req?.method).toBe("device_authorization");
    expect(typeof req?.approval_id).toBe("string");
    // Every field the web resolver maps must be present under its snake_case key.
    for (const key of [
      "approval_id",
      "method",
      "agent_id",
      "agent_name",
      "binding_message",
      "capabilities",
      "capability_reasons",
      "expires_in",
    ]) {
      expect(req && key in req).toBe(true);
    }
  });

  it("approve with the correct user code → pending grant becomes active (executable)", async () => {
    instance = makeInstance();
    approver = await signUp(instance, "approve@example.com");
    const agentId = await seedPendingApproval(instance, approver.userId);
    expect(await grantStatus(instance, agentId)).toBe("pending");

    const { status, body } = await postApproval(instance, approver.cookie, {
      agent_id: agentId,
      user_code: USER_CODE,
      action: "approve",
    });

    expect(status).toBe(200);
    expect(body.status).toBe("approved");
    expect(await grantStatus(instance, agentId)).toBe("active");
  });

  it("deny leaves the grant UNUSABLE — it transitions to denied, never active", async () => {
    instance = makeInstance();
    approver = await signUp(instance, "deny@example.com");
    const agentId = await seedPendingApproval(instance, approver.userId);

    const { status, body } = await postApproval(instance, approver.cookie, {
      agent_id: agentId,
      action: "deny",
    });

    expect(status).toBe(200);
    expect(body.status).toBe("denied");
    expect(await grantStatus(instance, agentId)).toBe("denied");
    expect(await grantStatus(instance, agentId)).not.toBe("active");
  });

  it("approve with the WRONG user code is rejected and the grant stays pending", async () => {
    instance = makeInstance();
    approver = await signUp(instance, "wrongcode@example.com");
    const agentId = await seedPendingApproval(instance, approver.userId);

    const { status, body } = await postApproval(instance, approver.cookie, {
      agent_id: agentId,
      user_code: "ZZZZ-9999",
      action: "approve",
    });

    expect(status).toBeGreaterThanOrEqual(400);
    expect(body.error).toBe("invalid_user_code");
    expect(await grantStatus(instance, agentId)).toBe("pending");
  });
});
