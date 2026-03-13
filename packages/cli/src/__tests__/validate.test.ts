import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";

// Mock @clack/prompts — must mock ALL named exports
import { mock } from "bun:test";

mock.module("@clack/prompts", () => ({
  intro: () => {},
  outro: () => {},
  cancel: () => {},
  confirm: async () => false,
  text: async () => "",
  select: async () => "",
  selectKey: async () => "",
  multiselect: async () => [],
  group: async () => ({}),
  groupMultiselect: async () => [],
  note: () => {},
  spinner: () => ({ start: () => {}, stop: () => {} }),
  stream: { info: () => {} },
  tasks: async () => {},
  password: async () => "",
  isCancel: () => false,
  log: { info: () => {}, warn: () => {}, error: () => {}, step: () => {}, success: () => {}, message: () => {} },
  updateSettings: () => {},
}));

mock.module("picocolors", () => ({
  default: {
    green: (s: string) => s,
    red: (s: string) => s,
    yellow: (s: string) => s,
    bold: (s: string) => s,
    dim: (s: string) => s,
    blue: (s: string) => s,
    cyan: (s: string) => s,
    white: (s: string) => s,
    gray: (s: string) => s,
    magenta: (s: string) => s,
    underline: (s: string) => s,
    italic: (s: string) => s,
    strikethrough: (s: string) => s,
    inverse: (s: string) => s,
    hidden: (s: string) => s,
    reset: (s: string) => s,
    bgRed: (s: string) => s,
    bgGreen: (s: string) => s,
    bgYellow: (s: string) => s,
    bgBlue: (s: string) => s,
    bgMagenta: (s: string) => s,
    bgCyan: (s: string) => s,
    bgWhite: (s: string) => s,
    isColorSupported: false,
    createColors: () => ({}),
  },
}));

import {
  checkConfig,
  checkEntities,
  checkGlossary,
  checkCatalog,
  checkMetrics,
  checkCrossReferences,
  renderValidateResults,
  renderValidateSections,
  runValidate,
  type ValidateResult,
  type ValidateSection,
} from "../validate";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string | null = null;

beforeEach(() => {});

afterEach(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

function makeTmpDir(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-validate-test-"));
  return tmpDir;
}

function createSemanticDir(
  base: string,
  opts: {
    entities?: Record<string, string>;
    metrics?: Record<string, string>;
    glossary?: string;
    catalog?: string;
    sources?: Record<string, { entities?: Record<string, string>; metrics?: Record<string, string> }>;
  } = {},
): string {
  const semanticDir = path.join(base, "semantic");
  const entDir = path.join(semanticDir, "entities");
  const metDir = path.join(semanticDir, "metrics");
  fs.mkdirSync(entDir, { recursive: true });
  fs.mkdirSync(metDir, { recursive: true });

  if (opts.entities) {
    for (const [name, content] of Object.entries(opts.entities)) {
      fs.writeFileSync(path.join(entDir, name), content);
    }
  }

  if (opts.metrics) {
    for (const [name, content] of Object.entries(opts.metrics)) {
      fs.writeFileSync(path.join(metDir, name), content);
    }
  }

  if (opts.glossary) {
    fs.writeFileSync(path.join(semanticDir, "glossary.yml"), opts.glossary);
  }

  if (opts.catalog) {
    fs.writeFileSync(path.join(semanticDir, "catalog.yml"), opts.catalog);
  }

  if (opts.sources) {
    for (const [source, srcOpts] of Object.entries(opts.sources)) {
      if (srcOpts.entities) {
        const srcEntDir = path.join(semanticDir, source, "entities");
        fs.mkdirSync(srcEntDir, { recursive: true });
        for (const [name, content] of Object.entries(srcOpts.entities)) {
          fs.writeFileSync(path.join(srcEntDir, name), content);
        }
      }
      if (srcOpts.metrics) {
        const srcMetDir = path.join(semanticDir, source, "metrics");
        fs.mkdirSync(srcMetDir, { recursive: true });
        for (const [name, content] of Object.entries(srcOpts.metrics)) {
          fs.writeFileSync(path.join(srcMetDir, name), content);
        }
      }
    }
  }

  return semanticDir;
}

async function withCwd<T>(dir: string, fn: () => T | Promise<T>): Promise<T> {
  const orig = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(orig);
  }
}

