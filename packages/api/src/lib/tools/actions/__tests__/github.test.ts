/**
 * GitHub App action tests (#5555).
 *
 * Mirrors `jira.test.ts` in shape, and carries the two things that are new
 * about this target: it authenticates as a GitHub App (so a token is MINTED
 * per call rather than sent straight through), and one of its credential
 * fields is a multi-line PEM. Both are places a secret could escape into a
 * message, a log or a URL, so they are pinned rather than assumed.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { generateKeyPairSync } from "node:crypto";

// ---------------------------------------------------------------------------
// Mocks — handler (no DB / auth) and the installation-token minter (no network)
// ---------------------------------------------------------------------------

let lastHandleActionCall: { request: unknown; executeFn: unknown } | null = null;

void mock.module("@atlas/api/lib/tools/actions/handler", () => ({
  buildActionRequest: (params: Record<string, unknown>) => ({
    id: "test-action-id",
    ...params,
  }),
  handleAction: async (request: unknown, executeFn: unknown) => {
    lastHandleActionCall = { request, executeFn };
    return { status: "pending", actionId: "test-action-id", summary: "test" };
  },
}));

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

/** Records what the action asked the minter for, so we can assert on it. */
let mintCalls: Array<{
  installationId: string;
  appId?: string;
  privateKey?: string;
}> = [];
let mintImpl: () => Promise<string> = async () => "ghs_installation_token";

void mock.module("@atlas/api/lib/github/installation-token", () => ({
  getGitHubInstallationToken: async (
    installationId: string,
    deps: { appId?: string; privateKey?: string },
  ) => {
    mintCalls.push({
      installationId,
      // Spread on presence: both are exact optionals on the capture, and a call
      // that supplied neither must record their absence, not an `undefined`
      // (#5522).
      ...(deps?.appId !== undefined ? { appId: deps.appId } : {}),
      ...(deps?.privateKey !== undefined ? { privateKey: deps.privateKey } : {}),
    });
    return mintImpl();
  },
}));

const {
  executeGitHubIssueCreate,
  createGitHubIssue,
  normalizeAppPrivateKey,
} = await import("@atlas/api/lib/tools/actions/github");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A real RSA key so the PKCS#1 → PKCS#8 conversion is actually exercised. */
const { privateKey: PKCS8_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
/** The same key in the PKCS#1 encoding GitHub's download button produces. */
const { privateKey: PKCS1_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});

function creds(overrides: Record<string, string | undefined> = {}) {
  return {
    GITHUB_ACTION_APP_ID: "111111",
    GITHUB_ACTION_INSTALLATION_ID: "222222",
    GITHUB_ACTION_PRIVATE_KEY: PKCS8_KEY,
    ...overrides,
  } as Parameters<typeof executeGitHubIssueCreate>[1];
}

// ---------------------------------------------------------------------------
// Env snapshot + fetch mock
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  "GITHUB_ACTION_APP_ID",
  "GITHUB_ACTION_INSTALLATION_ID",
  "GITHUB_ACTION_PRIVATE_KEY",
  "GITHUB_ACTION_DEFAULT_REPO",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
] as const;

const saved: Record<string, string | undefined> = {};
const originalFetch = globalThis.fetch;

let capturedFetchUrl = "";
let capturedFetchInit: RequestInit | undefined;

function installFetchMock(response: { status: number; body: unknown }) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    capturedFetchUrl = typeof input === "string" ? input : (input as Request).url;
    capturedFetchInit = init;
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}

function installFetchMockRaw(response: { status: number; text: string }) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    capturedFetchUrl = typeof input === "string" ? input : (input as Request).url;
    return new Response(response.text, { status: response.status });
  }) as typeof globalThis.fetch;
}

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  lastHandleActionCall = null;
  capturedFetchUrl = "";
  capturedFetchInit = undefined;
  mintCalls = [];
  mintImpl = async () => "ghs_installation_token";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of ENV_KEYS) {
    if (saved[key] !== undefined) process.env[key] = saved[key];
    else delete process.env[key];
  }
});

