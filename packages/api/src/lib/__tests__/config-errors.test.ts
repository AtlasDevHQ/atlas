/**
 * Tests for formatZodErrors() — human-readable Zod error formatting.
 *
 * Covers:
 * - Field path display for nested and root-level errors
 * - Expected vs received type display
 * - Smart suggestions for common auth misspellings
 * - Multi-error configs show all errors
 * - Various Zod issue types (invalid_type, invalid_union, invalid_value, too_small)
 * - Field-specific hints (connection URL, auth mode)
 * - Integration: errors flow through validateAndResolve()
 */
import { describe, it, expect } from "bun:test";
import { resolve } from "path";

// Cache-busting import to get fresh module
const configModPath = resolve(__dirname, "../config.ts");
const configMod = await import(`${configModPath}?t=${Date.now()}`);
const {
  formatZodErrors,
  AtlasConfigSchema,
  validateAndResolve,
} = configMod as typeof import("../config");

// ---------------------------------------------------------------------------
// formatZodErrors — unit tests
// ---------------------------------------------------------------------------

describe("formatZodErrors", () => {
  it("formats invalid_type with field path, expected, and received", () => {
    const result = AtlasConfigSchema.safeParse({
      datasources: { default: { url: 123 } },
    });
    expect(result.success).toBe(false);
    if (result.success) return;

    const formatted = formatZodErrors(result.error, {
      datasources: { default: { url: 123 } },
    });
    expect(formatted).toContain("datasources.default.url");
    expect(formatted).toContain("expected");
    expect(formatted).toContain("string");
    expect(formatted).toContain("number");
  });

  it("includes field hint for datasource URL", () => {
    const input = { datasources: { default: { url: 42 } } };
    const result = AtlasConfigSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (result.success) return;

    const formatted = formatZodErrors(result.error, input);
    expect(formatted).toContain("connection URL");
  });

  it("formats invalid auth value with valid options", () => {
    const input = { auth: "invalid-mode" };
    const result = AtlasConfigSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (result.success) return;

    const formatted = formatZodErrors(result.error, input);
    expect(formatted).toContain("auth");
    expect(formatted).toContain("invalid value");
    // Should list valid options
    expect(formatted).toContain('"auto"');
    expect(formatted).toContain('"api-key"');
    expect(formatted).toContain('"managed"');
    expect(formatted).toContain('"byot"');
    expect(formatted).toContain('"none"');
  });

  it("suggests correct auth value for common misspellings", () => {
    const input = { auth: "apiKey" };
    const result = AtlasConfigSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (result.success) return;

    const formatted = formatZodErrors(result.error, input);
    expect(formatted).toContain('Did you mean "api-key"?');
  });

  it("suggests api-key for api_key", () => {
    const input = { auth: "api_key" };
    const result = AtlasConfigSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (result.success) return;

    const formatted = formatZodErrors(result.error, input);
    expect(formatted).toContain('Did you mean "api-key"?');
  });

  it("suggests byot for bearer", () => {
    const input = { auth: "bearer" };
    const result = AtlasConfigSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (result.success) return;

    const formatted = formatZodErrors(result.error, input);
    expect(formatted).toContain('Did you mean "byot"?');
  });

  it("shows all errors for multi-error config", () => {
    const input = {
      datasources: { default: { url: "" } },
      tools: "explore",
      auth: "invalid",
    };
    const result = AtlasConfigSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (result.success) return;

    const formatted = formatZodErrors(result.error, input);
    const lines = formatted.split("\n").filter((l) => l.includes("Config error"));
    // Should have at least 2 errors (tools wrong type + auth invalid)
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });

  it("formats too_small errors (e.g. empty URL)", () => {
    const input = { datasources: { default: { url: "" } } };
    const result = AtlasConfigSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (result.success) return;

    const formatted = formatZodErrors(result.error, input);
    expect(formatted).toContain("datasources.default.url");
  });

  it("formats invalid tools type (string instead of array)", () => {
    const input = { tools: "explore" };
    const result = AtlasConfigSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (result.success) return;

    const formatted = formatZodErrors(result.error, input);
    expect(formatted).toContain("tools");
    expect(formatted).toContain("expected");
    expect(formatted).toContain("array");
  });

  it("formats maxTotalConnections wrong type", () => {
    const input = { maxTotalConnections: "one hundred" };
    const result = AtlasConfigSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (result.success) return;

    const formatted = formatZodErrors(result.error, input);
    expect(formatted).toContain("maxTotalConnections");
    expect(formatted).toContain("number");
    expect(formatted).toContain("string");
  });

  it("formats negative number errors for pool config", () => {
    const input = { maxTotalConnections: -5 };
    const result = AtlasConfigSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (result.success) return;

    const formatted = formatZodErrors(result.error, input);
    expect(formatted).toContain("maxTotalConnections");
  });

  it("formats nested scheduler errors", () => {
    const input = { scheduler: { backend: "invalid-backend" } };
    const result = AtlasConfigSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (result.success) return;

    const formatted = formatZodErrors(result.error, input);
    expect(formatted).toContain("scheduler.backend");
    // Should list valid backend options
    expect(formatted).toContain('"bun"');
    expect(formatted).toContain('"webhook"');
    expect(formatted).toContain('"vercel"');
  });

  it("no suggestion when auth value is not a common misspelling", () => {
    const input = { auth: "totally-random" };
    const result = AtlasConfigSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (result.success) return;

    const formatted = formatZodErrors(result.error, input);
    expect(formatted).not.toContain("Did you mean");
  });

  it("handles missing rawInput gracefully", () => {
    const result = AtlasConfigSchema.safeParse({ auth: "bad" });
    expect(result.success).toBe(false);
    if (result.success) return;

    // No rawInput passed — should still format without crashing
    const formatted = formatZodErrors(result.error);
    expect(formatted).toContain("Config error at auth");
  });
});

// ---------------------------------------------------------------------------
// Integration: validateAndResolve uses formatZodErrors
// ---------------------------------------------------------------------------

describe("validateAndResolve error messages", () => {
  it("includes formatted error in thrown message", () => {
    try {
      validateAndResolve({ auth: "apiKey" });
      expect.unreachable("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("Invalid atlas.config.ts:");
      expect(msg).toContain("Config error at auth");
      expect(msg).toContain('Did you mean "api-key"?');
    }
  });

  it("shows multiple errors in thrown message", () => {
    try {
      validateAndResolve({
        datasources: { db: { url: 123 } },
        tools: "not-array",
        auth: "api_key",
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      const configErrors = msg.split("\n").filter((l: string) => l.includes("Config error"));
      expect(configErrors.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("preserves backward compat: still starts with Invalid atlas.config.ts", () => {
    try {
      validateAndResolve({ auth: "bad" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as Error).message).toMatch(/^Invalid atlas\.config\.ts:/);
    }
  });

  it("still includes field path for datasource URL errors", () => {
    try {
      validateAndResolve({ datasources: { bad: { url: "" } } });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("datasources.bad.url");
    }
  });
});
