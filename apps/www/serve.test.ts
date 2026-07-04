/**
 * Request-handler tests for the static www server's agent-discovery surface
 * (#apex-discovery). Exercises the real `handleRequest` against a fixture
 * `out/` tree — no port bound — so the routing decisions that make
 * `useatlas.dev` the first-hop discovery host are covered:
 *   - /auth.md served as markdown with permissive CORS; OPTIONS preflight; 404
 *     (not the SPA shell) when the generated file is absent
 *   - /.well-known/openid-configuration + /oauth-authorization-server
 *     302-redirect to the canonical, always-current API issuer docs
 *   - /.well-known/oauth-protected-resource served from the generated file, and
 *     the missing-file 404 branch
 *   - the homepage Link header advertises the new relations
 *   - the pre-existing markdown-twin path (now testable via the export)
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

const AUTH_MD_BODY = "# auth.md\n";

beforeAll(async () => {
  fixtureDir = mkdtempSync(join(tmpdir(), "www-serve-"));
  writeFileSync(join(fixtureDir, "auth.md"), AUTH_MD_BODY);
  writeFileSync(join(fixtureDir, "index.html"), "<!doctype html><title>Atlas</title>");
  writeFileSync(join(fixtureDir, "llms.txt"), "# Atlas — llms.txt overview\n");
  mkdirSync(join(fixtureDir, ".well-known"), { recursive: true });
  writeFileSync(
    join(fixtureDir, ".well-known", "oauth-protected-resource.json"),
    `${JSON.stringify({ resource: "https://api.useatlas.dev" })}\n`,
  );
  writeFileSync(
    join(fixtureDir, ".well-known", "atlas-regions.json"),
    `${JSON.stringify({ default: "us", regions: [{ id: "us" }] })}\n`,
  );
  // A page + its markdown twin, for the Accept: text/markdown branch.
  mkdirSync(join(fixtureDir, "markdown"), { recursive: true });
  writeFileSync(join(fixtureDir, "markdown", "guide.md"), "# Guide — markdown twin\n");
  writeFileSync(join(fixtureDir, "guide.html"), "<!doctype html><title>Guide</title>");

  prevOutDir = process.env.WWW_OUT_DIR;
  process.env.WWW_OUT_DIR = fixtureDir;
  ({ handleRequest } = await import("./serve"));
});

afterAll(() => {
  if (prevOutDir === undefined) delete process.env.WWW_OUT_DIR;
  else process.env.WWW_OUT_DIR = prevOutDir;
  rmSync(fixtureDir, { recursive: true, force: true });
});

const req = (path: string, init?: RequestInit): Promise<Response> =>
  handleRequest(new Request(`https://www.useatlas.dev${path}`, init));

describe("apex agent discovery — /auth.md", () => {
  it("serves as markdown with permissive CORS", async () => {
    const res = await req("/auth.md");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.text()).toContain("# auth.md");
  });

  it("answers the OPTIONS preflight it advertises with 204 + CORS", async () => {
    const res = await req("/auth.md", { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
  });

  it("404s (not the SPA shell) when the generated file is absent", async () => {
    rmSync(join(fixtureDir, "auth.md"));
    try {
      const res = await req("/auth.md");
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("Not Found");
    } finally {
      writeFileSync(join(fixtureDir, "auth.md"), AUTH_MD_BODY);
    }
  });
});

describe("apex agent discovery — OAuth/OIDC redirects", () => {
  it("302-redirects /.well-known/openid-configuration to the canonical API issuer doc", async () => {
    const res = await req("/.well-known/openid-configuration");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://api.useatlas.dev/.well-known/openid-configuration/api/auth",
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("302-redirects /.well-known/oauth-authorization-server to the canonical API issuer doc", async () => {
    const res = await req("/.well-known/oauth-authorization-server");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://api.useatlas.dev/.well-known/oauth-authorization-server/api/auth",
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("apex agent discovery — .well-known + homepage", () => {
  it("serves /.well-known/oauth-protected-resource as JSON with CORS", async () => {
    const res = await req("/.well-known/oauth-protected-resource");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("serves /.well-known/atlas-regions.json (region directory) with CORS", async () => {
    const res = await req("/.well-known/atlas-regions.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.json()).toMatchObject({ default: "us" });
  });

  it("404s a registered well-known route whose backing file is missing", async () => {
    // api-catalog is a registered route, but the fixture has no api-catalog.json.
    const res = await req("/.well-known/api-catalog");
    expect(res.status).toBe(404);
  });

  it("advertises the discovery relations in the homepage Link header", async () => {
    const res = await req("/");
    const link = res.headers.get("link") ?? "";
    expect(link).toContain('</auth.md>; rel="auth.md"');
    expect(link).toContain('rel="oauth-authorization-server"');
    expect(link).toContain('rel="oauth-protected-resource"');
    expect(link).toContain('rel="atlas-regions"');
  });

  it("404s an unknown path (no 404.html fixture → plain Not Found)", async () => {
    const res = await req("/does-not-exist");
    expect(res.status).toBe(404);
  });
});

describe("apex agent discovery — markdown twins", () => {
  it("serves llms.txt for / under Accept: text/markdown", async () => {
    const res = await req("/", { headers: { accept: "text/markdown" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await res.text()).toContain("llms.txt overview");
  });

  it("serves a page's markdown twin under Accept: text/markdown, HTML otherwise", async () => {
    const md = await req("/guide", { headers: { accept: "text/markdown" } });
    expect(md.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await md.text()).toContain("markdown twin");

    const html = await req("/guide");
    expect(html.status).toBe(200);
    expect(await html.text()).toContain("<!doctype html>");
  });
});
