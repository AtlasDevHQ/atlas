import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import type { TableProfile } from "@useatlas/types";

// Track warn calls for staleness assertions
let warnCalls: unknown[][] = [];

// Mock logger — must be before importing profile-cache
mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: (...args: unknown[]) => {
      warnCalls.push(args);
    },
    error: () => {},
    debug: () => {},
  }),
}));

// Import after mock setup
const { cacheProfiles, loadCachedProfiles, invalidateProfileCache } = await import("../profile-cache");

// Use a temp directory for the semantic root
const tmpRoot = path.join(import.meta.dir, "__tmp-profile-cache__");
const cacheDir = path.join(tmpRoot, ".expert-cache");
const cachePath = path.join(cacheDir, "profiles.json");

/** Minimal valid TableProfile for testing. */
function makeProfile(name: string): TableProfile {
  return {
    table_name: name,
    object_type: "table",
    row_count: 100,
    columns: [],
    primary_key_columns: [],
    foreign_keys: [],
    inferred_foreign_keys: [],
    profiler_notes: [],
    table_flags: { possibly_abandoned: false, possibly_denormalized: false },
  };
}

describe("profile-cache", () => {
  beforeEach(() => {
    process.env.ATLAS_SEMANTIC_ROOT = tmpRoot;
    warnCalls = [];
    // Clean up any leftover cache
    if (fs.existsSync(cacheDir)) {
      fs.rmSync(cacheDir, { recursive: true });
    }
  });

  afterEach(() => {
    delete process.env.ATLAS_SEMANTIC_ROOT;
    if (fs.existsSync(cacheDir)) {
      fs.rmSync(cacheDir, { recursive: true });
    }
  });

  describe("cacheProfiles + loadCachedProfiles", () => {
    it("round-trips profiles through cache", () => {
      const profiles = [makeProfile("orders"), makeProfile("users")];
      cacheProfiles(profiles);

      const loaded = loadCachedProfiles();
      expect(loaded).toHaveLength(2);
      expect(loaded[0].table_name).toBe("orders");
      expect(loaded[1].table_name).toBe("users");
    });

    it("preserves column data in round-trip", () => {
      const profile = makeProfile("products");
      profile.columns = [
        {
          name: "id",
          type: "integer",
          nullable: false,
          unique_count: 500,
          null_count: 0,
          sample_values: ["1", "2", "3"],
          is_primary_key: true,
          is_foreign_key: false,
          fk_target_table: null,
          fk_target_column: null,
          is_enum_like: false,
          profiler_notes: [],
        },
      ];

      cacheProfiles([profile]);
      const loaded = loadCachedProfiles();
      expect(loaded[0].columns).toHaveLength(1);
      expect(loaded[0].columns[0].name).toBe("id");
      expect(loaded[0].columns[0].unique_count).toBe(500);
    });
  });

  describe("loadCachedProfiles", () => {
    it("returns empty array when cache file does not exist", () => {
      const result = loadCachedProfiles();
      expect(result).toEqual([]);
    });

    it("returns empty array when cache file is malformed JSON", () => {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(cachePath, "not-json", "utf-8");

      const result = loadCachedProfiles();
      expect(result).toEqual([]);
    });

    it("returns empty array when cache file has unexpected shape", () => {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(cachePath, JSON.stringify({ profiles: "not-an-array" }), "utf-8");

      const result = loadCachedProfiles();
      expect(result).toEqual([]);
    });

    it("logs warning when cache is stale (>7 days)", () => {
      const staleDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(
        cachePath,
        JSON.stringify({ cachedAt: staleDate, profiles: [makeProfile("old")] }),
        "utf-8",
      );

      const result = loadCachedProfiles();
      // Should still return the data
      expect(result).toHaveLength(1);
      expect(result[0].table_name).toBe("old");
      // Should have logged a warning about staleness (pino-style: obj, message)
      expect(warnCalls.length).toBeGreaterThanOrEqual(1);
      const warnMsg = warnCalls.find(
        (args) => args.some((a) => typeof a === "string" && a.includes("stale")),
      );
      expect(warnMsg).toBeTruthy();
    });

    it("does not warn when cache is fresh", () => {
      const freshDate = new Date().toISOString();
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(
        cachePath,
        JSON.stringify({ cachedAt: freshDate, profiles: [makeProfile("fresh")] }),
        "utf-8",
      );

      warnCalls = [];
      loadCachedProfiles();
      const staleWarns = warnCalls.filter(
        (args) => args.some((a) => typeof a === "string" && a.includes("stale")),
      );
      expect(staleWarns).toHaveLength(0);
    });
  });

  describe("invalidateProfileCache", () => {
    it("deletes the cache file", () => {
      cacheProfiles([makeProfile("orders")]);
      expect(fs.existsSync(cachePath)).toBe(true);

      invalidateProfileCache();
      expect(fs.existsSync(cachePath)).toBe(false);
    });

    it("does not throw when cache does not exist", () => {
      expect(() => invalidateProfileCache()).not.toThrow();
    });
  });
});
