import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import {
  resolveFixturePaths,
  shouldUseFixture,
} from "../../src/init/fixture.js";

describe("shouldUseFixture", () => {
  it("returns true when ATLAS_DATASOURCE_URL is unset", () => {
    expect(shouldUseFixture({})).toBe(true);
  });

  it("returns true when ATLAS_DATASOURCE_URL is empty", () => {
    expect(shouldUseFixture({ ATLAS_DATASOURCE_URL: "" })).toBe(true);
  });

  it("returns false when ATLAS_DATASOURCE_URL has any value", () => {
    expect(
      shouldUseFixture({ ATLAS_DATASOURCE_URL: "postgres://x" }),
    ).toBe(false);
  });
});

describe("resolveFixturePaths", () => {
  it("resolves a real seed.sql shipped with the package", () => {
    const { seedPath } = resolveFixturePaths();
    expect(existsSync(seedPath)).toBe(true);
    const seed = readFileSync(seedPath, "utf8");
    expect(seed).toContain("CREATE TABLE IF NOT EXISTS companies");
    expect(seed).toContain("CREATE TABLE IF NOT EXISTS people");
  });

  it("returns a sqlite URL pointing into a per-user cache dir", () => {
    const { sqliteUrl, sqlitePath } = resolveFixturePaths();
    expect(sqliteUrl.startsWith("sqlite://")).toBe(true);
    expect(sqliteUrl.endsWith(".sqlite")).toBe(true);
    expect(sqlitePath).toMatch(/atlas-mcp/);
  });

  it("respects an injected cache dir for testability", () => {
    const fake = "/tmp/atlas-test-cache";
    const { sqlitePath } = resolveFixturePaths({ cacheDir: fake });
    expect(sqlitePath.startsWith(fake)).toBe(true);
  });

  it("throws loud when the bundled seed.sql is missing", () => {
    // If `files: ["fixtures/"]` ever drops from package.json (or the seed
    // doesn't get packed for some other reason), this throw is the user's
    // only signal — pin the contract so a regression is caught at test time
    // instead of at first init.
    expect(() => resolveFixturePaths({ existsSync: () => false })).toThrow(
      /Bundled fixture seed\.sql is missing/,
    );
    expect(() => resolveFixturePaths({ existsSync: () => false })).toThrow(
      /Reinstall @useatlas\/mcp/,
    );
  });
});
