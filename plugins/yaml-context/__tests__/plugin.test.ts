import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { definePlugin, isContextPlugin } from "@useatlas/plugin-sdk";
import {
  contextYamlPlugin,
  buildContextYamlPlugin,
  readEntitySummaries,
  readGlossaryTerms,
  readMetricSummaries,
  buildContextString,
} from "../index";

// ---------------------------------------------------------------------------
// Test fixtures — temporary semantic directory
// ---------------------------------------------------------------------------

let tmpDir: string;
let semanticDir: string;

const ENTITY_YAML = `
table: companies
description: |
  Company records. Each row is a unique company.
dimensions:
  id:
    type: integer
    description: Primary key
  name:
    type: text
    description: Company name
    sample_values: [Acme, Globex, Initech]
  revenue:
    type: numeric
    description: Annual revenue in USD
`;

const ENTITY_YAML_2 = `
table: people
description: Contact records for each company.
dimensions:
  id:
    type: integer
    description: Primary key
  full_name:
    type: text
    description: Full name
`;

const GLOSSARY_YAML = `
terms:
  - term: revenue
    status: defined
    definition: Annual revenue in USD from the companies table.
  - term: size
    status: ambiguous
    definition: Could refer to company headcount or revenue bracket.
`;

const METRIC_YAML = `
entity: companies
metrics:
  - name: total_revenue
    description: Sum of annual revenue across all companies.
  - name: company_count
    description: Total number of companies.
`;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-context-yaml-test-"));
  semanticDir = path.join(tmpDir, "semantic");

  // Create directory structure
  fs.mkdirSync(path.join(semanticDir, "entities"), { recursive: true });
  fs.mkdirSync(path.join(semanticDir, "metrics"), { recursive: true });

  // Write test fixtures
  fs.writeFileSync(
    path.join(semanticDir, "entities", "companies.yml"),
    ENTITY_YAML,
  );
  fs.writeFileSync(
    path.join(semanticDir, "entities", "people.yml"),
    ENTITY_YAML_2,
  );
  fs.writeFileSync(path.join(semanticDir, "glossary.yml"), GLOSSARY_YAML);
  fs.writeFileSync(
    path.join(semanticDir, "metrics", "companies.yml"),
    METRIC_YAML,
  );
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper: mock AtlasPluginContext for initialize()
// ---------------------------------------------------------------------------

function makeMockCtx() {
  const logged: string[] = [];
  return {
    ctx: {
      db: null,
      connections: {
        get: () => {
          throw new Error("not implemented");
        },
        list: () => [],
      },
      tools: { register: () => {} },
      logger: {
        info: (msg: string) => logged.push(msg),
        warn: (msg: string) => logged.push(msg),
        error: (msg: string) => logged.push(msg),
        debug: (msg: string) => logged.push(msg),
      },
      config: {},
    },
    logged,
  };
}

// ---------------------------------------------------------------------------
// Plugin shape validation
// ---------------------------------------------------------------------------

