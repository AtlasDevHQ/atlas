import { describe, expect, test, afterEach } from "bun:test";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { PublishedContextWrapper } from "../components/admin/published-context-wrapper";

describe("PublishedContextWrapper", () => {
  afterEach(() => {
    cleanup();
  });

  test("renders children wrapped in an aria-hidden, non-interactive container", () => {
    const { getByText, container } = render(
      <PublishedContextWrapper
        resourceLabel="connection"
        action={{ label: "Create draft", onClick: () => {} }}
      >
        <div>Published demo connection</div>
      </PublishedContextWrapper>,
    );
    expect(getByText("Published demo connection")).toBeTruthy();

    // The rendered list should be hidden from assistive tech and
    // non-interactive so admins don't accidentally mutate the live
    // state while in this "context-only" view.
    const hidden = container.querySelector('[aria-hidden="true"]');
    expect(hidden?.className).toContain("pointer-events-none");
    expect(hidden?.className).toContain("opacity-60");
  });

  test("renders the Published badge + explanatory copy with the resource label", () => {
    const { container, getByText } = render(
      <PublishedContextWrapper
        resourceLabel="connection"
        action={{ label: "Create draft", onClick: () => {} }}
      >
        <div>child</div>
      </PublishedContextWrapper>,
    );
    const badge = container.querySelector('[aria-label="Published — live in production"]');
    expect(badge).toBeTruthy();
    expect(
      getByText(/You.*re viewing the live connection list/),
    ).toBeTruthy();
  });

  test("renders href-style CTA as a Next.js link", () => {
    const { getByRole } = render(
      <PublishedContextWrapper
        resourceLabel="prompt collection"
        action={{ label: "Create draft", href: "/admin/prompts/new" }}
      >
        <div>child</div>
      </PublishedContextWrapper>,
    );
    const link = getByRole("link", { name: /Create draft/ });
    expect(link.getAttribute("href")).toBe("/admin/prompts/new");
  });

  test("renders onClick-style CTA as a button that fires the handler", () => {
    let clicked = false;
    const { getByRole } = render(
      <PublishedContextWrapper
        resourceLabel="connection"
        action={{ label: "Create draft", onClick: () => { clicked = true; } }}
      >
        <div>child</div>
      </PublishedContextWrapper>,
    );
    const button = getByRole("button", { name: /Create draft/ });
    fireEvent.click(button);
    expect(clicked).toBe(true);
  });

  test("exposes an accessible label that notes the read-only state", () => {
    const { getByTestId } = render(
      <PublishedContextWrapper
        resourceLabel="connection"
        action={{ label: "Create draft", onClick: () => {} }}
      >
        <div>child</div>
      </PublishedContextWrapper>,
    );
    const wrapper = getByTestId("published-context-wrapper");
    expect(wrapper.getAttribute("aria-label")).toBe(
      "Published connections, read-only while in developer mode",
    );
  });
});
