import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveInside, runOkf, type OkfIO } from "../commands/okf";

interface CapturedIO extends OkfIO {
  readonly outLines: string[];
  readonly errLines: string[];
}

function captureIO(): CapturedIO {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    out: (line) => outLines.push(line),
    err: (line) => errLines.push(line),
  };
}

const TABLE_DOC = `---
type: BigQuery Table
title: Events table
description: Contains web event export data.
tags:
- events
timestamp: '2026-05-28T22:53:05+00:00'
---

# Overview
The events table.

# Schema
- \`event_name\` (STRING): The name of the event.
- \`event_count\` (INTEGER): How many times it fired.
`;

const METRIC_DOC = `---
type: Reference
title: Event Count
description: Total number of events.
tags:
- metric
---

\`\`\`sql
COUNT(*)
\`\`\`
`;

const ENTITY_YAML = `name: Orders
type: fact_table
table: orders
description: Customer orders.
dimensions:
  - name: id
    sql: id
    type: number
    primary_key: true
`;

let workDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "okf-cli-test-"));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function writeBundle(): string {
  const bundle = path.join(workDir, "bundle");
  fs.mkdirSync(path.join(bundle, "tables"), { recursive: true });
  fs.mkdirSync(path.join(bundle, "references", "metrics"), { recursive: true });
  fs.writeFileSync(path.join(bundle, "index.md"), "# Bundle\n");
  fs.writeFileSync(path.join(bundle, "tables", "events.md"), TABLE_DOC);
  fs.writeFileSync(path.join(bundle, "references", "metrics", "event_count.md"), METRIC_DOC);
  return bundle;
}

function writeSemanticLayer(): string {
  const layer = path.join(workDir, "semantic");
  fs.mkdirSync(path.join(layer, "entities"), { recursive: true });
  fs.writeFileSync(path.join(layer, "entities", "orders.yml"), ENTITY_YAML);
  return layer;
}

describe("resolveInside (defense-in-depth sink guard)", () => {
  it("resolves normal nested paths under the output root", () => {
    const out = path.join(workDir, "out");
    expect(resolveInside(out, "entities/orders.yml")).toBe(
      path.join(out, "entities", "orders.yml"),
    );
  });

  it("throws on traversal segments", () => {
    const out = path.join(workDir, "out");
    expect(() => resolveInside(out, "entities/../../escaped.yml")).toThrow(
      "refusing to write outside",
    );
  });

  it("throws on prefix-sibling escapes (out vs out-evil)", () => {
    const out = path.join(workDir, "out");
    expect(() => resolveInside(out, "../out-evil/x.yml")).toThrow("refusing to write outside");
  });
});

describe("okf command dispatch", () => {
  it("prints usage and exits 1 with no subcommand", () => {
    const io = captureIO();
    expect(runOkf(["okf"], io)).toBe(1);
    expect(io.outLines.join("\n")).toContain("Usage: atlas okf");
  });

  it("prints usage and exits 0 for --help", () => {
    const io = captureIO();
    expect(runOkf(["okf", "--help"], io)).toBe(0);
  });

  it("rejects unknown subcommands", () => {
    const io = captureIO();
    expect(runOkf(["okf", "sync"], io)).toBe(1);
    expect(io.errLines.join("\n")).toContain("Unknown okf subcommand: sync");
  });
});

