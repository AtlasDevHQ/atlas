/**
 * The anonymous demo principal (#5604) — the DB-free half.
 *
 * Token purpose isolation, the actor's reach, the IP hash, the settings
 * getters, and BOTH rate limits in their failing direction. The DB-backed
 * half (session rows, the answer-count email gate, slug resolution) runs
 * against real Postgres in `lib/__tests__/demo-anonymous-pg.test.ts`.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { signDemoToken, verifyDemoToken } from "@atlas/api/lib/demo";
import {
  ANONYMOUS_DEMO_SCOPES,
  anonymousDemoActor,
  anonymousDemoClientId,
  checkAnonymousDemoLimits,
  getAnonymousDemoIdentityRpmLimit,
  getAnonymousDemoIpRpmLimit,
  getAnonymousDemoTokenTtlMs,
  getDemoWorkspaceSlug,
  hashDemoIp,
  resetAnonymousDemoRateLimits,
  signAnonymousDemoToken,
  verifyAnonymousDemoToken,
} from "@atlas/api/lib/demo-anonymous";
import { getUserRole, meetsRoleRequirement } from "@atlas/api/lib/auth/permissions";
import { writeScopeDenied } from "@atlas/api/lib/mcp/dispatch-gate-contract";

const ORIG_SECRET = process.env.BETTER_AUTH_SECRET;
beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = "test-better-auth-secret-at-least-32-chars-long";
});
afterAll(() => {
  if (ORIG_SECRET === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = ORIG_SECRET;
});

const SID = "3f8c1d2e-0000-4000-8000-000000000001";
const WS = "org_demo";

describe("anonymous demo token", () => {
  it("round-trips session + workspace and carries the expiry", () => {
    const signed = signAnonymousDemoToken(SID, WS, 60_000);
    expect(signed).not.toBeNull();
    const claims = verifyAnonymousDemoToken(signed!.token);
    expect(claims).toEqual({ sessionId: SID, workspaceId: WS, expiresAt: signed!.expiresAt });
  });

  it("is NOT an email demo token, and an email demo token is NOT an anonymous one (distinct keys)", () => {
    const anon = signAnonymousDemoToken(SID, WS, 60_000)!;
    expect(verifyDemoToken(anon.token)).toBeNull();

    const email = signDemoToken("visitor@example.com")!;
    expect(verifyAnonymousDemoToken(email.token)).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const signed = signAnonymousDemoToken(SID, WS, 60_000)!;
    const [payload, sig] = signed.token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ kind: "anon", sid: SID, ws: "org_victim", exp: Date.now() + 60_000 }),
    ).toString("base64url");
    expect(verifyAnonymousDemoToken(`${forged}.${sig}`)).toBeNull();
    expect(verifyAnonymousDemoToken(`${payload}.${sig}x`)).toBeNull();
    expect(verifyAnonymousDemoToken("not-a-token")).toBeNull();
  });

  it("rejects an expired token", () => {
    const signed = signAnonymousDemoToken(SID, WS, -1)!;
    expect(verifyAnonymousDemoToken(signed.token)).toBeNull();
  });

  it("returns null when no signing secret is configured", () => {
    const saved = process.env.BETTER_AUTH_SECRET;
    delete process.env.BETTER_AUTH_SECRET;
    try {
      expect(signAnonymousDemoToken(SID, WS, 60_000)).toBeNull();
    } finally {
      process.env.BETTER_AUTH_SECRET = saved;
    }
  });
});

describe("anonymous demo actor — less reach than the email demo, never more", () => {
  it("is a member bound to the demo workspace, never admin", () => {
    const actor = anonymousDemoActor(SID, WS);
    expect(actor.activeOrganizationId).toBe(WS);
    expect(getUserRole(actor)).toBe("member");
    expect(meetsRoleRequirement(actor, "member")).toBe(true);
    expect(meetsRoleRequirement(actor, "admin")).toBe(false);
    expect(actor.id).toBe(`demo-anon:${SID}`);
  });

  it("carries a NON-EMPTY client id so it is never stdio-exempt from the write-scope gate", () => {
    const clientId = anonymousDemoClientId(SID);
    expect(clientId.length).toBeGreaterThan(0);
    expect(clientId).toContain(SID);
    // mcp:read only → any write tool is denied at gate 2.
    expect(writeScopeDenied({ clientId, scopes: ANONYMOUS_DEMO_SCOPES })).toBe(true);
    expect(ANONYMOUS_DEMO_SCOPES).toEqual(["mcp:read"]);
  });
});

describe("hashDemoIp — no raw IP at rest", () => {
  it("is deterministic, keyed, and never equals the input", () => {
    const a = hashDemoIp("203.0.113.7");
    const b = hashDemoIp("203.0.113.7");
    expect(a).toBe(b);
    expect(a).not.toBe("203.0.113.7");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(hashDemoIp("203.0.113.8")).not.toBe(a);
  });

  it("is null for an unknown IP", () => {
    expect(hashDemoIp(null)).toBeNull();
  });
});

describe("settings getters (env tier, registry defaults)", () => {
  const KEYS = [
    "ATLAS_DEMO_WORKSPACE_SLUG",
    "ATLAS_DEMO_ANON_IP_RATE_LIMIT_RPM",
    "ATLAS_DEMO_ANON_RATE_LIMIT_RPM",
    "ATLAS_DEMO_ANON_TOKEN_TTL_MINUTES",
  ] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("defaults: novamart-demo, 20 rpm per IP, 10 rpm per identity, 120 minutes", () => {
    expect(getDemoWorkspaceSlug()).toBe("novamart-demo");
    expect(getAnonymousDemoIpRpmLimit()).toBe(20);
    expect(getAnonymousDemoIdentityRpmLimit()).toBe(10);
    expect(getAnonymousDemoTokenTtlMs()).toBe(120 * 60_000);
  });

  it("reads overrides and falls back on invalid values", () => {
    process.env.ATLAS_DEMO_WORKSPACE_SLUG = "  other-demo ";
    process.env.ATLAS_DEMO_ANON_IP_RATE_LIMIT_RPM = "3";
    process.env.ATLAS_DEMO_ANON_RATE_LIMIT_RPM = "0";
    process.env.ATLAS_DEMO_ANON_TOKEN_TTL_MINUTES = "5";
    expect(getDemoWorkspaceSlug()).toBe("other-demo");
    expect(getAnonymousDemoIpRpmLimit()).toBe(3);
    expect(getAnonymousDemoIdentityRpmLimit()).toBe(0);
    expect(getAnonymousDemoTokenTtlMs()).toBe(5 * 60_000);

    process.env.ATLAS_DEMO_ANON_IP_RATE_LIMIT_RPM = "-1";
    process.env.ATLAS_DEMO_ANON_TOKEN_TTL_MINUTES = "100000";
    expect(getAnonymousDemoIpRpmLimit()).toBe(20);
    expect(getAnonymousDemoTokenTtlMs()).toBe(120 * 60_000);
  });
});

describe("rate limits — both buckets exercised in their failing direction", () => {
  const savedIp = process.env.ATLAS_DEMO_ANON_IP_RATE_LIMIT_RPM;
  const savedId = process.env.ATLAS_DEMO_ANON_RATE_LIMIT_RPM;
  beforeEach(async () => {
    await resetAnonymousDemoRateLimits();
  });
  afterEach(() => {
    if (savedIp === undefined) delete process.env.ATLAS_DEMO_ANON_IP_RATE_LIMIT_RPM;
    else process.env.ATLAS_DEMO_ANON_IP_RATE_LIMIT_RPM = savedIp;
    if (savedId === undefined) delete process.env.ATLAS_DEMO_ANON_RATE_LIMIT_RPM;
    else process.env.ATLAS_DEMO_ANON_RATE_LIMIT_RPM = savedId;
  });

  it("trips the per-IDENTITY bucket at its budget while the IP bucket still has headroom", async () => {
    process.env.ATLAS_DEMO_ANON_IP_RATE_LIMIT_RPM = "100";
    process.env.ATLAS_DEMO_ANON_RATE_LIMIT_RPM = "2";
    const ip = "198.51.100.1";
    expect((await checkAnonymousDemoLimits({ ip, sessionId: "s1" })).allowed).toBe(true);
    expect((await checkAnonymousDemoLimits({ ip, sessionId: "s1" })).allowed).toBe(true);
    const third = await checkAnonymousDemoLimits({ ip, sessionId: "s1" });
    expect(third.allowed).toBe(false);
    if (!third.allowed) {
      expect(third.bucket).toBe("identity");
      expect(third.retryAfterMs).toBeGreaterThan(0);
    }
    // A different identity behind the same IP is unaffected — the identity
    // budget is per minted principal.
    expect((await checkAnonymousDemoLimits({ ip, sessionId: "s2" })).allowed).toBe(true);
  });

  it("trips the per-IP bucket at its budget across identities AND blocks a mint from that IP", async () => {
    process.env.ATLAS_DEMO_ANON_IP_RATE_LIMIT_RPM = "2";
    process.env.ATLAS_DEMO_ANON_RATE_LIMIT_RPM = "100";
    const ip = "198.51.100.2";
    expect((await checkAnonymousDemoLimits({ ip, sessionId: "a" })).allowed).toBe(true);
    expect((await checkAnonymousDemoLimits({ ip, sessionId: "b" })).allowed).toBe(true);
    const third = await checkAnonymousDemoLimits({ ip, sessionId: "c" });
    expect(third.allowed).toBe(false);
    if (!third.allowed) expect(third.bucket).toBe("ip");
    // The mint shares the bucket: no fresh identity from an exhausted IP.
    const mint = await checkAnonymousDemoLimits({ ip, sessionId: null });
    expect(mint.allowed).toBe(false);
    if (!mint.allowed) expect(mint.bucket).toBe("ip");
    // Another IP is unaffected.
    expect((await checkAnonymousDemoLimits({ ip: "198.51.100.3", sessionId: "a" })).allowed).toBe(true);
  });

  it("does not charge a blocked attempt (backing off recovers on schedule)", async () => {
    process.env.ATLAS_DEMO_ANON_IP_RATE_LIMIT_RPM = "100";
    process.env.ATLAS_DEMO_ANON_RATE_LIMIT_RPM = "1";
    const ip = "198.51.100.4";
    expect((await checkAnonymousDemoLimits({ ip, sessionId: "s" })).allowed).toBe(true);
    // The IP bucket must not have been charged by the identity-blocked call.
    expect((await checkAnonymousDemoLimits({ ip, sessionId: "s" })).allowed).toBe(false);
    expect((await checkAnonymousDemoLimits({ ip, sessionId: "s" })).allowed).toBe(false);
    process.env.ATLAS_DEMO_ANON_IP_RATE_LIMIT_RPM = "2";
    // Only ONE IP attempt was recorded (the allowed one), so one slot remains.
    expect((await checkAnonymousDemoLimits({ ip, sessionId: "t" })).allowed).toBe(true);
  });

  it("collapses an unknown IP into one shared bucket rather than skipping the IP limit", async () => {
    process.env.ATLAS_DEMO_ANON_IP_RATE_LIMIT_RPM = "1";
    process.env.ATLAS_DEMO_ANON_RATE_LIMIT_RPM = "100";
    expect((await checkAnonymousDemoLimits({ ip: null, sessionId: "x" })).allowed).toBe(true);
    const second = await checkAnonymousDemoLimits({ ip: null, sessionId: "y" });
    expect(second.allowed).toBe(false);
    if (!second.allowed) expect(second.bucket).toBe("ip");
  });

  it("0 disables a bucket", async () => {
    process.env.ATLAS_DEMO_ANON_IP_RATE_LIMIT_RPM = "0";
    process.env.ATLAS_DEMO_ANON_RATE_LIMIT_RPM = "0";
    for (let i = 0; i < 25; i++) {
      expect((await checkAnonymousDemoLimits({ ip: "198.51.100.5", sessionId: "z" })).allowed).toBe(true);
    }
  });
});
