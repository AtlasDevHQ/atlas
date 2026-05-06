/**
 * Tests for the OAuth 2.1 loopback flow in `init --hosted`.
 *
 * Strategy: most external deps (fetch, browser, loopback listener, RNG,
 * timer) are replaced with deterministic stubs via the `HostedFlowOptions`
 * test seams. The integration block at the bottom exercises the actual
 * `defaultServeImpl` against a real Bun.serve port to pin the once-fired
 * listener guard.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultServeImpl,
  runHostedAuthFlow,
  type HostedFlowOptions,
  type LoopbackHandler,
  type LoopbackServer,
  type ServeImpl,
} from "../../src/init/hosted.js";
import { runInit } from "../../src/init/index.js";

// ── Helpers ───────────────────────────────────────────────────────────

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

const DISCOVERY_BODY = {
  authorization_endpoint: `${FAKE_API}/api/auth/oauth2/authorize`,
  token_endpoint: `${FAKE_API}/api/auth/oauth2/token`,
  registration_endpoint: `${FAKE_API}/api/auth/oauth2/register`,
  issuer: `${FAKE_API}/api/auth`,
};

/** Build a JWT-shaped string with a custom payload. Signature is junk —
 *  we never verify here. */
function jwt(payload: Record<string, unknown>): string {
  const enc = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${enc({ alg: "RS256", typ: "JWT" })}.${enc(payload)}.signature-not-verified`;
}

/** Deterministic random — base64url(0,1,2,…) with the requested length. */
function deterministicRandom(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = i & 0xff;
  return bytes;
}

/**
 * The base64url state value the flow generates from `deterministicRandom`
 * for `randomBytes(32)`. Mirrored inline once so every test asserts
 * against the same constant — if `encodeBase64Url` ever drifts from this,
 * one test reports the mismatch instead of all of them.
 */
const EXPECTED_STATE = (() => {
  let bin = "";
  for (let i = 0; i < 32; i++) bin += String.fromCharCode(i & 0xff);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
})();

/** The verifier the flow generates is a separate 32-byte draw. */
const EXPECTED_VERIFIER = (() => {
  let bin = "";
  for (let i = 0; i < 32; i++) bin += String.fromCharCode(i & 0xff);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
})();

type FetchStub = (req: Request) => Response | Promise<Response>;
interface FetchStubBehavior {
  /** Either the JSON body to return or a function that throws/returns. */
  discovery?: unknown | FetchStub;
  registration?: unknown | FetchStub;
  token?: unknown | FetchStub;
}

function fakeFetch(behavior: FetchStubBehavior): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const req = new Request(url, init);
    const dispatch = async (slot: unknown): Promise<Response> => {
      if (typeof slot === "function") {
        return (slot as FetchStub)(req);
      }
      return new Response(JSON.stringify(slot), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    if (url.includes("/.well-known/oauth-authorization-server")) {
      return dispatch(behavior.discovery ?? DISCOVERY_BODY);
    }
    if (url.endsWith("/register")) {
      return dispatch(behavior.registration ?? { client_id: "fake-client-id" });
    }
    if (url.endsWith("/token")) {
      return dispatch(behavior.token ?? {
        access_token: jwt({
          sub: "user-1",
          iss: DISCOVERY_BODY.issuer,
          "https://atlas.useatlas.dev/workspace_id": "ws_alpha",
        }),
        refresh_token: "r-1",
      });
    }
    throw new Error(`fakeFetch: no stub for ${url}`);
  }) as unknown as typeof fetch;
}

interface FakeServer extends LoopbackServer {
  invoke: (params: URLSearchParams, method?: string) => { status: number; body: string };
  stopped: boolean;
}

/**
 * Synchronous loopback stub. The flow under test starts the server, then
 * waits for the callback; we expose a hand-fired `invoke()` that the test
 * can call after kicking off the flow to deliver `?code=…&state=…`. The
 * method defaults to GET (the only method the OAuth callback uses).
 */
function fakeServe(params?: { port?: number }): { serve: ServeImpl; controller: () => FakeServer } {
  let captured: FakeServer | null = null;
  const serve: ServeImpl = async (handler: LoopbackHandler) => {
    const inst: FakeServer = {
      port: params?.port ?? 49152,
      stop: async () => {
        inst.stopped = true;
      },
      invoke: (p, method = "GET") => handler(p, method),
      stopped: false,
    };
    captured = inst;
    return inst;
  };
  return {
    serve,
    controller: () => {
      if (!captured) throw new Error("fakeServe: serve() not yet called");
      return captured;
    },
  };
}

// ── runHostedAuthFlow ──────────────────────────────────────────────────

describe("runHostedAuthFlow — happy path", () => {
  it("completes the loopback flow and returns the JWT + refresh + workspace", async () => {
    const { serve, controller } = fakeServe({ port: 49152 });
    const opts: HostedFlowOptions = {
      apiUrl: FAKE_API,
      fetchImpl: fakeFetch({}),
      serveImpl: serve,
      openBrowserImpl: async () => ({ ok: true }),
      randomBytesImpl: deterministicRandom,
      callbackTimeoutMs: 5000,
      consoleImpl: { log: () => {}, error: () => {} },
    };

    const pending = runHostedAuthFlow(opts);

    // Yield once so the flow registers the loopback handler before we
    // fire the callback. Without this, controller() throws.
    await new Promise((r) => setTimeout(r, 0));
    const params = new URLSearchParams();
    params.set("code", "abc123");
    // The state must match the encoded random bytes the flow generated.
    // We mirror the same encoding inline (deterministic).
    params.set("state", EXPECTED_STATE);
    const result = controller().invoke(params);
    expect(result.status).toBe(200);

    const out = await pending;
    expect(out.accessToken).toContain(".");
    // Bearer is a branded string; compare as plain string for the assertion.
    expect(out.refreshToken as string | null).toBe("r-1");
    expect(out.workspaceId).toBe("ws_alpha");
    expect(out.mcpUrl).toBe(`${FAKE_API}/mcp/ws_alpha/sse`);
    // Listener was stopped on success.
    expect(controller().stopped).toBe(true);
  });
});

describe("runHostedAuthFlow — wire format (pins acceptance criteria from #2024)", () => {
  it("sends PKCE S256 + 127.0.0.1 redirect_uri across DCR, authorize URL, and token", async () => {
    const { serve, controller } = fakeServe({ port: 49152 });
    const expectedRedirect = "http://127.0.0.1:49152/callback";

    let registrationBody: Record<string, unknown> | null = null;
    let authorizeUrl: string | null = null;
    let tokenForm: URLSearchParams | null = null;

    // Compute what the flow's PKCE code_challenge should be (S256(verifier)).
    const verifierBytes = new TextEncoder().encode(EXPECTED_VERIFIER);
    const digest = await crypto.subtle.digest("SHA-256", verifierBytes);
    const expectedChallenge = (() => {
      let bin = "";
      const arr = new Uint8Array(digest);
      for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
      return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    })();

    const pending = runHostedAuthFlow({
      apiUrl: FAKE_API,
      fetchImpl: fakeFetch({
        registration: async (req: Request) => {
          registrationBody = (await req.json()) as Record<string, unknown>;
          return new Response(JSON.stringify({ client_id: "test-client-id" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
        token: async (req: Request) => {
          tokenForm = new URLSearchParams(await req.text());
          return new Response(
            JSON.stringify({
              access_token: jwt({
                sub: "user-1",
                iss: DISCOVERY_BODY.issuer,
                "https://atlas.useatlas.dev/workspace_id": "ws_alpha",
              }),
              refresh_token: "r-1",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        },
      }),
      serveImpl: serve,
      openBrowserImpl: async (url) => {
        authorizeUrl = url;
        return { ok: true };
      },
      randomBytesImpl: deterministicRandom,
      callbackTimeoutMs: 5000,
      consoleImpl: { log: () => {}, error: () => {} },
    });
    await new Promise((r) => setTimeout(r, 0));
    controller().invoke(new URLSearchParams({ code: "the-code", state: EXPECTED_STATE }));
    await pending;

    // DCR — public-client posture, exact redirect URI, both grant types.
    expect(registrationBody).toMatchObject({
      client_name: "Atlas MCP CLI",
      token_endpoint_auth_method: "none",
      redirect_uris: [expectedRedirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });

    // Authorize URL — PKCE S256 + state + redirect parameters all present.
    expect(authorizeUrl).not.toBeNull();
    const u = new URL(authorizeUrl!);
    expect(u.origin + u.pathname).toBe(DISCOVERY_BODY.authorization_endpoint);
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("client_id")).toBe("test-client-id");
    expect(u.searchParams.get("redirect_uri")).toBe(expectedRedirect);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toBe(expectedChallenge);
    expect(u.searchParams.get("state")).toBe(EXPECTED_STATE);
    // Scopes include offline_access so a refresh token is issuable.
    expect(u.searchParams.get("scope")).toContain("mcp:read");
    expect(u.searchParams.get("scope")).toContain("offline_access");

    // Token exchange — auth-code grant, code+verifier+redirect_uri match.
    expect(tokenForm).not.toBeNull();
    expect(tokenForm!.get("grant_type")).toBe("authorization_code");
    expect(tokenForm!.get("code")).toBe("the-code");
    expect(tokenForm!.get("redirect_uri")).toBe(expectedRedirect);
    expect(tokenForm!.get("client_id")).toBe("test-client-id");
    expect(tokenForm!.get("code_verifier")).toBe(EXPECTED_VERIFIER);
  });
});

describe("runHostedAuthFlow — failure modes", () => {
  it("rejects on state mismatch (CSRF probe)", async () => {
    const { serve, controller } = fakeServe({});
    const pending = runHostedAuthFlow({
      apiUrl: FAKE_API,
      fetchImpl: fakeFetch({}),
      serveImpl: serve,
      openBrowserImpl: async () => ({ ok: true }),
      randomBytesImpl: deterministicRandom,
      callbackTimeoutMs: 5000,
      consoleImpl: { log: () => {}, error: () => {} },
    });
    await new Promise((r) => setTimeout(r, 0));
    const r = controller().invoke(
      new URLSearchParams({ code: "x", state: "wrong-state" }),
    );
    expect(r.status).toBe(400);
    await expect(pending).rejects.toMatchObject({
      name: "HostedFlowError",
      code: "callback_state_mismatch",
    });
    expect(controller().stopped).toBe(true);
  });

  it("rejects when the callback is missing the code parameter", async () => {
    const { serve, controller } = fakeServe({});
    const pending = runHostedAuthFlow({
      apiUrl: FAKE_API,
      fetchImpl: fakeFetch({}),
      serveImpl: serve,
      openBrowserImpl: async () => ({ ok: true }),
      randomBytesImpl: deterministicRandom,
      callbackTimeoutMs: 5000,
      consoleImpl: { log: () => {}, error: () => {} },
    });
    await new Promise((r) => setTimeout(r, 0));
    controller().invoke(new URLSearchParams({ state: EXPECTED_STATE }));
    await expect(pending).rejects.toMatchObject({ code: "callback_missing_code" });
  });

  it("rejects when the auth server returns ?error=access_denied", async () => {
    const { serve, controller } = fakeServe({});
    const pending = runHostedAuthFlow({
      apiUrl: FAKE_API,
      fetchImpl: fakeFetch({}),
      serveImpl: serve,
      openBrowserImpl: async () => ({ ok: true }),
      randomBytesImpl: deterministicRandom,
      callbackTimeoutMs: 5000,
      consoleImpl: { log: () => {}, error: () => {} },
    });
    await new Promise((r) => setTimeout(r, 0));
    controller().invoke(
      new URLSearchParams({
        error: "access_denied",
        error_description: "user clicked deny",
      }),
    );
    await expect(pending).rejects.toMatchObject({ code: "callback_oauth_error" });
  });

  it("rejects when the token endpoint returns invalid_grant", async () => {
    const { serve, controller } = fakeServe({});
    const pending = runHostedAuthFlow({
      apiUrl: FAKE_API,
      fetchImpl: fakeFetch({
        token: () =>
          new Response(
            JSON.stringify({ error: "invalid_grant", error_description: "code expired" }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          ),
      }),
      serveImpl: serve,
      openBrowserImpl: async () => ({ ok: true }),
      randomBytesImpl: deterministicRandom,
      callbackTimeoutMs: 5000,
      consoleImpl: { log: () => {}, error: () => {} },
    });
    await new Promise((r) => setTimeout(r, 0));
    controller().invoke(new URLSearchParams({ code: "abc", state: EXPECTED_STATE }));
    await expect(pending).rejects.toMatchObject({ code: "token_exchange_failed" });
  });

  it("falls back to manual URL when the browser launcher fails but completes the flow", async () => {
    const { serve, controller } = fakeServe({});
    const errors: string[] = [];
    const pending = runHostedAuthFlow({
      apiUrl: FAKE_API,
      fetchImpl: fakeFetch({}),
      serveImpl: serve,
      openBrowserImpl: async () => ({ ok: false, detail: "xdg-open: not found" }),
      randomBytesImpl: deterministicRandom,
      callbackTimeoutMs: 5000,
      consoleImpl: { log: () => {}, error: (m) => errors.push(m) },
    });
    await new Promise((r) => setTimeout(r, 0));
    controller().invoke(new URLSearchParams({ code: "abc", state: EXPECTED_STATE }));
    const result = await pending;
    expect(result.workspaceId).toBe("ws_alpha");
    expect(errors.join("\n")).toMatch(/auto-launch the browser/);
    expect(errors.join("\n")).toMatch(/xdg-open: not found/);
  });

  it("rejects when the access_token has no workspace_id claim", async () => {
    const { serve, controller } = fakeServe({});
    // iss matches, workspace_id missing — should land on missing_workspace_claim
    const noWorkspaceJwt = jwt({ sub: "user-1", iss: DISCOVERY_BODY.issuer });
    const pending = runHostedAuthFlow({
      apiUrl: FAKE_API,
      fetchImpl: fakeFetch({
        token: { access_token: noWorkspaceJwt },
      }),
      serveImpl: serve,
      openBrowserImpl: async () => ({ ok: true }),
      randomBytesImpl: deterministicRandom,
      callbackTimeoutMs: 5000,
      consoleImpl: { log: () => {}, error: () => {} },
    });
    await new Promise((r) => setTimeout(r, 0));
    controller().invoke(new URLSearchParams({ code: "abc", state: EXPECTED_STATE }));
    await expect(pending).rejects.toMatchObject({ code: "missing_workspace_claim" });
  });

  it("rejects when the access_token issuer does not match discovery", async () => {
    const { serve, controller } = fakeServe({});
    const wrongIssJwt = jwt({
      sub: "user-1",
      iss: "https://evil.example.com/api/auth",
      "https://atlas.useatlas.dev/workspace_id": "ws_alpha",
    });
    const pending = runHostedAuthFlow({
      apiUrl: FAKE_API,
      fetchImpl: fakeFetch({ token: { access_token: wrongIssJwt } }),
      serveImpl: serve,
      openBrowserImpl: async () => ({ ok: true }),
      randomBytesImpl: deterministicRandom,
      callbackTimeoutMs: 5000,
      consoleImpl: { log: () => {}, error: () => {} },
    });
    await new Promise((r) => setTimeout(r, 0));
    controller().invoke(new URLSearchParams({ code: "abc", state: EXPECTED_STATE }));
    await expect(pending).rejects.toMatchObject({ code: "issuer_mismatch" });
  });

  it("rejects an http:// apiUrl that isn't localhost", async () => {
    const { serve } = fakeServe({});
    await expect(
      runHostedAuthFlow({
        apiUrl: "http://evil.example.com",
        fetchImpl: fakeFetch({}),
        serveImpl: serve,
        openBrowserImpl: async () => ({ ok: true }),
        randomBytesImpl: deterministicRandom,
        callbackTimeoutMs: 5000,
        consoleImpl: { log: () => {}, error: () => {} },
      }),
    ).rejects.toMatchObject({ code: "invalid_api_url" });
  });

  it("returns 405 on a non-GET callback without settling the flow", async () => {
    const { serve, controller } = fakeServe({});
    const pending = runHostedAuthFlow({
      apiUrl: FAKE_API,
      fetchImpl: fakeFetch({}),
      serveImpl: serve,
      openBrowserImpl: async () => ({ ok: true }),
      randomBytesImpl: deterministicRandom,
      callbackTimeoutMs: 200,
      consoleImpl: { log: () => {}, error: () => {} },
    });
    await new Promise((r) => setTimeout(r, 0));
    const probe = controller().invoke(
      new URLSearchParams({ code: "abc", state: EXPECTED_STATE }),
      "POST",
    );
    expect(probe.status).toBe(405);
    // The flow continues waiting; the legitimate callback eventually arrives.
    controller().invoke(new URLSearchParams({ code: "abc", state: EXPECTED_STATE }));
    const result = await pending;
    expect(result.workspaceId).toBe("ws_alpha");
  });

  it("accepts http://127.0.0.1 for local-dev testing", async () => {
    const { serve, controller } = fakeServe({});
    const localDiscovery = {
      authorization_endpoint: "http://127.0.0.1:3001/api/auth/oauth2/authorize",
      token_endpoint: "http://127.0.0.1:3001/api/auth/oauth2/token",
      registration_endpoint: "http://127.0.0.1:3001/api/auth/oauth2/register",
      issuer: "http://127.0.0.1:3001/api/auth",
    };
    const localJwt = jwt({
      sub: "user-1",
      iss: localDiscovery.issuer,
      "https://atlas.useatlas.dev/workspace_id": "ws_dev",
    });
    const pending = runHostedAuthFlow({
      apiUrl: "http://127.0.0.1:3001",
      fetchImpl: fakeFetch({
        discovery: localDiscovery,
        token: { access_token: localJwt },
      }),
      serveImpl: serve,
      openBrowserImpl: async () => ({ ok: true }),
      randomBytesImpl: deterministicRandom,
      callbackTimeoutMs: 5000,
      consoleImpl: { log: () => {}, error: () => {} },
    });
    await new Promise((r) => setTimeout(r, 0));
    controller().invoke(new URLSearchParams({ code: "abc", state: EXPECTED_STATE }));
    const result = await pending;
    expect(result.workspaceId).toBe("ws_dev");
  });

  it("rejects when discovery itself fails", async () => {
    const { serve } = fakeServe({});
    await expect(
      runHostedAuthFlow({
        apiUrl: FAKE_API,
        fetchImpl: fakeFetch({
          discovery: () => new Response("nope", { status: 503 }),
        }),
        serveImpl: serve,
        openBrowserImpl: async () => ({ ok: true }),
        randomBytesImpl: deterministicRandom,
        callbackTimeoutMs: 5000,
        consoleImpl: { log: () => {}, error: () => {} },
      }),
    ).rejects.toMatchObject({ code: "discovery_failed" });
  });

  it("rejects when DCR fails", async () => {
    const { serve } = fakeServe({});
    await expect(
      runHostedAuthFlow({
        apiUrl: FAKE_API,
        fetchImpl: fakeFetch({
          registration: () =>
            new Response(JSON.stringify({ error: "invalid_request" }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            }),
        }),
        serveImpl: serve,
        openBrowserImpl: async () => ({ ok: true }),
        randomBytesImpl: deterministicRandom,
        callbackTimeoutMs: 5000,
        consoleImpl: { log: () => {}, error: () => {} },
      }),
    ).rejects.toMatchObject({ code: "registration_failed" });
  });

  it("rejects with callback_timeout if the callback never arrives", async () => {
    const { serve } = fakeServe({});
    await expect(
      runHostedAuthFlow({
        apiUrl: FAKE_API,
        fetchImpl: fakeFetch({}),
        serveImpl: serve,
        openBrowserImpl: async () => ({ ok: true }),
        randomBytesImpl: deterministicRandom,
        callbackTimeoutMs: 50, // very short timeout
        consoleImpl: { log: () => {}, error: () => {} },
      }),
    ).rejects.toMatchObject({ code: "callback_timeout" });
  });
});

// ── runInit({ mode: "hosted" }) integration ───────────────────────────

describe("runInit --hosted (print-only)", () => {
  it("prints a JSON snippet with the hosted MCP URL and Bearer header", async () => {
    const { serve, controller } = fakeServe({});
    const cap = captureStdio();
    try {
      const pending = runInit({
        mode: "hosted",
        apiUrl: FAKE_API,
        fetchImpl: fakeFetch({}),
        serveImpl: serve,
        openBrowserImpl: async () => ({ ok: true }),
        randomBytesImpl: deterministicRandom,
        callbackTimeoutMs: 5000,
      });
      await new Promise((r) => setTimeout(r, 0));
      controller().invoke(new URLSearchParams({ code: "abc", state: EXPECTED_STATE }));
      const res = await pending;
      expect(res.exitCode).toBe(0);
      const out = cap.logs.join("\n");
      expect(out).toContain(`"url": "${FAKE_API}/mcp/ws_alpha/sse"`);
      expect(out).toContain('"Authorization": "Bearer ');
      // bunx form is for --local, not hosted.
      expect(out).not.toContain('"command": "bunx"');
    } finally {
      cap.restore();
    }
  });
});

describe("runInit --hosted --write", () => {
  it("merges the hosted server block into the configured client config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atlas-mcp-init-hosted-"));
    const target = join(dir, "claude_desktop_config.json");
    const { serve, controller } = fakeServe({});
    const cap = captureStdio();
    try {
      const pending = runInit({
        mode: "hosted",
        apiUrl: FAKE_API,
        client: "claude-desktop",
        write: true,
        configPathOverride: target,
        fetchImpl: fakeFetch({}),
        serveImpl: serve,
        openBrowserImpl: async () => ({ ok: true }),
        randomBytesImpl: deterministicRandom,
        callbackTimeoutMs: 5000,
      });
      await new Promise((r) => setTimeout(r, 0));
      controller().invoke(new URLSearchParams({ code: "abc", state: EXPECTED_STATE }));
      const res = await pending;
      expect(res.exitCode).toBe(0);
      const written = JSON.parse(readFileSync(target, "utf8"));
      expect(written.mcpServers.atlas.url).toBe(`${FAKE_API}/mcp/ws_alpha/sse`);
      expect(written.mcpServers.atlas.headers.Authorization).toMatch(/^Bearer /);
      // No local-style command — hosted is a remote server pointer.
      expect(written.mcpServers.atlas.command).toBeUndefined();
    } finally {
      cap.restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runInit --hosted --write — preserves siblings + writes .bak", () => {
  it("merges hosted server beside an existing one and backs up the prior config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atlas-mcp-init-hosted-merge-"));
    const target = join(dir, "claude_desktop_config.json");
    const existing = JSON.stringify(
      {
        mcpServers: { other: { command: "x", args: ["y"] } },
        unrelatedTopLevel: { keep: true },
      },
      null,
      2,
    );
    Bun.write(target, existing);
    const { serve, controller } = fakeServe({});
    const cap = captureStdio();
    try {
      const pending = runInit({
        mode: "hosted",
        apiUrl: FAKE_API,
        client: "claude-desktop",
        write: true,
        configPathOverride: target,
        fetchImpl: fakeFetch({}),
        serveImpl: serve,
        openBrowserImpl: async () => ({ ok: true }),
        randomBytesImpl: deterministicRandom,
        callbackTimeoutMs: 5000,
      });
      await new Promise((r) => setTimeout(r, 0));
      controller().invoke(new URLSearchParams({ code: "abc", state: EXPECTED_STATE }));
      const res = await pending;
      expect(res.exitCode).toBe(0);
      const written = JSON.parse(readFileSync(target, "utf8"));
      // Sibling server preserved.
      expect(written.mcpServers.other).toEqual({ command: "x", args: ["y"] });
      // Hosted block added.
      expect(written.mcpServers.atlas.url).toBe(`${FAKE_API}/mcp/ws_alpha/sse`);
      // Unrelated top-level keys preserved.
      expect(written.unrelatedTopLevel).toEqual({ keep: true });
      // .bak written.
      expect(readFileSync(`${target}.bak`, "utf8")).toBe(existing);
    } finally {
      cap.restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runInit --hosted default API URL (brand hostname)", () => {
  // The CLI default is the brand hostname so a user running
  // `bunx @useatlas/mcp init --hosted --write` against SaaS lands on
  // `https://mcp.useatlas.dev` without flag plumbing — the cosmetic
  // primary surface. Operators can still override with --api-url or
  // ATLAS_PUBLIC_API_URL when targeting a non-canonical region or
  // self-hosted Atlas.
  it("uses https://mcp.useatlas.dev when neither --api-url nor ATLAS_PUBLIC_API_URL is set", async () => {
    const cap = captureStdio();
    let discoveryHost = "";
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/.well-known/oauth-authorization-server")) {
        discoveryHost = new URL(url).origin;
        // Short-circuit with a 503 so the flow exits before opening
        // a browser or binding a loopback port; the assertion above
        // captures what we care about.
        return new Response("upstream unavailable", { status: 503 });
      }
      throw new Error(`unexpected fetch in default-URL test: ${url}`);
    }) as unknown as typeof fetch;
    try {
      const res = await runInit({
        mode: "hosted",
        env: {} as NodeJS.ProcessEnv,
        fetchImpl,
        serveImpl: fakeServe({}).serve,
        openBrowserImpl: async () => ({ ok: true }),
        randomBytesImpl: deterministicRandom,
        callbackTimeoutMs: 1000,
      });
      expect(res.exitCode).toBe(1);
      expect(discoveryHost).toBe("https://mcp.useatlas.dev");
    } finally {
      cap.restore();
    }
  });

  it("ATLAS_PUBLIC_API_URL still overrides the default for ops on non-canonical regions", async () => {
    const cap = captureStdio();
    let discoveryHost = "";
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/.well-known/oauth-authorization-server")) {
        discoveryHost = new URL(url).origin;
        return new Response("upstream unavailable", { status: 503 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;
    try {
      await runInit({
        mode: "hosted",
        env: { ATLAS_PUBLIC_API_URL: "https://api-eu.useatlas.dev" } as NodeJS.ProcessEnv,
        fetchImpl,
        serveImpl: fakeServe({}).serve,
        openBrowserImpl: async () => ({ ok: true }),
        randomBytesImpl: deterministicRandom,
        callbackTimeoutMs: 1000,
      });
      expect(discoveryHost).toBe("https://api-eu.useatlas.dev");
    } finally {
      cap.restore();
    }
  });
});

