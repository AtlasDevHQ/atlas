import { describe, expect, it, afterEach } from "bun:test";
import { buildMcpConnectUrl, resolveMcpBaseUrl } from "../connect-url.js";

const ORIG_PUBLIC = process.env.ATLAS_PUBLIC_API_URL;
const ORIG_AUTH = process.env.BETTER_AUTH_URL;

function restoreEnv(): void {
  if (ORIG_PUBLIC === undefined) delete process.env.ATLAS_PUBLIC_API_URL;
  else process.env.ATLAS_PUBLIC_API_URL = ORIG_PUBLIC;
  if (ORIG_AUTH === undefined) delete process.env.BETTER_AUTH_URL;
  else process.env.BETTER_AUTH_URL = ORIG_AUTH;
}

describe("buildMcpConnectUrl", () => {
  afterEach(restoreEnv);

  it("builds /mcp/{workspaceId}/sse from an explicit base override", () => {
    expect(buildMcpConnectUrl("org_123", "https://example.test")).toBe(
      "https://example.test/mcp/org_123/sse",
    );
  });

  it("trims trailing slashes from the base", () => {
    expect(buildMcpConnectUrl("org_123", "https://example.test/")).toBe(
      "https://example.test/mcp/org_123/sse",
    );
  });

  it("brands a regional api host onto the public mcp host", () => {
    expect(resolveMcpBaseUrl("https://api.useatlas.dev")).toBe(
      "https://mcp.useatlas.dev",
    );
    expect(resolveMcpBaseUrl("https://api-eu.useatlas.dev")).toBe(
      "https://mcp-eu.useatlas.dev",
    );
    expect(buildMcpConnectUrl("org_x", "https://api-eu.useatlas.dev")).toBe(
      "https://mcp-eu.useatlas.dev/mcp/org_x/sse",
    );
  });

  it("falls back to ATLAS_PUBLIC_API_URL then BETTER_AUTH_URL", () => {
    delete process.env.ATLAS_PUBLIC_API_URL;
    process.env.BETTER_AUTH_URL = "https://auth.example.test";
    expect(buildMcpConnectUrl("org_a")).toBe(
      "https://auth.example.test/mcp/org_a/sse",
    );

    process.env.ATLAS_PUBLIC_API_URL = "https://public.example.test";
    expect(buildMcpConnectUrl("org_a")).toBe(
      "https://public.example.test/mcp/org_a/sse",
    );
  });

  it("leaves a non-brandable host untouched", () => {
    expect(resolveMcpBaseUrl("https://atlas.acme.internal")).toBe(
      "https://atlas.acme.internal",
    );
  });
});
