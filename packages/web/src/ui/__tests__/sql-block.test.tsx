import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { SQLBlock } from "../components/chat/sql-block";

describe("SQLBlock", () => {
  test("renders SQL text in fallback pre/code before highlighter loads", () => {
    const sql = "SELECT * FROM companies WHERE revenue > 100000";
    const { container } = render(<SQLBlock sql={sql} />);
    // Before lazy highlighter loads, falls back to pre/code
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toContain(sql);
  });

  test("renders copy button", () => {
    const { container } = render(<SQLBlock sql="SELECT 1" />);
    const button = container.querySelector("button");
    expect(button).not.toBeNull();
    expect(button!.textContent).toContain("Copy SQL");
  });

  test("renders multiline SQL", () => {
    const sql = "SELECT\n  name,\n  revenue\nFROM companies\nORDER BY revenue DESC";
    const { container } = render(<SQLBlock sql={sql} />);
    expect(container.textContent).toContain("SELECT");
    expect(container.textContent).toContain("ORDER BY");
  });

  test("renders empty SQL without crashing", () => {
    const { container } = render(<SQLBlock sql="" />);
    expect(container).not.toBeNull();
  });
});
