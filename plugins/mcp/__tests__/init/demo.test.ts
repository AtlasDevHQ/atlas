/**
 * Tests for the `init --demo` flow (#5604): one POST mints an anonymous demo
 * principal, and the resulting config points the client at `/mcp/demo` with
 * the short-lived bearer — under the `atlas-demo` server name, never `atlas`.
 *
 * `fetchImpl` is the only external dependency, so nothing here touches the
 * network.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DemoFlowError, runDemoMintFlow } from "../../src/init/demo.js";
import { runInit } from "../../src/init/index.js";

interface StdioCapture {
  logs: string[];
  errs: string[];
  restore: () => void;
}

let activeCapture: StdioCapture | null = null;

afterEach(() => {
  if (activeCapture) {
    activeCapture.restore();
    activeCapture = null;
  }
});

function captureStdio(): StdioCapture {
  const logs: string[] = [];
  const errs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => {
    logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  };
  console.error = (...a: unknown[]) => {
    errs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  };
  const cap: StdioCapture = {
    logs,
    errs,
    restore: () => {
      console.log = origLog;
      console.error = origErr;
    },
  };
  activeCapture = cap;
  return cap;
}

const FAKE_API = "https://atlas.test";
const MINT_URL = `${FAKE_API}/api/v1/demo/anonymous`;

const OK_BODY = {
  token: "anon.token",
  expiresAt: 1_800_000_000_000,
  sessionId: "aaaaaaaa-0000-4000-8000-000000000001",
  workspaceId: "org_demo",
  mcpUrl: `${FAKE_API}/mcp/demo`,
};

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(
  respond: (call: FetchCall) => Response,
): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const call = { url, init };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("runDemoMintFlow", () => {
  it("POSTs the client label to /api/v1/demo/anonymous and returns the minted principal", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(OK_BODY));
    const result = await runDemoMintFlow({ apiUrl: `${FAKE_API}/`, client: "claude-desktop", fetchImpl });
    expect(result).toEqual({
      accessToken: "anon.token",
      expiresAt: OK_BODY.expiresAt,
      sessionId: OK_BODY.sessionId,
      workspaceId: "org_demo",
      mcpUrl: `${FAKE_API}/mcp/demo`,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(MINT_URL);
    expect(calls[0]!.init?.method).toBe("POST");
    const sentBody = calls[0]!.init?.body;
    expect(typeof sentBody).toBe("string");
    expect(JSON.parse(sentBody as string)).toEqual({ client: "claude-desktop" });
    // No email, no account: the body carries nothing else.
    expect(sentBody as string).not.toContain("email");
  });

  it("refuses a plaintext non-loopback api url before any request", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(OK_BODY));
    await expect(runDemoMintFlow({ apiUrl: "http://atlas.test", fetchImpl })).rejects.toMatchObject({
      name: "DemoFlowError",
      code: "invalid_api_url",
    });
    expect(calls).toHaveLength(0);
  });

  it("maps 404 → demo_disabled, 429 → rate_limited (with retry), other failures → mint_failed with the request id", async () => {
    let f = fakeFetch(() => json({ error: "not_found", message: "not enabled", requestId: "r1" }, 404));
    await expect(runDemoMintFlow({ apiUrl: FAKE_API, fetchImpl: f.fetchImpl })).rejects.toMatchObject({
      code: "demo_disabled",
    });

    f = fakeFetch(() => json({ error: "rate_limited", retryAfterSeconds: 7, requestId: "r2" }, 429));
    const limited = await runDemoMintFlow({ apiUrl: FAKE_API, fetchImpl: f.fetchImpl }).catch((e: unknown) => e);
    expect(limited).toBeInstanceOf(DemoFlowError);
    expect((limited as DemoFlowError).code).toBe("rate_limited");
    expect((limited as DemoFlowError).message).toContain("7s");

    f = fakeFetch(() =>
      json({ error: "demo_workspace_unavailable", message: "not available", requestId: "req-503" }, 503),
    );
    const failed = await runDemoMintFlow({ apiUrl: FAKE_API, fetchImpl: f.fetchImpl }).catch((e: unknown) => e);
    expect((failed as DemoFlowError).code).toBe("mint_failed");
    expect((failed as DemoFlowError).message).toContain("demo_workspace_unavailable");
    expect((failed as DemoFlowError).message).toContain("req-503");
  });

  it("refuses a 2xx response missing any of the five fields", async () => {
    const { token: _drop, ...noToken } = OK_BODY;
    const { fetchImpl } = fakeFetch(() => json(noToken));
    await expect(runDemoMintFlow({ apiUrl: FAKE_API, fetchImpl })).rejects.toMatchObject({
      code: "malformed_response",
    });
    const nonJson = fakeFetch(() => new Response("<html>", { status: 200 }));
    await expect(runDemoMintFlow({ apiUrl: FAKE_API, fetchImpl: nonJson.fetchImpl })).rejects.toMatchObject({
      code: "malformed_response",
    });
  });

  it("wraps a network failure as mint_failed", async () => {
    const { fetchImpl } = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(runDemoMintFlow({ apiUrl: FAKE_API, fetchImpl })).rejects.toMatchObject({
      code: "mint_failed",
    });
  });
});

describe("runInit --demo", () => {
  it("prints an atlas-demo snippet pointing at /mcp/demo with the bearer, and says the email is optional", async () => {
    const cap = captureStdio();
    try {
      const { fetchImpl } = fakeFetch(() => json(OK_BODY));
      const res = await runInit({ mode: "demo", apiUrl: FAKE_API, client: "generic", fetchImpl });
      expect(res.exitCode).toBe(0);
      const out = cap.logs.join("\n");
      expect(out).toContain('"atlas-demo"');
      expect(out).not.toContain('"atlas":');
      expect(out).toContain(`"url": "${FAKE_API}/mcp/demo"`);
      expect(out).toContain('"Authorization": "Bearer anon.token"');
      expect(out).toContain('"type": "http"');
      expect(out).toContain("optional");
      expect(out).toContain("shareEmail");
    } finally {
      cap.restore();
    }
  });

  it("merges into the client config under atlas-demo, leaving an existing `atlas` entry untouched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atlas-mcp-demo-"));
    const target = join(dir, "claude_desktop_config.json");
    writeFileSync(
      target,
      JSON.stringify({ mcpServers: { atlas: { type: "http", url: "https://mcp.test/mcp/ws_real", headers: {} } } }),
    );
    const cap = captureStdio();
    try {
      const { fetchImpl } = fakeFetch(() => json(OK_BODY));
      const res = await runInit({
        mode: "demo",
        apiUrl: FAKE_API,
        client: "claude-desktop",
        write: true,
        configPathOverride: target,
        fetchImpl,
      });
      expect(res.exitCode).toBe(0);
      const written = JSON.parse(readFileSync(target, "utf8")) as {
        mcpServers: Record<string, { url: string; headers?: Record<string, string> }>;
      };
      expect(written.mcpServers.atlas?.url).toBe("https://mcp.test/mcp/ws_real");
      expect(written.mcpServers["atlas-demo"]?.url).toBe(`${FAKE_API}/mcp/demo`);
      expect(written.mcpServers["atlas-demo"]?.headers?.Authorization).toBe("Bearer anon.token");
      expect(cap.logs.join("\n")).toContain(`Wrote ${target}`);
    } finally {
      cap.restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 1 with the flow error on stderr when the demo is disabled", async () => {
    const cap = captureStdio();
    try {
      const { fetchImpl } = fakeFetch(() => json({ error: "not_found", requestId: "r" }, 404));
      const res = await runInit({ mode: "demo", apiUrl: FAKE_API, client: "generic", fetchImpl });
      expect(res.exitCode).toBe(1);
      expect(cap.errs.join("\n")).toContain("[atlas-mcp init --demo]");
      expect(cap.errs.join("\n")).toContain("not enabled");
    } finally {
      cap.restore();
    }
  });
});
