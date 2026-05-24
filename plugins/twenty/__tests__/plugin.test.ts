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
    expect(plugin.actions).toHaveLength(1);
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

describe("twentyPlugin — action metadata", () => {
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
