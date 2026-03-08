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
    const { container } = render(
      <EntityList entities={makeEntities()} selectedName={null} onSelect={() => {}} />,
    );
    expect(container.textContent).toContain("view");
  });

  test("shows non-default connection badge", () => {
    const { container } = render(
      <EntityList entities={makeEntities()} selectedName={null} onSelect={() => {}} />,
    );
    expect(container.textContent).toContain("warehouse");
  });

  test("filters entities by search", () => {
    const { container } = render(
      <EntityList entities={makeEntities()} selectedName={null} onSelect={() => {}} />,
    );
    const input = container.querySelector("input")!;
    fireEvent.change(input, { target: { value: "revenue" } });

    const buttons = container.querySelectorAll("button");
    // Only revenue_view should match
    let found = false;
    for (const btn of buttons) {
      if (btn.textContent?.includes("revenue_view")) found = true;
      expect(btn.textContent).not.toContain("users");
    }
    expect(found).toBe(true);
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
    // Find the button that contains "users"
    const buttons = container.querySelectorAll("button");
    for (const btn of buttons) {
      if (btn.textContent?.includes("users")) {
        fireEvent.click(btn);
        break;
      }
    }
    expect(onSelect).toHaveBeenCalledWith("users");
  });

  test("highlights selected entity", () => {
    const { container } = render(
      <EntityList entities={makeEntities()} selectedName="orders" onSelect={() => {}} />,
    );
    const buttons = container.querySelectorAll("button");
    for (const btn of buttons) {
      if (btn.textContent?.includes("orders")) {
        expect(btn.className).toContain("bg-accent");
      }
    }
  });

  test("searches by description", () => {
    const { container } = render(
      <EntityList entities={makeEntities()} selectedName={null} onSelect={() => {}} />,
    );
    const input = container.querySelector("input")!;
    fireEvent.change(input, { target: { value: "catalog" } });
    expect(container.textContent).toContain("products");
  });
});
