/**
 * Grouped-tree view (#3235). `/admin/semantic` renders entities under
 * collapsible Connection-group sections — labeled with datasource type +
 * member count — instead of a flat list with per-row group badges. The
 * single-DB case (default group only) stays flat with no group chrome.
 */

import { describe, expect, test, afterEach } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import {
  SemanticFileTree,
  type SemanticGroupMeta,
} from "../components/admin/semantic-file-tree";

function findButton(container: HTMLElement, label: string): HTMLElement | null {
  for (const btn of container.querySelectorAll("button")) {
    if (btn.textContent?.includes(label)) return btn as HTMLElement;
  }
  return null;
}

function sections(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll('[data-testid="semantic-group-section"]'),
  ) as HTMLElement[];
}

const GROUPS: SemanticGroupMeta[] = [
  { id: null, label: "default", dbTypeLabel: "Postgres", memberCount: 1 },
  { id: "g_warehouse", label: "warehouse", dbTypeLabel: "Snowflake", memberCount: 2 },
  { id: "g_crm", label: "crm", dbTypeLabel: "Salesforce", memberCount: 1 },
];

describe("SemanticFileTree — grouped tree (#3235)", () => {
  afterEach(() => {
    cleanup();
  });

  test("single-DB (default group only) renders flat with no group chrome", () => {
    const { container } = render(
      <SemanticFileTree
        entities={[
          { name: "orders", connectionGroupId: null },
          { name: "customers", connectionGroupId: null },
        ]}
        metricFileNames={[]}
        hasCatalog={false}
        hasGlossary={false}
        groups={[{ id: null, label: "default", dbTypeLabel: "Postgres", memberCount: 1 }]}
        selection={null}
        onSelect={() => {}}
      />,
    );
    // No collapsible group sections — the flat "entities" folder is kept.
    expect(sections(container).length).toBe(0);
    expect(container.textContent).toContain("entities");
    expect(findButton(container, "orders.yml")).not.toBeNull();
    expect(findButton(container, "customers.yml")).not.toBeNull();
  });

  test("multi-group renders one collapsible section per group", () => {
    const { container } = render(
      <SemanticFileTree
        entities={[
          { name: "orders", connectionGroupId: null },
          { name: "events", connectionGroupId: "g_warehouse" },
          { name: "leads", connectionGroupId: "g_crm" },
        ]}
        metricFileNames={[]}
        hasCatalog={false}
        hasGlossary={false}
        groups={GROUPS}
        selection={null}
        onSelect={() => {}}
      />,
    );
    expect(sections(container).length).toBe(3);
    // Entities render under their group, not in a single flat list.
    expect(findButton(container, "orders.yml")).not.toBeNull();
    expect(findButton(container, "events.yml")).not.toBeNull();
    expect(findButton(container, "leads.yml")).not.toBeNull();
  });

  test("each group header shows datasource type + member count", () => {
    const { container } = render(
      <SemanticFileTree
        entities={[
          { name: "events", connectionGroupId: "g_warehouse" },
          { name: "leads", connectionGroupId: "g_crm" },
        ]}
        metricFileNames={[]}
        hasCatalog={false}
        hasGlossary={false}
        groups={GROUPS}
        selection={null}
        onSelect={() => {}}
      />,
    );
    const byId = (id: string) =>
      sections(container).find((s) => s.getAttribute("data-group-id") === id);
    const warehouse = byId("g_warehouse");
    expect(warehouse).toBeDefined();
    expect(warehouse!.textContent).toContain("warehouse");
    expect(warehouse!.textContent).toContain("Snowflake");
    expect(warehouse!.textContent).toContain("2 members");

    const crm = byId("g_crm");
    expect(crm!.textContent).toContain("Salesforce");
    expect(crm!.textContent).toContain("1 member");
    // Singular member count, not "1 members".
    expect(crm!.textContent).not.toContain("1 members");
  });

  test("default group sorts first, then groups by label", () => {
    const { container } = render(
      <SemanticFileTree
        entities={[
          { name: "leads", connectionGroupId: "g_crm" },
          { name: "orders", connectionGroupId: null },
          { name: "events", connectionGroupId: "g_warehouse" },
        ]}
        metricFileNames={[]}
        hasCatalog={false}
        hasGlossary={false}
        groups={GROUPS}
        selection={null}
        onSelect={() => {}}
      />,
    );
    const labels = sections(container).map((s) => s.getAttribute("data-group-id"));
    // Default ("") first, then crm < warehouse by label.
    expect(labels).toEqual(["", "g_crm", "g_warehouse"]);
  });

  test("a present group with no metadata still renders (file-based degrade)", () => {
    const { container } = render(
      <SemanticFileTree
        entities={[
          { name: "orders", connectionGroupId: null },
          { name: "events", connectionGroupId: "g_warehouse" },
        ]}
        metricFileNames={[]}
        hasCatalog={false}
        hasGlossary={false}
        // No `groups` prop at all — label falls back to the stripped id.
        selection={null}
        onSelect={() => {}}
      />,
    );
    const warehouse = sections(container).find(
      (s) => s.getAttribute("data-group-id") === "g_warehouse",
    );
    expect(warehouse).toBeDefined();
    expect(warehouse!.textContent).toContain("warehouse");
    // No datasource-type or member-count suffix when metadata is absent.
    expect(warehouse!.textContent).not.toContain("members");
    expect(findButton(container, "events.yml")).not.toBeNull();
  });

  test("clicking a grouped entity selects it with its connectionGroupId", () => {
    let selected: unknown = null;
    const { container } = render(
      <SemanticFileTree
        entities={[
          { name: "orders", connectionGroupId: null },
          { name: "events", connectionGroupId: "g_warehouse" },
        ]}
        metricFileNames={[]}
        hasCatalog={false}
        hasGlossary={false}
        groups={GROUPS}
        selection={null}
        onSelect={(sel) => {
          selected = sel;
        }}
      />,
    );
    const btn = findButton(container, "events.yml");
    expect(btn).not.toBeNull();
    btn!.click();
    expect(selected).toEqual({
      type: "entity",
      name: "events",
      connectionGroupId: "g_warehouse",
    });
  });

  test("empty entity list renders flat with the 'No entities' affordance", () => {
    const { container } = render(
      <SemanticFileTree
        entities={[]}
        metricFileNames={[]}
        hasCatalog={false}
        hasGlossary={false}
        groups={[]}
        selection={null}
        onSelect={() => {}}
      />,
    );
    expect(sections(container).length).toBe(0);
    expect(container.textContent).toContain("entities");
    expect(container.textContent).toContain("No entities");
  });

  test("a single non-default group still renders grouped (not flat)", () => {
    const { container } = render(
      <SemanticFileTree
        entities={[{ name: "events", connectionGroupId: "g_warehouse" }]}
        metricFileNames={[]}
        hasCatalog={false}
        hasGlossary={false}
        groups={GROUPS}
        selection={null}
        onSelect={() => {}}
      />,
    );
    // One non-default group with entities → grouped, even though it's the only group.
    expect(sections(container).length).toBe(1);
    expect(sections(container)[0]!.getAttribute("data-group-id")).toBe("g_warehouse");
  });

  test("group header suffix handles dbType-only, member-count edges, and neither", () => {
    const { container } = render(
      <SemanticFileTree
        entities={[
          { name: "a", connectionGroupId: "g_dbonly" },
          { name: "b", connectionGroupId: "g_zero" },
          { name: "c", connectionGroupId: "g_bare" },
        ]}
        metricFileNames={[]}
        hasCatalog={false}
        hasGlossary={false}
        groups={[
          // dbType but no member count → "· Postgres", no member clause.
          { id: "g_dbonly", label: "dbonly", dbTypeLabel: "Postgres" },
          // memberCount 0 is suppressed (only > 0 renders).
          { id: "g_zero", label: "zero", dbTypeLabel: "Postgres", memberCount: 0 },
          // neither → bare label, no "·" separator.
          { id: "g_bare", label: "bare" },
        ]}
        selection={null}
        onSelect={() => {}}
      />,
    );
    const byId = (id: string) =>
      sections(container).find((s) => s.getAttribute("data-group-id") === id)!;

    expect(byId("g_dbonly").textContent).toContain("Postgres");
    expect(byId("g_dbonly").textContent).not.toContain("member");

    expect(byId("g_zero").textContent).not.toContain("0 member");

    const bare = byId("g_bare").textContent ?? "";
    expect(bare).toContain("bare");
    expect(bare).not.toContain("·");
    expect(bare).not.toContain("member");
  });
});
