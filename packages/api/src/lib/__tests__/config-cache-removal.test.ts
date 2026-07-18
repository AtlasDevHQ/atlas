/**
 * Config-block removal, phase 2 (#4551). Phase 1 (#4545, ignored-with-boot-
 * warning) shipped in v0.0.56; this completes the two-phase drop in the
 * following release train.
 *
 * The `cache:` block is gone from the config schema. A config file that
 * still carries one FAILS validation with a pointed error — the Query Cache
 * is configured solely via the settings registry (workspace > platform >
 * env > default). Pins: (1) validateAndResolve throws on a `cache:` block,
 * (2) the error names both migration targets (Admin UI + ATLAS_CACHE_* env
 * vars), (3) a config without the block resolves normally with no `cache`
 * key on the resolved config.
 */

import { describe, it, expect } from "bun:test";
import { validateAndResolve } from "../config";

describe("config-block removal: cache (#4551 phase 2)", () => {
  it("fails validation when a `cache:` block is present", () => {
    expect(() =>
      validateAndResolve({ cache: { enabled: false, ttl: 1234, maxSize: 7 } }),
    ).toThrow(/`cache:` block was removed/);
  });

  it("rejects even an empty `cache: {}` block", () => {
    expect(() => validateAndResolve({ cache: {} })).toThrow(
      /`cache:` block was removed/,
    );
  });

  it("points the operator at the settings registry and the env vars", () => {
    let message = "";
    try {
      validateAndResolve({ cache: { enabled: true } });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("Invalid atlas.config.ts");
    expect(message).toContain("settings registry");
    expect(message).toContain("workspace > platform > env > default");
    expect(message).toContain("Admin");
    expect(message).toContain("ATLAS_CACHE_ENABLED");
    expect(message).toContain("ATLAS_CACHE_TTL");
    expect(message).toContain("ATLAS_CACHE_MAX_SIZE");
  });

  it("treats an explicit `cache: undefined` as absent (TS optional-field semantics)", () => {
    const resolved = validateAndResolve({ cache: undefined });
    expect(resolved).not.toHaveProperty("cache");
  });

  it("resolves a config without the block normally, with no `cache` key", () => {
    const resolved = validateAndResolve({});
    expect(resolved).not.toHaveProperty("cache");
  });
});
