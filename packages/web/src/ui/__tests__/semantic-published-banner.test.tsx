import { describe, expect, test, afterEach } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import { SemanticPublishedBanner } from "../components/admin/semantic-published-banner";

describe("SemanticPublishedBanner", () => {
  afterEach(() => {
    cleanup();
  });

  test("renders the PublishedBadge so admins see this is live state", () => {
    const { container } = render(<SemanticPublishedBanner />);
    const badge = container.querySelector(
      '[aria-label="Published — live in production"]',
    );
    expect(badge).toBeTruthy();
  });

  test("explains the state and points at the Add Entity action", () => {
    const { getByTestId } = render(<SemanticPublishedBanner />);
    const banner = getByTestId("semantic-published-banner");
    expect(banner.textContent).toContain("You");
    expect(banner.textContent).toContain("live semantic layer");
    expect(banner.textContent).toContain("Add Entity");
  });

  test("uses amber tint so it visually pairs with the dev-mode banner", () => {
    const { getByTestId } = render(<SemanticPublishedBanner />);
    // Restyles within the amber family are acceptable — we only want
    // the dev-mode visual signal to stick around.
    expect(getByTestId("semantic-published-banner").className).toContain("amber");
  });
});
