/**
 * Tests for multi-seed selection logic in create-atlas.
 *
 * Tests the flag parsing, dataset validation, and seed directory structure.
 * The actual scaffolding is tested via smoke-test.sh (integration).
 */

import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";

// ── Seed directory structure ─────────────────────────────────────────

const DATA_DIR = path.resolve(import.meta.dir, "../../packages/cli/data");
const SEEDS_DIR = path.join(DATA_DIR, "seeds");

const EXPECTED_SEEDS = ["simple", "cybersec", "ecommerce"] as const;

describe("seed directory structure", () => {
  test("seeds/ directory exists", () => {
    expect(fs.existsSync(SEEDS_DIR)).toBe(true);
  });

  for (const seed of EXPECTED_SEEDS) {
    describe(`seeds/${seed}/`, () => {
      const seedDir = path.join(SEEDS_DIR, seed);

      test("directory exists", () => {
        expect(fs.existsSync(seedDir)).toBe(true);
      });

      test("seed.sql exists and is non-empty", () => {
        const sqlPath = path.join(seedDir, "seed.sql");
        expect(fs.existsSync(sqlPath)).toBe(true);
        const stat = fs.statSync(sqlPath);
        expect(stat.size).toBeGreaterThan(100);
      });

      test("semantic/ directory exists with entities", () => {
        const semanticDir = path.join(seedDir, "semantic");
        expect(fs.existsSync(semanticDir)).toBe(true);
        const entitiesDir = path.join(semanticDir, "entities");
        expect(fs.existsSync(entitiesDir)).toBe(true);
        const entities = fs.readdirSync(entitiesDir).filter((f) => f.endsWith(".yml"));
        expect(entities.length).toBeGreaterThan(0);
      });

      test("semantic/ has catalog.yml", () => {
        const catalogPath = path.join(seedDir, "semantic", "catalog.yml");
        expect(fs.existsSync(catalogPath)).toBe(true);
      });

      test("semantic/ has glossary.yml", () => {
        const glossaryPath = path.join(seedDir, "semantic", "glossary.yml");
        expect(fs.existsSync(glossaryPath)).toBe(true);
      });
    });
  }
});

// ── Backward-compat symlinks ─────────────────────────────────────────

describe("backward-compatible symlinks", () => {
  test("demo.sql symlink resolves to seeds/simple/seed.sql", () => {
    const symlinkPath = path.join(DATA_DIR, "demo.sql");
    expect(fs.existsSync(symlinkPath)).toBe(true);
    const target = fs.readlinkSync(symlinkPath);
    expect(target).toBe("seeds/simple/seed.sql");
  });

  test("cybersec.sql symlink resolves to seeds/cybersec/seed.sql", () => {
    const symlinkPath = path.join(DATA_DIR, "cybersec.sql");
    expect(fs.existsSync(symlinkPath)).toBe(true);
    const target = fs.readlinkSync(symlinkPath);
    expect(target).toBe("seeds/cybersec/seed.sql");
  });

  test("ecommerce.sql symlink resolves to seeds/ecommerce/seed.sql", () => {
    const symlinkPath = path.join(DATA_DIR, "ecommerce.sql");
    expect(fs.existsSync(symlinkPath)).toBe(true);
    const target = fs.readlinkSync(symlinkPath);
    expect(target).toBe("seeds/ecommerce/seed.sql");
  });

  test("demo-semantic symlink resolves to seeds/simple/semantic", () => {
    const symlinkPath = path.join(DATA_DIR, "demo-semantic");
    expect(fs.existsSync(symlinkPath)).toBe(true);
    const target = fs.readlinkSync(symlinkPath);
    expect(target).toBe("seeds/simple/semantic");
  });
});

// ── CLI DEMO_DATASETS config ─────────────────────────────────────────

describe("DEMO_DATASETS config", () => {
  // Import the exported config from CLI
  let DEMO_DATASETS: Record<string, { pg: string; semanticDir: string; label: string }>;
  let parseDemoArg: (args: string[]) => string | null;

  // Use dynamic import since init.ts has heavy deps
  test("DEMO_DATASETS exports are correct", async () => {
    const mod = await import("../../packages/cli/src/commands/init");
    DEMO_DATASETS = mod.DEMO_DATASETS;

    expect(Object.keys(DEMO_DATASETS)).toEqual(["simple", "cybersec", "ecommerce"]);

    // Each dataset should reference seeds/<name>/seed.sql
    for (const [name, meta] of Object.entries(DEMO_DATASETS)) {
      expect(meta.pg).toBe(`seeds/${name}/seed.sql`);
      expect(meta.semanticDir).toBe(`seeds/${name}/semantic`);
      expect(meta.label.length).toBeGreaterThan(0);
    }
  });

  test("parseDemoArg returns null when --demo not present", async () => {
    const mod = await import("../../packages/cli/src/commands/init");
    parseDemoArg = mod.parseDemoArg;

    expect(parseDemoArg(["init"])).toBeNull();
    expect(parseDemoArg(["init", "--enrich"])).toBeNull();
  });

  test("parseDemoArg returns 'simple' for bare --demo", async () => {
    const mod = await import("../../packages/cli/src/commands/init");
    parseDemoArg = mod.parseDemoArg;

    expect(parseDemoArg(["init", "--demo"])).toBe("simple");
  });

  test("parseDemoArg returns specified dataset", async () => {
    const mod = await import("../../packages/cli/src/commands/init");
    parseDemoArg = mod.parseDemoArg;

    expect(parseDemoArg(["init", "--demo", "cybersec"])).toBe("cybersec");
    expect(parseDemoArg(["init", "--demo", "ecommerce"])).toBe("ecommerce");
    expect(parseDemoArg(["init", "--demo", "simple"])).toBe("simple");
  });

  test("parseDemoArg throws for unknown dataset", async () => {
    const mod = await import("../../packages/cli/src/commands/init");
    parseDemoArg = mod.parseDemoArg;

    expect(() => parseDemoArg(["init", "--demo", "unknown"])).toThrow(
      /Unknown demo dataset/,
    );
  });
});

// ── Seed SQL file content checks ─────────────────────────────────────

describe("seed SQL content", () => {
  test("simple seed uses PostgreSQL syntax", () => {
    const sql = fs.readFileSync(path.join(SEEDS_DIR, "simple/seed.sql"), "utf-8");
    expect(sql).toContain("CREATE TABLE");
    expect(sql).toContain("INSERT INTO");
  });

  test("cybersec seed uses generate_series for realistic data", () => {
    const sql = fs.readFileSync(path.join(SEEDS_DIR, "cybersec/seed.sql"), "utf-8");
    expect(sql).toContain("generate_series");
    expect(sql).toContain("CREATE TABLE");
  });

  test("ecommerce seed uses generate_series for realistic data", () => {
    const sql = fs.readFileSync(path.join(SEEDS_DIR, "ecommerce/seed.sql"), "utf-8");
    expect(sql).toContain("generate_series");
    expect(sql).toContain("CREATE TABLE");
  });
});
