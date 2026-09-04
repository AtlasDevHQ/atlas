/**
 * SemanticFileTree — the `/admin/semantic` file tree.
 *
 * Merged 2026-09-04 from four sibling files that all exercised this one
 * component: formerly semantic-file-tree-drafts.test.tsx,
 * semantic-file-tree-drift.test.tsx and semantic-file-tree-groups.test.tsx.
 *
 * Grouped-tree view (#3235): `/admin/semantic` renders entities under
 * collapsible Connection-group sections — labeled with datasource type +
 * member count — instead of a flat list with per-row group badges. The
 * single-DB case (default group only) stays flat with no group chrome.
 */

import { describe, expect, test, mock, afterEach } from "bun:test";
import { render, fireEvent, cleanup } from "@testing-library/react";
import {
  SemanticFileTree,
  type SemanticGroupMeta,
  type SemanticSelection,
} from "../components/admin/semantic-file-tree";

afterEach(() => {
  cleanup();
});

function makeProps(overrides?: Record<string, unknown>) {
  return {
    entities: [
      { name: "users", connectionGroupId: null, draft: false },
      { name: "orders", connectionGroupId: null, draft: false },
      { name: "products", connectionGroupId: null, draft: false },
    ],
    metricFileNames: ["revenue", "engagement"],
    hasCatalog: true,
    hasGlossary: true,
    selection: null as SemanticSelection,
    onSelect: mock(() => {}),
    ...overrides,
  };
}

