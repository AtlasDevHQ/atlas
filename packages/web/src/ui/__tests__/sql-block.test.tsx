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

  // ⚠️ THE CODE SURFACE DOES NOT FOLLOW THE MODE. PRODUCT.md Principle 5: the
  // SQL pane is an "always-dark terminal window (--code-*), identical on every
  // surface and mode". This shipped as `bg-zinc-100 dark:bg-zinc-800` under
  // `dark ? oneDark : oneLight`, so in light mode the most brand-defining
  // component in the product was a light grey box (#5306). Mutation: restore
  // `bg-zinc-100` on the fallback pre → this test goes red.
  test("the fallback pane is the dark code surface, not a mode-following grey", () => {
    const { container } = render(<SQLBlock sql="SELECT 1" />);
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    const cls = pre!.className;
    expect(cls).toContain("bg-code-bg");
    expect(cls).toContain("text-code-fg");
    expect(cls).not.toMatch(/bg-(white|zinc|slate|gray|neutral)/);
  });

  test("renders empty SQL without crashing", () => {
    const { container } = render(<SQLBlock sql="" />);
    expect(container).not.toBeNull();
  });
});