describe("runInit --hosted error mapping", () => {
  it("returns exitCode 1 with a HostedFlowError message on flow failure", async () => {
    const { serve, controller } = fakeServe({});
    const cap = captureStdio();
    try {
      const pending = runInit({
        mode: "hosted",
        apiUrl: FAKE_API,
        fetchImpl: fakeFetch({}),
        serveImpl: serve,
        openBrowserImpl: async () => ({ ok: true }),
        randomBytesImpl: deterministicRandom,
        callbackTimeoutMs: 5000,
      });
      await new Promise((r) => setTimeout(r, 0));
      // Wrong state — flow rejects.
      controller().invoke(new URLSearchParams({ code: "abc", state: "wrong" }));
      const res = await pending;
      expect(res.exitCode).toBe(1);
      const err = cap.errs.join("\n");
      expect(err).toContain("init --hosted");
      expect(err).toMatch(/state mismatch/i);
    } finally {
      cap.restore();
    }
  });
});

describe("runHostedAuthFlow — wire format header pinning", () => {
  // OAuth 2.1 §3.2.1 mandates the form-encoded body for the token endpoint.
  // A regression to `application/json` here would break interop with every
  // standards-compliant server. DCR is JSON-bodied; pin both directions so
  // a header swap can't slip through with the existing tests.
  it("DCR uses application/json + Accept: application/json", async () => {
    const { serve, controller } = fakeServe({});
    let dcrHeaders: Headers | null = null;
    const pending = runHostedAuthFlow({
      apiUrl: FAKE_API,
      fetchImpl: fakeFetch({
        registration: async (req: Request) => {
          dcrHeaders = req.headers;
          return new Response(JSON.stringify({ client_id: "cid" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      }),
      serveImpl: serve,
      openBrowserImpl: async () => ({ ok: true }),
      randomBytesImpl: deterministicRandom,
      callbackTimeoutMs: 5000,
      consoleImpl: { log: () => {}, error: () => {} },
    });
    await new Promise((r) => setTimeout(r, 0));
    controller().invoke(new URLSearchParams({ code: "x", state: EXPECTED_STATE }));
    await pending;
    expect(dcrHeaders).not.toBeNull();
    expect(dcrHeaders!.get("Content-Type")).toBe("application/json");
    expect(dcrHeaders!.get("Accept")).toBe("application/json");
  });

  it("token exchange uses application/x-www-form-urlencoded + Accept: application/json", async () => {
    const { serve, controller } = fakeServe({});
    let tokenHeaders: Headers | null = null;
    const pending = runHostedAuthFlow({
      apiUrl: FAKE_API,
      fetchImpl: fakeFetch({
        token: async (req: Request) => {
          tokenHeaders = req.headers;
          return new Response(
            JSON.stringify({
              access_token: jwt({
                sub: "u",
                iss: DISCOVERY_BODY.issuer,
                "https://atlas.useatlas.dev/workspace_id": "ws_alpha",
              }),
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        },
      }),
      serveImpl: serve,
      openBrowserImpl: async () => ({ ok: true }),
      randomBytesImpl: deterministicRandom,
      callbackTimeoutMs: 5000,
      consoleImpl: { log: () => {}, error: () => {} },
    });
    await new Promise((r) => setTimeout(r, 0));
    controller().invoke(new URLSearchParams({ code: "x", state: EXPECTED_STATE }));
    await pending;
    expect(tokenHeaders).not.toBeNull();
    expect(tokenHeaders!.get("Content-Type")).toBe("application/x-www-form-urlencoded");
    expect(tokenHeaders!.get("Accept")).toBe("application/json");
  });
});

describe("runHostedAuthFlow — malformed JWT discriminant", () => {
  it("rejects with malformed_jwt when access_token isn't a 3-part token", async () => {
    const { serve, controller } = fakeServe({});
    const pending = runHostedAuthFlow({
      apiUrl: FAKE_API,
      fetchImpl: fakeFetch({
        token: { access_token: "not-a-jwt" },
      }),
      serveImpl: serve,
      openBrowserImpl: async () => ({ ok: true }),
      randomBytesImpl: deterministicRandom,
      callbackTimeoutMs: 5000,
      consoleImpl: { log: () => {}, error: () => {} },
    });
    await new Promise((r) => setTimeout(r, 0));
    controller().invoke(new URLSearchParams({ code: "abc", state: EXPECTED_STATE }));
    await expect(pending).rejects.toMatchObject({ code: "malformed_jwt" });
  });

  it("rejects with malformed_jwt when payload base64 is not JSON", async () => {
    const { serve, controller } = fakeServe({});
    // Three parts, middle is base64url("not-json"), signature is junk.
    const middle = btoa("not-json").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const pending = runHostedAuthFlow({
      apiUrl: FAKE_API,
      fetchImpl: fakeFetch({
        token: { access_token: `header.${middle}.sig` },
      }),
      serveImpl: serve,
      openBrowserImpl: async () => ({ ok: true }),
      randomBytesImpl: deterministicRandom,
      callbackTimeoutMs: 5000,
      consoleImpl: { log: () => {}, error: () => {} },
    });
    await new Promise((r) => setTimeout(r, 0));
    controller().invoke(new URLSearchParams({ code: "abc", state: EXPECTED_STATE }));
    await expect(pending).rejects.toMatchObject({ code: "malformed_jwt" });
  });
});

describe("runInit --hosted --write failure path", () => {
  it("surfaces a write failure and leaves any existing config untouched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atlas-mcp-init-hosted-fail-"));
    // Pre-existing config we expect to survive the failed write.
    const target = join(dir, "claude_desktop_config.json");
    const original = `${JSON.stringify({ mcpServers: { existing: { command: "x", args: [] } } }, null, 2)}\n`;
    writeFileSync(target, original, { encoding: "utf8" });
    // Make the directory read-only so the tmp write fails. POSIX-only —
    // skip on win32 where chmod permission bits aren't enforced.
    if (process.platform === "win32") return;
    chmodSync(dir, 0o500);
    const { serve, controller } = fakeServe({});
    const cap = captureStdio();
    try {
      const pending = runInit({
        mode: "hosted",
        apiUrl: FAKE_API,
        client: "claude-desktop",
        write: true,
        configPathOverride: target,
        fetchImpl: fakeFetch({}),
        serveImpl: serve,
        openBrowserImpl: async () => ({ ok: true }),
        randomBytesImpl: deterministicRandom,
        callbackTimeoutMs: 5000,
      });
      await new Promise((r) => setTimeout(r, 0));
      controller().invoke(new URLSearchParams({ code: "abc", state: EXPECTED_STATE }));
      const res = await pending;
      expect(res.exitCode).toBe(1);
      const err = cap.errs.join("\n");
      expect(err).toMatch(/failed to write/);
      expect(err).toMatch(/not modified/);
      // Original content survives — atomic-write guarantee.
      expect(readFileSync(target, "utf8")).toBe(original);
    } finally {
      cap.restore();
      // Restore perms so the tmpdir cleanup succeeds.
      chmodSync(dir, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces a directory-creation failure with the directory in the message", async () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "atlas-mcp-init-hosted-mkdir-"));
    // Write a regular file where we want to create a subdirectory — the
    // recursive mkdir will fail with ENOTDIR.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "");
    const target = join(blocker, "child", "claude_desktop_config.json");
    const { serve, controller } = fakeServe({});
    const cap = captureStdio();
    try {
      const pending = runInit({
        mode: "hosted",
        apiUrl: FAKE_API,
        client: "claude-desktop",
        write: true,
        configPathOverride: target,
        fetchImpl: fakeFetch({}),
        serveImpl: serve,
        openBrowserImpl: async () => ({ ok: true }),
        randomBytesImpl: deterministicRandom,
        callbackTimeoutMs: 5000,
      });
      await new Promise((r) => setTimeout(r, 0));
      controller().invoke(new URLSearchParams({ code: "abc", state: EXPECTED_STATE }));
      const res = await pending;
      expect(res.exitCode).toBe(1);
      const err = cap.errs.join("\n");
      expect(err).toMatch(/Could not create config directory/);
    } finally {
      cap.restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Real Bun.serve integration: once-fired listener guard ──────────────
//
// The `defaultServeImpl` once-fired flag and 404-for-everything-else
// branches live inside Bun.serve's `fetch` callback — they aren't reachable
// through the `fakeServe` test seam used elsewhere. Bind a real port (port
// 0 → OS-assigned) and exercise the guards directly.

describe("defaultServeImpl — single-shot listener guard", () => {
  it("invokes the handler once, returns 404 on subsequent /callback requests, and 404s non-callback paths", async () => {
    let calls = 0;
    const handler: LoopbackHandler = (params) => {
      calls += 1;
      return { status: 200, body: `ok:${params.get("code") ?? ""}` };
    };
    const server = await defaultServeImpl(handler);
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const first = await fetch(`${base}/callback?code=abc&state=xyz`);
      expect(first.status).toBe(200);
      expect(await first.text()).toBe("ok:abc");
      // Replay — the handler MUST NOT run again.
      const second = await fetch(`${base}/callback?code=abc&state=xyz`);
      expect(second.status).toBe(404);
      // Non-callback path is also 404 and never reaches the handler.
      const stray = await fetch(`${base}/anything-else`);
      expect(stray.status).toBe(404);
      expect(calls).toBe(1);
    } finally {
      await server.stop();
    }
  });
});

