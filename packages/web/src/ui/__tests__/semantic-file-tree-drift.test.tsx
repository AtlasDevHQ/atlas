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

describe("SemanticFileTree — drift accent (#2459)", () => {
  afterEach(() => {
    cleanup();
  });

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
    const driftBtn = findEntityButton(container, "orders.yml");
    const cleanBtn = findEntityButton(container, "users.yml");
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
    const btn = findEntityButton(container, "legacy.yml");
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
    expect(findEntityButton(container, "orders.yml")!.className).not.toContain("border-sky-400/60");
    expect(findEntityButton(container, "users.yml")!.className).not.toContain("border-sky-400/60");
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
    const btn = findEntityButton(container, "orders.yml");
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
    const btn = findEntityButton(container, "orders.yml");
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
    const btn = findEntityButton(container, "legacy.yml");
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
    const btn = findEntityButton(container, "orders.yml");
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
    const btn = findEntityButton(container, "orders.yml");
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
    const btn = findEntityButton(container, "users.yml");
    expect(btn!.getAttribute("title")).toBeNull();
    expect(btn!.getAttribute("aria-label")).toBeNull();
    expect(btn!.className).not.toContain("border-sky-400/60");
    // The exposed data-drift-state attribute lets slice 2's drawer hook in
    // without having to re-parse classnames.
    expect(btn!.getAttribute("data-drift-state")).toBe("in-sync");
  });
});
