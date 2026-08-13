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

void mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => ({ deployMode }),
}));

const { workspaceActorGuard } = await import("../workspace-router");

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
});
