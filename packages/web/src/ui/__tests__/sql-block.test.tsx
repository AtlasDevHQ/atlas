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

  // The fallback-pane / code-surface assertion (#5306) lives in its own file,
  // sql-block-fallback.test.tsx. It has to render SQLBlock before anything else
  // in the module registry has, because the component caches its lazily-imported
  // highlighter in module scope — the three renders above are exactly what used
  // to break it. That file says why in full; do not move it back here.

  test("renders empty SQL without crashing", () => {
    const { container } = render(<SQLBlock sql="" />);
    expect(container).not.toBeNull();
  });
});
