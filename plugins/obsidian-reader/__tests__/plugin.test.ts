import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { definePlugin, isActionPlugin } from "@useatlas/plugin-sdk";
import { obsidianReaderPlugin, executeObsidianSearch } from "../src/index";

const VALID_CONFIG = {
  api_url: "http://127.0.0.1:27123",
  api_key: "test-obsidian-key",
} as const;

const originalFetch = globalThis.fetch;

let capturedFetchUrl = "";
let capturedFetchInit: RequestInit | undefined;

function installFetchMock(response: { status: number; body: unknown; contentType?: string }) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    capturedFetchUrl = typeof input === "string" ? input : (input as Request).url;
    capturedFetchInit = init;
    return new Response(
      typeof response.body === "string" ? response.body : JSON.stringify(response.body),
      {
        status: response.status,
        headers: { "Content-Type": response.contentType ?? "application/json" },
      },
    );
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
// Plugin shape
// ---------------------------------------------------------------------------

describe("obsidianReaderPlugin — shape", () => {
  test("createPlugin() produces a valid AtlasActionPlugin", () => {
    const plugin = obsidianReaderPlugin(VALID_CONFIG);
    expect(plugin.id).toBe("obsidian-reader");
    expect(plugin.types).toEqual(["action"]);
    expect(plugin.version).toBe("1.0.0");
    expect(plugin.name).toBe("Obsidian Reader");
    expect(plugin.actions).toHaveLength(1);
  });

  test("definePlugin() accepts the created plugin", () => {
    const plugin = obsidianReaderPlugin(VALID_CONFIG);
    expect(definePlugin(plugin)).toBe(plugin);
  });

  test("isActionPlugin type guard returns true", () => {
    expect(isActionPlugin(obsidianReaderPlugin(VALID_CONFIG))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

describe("obsidianReaderPlugin — config validation", () => {
  test("rejects missing api_key", () => {
    expect(() => obsidianReaderPlugin({ api_url: "http://127.0.0.1:27123" } as never)).toThrow(
      "Plugin config validation failed",
    );
  });

  test("rejects empty api_key", () => {
    expect(() => obsidianReaderPlugin({ api_key: "" })).toThrow(
      "Plugin config validation failed",
    );
  });

  test("accepts a config without api_url (defaults loopback)", () => {
    expect(() => obsidianReaderPlugin({ api_key: "x" })).not.toThrow();
  });

  test("accepts a remote https vault URL", () => {
    expect(() =>
      obsidianReaderPlugin({ api_url: "https://vault.example.com:27124", api_key: "x" }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Action metadata
// ---------------------------------------------------------------------------

describe("obsidianReaderPlugin — action metadata", () => {
  test("action has correct shape", () => {
    const plugin = obsidianReaderPlugin(VALID_CONFIG);
    expect(plugin.actions[0].name).toBe("readObsidianVault");
    expect(plugin.actions[0].actionType).toBe("obsidian:read");
    expect(plugin.actions[0].reversible).toBe(true);
    expect(plugin.actions[0].defaultApproval).toBe("auto");
    expect(plugin.actions[0].requiredCredentials).toEqual(["api_key"]);
  });
});

// ---------------------------------------------------------------------------
// Search execution
// ---------------------------------------------------------------------------

describe("executeObsidianSearch", () => {
  test("calls /search/simple/ with bearer auth and contextLength", async () => {
    installFetchMock({
      status: 200,
      body: [
        {
          filename: "Notes/Atlas.md",
          score: 0.91,
          matches: [{ context: "Atlas is a text-to-SQL agent…" }],
        },
      ],
    });

    const result = await executeObsidianSearch(VALID_CONFIG, { query: "atlas" });
    expect(capturedFetchUrl).toContain("/search/simple/?query=atlas");
    expect(capturedFetchUrl).toContain("contextLength=100");
    expect(capturedFetchInit?.method).toBe("POST");

    const headers = capturedFetchInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-obsidian-key");

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].filename).toBe("Notes/Atlas.md");
    expect(result.hits[0].excerpt).toBe("Atlas is a text-to-SQL agent…");
  });

  test("URL-encodes the query parameter", async () => {
    installFetchMock({ status: 200, body: [] });
    await executeObsidianSearch(VALID_CONFIG, { query: "hello world & friends" });
    expect(capturedFetchUrl).toContain("query=hello%20world%20%26%20friends");
  });

  test("strips trailing slash from api_url", async () => {
    installFetchMock({ status: 200, body: [] });
    await executeObsidianSearch(
      { ...VALID_CONFIG, api_url: "http://127.0.0.1:27123/" },
      { query: "x" },
    );
    expect(capturedFetchUrl.startsWith("http://127.0.0.1:27123/search/simple/")).toBe(true);
  });

  test("joins multiple match contexts with separator", async () => {
    installFetchMock({
      status: 200,
      body: [
        {
          filename: "Notes/A.md",
          score: 0.5,
          matches: [{ context: "first hit" }, { context: "second hit" }],
        },
      ],
    });
    const result = await executeObsidianSearch(VALID_CONFIG, { query: "hit" });
    expect(result.hits[0].excerpt).toBe("first hit\n---\nsecond hit");
  });

  test("throws on REST API error with detail", async () => {
    installFetchMock({
      status: 401,
      body: { message: "Invalid API key", errorCode: 40101 },
    });
    await expect(
      executeObsidianSearch(VALID_CONFIG, { query: "x" }),
    ).rejects.toThrow("Obsidian REST API error: Invalid API key");
  });

  test("throws on non-array response shape", async () => {
    installFetchMock({ status: 200, body: { unexpected: "shape" } });
    await expect(
      executeObsidianSearch(VALID_CONFIG, { query: "x" }),
    ).rejects.toThrow("non-array search result");
  });

  test("throws on unparseable success response", async () => {
    installFetchMock({ status: 200, body: "not-json", contentType: "text/plain" });
    await expect(
      executeObsidianSearch(VALID_CONFIG, { query: "x" }),
    ).rejects.toThrow("unparseable response");
  });

  test("error message does not leak api_key", async () => {
    installFetchMock({ status: 500, body: {} });
    let caught: Error | undefined;
    try {
      await executeObsidianSearch(VALID_CONFIG, { query: "x" });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).not.toContain("test-obsidian-key");
  });
});

// ---------------------------------------------------------------------------
// AI SDK tool execution
// ---------------------------------------------------------------------------

describe("obsidianReaderPlugin — tool execution", () => {
  test("readObsidianVault tool returns hits", async () => {
    installFetchMock({
      status: 200,
      body: [{ filename: "n.md", score: 0.9, matches: [{ context: "hit" }] }],
    });
    const plugin = obsidianReaderPlugin(VALID_CONFIG);
    const aiTool = plugin.actions[0].tool as unknown as {
      execute: (args: unknown, options: unknown) => Promise<unknown>;
    };
    const result = (await aiTool.execute(
      { query: "test" },
      { toolCallId: "test-call", messages: [], abortSignal: undefined as unknown as AbortSignal },
    )) as { hits: { filename: string }[] };
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].filename).toBe("n.md");
  });
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

describe("obsidianReaderPlugin — healthCheck", () => {
  test("returns healthy on 200", async () => {
    installFetchMock({ status: 200, body: { status: "ok" } });
    const plugin = obsidianReaderPlugin(VALID_CONFIG);
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(true);
  });

  test("returns unhealthy on 401", async () => {
    installFetchMock({ status: 401, body: { message: "Unauthorized" } });
    const plugin = obsidianReaderPlugin(VALID_CONFIG);
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(false);
    expect(result.message).toContain("rejected the API key");
  });

  test("returns unhealthy on network error", async () => {
    globalThis.fetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof globalThis.fetch;
    const plugin = obsidianReaderPlugin(VALID_CONFIG);
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(false);
    expect(result.message).toContain("ECONNREFUSED");
  });
});

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

describe("obsidianReaderPlugin — initialize", () => {
  test("logs init without leaking api_key", async () => {
    const plugin = obsidianReaderPlugin(VALID_CONFIG);
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
    expect(logged.some((m) => m.includes("Obsidian reader plugin initialized"))).toBe(true);
    expect(logged.every((m) => !m.includes("test-obsidian-key"))).toBe(true);
  });
});
