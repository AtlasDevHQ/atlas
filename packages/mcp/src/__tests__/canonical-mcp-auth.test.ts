/**
 * Smoke test for the Phase 2 OAuth round-trip helper (#2119).
 *
 * Boots the in-process Better Auth + MCP server, runs the loopback flow,
 * and asserts the returned bearer is a real JWT with the expected `iss`,
 * `aud`, and workspace claim. If any of those drift, every dispatch in
 * `canonical-mcp-eval.evalspec.ts` will 401 — failing here narrows the
 * blast radius to one assertion file instead of every eval question.
 *
 * The evalspec depends on this helper working correctly. This test runs
 * BEFORE the evalspec in alphabetical order (auth.test < eval.evalspec)
 * so a regression in the helper trips here first with a precise message.
 *
 * Mocks `@atlas/api/lib/db/internal` and `@atlas/api/lib/audit` because
 * the MCP route's residency check + audit emission would otherwise pull
 * the real internal DB into scope (which has no Postgres in this test).
 */

import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import { ATLAS_OAUTH_WORKSPACE_CLAIM } from "@atlas/api/lib/auth/oauth-claims";

// `@atlas/api/lib/db/internal` is NOT mocked — the real module's
// `hasInternalDB()` returns false when `DATABASE_URL` is unset, which
// matches the eval environment. Mocking it here would have to enumerate
// every export (CLAUDE.md rule: partial mocks break sibling files via
// SyntaxError) and the real shape covers our needs naturally.

mock.module("@atlas/api/lib/audit", () => ({
  ADMIN_ACTIONS: {
    mcp_session: { start: "mcp_session.start" },
    oauth_token: {
      issue: "oauth_token.issue",
      refresh: "oauth_token.refresh",
      revoke: "oauth_token.revoke",
    },
  },
  logAdminAction: () => undefined,
  logAdminActionAwait: async () => undefined,
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  causeToError: (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
}));

interface ServerHandle {
  close: () => void;
  bearer: string;
  workspaceId: string;
  baseUrl: string;
  userId: string;
}

let handle: ServerHandle | undefined;

beforeAll(async () => {
  const { createHostedMcpRouter } = await import("@atlas/mcp/hosted");
  const { startEvalAuthServer } = await import("./canonical-mcp-auth");
  const mcpRouter = new Hono();
  mcpRouter.route("/", createHostedMcpRouter());
  handle = await startEvalAuthServer({ mcpRouter });
});

afterAll(async () => {
  handle?.close();
  handle = undefined;
  const { _resetHostedSessions } = await import("@atlas/mcp/hosted");
  await _resetHostedSessions();
  mock.restore();
});

describe("Phase 2 OAuth round-trip helper (#2119)", () => {
  it("issues a JWT-formatted bearer", () => {
    if (!handle) throw new Error("server not started");
    const parts = handle.bearer.split(".");
    expect(parts.length).toBe(3);
  });

  it("stamps the workspace claim with the activated organization id", () => {
    if (!handle) throw new Error("server not started");
    const payload = decodeJwtPayloadUnsafe(handle.bearer);
    expect(payload[ATLAS_OAUTH_WORKSPACE_CLAIM]).toBe(handle.workspaceId);
  });

  it("issues with the in-process baseUrl as the issuer", () => {
    if (!handle) throw new Error("server not started");
    const payload = decodeJwtPayloadUnsafe(handle.bearer);
    expect(payload.iss).toBe(`${handle.baseUrl}/api/auth`);
  });

  it("stamps the MCP resource indicator as the audience", () => {
    if (!handle) throw new Error("server not started");
    const payload = decodeJwtPayloadUnsafe(handle.bearer);
    const aud = payload.aud;
    const expected = `${handle.baseUrl}/mcp`;
    if (Array.isArray(aud)) {
      expect(aud).toContain(expected);
    } else {
      expect(aud).toBe(expected);
    }
  });

  it("MCP route accepts the issued bearer end-to-end", async () => {
    if (!handle) throw new Error("server not started");
    const res = await fetch(`${handle.baseUrl}/mcp/${handle.workspaceId}/sse`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${handle.bearer}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "auth-smoke", version: "0.0.0" },
        },
        id: 1,
      }),
    });
    // The contract is "not 401"; the SDK may negotiate via SSE so we
    // don't pin a specific success status. A 401 here means the JWKS
    // path or audience matching broke; that's the regression class
    // this test exists to catch.
    // The contract is "not 401"; the SDK may negotiate via SSE so we
    // don't pin a specific success status. A 401 here means the JWKS
    // path or audience / issuer matching broke; that is the regression
    // class this test exists to catch. Surface the response body on
    // failure so a future regression names the underlying mismatch
    // (audience / issuer / expiry) without requiring a re-run.
    if (res.status === 401) {
      const body = await res.text();
      throw new Error(
        `MCP route rejected the real bearer with 401. Body: ${body.slice(0, 256)}`,
      );
    }
    expect(res.headers.get("www-authenticate")).toBeNull();
  });
});

/**
 * Decode a JWT payload WITHOUT verifying the signature. Safe ONLY in
 * test code where we just minted the token from an in-process issuer
 * we control. Production callers must always use the JWKS-backed
 * verifier — see hosted.ts / verifyAccessToken for the production path.
 */
function decodeJwtPayloadUnsafe(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error(`not a JWT: ${jwt.slice(0, 40)}…`);
  const json = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
  return JSON.parse(json) as Record<string, unknown>;
}
