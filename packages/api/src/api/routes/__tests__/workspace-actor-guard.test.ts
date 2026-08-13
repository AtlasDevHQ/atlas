/**
 * #5189 — `workspaceActorGuard`, isolated.
 *
 * `createWorkspaceRouter()` builds on `standardAuth`, which does two fewer
 * things than the `adminAuth` it replaces on the dashboards surface. This guard
 * puts both back, and the reason to test it apart from the routes is that one
 * of them depends on DEPLOY MODE — a condition the shared route harness pins to
 * self-hosted, so a route-level test of it would pass without ever entering the
 * branch.
 *
 * The `mode: "none"` case is the sharper of the two. It is the no-auth local-dev
 * carve-out, and `resolveLegacyPermissions` short-circuits an undefined user in
 * that mode to the FULL `PERMISSIONS` set — so under SaaS it is not a weak
 * check, it is no check at all. `adminAuth` carries this guard (#3342 L-1)
 * precisely because the weaker tier was the unguarded one, and a workspace
 * router is a weaker tier.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
import { Hono } from "hono";

let deployMode = "self-hosted";
let configThrows = false;
let configIsNull = false;
let deployModeAbsent = false;

// Spread the real module. `mock.module` REPLACES it wholesale, so a factory
// returning only `getConfig` passes today purely because nothing in this
// module's transitive graph statically imports another name — the next one that
// does turns it into a load-time SyntaxError in an unrelated suite.
const realConfig = await import("@atlas/api/lib/config");
void mock.module("@atlas/api/lib/config", () => ({
  ...realConfig,
  getConfig: () => {
    if (configThrows) throw new Error("config module exploded");
    if (configIsNull) return null;
    return deployModeAbsent ? {} : { deployMode };
  },
}));

// The unknown-deploy-mode arms all RESOLVE the same way (permissive), so the
// log is the only thing that distinguishes "determined self-hosted" from "could
// not determine, proceeding anyway". Measured: without capturing it, collapsing
// the three states back into `mode !== "saas"` passes every behavioural
// assertion in this file — the fix would be unfalsifiable.
const warnings: Array<{ obj: Record<string, unknown>; msg: string }> = [];
const realLogger = await import("@atlas/api/lib/logger");
void mock.module("@atlas/api/lib/logger", () => ({
  ...realLogger,
  createLogger: () => ({
    info: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    error: () => {},
    warn: (obj: unknown, msg?: unknown) => {
      warnings.push({
        obj: (typeof obj === "object" && obj !== null ? obj : {}) as Record<string, unknown>,
        msg: typeof msg === "string" ? msg : typeof obj === "string" ? obj : "",
      });
    },
    child() {
      return this;
    },
  }),
}));

const { workspaceActorGuard, requireWorkspacePermission } = await import(
  "../workspace-router"
);

type TestAuth = {
  mode: string;
  user?: { id: string; claims?: Record<string, unknown> };
};

function appWith(authResult: TestAuth) {
  const app = new Hono();
  app.use(async (c, next) => {
    c.set("requestId" as never, "req-test" as never);
    c.set("authResult" as never, authResult as never);
    await next();
  });
  app.use(workspaceActorGuard as never);
  app.get("/", (c) => c.json({ reached: true }));
  return app;
}

beforeEach(() => {
  deployMode = "self-hosted";
  configThrows = false;
  configIsNull = false;
  deployModeAbsent = false;
  warnings.length = 0;
  delete process.env.ATLAS_DEPLOY_MODE;
});

describe("workspaceActorGuard — workspace API keys", () => {
  it("denies a request carrying the api_key marker claim", async () => {
    const res = await appWith({
      mode: "managed",
      user: { id: "k1", claims: { api_key: true } },
    }).request("/");

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("api_key_not_permitted");
    // The admin router's copy says "cannot access admin endpoints", which is
    // false on a surface that is deliberately not an admin endpoint.
    expect(body.message).not.toContain("admin endpoints");
  });

  it("admits an ordinary human session", async () => {
    const res = await appWith({ mode: "managed", user: { id: "u1" } }).request("/");
    expect(res.status).toBe(200);
  });

  it("treats a non-`true` marker as human — the claim is read by identity", async () => {
    // `resolveActorKind` tests `=== true`. Pinning this stops a future fixture
    // from asserting the deny while exercising the human path.
    const res = await appWith({
      mode: "managed",
      user: { id: "u1", claims: { api_key: "yes" } },
    }).request("/");
    expect(res.status).toBe(200);
  });
});

describe('workspaceActorGuard — mode:"none" under SaaS', () => {
  it("refuses with 500 auth_misconfigured when deploy mode is saas", async () => {
    deployMode = "saas";
    const res = await appWith({ mode: "none" }).request("/");

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("auth_misconfigured");
  });

  it("admits the same request self-hosted — this is the local-dev carve-out", async () => {
    // Both halves matter: a guard that refused unconditionally would break
    // `bun run dev` with no auth configured, which is the documented default.
    const res = await appWith({ mode: "none" }).request("/");
    expect(res.status).toBe(200);
  });

  it("does not refuse an ordinary managed session under saas", async () => {
    deployMode = "saas";
    const res = await appWith({ mode: "managed", user: { id: "u1" } }).request("/");
    expect(res.status).toBe(200);
  });

  // ── The unknown-deploy-mode arms ────────────────────────────────
  //
  // The predicate used to answer `false` on any fault, SILENTLY, and had a
  // third state (`deployMode === undefined`) that fell through the same way.
  //
  // ⚠️ Fail-closed on unknown was implemented and then WITHDRAWN, measured: it
  // reddened `dashboards`, `integrations-discord`,
  // `integrations-slack-install-cap` and `admin-router` — the supported
  // self-hosted no-auth configuration.
  // `mode: "none"` means no auth is configured, which is a documented
  // self-hosted posture and a catastrophically broken SaaS region — so unknown
  // resolves permissive, and what changed is that it now says so in the log.
  // These tests pin the resolution rather than the aspiration.

  // Each arm asserts BOTH halves: it proceeds, AND it says why it could not
  // determine the mode. The status alone is identical to a determined
  // self-hosted answer, so without the log assertion these three cannot fail.

  it("does not refuse when the config module THROWS, and warns with the cause", async () => {
    configThrows = true;
    const res = await appWith({ mode: "none" }).request("/");
    expect(res.status).toBe(200);
    const w = warnings.find((x) => x.msg.includes("deploy-mode unresolved"));
    expect(w, "no deploy-mode warning was emitted").toBeDefined();
    expect(String(w!.obj.reason)).toContain("config module exploded");
  });

  it("does not refuse when config is not initialized yet, and warns", async () => {
    configIsNull = true;
    const res = await appWith({ mode: "none" }).request("/");
    expect(res.status).toBe(200);
    expect(warnings.some((x) => x.msg.includes("deploy-mode unresolved"))).toBe(true);
  });

  it("stays SILENT when the mode is genuinely determined", async () => {
    // The other half — a predicate that warned unconditionally would satisfy
    // every assertion above while making the log useless.
    const res = await appWith({ mode: "none" }).request("/");
    expect(res.status).toBe(200);
    expect(warnings.filter((x) => x.msg.includes("deploy-mode unresolved"))).toEqual([]);
  });

  it("does not refuse when config resolved but deployMode is ABSENT, and warns", async () => {
    // The third input shape, and the one the type itself says is possible:
    // `ResolvedConfig.deployMode` is optional. The first version of this fix
    // narrowed on `cfg !== null` and left this arm on the old permissive path
    // with no log at all — so a `_setConfigForTest(Partial<…>)` fixture could
    // assert the guard and pass for the wrong reason.
    deployModeAbsent = true;
    const res = await appWith({ mode: "none" }).request("/");
    expect(res.status).toBe(200);
    const w = warnings.find((x) => x.msg.includes("deploy-mode unresolved"));
    expect(w, "an absent deployMode was treated as a determined answer").toBeDefined();
    expect(w!.obj.reason).toBe("config resolved deployMode=undefined");
  });

  it("STILL refuses when the env states saas and config is unavailable", async () => {
    // The one positive signal available without config. Without this arm the
    // three tests above would be satisfied by a predicate hardcoded to false,
    // which is exactly what they are meant to rule out.
    configThrows = true;
    process.env.ATLAS_DEPLOY_MODE = "saas";
    const res = await appWith({ mode: "none" }).request("/");
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe("auth_misconfigured");
  });
});

describe("workspaceActorGuard — middleware-order contract", () => {
  it("fails closed with 500 when authResult is absent", async () => {
    // A reorder that put this before `standardAuth` would otherwise be an
    // unlogged TypeError surfacing as an opaque 500 with no cause. Same guard
    // `mfaRequired` carries, for the same once-observed reason.
    // Deliberately NO `requestId` seeded by the fixture. `standardAuth` sets
    // BOTH `requestId` and `authResult`, so this branch's own precondition
    // guarantees there is none to read — a fixture that sets one tests a state
    // production cannot reach, and an earlier version of this test passed only
    // because of that.
    const app = new Hono();
    app.use(workspaceActorGuard as never);
    app.get("/", (c) => c.json({ reached: true }));

    const res = await app.request("/");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; requestId: string };
    expect(body.error).toBe("auth_misconfigured");
    // CLAUDE.md: every 500 carries a requestId. Seeded here, not read — the
    // first version READ one and shipped a 500 with no correlation handle, on
    // the one path built to be a debugging aid.
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("honours an inbound x-request-id when seeding", async () => {
    const app = new Hono();
    app.use(workspaceActorGuard as never);
    app.get("/", (c) => c.json({ reached: true }));

    const res = await app.request("/", {
      headers: { "x-request-id": "trace-abc" },
    });
    expect(((await res.json()) as { requestId: string }).requestId).toBe("trace-abc");
  });
});

describe("requireWorkspacePermission — refuses to run un-guarded", () => {
  it("fails closed with 500 when workspaceActorGuard did not run", async () => {
    // The gate is mounted PER ROUTE and the guard PER ROUTER, so the middleware
    // that grants is not the middleware that guards. A future file composing
    // `standardAuth` + `requireWorkspacePermission` by hand would silently lose
    // the api-key deny and the SaaS `mode:"none"` refusal — and would pass every
    // test written against the composed dashboards app, because those exercise a
    // router where the guard IS mounted. This is the only thing that sees it.
    const app = new Hono();
    app.use(async (c, next) => {
      c.set("requestId" as never, "req-test" as never);
      c.set("authResult" as never, { mode: "managed", user: { id: "u1" } } as never);
      await next();
    });
    app.use(requireWorkspacePermission("dashboards:read") as never);
    app.get("/", (c) => c.json({ reached: true }));

    const res = await app.request("/");
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe("auth_misconfigured");
  });

  it("proceeds when the guard ran first", async () => {
    // Both halves: a refusal that fires unconditionally would pass the test
    // above while breaking every real route.
    const app = new Hono();
    app.use(async (c, next) => {
      c.set("requestId" as never, "req-test" as never);
      c.set("authResult" as never, { mode: "managed", user: { id: "u1" } } as never);
      await next();
    });
    app.use(workspaceActorGuard as never);
    app.use(requireWorkspacePermission("dashboards:read") as never);
    app.get("/", (c) => c.json({ reached: true }));

    const res = await app.request("/");
    // 200, measured. The self-hosted no-op RolesPolicy delegates to
    // `checkPermissionLegacy`, and a role-less user defaults to `member`,
    // which now carries `dashboards:read` — so it ALLOWS. (`not.toBe(500)`
    // would also pass on a 404 or a 503; the exact status additionally pins
    // the member grant end to end.)
    expect(res.status).toBe(200);
  });
});