describe("plugin shape", () => {
  test("contextYamlPlugin() produces a valid AtlasContextPlugin", () => {
    const plugin = contextYamlPlugin({ semanticDir });
    expect(plugin.id).toBe("context-yaml");
    expect(plugin.type).toBe("context");
    expect(plugin.version).toBe("0.1.0");
    expect(plugin.name).toBe("YAML Semantic Layer Context");
  });

  test("definePlugin() accepts the built plugin", () => {
    const plugin = buildContextYamlPlugin({ semanticDir });
    const validated = definePlugin(plugin);
    expect(validated).toBe(plugin);
  });

  test("isContextPlugin type guard returns true", () => {
    const plugin = contextYamlPlugin({ semanticDir });
    expect(isContextPlugin(plugin)).toBe(true);
  });

  test("contextProvider has load and refresh methods", () => {
    const plugin = contextYamlPlugin({ semanticDir });
    expect(typeof plugin.contextProvider.load).toBe("function");
    expect(typeof plugin.contextProvider.refresh).toBe("function");
  });

  test("config is stored on the plugin object", () => {
    const config = { semanticDir: "/some/path" };
    const plugin = contextYamlPlugin(config);
    expect(plugin.config).toEqual(config);
  });

  test("defaults semanticDir when not provided", () => {
    const plugin = contextYamlPlugin();
    expect(plugin.config).toEqual({});
  });

  test("plugin has all fields required for config validation", () => {
    const plugin = contextYamlPlugin({ semanticDir });
    expect(typeof plugin.id).toBe("string");
    expect(plugin.id.trim().length).toBeGreaterThan(0);
    expect(["datasource", "context", "interaction", "action"]).toContain(
      plugin.type,
    );
    expect(typeof plugin.version).toBe("string");
    expect(plugin.version.trim().length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// YAML readers
// ---------------------------------------------------------------------------

describe("readEntitySummaries", () => {
  test("reads entity files from the entities directory", () => {
    const entities = readEntitySummaries(semanticDir);
    expect(entities).toHaveLength(2);
  });

  test("extracts table name and description", () => {
    const entities = readEntitySummaries(semanticDir);
    const companies = entities.find((e) => e.table === "companies");
    expect(companies).toBeDefined();
    expect(companies!.description).toContain("Company records");
  });

  test("counts dimensions", () => {
    const entities = readEntitySummaries(semanticDir);
    const companies = entities.find((e) => e.table === "companies");
    expect(companies!.dimensionCount).toBe(3); // id, name, revenue
  });

  test("returns empty array for nonexistent directory", () => {
    const entities = readEntitySummaries("/nonexistent/path");
    expect(entities).toEqual([]);
  });

  test("returns empty array when entities/ subdirectory is missing", () => {
    const emptyDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "atlas-ctx-empty-"),
    );
    try {
      const entities = readEntitySummaries(emptyDir);
      expect(entities).toEqual([]);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

describe("readGlossaryTerms", () => {
  test("reads glossary terms from glossary.yml", () => {
    const terms = readGlossaryTerms(semanticDir);
    expect(terms).toHaveLength(2);
  });

  test("extracts term name, status, and definition", () => {
    const terms = readGlossaryTerms(semanticDir);
    const revenue = terms.find((t) => t.term === "revenue");
    expect(revenue).toBeDefined();
    expect(revenue!.status).toBe("defined");
    expect(revenue!.definition).toContain("Annual revenue");
  });

  test("captures ambiguous status", () => {
    const terms = readGlossaryTerms(semanticDir);
    const size = terms.find((t) => t.term === "size");
    expect(size).toBeDefined();
    expect(size!.status).toBe("ambiguous");
  });

  test("returns empty array when glossary.yml is missing", () => {
    const emptyDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "atlas-ctx-no-gloss-"),
    );
    try {
      const terms = readGlossaryTerms(emptyDir);
      expect(terms).toEqual([]);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

describe("readMetricSummaries", () => {
  test("reads metrics from the metrics directory", () => {
    const metrics = readMetricSummaries(semanticDir);
    expect(metrics).toHaveLength(2);
  });

  test("extracts metric name, description, and entity", () => {
    const metrics = readMetricSummaries(semanticDir);
    const totalRevenue = metrics.find((m) => m.name === "total_revenue");
    expect(totalRevenue).toBeDefined();
    expect(totalRevenue!.description).toContain("Sum of annual revenue");
    expect(totalRevenue!.entity).toBe("companies");
  });

  test("returns empty array for nonexistent directory", () => {
    const metrics = readMetricSummaries("/nonexistent/path");
    expect(metrics).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Context string builder
// ---------------------------------------------------------------------------

describe("buildContextString", () => {
  test("includes table summaries", () => {
    const context = buildContextString(
      [{ table: "orders", description: "Order records", dimensionCount: 5 }],
      [],
      [],
    );
    expect(context).toContain("**orders**");
    expect(context).toContain("5 dimensions");
    expect(context).toContain("Order records");
  });

  test("includes glossary terms with ambiguous marker", () => {
    const context = buildContextString(
      [],
      [{ term: "size", status: "ambiguous", definition: "Could be many things" }],
      [],
    );
    expect(context).toContain("**size**");
    expect(context).toContain("*(ambiguous)*");
  });

  test("includes metric summaries with entity", () => {
    const context = buildContextString(
      [],
      [],
      [{ name: "total_sales", description: "Sum of sales", entity: "orders" }],
    );
    expect(context).toContain("**total_sales**");
    expect(context).toContain("(orders)");
  });

  test("returns empty string when no data", () => {
    expect(buildContextString([], [], [])).toBe("");
  });

  test("combines all sections under a single heading", () => {
    const context = buildContextString(
      [{ table: "t", dimensionCount: 1 }],
      [{ term: "x" }],
      [{ name: "m" }],
    );
    expect(context).toContain("## Semantic Layer Context");
    expect(context).toContain("### Available Tables");
    expect(context).toContain("### Glossary");
    expect(context).toContain("### Metrics");
  });
});

// ---------------------------------------------------------------------------
// Context loading (integration)
// ---------------------------------------------------------------------------

describe("contextProvider.load", () => {
  test("returns formatted context string from YAML files", async () => {
    const plugin = contextYamlPlugin({ semanticDir });
    const context = await plugin.contextProvider.load();

    expect(context).toContain("## Semantic Layer Context");
    expect(context).toContain("**companies**");
    expect(context).toContain("**people**");
    expect(context).toContain("**revenue**");
    expect(context).toContain("**total_revenue**");
  });

  test("caches result across multiple calls", async () => {
    const plugin = contextYamlPlugin({ semanticDir });
    const first = await plugin.contextProvider.load();
    const second = await plugin.contextProvider.load();
    // Same reference (cached)
    expect(first).toBe(second);
  });

  test("refresh clears the cache and picks up new files", async () => {
    const refreshDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "atlas-ctx-refresh-"),
    );
    try {
      fs.mkdirSync(path.join(refreshDir, "entities"), { recursive: true });
      fs.writeFileSync(
        path.join(refreshDir, "entities", "companies.yml"),
        ENTITY_YAML,
      );

      const plugin = contextYamlPlugin({ semanticDir: refreshDir });
      const first = await plugin.contextProvider.load();
      expect(first).toContain("**companies**");
      expect(first).not.toContain("**orders**");

      // Add a new entity file after initial load
      fs.writeFileSync(
        path.join(refreshDir, "entities", "orders.yml"),
        "table: orders\ndescription: Order records\ndimensions:\n  id:\n    type: integer\n",
      );

      // Without refresh, cache still returns old content
      const cached = await plugin.contextProvider.load();
      expect(cached).not.toContain("**orders**");

      // After refresh, new file is picked up
      await plugin.contextProvider.refresh!();
      const refreshed = await plugin.contextProvider.load();
      expect(refreshed).toContain("**orders**");
      expect(refreshed).toContain("**companies**");
    } finally {
      fs.rmSync(refreshDir, { recursive: true, force: true });
    }
  });

  test("returns empty string for empty semantic directory", async () => {
    const emptyDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "atlas-ctx-empty-load-"),
    );
    try {
      fs.mkdirSync(path.join(emptyDir, "entities"), { recursive: true });
      const plugin = contextYamlPlugin({ semanticDir: emptyDir });
      const context = await plugin.contextProvider.load();
      expect(context).toBe("");
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

describe("healthCheck", () => {
  test("returns healthy when semantic directory has entity files", async () => {
    const plugin = contextYamlPlugin({ semanticDir });
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(true);
    expect(result.message).toContain("2 entity file(s) found");
  });

  test("returns unhealthy when semantic directory does not exist", async () => {
    const plugin = contextYamlPlugin({
      semanticDir: "/nonexistent/semantic",
    });
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(false);
    expect(result.message).toContain("Semantic directory not found");
  });

  test("returns unhealthy when entities subdirectory is missing", async () => {
    const noEntitiesDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "atlas-ctx-no-entities-"),
    );
    try {
      const plugin = contextYamlPlugin({ semanticDir: noEntitiesDir });
      const result = await plugin.healthCheck!();
      expect(result.healthy).toBe(false);
      expect(result.message).toContain("Entities directory not found");
    } finally {
      fs.rmSync(noEntitiesDir, { recursive: true, force: true });
    }
  });

  test("returns unhealthy when entities directory is empty", async () => {
    const emptyEntitiesDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "atlas-ctx-empty-entities-"),
    );
    try {
      fs.mkdirSync(path.join(emptyEntitiesDir, "entities"), {
        recursive: true,
      });
      const plugin = contextYamlPlugin({ semanticDir: emptyEntitiesDir });
      const result = await plugin.healthCheck!();
      expect(result.healthy).toBe(false);
      expect(result.message).toContain("No entity YAML files found");
    } finally {
      fs.rmSync(emptyEntitiesDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

describe("initialize", () => {
  test("logs the semantic directory path", async () => {
    const plugin = contextYamlPlugin({ semanticDir });
    const { ctx, logged } = makeMockCtx();
    await plugin.initialize!(ctx as never);
    const msg = logged.find((m) =>
      m.includes("Context-YAML plugin initialized"),
    );
    expect(msg).toBeDefined();
    expect(msg).toContain(semanticDir);
  });

  test("logs health check warning when unhealthy", async () => {
    const plugin = contextYamlPlugin({ semanticDir: "/nonexistent/dir" });
    const { ctx, logged } = makeMockCtx();
    await plugin.initialize!(ctx as never);
    const warning = logged.find((m) =>
      m.includes("[context-yaml] Health check warning"),
    );
    expect(warning).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Malformed YAML handling
// ---------------------------------------------------------------------------

describe("malformed YAML handling", () => {
  test("entity file with invalid YAML syntax is skipped", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-ctx-bad-yaml-"));
    try {
      fs.mkdirSync(path.join(dir, "entities"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, "entities", "good.yml"),
        ENTITY_YAML,
      );
      fs.writeFileSync(
        path.join(dir, "entities", "bad.yml"),
        "table: broken\n  invalid:\nindent: [[[",
      );
      const entities = readEntitySummaries(dir);
      expect(entities).toHaveLength(1);
      expect(entities[0].table).toBe("companies");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("entity file with missing table field is skipped", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-ctx-no-table-"));
    try {
      fs.mkdirSync(path.join(dir, "entities"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, "entities", "no-table.yml"),
        "description: Missing table field\ndimensions:\n  id:\n    type: integer\n",
      );
      const entities = readEntitySummaries(dir);
      expect(entities).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("entity file with no dimensions key has dimensionCount 0", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-ctx-no-dims-"));
    try {
      fs.mkdirSync(path.join(dir, "entities"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, "entities", "minimal.yml"),
        "table: minimal\ndescription: No dimensions\n",
      );
      const entities = readEntitySummaries(dir);
      expect(entities).toHaveLength(1);
      expect(entities[0].dimensionCount).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("glossary with malformed YAML returns empty array", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-ctx-bad-gloss-"));
    try {
      fs.writeFileSync(
        path.join(dir, "glossary.yml"),
        "terms: [[[invalid yaml",
      );
      const terms = readGlossaryTerms(dir);
      expect(terms).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("glossary with terms not an array returns empty array", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-ctx-terms-obj-"));
    try {
      fs.writeFileSync(
        path.join(dir, "glossary.yml"),
        "terms: not-an-array\n",
      );
      const terms = readGlossaryTerms(dir);
      expect(terms).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("metric file with invalid YAML is skipped, valid files still returned", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-ctx-bad-metric-"));
    try {
      fs.mkdirSync(path.join(dir, "metrics"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, "metrics", "good.yml"),
        METRIC_YAML,
      );
      fs.writeFileSync(
        path.join(dir, "metrics", "bad.yml"),
        "entity: broken\n  metrics: [[[",
      );
      const metrics = readMetricSummaries(dir);
      expect(metrics).toHaveLength(2); // total_revenue + company_count from good.yml
      expect(metrics.find((m) => m.name === "total_revenue")).toBeDefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("metric file with no metrics array is skipped", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-ctx-no-metrics-"));
    try {
      fs.mkdirSync(path.join(dir, "metrics"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, "metrics", "empty.yml"),
        "entity: orders\n",
      );
      const metrics = readMetricSummaries(dir);
      expect(metrics).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// buildContextString edge cases
// ---------------------------------------------------------------------------

describe("buildContextString edge cases", () => {
  test("non-ambiguous glossary status has no ambiguous marker", () => {
    const context = buildContextString(
      [],
      [{ term: "revenue", status: "defined", definition: "Total income" }],
      [],
    );
    expect(context).toContain("**revenue**");
    expect(context).not.toContain("*(ambiguous)*");
    expect(context).toContain("Total income");
  });

  test("entity with missing optional fields has no trailing artifacts", () => {
    const context = buildContextString(
      [{ table: "raw_events", dimensionCount: 0 }],
      [],
      [],
    );
    expect(context).toContain("**raw_events** (0 dimensions)");
    // No trailing " — " when description is missing
    expect(context).not.toContain(" — \n");
    expect(context).not.toContain(" — `");
  });
});
