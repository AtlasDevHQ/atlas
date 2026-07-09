/**
 * Live-toggle integration test for the Agent Auth surface (#4409).
 *
 * The headline guarantee of Slice 1: with `ATLAS_AGENT_AUTH_ENABLED` OFF (the
 * default) every agent-auth path AND the `/.well-known/agent-configuration`
 * discovery document return 404; flipping the setting ON — with NO process
 * restart and NO rebuild of the (build-once) auth singleton — makes the whole
 * surface reachable; flipping it back returns it to 404. And a non-agent-auth
 * auth path is never gated, so the gate is scoped, not a blanket kill-switch.
 *
 * This drives the REAL catch-all auth router (`routes/auth.ts`) and the REAL
 * `.well-known` router (`routes/well-known.ts`) — i.e. the actual gate wiring.
 * Only two boundaries are stubbed so the test needn't build the full heavy auth
 * singleton: `detectAuthMode` (→ managed) and `getAuthInstance` (→ a stub whose
 * `.handler` returns a 200 marker). The gate sits IN FRONT of both, so "off →
 * 404" is decided before either stub is consulted; "on → reachable" means the
 * request reaches the stub (200), never 404. The real plugin's JWT/grant
 * behavior is covered separately in `agent-auth-plugin.test.ts`.
 *
 * No-restart proof: the same mounted app + same stub is reused across the
 * off→on→off sequence; only `process.env.ATLAS_AGENT_AUTH_ENABLED` changes
 * between requests, and the `getSettingLive` stub (which mirrors real
 * no-internal-DB resolution: an env read per call — see the stub-site comment)
 * picks it up per request. Self-contained: env saved and restored.
 */

import { describe, it, expect, beforeAll, afterAll, mock } from "bun:test";
import { Hono } from "hono";

// Stub the auth-mode detector → managed, and the auth singleton → a light stub.
// Both are consulted via dynamic import inside the routers, so mock.module
// intercepts them; neither router statically imports these modules.
import * as detectReal from "@atlas/api/lib/auth/detect";
void mock.module("@atlas/api/lib/auth/detect", () => ({
  ...detectReal,
  detectAuthMode: () => "managed",
}));

