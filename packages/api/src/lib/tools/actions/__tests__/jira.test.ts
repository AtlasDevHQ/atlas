import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Mock handler module so we don't hit real DB / auth
// ---------------------------------------------------------------------------

let lastHandleActionCall: { request: unknown; executeFn: unknown } | null = null;

mock.module("@atlas/api/lib/tools/actions/handler", () => ({
  buildActionRequest: (params: Record<string, unknown>) => ({
    id: "test-action-id",
    ...params,
  }),
  handleAction: async (request: unknown, executeFn: unknown) => {
    lastHandleActionCall = { request, executeFn };
    return { status: "pending_approval", actionId: "test-action-id", summary: "test" };
  },
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

const { executeJiraCreate, createJiraTicket, textToADF } = await import(
  "@atlas/api/lib/tools/actions/jira"
);

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

  it("requires JIRA credentials", () => {
    expect(createJiraTicket.requiredCredentials).toEqual([
      "JIRA_BASE_URL",
      "JIRA_EMAIL",
      "JIRA_API_TOKEN",
    ]);
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
  it("throws when JIRA credentials are missing", async () => {
    delete process.env.JIRA_BASE_URL;
    delete process.env.JIRA_EMAIL;
    delete process.env.JIRA_API_TOKEN;

    await expect(
      executeJiraCreate({
        summary: "Test",
        description: "Test desc",
        project: "PROJ",
      }),
    ).rejects.toThrow("Missing JIRA credentials");
  });

  it("throws when no project is specified and no default", async () => {
    process.env.JIRA_BASE_URL = "https://test.atlassian.net";
    process.env.JIRA_EMAIL = "test@example.com";
    process.env.JIRA_API_TOKEN = "tok-123";
    delete process.env.JIRA_DEFAULT_PROJECT;

    await expect(
      executeJiraCreate({
        summary: "Test",
        description: "Test desc",
      }),
    ).rejects.toThrow("No JIRA project specified");
  });

  it("calls the correct JIRA API endpoint with Basic auth", async () => {
    process.env.JIRA_BASE_URL = "https://test.atlassian.net";
    process.env.JIRA_EMAIL = "test@example.com";
    process.env.JIRA_API_TOKEN = "tok-123";

    installFetchMock({
      status: 201,
      body: { key: "PROJ-42", self: "https://test.atlassian.net/rest/api/3/issue/12345" },
    });

    const result = await executeJiraCreate({
      summary: "Bug report",
      description: "Something is broken",
      project: "PROJ",
      labels: ["bug", "urgent"],
    });

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

  it("falls back to JIRA_DEFAULT_PROJECT when project not provided", async () => {
    process.env.JIRA_BASE_URL = "https://test.atlassian.net";
    process.env.JIRA_EMAIL = "test@example.com";
    process.env.JIRA_API_TOKEN = "tok-123";
    process.env.JIRA_DEFAULT_PROJECT = "DEFAULT";

    installFetchMock({
      status: 201,
      body: { key: "DEFAULT-1", self: "..." },
    });

    await executeJiraCreate({
      summary: "Test",
      description: "Desc",
    });

    const body = JSON.parse(capturedFetchInit?.body as string);
    expect(body.fields.project.key).toBe("DEFAULT");
  });

  it("throws on API error without exposing secrets", async () => {
    process.env.JIRA_BASE_URL = "https://test.atlassian.net";
    process.env.JIRA_EMAIL = "test@example.com";
    process.env.JIRA_API_TOKEN = "tok-123";

    installFetchMock({
      status: 400,
      body: { errorMessages: ["Project 'BAD' does not exist."], errors: {} },
    });

    try {
      await executeJiraCreate({
        summary: "Test",
        description: "Desc",
        project: "BAD",
      });
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
    process.env.JIRA_BASE_URL = "https://test.atlassian.net";
    process.env.JIRA_EMAIL = "test@example.com";
    process.env.JIRA_API_TOKEN = "tok-123";

    installFetchMockRaw({ status: 500, text: "Internal Server Error" });

    await expect(
      executeJiraCreate({ summary: "Test", description: "Desc", project: "PROJ" }),
    ).rejects.toThrow("HTTP 500");
  });

  it("omits labels field when no labels provided", async () => {
    process.env.JIRA_BASE_URL = "https://test.atlassian.net";
    process.env.JIRA_EMAIL = "test@example.com";
    process.env.JIRA_API_TOKEN = "tok-123";

    installFetchMock({
      status: 201,
      body: { key: "PROJ-1", self: "..." },
    });

    await executeJiraCreate({
      summary: "Test",
      description: "Desc",
      project: "PROJ",
    });

    const body = JSON.parse(capturedFetchInit?.body as string);
    expect(body.fields.labels).toBeUndefined();
  });

  it("throws when only JIRA_BASE_URL is set (partial credentials)", async () => {
    process.env.JIRA_BASE_URL = "https://test.atlassian.net";
    delete process.env.JIRA_EMAIL;
    delete process.env.JIRA_API_TOKEN;

    await expect(
      executeJiraCreate({
        summary: "Test",
        description: "Desc",
        project: "PROJ",
      }),
    ).rejects.toThrow("Missing JIRA credentials");
  });

  it("throws when success response is not valid JSON", async () => {
    process.env.JIRA_BASE_URL = "https://test.atlassian.net";
    process.env.JIRA_EMAIL = "test@example.com";
    process.env.JIRA_API_TOKEN = "tok-123";

    // Return 201 but with invalid JSON body
    globalThis.fetch = (async () => {
      return new Response("not json", {
        status: 201,
        headers: { "Content-Type": "text/plain" },
      });
    }) as unknown as typeof globalThis.fetch;

    await expect(
      executeJiraCreate({ summary: "Test", description: "Desc", project: "PROJ" }),
    ).rejects.toThrow("response could not be parsed");
  });

  it("throws when success response is missing key field", async () => {
    process.env.JIRA_BASE_URL = "https://test.atlassian.net";
    process.env.JIRA_EMAIL = "test@example.com";
    process.env.JIRA_API_TOKEN = "tok-123";

    installFetchMock({
      status: 201,
      body: { id: "12345", self: "https://test.atlassian.net/rest/api/3/issue/12345" },
    });

    await expect(
      executeJiraCreate({ summary: "Test", description: "Desc", project: "PROJ" }),
    ).rejects.toThrow("response could not be parsed");
  });

  it("strips trailing slash from base URL", async () => {
    process.env.JIRA_BASE_URL = "https://test.atlassian.net/";
    process.env.JIRA_EMAIL = "test@example.com";
    process.env.JIRA_API_TOKEN = "tok-123";

    installFetchMock({
      status: 201,
      body: { key: "PROJ-1", self: "..." },
    });

    const result = await executeJiraCreate({
      summary: "Test",
      description: "Desc",
      project: "PROJ",
    });

    expect(capturedFetchUrl).toBe("https://test.atlassian.net/rest/api/3/issue");
    expect(result.url).toBe("https://test.atlassian.net/browse/PROJ-1");
  });
});

// ---------------------------------------------------------------------------
// Tool execute — integration with handleAction
// ---------------------------------------------------------------------------

describe("createJiraTicket — tool execute", () => {
  it("calls handleAction with correct actionType and payload", async () => {
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
    expect(request.target).toBe("FALLBACK");
    expect(request.reversible).toBe(true);
    expect((request.payload as Record<string, unknown>).summary).toBe("Test issue");
  });

  it("uses explicit project when provided instead of JIRA_DEFAULT_PROJECT", async () => {
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