describe("okf import", () => {
  it("requires --bundle", () => {
    const io = captureIO();
    expect(runOkf(["okf", "import"], io)).toBe(1);
    expect(io.errLines.join("\n")).toContain("--bundle");
  });

  it("fails on a missing bundle directory", () => {
    const io = captureIO();
    expect(runOkf(["okf", "import", "--bundle", path.join(workDir, "nope")], io)).toBe(1);
    expect(io.errLines.join("\n")).toContain("not found");
  });

  it("writes a draft semantic layer from a bundle", () => {
    const bundle = writeBundle();
    const out = path.join(workDir, "out");
    const io = captureIO();
    expect(runOkf(["okf", "import", "--bundle", bundle, "--out", out], io)).toBe(0);

    const entity = fs.readFileSync(path.join(out, "entities", "events.yml"), "utf8");
    expect(entity).toContain("table: events");
    expect(entity).toContain("name: Events table");
    const metrics = fs.readFileSync(path.join(out, "metrics", "okf-imported.yml"), "utf8");
    expect(metrics).toContain("unverified_sql: true");
    expect(fs.existsSync(path.join(out, "catalog.yml"))).toBe(true);
    expect(io.outLines.join("\n")).toContain("1 entities");
  });

  it("refuses to overwrite existing files without --force", () => {
    const bundle = writeBundle();
    const out = path.join(workDir, "out");
    fs.mkdirSync(path.join(out, "entities"), { recursive: true });
    fs.writeFileSync(path.join(out, "entities", "events.yml"), "table: events\n");

    const io = captureIO();
    expect(runOkf(["okf", "import", "--bundle", bundle, "--out", out], io)).toBe(1);
    expect(io.errLines.join("\n")).toContain("--force");
    // Existing file untouched.
    expect(fs.readFileSync(path.join(out, "entities", "events.yml"), "utf8")).toBe(
      "table: events\n",
    );

    const forced = captureIO();
    expect(
      runOkf(["okf", "import", "--bundle", bundle, "--out", out, "--force"], forced),
    ).toBe(0);
    expect(
      fs.readFileSync(path.join(out, "entities", "events.yml"), "utf8"),
    ).toContain("name: Events table");
  });
});

describe("okf import (hostile bundle)", () => {
  it("never writes outside --out for a forged atlas.entity.table", () => {
    const bundle = path.join(workDir, "bundle");
    fs.mkdirSync(path.join(bundle, "tables"), { recursive: true });
    fs.writeFileSync(
      path.join(bundle, "tables", "evil.md"),
      `---
type: Table
title: Evil
atlas:
  kind: table
  entity:
    table: ../../escaped
---

# Overview
Nope.
`,
    );
    const out = path.join(workDir, "out");
    const io = captureIO();
    expect(runOkf(["okf", "import", "--bundle", bundle, "--out", out], io)).toBe(0);
    // The engine rejects the forged name; nothing may exist above --out.
    expect(fs.existsSync(path.join(workDir, "escaped.yml"))).toBe(false);
    expect(fs.existsSync(path.join(out, "entities"))).toBe(false);
    expect(io.errLines.join("\n")).toContain("not a safe table name");
    expect(io.errLines.join("\n")).toContain("no entities were imported");
  });
});

describe("okf export", () => {
  it("requires --out", () => {
    const io = captureIO();
    expect(runOkf(["okf", "export"], io)).toBe(1);
    expect(io.errLines.join("\n")).toContain("--out");
  });

  it("fails on a missing semantic layer directory", () => {
    const io = captureIO();
    expect(
      runOkf(
        ["okf", "export", "--semantic", path.join(workDir, "nope"), "--out", path.join(workDir, "b")],
        io,
      ),
    ).toBe(1);
    expect(io.errLines.join("\n")).toContain("not found");
  });

  it("writes an OKF bundle from a semantic layer", () => {
    const layer = writeSemanticLayer();
    const out = path.join(workDir, "bundle-out");
    const io = captureIO();
    expect(runOkf(["okf", "export", "--semantic", layer, "--out", out], io)).toBe(0);

    const doc = fs.readFileSync(path.join(out, "tables", "orders.md"), "utf8");
    expect(doc).toContain("type: Table");
    expect(doc).toContain("# Schema");
    expect(doc).toContain("atlas:");
    const rootIndex = fs.readFileSync(path.join(out, "index.md"), "utf8");
    expect(rootIndex).toContain('okf_version: "0.1"');
    expect(io.outLines.join("\n")).toContain("concept docs");
  });

  it("refuses a non-empty output directory without --force", () => {
    const layer = writeSemanticLayer();
    const out = path.join(workDir, "bundle-out");
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "keep.txt"), "x");

    const io = captureIO();
    expect(runOkf(["okf", "export", "--semantic", layer, "--out", out], io)).toBe(1);
    expect(io.errLines.join("\n")).toContain("--force");
  });
});
