import { describe, expect, test, afterEach } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import { SemanticFileTree } from "../components/admin/semantic-file-tree";

function findEntityButton(container: HTMLElement, fileName: string): HTMLElement | null {
  const buttons = container.querySelectorAll("button");
  for (const btn of buttons) {
    if (btn.textContent?.includes(fileName)) return btn as HTMLElement;
  }
  return null;
}

describe("SemanticFileTree — draft accent", () => {
  afterEach(() => {
    cleanup();
  });

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
    const draftBtn = findEntityButton(container, "orders.yml");
    const publishedBtn = findEntityButton(container, "users.yml");
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
    const btn = findEntityButton(container, "orders.yml");
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
    const btn = findEntityButton(container, "orders.yml");
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
