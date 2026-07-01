/**
 * Tests for the anonymous onboarding caller (`start_trial`, ADR-0018, #3649).
 *
 *   1. The tool provisions into grace and hands back the connect URL, over the
 *      in-memory Client/Server transport — the same seam `tools.test.ts` uses.
 *   2. Input is collected via tool args OR MCP elicitation.
 *   3. Typed provisioning failures surface as `AtlasMcpToolError` envelopes.
 *   4. The tool + router are SaaS-only: absent off-SaaS.
 *   5. The onboarding server exposes ONLY `start_trial` — no read/write tools —
 *      so the anonymous caller can never reach the dispatch gate.
 */

import { describe, expect, it, mock, beforeAll, afterAll } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { parseAtlasMcpToolError } from "@useatlas/types/mcp";
import { TrialProvisioningError } from "@atlas/ee/onboarding/provision-trial";

// Control deployMode via getConfig — mirrors hosted.test.ts. `mockDeployMode`
// is mutable so individual tests can flip SaaS on/off.
let mockDeployMode: "saas" | "self-hosted" = "saas";
const __mockedConfig = () => ({ deployMode: mockDeployMode });
mock.module("@atlas/api/lib/config", () => ({
  initializeConfig: mock(async () => __mockedConfig()),
  getConfig: mock(() => __mockedConfig()),
  loadConfig: mock(async () => __mockedConfig()),
  configFromEnv: mock(() => __mockedConfig()),
  validateAndResolve: mock(() => __mockedConfig()),
  defineConfig: (c: unknown) => c,
  applyDatasources: mock(async () => undefined),
  validateToolConfig: mock(async () => undefined),
  formatZodErrors: () => "",
  _resetConfig: mock(() => undefined),
  _setConfigForTest: mock(() => undefined),
  _warnPoolDefaultsInSaaS: mock(() => undefined),
}));

import {
  registerStartTrialTool,
  createOnboardingMcpServer,
  createOnboardingMcpRouter,
  type ProvisionTrialFn,
  type TrialAttemptLimiter,
} from "../onboarding.js";

/** Default test stub: rate limit allows. */
const allowRate: TrialAttemptLimiter = async () => ({ allowed: true });

// The elicitation requestState is HMAC'd from BETTER_AUTH_SECRET; set one for
// the round-trip test and restore after (self-contained, no top-level mutation).
const ORIG_AUTH_SECRET = process.env.BETTER_AUTH_SECRET;
beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = "test-better-auth-secret-at-least-32-chars-long";
});
afterAll(() => {
  if (ORIG_AUTH_SECRET === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = ORIG_AUTH_SECRET;
});

const okProvision: ProvisionTrialFn = async (input) => ({
  workspaceId: "org_new",
  connectUrl: "https://mcp.test/mcp/org_new/sse",
  claimUrl: `https://app.test/claim?email=${encodeURIComponent(input.email)}`,
  state: input.orgName.includes("locked") ? "locked" : "grace",
});

async function wireTool(
  provision: ProvisionTrialFn,
  opts: {
    withElicitation?: { email: string; orgName: string };
    /** Raw elicitation reply — lets a test decline/cancel or return partial content. */
    elicit?: () => { action: string; content?: Record<string, string> };
    /** Override the attempt limiter (defaults to allow-all). */
    checkRateLimit?: TrialAttemptLimiter;
  } = {},
) {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  registerStartTrialTool(server, {
    provision,
    checkRateLimit: opts.checkRateLimit ?? allowRate,
  });

  const wantsElicit = Boolean(opts.withElicitation || opts.elicit);
  const client = new Client(
    { name: "test-client", version: "0.0.1" },
    wantsElicit ? { capabilities: { elicitation: {} } } : undefined,
  );
  if (opts.elicit) {
    const reply = opts.elicit;
    client.setRequestHandler(ElicitRequestSchema, async () => reply());
  } else if (opts.withElicitation) {
    const reply = opts.withElicitation;
    client.setRequestHandler(ElicitRequestSchema, async () => ({
      action: "accept",
      content: { email: reply.email, orgName: reply.orgName },
    }));
  }

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client };
}

