import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Mock handler module so we don't hit real DB / auth
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

const { executeJiraCreate, createJiraTicket, textToADF, toJiraCredentials } = await import(
  "@atlas/api/lib/tools/actions/jira"
);

/**
 * A complete credential set. Since #3766 `executeJiraCreate` takes credentials
 * as an ARGUMENT and never reads `process.env` — the resolver owns the
 * workspace → self-host-env ladder — so these tests build the set directly
 * rather than staging env vars.
 */
function creds(overrides: Record<string, string | undefined> = {}) {
  return {
    JIRA_BASE_URL: "https://test.atlassian.net",
    JIRA_EMAIL: "test@example.com",
    JIRA_API_TOKEN: "tok-123",
    ...overrides,
  } as Parameters<typeof executeJiraCreate>[1];
}

// ---------------------------------------------------------------------------
// Env snapshot + fetch mock
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  "JIRA_BASE_URL",
  "JIRA_EMAIL",
  "JIRA_API_TOKEN",
  "JIRA_DEFAULT_PROJECT",
] as const;

const saved: Record<string, string | undefined> = {};
const originalFetch = globalThis.fetch;

let capturedFetchUrl = "";
let capturedFetchInit: RequestInit | undefined;

function installFetchMock(
  response: { status: number; body: unknown },
) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    capturedFetchUrl = typeof input === "string" ? input : (input as Request).url;
    capturedFetchInit = init;
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}

