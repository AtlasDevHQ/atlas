import { describe, expect, test, mock } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import { EntityList, type EntitySummary } from "../components/admin/entity-list";

function makeEntities(): EntitySummary[] {
  return [
    { name: "users", description: "User accounts", columnCount: 8 },
    { name: "orders", description: "Customer orders", type: "table", columnCount: 12, connectionId: "default" },
    { name: "revenue_view", description: "Revenue aggregates", type: "view", columnCount: 4 },
    { name: "products", description: "Product catalog", columnCount: 6, connectionId: "warehouse" },
  ];
}

/** Find the entity button whose text includes the given name. */
function findEntityButton(container: HTMLElement, name: string): HTMLElement | null {
  const buttons = container.querySelectorAll("button");
  for (const btn of buttons) {
    if (btn.textContent?.includes(name)) return btn as HTMLElement;
  }
  return null;
}

describe("EntityList", () => {
  test("renders all entities", () => {
    const onSelect = mock(() => {});
    const { container } = render(
      <EntityList entities={makeEntities()} selectedName={null} onSelect={onSelect} />,
    );
    expect(container.textContent).toContain("users");
    expect(container.textContent).toContain("orders");
    expect(container.textContent).toContain("revenue_view");
    expect(container.textContent).toContain("products");
  });

  test("displays column counts", () => {
    const { container } = render(
      <EntityList entities={makeEntities()} selectedName={null} onSelect={() => {}} />,
    );
    expect(container.textContent).toContain("8 cols");
    expect(container.textContent).toContain("12 cols");
  });

  test("shows view badge for view entities", () => {
    // Render only the view entity to avoid false positives from "Overview"
    const { container } = render(
      <EntityList
        entities={[{ name: "revenue_view", description: "Revenue aggregates", type: "view", columnCount: 4 }]}
        selectedName={null}
        onSelect={() => {}}
      />,
    );
    const btn = findEntityButton(container, "revenue_view");
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toContain("view");
  });

  test("shows non-default connection badge", () => {
    const { container } = render(
      <EntityList entities={makeEntities()} selectedName={null} onSelect={() => {}} />,
    );
    expect(container.textContent).toContain("warehouse");
  });

  test("filters entities by search — shows only matching results", () => {
    const { container } = render(
      <EntityList entities={makeEntities()} selectedName={null} onSelect={() => {}} />,
    );
    const input = container.querySelector("input")!;
    fireEvent.change(input, { target: { value: "revenue" } });

    // revenue_view should be present, others absent
    expect(findEntityButton(container, "revenue_view")).not.toBeNull();
    expect(findEntityButton(container, "users")).toBeNull();
    expect(findEntityButton(container, "orders")).toBeNull();
    expect(findEntityButton(container, "products")).toBeNull();
  });

  test("shows 'No matches' when search has no results", () => {
    const { container } = render(
      <EntityList entities={makeEntities()} selectedName={null} onSelect={() => {}} />,
    );
    const input = container.querySelector("input")!;
    fireEvent.change(input, { target: { value: "zzzzz" } });
    expect(container.textContent).toContain("No matches");
  });

  test("shows 'No entities found' when list is empty", () => {
    const { container } = render(
      <EntityList entities={[]} selectedName={null} onSelect={() => {}} />,
    );
    expect(container.textContent).toContain("No entities found");
  });

  test("calls onSelect when entity is clicked", () => {
    const onSelect = mock(() => {});
    const { container } = render(
      <EntityList entities={makeEntities()} selectedName={null} onSelect={onSelect} />,
    );
    const btn = findEntityButton(container, "users");
    expect(btn).not.toBeNull();
    fireEvent.click(btn!);
    expect(onSelect).toHaveBeenCalledWith("users");
  });

  test("highlights selected entity", () => {
    const { container } = render(
      <EntityList entities={makeEntities()} selectedName="orders" onSelect={() => {}} />,
    );
    const btn = findEntityButton(container, "orders");
    expect(btn).not.toBeNull();
    expect(btn!.className).toContain("bg-accent");
  });

  test("searches by description", () => {
    const { container } = render(
      <EntityList entities={makeEntities()} selectedName={null} onSelect={() => {}} />,
    );
    const input = container.querySelector("input")!;
    fireEvent.change(input, { target: { value: "catalog" } });
    expect(findEntityButton(container, "products")).not.toBeNull();
  });
});
