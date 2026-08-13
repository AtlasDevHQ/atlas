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

// Spread the real module. `mock.module` REPLACES it wholesale, so a factory
// returning only `getConfig` passes today purely because nothing in this
// module's transitive graph statically imports another name — the next one that
// does turns it into a load-time SyntaxError in an unrelated suite.
const realConfig = await import("@atlas/api/lib/config");
void mock.module("@atlas/api/lib/config", () => ({
  ...realConfig,
  getConfig: () => {
    if (configThrows) throw new Error("config module exploded");
    return configIsNull ? null : { deployMode };
  },
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

  // The deploy-mode predicate used to answer `false` on any fault — a silent
  // false negative on a security check, which is the one shape CLAUDE.md names
  // outright. When it says "not SaaS", this guard becomes a no-op and
  // `mode:"none"` resolves to the FULL permission set, so a wrong `false` is not
  // a degraded check, it is no check.

  it("stays armed when the config module THROWS", async () => {
    configThrows = true;
    const res = await appWith({ mode: "none" }).request("/");
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe("auth_misconfigured");
  });

  it("stays armed when config is not initialized yet", async () => {
    // Reachable: routes can be served before `initConfig` completes, and a null
    // config read as "self-hosted" is indistinguishable from the real thing.
    configIsNull = true;
    const res = await appWith({ mode: "none" }).request("/");
    expect(res.status).toBe(500);
  });

  // ⚠️ These two are the ones that matter, and the first version of this fix
  // failed both. The fallback used to be `ATLAS_DEPLOY_MODE === "saas"` — but a
  // production SaaS region sets `deployMode` in `deploy/api/atlas.config.ts` and
  // leaves that env var UNSET, so the fallback answered "self-hosted" for
  // exactly the deploy it protects. Fixtures that set the env var to "saas"
  // could not see it: they exercised the one input shape a narrow fallback gets
  // right.

  it("stays armed on a config-file SaaS region, where ATLAS_DEPLOY_MODE is unset", async () => {
    configThrows = true;
    // Deliberately NOT setting the env var — this is the prod shape.
    expect(process.env.ATLAS_DEPLOY_MODE).toBeUndefined();
    const res = await appWith({ mode: "none" }).request("/");
    expect(res.status).toBe(500);
  });

  it("honours an explicit self-hosted declaration when config is unavailable", async () => {
    // The other direction, and it is what keeps the fallback from being an
    // unconditional refusal: an operator who has SAID self-hosted is believed.
    configThrows = true;
    process.env.ATLAS_DEPLOY_MODE = "self-hosted";
    const res = await appWith({ mode: "none" }).request("/");
    expect(res.status).toBe(200);
  });
});

describe("workspaceActorGuard — middleware-order contract", () => {
  it("fails closed with 500 when authResult is absent", async () => {
    // A reorder that put this before `standardAuth` would otherwise be an
    // unlogged TypeError surfacing as an opaque 500 with no cause. Same guard
    // `mfaRequired` carries, for the same once-observed reason.
    const app = new Hono();
    app.use(async (c, next) => {
      c.set("requestId" as never, "req-test" as never);
      await next();
    });
    app.use(workspaceActorGuard as never);
    app.get("/", (c) => c.json({ reached: true }));

    const res = await app.request("/");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; requestId: string };
    expect(body.error).toBe("auth_misconfigured");
    expect(body.requestId).toBe("req-test");
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
    // 503 is the self-hosted no-op RolesPolicy answering `permissions_unavailable`
    // — the point here is that it got PAST the ordering refusal, which is a 500.
    expect(res.status).not.toBe(500);
  });
});
