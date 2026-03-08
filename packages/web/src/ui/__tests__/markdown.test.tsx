import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { Markdown } from "../components/chat/markdown";

describe("Markdown", () => {
  test("renders plain text", () => {
    const { container } = render(<Markdown content="Hello world" />);
    expect(container.textContent).toContain("Hello world");
  });

  test("renders bold text", () => {
    const { container } = render(<Markdown content="**bold text**" />);
    const strong = container.querySelector("strong");
    expect(strong).not.toBeNull();
    expect(strong!.textContent).toBe("bold text");
  });

  test("renders headings", () => {
    const { container } = render(
      <Markdown content={"# Heading 1\n## Heading 2\n### Heading 3"} />,
    );
    expect(container.querySelector("h1")?.textContent).toBe("Heading 1");
    expect(container.querySelector("h2")?.textContent).toBe("Heading 2");
    expect(container.querySelector("h3")?.textContent).toBe("Heading 3");
  });

  test("renders unordered lists", () => {
    const { container } = render(
      <Markdown content={"- item 1\n- item 2\n- item 3"} />,
    );
    const ul = container.querySelector("ul");
    expect(ul).not.toBeNull();
    const items = ul!.querySelectorAll("li");
    expect(items.length).toBe(3);
  });

  test("renders ordered lists", () => {
    const { container } = render(
      <Markdown content={"1. first\n2. second\n3. third"} />,
    );
    const ol = container.querySelector("ol");
    expect(ol).not.toBeNull();
  });

  test("renders inline code", () => {
    const { container } = render(
      <Markdown content="Use `SELECT * FROM table`" />,
    );
    const code = container.querySelector("code");
    expect(code).not.toBeNull();
    expect(code!.textContent).toContain("SELECT * FROM table");
  });

  test("renders code blocks with fallback pre (before syntax highlighter loads)", () => {
    const { container } = render(
      <Markdown content={'```sql\nSELECT 1;\n```'} />,
    );
    // Before lazy load, falls back to <pre><code>
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toContain("SELECT 1;");
  });

  test("renders blockquotes", () => {
    const { container } = render(
      <Markdown content="> This is a quote" />,
    );
    const blockquote = container.querySelector("blockquote");
    expect(blockquote).not.toBeNull();
    expect(blockquote!.textContent).toContain("This is a quote");
  });

  test("renders empty content without crashing", () => {
    const { container } = render(<Markdown content="" />);
    expect(container).not.toBeNull();
  });

  test("renders multiple paragraphs", () => {
    const { container } = render(
      <Markdown content={"First paragraph\n\nSecond paragraph"} />,
    );
    const paragraphs = container.querySelectorAll("p");
    expect(paragraphs.length).toBe(2);
  });

  test("renders markdown table content (GFM tables need remark-gfm plugin)", () => {
    const md = "| Col A | Col B |\n|-------|-------|\n| 1 | 2 |\n| 3 | 4 |";
    const { container } = render(<Markdown content={md} />);
    // react-markdown renders table content even without remark-gfm
    expect(container.textContent).toContain("Col A");
    expect(container.textContent).toContain("Col B");
  });
});
