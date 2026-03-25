import { describe, expect, test } from "bun:test";
import type React from "react";
import { render, fireEvent } from "@testing-library/react";
import { ResultCardBase, ResultCardErrorBoundary } from "../components/chat/result-card-base";

describe("ResultCardBase", () => {
  test("renders badge text", () => {
    const { container } = render(
      <ResultCardBase badge="SQL" badgeClassName="bg-blue-100" title="Test query">
        <div>content</div>
      </ResultCardBase>,
    );
    expect(container.textContent).toContain("SQL");
  });

  test("renders title text", () => {
    const { container } = render(
      <ResultCardBase badge="SQL" badgeClassName="bg-blue-100" title="Top companies by revenue">
        <div>content</div>
      </ResultCardBase>,
    );
    expect(container.textContent).toContain("Top companies by revenue");
  });

  test("renders headerExtra content", () => {
    const { container } = render(
      <ResultCardBase
        badge="SQL"
        badgeClassName="bg-blue-100"
        title="Query"
        headerExtra={<span data-testid="row-count">5 rows</span>}
      >
        <div>content</div>
      </ResultCardBase>,
    );
    expect(container.textContent).toContain("5 rows");
  });

  test("headerExtra remains visible after collapse", () => {
    const { container } = render(
      <ResultCardBase
        badge="SQL"
        badgeClassName="bg-blue-100"
        title="Query"
        headerExtra={<span data-testid="row-count">5 rows</span>}
      >
        <div>content</div>
      </ResultCardBase>,
    );

    const toggleBtn = container.querySelector("button")!;
    fireEvent.click(toggleBtn);
    // headerExtra is in the header, not the body — should persist
    expect(container.textContent).toContain("5 rows");
    expect(container.querySelector("[data-testid='row-count']")).not.toBeNull();
  });

  test("renders children when expanded (default)", () => {
    const { container } = render(
      <ResultCardBase badge="SQL" badgeClassName="bg-blue-100" title="Query">
        <div data-testid="child-content">table here</div>
      </ResultCardBase>,
    );
    expect(container.querySelector("[data-testid='child-content']")).not.toBeNull();
  });

  test("collapse hides children", () => {
    const { container } = render(
      <ResultCardBase badge="SQL" badgeClassName="bg-blue-100" title="Query">
        <div data-testid="child-content">table here</div>
      </ResultCardBase>,
    );

    // Click header to collapse
    const toggleBtn = container.querySelector("button")!;
    fireEvent.click(toggleBtn);
    expect(container.querySelector("[data-testid='child-content']")).toBeNull();
  });

  test("expand after collapse restores children", () => {
    const { container } = render(
      <ResultCardBase badge="SQL" badgeClassName="bg-blue-100" title="Query">
        <div data-testid="child-content">table here</div>
      </ResultCardBase>,
    );

    const toggleBtn = container.querySelector("button")!;
    // Collapse
    fireEvent.click(toggleBtn);
    expect(container.querySelector("[data-testid='child-content']")).toBeNull();
    // Expand
    fireEvent.click(toggleBtn);
    expect(container.querySelector("[data-testid='child-content']")).not.toBeNull();
  });

  test("defaultOpen=false starts collapsed", () => {
    const { container } = render(
      <ResultCardBase badge="SQL" badgeClassName="bg-blue-100" title="Query" defaultOpen={false}>
        <div data-testid="child-content">table here</div>
      </ResultCardBase>,
    );
    expect(container.querySelector("[data-testid='child-content']")).toBeNull();
  });

  test("defaultOpen=false can be expanded", () => {
    const { container } = render(
      <ResultCardBase badge="SQL" badgeClassName="bg-blue-100" title="Query" defaultOpen={false}>
        <div data-testid="child-content">table here</div>
      </ResultCardBase>,
    );

    const toggleBtn = container.querySelector("button")!;
    fireEvent.click(toggleBtn);
    expect(container.querySelector("[data-testid='child-content']")).not.toBeNull();
  });

  test("applies badgeClassName to badge element", () => {
    const { container } = render(
      <ResultCardBase badge="Python" badgeClassName="bg-emerald-100 text-emerald-700" title="Script">
        <div>content</div>
      </ResultCardBase>,
    );
    const badge = container.querySelector("button span:first-child")!;
    expect(badge.className).toContain("bg-emerald-100");
    expect(badge.className).toContain("text-emerald-700");
  });

  test("applies contentClassName to content wrapper", () => {
    const { container } = render(
      <ResultCardBase
        badge="Python"
        badgeClassName="bg-emerald-100"
        title="Script"
        contentClassName="space-y-2 px-3 py-2"
      >
        <div data-testid="child-content">content</div>
      </ResultCardBase>,
    );
    const contentWrapper = container.querySelector("[data-testid='child-content']")!.parentElement!;
    expect(contentWrapper.className).toContain("space-y-2");
    expect(contentWrapper.className).toContain("px-3");
  });

  test("shows collapse arrow ▾ when expanded", () => {
    const { container } = render(
      <ResultCardBase badge="SQL" badgeClassName="bg-blue-100" title="Query">
        <div>content</div>
      </ResultCardBase>,
    );
    expect(container.textContent).toContain("\u25BE");
  });

  test("shows expand arrow ▸ when collapsed", () => {
    const { container } = render(
      <ResultCardBase badge="SQL" badgeClassName="bg-blue-100" title="Query" defaultOpen={false}>
        <div>content</div>
      </ResultCardBase>,
    );
    expect(container.textContent).toContain("\u25B8");
  });

  test("toggle button has aria-expanded=true when open", () => {
    const { container } = render(
      <ResultCardBase badge="SQL" badgeClassName="bg-blue-100" title="Query">
        <div>content</div>
      </ResultCardBase>,
    );
    const toggleBtn = container.querySelector("button")!;
    expect(toggleBtn.getAttribute("aria-expanded")).toBe("true");
  });

  test("toggle button has aria-expanded=false when collapsed", () => {
    const { container } = render(
      <ResultCardBase badge="SQL" badgeClassName="bg-blue-100" title="Query">
        <div>content</div>
      </ResultCardBase>,
    );
    const toggleBtn = container.querySelector("button")!;
    fireEvent.click(toggleBtn);
    expect(toggleBtn.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("ResultCardErrorBoundary", () => {
  // Suppress console.error from the error boundary during tests
  const originalError = console.error;
  const suppress = () => { console.error = () => {}; };
  const restore = () => { console.error = originalError; };

  test("renders children when no error", () => {
    const { container } = render(
      <ResultCardErrorBoundary label="SQL">
        <div data-testid="child">hello</div>
      </ResultCardErrorBoundary>,
    );
    expect(container.querySelector("[data-testid='child']")).not.toBeNull();
  });

  test("renders error message when child throws", () => {
    suppress();
    function ThrowingChild(): React.ReactElement {
      throw new Error("render boom");
    }

    const { container } = render(
      <ResultCardErrorBoundary label="SQL">
        <ThrowingChild />
      </ResultCardErrorBoundary>,
    );
    restore();

    expect(container.textContent).toContain("SQL result could not be rendered");
    expect(container.textContent).toContain("render boom");
  });

  test("uses label prop in error message", () => {
    suppress();
    function ThrowingChild(): React.ReactElement {
      throw new Error("oops");
    }

    const { container } = render(
      <ResultCardErrorBoundary label="Python">
        <ThrowingChild />
      </ResultCardErrorBoundary>,
    );
    restore();

    expect(container.textContent).toContain("Python result could not be rendered");
  });

  test("shows fallback when error has no message", () => {
    suppress();
    function ThrowingChild(): React.ReactElement {
      throw new Error();
    }

    const { container } = render(
      <ResultCardErrorBoundary label="Test">
        <ThrowingChild />
      </ResultCardErrorBoundary>,
    );
    restore();

    expect(container.textContent).toContain("Test result could not be rendered");
    expect(container.textContent).toContain("unknown error");
  });
});