describe("start_trial tool", () => {
  it("exposes only start_trial (no read/write tools reach the anonymous caller)", async () => {
    const { client } = await wireTool(okProvision);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["start_trial"]);
  });

  it("provisions into grace and returns { workspaceId, connectUrl, claimUrl, state } from args", async () => {
    const { client } = await wireTool(okProvision);
    const result = await client.callTool({
      name: "start_trial",
      arguments: { email: "founder@acme.com", orgName: "Acme" },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      workspaceId: "org_new",
      connectUrl: "https://mcp.test/mcp/org_new/sse",
      claimUrl: "https://app.test/claim?email=founder%40acme.com",
      state: "grace",
    });
  });

  it("passes a locked state through unchanged", async () => {
    const { client } = await wireTool(okProvision);
    const result = await client.callTool({
      name: "start_trial",
      arguments: { email: "founder@acme.com", orgName: "locked-acme"},
    });
    expect(
      (result.structuredContent as { state: string }).state,
    ).toBe("locked");
  });

  it("collects email + orgName via MCP elicitation when omitted", async () => {
    const seen: Array<{ email: string; orgName: string }> = [];
    const provision: ProvisionTrialFn = async (input) => {
      seen.push(input);
      return {
        workspaceId: "org_elicited",
        connectUrl: "https://mcp.test/mcp/org_elicited/sse",
        claimUrl: "https://app.test/claim?email=elicited%40acme.com",
        state: "grace",
      };
    };
    const { client } = await wireTool(provision, {
      withElicitation: { email: "elicited@acme.com", orgName: "Elicited Co" },
    });
    const result = await client.callTool({
      name: "start_trial",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    expect(seen).toEqual([{ email: "elicited@acme.com", orgName: "Elicited Co" }]);
    expect(
      (result.structuredContent as { workspaceId: string }).workspaceId,
    ).toBe("org_elicited");
  });

  it("returns a validation_failed envelope when the client declines elicitation", async () => {
    let provisioned = false;
    const provision: ProvisionTrialFn = async () => {
      provisioned = true;
      return {
        workspaceId: "org_x",
        connectUrl: "https://mcp.test/mcp/org_x/sse",
        claimUrl: "https://app.test/claim?email=x%40acme.com",
        state: "grace",
      };
    };
    const { client } = await wireTool(provision, {
      elicit: () => ({ action: "decline" }),
    });
    // No args → the tool elicits; the client declines.
    const result = await client.callTool({ name: "start_trial", arguments: {} });
    expect(result.isError).toBe(true);
    const arr = result.content as Array<{ type: string; text: string }>;
    const err = parseAtlasMcpToolError(arr[0]!.text);
    expect(err?.code).toBe("validation_failed");
    // A declined elicitation must never provision.
    expect(provisioned).toBe(false);
  });

  it("merges a supplied arg with an elicited field (partial elicitation)", async () => {
    const seen: Array<{ email: string; orgName: string }> = [];
    const provision: ProvisionTrialFn = async (input) => {
      seen.push(input);
      return {
        workspaceId: "org_partial",
        connectUrl: "https://mcp.test/mcp/org_partial/sse",
        claimUrl: "https://app.test/claim?email=supplied%40acme.com",
        state: "grace",
      };
    };
    // email supplied as an arg; only orgName comes back from elicitation.
    const { client } = await wireTool(provision, {
      elicit: () => ({ action: "accept", content: { orgName: "Elicited Co" } }),
    });
    const result = await client.callTool({
      name: "start_trial",
      arguments: { email: "supplied@acme.com"},
    });
    expect(result.isError).toBeFalsy();
    expect(seen).toEqual([
      { email: "supplied@acme.com", orgName: "Elicited Co" },
    ]);
  });

  it("maps every TrialProvisioningError code to the right envelope", async () => {
    const cases: Array<{
      code:
        | "invalid_input"
        | "business_email"
        | "plus_addressing"
        | "signup_failed"
        | "not_saas"
        | "org_failed"
        | "trial_not_assigned";
      envelopeCode: "validation_failed" | "forbidden" | "internal_error";
      expectHint?: boolean;
      // Substring the hint must contain, pinning the distinct per-code wording
      // (not just "a hint exists") so plus_addressing can't silently collapse
      // into the generic business_email/signup_failed hint.
      expectHintIncludes?: string;
      expectRequestId?: boolean;
    }> = [
      { code: "invalid_input", envelopeCode: "validation_failed" },
      { code: "business_email", envelopeCode: "validation_failed", expectHint: true },
      {
        code: "plus_addressing",
        envelopeCode: "validation_failed",
        expectHint: true,
        expectHintIncludes: "you+tag",
      },
      { code: "signup_failed", envelopeCode: "validation_failed", expectHint: true },
      { code: "not_saas", envelopeCode: "forbidden" },
      { code: "org_failed", envelopeCode: "internal_error", expectRequestId: true },
      {
        code: "trial_not_assigned",
        envelopeCode: "internal_error",
        expectRequestId: true,
      },
    ];
    for (const tc of cases) {
      const provision: ProvisionTrialFn = async () => {
        throw new TrialProvisioningError(tc.code, `boom:${tc.code}`);
      };
      const { client } = await wireTool(provision);
      const result = await client.callTool({
        name: "start_trial",
        arguments: { email: "x@y.com", orgName: "Acme" },
      });
      expect(result.isError).toBe(true);
      const arr = result.content as Array<{ type: string; text: string }>;
      const err = parseAtlasMcpToolError(arr[0]!.text);
      expect(err?.code).toBe(tc.envelopeCode);
      if (tc.expectHint) expect(typeof err?.hint).toBe("string");
      if (tc.expectHintIncludes) {
        expect(err?.hint, `hint for ${tc.code} must carry its distinct wording`).toContain(
          tc.expectHintIncludes,
        );
      }
      if (tc.expectRequestId) {
        // Assert the shape, not mere truthiness — the literal string
        // "undefined" would pass `toBeTruthy()`. request_id is a UUID.
        expect(err?.request_id).toMatch(/^[0-9a-f-]{36}$/i);
      }
    }
  });

  it("maps a TrialProvisioningError(invalid_input) to a validation_failed envelope", async () => {
    const provision: ProvisionTrialFn = async () => {
      throw new TrialProvisioningError("invalid_input", "bad email");
    };
    const { client } = await wireTool(provision);
    const result = await client.callTool({
      name: "start_trial",
      arguments: { email: "x@y.com", orgName: "Acme" },
    });
    expect(result.isError).toBe(true);
    const arr = result.content as Array<{ type: string; text: string }>;
    const err = parseAtlasMcpToolError(arr[0]!.text);
    expect(err?.code).toBe("validation_failed");
  });

  it("maps an unexpected error to internal_error with a request_id", async () => {
    const provision: ProvisionTrialFn = async () => {
      throw new Error("kaboom");
    };
    const { client } = await wireTool(provision);
    const result = await client.callTool({
      name: "start_trial",
      arguments: { email: "x@y.com", orgName: "Acme" },
    });
    expect(result.isError).toBe(true);
    const arr = result.content as Array<{ type: string; text: string }>;
    const err = parseAtlasMcpToolError(arr[0]!.text);
    expect(err?.code).toBe("internal_error");
    expect(err?.request_id).toMatch(/^[0-9a-f-]{36}$/i);
  });
});

describe("start_trial abuse controls (#3654 / #4159)", () => {
  // ── No Turnstile on the headless door (#4159) ─────────────────────────────
  // Turnstile is proof-of-human-in-a-browser; a CLI/AI-agent caller can't solve
  // it. It moved to the interactive web signup (server captcha plugin +
  // rendered widget). The headless door provisions with NO token; its abuse
  // bound is rate-limit + business-email policy + the unclaimed-grace reaper.
  it("provisions with NO Turnstile token — the headless door needs none (#4159)", async () => {
    const seen: Array<{ email: string; orgName: string }> = [];
    const provision: ProvisionTrialFn = async (input) => {
      seen.push(input);
      return okProvision(input);
    };
    const { client } = await wireTool(provision);
    const result = await client.callTool({
      name: "start_trial",
      arguments: { email: "founder@acme.com", orgName: "Acme" }, // no turnstileToken
    });
    expect(result.isError).toBeFalsy();
    // Provisioning actually ran — not a validation short-circuit.
    expect(seen).toEqual([{ email: "founder@acme.com", orgName: "Acme" }]);
    expect(
      (result.structuredContent as { workspaceId: string }).workspaceId,
    ).toBe("org_new");
  });

  it("ignores a stray turnstileToken arg — stripped by the input schema, not an error (#4159)", async () => {
    // An older client that still sends `turnstileToken` must not fail: the tool
    // input schema no longer declares the field, so the MCP SDK strips the
    // unknown key and provisioning proceeds normally.
    const { client } = await wireTool(okProvision);
    const result = await client.callTool({
      name: "start_trial",
      arguments: {
        email: "founder@acme.com",
        orgName: "Acme",
        turnstileToken: "leftover-from-an-old-client",
      } as Record<string, unknown>,
    });
    expect(result.isError).toBeFalsy();
    expect(
      (result.structuredContent as { workspaceId: string }).workspaceId,
    ).toBe("org_new");
  });

  // ── Rate limiting ─────────────────────────────────────────────────────────
  it("returns a typed rate_limited envelope with retry guidance when the limiter trips", async () => {
    let provisioned = false;
    const provision: ProvisionTrialFn = async () => {
      provisioned = true;
      return okProvision({ email: "x@y.com", orgName: "Acme" });
    };
    const checkRateLimit: TrialAttemptLimiter = async () => ({
      allowed: false,
      bucket: "email",
      retryAfterMs: 42_000,
    });
    const { client } = await wireTool(provision, { checkRateLimit });
    const result = await client.callTool({
      name: "start_trial",
      arguments: { email: "spam@acme.com", orgName: "Acme" },
    });
    expect(result.isError).toBe(true);
    const err = parseAtlasMcpToolError(
      (result.content as Array<{ text: string }>)[0]!.text,
    );
    expect(err?.code).toBe("rate_limited");
    expect(err?.retry_after).toBe(42); // ceil(42000 / 1000)
    expect(err?.hint).toBeTruthy();
    // Rate-limit is the FIRST (and now only pre-provision) guard: provisioning
    // must not run once the limiter trips.
    expect(provisioned).toBe(false);
  });

  it("passes the resolved email to the rate limiter and recovers once it clears", async () => {
    const seen: Array<{ ip: string | null; email: string }> = [];
    let trip = true;
    const checkRateLimit: TrialAttemptLimiter = async (input) => {
      seen.push(input);
      return trip
        ? { allowed: false, bucket: "ip", retryAfterMs: 1000 }
        : { allowed: true };
    };
    const { client } = await wireTool(okProvision, { checkRateLimit });

    // First call trips the limiter.
    const blocked = await client.callTool({
      name: "start_trial",
      arguments: { email: "burst@acme.com", orgName: "Acme" },
    });
    expect(blocked.isError).toBe(true);
    expect(
      parseAtlasMcpToolError((blocked.content as Array<{ text: string }>)[0]!.text)?.code,
    ).toBe("rate_limited");

    // Window clears — the same caller now succeeds (trip → recover).
    trip = false;
    const ok = await client.callTool({
      name: "start_trial",
      arguments: { email: "burst@acme.com", orgName: "Acme" },
    });
    expect(ok.isError).toBeFalsy();
    expect(seen).toEqual([
      { ip: null, email: "burst@acme.com" },
      { ip: null, email: "burst@acme.com" },
    ]);
  });
});

describe("onboarding SaaS gating", () => {
  it("createOnboardingMcpServer returns a server on SaaS, null off-SaaS", () => {
    mockDeployMode = "saas";
    expect(createOnboardingMcpServer({ provision: okProvision })).not.toBeNull();
    mockDeployMode = "self-hosted";
    expect(createOnboardingMcpServer({ provision: okProvision })).toBeNull();
    mockDeployMode = "saas";
  });

  it("/sse returns a structured 404 off-SaaS, serves on SaaS — gate is per-request, route always registered (#3886)", async () => {
    // The /sse route is ALWAYS registered (so it wins precedence over the hosted
    // param route regardless of when config resolved); off-SaaS the handler
    // refuses with a structured 404 rather than the route being absent.
    mockDeployMode = "self-hosted";
    const offRouter = createOnboardingMcpRouter();
    const off = await offRouter.request("/sse", { method: "POST" });
    expect(off.status).toBe(404);
    const offBody = (await off.json()) as { error?: string; requestId?: string };
    expect(offBody.error).toBe("not_found");
    expect(offBody.requestId).toBeTruthy();

    mockDeployMode = "saas";
    const onRouter = createOnboardingMcpRouter();
    const on = await onRouter.request("/sse", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(on.status).not.toBe(404);
  });

  it("a router built off-SaaS still serves once config flips to SaaS — no construction-time gate (#3886)", async () => {
    // Reproduces the server.ts boot ordering at the unit level: the router is
    // constructed before config resolves to SaaS, yet must serve once it does.
    mockDeployMode = "self-hosted";
    const router = createOnboardingMcpRouter();

    mockDeployMode = "saas";
    const res = await router.request("/sse", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "1.0" } },
      }),
    });
    expect(res.status).not.toBe(404);
    expect(res.headers.get("mcp-session-id")).toBeTruthy();
  });

  it("returns a structured unknown_session 404 for a bogus mcp-session-id (SaaS)", async () => {
    mockDeployMode = "saas";
    const router = createOnboardingMcpRouter();
    const res = await router.request("/sse", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": "does-not-exist",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    // A present-but-unknown session id is a different 404 than the off-SaaS
    // no-route 404 — it carries the structured unknown_session body + requestId.
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string; requestId?: string };
    expect(body.error).toBe("unknown_session");
    expect(body.requestId).toBeTruthy();
  });
});
