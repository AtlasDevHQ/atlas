import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { definePlugin, isActionPlugin } from "@useatlas/plugin-sdk";
import { jiraPlugin } from "../index";
import { textToADF, executeJiraCreate } from "../tool";

// ---------------------------------------------------------------------------
// Valid config fixture
// ---------------------------------------------------------------------------

const VALID_CONFIG = {
  host: "https://myco.atlassian.net",
  email: "bot@myco.com",
  apiToken: "test-token-123",
  projectKey: "ENG",
} as const;

const VALID_CONFIG_WITH_LABELS = {
  ...VALID_CONFIG,
  labels: ["atlas", "automated"],
};

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

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

beforeEach(() => {
  capturedFetchUrl = "";
  capturedFetchInit = undefined;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Plugin shape validation
// ---------------------------------------------------------------------------

describe("jiraPlugin — shape validation", () => {
  test("createPlugin() produces a valid AtlasActionPlugin", () => {
    const plugin = jiraPlugin(VALID_CONFIG);
    expect(plugin.id).toBe("jira-action");
    expect(plugin.type).toBe("action");
    expect(plugin.version).toBe("1.0.0");
    expect(plugin.name).toBe("JIRA Action");
    expect(Array.isArray(plugin.actions)).toBe(true);
    expect(plugin.actions).toHaveLength(1);
  });

  test("definePlugin() accepts the created plugin", () => {
    const plugin = jiraPlugin(VALID_CONFIG);
    const validated = definePlugin(plugin);
    expect(validated).toBe(plugin);
  });

  test("isActionPlugin type guard returns true", () => {
    const plugin = jiraPlugin(VALID_CONFIG);
    expect(isActionPlugin(plugin)).toBe(true);
  });

  test("config is stored on the plugin object", () => {
    const plugin = jiraPlugin(VALID_CONFIG);
    expect(plugin.config).toEqual(VALID_CONFIG);
  });

  test("config with labels is stored correctly", () => {
    const plugin = jiraPlugin(VALID_CONFIG_WITH_LABELS);
    expect(plugin.config?.labels).toEqual(["atlas", "automated"]);
  });
});

// ---------------------------------------------------------------------------
// Action metadata
// ---------------------------------------------------------------------------

describe("jiraPlugin — action metadata", () => {
  test("action has correct name", () => {
    const plugin = jiraPlugin(VALID_CONFIG);
    expect(plugin.actions[0].name).toBe("createJiraTicket");
  });

  test("action has correct actionType", () => {
    const plugin = jiraPlugin(VALID_CONFIG);
    expect(plugin.actions[0].actionType).toBe("jira:create");
  });

  test("action is reversible", () => {
    const plugin = jiraPlugin(VALID_CONFIG);
    expect(plugin.actions[0].reversible).toBe(true);
  });

  test("action defaults to manual approval", () => {
    const plugin = jiraPlugin(VALID_CONFIG);
    expect(plugin.actions[0].defaultApproval).toBe("manual");
  });

  test("action lists required credentials", () => {
    const plugin = jiraPlugin(VALID_CONFIG);
    expect(plugin.actions[0].requiredCredentials).toEqual(["host", "email", "apiToken"]);
  });

  test("action has a description", () => {
    const plugin = jiraPlugin(VALID_CONFIG);
    expect(plugin.actions[0].description).toBeTruthy();
    expect(plugin.actions[0].description).toContain("JIRA");
  });

  test("action has a tool", () => {
    const plugin = jiraPlugin(VALID_CONFIG);
    expect(plugin.actions[0].tool).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

describe("jiraPlugin — config validation", () => {
  test("rejects missing host", () => {
    expect(() =>
      jiraPlugin({ email: "a@b.com", apiToken: "t", projectKey: "X" } as never),
    ).toThrow("Plugin config validation failed");
  });

  test("rejects invalid host URL", () => {
    expect(() =>
      jiraPlugin({ ...VALID_CONFIG, host: "not-a-url" }),
    ).toThrow("Plugin config validation failed");
  });

  test("rejects missing email", () => {
    expect(() =>
      jiraPlugin({ host: "https://x.atlassian.net", apiToken: "t", projectKey: "X" } as never),
    ).toThrow("Plugin config validation failed");
  });

  test("rejects invalid email", () => {
    expect(() =>
      jiraPlugin({ ...VALID_CONFIG, email: "not-an-email" }),
    ).toThrow("Plugin config validation failed");
  });

  test("rejects empty apiToken", () => {
    expect(() =>
      jiraPlugin({ ...VALID_CONFIG, apiToken: "" }),
    ).toThrow("Plugin config validation failed");
  });

  test("rejects empty projectKey", () => {
    expect(() =>
      jiraPlugin({ ...VALID_CONFIG, projectKey: "" }),
    ).toThrow("Plugin config validation failed");
  });

  test("rejects lowercase projectKey", () => {
    expect(() =>
      jiraPlugin({ ...VALID_CONFIG, projectKey: "eng" }),
    ).toThrow("Plugin config validation failed");
  });

  test("accepts valid config", () => {
    expect(() => jiraPlugin(VALID_CONFIG)).not.toThrow();
  });

  test("accepts config with optional labels", () => {
    expect(() => jiraPlugin(VALID_CONFIG_WITH_LABELS)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tool parameters schema
// ---------------------------------------------------------------------------

describe("jiraPlugin — tool parameters", () => {
  test("tool has execute function", () => {
    const plugin = jiraPlugin(VALID_CONFIG);
    const aiTool = plugin.actions[0].tool as unknown as Record<string, unknown>;

    // AI SDK tools expose an execute function
    expect(typeof aiTool.execute).toBe("function");
  });

  test("tool execute calls JIRA API with correct payload", async () => {
    installFetchMock({
      status: 201,
      body: { key: "ENG-99", self: "..." },
    });

    const plugin = jiraPlugin(VALID_CONFIG);
    const aiTool = plugin.actions[0].tool as unknown as {
      execute: (args: unknown, options: unknown) => Promise<unknown>;
    };

    const result = await aiTool.execute(
      { summary: "Test issue", description: "Details here" },
      { toolCallId: "test-call", messages: [], abortSignal: undefined as unknown as AbortSignal },
    );

    expect(result).toBeDefined();
    expect((result as { key: string }).key).toBe("ENG-99");

    const body = JSON.parse(capturedFetchInit?.body as string);
    expect(body.fields.summary).toBe("Test issue");
    expect(body.fields.project.key).toBe("ENG");
  });

  test("tool execute uses explicit project when provided", async () => {
    installFetchMock({
      status: 201,
      body: { key: "OTHER-1", self: "..." },
    });

    const plugin = jiraPlugin(VALID_CONFIG);
    const aiTool = plugin.actions[0].tool as unknown as {
      execute: (args: unknown, options: unknown) => Promise<unknown>;
    };

    await aiTool.execute(
      { summary: "Test", description: "Desc", project: "OTHER", labels: ["bug"] },
      { toolCallId: "test-call-2", messages: [], abortSignal: undefined as unknown as AbortSignal },
    );

    const body = JSON.parse(capturedFetchInit?.body as string);
    expect(body.fields.project.key).toBe("OTHER");
    expect(body.fields.labels).toEqual(["bug"]);
  });
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

describe("jiraPlugin — healthCheck", () => {
  test("returns healthy when JIRA API responds 200", async () => {
    installFetchMock({
      status: 200,
      body: { accountId: "123", displayName: "Bot" },
    });

    const plugin = jiraPlugin(VALID_CONFIG);
    const result = await plugin.healthCheck!();

    expect(result.healthy).toBe(true);
    expect(result.latencyMs).toBeDefined();
    expect(capturedFetchUrl).toBe("https://myco.atlassian.net/rest/api/3/myself");

    // Verify Basic auth header
    const expectedAuth = Buffer.from("bot@myco.com:test-token-123").toString("base64");
    expect((capturedFetchInit?.headers as Record<string, string>)?.Authorization).toBe(
      `Basic ${expectedAuth}`,
    );
  });

  test("returns unhealthy when JIRA API responds 401", async () => {
    installFetchMock({
      status: 401,
      body: { message: "Unauthorized" },
    });

    const plugin = jiraPlugin(VALID_CONFIG);
    const result = await plugin.healthCheck!();

    expect(result.healthy).toBe(false);
    expect(result.message).toContain("401");
  });

  test("returns unhealthy on network error", async () => {
    globalThis.fetch = (() => {
      throw new Error("Network unreachable");
    }) as unknown as typeof globalThis.fetch;

    const plugin = jiraPlugin(VALID_CONFIG);
    const result = await plugin.healthCheck!();

    expect(result.healthy).toBe(false);
    expect(result.message).toContain("Network unreachable");
  });

  test("strips trailing slash from host in health check URL", async () => {
    installFetchMock({ status: 200, body: {} });

    const plugin = jiraPlugin({ ...VALID_CONFIG, host: "https://myco.atlassian.net/" });
    await plugin.healthCheck!();

    expect(capturedFetchUrl).toBe("https://myco.atlassian.net/rest/api/3/myself");
  });
});

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

describe("jiraPlugin — initialize", () => {
  test("calls logger.info with project key", async () => {
    const plugin = jiraPlugin(VALID_CONFIG);
    const logged: string[] = [];
    const mockCtx = {
      db: null,
      connections: { get: () => ({}), list: () => [] },
      tools: { register: () => {} },
      logger: {
        info: (msg: string) => logged.push(msg),
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      config: {},
    };

    await plugin.initialize!(mockCtx as never);
    expect(logged.some((m) => m.includes("ENG"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// textToADF (extracted helper)
// ---------------------------------------------------------------------------

describe("textToADF", () => {
  test("splits paragraphs on double newline", () => {
    const doc = textToADF("Para1\n\nPara2");
    expect(doc.content).toHaveLength(2);
    expect(doc.content[0].content[0].text).toBe("Para1");
    expect(doc.content[1].content[0].text).toBe("Para2");
  });

  test("returns fallback for empty text", () => {
    const doc = textToADF("");
    expect(doc.content[0].content[0].text).toBe("(no description)");
  });
});

// ---------------------------------------------------------------------------
// executeJiraCreate (config-driven)
// ---------------------------------------------------------------------------

describe("executeJiraCreate", () => {
  test("calls correct JIRA API endpoint", async () => {
    installFetchMock({
      status: 201,
      body: { key: "ENG-42", self: "https://myco.atlassian.net/rest/api/3/issue/123" },
    });

    const result = await executeJiraCreate(VALID_CONFIG, {
      summary: "Bug report",
      description: "Something is broken",
    });

    expect(capturedFetchUrl).toBe("https://myco.atlassian.net/rest/api/3/issue");
    expect(capturedFetchInit?.method).toBe("POST");
    expect(result.key).toBe("ENG-42");
    expect(result.url).toBe("https://myco.atlassian.net/browse/ENG-42");
  });

  test("uses explicit project over config default", async () => {
    installFetchMock({
      status: 201,
      body: { key: "OTHER-1", self: "..." },
    });

    await executeJiraCreate(VALID_CONFIG, {
      summary: "Test",
      description: "Desc",
      project: "OTHER",
    });

    const body = JSON.parse(capturedFetchInit?.body as string);
    expect(body.fields.project.key).toBe("OTHER");
  });

  test("uses config labels when no per-call labels provided", async () => {
    installFetchMock({
      status: 201,
      body: { key: "ENG-1", self: "..." },
    });

    await executeJiraCreate(VALID_CONFIG_WITH_LABELS, {
      summary: "Test",
      description: "Desc",
    });

    const body = JSON.parse(capturedFetchInit?.body as string);
    expect(body.fields.labels).toEqual(["atlas", "automated"]);
  });

  test("per-call labels override config labels", async () => {
    installFetchMock({
      status: 201,
      body: { key: "ENG-1", self: "..." },
    });

    await executeJiraCreate(VALID_CONFIG_WITH_LABELS, {
      summary: "Test",
      description: "Desc",
      labels: ["urgent"],
    });

    const body = JSON.parse(capturedFetchInit?.body as string);
    expect(body.fields.labels).toEqual(["urgent"]);
  });

  test("throws on API error", async () => {
    installFetchMock({
      status: 400,
      body: { errorMessages: ["Project 'BAD' does not exist."], errors: {} },
    });

    await expect(
      executeJiraCreate(VALID_CONFIG, {
        summary: "Test",
        description: "Desc",
        project: "BAD",
      }),
    ).rejects.toThrow("JIRA API error");
  });

  test("error does not expose credentials", async () => {
    installFetchMock({
      status: 400,
      body: { errorMessages: ["Error"], errors: {} },
    });

    let thrownError: Error | undefined;
    try {
      await executeJiraCreate(VALID_CONFIG, {
        summary: "Test",
        description: "Desc",
      });
      expect.unreachable("executeJiraCreate should have thrown on HTTP 400");
    } catch (err) {
      thrownError = err as Error;
    }

    expect(thrownError).toBeInstanceOf(Error);
    expect(thrownError!.message).not.toContain("test-token-123");
    expect(thrownError!.message).not.toContain("bot@myco.com");
  });
});

// ---------------------------------------------------------------------------
// atlas.config.ts registration (type-level verification)
// ---------------------------------------------------------------------------

describe("jiraPlugin — config registration", () => {
  test("plugin object has all fields required for config validation", () => {
    const plugin = jiraPlugin(VALID_CONFIG);

    // These are the fields validatePlugins() in config.ts checks
    expect(typeof plugin.id).toBe("string");
    expect(plugin.id.trim().length).toBeGreaterThan(0);
    expect(typeof plugin.type).toBe("string");
    expect(["datasource", "context", "interaction", "action"]).toContain(plugin.type);
    expect(typeof plugin.version).toBe("string");
    expect(plugin.version.trim().length).toBeGreaterThan(0);
  });
});
