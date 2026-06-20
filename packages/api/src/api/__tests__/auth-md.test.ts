/**
 * Route tests for `GET /auth.md` (#3824).
 *
 * Thin — these cover the HTTP-plumbing contract only: 200 + `text/markdown`
 * + CORS headers in managed mode; 404 in non-managed mode; the `OPTIONS`
 * preflight responds like the sibling `.well-known` discovery routes. The
 * *content* of the document is asserted by the pure-builder unit tests in
 * `lib/mcp/__tests__/auth-md.test.ts`; here we only confirm the wiring.
 *
 * Structure mirrors `well-known.test.ts` — same auth-mode mock, same
 * gating outcomes (`managed` / `not-managed`), same header expectations.
 */

import { describe, it, expect, beforeEach, afterAll, mock } from "bun:test";

// ── Mocks ──────────────────────────────────────────────────────────

const mockDetectAuthMode: { current: "managed" | "none" } = {
  current: "managed",
};

mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => mockDetectAuthMode.current,
}));

// ── Import routes after mocks ──────────────────────────────────────

const { authMd } = await import("../routes/auth-md");
const { Hono } = await import("hono");

afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  mockDetectAuthMode.current = "managed";
});

async function startServer() {
  const app = new Hono();
  app.route("/auth.md", authMd);
  const server = Bun.serve({ port: 0, idleTimeout: 0, fetch: app.fetch });
  return {
    url: `http://localhost:${server.port}`,
    close: () => server.stop(true),
  };
}

describe("auth.md — managed auth mode", () => {
  it("serves GET /auth.md as 200 text/markdown with permissive CORS", async () => {
    const prev = process.env.ATLAS_PUBLIC_API_URL;
    process.env.ATLAS_PUBLIC_API_URL = "https://api.useatlas.dev";
    const handle = await startServer();
    try {
      const res = await fetch(`${handle.url}/auth.md`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/markdown");
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("cache-control")).toContain("max-age");

      const body = await res.text();
      // The hosts are resolved from the shared .well-known helpers, so /auth.md
      // advertises exactly what machine discovery does: the auth-server issuer
      // is the api.* host (`buildAuthServerUri`, matching the protected-resource
      // metadata's `authorization_servers`), and the MCP resource is the
      // brand-mirror mcp.* host (`buildResourceUri`).
      expect(body).toContain("https://api.useatlas.dev/api/auth");
      expect(body).toContain("https://mcp.useatlas.dev/mcp");
      // Scopes flow from the canonical ATLAS_OAUTH_SCOPES constant.
      expect(body).toContain("mcp:read");
      expect(body).toContain("mcp:write");
      // The onboarding endpoint + start_trial contract are named.
      expect(body).toContain("/mcp/onboarding/sse");
      expect(body).toContain("start_trial");
      // Backstop: no WorkOS conformance endpoint Atlas doesn't serve.
      expect(body).not.toContain("/agent/identity");
    } finally {
      handle.close();
      if (prev === undefined) delete process.env.ATLAS_PUBLIC_API_URL;
      else process.env.ATLAS_PUBLIC_API_URL = prev;
    }
  });

  it("answers OPTIONS preflight with a CORS-permissive 204", async () => {
    const handle = await startServer();
    try {
      const res = await fetch(`${handle.url}/auth.md`, { method: "OPTIONS" });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("access-control-allow-methods")).toContain("GET");
    } finally {
      handle.close();
    }
  });
});

describe("auth.md — non-managed auth mode", () => {
  it("returns 404 when auth is not managed", async () => {
    mockDetectAuthMode.current = "none";
    const handle = await startServer();
    try {
      const res = await fetch(`${handle.url}/auth.md`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("not_found");
    } finally {
      handle.close();
    }
  });
});
