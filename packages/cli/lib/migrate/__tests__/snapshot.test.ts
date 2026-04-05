/**
 * Tests for semantic layer snapshot library.
 *
 * Uses a temporary directory to isolate each test from the real filesystem.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  createSnapshot,
  getHistory,
  getLatestEntry,
  loadSnapshot,
  currentHash,
  diffFiles,
  diffCurrentVsSnapshot,
  diffSnapshots,
  rollbackToSnapshot,
  collectSemanticFiles,
  parseSnapshotEntities,
} from "../snapshot";
import type { SnapshotFile } from "../snapshot";

// ── Test helpers ──────────────────────────────────────────────────

let tmpDir: string;

function semanticRoot(): string {
  return path.join(tmpDir, "semantic");
}

function writeYaml(relativePath: string, content: string): void {
  const fullPath = path.join(semanticRoot(), relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf-8");
}

function readYaml(relativePath: string): string {
  return fs.readFileSync(path.join(semanticRoot(), relativePath), "utf-8");
}

function setupBasicSemanticLayer(): void {
  writeYaml("entities/orders.yml", `table: orders\ndescription: Customer orders\ndimensions:\n  - name: id\n    type: number\n`);
  writeYaml("entities/customers.yml", `table: customers\ndescription: Customer data\ndimensions:\n  - name: id\n    type: number\n`);
  writeYaml("glossary.yml", `terms:\n  - name: revenue\n    definition: Total sales amount\n`);
  writeYaml("catalog.yml", `entities:\n  - orders\n  - customers\n`);
  writeYaml("metrics/revenue.yml", `name: revenue\nsql: SUM(total)\n`);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-migrate-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── collectSemanticFiles ──────────────────────────────────────────

describe("collectSemanticFiles", () => {
  it("collects all YAML files from semantic directory", () => {
    setupBasicSemanticLayer();
    const files = collectSemanticFiles(semanticRoot());

    expect(files.length).toBe(5);
    const paths = files.map((f) => f.path);
    expect(paths).toContain("entities/orders.yml");
    expect(paths).toContain("entities/customers.yml");
    expect(paths).toContain("glossary.yml");
    expect(paths).toContain("catalog.yml");
    expect(paths).toContain("metrics/revenue.yml");
  });

  it("sorts files by path", () => {
    setupBasicSemanticLayer();
    const files = collectSemanticFiles(semanticRoot());
    const paths = files.map((f) => f.path);
    expect(paths).toEqual([...paths].sort());
  });

  it("skips .history directory", () => {
    setupBasicSemanticLayer();
    // Create a snapshot first (which creates .history/)
    createSnapshot(semanticRoot());

    const files = collectSemanticFiles(semanticRoot());
    const historyFiles = files.filter((f) => f.path.includes(".history"));
    expect(historyFiles.length).toBe(0);
  });

  it("skips .orgs directory", () => {
    setupBasicSemanticLayer();
    writeYaml(".orgs/org-123/entities/test.yml", "table: test\n");

    const files = collectSemanticFiles(semanticRoot());
    const orgsFiles = files.filter((f) => f.path.includes(".orgs"));
    expect(orgsFiles.length).toBe(0);
  });

  it("returns empty for non-existent directory", () => {
    const files = collectSemanticFiles(path.join(tmpDir, "nonexistent"));
    expect(files.length).toBe(0);
  });
});

// ── createSnapshot ────────────────────────────────────────────────

describe("createSnapshot", () => {
  it("creates a snapshot with correct metadata", () => {
    setupBasicSemanticLayer();
    const entry = createSnapshot(semanticRoot(), {
      message: "Test snapshot",
      trigger: "manual",
    });

    expect(entry).not.toBeNull();
    expect(entry!.hash).toHaveLength(8);
    expect(entry!.message).toBe("Test snapshot");
    expect(entry!.trigger).toBe("manual");
    expect(entry!.filename).toContain(entry!.hash);
    expect(new Date(entry!.timestamp).getTime()).not.toBeNaN();
  });

  it("stores snapshot file on disk", () => {
    setupBasicSemanticLayer();
    const entry = createSnapshot(semanticRoot())!;

    const snapshotPath = path.join(semanticRoot(), ".history", entry.filename);
    expect(fs.existsSync(snapshotPath)).toBe(true);

    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf-8"));
    expect(snapshot.files.length).toBe(5);
    expect(snapshot.hash).toBe(entry.hash);
  });

  it("updates manifest with new entry", () => {
    setupBasicSemanticLayer();
    createSnapshot(semanticRoot());

    const manifest = getHistory(semanticRoot());
    expect(manifest.version).toBe(1);
    expect(manifest.entries.length).toBe(1);
  });

  it("returns null when nothing changed since last snapshot", () => {
    setupBasicSemanticLayer();
    const first = createSnapshot(semanticRoot());
    expect(first).not.toBeNull();

    const second = createSnapshot(semanticRoot());
    expect(second).toBeNull();
  });

  it("respects force flag to create duplicate snapshot", () => {
    setupBasicSemanticLayer();
    createSnapshot(semanticRoot());
    const forced = createSnapshot(semanticRoot(), { force: true });
    expect(forced).not.toBeNull();

    const manifest = getHistory(semanticRoot());
    expect(manifest.entries.length).toBe(2);
  });

  it("throws when no YAML files exist", () => {
    fs.mkdirSync(semanticRoot(), { recursive: true });
    expect(() => createSnapshot(semanticRoot())).toThrow("No YAML files found");
  });

  it("creates .history directory if it does not exist", () => {
    setupBasicSemanticLayer();
    createSnapshot(semanticRoot());

    const historyPath = path.join(semanticRoot(), ".history");
    expect(fs.existsSync(historyPath)).toBe(true);
  });
});

// ── loadSnapshot ──────────────────────────────────────────────────

describe("loadSnapshot", () => {
  it("loads a snapshot by full hash", () => {
    setupBasicSemanticLayer();
    const entry = createSnapshot(semanticRoot())!;

    const snapshot = loadSnapshot(semanticRoot(), entry.hash);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.hash).toBe(entry.hash);
    expect(snapshot!.files.length).toBe(5);
  });

  it("loads a snapshot by hash prefix", () => {
    setupBasicSemanticLayer();
    const entry = createSnapshot(semanticRoot())!;

    const snapshot = loadSnapshot(semanticRoot(), entry.hash.slice(0, 4));
    expect(snapshot).not.toBeNull();
    expect(snapshot!.hash).toBe(entry.hash);
  });

  it("returns null for unknown hash", () => {
    setupBasicSemanticLayer();
    createSnapshot(semanticRoot());

    const snapshot = loadSnapshot(semanticRoot(), "zzzzzzzz");
    expect(snapshot).toBeNull();
  });
});

// ── getLatestEntry ────────────────────────────────────────────────

describe("getLatestEntry", () => {
  it("returns null when no snapshots exist", () => {
    fs.mkdirSync(semanticRoot(), { recursive: true });
    expect(getLatestEntry(semanticRoot())).toBeNull();
  });

  it("returns the most recent entry", () => {
    setupBasicSemanticLayer();
    createSnapshot(semanticRoot(), { message: "first" });

    writeYaml("entities/products.yml", "table: products\n");
    createSnapshot(semanticRoot(), { message: "second" });

    const latest = getLatestEntry(semanticRoot());
    expect(latest).not.toBeNull();
    expect(latest!.message).toBe("second");
  });
});

// ── currentHash ───────────────────────────────────────────────────

describe("currentHash", () => {
  it("returns consistent hash for same content", () => {
    setupBasicSemanticLayer();
    const h1 = currentHash(semanticRoot());
    const h2 = currentHash(semanticRoot());
    expect(h1).toBe(h2);
  });

  it("changes when files are modified", () => {
    setupBasicSemanticLayer();
    const before = currentHash(semanticRoot());

    writeYaml("entities/orders.yml", "table: orders\ndescription: Updated\n");
    const after = currentHash(semanticRoot());

    expect(before).not.toBe(after);
  });
});

// ── diffFiles ─────────────────────────────────────────────────────

describe("diffFiles", () => {
  it("detects added files", () => {
    const before: SnapshotFile[] = [{ path: "a.yml", content: "x" }];
    const after: SnapshotFile[] = [
      { path: "a.yml", content: "x" },
      { path: "b.yml", content: "y" },
    ];

    const diffs = diffFiles(before, after);
    expect(diffs.length).toBe(2);
    expect(diffs.find((d) => d.path === "b.yml")?.status).toBe("added");
    expect(diffs.find((d) => d.path === "a.yml")?.status).toBe("unchanged");
  });

  it("detects removed files", () => {
    const before: SnapshotFile[] = [
      { path: "a.yml", content: "x" },
      { path: "b.yml", content: "y" },
    ];
    const after: SnapshotFile[] = [{ path: "a.yml", content: "x" }];

    const diffs = diffFiles(before, after);
    expect(diffs.find((d) => d.path === "b.yml")?.status).toBe("removed");
  });

  it("detects modified files", () => {
    const before: SnapshotFile[] = [{ path: "a.yml", content: "old" }];
    const after: SnapshotFile[] = [{ path: "a.yml", content: "new" }];

    const diffs = diffFiles(before, after);
    expect(diffs[0].status).toBe("modified");
    expect(diffs[0].lines.length).toBeGreaterThan(0);
  });

  it("marks unchanged files correctly", () => {
    const files: SnapshotFile[] = [{ path: "a.yml", content: "same" }];
    const diffs = diffFiles(files, files);
    expect(diffs[0].status).toBe("unchanged");
    expect(diffs[0].lines.length).toBe(0);
  });
});

// ── diffCurrentVsSnapshot ─────────────────────────────────────────

describe("diffCurrentVsSnapshot", () => {
  it("returns null when no snapshots exist", () => {
    setupBasicSemanticLayer();
    expect(diffCurrentVsSnapshot(semanticRoot())).toBeNull();
  });

  it("shows no changes when current matches snapshot", () => {
    setupBasicSemanticLayer();
    createSnapshot(semanticRoot());

    const result = diffCurrentVsSnapshot(semanticRoot());
    expect(result).not.toBeNull();

    const changed = result!.diffs.filter((d) => d.status !== "unchanged");
    expect(changed.length).toBe(0);
  });

  it("detects modifications since snapshot", () => {
    setupBasicSemanticLayer();
    createSnapshot(semanticRoot());

    writeYaml("entities/orders.yml", "table: orders\ndescription: Updated\n");
    const result = diffCurrentVsSnapshot(semanticRoot());

    const modified = result!.diffs.filter((d) => d.status === "modified");
    expect(modified.length).toBe(1);
    expect(modified[0].path).toBe("entities/orders.yml");
  });

  it("detects new files since snapshot", () => {
    setupBasicSemanticLayer();
    createSnapshot(semanticRoot());

    writeYaml("entities/products.yml", "table: products\n");
    const result = diffCurrentVsSnapshot(semanticRoot());

    const added = result!.diffs.filter((d) => d.status === "added");
    expect(added.length).toBe(1);
    expect(added[0].path).toBe("entities/products.yml");
  });
});

// ── diffSnapshots ─────────────────────────────────────────────────

describe("diffSnapshots", () => {
  it("diffs between two snapshots", () => {
    setupBasicSemanticLayer();
    const first = createSnapshot(semanticRoot(), { message: "v1" })!;

    writeYaml("entities/products.yml", "table: products\n");
    const second = createSnapshot(semanticRoot(), { message: "v2" })!;

    const result = diffSnapshots(semanticRoot(), first.hash, second.hash);
    expect(result).not.toBeNull();
    expect(result!.from.hash).toBe(first.hash);
    expect(result!.to.hash).toBe(second.hash);

    const added = result!.diffs.filter((d) => d.status === "added");
    expect(added.length).toBe(1);
    expect(added[0].path).toBe("entities/products.yml");
  });

  it("returns null for unknown hash", () => {
    setupBasicSemanticLayer();
    createSnapshot(semanticRoot());
    expect(diffSnapshots(semanticRoot(), "aaaaaaaa", "bbbbbbbb")).toBeNull();
  });
});

// ── rollbackToSnapshot ────────────────────────────────────────────

describe("rollbackToSnapshot", () => {
  it("restores files to snapshot state", () => {
    setupBasicSemanticLayer();
    const entry = createSnapshot(semanticRoot(), { message: "v1" })!;

    // Make changes
    writeYaml("entities/orders.yml", "table: orders\ndescription: Changed!\n");
    writeYaml("entities/products.yml", "table: products\n");

    rollbackToSnapshot(semanticRoot(), entry.hash);

    // Verify files are restored
    const orders = readYaml("entities/orders.yml");
    expect(orders).toContain("Customer orders");
    expect(orders).not.toContain("Changed!");

    // products.yml should be removed (didn't exist in v1)
    expect(fs.existsSync(path.join(semanticRoot(), "entities/products.yml"))).toBe(false);
  });

  it("creates a pre-rollback snapshot", () => {
    setupBasicSemanticLayer();
    const entry = createSnapshot(semanticRoot())!;

    writeYaml("entities/orders.yml", "table: orders\ndescription: Changed!\n");

    const { preRollback } = rollbackToSnapshot(semanticRoot(), entry.hash);
    expect(preRollback).not.toBeNull();
    expect(preRollback!.trigger).toBe("rollback");

    // Pre-rollback snapshot should contain the changed content
    const preSnap = loadSnapshot(semanticRoot(), preRollback!.hash);
    expect(preSnap).not.toBeNull();
    const ordersFile = preSnap!.files.find((f) => f.path === "entities/orders.yml");
    expect(ordersFile).toBeDefined();
    expect(ordersFile!.content).toContain("Changed!");
  });

  it("throws for unknown hash", () => {
    setupBasicSemanticLayer();
    expect(() => rollbackToSnapshot(semanticRoot(), "zzzzzzzz")).toThrow("Snapshot not found");
  });

  it("preserves .history directory during rollback", () => {
    setupBasicSemanticLayer();
    const entry = createSnapshot(semanticRoot())!;

    writeYaml("entities/orders.yml", "table: orders\ndescription: Changed!\n");
    rollbackToSnapshot(semanticRoot(), entry.hash);

    // .history should still exist with manifest
    const historyPath = path.join(semanticRoot(), ".history");
    expect(fs.existsSync(historyPath)).toBe(true);
    expect(fs.existsSync(path.join(historyPath, "manifest.json"))).toBe(true);
  });
});

// ── getHistory ────────────────────────────────────────────────────

describe("getHistory", () => {
  it("returns empty manifest when no history exists", () => {
    fs.mkdirSync(semanticRoot(), { recursive: true });
    const manifest = getHistory(semanticRoot());
    expect(manifest.version).toBe(1);
    expect(manifest.entries.length).toBe(0);
  });

  it("tracks multiple snapshots in order", () => {
    setupBasicSemanticLayer();
    createSnapshot(semanticRoot(), { message: "first" });

    writeYaml("entities/products.yml", "table: products\n");
    createSnapshot(semanticRoot(), { message: "second" });

    writeYaml("entities/invoices.yml", "table: invoices\n");
    createSnapshot(semanticRoot(), { message: "third" });

    const manifest = getHistory(semanticRoot());
    expect(manifest.entries.length).toBe(3);
    expect(manifest.entries[0].message).toBe("first");
    expect(manifest.entries[1].message).toBe("second");
    expect(manifest.entries[2].message).toBe("third");
  });
});

// ── parseSnapshotEntities ─────────────────────────────────────────

describe("parseSnapshotEntities", () => {
  it("parses valid entity YAML from snapshot", () => {
    setupBasicSemanticLayer();
    const entry = createSnapshot(semanticRoot())!;
    const snapshot = loadSnapshot(semanticRoot(), entry.hash)!;

    const entities = parseSnapshotEntities(snapshot);
    expect(entities.size).toBe(2); // orders + customers
    expect(entities.has("orders")).toBe(true);
    expect(entities.has("customers")).toBe(true);
    expect(entities.get("orders")!.table).toBe("orders");
  });

  it("excludes non-entity files", () => {
    setupBasicSemanticLayer();
    const entry = createSnapshot(semanticRoot())!;
    const snapshot = loadSnapshot(semanticRoot(), entry.hash)!;

    const entities = parseSnapshotEntities(snapshot);
    // glossary, catalog, and metrics should not be in the entity map
    expect(entities.has("glossary")).toBe(false);
    expect(entities.has("catalog")).toBe(false);
    expect(entities.has("revenue")).toBe(false);
  });

  it("skips malformed YAML gracefully", () => {
    setupBasicSemanticLayer();
    const entry = createSnapshot(semanticRoot())!;
    const snapshot = loadSnapshot(semanticRoot(), entry.hash)!;

    // Inject a malformed file into the snapshot
    const corruptSnapshot = {
      ...snapshot,
      files: [...snapshot.files, { path: "entities/broken.yml", content: "{{{{invalid yaml" }],
    };

    const entities = parseSnapshotEntities(corruptSnapshot);
    // Should still parse the valid entities
    expect(entities.size).toBe(2);
    expect(entities.has("broken")).toBe(false);
  });
});

// ── loadSnapshot edge cases ───────────────────────────────────────

describe("loadSnapshot edge cases", () => {
  it("returns null when snapshot file is missing from disk", () => {
    setupBasicSemanticLayer();
    const entry = createSnapshot(semanticRoot())!;

    // Delete the snapshot file but leave the manifest intact
    const snapshotPath = path.join(semanticRoot(), ".history", entry.filename);
    fs.unlinkSync(snapshotPath);

    const snapshot = loadSnapshot(semanticRoot(), entry.hash);
    expect(snapshot).toBeNull();
  });

  it("throws on corrupt snapshot JSON", () => {
    setupBasicSemanticLayer();
    const entry = createSnapshot(semanticRoot())!;

    // Corrupt the snapshot file
    const snapshotPath = path.join(semanticRoot(), ".history", entry.filename);
    fs.writeFileSync(snapshotPath, "{{not valid json", "utf-8");

    expect(() => loadSnapshot(semanticRoot(), entry.hash)).toThrow("Corrupt snapshot file");
  });
});

// ── readManifest edge cases ───────────────────────────────────────

describe("readManifest edge cases", () => {
  it("throws on corrupt manifest JSON", () => {
    setupBasicSemanticLayer();
    createSnapshot(semanticRoot());

    // Corrupt the manifest
    const mp = path.join(semanticRoot(), ".history", "manifest.json");
    fs.writeFileSync(mp, "not json!", "utf-8");

    expect(() => getHistory(semanticRoot())).toThrow("Corrupt manifest");
  });

  it("throws on manifest with invalid structure", () => {
    setupBasicSemanticLayer();
    createSnapshot(semanticRoot());

    // Write valid JSON but wrong structure
    const mp = path.join(semanticRoot(), ".history", "manifest.json");
    fs.writeFileSync(mp, JSON.stringify({ version: 1, data: "wrong" }), "utf-8");

    expect(() => getHistory(semanticRoot())).toThrow("Corrupt manifest");
  });
});

// ── diffCurrentVsSnapshot with targetHash ─────────────────────────

describe("diffCurrentVsSnapshot with targetHash", () => {
  it("diffs current state against a specific snapshot by hash", () => {
    setupBasicSemanticLayer();
    const first = createSnapshot(semanticRoot(), { message: "v1" })!;

    writeYaml("entities/products.yml", "table: products\n");
    createSnapshot(semanticRoot(), { message: "v2" });

    writeYaml("entities/invoices.yml", "table: invoices\n");

    // Diff current (has products + invoices) against v1 (no products, no invoices)
    const result = diffCurrentVsSnapshot(semanticRoot(), first.hash);
    expect(result).not.toBeNull();
    expect(result!.snapshotEntry.hash).toBe(first.hash);

    const added = result!.diffs.filter((d) => d.status === "added");
    expect(added.length).toBe(2); // products + invoices
  });

  it("returns null for unknown targetHash", () => {
    setupBasicSemanticLayer();
    createSnapshot(semanticRoot());

    const result = diffCurrentVsSnapshot(semanticRoot(), "zzzzzzzz");
    expect(result).toBeNull();
  });
});

// ── rollbackToSnapshot path traversal protection ──────────────────

describe("rollbackToSnapshot path safety", () => {
  it("rejects snapshot with path traversal", () => {
    setupBasicSemanticLayer();
    const entry = createSnapshot(semanticRoot())!;

    // Tamper with the snapshot file to include a path traversal
    const snapshotPath = path.join(semanticRoot(), ".history", entry.filename);
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf-8"));
    snapshot.files.push({ path: "../../etc/evil.yml", content: "malicious" });
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot), "utf-8");

    expect(() => rollbackToSnapshot(semanticRoot(), entry.hash)).toThrow("Path traversal detected");
  });

  it("cleans up empty subdirectories after rollback", () => {
    setupBasicSemanticLayer();
    const entry = createSnapshot(semanticRoot())!;

    // Create a new subdirectory with files
    writeYaml("queries/custom.yml", "name: custom\n");
    expect(fs.existsSync(path.join(semanticRoot(), "queries"))).toBe(true);

    rollbackToSnapshot(semanticRoot(), entry.hash);

    // queries/ directory should be cleaned up
    expect(fs.existsSync(path.join(semanticRoot(), "queries"))).toBe(false);
  });
});

// ── collectSemanticFiles with .yaml extension ─────────────────────

describe("collectSemanticFiles .yaml extension", () => {
  it("collects .yaml files alongside .yml files", () => {
    setupBasicSemanticLayer();
    writeYaml("entities/products.yaml", "table: products\n");

    const files = collectSemanticFiles(semanticRoot());
    const yamlFile = files.find((f) => f.path === "entities/products.yaml");
    expect(yamlFile).toBeDefined();
    expect(yamlFile!.content).toContain("products");
  });
});