// ---------------------------------------------------------------------------
// AtlasAction metadata
// ---------------------------------------------------------------------------

describe("createGitHubIssue — metadata", () => {
  it("has the correct actionType", () => {
    expect(createGitHubIssue.actionType).toBe("github:create_issue");
  });

  it("is reversible", () => {
    expect(createGitHubIssue.reversible).toBe(true);
  });

  it("defaults to manual approval — parity with createJiraTicket", () => {
    expect(createGitHubIssue.defaultApproval).toBe("manual");
  });

  it("declares no global required credentials (they are per-workspace)", () => {
    expect(createGitHubIssue.requiredCredentials).toEqual([]);
  });

  it("has a name and a description", () => {
    expect(createGitHubIssue.name).toBe("createGitHubIssue");
    expect(createGitHubIssue.description).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// normalizeAppPrivateKey — the PEM half of the #5555 shape question
// ---------------------------------------------------------------------------

describe("normalizeAppPrivateKey", () => {
  it("passes a PKCS#8 key through as PKCS#8", () => {
    expect(normalizeAppPrivateKey(PKCS8_KEY)).toContain("BEGIN PRIVATE KEY");
  });

  it("converts GitHub's PKCS#1 download to PKCS#8", () => {
    // The workspace admin pastes what GitHub gave them; asking them to run
    // `openssl pkcs8` first is a support ticket, not a product.
    expect(PKCS1_KEY).toContain("BEGIN RSA PRIVATE KEY");
    expect(normalizeAppPrivateKey(PKCS1_KEY)).toContain("BEGIN PRIVATE KEY");
  });

  it("un-escapes a `\\n`-flattened key from a single-line .env value", () => {
    const flattened = PKCS8_KEY.replace(/\n/g, "\\n");
    expect(flattened).not.toContain("\n");
    expect(normalizeAppPrivateKey(flattened)).toContain("BEGIN PRIVATE KEY");
  });

  it("leaves a real multi-line key alone rather than rewriting inside it", () => {
    expect(normalizeAppPrivateKey(PKCS8_KEY)).toBe(
      normalizeAppPrivateKey(PKCS8_KEY.replace(/\n/g, "\\n")),
    );
  });

  it("throws on an unreadable key without echoing any of it", () => {
    try {
      normalizeAppPrivateKey("-----BEGIN PRIVATE KEY-----\nsUpErS3cret\n-----END PRIVATE KEY-----");
      expect.unreachable("a malformed PEM must not be accepted");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("not a readable PEM");
      // The payload of a PEM IS the secret — a parser message that quoted the
      // input would put it in the log and in action_log.error.
      expect(message).not.toContain("sUpErS3cret");
    }
  });
});

// ---------------------------------------------------------------------------
// executeGitHubIssueCreate — raw API call
// ---------------------------------------------------------------------------

describe("executeGitHubIssueCreate", () => {
  it("throws when no repo is given and the credential set carries no default", async () => {
    await expect(
      executeGitHubIssueCreate({ title: "T", body: "B" }, creds()),
    ).rejects.toThrow("No GitHub repository specified");
  });

  it("posts to the right repo with the minted installation token", async () => {
    installFetchMock({
      status: 201,
      body: { number: 42, html_url: "https://github.com/acme/platform/issues/42" },
    });

    const result = await executeGitHubIssueCreate(
      { title: "Bug report", body: "Something is broken", repo: "acme/platform", labels: ["bug"] },
      creds(),
    );

    expect(capturedFetchUrl).toBe("https://api.github.com/repos/acme/platform/issues");
    expect(capturedFetchInit?.method).toBe("POST");
    const headers = capturedFetchInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer ghs_installation_token");

    const body = JSON.parse(capturedFetchInit?.body as string);
    expect(body.title).toBe("Bug report");
    expect(body.labels).toEqual(["bug"]);

    expect(result.number).toBe(42);
    expect(result.repo).toBe("acme/platform");
    expect(result.url).toBe("https://github.com/acme/platform/issues/42");
  });

  it("mints with the WORKSPACE's App, never letting the minter default to operator env", async () => {
    // The regression this target could have shipped: `getGitHubInstallationToken`
    // falls back to GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY when either dep is
    // absent, so an omitted argument would file the tenant's issue as Atlas.
    process.env.GITHUB_APP_ID = "999999";
    process.env.GITHUB_APP_PRIVATE_KEY = "operator-key";

    installFetchMock({ status: 201, body: { number: 1, html_url: "https://github.com/t/r/issues/1" } });
    await executeGitHubIssueCreate({ title: "T", body: "B", repo: "t/r" }, creds());

    expect(mintCalls).toHaveLength(1);
    expect(mintCalls[0].installationId).toBe("222222");
    expect(mintCalls[0].appId).toBe("111111");
    expect(mintCalls[0].appId).not.toBe("999999");
    // Passed explicitly, and normalized on the way — never undefined, which is
    // the value that would open the env fallback.
    expect(mintCalls[0].privateKey).toBeTruthy();
    expect(mintCalls[0].privateKey).toContain("BEGIN PRIVATE KEY");
    expect(mintCalls[0].privateKey).not.toBe("operator-key");
  });

  it("reads no GITHUB_* env var, even when every one of them is set", async () => {
    for (const key of ENV_KEYS) process.env[key] = "operator-value";
    process.env.GITHUB_ACTION_DEFAULT_REPO = "operator/repo";

    installFetchMock({ status: 201, body: { number: 7, html_url: "https://github.com/tenant/app/issues/7" } });

    const result = await executeGitHubIssueCreate(
      { title: "T", body: "B" },
      creds({ GITHUB_ACTION_DEFAULT_REPO: "tenant/app" }),
    );

    expect(capturedFetchUrl).toBe("https://api.github.com/repos/tenant/app/issues");
    expect(capturedFetchUrl).not.toContain("operator");
    expect(result.repo).toBe("tenant/app");
  });

  it("falls back to the credential set's default repo when none is provided", async () => {
    installFetchMock({ status: 201, body: { number: 3, html_url: "https://github.com/acme/default/issues/3" } });
    await executeGitHubIssueCreate(
      { title: "T", body: "B" },
      creds({ GITHUB_ACTION_DEFAULT_REPO: "acme/default" }),
    );
    expect(capturedFetchUrl).toBe("https://api.github.com/repos/acme/default/issues");
  });

  it("rejects a repo that is not owner/repo rather than building an injecting URL", async () => {
    installFetchMock({ status: 201, body: { number: 1 } });
    for (const bad of ["../../secrets", "owner/repo/extra", "owner repo", "owner/repo?x=1", "owner"]) {
      await expect(
        executeGitHubIssueCreate({ title: "T", body: "B", repo: bad }, creds()),
      ).rejects.toThrow("owner/repo form");
    }
    // Nothing reached the network, and nothing was minted for a bad repo.
    expect(capturedFetchUrl).toBe("");
    expect(mintCalls).toHaveLength(0);
  });

  it("throws on API error without exposing the key or the minted token", async () => {
    installFetchMock({
      status: 422,
      body: {
        message: "Validation Failed",
        errors: [{ resource: "Issue", field: "title", code: "missing_field" }],
      },
    });

    try {
      await executeGitHubIssueCreate({ title: "T", body: "B", repo: "acme/platform" }, creds());
      expect.unreachable("a 422 must throw");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("GitHub API error");
      expect(message).toContain("Validation Failed");
      expect(message).toContain("title: missing_field");
      expect(message).not.toContain("ghs_installation_token");
      expect(message).not.toContain("BEGIN PRIVATE KEY");
    }
  });

  it("handles non-JSON error responses", async () => {
    installFetchMockRaw({ status: 500, text: "Internal Server Error" });
    await expect(
      executeGitHubIssueCreate({ title: "T", body: "B", repo: "acme/platform" }, creds()),
    ).rejects.toThrow("HTTP 500");
  });

  it("omits labels when none are provided", async () => {
    installFetchMock({ status: 201, body: { number: 1, html_url: "https://github.com/a/b/issues/1" } });
    await executeGitHubIssueCreate({ title: "T", body: "B", repo: "a/b" }, creds());
    expect(JSON.parse(capturedFetchInit?.body as string).labels).toBeUndefined();
  });

  it("falls back to the canonical issue URL when GitHub omits html_url", async () => {
    installFetchMock({ status: 201, body: { number: 9 } });
    const result = await executeGitHubIssueCreate({ title: "T", body: "B", repo: "a/b" }, creds());
    expect(result.url).toBe("https://github.com/a/b/issues/9");
  });

  it("throws when the success response carries no issue number", async () => {
    installFetchMock({ status: 201, body: { html_url: "https://github.com/a/b/issues/1" } });
    await expect(
      executeGitHubIssueCreate({ title: "T", body: "B", repo: "a/b" }, creds()),
    ).rejects.toThrow("response could not be parsed");
  });

  it("propagates a mint failure rather than filing the issue unauthenticated", async () => {
    mintImpl = async () => {
      throw new Error("GitHub rejected the installation-token request (HTTP 401).");
    };
    installFetchMock({ status: 201, body: { number: 1 } });

    await expect(
      executeGitHubIssueCreate({ title: "T", body: "B", repo: "a/b" }, creds()),
    ).rejects.toThrow("installation-token");
    expect(capturedFetchUrl).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Tool execute — integration with handleAction (the approval queue)
// ---------------------------------------------------------------------------

describe("createGitHubIssue — tool execute", () => {
  it("pends through handleAction with the right actionType and payload", async () => {
    // The env default must not decide the approval card's target — the repo is
    // per-workspace and resolves at execution time.
    process.env.GITHUB_ACTION_DEFAULT_REPO = "operator/fallback";

    const aiTool = createGitHubIssue.tool as unknown as {
      execute: (args: unknown, options: unknown) => Promise<unknown>;
    };

    await aiTool.execute(
      { title: "Test issue", body: "Details here" },
      { toolCallId: "test-call", messages: [], abortSignal: undefined as unknown as AbortSignal },
    );

    expect(lastHandleActionCall).not.toBeNull();
    const request = lastHandleActionCall!.request as Record<string, unknown>;
    expect(request.actionType).toBe("github:create_issue");
    expect(request.target).toBe("(workspace default repository)");
    expect(request.target).not.toBe("operator/fallback");
    expect(request.reversible).toBe(true);
    expect((request.payload as Record<string, unknown>).title).toBe("Test issue");
  });

  it("uses the explicit repo as the approval-card target when provided", async () => {
    const aiTool = createGitHubIssue.tool as unknown as {
      execute: (args: unknown, options: unknown) => Promise<unknown>;
    };

    await aiTool.execute(
      { title: "Explicit repo", body: "Details", repo: "acme/platform" },
      { toolCallId: "test-call-2", messages: [], abortSignal: undefined as unknown as AbortSignal },
    );

    const request = lastHandleActionCall!.request as Record<string, unknown>;
    expect(request.target).toBe("acme/platform");
    expect((request.payload as Record<string, unknown>).repo).toBe("acme/platform");
  });

  it("the approval card's summary carries no credential", () => {
    // The card is rendered to an approver who may not be a workspace admin.
    const request = lastHandleActionCall?.request as Record<string, unknown> | undefined;
    expect(JSON.stringify(request ?? {})).not.toContain("BEGIN PRIVATE KEY");
  });
});
