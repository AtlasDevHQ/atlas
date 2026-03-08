import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { definePlugin, isActionPlugin } from "@useatlas/plugin-sdk";
import { emailPlugin } from "../index";
import { extractEmailDomain, validateAllowedDomains, executeEmailSend } from "../tool";

// ---------------------------------------------------------------------------
// Valid config fixture
// ---------------------------------------------------------------------------

const VALID_CONFIG = {
  resendApiKey: "re_test_123",
} as const;

const VALID_CONFIG_WITH_DOMAINS = {
  ...VALID_CONFIG,
  allowedDomains: ["myco.com", "partner.io"],
};

const VALID_CONFIG_FULL = {
  ...VALID_CONFIG,
  allowedDomains: ["myco.com"],
  fromAddress: "Atlas <atlas@myco.com>",
  approvalMode: "manual" as const,
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

describe("emailPlugin — shape validation", () => {
  test("createPlugin() produces a valid AtlasActionPlugin", () => {
    const plugin = emailPlugin(VALID_CONFIG);
    expect(plugin.id).toBe("email-action");
    expect(plugin.types).toEqual(["action"]);
    expect(plugin.version).toBe("1.0.0");
    expect(plugin.name).toBe("Email Action");
    expect(Array.isArray(plugin.actions)).toBe(true);
    expect(plugin.actions).toHaveLength(1);
  });

  test("definePlugin() accepts the created plugin", () => {
    const plugin = emailPlugin(VALID_CONFIG);
    const validated = definePlugin(plugin);
    expect(validated).toBe(plugin);
  });

  test("isActionPlugin type guard returns true", () => {
    const plugin = emailPlugin(VALID_CONFIG);
    expect(isActionPlugin(plugin)).toBe(true);
  });

  test("config is stored on the plugin object", () => {
    const plugin = emailPlugin(VALID_CONFIG);
    expect(plugin.config?.resendApiKey).toBe("re_test_123");
  });

  test("config with domains is stored correctly", () => {
    const plugin = emailPlugin(VALID_CONFIG_WITH_DOMAINS);
    expect(plugin.config?.allowedDomains).toEqual(["myco.com", "partner.io"]);
  });
});

// ---------------------------------------------------------------------------
// Action metadata
// ---------------------------------------------------------------------------

describe("emailPlugin — action metadata", () => {
  test("action has correct name", () => {
    const plugin = emailPlugin(VALID_CONFIG);
    expect(plugin.actions[0].name).toBe("sendEmailReport");
  });

  test("action has correct actionType", () => {
    const plugin = emailPlugin(VALID_CONFIG);
    expect(plugin.actions[0].actionType).toBe("email:send");
  });

  test("action is not reversible", () => {
    const plugin = emailPlugin(VALID_CONFIG);
    expect(plugin.actions[0].reversible).toBe(false);
  });

  test("action defaults to admin-only approval", () => {
    const plugin = emailPlugin(VALID_CONFIG);
    expect(plugin.actions[0].defaultApproval).toBe("admin-only");
  });

  test("action uses configured approval mode", () => {
    const plugin = emailPlugin(VALID_CONFIG_FULL);
    expect(plugin.actions[0].defaultApproval).toBe("manual");
  });

  test("action lists required credentials", () => {
    const plugin = emailPlugin(VALID_CONFIG);
    expect(plugin.actions[0].requiredCredentials).toEqual(["resendApiKey"]);
  });

  test("action has a description", () => {
    const plugin = emailPlugin(VALID_CONFIG);
    expect(plugin.actions[0].description).toBeTruthy();
    expect(plugin.actions[0].description).toContain("Email");
  });

  test("action has a tool", () => {
    const plugin = emailPlugin(VALID_CONFIG);
    expect(plugin.actions[0].tool).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

describe("emailPlugin — config validation", () => {
  test("rejects missing resendApiKey", () => {
    expect(() =>
      emailPlugin({} as never),
    ).toThrow("Plugin config validation failed");
  });

  test("rejects empty resendApiKey", () => {
    expect(() =>
      emailPlugin({ resendApiKey: "" }),
    ).toThrow("Plugin config validation failed");
  });

  test("accepts valid minimal config", () => {
    expect(() => emailPlugin(VALID_CONFIG)).not.toThrow();
  });

  test("accepts config with all optional fields", () => {
    expect(() => emailPlugin(VALID_CONFIG_FULL)).not.toThrow();
  });

  test("rejects invalid approval mode", () => {
    expect(() =>
      emailPlugin({ resendApiKey: "re_test", approvalMode: "invalid" as never }),
    ).toThrow("Plugin config validation failed");
  });

  test("rejects empty domain in allowedDomains", () => {
    expect(() =>
      emailPlugin({ resendApiKey: "re_test_123", allowedDomains: ["myco.com", ""] }),
    ).toThrow("Plugin config validation failed");
  });

  test("rejects empty fromAddress", () => {
    expect(() =>
      emailPlugin({ resendApiKey: "re_test_123", fromAddress: "" }),
    ).toThrow("Plugin config validation failed");
  });
});

// ---------------------------------------------------------------------------
// Domain allowlist validation
// ---------------------------------------------------------------------------

describe("extractEmailDomain", () => {
  test("extracts domain from plain email", () => {
    expect(extractEmailDomain("user@myco.com")).toBe("myco.com");
  });

  test("extracts domain from display-name format", () => {
    expect(extractEmailDomain("User <user@myco.com>")).toBe("myco.com");
  });

  test("lowercases domain", () => {
    expect(extractEmailDomain("user@MyCo.COM")).toBe("myco.com");
  });

  test("returns undefined for invalid email", () => {
    expect(extractEmailDomain("no-at-sign")).toBeUndefined();
  });
});

describe("validateAllowedDomains", () => {
  test("no allowlist — all domains pass", () => {
    const result = validateAllowedDomains(["user@anything.com"]);
    expect(result.valid).toBe(true);
    expect(result.blocked).toHaveLength(0);
  });

  test("empty allowlist — all domains pass", () => {
    const result = validateAllowedDomains(["user@anything.com"], []);
    expect(result.valid).toBe(true);
  });

  test("allowed domain passes", () => {
    const result = validateAllowedDomains(["user@myco.com"], ["myco.com"]);
    expect(result.valid).toBe(true);
  });

  test("blocked domain fails", () => {
    const result = validateAllowedDomains(["user@blocked.com"], ["myco.com"]);
    expect(result.valid).toBe(false);
    expect(result.blocked).toEqual(["user@blocked.com"]);
  });

  test("mixed allowed and blocked recipients", () => {
    const result = validateAllowedDomains(
      ["ok@myco.com", "bad@other.com"],
      ["myco.com"],
    );
    expect(result.valid).toBe(false);
    expect(result.blocked).toEqual(["bad@other.com"]);
  });

  test("display-name format is parsed for domain check", () => {
    const result = validateAllowedDomains(
      ["User <user@blocked.com>"],
      ["myco.com"],
    );
    expect(result.valid).toBe(false);
    expect(result.blocked).toEqual(["User <user@blocked.com>"]);
  });

  test("domain matching is case-insensitive", () => {
    const result = validateAllowedDomains(
      ["user@MYCO.COM"],
      ["myco.com"],
    );
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

describe("emailPlugin — tool execution", () => {
  test("successful email send returns id", async () => {
    installFetchMock({
      status: 200,
      body: { id: "email_abc123" },
    });

    const plugin = emailPlugin(VALID_CONFIG);
    const aiTool = plugin.actions[0].tool as unknown as {
      execute: (args: unknown, options: unknown) => Promise<unknown>;
    };

    const result = await aiTool.execute(
      { to: "user@test.com", subject: "Report", body: "<h1>Results</h1>" },
      { toolCallId: "test-call", messages: [], abortSignal: undefined as unknown as AbortSignal },
    );

    expect((result as { id: string }).id).toBe("email_abc123");
    expect(capturedFetchUrl).toBe("https://api.resend.com/emails");
    expect(capturedFetchInit?.method).toBe("POST");

    const body = JSON.parse(capturedFetchInit?.body as string);
    expect(body.to).toEqual(["user@test.com"]);
    expect(body.subject).toBe("Report");
    expect(body.html).toBe("<h1>Results</h1>");
    expect(body.from).toBe("Atlas <atlas@notifications.useatlas.dev>");

    // Verify Bearer auth header
    expect((capturedFetchInit?.headers as Record<string, string>)?.Authorization).toBe(
      "Bearer re_test_123",
    );
  });

  test("uses custom from address", async () => {
    installFetchMock({
      status: 200,
      body: { id: "email_xyz" },
    });

    const plugin = emailPlugin({
      resendApiKey: "re_test_123",
      fromAddress: "Custom <custom@myco.com>",
    });
    const aiTool = plugin.actions[0].tool as unknown as {
      execute: (args: unknown, options: unknown) => Promise<unknown>;
    };

    await aiTool.execute(
      { to: "user@test.com", subject: "Test", body: "Hi" },
      { toolCallId: "test-call", messages: [], abortSignal: undefined as unknown as AbortSignal },
    );

    const body = JSON.parse(capturedFetchInit?.body as string);
    expect(body.from).toBe("Custom <custom@myco.com>");
  });

  test("accepts array of recipients", async () => {
    installFetchMock({
      status: 200,
      body: { id: "email_multi" },
    });

    const plugin = emailPlugin(VALID_CONFIG);
    const aiTool = plugin.actions[0].tool as unknown as {
      execute: (args: unknown, options: unknown) => Promise<unknown>;
    };

    await aiTool.execute(
      { to: ["a@test.com", "b@test.com"], subject: "Test", body: "Hi" },
      { toolCallId: "test-call", messages: [], abortSignal: undefined as unknown as AbortSignal },
    );

    const body = JSON.parse(capturedFetchInit?.body as string);
    expect(body.to).toEqual(["a@test.com", "b@test.com"]);
  });

  test("domain blocked throws without calling API", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const plugin = emailPlugin(VALID_CONFIG_WITH_DOMAINS);
    const aiTool = plugin.actions[0].tool as unknown as {
      execute: (args: unknown, options: unknown) => Promise<unknown>;
    };

    await expect(
      aiTool.execute(
        { to: "user@blocked.com", subject: "Test", body: "Hi" },
        { toolCallId: "test-call", messages: [], abortSignal: undefined as unknown as AbortSignal },
      ),
    ).rejects.toThrow("not allowed");

    expect(fetchCalled).toBe(false);
  });

  test("Resend API error throws with detail", async () => {
    installFetchMock({
      status: 422,
      body: { message: "Invalid email address" },
    });

    const plugin = emailPlugin(VALID_CONFIG);
    const aiTool = plugin.actions[0].tool as unknown as {
      execute: (args: unknown, options: unknown) => Promise<unknown>;
    };

    await expect(
      aiTool.execute(
        { to: "bad@test.com", subject: "Test", body: "Hi" },
        { toolCallId: "test-call", messages: [], abortSignal: undefined as unknown as AbortSignal },
      ),
    ).rejects.toThrow("Resend API error: Invalid email address");
  });

  test("error does not expose API key", async () => {
    installFetchMock({
      status: 400,
      body: { message: "Bad request" },
    });

    let thrownError: Error | undefined;
    try {
      await executeEmailSend(VALID_CONFIG, {
        to: "user@test.com",
        subject: "Test",
        body: "Hi",
      });
      expect.unreachable("executeEmailSend should have thrown on HTTP 400");
    } catch (err) {
      thrownError = err as Error;
    }

    expect(thrownError).toBeInstanceOf(Error);
    expect(thrownError!.message).not.toContain("re_test_123");
  });
});

// ---------------------------------------------------------------------------
// executeEmailSend (config-driven)
// ---------------------------------------------------------------------------

describe("executeEmailSend", () => {
  test("calls correct Resend API endpoint", async () => {
    installFetchMock({
      status: 200,
      body: { id: "email_test1" },
    });

    const result = await executeEmailSend(VALID_CONFIG, {
      to: "user@test.com",
      subject: "Report",
      body: "<p>Data</p>",
    });

    expect(capturedFetchUrl).toBe("https://api.resend.com/emails");
    expect(capturedFetchInit?.method).toBe("POST");
    expect(result.id).toBe("email_test1");
  });

  test("sends correct Authorization header", async () => {
    installFetchMock({ status: 200, body: { id: "x" } });

    await executeEmailSend(VALID_CONFIG, {
      to: "user@test.com",
      subject: "Test",
      body: "Hi",
    });

    expect((capturedFetchInit?.headers as Record<string, string>)?.Authorization).toBe(
      "Bearer re_test_123",
    );
  });

  test("uses default from address when not configured", async () => {
    installFetchMock({ status: 200, body: { id: "x" } });

    await executeEmailSend(VALID_CONFIG, {
      to: "user@test.com",
      subject: "Test",
      body: "Hi",
    });

    const body = JSON.parse(capturedFetchInit?.body as string);
    expect(body.from).toBe("Atlas <atlas@notifications.useatlas.dev>");
  });

  test("uses custom from address when configured", async () => {
    installFetchMock({ status: 200, body: { id: "x" } });

    await executeEmailSend(VALID_CONFIG_FULL, {
      to: "user@test.com",
      subject: "Test",
      body: "Hi",
    });

    const body = JSON.parse(capturedFetchInit?.body as string);
    expect(body.from).toBe("Atlas <atlas@myco.com>");
  });

  test("normalizes single recipient to array", async () => {
    installFetchMock({ status: 200, body: { id: "x" } });

    await executeEmailSend(VALID_CONFIG, {
      to: "single@test.com",
      subject: "Test",
      body: "Hi",
    });

    const body = JSON.parse(capturedFetchInit?.body as string);
    expect(body.to).toEqual(["single@test.com"]);
  });

  test("throws when API response omits id", async () => {
    installFetchMock({ status: 200, body: {} });

    await expect(
      executeEmailSend(VALID_CONFIG, {
        to: "user@test.com",
        subject: "Test",
        body: "Hi",
      }),
    ).rejects.toThrow("Resend response did not include an ID");
  });

  test("throws on API error with message", async () => {
    installFetchMock({
      status: 422,
      body: { message: "Invalid email" },
    });

    await expect(
      executeEmailSend(VALID_CONFIG, {
        to: "user@test.com",
        subject: "Test",
        body: "Hi",
      }),
    ).rejects.toThrow("Resend API error: Invalid email");
  });

  test("throws on API error without message", async () => {
    installFetchMock({
      status: 500,
      body: {},
    });

    await expect(
      executeEmailSend(VALID_CONFIG, {
        to: "user@test.com",
        subject: "Test",
        body: "Hi",
      }),
    ).rejects.toThrow("Resend API error: HTTP 500");
  });

  test("handles non-JSON error response body", async () => {
    globalThis.fetch = (async () => {
      return new Response("Service Unavailable", {
        status: 503,
        headers: { "Content-Type": "text/plain" },
      });
    }) as unknown as typeof globalThis.fetch;

    await expect(
      executeEmailSend(VALID_CONFIG, {
        to: "user@test.com",
        subject: "Test",
        body: "Hi",
      }),
    ).rejects.toThrow(/Resend API error:.*503/);
  });

  test("throws on unparseable success response", async () => {
    globalThis.fetch = (async () => {
      return new Response("not-json", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }) as unknown as typeof globalThis.fetch;

    await expect(
      executeEmailSend(VALID_CONFIG, {
        to: "user@test.com",
        subject: "Test",
        body: "Hi",
      }),
    ).rejects.toThrow("Resend API returned unparseable response");
  });

  test("throws on network failure", async () => {
    globalThis.fetch = (() => {
      return Promise.reject(new Error("Network unreachable"));
    }) as unknown as typeof globalThis.fetch;

    await expect(
      executeEmailSend(VALID_CONFIG, {
        to: "user@test.com",
        subject: "Test",
        body: "Hi",
      }),
    ).rejects.toThrow("Network unreachable");
  });
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

describe("emailPlugin — healthCheck", () => {
  test("returns healthy when Resend API responds OK", async () => {
    installFetchMock({ status: 200, body: { data: [] } });

    const plugin = emailPlugin(VALID_CONFIG);
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(true);
    expect(result.latencyMs).toBeDefined();
    expect(capturedFetchUrl).toBe("https://api.resend.com/domains");
    expect((capturedFetchInit?.headers as Record<string, string>)?.Authorization).toBe(
      "Bearer re_test_123",
    );
  });

  test("returns unhealthy on non-200 response", async () => {
    installFetchMock({ status: 401, body: { message: "Invalid API key" } });

    const plugin = emailPlugin(VALID_CONFIG);
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(false);
    expect(result.message).toContain("401");
    expect(result.latencyMs).toBeDefined();
  });

  test("returns unhealthy on network error", async () => {
    globalThis.fetch = (() => {
      return Promise.reject(new Error("Connection refused"));
    }) as unknown as typeof globalThis.fetch;

    const plugin = emailPlugin(VALID_CONFIG);
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(false);
    expect(result.message).toContain("Connection refused");
  });
});

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

describe("emailPlugin — initialize", () => {
  test("logs initialization message", async () => {
    const plugin = emailPlugin(VALID_CONFIG);
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
    expect(logged.some((m) => m.includes("Email plugin initialized"))).toBe(true);
  });

  test("logs domain restrictions when configured", async () => {
    const plugin = emailPlugin(VALID_CONFIG_WITH_DOMAINS);
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
    expect(logged.some((m) => m.includes("myco.com"))).toBe(true);
  });

  test("does not log credentials", async () => {
    const plugin = emailPlugin(VALID_CONFIG);
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
    expect(logged.every((m) => !m.includes("re_test_123"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// atlas.config.ts registration (type-level verification)
// ---------------------------------------------------------------------------

describe("emailPlugin — config registration", () => {
  test("plugin object has all fields required for config validation", () => {
    const plugin = emailPlugin(VALID_CONFIG);

    expect(typeof plugin.id).toBe("string");
    expect(plugin.id.trim().length).toBeGreaterThan(0);
    expect(Array.isArray(plugin.types)).toBe(true);
    expect(plugin.types.every((t: string) => ["datasource", "context", "interaction", "action", "sandbox"].includes(t))).toBe(true);
    expect(typeof plugin.version).toBe("string");
    expect(plugin.version.trim().length).toBeGreaterThan(0);
  });
});
