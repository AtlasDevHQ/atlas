import { describe, expect, test, afterEach } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import { DemoBadge, DraftBadge } from "../components/admin/mode-badges";

describe("DemoBadge", () => {
  afterEach(() => {
    cleanup();
  });

  test("renders 'Demo' text", () => {
    const { container } = render(<DemoBadge />);
    expect(container.textContent).toBe("Demo");
  });

  test("has accessible label and title attribute", () => {
    const { container } = render(<DemoBadge />);
    const el = container.querySelector("[aria-label]");
    expect(el?.getAttribute("aria-label")).toBe("Demo content");
    expect(el?.getAttribute("title")).toBe("Part of the demo dataset");
  });

  test("applies caller-provided className in addition to defaults", () => {
    const { container } = render(<DemoBadge className="my-custom" />);
    const el = container.querySelector("[aria-label]");
    expect(el?.className).toContain("my-custom");
  });
});

describe("DraftBadge", () => {
  afterEach(() => {
    cleanup();
  });

  test("renders 'Draft' text", () => {
    const { container } = render(<DraftBadge />);
    expect(container.textContent).toBe("Draft");
  });

  test("has accessible label and title attribute", () => {
    const { container } = render(<DraftBadge />);
    const el = container.querySelector("[aria-label]");
    expect(el?.getAttribute("aria-label")).toBe("Draft — not yet published");
    expect(el?.getAttribute("title")).toBe("Draft — not yet published");
  });

  test("uses amber tint so it pairs with developer-mode banner", () => {
    const { container } = render(<DraftBadge />);
    const el = container.querySelector("[aria-label]");
    // Keep assertion broad so restyles within the amber family don't break
    // the test — we only care that the amber signal is present.
    expect(el?.className).toContain("amber");
  });
});
