/**
 * Tests for the operator-credential env overlay (#3704) — the merge the chat
 * plugin applies before building the AdapterRegistry. Precedence under test:
 * resolver overlay (DB-backed, Admin-set) wins over `process.env`; unresolved
 * (`undefined` / empty) overlay keys fall through to env unchanged.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { resolveAdapterBuildEnv } from "./index";
import { ChatConfigSchema, type ChatPluginConfig } from "./config";

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Parameters<typeof resolveAdapterBuildEnv>[1];

// Minimal config — only the fields the helper reads matter.
function cfg(resolveAdapterEnv?: ChatPluginConfig["resolveAdapterEnv"]): ChatPluginConfig {
  return {
    executeQuery: (async () => ({})) as unknown as ChatPluginConfig["executeQuery"],
    resolveAdapterEnv,
  };
}

const ORIGINAL_ENV = { ...process.env };
beforeEach(() => {
  delete process.env.SLACK_SIGNING_SECRET;
  delete process.env.SLACK_CLIENT_ID;
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("resolveAdapterBuildEnv", () => {
  it("returns process.env unchanged when no resolver is configured (self-host)", async () => {
    process.env.SLACK_SIGNING_SECRET = "env-sign";
    const env = await resolveAdapterBuildEnv(cfg(undefined), noopLogger);
    expect(env).toBe(process.env);
  });

  it("overlays resolver values on top of env (DB wins)", async () => {
    process.env.SLACK_SIGNING_SECRET = "env-sign";
    process.env.SLACK_CLIENT_ID = "env-id";
    const env = await resolveAdapterBuildEnv(
      cfg(async () => ({ SLACK_SIGNING_SECRET: "db-sign" })),
      noopLogger,
    );
    expect(env.SLACK_SIGNING_SECRET).toBe("db-sign"); // overridden
    expect(env.SLACK_CLIENT_ID).toBe("env-id"); // untouched fallback
    // The real process.env is not mutated — the helper returns a clone.
    expect(process.env.SLACK_SIGNING_SECRET).toBe("env-sign");
  });

  it("does not clobber an env value with an undefined overlay value", async () => {
    process.env.SLACK_SIGNING_SECRET = "env-sign";
    const env = await resolveAdapterBuildEnv(
      cfg(async () => ({ SLACK_SIGNING_SECRET: undefined })),
      noopLogger,
    );
    expect(env.SLACK_SIGNING_SECRET).toBe("env-sign");
  });

  it("does not clobber an env value with an empty-string overlay value", async () => {
    process.env.SLACK_SIGNING_SECRET = "env-sign";
    const env = await resolveAdapterBuildEnv(
      cfg(async () => ({ SLACK_SIGNING_SECRET: "" })),
      noopLogger,
    );
    expect(env.SLACK_SIGNING_SECRET).toBe("env-sign");
  });

  it("supplies a value env lacks entirely (set-from-Admin-only)", async () => {
    const env = await resolveAdapterBuildEnv(
      cfg(async () => ({ SLACK_SIGNING_SECRET: "db-only" })),
      noopLogger,
    );
    expect(env.SLACK_SIGNING_SECRET).toBe("db-only");
  });

  it("propagates a throwing resolver (fail-loud, no env-only fallback)", async () => {
    const boom = mock(async () => {
      throw new Error("decrypt failed");
    });
    await expect(resolveAdapterBuildEnv(cfg(boom), noopLogger)).rejects.toThrow(/decrypt failed/);
  });
});

describe("ChatConfigSchema accepts resolveAdapterEnv", () => {
  // Regression for the #3704 boot crash: `resolveAdapterEnv` was on the
  // ChatPluginConfig TS interface + wired in atlas.config.ts, but missing
  // from the `.strict()` Zod schema, so config load rejected the key and the
  // API crashed before binding HTTP (caught only by Boot Smoke). These tests
  // exercise the schema directly — the path the TS-typed unit tests bypass.
  it("validates a config carrying resolveAdapterEnv", () => {
    const result = ChatConfigSchema.safeParse({
      executeQuery: async () => ({}),
      resolveAdapterEnv: async () => ({ SLACK_SIGNING_SECRET: "x" }),
    });
    expect(result.success).toBe(true);
  });

  it("still validates a config omitting it (optional)", () => {
    const result = ChatConfigSchema.safeParse({ executeQuery: async () => ({}) });
    expect(result.success).toBe(true);
  });
});
