/**
 * Tests for actions-related configuration in atlas.config.ts.
 *
 * Covers:
 * - Zod validation of the actions schema (validateAndResolve)
 * - configFromEnv() reading action-related env vars
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolve } from "path";

// Cache-busting imports (same pattern as config.test.ts)
const configModPath = resolve(__dirname, "../config.ts");
const configMod = await import(`${configModPath}?t=${Date.now()}`);
const { configFromEnv, validateAndResolve, _resetConfig } = configMod as typeof import("../config");

const envKeys = [
  "ATLAS_ACTIONS_ENABLED",
  "ATLAS_ACTION_APPROVAL",
  "ATLAS_ACTION_TIMEOUT",
  "ATLAS_ACTION_MAX_PER_CONVERSATION",
  "ATLAS_DATASOURCE_URL",
];

// ---------------------------------------------------------------------------
// Zod validation (validateAndResolve) — actions
// ---------------------------------------------------------------------------

describe("validateAndResolve — actions", () => {
  it("accepts config with valid actions section (defaults + per-action)", () => {
    const resolved = validateAndResolve({
      actions: {
        defaults: { approval: "manual", timeout: 5000, maxPerConversation: 10 },
        "slack:send": { enabled: true, approval: "auto" },
      },
    });
    expect(resolved.actions).toBeDefined();
    expect(resolved.actions!.defaults).toEqual({
      approval: "manual",
      timeout: 5000,
      maxPerConversation: 10,
    });
    expect(resolved.actions!["slack:send"]).toEqual({
      enabled: true,
      approval: "auto",
    });
  });

  it("accepts empty actions object", () => {
    const resolved = validateAndResolve({ actions: {} });
    expect(resolved.actions).toBeDefined();
    expect(resolved.actions).toEqual({});
  });

  it("rejects invalid approval mode in actions.defaults", () => {
    expect(() =>
      validateAndResolve({
        actions: { defaults: { approval: "yolo" } },
      }),
    ).toThrow("Invalid atlas.config.ts");
  });

  it("accepts all valid approval modes in actions.defaults.approval", () => {
    const validModes = ["auto", "manual", "admin-only"] as const;
    for (const approval of validModes) {
      const resolved = validateAndResolve({
        actions: { defaults: { approval } },
      });
      expect(resolved.actions!.defaults!.approval).toBe(approval);
    }
  });

  it("accepts per-action config with passthrough fields (e.g. allowedChannels)", () => {
    const resolved = validateAndResolve({
      actions: {
        "slack:send": {
          enabled: true,
          approval: "manual",
          rateLimit: 5,
          allowedChannels: ["#general", "#alerts"],
        },
      },
    });
    const slackAction = resolved.actions!["slack:send"] as Record<string, unknown>;
    expect(slackAction.enabled).toBe(true);
    expect(slackAction.approval).toBe("manual");
    expect(slackAction.rateLimit).toBe(5);
    expect(slackAction.allowedChannels).toEqual(["#general", "#alerts"]);
  });

  it("rejects negative timeout in actions.defaults", () => {
    expect(() =>
      validateAndResolve({
        actions: { defaults: { timeout: -1 } },
      }),
    ).toThrow("Invalid atlas.config.ts");
  });

  it("actions field is optional (missing is fine)", () => {
    const resolved = validateAndResolve({});
    expect(resolved.actions).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// configFromEnv — action env vars
// ---------------------------------------------------------------------------

describe("configFromEnv — actions", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    _resetConfig();
    for (const key of envKeys) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    _resetConfig();
    for (const key of envKeys) {
      if (saved[key] !== undefined) process.env[key] = saved[key];
      else delete process.env[key];
    }
  });

  it("includes actions when ATLAS_ACTIONS_ENABLED=true", () => {
    process.env.ATLAS_ACTIONS_ENABLED = "true";
    const config = configFromEnv();
    expect(config.actions).toBeDefined();
    expect(config.actions!.defaults).toBeDefined();
  });

  it("does not include actions when ATLAS_ACTIONS_ENABLED is not set", () => {
    const config = configFromEnv();
    expect(config.actions).toBeUndefined();
  });

  it("reads ATLAS_ACTION_APPROVAL into actions.defaults.approval", () => {
    process.env.ATLAS_ACTIONS_ENABLED = "true";
    process.env.ATLAS_ACTION_APPROVAL = "admin-only";
    const config = configFromEnv();
    expect(config.actions!.defaults!.approval).toBe("admin-only");
  });

  it("reads ATLAS_ACTION_TIMEOUT into actions.defaults.timeout", () => {
    process.env.ATLAS_ACTIONS_ENABLED = "true";
    process.env.ATLAS_ACTION_TIMEOUT = "10000";
    const config = configFromEnv();
    expect(config.actions!.defaults!.timeout).toBe(10000);
  });

  it("reads ATLAS_ACTION_MAX_PER_CONVERSATION into actions.defaults.maxPerConversation", () => {
    process.env.ATLAS_ACTIONS_ENABLED = "true";
    process.env.ATLAS_ACTION_MAX_PER_CONVERSATION = "5";
    const config = configFromEnv();
    expect(config.actions!.defaults!.maxPerConversation).toBe(5);
  });

  it("ignores invalid ATLAS_ACTION_APPROVAL value", () => {
    process.env.ATLAS_ACTIONS_ENABLED = "true";
    process.env.ATLAS_ACTION_APPROVAL = "yolo";
    const config = configFromEnv();
    expect(config.actions!.defaults!.approval).toBeUndefined();
  });
});
