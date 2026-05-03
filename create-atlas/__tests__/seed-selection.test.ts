/**
 * Tests for the canonical demo dataset.
 *
 * Atlas ships a single canonical demo seed (NovaMart e-commerce). The previous
 * multi-seed picker (`simple` / `cybersec` / `ecommerce`) was reverted in
 * 1.4.0 (#2021). These tests guard the new contract:
 *
 *   - The ecommerce seed structure on disk
 *   - parseDemoArg returns a boolean and rejects legacy seed names
 *   - The --seed flag is fully removed
 */

import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";

const DATA_DIR = path.resolve(import.meta.dir, "../../packages/cli/data");
const SEEDS_DIR = path.join(DATA_DIR, "seeds");
const ECOMMERCE_DIR = path.join(SEEDS_DIR, "ecommerce");

// ── Seed directory structure ─────────────────────────────────────────

describe("canonical ecommerce seed", () => {
  test("seeds/ contains only ecommerce/", () => {
    expect(fs.existsSync(SEEDS_DIR)).toBe(true);
    const entries = fs.readdirSync(SEEDS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    expect(entries).toEqual(["ecommerce"]);
  });

  test("seeds/ecommerce/seed.sql exists and is non-trivial", () => {
    const sqlPath = path.join(ECOMMERCE_DIR, "seed.sql");
    expect(fs.existsSync(sqlPath)).toBe(true);
    expect(fs.statSync(sqlPath).size).toBeGreaterThan(1000);
  });

  test("seeds/ecommerce/seed.sql uses PostgreSQL syntax", () => {
    const sql = fs.readFileSync(path.join(ECOMMERCE_DIR, "seed.sql"), "utf-8");
    expect(sql).toContain("CREATE TABLE");
    expect(sql).toContain("generate_series");
  });

  test("seeds/ecommerce/semantic/ has entities, catalog, glossary", () => {
    const semantic = path.join(ECOMMERCE_DIR, "semantic");
    expect(fs.existsSync(path.join(semantic, "entities"))).toBe(true);
    expect(fs.existsSync(path.join(semantic, "catalog.yml"))).toBe(true);
    expect(fs.existsSync(path.join(semantic, "glossary.yml"))).toBe(true);

    const entities = fs.readdirSync(path.join(semantic, "entities"))
      .filter((f) => f.endsWith(".yml"));
    expect(entities.length).toBeGreaterThan(0);
  });
});

// ── CLI DEMO_DATASET config ──────────────────────────────────────────

describe("CLI DEMO_DATASET", () => {
  test("DEMO_DATASET points at the ecommerce seed", async () => {
    const mod = await import("../../packages/cli/src/commands/init");
    expect(mod.DEMO_DATASET.pg).toBe("seeds/ecommerce/seed.sql");
    expect(mod.DEMO_DATASET.semanticDir).toBe("seeds/ecommerce/semantic");
    expect(mod.DEMO_DATASET.label.length).toBeGreaterThan(0);
  });

  test("parseDemoArg returns false when --demo not present", async () => {
    const { parseDemoArg } = await import("../../packages/cli/src/commands/init");
    expect(parseDemoArg(["init"])).toBe(false);
    expect(parseDemoArg(["init", "--enrich"])).toBe(false);
  });

  test("parseDemoArg returns true for bare --demo", async () => {
    const { parseDemoArg } = await import("../../packages/cli/src/commands/init");
    expect(parseDemoArg(["init", "--demo"])).toBe(true);
  });

  test("parseDemoArg accepts --demo ecommerce for backward compat", async () => {
    const { parseDemoArg } = await import("../../packages/cli/src/commands/init");
    expect(parseDemoArg(["init", "--demo", "ecommerce"])).toBe(true);
  });

  test("parseDemoArg rejects legacy --demo simple with migration message", async () => {
    const { parseDemoArg } = await import("../../packages/cli/src/commands/init");
    expect(() => parseDemoArg(["init", "--demo", "simple"])).toThrow(
      /removed in 1\.4\.0/,
    );
  });

  test("parseDemoArg rejects legacy --demo cybersec with migration message", async () => {
    const { parseDemoArg } = await import("../../packages/cli/src/commands/init");
    expect(() => parseDemoArg(["init", "--demo", "cybersec"])).toThrow(
      /removed in 1\.4\.0/,
    );
  });

  test("parseDemoArg rejects unknown dataset values", async () => {
    const { parseDemoArg } = await import("../../packages/cli/src/commands/init");
    expect(() => parseDemoArg(["init", "--demo", "unknown"])).toThrow(
      /Unknown demo value/,
    );
  });

  test("--seed flag is fully removed and throws a migration error", async () => {
    const { parseDemoArg } = await import("../../packages/cli/src/commands/init");
    expect(() => parseDemoArg(["init", "--seed"])).toThrow(
      /--seed flag was removed in 1\.4\.0/,
    );
    expect(() => parseDemoArg(["init", "--seed", "ecommerce"])).toThrow(
      /--seed flag was removed in 1\.4\.0/,
    );
  });
});
