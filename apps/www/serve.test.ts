/**
 * Request-handler tests for the static www server's agent-discovery surface
 * (#apex-discovery). Exercises the real `handleRequest` against a fixture
 * `out/` tree — no port bound — so the routing decisions that make
 * `useatlas.dev` the first-hop discovery host are covered:
 *   - /auth.md served as markdown with permissive CORS
 *   - /.well-known/openid-configuration + /oauth-authorization-server
 *     302-redirect to the canonical, always-current API issuer docs
 *   - /.well-known/oauth-protected-resource served from the generated file
 *   - the homepage Link header advertises the new relations
 *
 * WWW_OUT_DIR points the handler at the fixture; set before importing serve.ts
 * (its OUT_DIR is read at module load), restored after. Self-contained: no
 * top-level env mutation, no chdir.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let handleRequest: (req: Request) => Promise<Response>;
let fixtureDir: string;
let prevOutDir: string | undefined;

beforeAll(async () => {
  fixtureDir = mkdtempSync(join(tmpdir(), "www-serve-"));
  writeFileSync(join(fixtureDir, "auth.md"), "# Connecting an agent to Atlas\n");
  writeFileSync(join(fixtureDir, "index.html"), "<!doctype html><title>Atlas</title>");
  mkdirSync(join(fixtureDir, ".well-known"), { recursive: true });
  writeFileSync(
    join(fixtureDir, ".well-known", "oauth-protected-resource.json"),
    `${JSON.stringify({ resource: "https://api.useatlas.dev" })}\n`,
  );

  prevOutDir = process.env.WWW_OUT_DIR;
  process.env.WWW_OUT_DIR = fixtureDir;
  ({ handleRequest } = await import("./serve"));
});

afterAll(() => {
  if (prevOutDir === undefined) delete process.env.WWW_OUT_DIR;
  else process.env.WWW_OUT_DIR = prevOutDir;
  rmSync(fixtureDir, { recursive: true, force: true });
});

const req = (path: string): Promise<Response> =>
  handleRequest(new Request(`https://www.useatlas.dev${path}`));

describe("apex agent discovery", () => {
  it("serves /auth.md as markdown with permissive CORS", async () => {
    const res = await req("/auth.md");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.text()).toContain("Connecting an agent to Atlas");
  });

  it("302-redirects /.well-known/openid-configuration to the canonical API issuer doc", async () => {
    const res = await req("/.well-known/openid-configuration");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://api.useatlas.dev/.well-known/openid-configuration/api/auth",
    );
    // ACAO so a browser agent following the redirect from fetch() isn't opaque.
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("302-redirects /.well-known/oauth-authorization-server to the canonical API issuer doc", async () => {
    const res = await req("/.well-known/oauth-authorization-server");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://api.useatlas.dev/.well-known/oauth-authorization-server/api/auth",
    );
  });

  it("serves /.well-known/oauth-protected-resource as JSON", async () => {
    const res = await req("/.well-known/oauth-protected-resource");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
  });

  it("advertises the discovery relations in the homepage Link header", async () => {
    const res = await req("/");
    const link = res.headers.get("link") ?? "";
    expect(link).toContain('</auth.md>; rel="auth.md"');
    expect(link).toContain('rel="oauth-authorization-server"');
    expect(link).toContain('rel="oauth-protected-resource"');
  });
});