// ---------------------------------------------------------------------------
// checkConfig
// ---------------------------------------------------------------------------

describe("checkConfig", () => {
  test("pass when no config file exists", async () => {
    const dir = makeTmpDir();
    const result = await withCwd(dir, () => checkConfig());
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("Not present");
  });

  test("pass with valid config file", async () => {
    const dir = makeTmpDir();
    fs.writeFileSync(
      path.join(dir, "atlas.config.ts"),
      'import { defineConfig } from "@atlas/api/lib/config";\nexport default defineConfig({ tools: ["explore"] });\n',
    );
    const result = await withCwd(dir, () => checkConfig());
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("defineConfig");
  });

  test("warn when no default export", async () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, "atlas.config.ts"), "const x = 1;\n");
    const result = await withCwd(dir, () => checkConfig());
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("No default export");
  });

  test("fail when file is empty", async () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, "atlas.config.ts"), "");
    const result = await withCwd(dir, () => checkConfig());
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("empty");
  });
});

// ---------------------------------------------------------------------------
// checkEntities
// ---------------------------------------------------------------------------

describe("checkEntities", () => {
  test("fail when no entity files exist", () => {
    const dir = makeTmpDir();
    const semanticDir = createSemanticDir(dir);
    const { results, entities } = checkEntities(semanticDir);
    expect(entities.length).toBe(0);
    expect(results[0].status).toBe("fail");
    expect(results[0].detail).toContain("No entity files");
  });

  test("pass with valid entity files", () => {
    const dir = makeTmpDir();
    const semanticDir = createSemanticDir(dir, {
      entities: {
        "users.yml": [
          "table: users",
          "description: User accounts",
          "dimensions:",
          "  id:",
          "    type: integer",
          "    description: User ID",
          "  name:",
          "    type: string",
          "    description: User name",
          "    sample_values: [Alice, Bob]",
        ].join("\n"),
        "orders.yml": [
          "table: orders",
          "dimensions:",
          "  id:",
          "    type: integer",
          "    description: Order ID",
        ].join("\n"),
      },
    });
    const { results, entities } = checkEntities(semanticDir);
    expect(entities.length).toBe(2);
    expect(results[0].status).toBe("pass");
    expect(results[0].detail).toContain("2 entities parsed");
  });

  test("fail on invalid YAML syntax", () => {
    const dir = makeTmpDir();
    const semanticDir = createSemanticDir(dir, {
      entities: {
        "bad.yml": ": invalid yaml [",
      },
    });
    const { results } = checkEntities(semanticDir);
    const errorResult = results.find((r) => r.status === "fail" && r.detail.includes("Invalid YAML"));
    expect(errorResult).toBeTruthy();
  });

  test("fail when table field is missing", () => {
    const dir = makeTmpDir();
    const semanticDir = createSemanticDir(dir, {
      entities: {
        "no_table.yml": "description: Missing table field\ndimensions:\n  id:\n    type: string\n",
      },
    });
    const { results } = checkEntities(semanticDir);
    const errorResult = results.find((r) => r.status === "fail" && r.detail.includes('"table"'));
    expect(errorResult).toBeTruthy();
  });

  test("fail when dimensions field is missing", () => {
    const dir = makeTmpDir();
    const semanticDir = createSemanticDir(dir, {
      entities: {
        "no_dims.yml": "table: no_dims\ndescription: Missing dimensions\n",
      },
    });
    const { results } = checkEntities(semanticDir);
    const errorResult = results.find((r) => r.status === "fail" && r.detail.includes('"dimensions"'));
    expect(errorResult).toBeTruthy();
  });

  test("warn on missing description for dimension", () => {
    const dir = makeTmpDir();
    const semanticDir = createSemanticDir(dir, {
      entities: {
        "orders.yml": [
          "table: orders",
          "dimensions:",
          "  status:",
          "    type: string",
        ].join("\n"),
      },
    });
    const { results } = checkEntities(semanticDir);
    const warnResult = results.find((r) => r.status === "warn" && r.detail.includes("description"));
    expect(warnResult).toBeTruthy();
    expect(warnResult!.detail).toContain('"status"');
  });

  test("warn on empty sample_values", () => {
    const dir = makeTmpDir();
    const semanticDir = createSemanticDir(dir, {
      entities: {
        "users.yml": [
          "table: users",
          "dimensions:",
          "  role:",
          "    type: string",
          "    description: User role",
          "    sample_values: []",
        ].join("\n"),
      },
    });
    const { results } = checkEntities(semanticDir);
    const warnResult = results.find((r) => r.status === "warn" && r.detail.includes("sample_values"));
    expect(warnResult).toBeTruthy();
    expect(warnResult!.detail).toContain('"role"');
  });

  test("warn on dimension missing type", () => {
    const dir = makeTmpDir();
    const semanticDir = createSemanticDir(dir, {
      entities: {
        "items.yml": [
          "table: items",
          "dimensions:",
          "  name:",
          "    description: Item name",
        ].join("\n"),
      },
    });
    const { results } = checkEntities(semanticDir);
    const warnResult = results.find((r) => r.status === "warn" && r.detail.includes('"type"'));
    expect(warnResult).toBeTruthy();
  });

  test("handles per-source subdirectory entities", () => {
    const dir = makeTmpDir();
    const semanticDir = createSemanticDir(dir, {
      entities: {
        "main.yml": "table: main\ndimensions:\n  id:\n    type: integer\n    description: ID\n",
      },
      sources: {
        warehouse: {
          entities: {
            "products.yml": "table: products\ndimensions:\n  id:\n    type: integer\n    description: ID\n",
          },
        },
      },
    });
    const { entities } = checkEntities(semanticDir);
    expect(entities.length).toBe(2);
    expect(entities.some((e) => e.table === "products")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkGlossary
// ---------------------------------------------------------------------------

describe("checkGlossary", () => {
  test("pass when glossary does not exist", () => {
    const dir = makeTmpDir();
    const semanticDir = createSemanticDir(dir);
    const result = checkGlossary(semanticDir);
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("Not present");
  });

  test("pass with valid glossary", () => {
    const dir = makeTmpDir();
    const semanticDir = createSemanticDir(dir, {
      glossary: "term1:\n  definition: First term\nterm2:\n  definition: Second term\n",
    });
    const result = checkGlossary(semanticDir);
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("2 terms");
  });

  test("fail on invalid YAML", () => {
    const dir = makeTmpDir();
    const semanticDir = createSemanticDir(dir, {
      glossary: ": broken [yaml",
    });
    const result = checkGlossary(semanticDir);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("Invalid YAML");
  });
});

// ---------------------------------------------------------------------------
// checkCatalog
// ---------------------------------------------------------------------------

describe("checkCatalog", () => {
  test("pass when catalog does not exist", () => {
    const dir = makeTmpDir();
    const semanticDir = createSemanticDir(dir);
    const result = checkCatalog(semanticDir);
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("Not present");
  });

  test("pass with valid catalog", () => {
    const dir = makeTmpDir();
    const semanticDir = createSemanticDir(dir, {
      catalog: "tables:\n  - users\n  - orders\n",
    });
    const result = checkCatalog(semanticDir);
    expect(result.status).toBe("pass");
    expect(result.detail).toBe("Valid");
  });

  test("fail on invalid YAML", () => {
    const dir = makeTmpDir();
    const semanticDir = createSemanticDir(dir, {
      catalog: "bad: [yaml: {{",
    });
    const result = checkCatalog(semanticDir);
    expect(result.status).toBe("fail");
  });
});

// ---------------------------------------------------------------------------
// checkMetrics
// ---------------------------------------------------------------------------

describe("checkMetrics", () => {
  test("no results when no metric files exist", () => {
    const dir = makeTmpDir();
    const semanticDir = createSemanticDir(dir);
    const { results, metrics } = checkMetrics(semanticDir);
    expect(metrics.length).toBe(0);
    // No summary line when there are no metric files
    expect(results.length).toBe(0);
  });

  test("pass with valid metric files", () => {
    const dir = makeTmpDir();
    const semanticDir = createSemanticDir(dir, {
      metrics: {
        "revenue.yml": "metric: total_revenue\ntable: orders\n",
        "users.yml": "metric: active_users\ntable: users\n",
      },
    });
    const { results, metrics } = checkMetrics(semanticDir);
    expect(metrics.length).toBe(2);
    expect(results[0].status).toBe("pass");
    expect(results[0].detail).toContain("2 metrics parsed");
  });

  test("fail on invalid YAML in metrics", () => {
    const dir = makeTmpDir();
    const semanticDir = createSemanticDir(dir, {
      metrics: {
        "bad.yml": ": broken [yaml",
        "good.yml": "metric: ok\ntable: users\n",
      },
    });
    const { results, metrics } = checkMetrics(semanticDir);
    expect(metrics.length).toBe(1);
    const errorResult = results.find((r) => r.status === "fail" && r.detail.includes("Invalid YAML"));
    expect(errorResult).toBeTruthy();
  });

  test("handles per-source subdirectory metrics", () => {
    const dir = makeTmpDir();
    const semanticDir = createSemanticDir(dir, {
      metrics: {
        "main.yml": "metric: main_metric\ntable: main\n",
      },
      sources: {
        warehouse: {
          metrics: {
            "products.yml": "metric: product_count\ntable: products\n",
          },
        },
      },
    });
    const { metrics } = checkMetrics(semanticDir);
    expect(metrics.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// checkCrossReferences
// ---------------------------------------------------------------------------

describe("checkCrossReferences", () => {
  test("no errors when all join targets exist", () => {
    const entities = [
      {
        file: "entities/users.yml",
        table: "users",
        dimensions: { id: { type: "integer" } },
        joins: { orders: { description: "user orders" } },
      },
      {
        file: "entities/orders.yml",
        table: "orders",
        dimensions: { id: { type: "integer" } },
      },
    ];
    const results = checkCrossReferences(entities, []);
    const errors = results.filter((r) => r.status === "fail");
    expect(errors.length).toBe(0);
  });

  test("fail when join target does not exist", () => {
    const entities = [
      {
        file: "entities/users.yml",
        table: "users",
        dimensions: { id: { type: "integer" } },
        joins: { nonexistent_table: { description: "bad join" } },
      },
    ];
    const results = checkCrossReferences(entities, []);
    const errors = results.filter((r) => r.status === "fail");
    expect(errors.length).toBe(1);
    expect(errors[0].detail).toContain("nonexistent_table");
  });

  test("fail when metric references unknown table", () => {
    const entities = [
      {
        file: "entities/users.yml",
        table: "users",
        dimensions: { id: { type: "integer" } },
      },
    ];
    const metrics = [
      { file: "metrics/revenue.yml", table: "nonexistent" },
    ];
    const results = checkCrossReferences(entities, metrics);
    const errors = results.filter((r) => r.status === "fail");
    expect(errors.length).toBe(1);
    expect(errors[0].detail).toContain("nonexistent");
  });

  test("warn on unused entities not referenced by joins or metrics", () => {
    const entities = [
      {
        file: "entities/users.yml",
        table: "users",
        dimensions: { id: { type: "integer" } },
        joins: { orders: { description: "user orders" } },
      },
      {
        file: "entities/orders.yml",
        table: "orders",
        dimensions: { id: { type: "integer" } },
      },
      {
        file: "entities/orphan.yml",
        table: "orphan",
        dimensions: { id: { type: "integer" } },
      },
    ];
    const results = checkCrossReferences(entities, []);
    const warnings = results.filter((r) => r.status === "warn");
    // "users" is referenced as a join source (but not a target → not in referencedTables)
    // "orders" is referenced by users' join → referenced
    // "orphan" has no inbound references → should warn
    expect(warnings.length).toBe(2); // users + orphan
    expect(warnings.some((w) => w.detail.includes('"orphan"'))).toBe(true);
    expect(warnings.some((w) => w.detail.includes('"users"'))).toBe(true);
  });

  test("no unused entity warning when entity is referenced by a metric", () => {
    const entities = [
      {
        file: "entities/users.yml",
        table: "users",
        dimensions: { id: { type: "integer" } },
      },
    ];
    const metrics = [{ file: "metrics/user_count.yml", table: "users" }];
    const results = checkCrossReferences(entities, metrics);
    const warnings = results.filter((r) => r.status === "warn");
    expect(warnings.length).toBe(0);
  });

  test("resolves join target from target_table field", () => {
    const entities = [
      {
        file: "entities/orders.yml",
        table: "orders",
        dimensions: { id: { type: "integer" } },
        joins: { user_ref: { target_table: "users", description: "order user" } },
      },
      {
        file: "entities/users.yml",
        table: "users",
        dimensions: { id: { type: "integer" } },
      },
    ];
    const results = checkCrossReferences(entities, []);
    const errors = results.filter((r) => r.status === "fail");
    expect(errors.length).toBe(0);
  });

  test("handles metric with tables array", () => {
    const entities = [
      {
        file: "entities/users.yml",
        table: "users",
        dimensions: { id: { type: "integer" } },
      },
    ];
    const metrics = [
      { file: "metrics/combo.yml", tables: ["users", "missing_table"] },
    ];
    const results = checkCrossReferences(entities, metrics);
    const errors = results.filter((r) => r.status === "fail");
    expect(errors.length).toBe(1);
    expect(errors[0].detail).toContain("missing_table");
  });

  test("resolves array-style joins with target_entity (profiler-generated)", () => {
    const entities = [
      {
        file: "entities/people.yml",
        table: "people",
        dimensions: { id: { type: "integer" } },
        joins: [
          { target_entity: "Companies", relationship: "many_to_one", join_columns: { from: "company_id", to: "id" } },
        ],
      },
      {
        file: "entities/companies.yml",
        table: "companies",
        dimensions: { id: { type: "integer" } },
      },
    ];
    const results = checkCrossReferences(entities, []);
    const errors = results.filter((r) => r.status === "fail");
    expect(errors.length).toBe(0);
  });

  test("array-style join with missing target_entity reports error", () => {
    const entities = [
      {
        file: "entities/people.yml",
        table: "people",
        dimensions: { id: { type: "integer" } },
        joins: [
          { target_entity: "MissingTable", relationship: "many_to_one", join_columns: { from: "company_id", to: "id" } },
        ],
      },
    ];
    const results = checkCrossReferences(entities, []);
    const errors = results.filter((r) => r.status === "fail");
    expect(errors.length).toBe(1);
    expect(errors[0].detail).toContain("missing_table");
  });

  test("handles schema-qualified table names in joins", () => {
    const entities = [
      {
        file: "entities/users.yml",
        table: "public.users",
        dimensions: { id: { type: "integer" } },
        joins: { orders: { description: "user orders" } },
      },
      {
        file: "entities/orders.yml",
        table: "orders",
        dimensions: { id: { type: "integer" } },
      },
    ];
    const results = checkCrossReferences(entities, []);
    const errors = results.filter((r) => r.status === "fail");
    expect(errors.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// renderValidateResults
// ---------------------------------------------------------------------------

describe("renderValidateResults", () => {
  test("renders without crashing on typical results", () => {
    const results: ValidateResult[] = [
      { status: "pass", label: "atlas.config.ts", detail: "Valid" },
      { status: "fail", label: "entities/bad.yml", detail: "Error", fix: "Fix it" },
      { status: "warn", label: "entities/ok.yml:15", detail: "Missing description" },
    ];
    expect(() => renderValidateResults(results)).not.toThrow();
  });

  test("handles empty results array without crashing", () => {
    expect(() => renderValidateResults([])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// runValidate (integration)
// ---------------------------------------------------------------------------

describe("runValidate", () => {
  test("returns 0 for a valid semantic layer (offline)", async () => {
    const dir = makeTmpDir();
    createSemanticDir(dir, {
      entities: {
        "users.yml": "table: users\ndimensions:\n  id:\n    type: integer\n    description: User ID\n",
        "orders.yml": [
          "table: orders",
          "dimensions:",
          "  id:",
          "    type: integer",
          "    description: Order ID",
          "  user_id:",
          "    type: integer",
          "    description: FK to users",
          "joins:",
          "  users:",
          "    description: orders.user_id → users.id",
        ].join("\n"),
      },
      glossary: "user:\n  definition: A person\n",
      metrics: {
        "order_count.yml": "metric: order_count\ntable: orders\n",
      },
    });
    const exitCode = await withCwd(dir, () => runValidate({ offline: true }));
    expect(exitCode).toBe(0);
  });

  test("returns 1 when entity has errors", async () => {
    const dir = makeTmpDir();
    createSemanticDir(dir, {
      entities: {
        "bad.yml": ": invalid [yaml",
      },
    });
    const exitCode = await withCwd(dir, () => runValidate({ offline: true }));
    expect(exitCode).toBe(1);
  });

  test("returns 1 when join target is missing", async () => {
    const dir = makeTmpDir();
    createSemanticDir(dir, {
      entities: {
        "items.yml": [
          "table: items",
          "dimensions:",
          "  id:",
          "    type: integer",
          "    description: Item ID",
          "joins:",
          "  nonexistent_table:",
          "    description: bad ref",
        ].join("\n"),
      },
    });
    const exitCode = await withCwd(dir, () => runValidate({ offline: true }));
    expect(exitCode).toBe(1);
  });

  test("returns 2 when only warnings present (offline)", async () => {
    const dir = makeTmpDir();
    createSemanticDir(dir, {
      entities: {
        "users.yml": [
          "table: users",
          "dimensions:",
          "  id:",
          "    type: integer",
          // missing description — triggers warn, not fail
        ].join("\n"),
      },
    });
    const exitCode = await withCwd(dir, () => runValidate({ offline: true }));
    expect(exitCode).toBe(2);
  });

  test("returns 1 when no entities exist", async () => {
    const dir = makeTmpDir();
    createSemanticDir(dir);
    const exitCode = await withCwd(dir, () => runValidate({ offline: true }));
    expect(exitCode).toBe(1);
  });

  test("--offline skips connectivity section", async () => {
    const dir = makeTmpDir();
    createSemanticDir(dir, {
      entities: {
        "users.yml": "table: users\ndimensions:\n  id:\n    type: integer\n    description: User ID\n",
      },
      metrics: {
        "user_count.yml": "metric: user_count\ntable: users\n",
      },
    });
    // offline mode should not attempt any network calls
    const exitCode = await withCwd(dir, () => runValidate({ offline: true }));
    expect(exitCode).toBe(0);
  });

  test("doctor mode returns same exit code as strict for offline failures", async () => {
    const dir = makeTmpDir();
    createSemanticDir(dir, {
      entities: {
        "bad.yml": ": invalid [yaml",
      },
    });
    const exitCode = await withCwd(dir, () => runValidate({ offline: true, mode: "doctor" }));
    expect(exitCode).toBe(1);
  });

  test("doctor mode returns 0 for valid semantic layer (offline)", async () => {
    const dir = makeTmpDir();
    createSemanticDir(dir, {
      entities: {
        "users.yml": "table: users\ndimensions:\n  id:\n    type: integer\n    description: User ID\n",
      },
      metrics: {
        "user_count.yml": "metric: user_count\ntable: users\n",
      },
    });
    const exitCode = await withCwd(dir, () => runValidate({ offline: true, mode: "doctor" }));
    expect(exitCode).toBe(0);
  });

  test("doctor mode returns 2 for warnings-only (offline)", async () => {
    const dir = makeTmpDir();
    createSemanticDir(dir, {
      entities: {
        "users.yml": [
          "table: users",
          "dimensions:",
          "  id:",
          "    type: integer",
          // missing description — triggers warn, not fail
        ].join("\n"),
      },
    });
    const exitCode = await withCwd(dir, () => runValidate({ offline: true, mode: "doctor" }));
    expect(exitCode).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// renderValidateSections
// ---------------------------------------------------------------------------

describe("renderValidateSections", () => {
  test("renders sections without crashing", () => {
    const sections: ValidateSection[] = [
      {
        category: "Config",
        results: [{ status: "pass", label: "atlas.config.ts", detail: "Valid" }],
      },
      {
        category: "Semantic Layer",
        results: [
          { status: "fail", label: "entities/bad.yml", detail: "Error", fix: "Fix it" },
          { status: "warn", label: "entities/ok.yml:15", detail: "Missing description" },
        ],
      },
      {
        category: "Connectivity",
        results: [{ status: "pass", label: "Database", detail: "Connected" }],
      },
    ];
    expect(() => renderValidateSections(sections)).not.toThrow();
  });

  test("handles empty sections without crashing", () => {
    expect(() => renderValidateSections([])).not.toThrow();
  });

  test("skips sections with no results", () => {
    const sections: ValidateSection[] = [
      { category: "Config", results: [] },
      { category: "Semantic Layer", results: [{ status: "pass", label: "test", detail: "ok" }] },
    ];
    expect(() => renderValidateSections(sections)).not.toThrow();
  });
});
