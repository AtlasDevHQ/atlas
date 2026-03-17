import { describe, expect, test } from "bun:test";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as yaml from "js-yaml";
import { generateProposals, loadEntities, loadGlossary, applyProposals } from "../propose";
import type { EntityYaml, GlossaryYaml } from "../propose";
import type { AnalysisResult, ObservedJoin, ObservedPattern, ObservedAlias } from "../analyze";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "atlas-learn-test-"));
}

function writeEntity(dir: string, filename: string, entity: EntityYaml): void {
  const entitiesDir = path.join(dir, "entities");
  fs.mkdirSync(entitiesDir, { recursive: true });
  fs.writeFileSync(
    path.join(entitiesDir, filename),
    yaml.dump(entity, { lineWidth: -1 }),
  );
}

function writeGlossary(dir: string, glossary: GlossaryYaml): void {
  fs.writeFileSync(
    path.join(dir, "glossary.yml"),
    yaml.dump(glossary, { lineWidth: -1 }),
  );
}

function makeAnalysis(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    totalQueries: 100,
    tableUsage: new Map([["users", 50], ["orders", 30]]),
    joins: new Map(),
    patterns: [],
    aliases: [],
    ...overrides,
  };
}

describe("loadEntities", () => {
  test("loads entity YAML files", () => {
    const dir = makeTempDir();
    writeEntity(dir, "users.yml", { table: "users", name: "Users" });
    writeEntity(dir, "orders.yml", { table: "orders", name: "Orders" });

    const entities = loadEntities(path.join(dir, "entities"));
    expect(entities.size).toBe(2);
    expect(entities.has("users")).toBe(true);
    expect(entities.has("orders")).toBe(true);

    fs.rmSync(dir, { recursive: true });
  });

  test("returns empty map for missing directory", () => {
    const entities = loadEntities("/nonexistent/path");
    expect(entities.size).toBe(0);
  });
});

describe("loadGlossary", () => {
  test("loads glossary YAML", () => {
    const dir = makeTempDir();
    writeGlossary(dir, { terms: { revenue: { status: "defined", definition: "Total income" } } });

    const result = loadGlossary(dir);
    expect(result).not.toBeNull();
    expect(result!.glossary.terms.revenue.status).toBe("defined");

    fs.rmSync(dir, { recursive: true });
  });

  test("returns null when no glossary exists", () => {
    const dir = makeTempDir();
    const result = loadGlossary(dir);
    expect(result).toBeNull();
    fs.rmSync(dir, { recursive: true });
  });
});

describe("generateProposals", () => {
  test("proposes new query patterns", () => {
    const dir = makeTempDir();
    writeEntity(dir, "users.yml", {
      table: "users",
      name: "Users",
      query_patterns: [
        { description: "Existing pattern", sql: "SELECT * FROM users" },
      ],
    });

    const entities = loadEntities(path.join(dir, "entities"));
    const analysis = makeAnalysis({
      patterns: [
        {
          sql: "SELECT COUNT(*) FROM users GROUP BY status",
          tables: ["users"],
          count: 5,
          primaryTable: "users",
          description: "Aggregation on users",
        },
      ] satisfies ObservedPattern[],
    });

    const result = generateProposals(analysis, entities, null);
    expect(result.proposals.length).toBe(1);
    expect(result.proposals[0]!.type).toBe("query_pattern");
    expect(result.proposals[0]!.table).toBe("users");

    fs.rmSync(dir, { recursive: true });
  });

  test("skips query patterns that already exist", () => {
    const dir = makeTempDir();
    writeEntity(dir, "users.yml", {
      table: "users",
      name: "Users",
      query_patterns: [
        { description: "Count by status", sql: "SELECT COUNT(*) FROM users GROUP BY status" },
      ],
    });

    const entities = loadEntities(path.join(dir, "entities"));
    const analysis = makeAnalysis({
      patterns: [
        {
          sql: "SELECT COUNT(*) FROM users GROUP BY status",
          tables: ["users"],
          count: 5,
          primaryTable: "users",
          description: "Aggregation on users",
        },
      ] satisfies ObservedPattern[],
    });

    const result = generateProposals(analysis, entities, null);
    expect(result.proposals.length).toBe(0);

    fs.rmSync(dir, { recursive: true });
  });

  test("proposes join discoveries", () => {
    const dir = makeTempDir();
    writeEntity(dir, "users.yml", { table: "users", name: "Users" });
    writeEntity(dir, "orders.yml", { table: "orders", name: "Orders" });

    const entities = loadEntities(path.join(dir, "entities"));
    const joins = new Map<string, ObservedJoin>();
    joins.set("orders::users", {
      fromTable: "orders",
      toTable: "users",
      onClause: "orders.user_id = users.id",
      count: 10,
    });

    const analysis = makeAnalysis({ joins });
    const result = generateProposals(analysis, entities, null);

    const joinProposals = result.proposals.filter((p) => p.type === "join");
    expect(joinProposals.length).toBeGreaterThanOrEqual(1);

    fs.rmSync(dir, { recursive: true });
  });

  test("proposes glossary terms from aliases", () => {
    const dir = makeTempDir();
    writeEntity(dir, "users.yml", {
      table: "users",
      name: "Users",
      dimensions: [{ name: "id", sql: "id", type: "number" }],
    });
    writeGlossary(dir, { terms: {} });

    const entities = loadEntities(path.join(dir, "entities"));
    const glossaryData = loadGlossary(dir);
    const analysis = makeAnalysis({
      aliases: [
        {
          alias: "active_users",
          expression: "COUNT(DISTINCT id)",
          tables: ["users"],
          count: 5,
        },
      ] satisfies ObservedAlias[],
    });

    const result = generateProposals(analysis, entities, glossaryData);
    const glossaryProposals = result.proposals.filter((p) => p.type === "glossary_term");
    expect(glossaryProposals.length).toBe(1);

    fs.rmSync(dir, { recursive: true });
  });
});

describe("applyProposals", () => {
  test("writes updated entity files", () => {
    const dir = makeTempDir();
    writeEntity(dir, "users.yml", {
      table: "users",
      name: "Users",
    });

    const entities = loadEntities(path.join(dir, "entities"));
    const analysis = makeAnalysis({
      patterns: [
        {
          sql: "SELECT COUNT(*) FROM users",
          tables: ["users"],
          count: 5,
          primaryTable: "users",
          description: "Count users",
        },
      ] satisfies ObservedPattern[],
    });

    const proposalSet = generateProposals(analysis, entities, null);
    const written = applyProposals(proposalSet);
    expect(written.length).toBe(1);

    // Verify the file was updated
    const content = fs.readFileSync(written[0]!, "utf-8");
    const parsed = yaml.load(content) as EntityYaml;
    expect(parsed.query_patterns).toBeDefined();
    expect(parsed.query_patterns!.length).toBe(1);

    fs.rmSync(dir, { recursive: true });
  });
});
