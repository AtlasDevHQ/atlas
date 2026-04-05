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

  test("cybersec-semantic symlink resolves to seeds/cybersec/semantic", () => {
    const symlinkPath = path.join(DATA_DIR, "cybersec-semantic");
    expect(fs.existsSync(symlinkPath)).toBe(true);
    const target = fs.readlinkSync(symlinkPath);
    expect(target).toBe("seeds/cybersec/semantic");
  });

  test("ecommerce-semantic symlink resolves to seeds/ecommerce/semantic", () => {
    const symlinkPath = path.join(DATA_DIR, "ecommerce-semantic");
    expect(fs.existsSync(symlinkPath)).toBe(true);
    const target = fs.readlinkSync(symlinkPath);
    expect(target).toBe("seeds/ecommerce/semantic");
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

// ── pruneSeedData ────────────────────────────────────────────────────

import { pruneSeedData } from "../index";
import * as os from "os";

const ALL_SEEDS = ["simple", "cybersec", "ecommerce"] as const;

function createFakeProject(selectedSeed?: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-prune-test-"));
  // Create data/seeds/<name>/ with seed.sql + semantic/entities/
  for (const seed of ALL_SEEDS) {
    const seedDir = path.join(tmpDir, "data", "seeds", seed);
    fs.mkdirSync(path.join(seedDir, "semantic", "entities"), { recursive: true });
    fs.writeFileSync(path.join(seedDir, "seed.sql"), `-- ${seed} seed SQL`);
    fs.writeFileSync(path.join(seedDir, "semantic", "catalog.yml"), `name: ${seed}`);
    fs.writeFileSync(path.join(seedDir, "semantic", "entities", "main.yml"), `table: ${seed}`);
  }
  // Create flat backward-compat SQL files
  fs.writeFileSync(path.join(tmpDir, "data", "demo.sql"), "-- simple");
  fs.writeFileSync(path.join(tmpDir, "data", "simple.sql"), "-- simple");
  fs.writeFileSync(path.join(tmpDir, "data", "cybersec.sql"), "-- cybersec");
  fs.writeFileSync(path.join(tmpDir, "data", "ecommerce.sql"), "-- ecommerce");
  // Create default semantic/ dir (simulates template's simple semantic layer)
  fs.mkdirSync(path.join(tmpDir, "semantic", "entities"), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "semantic", "catalog.yml"), "name: default");
  return tmpDir;
}

describe("pruneSeedData", () => {
  test("selecting cybersec keeps only cybersec seed dir", () => {
    const tmp = createFakeProject();
    pruneSeedData(tmp, "cybersec", ALL_SEEDS);

    expect(fs.existsSync(path.join(tmp, "data", "seeds", "cybersec"))).toBe(true);
    expect(fs.existsSync(path.join(tmp, "data", "seeds", "simple"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, "data", "seeds", "ecommerce"))).toBe(false);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("selecting cybersec overwrites semantic/ with cybersec semantic", () => {
    const tmp = createFakeProject();
    pruneSeedData(tmp, "cybersec", ALL_SEEDS);

    const catalog = fs.readFileSync(path.join(tmp, "semantic", "catalog.yml"), "utf-8");
    expect(catalog).toContain("cybersec");

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("selecting cybersec removes demo.sql flat file", () => {
    const tmp = createFakeProject();
    pruneSeedData(tmp, "cybersec", ALL_SEEDS);

    expect(fs.existsSync(path.join(tmp, "data", "demo.sql"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, "data", "simple.sql"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, "data", "ecommerce.sql"))).toBe(false);
    // cybersec.sql should remain
    expect(fs.existsSync(path.join(tmp, "data", "cybersec.sql"))).toBe(true);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("selecting simple keeps demo.sql (it is a copy of simple/seed.sql)", () => {
    const tmp = createFakeProject();
    pruneSeedData(tmp, "simple", ALL_SEEDS);

    expect(fs.existsSync(path.join(tmp, "data", "demo.sql"))).toBe(true);
    expect(fs.existsSync(path.join(tmp, "data", "cybersec.sql"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, "data", "ecommerce.sql"))).toBe(false);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("handles missing data/seeds/ directory without crashing", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-prune-empty-"));
    fs.mkdirSync(path.join(tmp, "data"), { recursive: true });
    // No seeds dir, no semantic dir — should not throw
    expect(() => pruneSeedData(tmp, "cybersec", ALL_SEEDS)).not.toThrow();

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
