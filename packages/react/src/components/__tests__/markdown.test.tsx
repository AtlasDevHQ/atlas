import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { Markdown } from "../chat/markdown";

describe("Markdown", () => {
  test("renders plain text", () => {
    const { container } = render(<Markdown content="Hello world" />);
    expect(container.textContent).toContain("Hello world");
  });

  test("renders code blocks with fallback pre (before syntax highlighter loads)", () => {
    const { container } = render(
      <Markdown content={"```sql\nSELECT * FROM users\n```"} />,
    );
    expect(container.textContent).toContain("SELECT * FROM users");
  });

  test("does NOT evaluate raw HTML (sanitization)", () => {
    const { container } = render(
      <Markdown content={'<script>window.__pwned = true;</script><b>bold?</b>'} />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
  });

  // #3138 — disallowImages closes the IP/referrer-tracking vector on
  // untrusted / publicly-shared surfaces.
  test("renders a markdown image by default", () => {
    const { container } = render(
      <Markdown content={"![pixel](https://attacker.example/track.png)"} />,
    );
    expect(container.querySelector("img")).not.toBeNull();
  });

  test("disallowImages strips markdown images (no network fetch)", () => {
    const { container } = render(
      <Markdown
        content={"![pixel](https://attacker.example/track.png)\n\nVisible text"}
        disallowImages
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("Visible text");
  });
});