function installFetchMockRaw(
  response: { status: number; text: string },
) {
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

describe("createJiraTicket — metadata", () => {
  it("has the correct actionType", () => {
    expect(createJiraTicket.actionType).toBe("jira:create");
  });

  it("is reversible", () => {
    expect(createJiraTicket.reversible).toBe(true);
  });

  it("defaults to manual approval", () => {
    expect(createJiraTicket.defaultApproval).toBe("manual");
  });

  it("declares no global required credentials (#3766 — they are per-workspace)", () => {
    // `validateActionCredentials()` checks this list against the GLOBAL
    // process.env, a question that has no meaningful answer for a
    // per-workspace target. Configuration status lives on the workspace Admin
    // surface (`getActionTargetStatus`) instead.
    expect(createJiraTicket.requiredCredentials).toEqual([]);
  });

  it("has a name", () => {
    expect(createJiraTicket.name).toBe("createJiraTicket");
  });

  it("has a description", () => {
    expect(createJiraTicket.description).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// textToADF — Atlassian Document Format helper
// ---------------------------------------------------------------------------

describe("textToADF", () => {
  it("splits multi-paragraph text into separate paragraph nodes", () => {
    const doc = textToADF("Para1\n\nPara2\n\nPara3");
    expect(doc.type).toBe("doc");
    expect(doc.version).toBe(1);
    expect(doc.content).toHaveLength(3);
    expect(doc.content[0].content[0].text).toBe("Para1");
    expect(doc.content[1].content[0].text).toBe("Para2");
    expect(doc.content[2].content[0].text).toBe("Para3");
  });

  it("returns fallback for empty text", () => {
    const doc = textToADF("");
    expect(doc.content).toHaveLength(1);
    expect(doc.content[0].content[0].text).toBe("(no description)");
  });

  it("returns fallback for whitespace-only text", () => {
    const doc = textToADF("   \n\n   ");
    expect(doc.content).toHaveLength(1);
    expect(doc.content[0].content[0].text).toBe("(no description)");
  });

  it("produces no empty paragraph nodes from trailing newlines", () => {
    const doc = textToADF("Hello\n\n\n\n");
    for (const node of doc.content) {
      expect(node.content[0].text.trim().length).toBeGreaterThan(0);
    }
    expect(doc.content).toHaveLength(1);
    expect(doc.content[0].content[0].text).toBe("Hello");
  });

  it("does not split on single newlines", () => {
    const doc = textToADF("Line1\nLine2");
    expect(doc.content).toHaveLength(1);
    expect(doc.content[0].content[0].text).toBe("Line1\nLine2");
  });
});

// ---------------------------------------------------------------------------
// executeJiraCreate — raw API call
// ---------------------------------------------------------------------------

describe("executeJiraCreate", () => {
  it("throws when no project is specified and the credential set carries no default", async () => {
    await expect(
      executeJiraCreate(
        {
          summary: "Test",
          description: "Test desc",
        },
        creds(),
      ),
    ).rejects.toThrow("No JIRA project specified");
  });

  it("reads no JIRA_* env var, even when every one of them is set", async () => {
    // The regression #3766 fixes: a tenant's action must never pick up the
    // deployment's globals. `executeJiraCreate` is credential-agnostic now, so
    // the operator env below must be invisible to it.
    process.env.JIRA_BASE_URL = "https://operator.atlassian.net";
    process.env.JIRA_EMAIL = "operator@atlas.dev";
    process.env.JIRA_API_TOKEN = "operator-token";
    process.env.JIRA_DEFAULT_PROJECT = "OPS";

    installFetchMock({ status: 201, body: { key: "TENANT-1", self: "..." } });

    const result = await executeJiraCreate(
      { summary: "Test", description: "Desc" },
      creds({
        JIRA_BASE_URL: "https://tenant.atlassian.net",
        JIRA_EMAIL: "admin@tenant.example",
        JIRA_API_TOKEN: "tenant-token",
        JIRA_DEFAULT_PROJECT: "TEN",
      }),
    );

    expect(capturedFetchUrl).toBe("https://tenant.atlassian.net/rest/api/3/issue");
    const auth = (capturedFetchInit?.headers as Record<string, string>)?.Authorization;
    expect(auth).toBe(
      `Basic ${Buffer.from("admin@tenant.example:tenant-token").toString("base64")}`,
    );
    expect(auth).not.toContain(
      Buffer.from("operator@atlas.dev:operator-token").toString("base64"),
    );
    const body = JSON.parse(capturedFetchInit?.body as string);
    expect(body.fields.project.key).toBe("TEN");
    expect(result.url).toBe("https://tenant.atlassian.net/browse/TENANT-1");
  });

  it("calls the correct JIRA API endpoint with Basic auth", async () => {

    installFetchMock({
      status: 201,
      body: { key: "PROJ-42", self: "https://test.atlassian.net/rest/api/3/issue/12345" },
    });

    const result = await executeJiraCreate(
      {
        summary: "Bug report",
        description: "Something is broken",
        project: "PROJ",
        labels: ["bug", "urgent"],
      },
      creds(),
    );

    expect(capturedFetchUrl).toBe("https://test.atlassian.net/rest/api/3/issue");
    expect(capturedFetchInit?.method).toBe("POST");

    // Check Basic auth header
    const expectedAuth = Buffer.from("test@example.com:tok-123").toString("base64");
    expect((capturedFetchInit?.headers as Record<string, string>)?.Authorization).toBe(
      `Basic ${expectedAuth}`,
    );

    // Check body includes project, summary, labels
    const body = JSON.parse(capturedFetchInit?.body as string);
    expect(body.fields.project.key).toBe("PROJ");
    expect(body.fields.summary).toBe("Bug report");
    expect(body.fields.labels).toEqual(["bug", "urgent"]);

    // Check description is ADF format
    expect(body.fields.description.type).toBe("doc");
    expect(body.fields.description.version).toBe(1);

    // Check result
    expect(result.key).toBe("PROJ-42");
    expect(result.url).toBe("https://test.atlassian.net/browse/PROJ-42");
  });

  it("falls back to the credential set's default project when none is provided", async () => {
    installFetchMock({
      status: 201,
      body: { key: "DEFAULT-1", self: "..." },
    });

    await executeJiraCreate(
      {
        summary: "Test",
        description: "Desc",
      },
      creds({ JIRA_DEFAULT_PROJECT: "DEFAULT" }),
    );

    const body = JSON.parse(capturedFetchInit?.body as string);
    expect(body.fields.project.key).toBe("DEFAULT");
  });

  it("throws on API error without exposing secrets", async () => {

    installFetchMock({
      status: 400,
      body: { errorMessages: ["Project 'BAD' does not exist."], errors: {} },
    });

    try {
      await executeJiraCreate(
        {
          summary: "Test",
          description: "Desc",
          project: "BAD",
        },
        creds(),
      );
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("JIRA API error");
      expect(message).toContain("does not exist");
      // Must not contain secrets
      expect(message).not.toContain("tok-123");
      expect(message).not.toContain("test@example.com");
    }
  });

  it("handles non-JSON error responses", async () => {

    installFetchMockRaw({ status: 500, text: "Internal Server Error" });

    await expect(
      executeJiraCreate({ summary: "Test", description: "Desc", project: "PROJ" }, creds()),
    ).rejects.toThrow("HTTP 500");
  });

  it("omits labels field when no labels provided", async () => {

    installFetchMock({
      status: 201,
      body: { key: "PROJ-1", self: "..." },
    });

    await executeJiraCreate(
      {
        summary: "Test",
        description: "Desc",
        project: "PROJ",
      },
      creds(),
    );

    const body = JSON.parse(capturedFetchInit?.body as string);
    expect(body.fields.labels).toBeUndefined();
  });

  it("toJiraCredentials rejects a partial set and names only the missing KEYS", () => {
    try {
      toJiraCredentials({ JIRA_BASE_URL: "https://test.atlassian.net", JIRA_API_TOKEN: "tok-123" });
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("JIRA_EMAIL");
      // Names, never values — the message must not echo a credential.
      expect(message).not.toContain("tok-123");
      expect(message).not.toContain("test.atlassian.net");
    }
  });

  it("throws when success response is not valid JSON", async () => {

    // Return 201 but with invalid JSON body
    globalThis.fetch = (async () => {
      return new Response("not json", {
        status: 201,
        headers: { "Content-Type": "text/plain" },
      });
    }) as unknown as typeof globalThis.fetch;

    await expect(
      executeJiraCreate({ summary: "Test", description: "Desc", project: "PROJ" }, creds()),
    ).rejects.toThrow("response could not be parsed");
  });

  it("throws when success response is missing key field", async () => {

    installFetchMock({
      status: 201,
      body: { id: "12345", self: "https://test.atlassian.net/rest/api/3/issue/12345" },
    });

    await expect(
      executeJiraCreate({ summary: "Test", description: "Desc", project: "PROJ" }, creds()),
    ).rejects.toThrow("response could not be parsed");
  });

  it("strips trailing slash from base URL", async () => {

    installFetchMock({
      status: 201,
      body: { key: "PROJ-1", self: "..." },
    });

    const result = await executeJiraCreate(
      {
        summary: "Test",
        description: "Desc",
        project: "PROJ",
      },
      creds({ JIRA_BASE_URL: "https://test.atlassian.net/" }),
    );

    expect(capturedFetchUrl).toBe("https://test.atlassian.net/rest/api/3/issue");
    expect(result.url).toBe("https://test.atlassian.net/browse/PROJ-1");
  });
});

// ---------------------------------------------------------------------------
// Tool execute — integration with handleAction
// ---------------------------------------------------------------------------

describe("createJiraTicket — tool execute", () => {
  it("calls handleAction with correct actionType and payload", async () => {
    // The env default must NOT decide the approval card's target since #3766 —
    // the default project is per-workspace and resolves at execution time.
    process.env.JIRA_DEFAULT_PROJECT = "FALLBACK";

    const aiTool = createJiraTicket.tool as unknown as {
      execute: (args: unknown, options: unknown) => Promise<unknown>;
    };

    await aiTool.execute(
      { summary: "Test issue", description: "Details here" },
      { toolCallId: "test-call", messages: [], abortSignal: undefined as unknown as AbortSignal },
    );

    expect(lastHandleActionCall).not.toBeNull();
    const request = lastHandleActionCall!.request as Record<string, unknown>;
    expect(request.actionType).toBe("jira:create");
    expect(request.target).toBe("(workspace default project)");
    expect(request.target).not.toBe("FALLBACK");
    expect(request.reversible).toBe(true);
    expect((request.payload as Record<string, unknown>).summary).toBe("Test issue");
  });

  it("uses the explicit project as the approval-card target when provided", async () => {
    process.env.JIRA_DEFAULT_PROJECT = "FALLBACK";

    const aiTool = createJiraTicket.tool as unknown as {
      execute: (args: unknown, options: unknown) => Promise<unknown>;
    };

    await aiTool.execute(
      { summary: "Explicit project", description: "Details", project: "EXPLICIT" },
      { toolCallId: "test-call-2", messages: [], abortSignal: undefined as unknown as AbortSignal },
    );

    expect(lastHandleActionCall).not.toBeNull();
    const request = lastHandleActionCall!.request as Record<string, unknown>;
    expect(request.target).toBe("EXPLICIT");
    expect((request.payload as Record<string, unknown>).project).toBe("EXPLICIT");
  });
});
