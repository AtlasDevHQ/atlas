/**
 * Tests for discoverEntities() warnings in semantic-files.ts.
 *
 * Covers warning accumulation when YAML files fail to parse
 * or directories are unreadable.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { resolve } from "path";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { discoverEntities } from "../semantic-files";

const tmpBase = resolve(__dirname, ".tmp-entities-test");
let counter = 0;

function makeRoot(suffix: string): string {
  counter++;
  const root = resolve(tmpBase, `${suffix}-${counter}`);
  mkdirSync(resolve(root, "entities"), { recursive: true });
  return root;
}

function writeEntity(root: string, name: string, content: string, source?: string): void {
  const dir = source
    ? resolve(root, source, "entities")
    : resolve(root, "entities");
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, `${name}.yml`), content);
}

afterEach(() => {
  if (existsSync(tmpBase)) {
    rmSync(tmpBase, { recursive: true, force: true });
  }
});

describe("discoverEntities", () => {
  it("returns entities with no warnings when all files are valid", () => {
    const root = makeRoot("clean");
    writeEntity(root, "users", "table: users\ndescription: Users table\n");

    const { entities, warnings } = discoverEntities(root);
    expect(entities).toHaveLength(1);
    expect(entities[0].table).toBe("users");
    expect(warnings).toEqual([]);
  });

  it("returns warnings for malformed YAML files", () => {
    const root = makeRoot("malformed");
    writeEntity(root, "broken", "{{{not valid yaml");
    writeEntity(root, "good", "table: good_table\ndescription: Valid\n");

    const { entities, warnings } = discoverEntities(root);
    expect(entities).toHaveLength(1);
    expect(entities[0].table).toBe("good_table");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Failed to parse entity:.*broken\.yml/);
  });

  it("returns warnings for malformed YAML in per-source subdirectory", () => {
    const root = makeRoot("sub-malformed");
    writeEntity(root, "ok", "table: ok_table\ndescription: Fine\n");
    writeEntity(root, "bad", "{{{not valid yaml", "warehouse");

    const { entities, warnings } = discoverEntities(root);
    expect(entities).toHaveLength(1);
    expect(entities[0].table).toBe("ok_table");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Failed to parse entity:.*bad\.yml/);
  });

  it("returns warning for entity file missing table field", () => {
    const root = makeRoot("no-table");
    writeEntity(root, "bad", "description: No table field\ndimensions:\n  id:\n    type: number\n");
    writeEntity(root, "good", "table: good_table\ndescription: Valid\n");

    const { entities, warnings } = discoverEntities(root);
    expect(entities).toHaveLength(1);
    expect(entities[0].table).toBe("good_table");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/missing required 'table' field:.*bad\.yml/);
  });

  it("returns empty entities and no warnings for non-existent root", () => {
    const { entities, warnings } = discoverEntities("/tmp/nonexistent-atlas-entities-test");
    expect(entities).toEqual([]);
    expect(warnings).toEqual([]);
  });
});
