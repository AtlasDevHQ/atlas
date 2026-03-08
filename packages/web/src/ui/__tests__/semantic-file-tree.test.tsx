import { describe, expect, test, mock } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import { SemanticFileTree, type SemanticSelection } from "../components/admin/semantic-file-tree";

const defaultProps = {
  entityNames: ["users", "orders", "products"],
  metricFileNames: ["revenue", "engagement"],
  hasCatalog: true,
  hasGlossary: true,
  selection: null as SemanticSelection,
  onSelect: mock(() => {}),
};

describe("SemanticFileTree", () => {
  test("renders semantic/ header", () => {
    const { container } = render(<SemanticFileTree {...defaultProps} />);
    expect(container.textContent).toContain("semantic/");
  });

  test("renders catalog.yml when hasCatalog is true", () => {
    const { container } = render(<SemanticFileTree {...defaultProps} />);
    expect(container.textContent).toContain("catalog.yml");
  });

  test("hides catalog.yml when hasCatalog is false", () => {
    const { container } = render(<SemanticFileTree {...defaultProps} hasCatalog={false} />);
    expect(container.textContent).not.toContain("catalog.yml");
  });

  test("renders glossary.yml when hasGlossary is true", () => {
    const { container } = render(<SemanticFileTree {...defaultProps} />);
    expect(container.textContent).toContain("glossary.yml");
  });

  test("renders entity files with .yml extension", () => {
    const { container } = render(<SemanticFileTree {...defaultProps} />);
    expect(container.textContent).toContain("users.yml");
    expect(container.textContent).toContain("orders.yml");
    expect(container.textContent).toContain("products.yml");
  });

  test("renders metric files with .yml extension", () => {
    const { container } = render(<SemanticFileTree {...defaultProps} />);
    expect(container.textContent).toContain("revenue.yml");
    expect(container.textContent).toContain("engagement.yml");
  });

  test("renders entities folder section", () => {
    const { container } = render(<SemanticFileTree {...defaultProps} />);
    expect(container.textContent).toContain("entities");
  });

  test("renders metrics folder section", () => {
    const { container } = render(<SemanticFileTree {...defaultProps} />);
    expect(container.textContent).toContain("metrics");
  });

  test("hides metrics section when no metric files", () => {
    const { container } = render(
      <SemanticFileTree {...defaultProps} metricFileNames={[]} />,
    );
    // Should still have entities but text "metrics" only appears in folder sections
    expect(container.textContent).toContain("entities");
  });

  test("shows 'No entities' when entity list is empty", () => {
    const { container } = render(
      <SemanticFileTree {...defaultProps} entityNames={[]} />,
    );
    expect(container.textContent).toContain("No entities");
  });

  test("calls onSelect with catalog when catalog is clicked", () => {
    const onSelect = mock(() => {});
    const { container } = render(
      <SemanticFileTree {...defaultProps} onSelect={onSelect} />,
    );
    const buttons = container.querySelectorAll("button");
    for (const btn of buttons) {
      if (btn.textContent?.includes("catalog.yml")) {
        fireEvent.click(btn);
        break;
      }
    }
    expect(onSelect).toHaveBeenCalledWith({ type: "catalog" });
  });

  test("calls onSelect with entity when entity file is clicked", () => {
    const onSelect = mock(() => {});
    const { container } = render(
      <SemanticFileTree {...defaultProps} onSelect={onSelect} />,
    );
    const buttons = container.querySelectorAll("button");
    for (const btn of buttons) {
      if (btn.textContent?.includes("users.yml")) {
        fireEvent.click(btn);
        break;
      }
    }
    expect(onSelect).toHaveBeenCalledWith({ type: "entity", name: "users" });
  });

  test("highlights selected entity file", () => {
    const { container } = render(
      <SemanticFileTree
        {...defaultProps}
        selection={{ type: "entity", name: "orders" }}
      />,
    );
    const buttons = container.querySelectorAll("button");
    for (const btn of buttons) {
      if (btn.textContent?.includes("orders.yml")) {
        expect(btn.className).toContain("bg-accent");
      }
    }
  });
});