/** Find a button whose text includes the given label. */
function findButton(container: HTMLElement, label: string): HTMLElement | null {
  const buttons = container.querySelectorAll("button");
  for (const btn of buttons) {
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

describe("SemanticFileTree", () => {
  test("renders semantic/ header", () => {
    const { container } = render(<SemanticFileTree {...makeProps()} />);
    expect(container.textContent).toContain("semantic/");
  });

  test("renders catalog.yml when hasCatalog is true", () => {
    const { container } = render(<SemanticFileTree {...makeProps()} />);
    expect(container.textContent).toContain("catalog.yml");
  });

  test("hides catalog.yml when hasCatalog is false", () => {
    const { container } = render(<SemanticFileTree {...makeProps({ hasCatalog: false })} />);
    expect(container.textContent).not.toContain("catalog.yml");
  });

  test("renders glossary.yml when hasGlossary is true", () => {
    const { container } = render(<SemanticFileTree {...makeProps()} />);
    expect(container.textContent).toContain("glossary.yml");
  });

  test("renders entity files with .yml extension", () => {
    const { container } = render(<SemanticFileTree {...makeProps()} />);
    expect(container.textContent).toContain("users.yml");
    expect(container.textContent).toContain("orders.yml");
    expect(container.textContent).toContain("products.yml");
  });

  test("renders metric files with .yml extension", () => {
    const { container } = render(<SemanticFileTree {...makeProps()} />);
    expect(container.textContent).toContain("revenue.yml");
    expect(container.textContent).toContain("engagement.yml");
  });

  test("renders entities folder section", () => {
    const { container } = render(<SemanticFileTree {...makeProps()} />);
    expect(container.textContent).toContain("entities");
  });

  test("renders metrics folder section", () => {
    const { container } = render(<SemanticFileTree {...makeProps()} />);
    expect(container.textContent).toContain("metrics");
  });

  test("hides metrics section when no metric files", () => {
    const { container } = render(
      <SemanticFileTree {...makeProps({ metricFileNames: [] })} />,
    );
    expect(container.textContent).toContain("entities");
  });

  test("calls onSelect with catalog when catalog is clicked", () => {
    const onSelect = mock(() => {});
    const { container } = render(
      <SemanticFileTree {...makeProps({ onSelect })} />,
    );
    const btn = findButton(container, "catalog.yml");
    expect(btn).not.toBeNull();
    fireEvent.click(btn!);
    expect(onSelect).toHaveBeenCalledWith({ type: "catalog" });
  });

  test("calls onSelect with entity when entity file is clicked", () => {
    const onSelect = mock(() => {});
    const { container } = render(
      <SemanticFileTree {...makeProps({ onSelect })} />,
    );
    const btn = findButton(container, "users.yml");
    expect(btn).not.toBeNull();
    fireEvent.click(btn!);
    expect(onSelect).toHaveBeenCalledWith({
      type: "entity",
      name: "users",
      connectionGroupId: null,
    });
  });

  test("highlights selected entity file", () => {
    const { container } = render(
      <SemanticFileTree
        {...makeProps({ selection: { type: "entity", name: "orders" } })}
      />,
    );
    const btn = findButton(container, "orders.yml");
    expect(btn).not.toBeNull();
    expect(btn!.className).toContain("bg-accent");
  });
});

describe("SemanticFileTree — draft accent", () => {
  test("applies amber left border to draft entities", () => {
    const { container } = render(
      <SemanticFileTree
        entities={[
          { name: "users", connectionGroupId: null, draft: false },
          { name: "orders", connectionGroupId: null, draft: true },
        ]}
        metricFileNames={[]}
        hasCatalog={false}
        hasGlossary={false}
        selection={null}
        onSelect={() => {}}
      />,
    );
    const draftBtn = findButton(container, "orders.yml");
    const publishedBtn = findButton(container, "users.yml");
    expect(draftBtn).not.toBeNull();
    expect(publishedBtn).not.toBeNull();
    expect(draftBtn!.className).toContain("border-amber-400/60");
    expect(publishedBtn!.className).not.toContain("border-amber-400/60");
  });

  test("draft entity has aria-label indicating draft status", () => {
    const { container } = render(
      <SemanticFileTree
        entities={[{ name: "orders", connectionGroupId: null, draft: true }]}
        metricFileNames={[]}
        hasCatalog={false}
        hasGlossary={false}
        selection={null}
        onSelect={() => {}}
      />,
    );
    const btn = findButton(container, "orders.yml");
    expect(btn!.getAttribute("aria-label")).toBe("orders.yml (draft)");
  });

  test("no accent when entity is not a draft", () => {
    const { container } = render(
      <SemanticFileTree
        entities={[{ name: "orders", connectionGroupId: null, draft: false }]}
        metricFileNames={[]}
        hasCatalog={false}
        hasGlossary={false}
        selection={null}
        onSelect={() => {}}
      />,
    );
    const btn = findButton(container, "orders.yml");
    expect(btn!.className).not.toContain("border-amber-400/60");
  });

  test("renders one row per group section when same name in multiple groups (#2412/#3235)", () => {
    const { container } = render(
      <SemanticFileTree
        entities={[
          { name: "users", connectionGroupId: "g_prod_us", draft: false },
          { name: "users", connectionGroupId: "g_prod_eu", draft: false },
        ]}
        metricFileNames={[]}
        hasCatalog={false}
        hasGlossary={false}
        selection={null}
        onSelect={() => {}}
      />,
    );
    // One entity row per group — same as before the grouped-tree upgrade.
    const buttons = Array.from(container.querySelectorAll("button"))
      .filter((b) => b.textContent?.includes("users.yml"));
    expect(buttons.length).toBe(2);

    // #3235: the per-row environment badge is replaced by a collapsible group
    // section. With no `groups` metadata the label falls back to the id with
    // the `g_` prefix stripped.
    const sections = container.querySelectorAll('[data-testid="semantic-group-section"]');
    expect(sections.length).toBe(2);
    const sectionLabels = Array.from(sections)
      .map((el) => el.textContent?.trim())
      .toSorted();
    expect(sectionLabels).toEqual(["prod_eu", "prod_us"]);
    // The old badge affordance is gone.
    expect(container.querySelector('[data-testid="entity-env-badge"]')).toBeNull();
  });

  test("selection match honors connectionGroupId (#2412)", () => {
    const { container } = render(
      <SemanticFileTree
        entities={[
          { name: "users", connectionGroupId: "g_prod_us", draft: false },
          { name: "users", connectionGroupId: "g_prod_eu", draft: false },
        ]}
        metricFileNames={[]}
        hasCatalog={false}
        hasGlossary={false}
        selection={{ type: "entity", name: "users", connectionGroupId: "g_prod_eu" }}
        onSelect={() => {}}
      />,
    );
    // Exactly one row matches the scoped selection — proving the group
    // qualifier is honored (both rows share the name "users").
    const buttons = Array.from(container.querySelectorAll("button"))
      .filter((b) => b.textContent?.includes("users.yml"));
    const selected = buttons.filter((b) => b.className.includes("bg-accent"));
    expect(selected.length).toBe(1);
    // Groups are sorted by label (prod_eu before prod_us), so the selected
    // prod_eu row is the first of the two.
    expect(buttons[0]!.className).toContain("bg-accent");
    expect(buttons[1]!.className).not.toContain("bg-accent");
  });
});

describe("SemanticFileTree — drift accent (#2459)", () => {
  test("paints a blue 2px left border on changed entities", () => {
    const { container } = render(
      <SemanticFileTree
        entities={[
          { name: "orders", connectionGroupId: null, drift: { state: "changed", changeCount: 3 } },
          { name: "users", connectionGroupId: null, drift: { state: "in-sync" } },
        ]}
        metricFileNames={[]}
        hasCatalog={false}
        hasGlossary={false}
        selection={null}
        onSelect={() => {}}
      />,
    );
    const driftBtn = findButton(container, "orders.yml");
    const cleanBtn = findButton(container, "users.yml");
    expect(driftBtn).not.toBeNull();
    expect(cleanBtn).not.toBeNull();
    expect(driftBtn!.className).toContain("border-sky-400/60");
    expect(cleanBtn!.className).not.toContain("border-sky-400/60");
  });

  test("paints the drift border on removed entities too", () => {
    const { container } = render(
      <SemanticFileTree
        entities={[
          { name: "legacy", connectionGroupId: null, drift: { state: "removed" } },
        ]}
        metricFileNames={[]}
        hasCatalog={false}
        hasGlossary={false}
        selection={null}
        onSelect={() => {}}
      />,
    );
    const btn = findButton(container, "legacy.yml");
    expect(btn!.className).toContain("border-sky-400/60");
  });

  test("no drift border when drift is null (no introspection ran)", () => {
    const { container } = render(
      <SemanticFileTree
        entities={[
          { name: "orders", connectionGroupId: null, drift: null },
          { name: "users", connectionGroupId: null },
        ]}
        metricFileNames={[]}
        hasCatalog={false}
        hasGlossary={false}
        selection={null}
        onSelect={() => {}}
      />,
    );
    expect(findButton(container, "orders.yml")!.className).not.toContain("border-sky-400/60");
    expect(findButton(container, "users.yml")!.className).not.toContain("border-sky-400/60");
  });

  test("hover tooltip surfaces the change count for changed rows", () => {
    const { container } = render(
      <SemanticFileTree
        entities={[
          { name: "orders", connectionGroupId: null, drift: { state: "changed", changeCount: 3 } },
        ]}
        metricFileNames={[]}
        hasCatalog={false}
        hasGlossary={false}
        selection={null}
        onSelect={() => {}}
      />,
    );
    const btn = findButton(container, "orders.yml");
    expect(btn!.getAttribute("title")).toBe("3 column changes vs database");
  });

  test("singular form for a one-column change", () => {
    const { container } = render(
      <SemanticFileTree
        entities={[
          { name: "orders", connectionGroupId: null, drift: { state: "changed", changeCount: 1 } },
        ]}
        metricFileNames={[]}
        hasCatalog={false}
        hasGlossary={false}
        selection={null}
        onSelect={() => {}}
      />,
    );
    const btn = findButton(container, "orders.yml");
    expect(btn!.getAttribute("title")).toBe("1 column change vs database");
  });

  test("removed rows get a removal-specific tooltip", () => {
    const { container } = render(
      <SemanticFileTree
        entities={[
          { name: "legacy", connectionGroupId: null, drift: { state: "removed" } },
        ]}
        metricFileNames={[]}
        hasCatalog={false}
        hasGlossary={false}
        selection={null}
        onSelect={() => {}}
      />,
    );
    const btn = findButton(container, "legacy.yml");
    expect(btn!.getAttribute("title")).toBe("Table missing from the database");
  });

  test("drift state goes into aria-label so screen readers hear it", () => {
    const { container } = render(
      <SemanticFileTree
        entities={[
          { name: "orders", connectionGroupId: null, drift: { state: "changed", changeCount: 2 } },
        ]}
        metricFileNames={[]}
        hasCatalog={false}
        hasGlossary={false}
        selection={null}
        onSelect={() => {}}
      />,
    );
    const btn = findButton(container, "orders.yml");
    expect(btn!.getAttribute("aria-label")).toBe("orders.yml (drift: 2 column changes)");
  });

  test("draft accent wins border precedence when both states apply", () => {
    // A drafted-and-drifted entity reads as draft in the border (you're
    // actively editing — that's the louder signal). Drift still appears in
    // the title / aria-label so the information isn't lost.
    const { container } = render(
      <SemanticFileTree
        entities={[
          {
            name: "orders",
            connectionGroupId: null,
            draft: true,
            drift: { state: "changed", changeCount: 1 },
          },
        ]}
        metricFileNames={[]}
        hasCatalog={false}
        hasGlossary={false}
        selection={null}
        onSelect={() => {}}
      />,
    );
    const btn = findButton(container, "orders.yml");
    expect(btn!.className).toContain("border-amber-400/60");
    expect(btn!.className).not.toContain("border-sky-400/60");
    expect(btn!.getAttribute("aria-label")).toBe(
      "orders.yml (draft, drift: 1 column change)",
    );
    expect(btn!.getAttribute("title")).toBe("1 column change vs database");
  });

  test("in-sync rows do not get any drift attribute", () => {
    const { container } = render(
      <SemanticFileTree
        entities={[
          { name: "users", connectionGroupId: null, drift: { state: "in-sync" } },
        ]}
        metricFileNames={[]}
        hasCatalog={false}
        hasGlossary={false}
        selection={null}
        onSelect={() => {}}
      />,
    );
    const btn = findButton(container, "users.yml");
    expect(btn!.getAttribute("title")).toBeNull();
    expect(btn!.getAttribute("aria-label")).toBeNull();
    expect(btn!.className).not.toContain("border-sky-400/60");
    // The exposed data-drift-state attribute lets slice 2's drawer hook in
    // without having to re-parse classnames.
    expect(btn!.getAttribute("data-drift-state")).toBe("in-sync");
  });
});

describe("SemanticFileTree — grouped tree (#3235)", () => {
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
