/**
 * twentyPlugin shape + config-validation tests.
 *
 * The action's runtime execution path is covered by the TwentyClient
 * tests (which exercise the same `upsertPerson` codepath the action
 * tool wraps). This file focuses on the plugin scaffold itself:
 * validates that `createPlugin()` builds a well-formed AtlasActionPlugin.
 */
import { describe, test, expect } from "bun:test";
import { definePlugin, isActionPlugin } from "@useatlas/plugin-sdk";
import { twentyPlugin } from "../src/index";

const VALID_CONFIG = {
  apiKey: "twenty_test_key",
  baseUrl: "https://crm.example.com",
} as const;

const VALID_CONFIG_FULL = {
  apiKey: "twenty_test_key",
  baseUrl: "https://crm.example.com",
  timeoutMs: 15_000,
};

describe("twentyPlugin — shape validation", () => {
  test("createPlugin() produces a valid AtlasActionPlugin", () => {
    const plugin = twentyPlugin(VALID_CONFIG);
    expect(plugin.id).toBe("twenty-action");
    expect(plugin.types).toEqual(["action"]);
    expect(plugin.version).toBe("0.1.0");
    expect(plugin.name).toBe("Twenty CRM Action");
    expect(Array.isArray(plugin.actions)).toBe(true);
    // Two actions: upsertTwentyPerson + stampStripeCustomerId (#2737).
    expect(plugin.actions).toHaveLength(2);
  });

  test("definePlugin() accepts the created plugin", () => {
    const plugin = twentyPlugin(VALID_CONFIG);
    const validated = definePlugin(plugin);
    expect(validated).toBe(plugin);
  });

  test("isActionPlugin type guard returns true", () => {
    expect(isActionPlugin(twentyPlugin(VALID_CONFIG))).toBe(true);
  });

  test("config is stored on the plugin object", () => {
    const plugin = twentyPlugin(VALID_CONFIG);
    expect(plugin.config?.apiKey).toBe("twenty_test_key");
    expect(plugin.config?.baseUrl).toBe("https://crm.example.com");
  });
});

describe("twentyPlugin — upsertTwentyPerson action metadata", () => {
  test("action name is upsertTwentyPerson", () => {
    expect(twentyPlugin(VALID_CONFIG).actions[0].name).toBe("upsertTwentyPerson");
  });

  test("action actionType is crm:upsert-person", () => {
    expect(twentyPlugin(VALID_CONFIG).actions[0].actionType).toBe(
      "crm:upsert-person",
    );
  });

  test("action is not reversible", () => {
    expect(twentyPlugin(VALID_CONFIG).actions[0].reversible).toBe(false);
  });

  test("action defaults to admin-only approval", () => {
    expect(twentyPlugin(VALID_CONFIG).actions[0].defaultApproval).toBe(
      "admin-only",
    );
  });

  test("action requires apiKey credential", () => {
    expect(twentyPlugin(VALID_CONFIG).actions[0].requiredCredentials).toEqual([
      "apiKey",
    ]);
  });
});

describe("twentyPlugin — stampStripeCustomerId action metadata", () => {
  test("action name is stampStripeCustomerId", () => {
    expect(twentyPlugin(VALID_CONFIG).actions[1].name).toBe(
      "stampStripeCustomerId",
    );
  });

  test("action actionType is crm:stamp-stripe-customer-id", () => {
    expect(twentyPlugin(VALID_CONFIG).actions[1].actionType).toBe(
      "crm:stamp-stripe-customer-id",
    );
  });

  test("action is not reversible (stamping is a write that we don't roll back)", () => {
    expect(twentyPlugin(VALID_CONFIG).actions[1].reversible).toBe(false);
  });

  test("action defaults to admin-only approval", () => {
    expect(twentyPlugin(VALID_CONFIG).actions[1].defaultApproval).toBe(
      "admin-only",
    );
  });

  test("action requires apiKey credential", () => {
    expect(twentyPlugin(VALID_CONFIG).actions[1].requiredCredentials).toEqual([
      "apiKey",
    ]);
  });
});

describe("twentyPlugin — config validation", () => {
  test("rejects missing apiKey", () => {
    expect(() => twentyPlugin({ baseUrl: "https://crm.example.com" } as never)).toThrow(
      "Plugin config validation failed",
    );
  });

  test("rejects empty apiKey", () => {
    expect(() => twentyPlugin({ apiKey: "", baseUrl: "https://crm.example.com" })).toThrow(
      "Plugin config validation failed",
    );
  });

  test("rejects missing baseUrl (no built-in default)", () => {
    expect(() => twentyPlugin({ apiKey: "abc" } as never)).toThrow(
      "Plugin config validation failed",
    );
  });

  test("rejects non-URL baseUrl (z.string().url())", () => {
    expect(() =>
      twentyPlugin({ apiKey: "abc", baseUrl: "crm.example.com" }),
    ).toThrow("Plugin config validation failed");
  });

  test("accepts valid minimal config", () => {
    expect(() => twentyPlugin(VALID_CONFIG)).not.toThrow();
  });

  test("accepts valid full config", () => {
    expect(() => twentyPlugin(VALID_CONFIG_FULL)).not.toThrow();
  });

  test("rejects negative timeoutMs", () => {
    expect(() =>
      twentyPlugin({
        apiKey: "abc",
        baseUrl: "https://crm.example.com",
        timeoutMs: -1,
      }),
    ).toThrow("Plugin config validation failed");
  });
});

describe("twentyPlugin — healthCheck (#3179)", () => {
  test("defines a healthCheck so a revoked key can surface unhealthy", () => {
    // Without it, PluginRegistry falls back to the last post-init status and
    // reports `healthy` forever (the bug #3179 fixes).
    expect(typeof twentyPlugin(VALID_CONFIG).healthCheck).toBe("function");
  });

  test("reports healthy when the Twenty probe returns 200", async () => {
    const plugin = twentyPlugin(VALID_CONFIG);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ components: { schemas: { Person: { properties: {} } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof globalThis.fetch;
    try {
      const result = await plugin.healthCheck!();
      expect(result.healthy).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("reports unhealthy when the Twenty key is revoked (401)", async () => {
    const plugin = twentyPlugin(VALID_CONFIG);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ messages: ["Unauthorized"] }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof globalThis.fetch;
    try {
      const result = await plugin.healthCheck!();
      expect(result.healthy).toBe(false);
      expect(result.message).toContain("401");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
