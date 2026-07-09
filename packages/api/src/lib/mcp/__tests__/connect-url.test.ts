import { describe, expect, it, afterEach, mock, type Mock } from "bun:test";

// Capture the warn `buildMcpConnectUrl` emits on an unresolved base. Mock the
// logger before importing the SUT so its module-level `createLogger` call binds
// to these spies. Mock the full logger surface (CLAUDE.md "mock all exports").
const mockLogWarn: Mock<(...args: unknown[]) => void> = mock(() => {});
const stubLogger = {
  info: mock(() => {}),
  warn: mockLogWarn,
  error: mock(() => {}),
  debug: mock(() => {}),
};
void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => stubLogger,
  getLogger: () => stubLogger,
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
  getRequestContext: () => undefined,
  redactPaths: [],
  setLogLevel: () => false,
}));

const { buildMcpConnectUrl, resolveMcpBaseUrl } = await import("../connect-url.js");

const ORIG_PUBLIC = process.env.ATLAS_PUBLIC_API_URL;
const ORIG_AUTH = process.env.BETTER_AUTH_URL;

function restoreEnv(): void {
  if (ORIG_PUBLIC === undefined) delete process.env.ATLAS_PUBLIC_API_URL;
  else process.env.ATLAS_PUBLIC_API_URL = ORIG_PUBLIC;
  if (ORIG_AUTH === undefined) delete process.env.BETTER_AUTH_URL;
  else process.env.BETTER_AUTH_URL = ORIG_AUTH;
}

describe("buildMcpConnectUrl", () => {
  afterEach(() => {
    restoreEnv();
    mockLogWarn.mockClear();
  });

  it("builds the canonical /mcp/{workspaceId} (no /sse) from an explicit base override", () => {
    expect(buildMcpConnectUrl("org_123", "https://example.test")).toBe(
      "https://example.test/mcp/org_123",
    );
  });

  it("trims trailing slashes from the base", () => {
    expect(buildMcpConnectUrl("org_123", "https://example.test/")).toBe(
      "https://example.test/mcp/org_123",
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
      "https://mcp-eu.useatlas.dev/mcp/org_x",
    );
  });

  it("falls back to ATLAS_PUBLIC_API_URL then BETTER_AUTH_URL", () => {
    delete process.env.ATLAS_PUBLIC_API_URL;
    process.env.BETTER_AUTH_URL = "https://auth.example.test";
    expect(buildMcpConnectUrl("org_a")).toBe(
      "https://auth.example.test/mcp/org_a",
    );

    process.env.ATLAS_PUBLIC_API_URL = "https://public.example.test";
    expect(buildMcpConnectUrl("org_a")).toBe(
      "https://public.example.test/mcp/org_a",
    );
  });

  it("leaves a non-brandable host untouched", () => {
    expect(resolveMcpBaseUrl("https://atlas.acme.internal")).toBe(
      "https://atlas.acme.internal",
    );
  });

  it("resolves to an empty base when no source is set", () => {
    delete process.env.ATLAS_PUBLIC_API_URL;
    delete process.env.BETTER_AUTH_URL;
    expect(resolveMcpBaseUrl()).toBe("");
  });

  it("yields a relative (unusable) connect URL when no base resolves — and warns", () => {
    // SaaS boot requires a public API base, so this is unreachable in a
    // correctly configured region. The function does NOT throw (a missing base
    // shouldn't crash provisioning), but it emits a warn so the misconfiguration
    // surfaces rather than silently handing back a relative path. We assert the
    // documented degenerate shape so a future regression to a thrown error or a
    // different fallback is caught.
    delete process.env.ATLAS_PUBLIC_API_URL;
    delete process.env.BETTER_AUTH_URL;
    expect(buildMcpConnectUrl("org_z")).toBe("/mcp/org_z");
    // The warn is the actual point of the fix — surface the misconfiguration
    // rather than silently handing back a relative path. Assert it fired with
    // the workspace id so a regression that drops the warn is caught.
    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    expect(mockLogWarn.mock.calls[0]?.[0]).toEqual({ workspaceId: "org_z" });
  });

  it("does NOT warn when a base resolves", () => {
    expect(buildMcpConnectUrl("org_ok", "https://example.test")).toBe(
      "https://example.test/mcp/org_ok",
    );
    expect(mockLogWarn).not.toHaveBeenCalled();
  });
});
