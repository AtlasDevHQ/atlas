/**
 * Integration regression for #3886 — the unauthenticated onboarding MCP
 * endpoint must stay reachable WITHOUT a bearer when it is mounted ALONGSIDE
 * the authenticated hosted router (the real production shape, `api/index.ts`),
 * AND when the onboarding router was constructed BEFORE config resolved to
 * SaaS — the boot ordering that shipped the bug.
 *
 * The shipped bug: `createOnboardingMcpRouter()` self-gated on
 * `getConfig()?.deployMode === "saas"` at CONSTRUCTION time. In `server.ts` the
 * router is built while `api/index.ts` is evaluated (via the static
 * `import { app }`), which runs BEFORE `initializeConfig()` — so `getConfig()`
 * was still `null`, the gate failed, and the router mounted with NO `/sse`
 * route. The "Onboarding MCP endpoint mounted" log fired regardless. At request
 * time `deployMode` *was* `saas`, but the static `/mcp/onboarding/sse` route
 * never existed, so the request fell through to the hosted `/:workspaceId/sse`
 * handler (`onboarding` read as a workspace id) → its bearer gate → 401
 * `missing_bearer`. The whole self-serve `start_trial` funnel was unreachable.
 *
 * `onboarding.test.ts` missed it because it drove `createOnboardingMcpRouter()`
 * in isolation (no hosted router mounted) with config already SaaS — never the
 * mounted-together, built-before-config path where the collision happens.
 *
 * This suite reproduces the exact timing: build the onboarding router while
 * config is NOT SaaS, mount it before the hosted router (production order),
 * flip config to SaaS, then drive the live `/mcp/onboarding/sse` HTTP path.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  _resetConfig,
  _setConfigForTest,
  type ResolvedConfig,
} from "@atlas/api/lib/config";
import { createOnboardingMcpRouter } from "../onboarding.js";
import { createHostedMcpRouter } from "../hosted.js";

// Only `deployMode` is read on the paths under test; a focused cast keeps the
// fixture from having to construct a full ResolvedConfig.
const saasConfig = { deployMode: "saas" } as unknown as ResolvedConfig;
const selfHostedConfig = { deployMode: "self-hosted" } as unknown as ResolvedConfig;

const INITIALIZE_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "probe", version: "1.0" },
  },
});

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
  // No Authorization header — the onboarding funnel has no token yet.
};

/**
 * Mount both routers exactly like `api/index.ts`: onboarding first (so its
 * static `/mcp/onboarding[/sse]` wins precedence over the hosted param route),
 * hosted second. `configAtBuild` is the resolved config in effect WHEN the
 * onboarding router is constructed — pass `null`/self-hosted to reproduce the
 * boot ordering where config has not resolved to SaaS yet. `configAtRuntime`
 * (default SaaS) is the config in effect when requests arrive (post-boot).
 */
function mountBoth(
  configAtBuild: ResolvedConfig | null,
  configAtRuntime: ResolvedConfig | null = saasConfig,
): Hono {
  const app = new Hono();
  _setConfigForTest(configAtBuild);
  app.route("/mcp/onboarding", createOnboardingMcpRouter());
  app.route("/mcp", createHostedMcpRouter());
  _setConfigForTest(configAtRuntime);
  return app;
}

afterEach(() => {
  _resetConfig();
});

describe("onboarding + hosted mounted together (#3886)", () => {
  it("serves /mcp/onboarding/sse unauthenticated even when built before config resolved to SaaS", async () => {
    // Built with config NOT yet SaaS — the exact server.ts boot ordering.
    const app = mountBoth(selfHostedConfig);

    const res = await app.request("/mcp/onboarding/sse", {
      method: "POST",
      headers: MCP_HEADERS,
      body: INITIALIZE_BODY,
    });

    // The bug returned 401 missing_bearer here (fell through to the hosted gate).
    expect(res.status).not.toBe(401);
    // A successful initialize issues a session — proof the request reached the
    // onboarding MCP server, not the bearer gate.
    expect(res.headers.get("mcp-session-id")).toBeTruthy();
  });

  it("also serves unauthenticated when config was unresolved (null) at build — the literal boot state", async () => {
    // getConfig() === null at construction is the real server.ts moment.
    const app = mountBoth(null);

    const res = await app.request("/mcp/onboarding/sse", {
      method: "POST",
      headers: MCP_HEADERS,
      body: INITIALIZE_BODY,
    });

    expect(res.status).not.toBe(401);
    expect(res.headers.get("mcp-session-id")).toBeTruthy();
  });

  it("serves the canonical /mcp/onboarding path (no /sse suffix) unauthenticated", async () => {
    // The standard Streamable HTTP path — the `/sse` suffix connoted the
    // deprecated transport and misled clients (#3886).
    const app = mountBoth(null);

    const res = await app.request("/mcp/onboarding", {
      method: "POST",
      headers: MCP_HEADERS,
      body: INITIALIZE_BODY,
    });

    expect(res.status).not.toBe(401);
    expect(res.headers.get("mcp-session-id")).toBeTruthy();
  });

  it.each([
    ["canonical", "/mcp/onboarding"],
    ["legacy alias", "/mcp/onboarding/sse"],
  ])(
    "a no-bearer MCP client reaches start_trial through the fully mounted app (%s path)",
    async (_label, path) => {
      const app = mountBoth(null);
      const server = Bun.serve({ port: 0, idleTimeout: 0, fetch: app.fetch });
      try {
        const client = new Client({ name: "probe", version: "1.0" });
        const transport = new StreamableHTTPClientTransport(
          new URL(`http://localhost:${server.port}${path}`),
        );
        // No auth configured on the transport — the handshake must succeed anyway.
        await client.connect(transport);
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name)).toEqual(["start_trial"]);
        await client.close();
      } finally {
        await server.stop(true);
      }
    },
  );

  it.each([
    ["POST", "/mcp/onboarding"],
    ["GET", "/mcp/onboarding"],
    ["DELETE", "/mcp/onboarding"],
    ["POST", "/mcp/onboarding/sse"],
    ["GET", "/mcp/onboarding/sse"],
    ["DELETE", "/mcp/onboarding/sse"],
  ])(
    "off-SaaS, %s %s hits the onboarding handler's 404 gate (not the hosted bearer gate, not an absent route)",
    async (method, path) => {
      // Both build AND runtime config are self-hosted — the genuine off-SaaS
      // mounted shape. Every handled method on BOTH paths must reach the
      // onboarding handler's per-request gate (structured `not_found`): a Hono
      // route-not-found would be a bodyless 404, and a fall-through to the
      // hosted `/:workspaceId/sse` gate would be 401 missing_bearer —
      // `error: "not_found"` distinguishes both. The `/sse` alias is the path
      // that could structurally collide with the hosted param route, so its
      // GET/DELETE coverage is the load-bearing case.
      const app = mountBoth(selfHostedConfig, selfHostedConfig);
      const res = await app.request(path, {
        method,
        headers: MCP_HEADERS,
        ...(method === "POST" ? { body: INITIALIZE_BODY } : {}),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe("not_found");
    },
  );

  it("the hosted /:workspaceId/sse path still 401s without a bearer (collision target is live)", async () => {
    // Proves the hosted bearer gate IS mounted and would 401 — so the onboarding
    // path's not-401 above is meaningful, not a vacuous pass from an absent gate.
    const app = mountBoth(saasConfig);

    const res = await app.request("/mcp/not-onboarding/sse", {
      method: "POST",
      headers: MCP_HEADERS,
      body: INITIALIZE_BODY,
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("missing_bearer");
  });
});
