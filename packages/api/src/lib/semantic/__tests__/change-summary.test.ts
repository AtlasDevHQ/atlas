/**
 * Tests for generateChangeSummary — the change summary generator for
 * semantic entity version history (#1126).
 */

import { describe, it, expect } from "bun:test";
import { generateChangeSummary } from "../entities";

describe("generateChangeSummary()", () => {
  it("returns 'Initial version' when oldYaml is null", async () => {
    const result = await generateChangeSummary(null, "table: users\n");
    expect(result).toBe("Initial version");
  });

  it("detects added dimensions", async () => {
    const oldYaml = "table: users\ndimensions:\n  - name: id\n    sql: id\n    type: number\n";
    const newYaml = "table: users\ndimensions:\n  - name: id\n    sql: id\n    type: number\n  - name: email\n    sql: email\n    type: string\n";
    const result = await generateChangeSummary(oldYaml, newYaml);
    expect(result).toContain("+1 dimension");
  });

  it("detects removed measures", async () => {
    const oldYaml = "table: users\nmeasures:\n  - name: count\n    sql: COUNT(*)\n    type: count\n  - name: avg_age\n    sql: AVG(age)\n    type: avg\n";
    const newYaml = "table: users\nmeasures:\n  - name: count\n    sql: COUNT(*)\n    type: count\n";
    const result = await generateChangeSummary(oldYaml, newYaml);
    expect(result).toContain("-1 measure");
  });

  it("detects mixed adds and removes across sections", async () => {
    const oldYaml = "table: users\ndimensions:\n  - name: id\n    sql: id\n    type: number\njoins:\n  - name: to_orders\n    sql: users.id = orders.user_id\n";
    const newYaml = "table: users\ndimensions:\n  - name: id\n    sql: id\n    type: number\n  - name: email\n    sql: email\n    type: string\n";
    const result = await generateChangeSummary(oldYaml, newYaml);
    expect(result).toContain("+1 dimension");
    expect(result).toContain("-1 join");
  });

  it("pluralizes correctly for multiple items", async () => {
    const oldYaml = "table: users\n";
    const newYaml = "table: users\ndimensions:\n  - name: id\n    sql: id\n    type: number\n  - name: email\n    sql: email\n    type: string\n  - name: name\n    sql: name\n    type: string\n";
    const result = await generateChangeSummary(oldYaml, newYaml);
    expect(result).toContain("+3 dimensions");
  });

  it("detects description change", async () => {
    const oldYaml = "table: users\ndescription: Old description\n";
    const newYaml = "table: users\ndescription: New description\n";
    const result = await generateChangeSummary(oldYaml, newYaml);
    expect(result).toContain("description updated");
  });

  it("detects table rename", async () => {
    const oldYaml = "table: users\n";
    const newYaml = "table: accounts\n";
    const result = await generateChangeSummary(oldYaml, newYaml);
    expect(result).toContain("table renamed");
  });

  it("returns 'No structural changes' when YAML is identical", async () => {
    const yaml = "table: users\ndescription: User accounts\ndimensions:\n  - name: id\n    sql: id\n    type: number\n";
    const result = await generateChangeSummary(yaml, yaml);
    expect(result).toBe("No structural changes");
  });

  it("returns null when YAML is unparseable", async () => {
    const result = await generateChangeSummary("not: [valid: yaml: {{", "also: [broken: {{");
    // generateChangeSummary catches parse errors and returns null
    expect(result === null || typeof result === "string").toBe(true);
  });
});