const AGENT_CONFIG_DOC = { version: "1.0-draft", provider_name: "Atlas", endpoints: {} };
const stubAuthInstance = {
  handler: async (req: Request): Promise<Response> => {
    const path = new URL(req.url).pathname;
    if (path === "/api/auth/agent-configuration") {
      return new Response(JSON.stringify(AGENT_CONFIG_DOC), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    // Any other reached path → 200 marker ("reachable, not 404").
    return new Response(JSON.stringify({ reached: path }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
};
// Intentional wholesale replace (NOT a spread of the real module, unlike the
// `detect` mock above): building the real auth singleton is heavy, and both
// routers consume ONLY `getAuthInstance` from this module — and only via dynamic
// `import()` inside their handlers — so a light stub is sufficient and nothing
// else in this test's graph needs the module's other exports.
void mock.module("@atlas/api/lib/auth/server", () => ({
  getAuthInstance: () => stubAuthInstance,
}));

// Spy on `getSettingLive` to record the orgId the REAL gate threads through on
// each read, while keeping env as the source (no internal DB in the test, so a
// non-delegating stub that reads process.env matches real self-hosted
// resolution — delegating to the real fn would recurse through this same mock).
// Spread so every other settings export stays real. This lets the state-4 guard
// below assert the router NEVER passes a workspace to the gate — the property
// that keeps a tenant from re-opening an operator-disabled feature (#4419).
import * as settingsReal from "@atlas/api/lib/settings";
const gateOrgIdCalls: Array<string | undefined> = [];
void mock.module("@atlas/api/lib/settings", () => ({
  ...settingsReal,
  getSettingLive: async (_key: string, orgId?: string) => {
    gateOrgIdCalls.push(orgId);
    return process.env.ATLAS_AGENT_AUTH_ENABLED;
  },
}));

// SUT routers — imported AFTER the mocks.
import { auth } from "@atlas/api/api/routes/auth";
import { wellKnown } from "@atlas/api/api/routes/well-known";

const app = new Hono();
app.route("/api/auth", auth);
app.route("/.well-known", wellKnown);

/** Every path the gate must 404 when off / admit when on. */
const AGENT_AUTH_PATHS = [
  { method: "POST", path: "/api/auth/agent/register" },
  { method: "GET", path: "/api/auth/agent/list" },
  { method: "POST", path: "/api/auth/host/enroll" },
  { method: "POST", path: "/api/auth/host/create" },
  { method: "GET", path: "/api/auth/capability/list" },
  { method: "POST", path: "/api/auth/capability/execute" },
  { method: "GET", path: "/api/auth/agent-configuration" },
] as const;

const DISCOVERY_PATH = "/.well-known/agent-configuration";

async function req(method: string, path: string): Promise<Response> {
  return app.request(path, { method });
}

describe("Agent Auth live-toggle (#4409)", () => {
  const prev = process.env.ATLAS_AGENT_AUTH_ENABLED;

  beforeAll(() => {
    delete process.env.ATLAS_AGENT_AUTH_ENABLED; // default = off
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.ATLAS_AGENT_AUTH_ENABLED;
    else process.env.ATLAS_AGENT_AUTH_ENABLED = prev;
  });

  it("OFF (default): every agent-auth path returns 404", async () => {
    delete process.env.ATLAS_AGENT_AUTH_ENABLED;
    for (const { method, path } of AGENT_AUTH_PATHS) {
      const res = await req(method, path);
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
    }
  });

  it("OFF: the gate 404 carries the exact `{ error: \"not_found\" }` envelope the web approval page keys on", async () => {
    // Cross-package wire contract: `resolve-approval-outcome.ts` (packages/web)
    // discriminates "surface gated off" from a per-request 404 (e.g.
    // `agent_not_found`) by this literal. The constant can't be shared until the
    // next `@useatlas/types` publish window (scaffold-bound source may only use
    // published symbols), so this pin + the web-side test are the drift guard.
    // If you change this envelope, update GATE_OFF_ERROR there in the same PR.
    delete process.env.ATLAS_AGENT_AUTH_ENABLED;
    const res = await req("POST", "/api/auth/agent/approve-capability");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("not_found");
  });

  it("OFF (default): the discovery document returns 404", async () => {
    delete process.env.ATLAS_AGENT_AUTH_ENABLED;
    const res = await req("GET", DISCOVERY_PATH);
    expect(res.status).toBe(404);
  });

  it("ON (flipped live, no restart): every agent-auth path is reachable (not 404)", async () => {
    process.env.ATLAS_AGENT_AUTH_ENABLED = "true";
    for (const { method, path } of AGENT_AUTH_PATHS) {
      const res = await req(method, path);
      expect({ path, status: res.status }).toEqual({ path, status: 200 });
    }
  });

  it("ON: the discovery document is served (the plugin's canonical doc, proxied)", async () => {
    process.env.ATLAS_AGENT_AUTH_ENABLED = "true";
    const res = await req("GET", DISCOVERY_PATH);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version?: string };
    expect(body.version).toBe("1.0-draft");
  });

  it("flipped back OFF: the surface returns to 404 (no restart)", async () => {
    // Same app, same singleton — only the setting changed.
    process.env.ATLAS_AGENT_AUTH_ENABLED = "true";
    expect((await req("POST", "/api/auth/capability/execute")).status).toBe(200);
    delete process.env.ATLAS_AGENT_AUTH_ENABLED;
    expect((await req("POST", "/api/auth/capability/execute")).status).toBe(404);
    expect((await req("GET", DISCOVERY_PATH)).status).toBe(404);
  });

  it("fail-closed: an explicitly false value is off", async () => {
    process.env.ATLAS_AGENT_AUTH_ENABLED = "false";
    expect((await req("POST", "/api/auth/agent/register")).status).toBe(404);
    expect((await req("GET", DISCOVERY_PATH)).status).toBe(404);
  });

  it("state 4 (#4419): the HTTP surface reads the platform tier only — a workspace can never re-open a platform-off", async () => {
    // Platform OFF. The HTTP surface has no workspace to consult (the JWT isn't
    // verified yet), so it MUST call the gate with no orgId — meaning a
    // workspace override of ON is invisible here and the surface stays 404 for
    // everyone. Assert both the 404 AND that no orgId was ever threaded, so a
    // future refactor that leaked a workspace into the HTTP gate (which would
    // let a tenant re-open an operator-disabled feature) goes RED here.
    delete process.env.ATLAS_AGENT_AUTH_ENABLED;
    gateOrgIdCalls.length = 0;
    expect((await req("POST", "/api/auth/agent/register")).status).toBe(404);
    expect((await req("POST", "/api/auth/capability/execute")).status).toBe(404);
    expect((await req("GET", DISCOVERY_PATH)).status).toBe(404);
    expect(gateOrgIdCalls.length).toBeGreaterThan(0);
    expect(gateOrgIdCalls.every((orgId) => orgId === undefined)).toBe(true);
  });

  it("the gate is scoped: a non-agent-auth auth path is never gated", async () => {
    // sign-in is not an agent-auth path, so it reaches the auth handler
    // regardless of the setting.
    delete process.env.ATLAS_AGENT_AUTH_ENABLED;
    expect((await req("POST", "/api/auth/sign-in/email")).status).toBe(200);
    process.env.ATLAS_AGENT_AUTH_ENABLED = "true";
    expect((await req("POST", "/api/auth/sign-in/email")).status).toBe(200);
  });
});
