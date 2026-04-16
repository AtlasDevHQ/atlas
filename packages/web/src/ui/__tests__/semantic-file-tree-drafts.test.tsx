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
        entityNames={["users", "orders"]}
        metricFileNames={[]}
        hasCatalog={false}
        hasGlossary={false}
        selection={null}
        onSelect={() => {}}
        draftEntityNames={new Set(["orders"])}
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
        entityNames={["orders"]}
        metricFileNames={[]}
        hasCatalog={false}
        hasGlossary={false}
        selection={null}
        onSelect={() => {}}
        draftEntityNames={new Set(["orders"])}
      />,
    );
    const btn = findEntityButton(container, "orders.yml");
    expect(btn!.getAttribute("aria-label")).toBe("orders.yml (draft)");
  });

  test("no accent when draftEntityNames prop is omitted", () => {
    const { container } = render(
      <SemanticFileTree
        entityNames={["orders"]}
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
});
