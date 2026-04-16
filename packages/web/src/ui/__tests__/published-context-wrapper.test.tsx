import { describe, expect, test, afterEach } from "bun:test";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { PublishedContextWrapper } from "../components/admin/published-context-wrapper";

const CONNECTION_LABEL = { singular: "connection", plural: "connections" } as const;
const ENTITY_LABEL = { singular: "entity", plural: "entities" } as const;
const PROMPT_LABEL = { singular: "prompt collection", plural: "prompt collections" } as const;

describe("PublishedContextWrapper", () => {
  afterEach(() => {
    cleanup();
  });

  test("renders children wrapped in an inert, non-interactive container", () => {
    const { getByText, container } = render(
      <PublishedContextWrapper
        resourceLabel={CONNECTION_LABEL}
        action={{ kind: "button", label: "Create draft", onClick: () => {} }}
      >
        <div>Published demo connection</div>
      </PublishedContextWrapper>,
    );
    expect(getByText("Published demo connection")).toBeTruthy();

    const inertBox = container.querySelector("[inert]");
    expect(inertBox).toBeTruthy();
    expect(inertBox?.className).toContain("pointer-events-none");
    expect(inertBox?.className).toContain("opacity-60");
  });

  test("inert blocks focus on descendants — a tabbing admin cannot reach the read-only list", () => {
    // `pointer-events-none` alone doesn't block keyboard focus; `inert`
    // does. If a future refactor drops `inert` and keeps only
    // pointer-events-none, this test is the one that fails — preserving
    // the keyboard-a11y promise made in the wrapper's docstring.
    const { getByTestId } = render(
      <PublishedContextWrapper
        resourceLabel={CONNECTION_LABEL}
        action={{ kind: "button", label: "Create draft", onClick: () => {} }}
      >
        <button data-testid="inside-button" type="button">
          Published row
        </button>
      </PublishedContextWrapper>,
    );
    const inside = getByTestId("inside-button") as HTMLButtonElement;
    inside.focus();
    expect(document.activeElement).not.toBe(inside);
  });

  test("renders the Published badge + copy with the singular resource label", () => {
    const { container, getByText } = render(
      <PublishedContextWrapper
        resourceLabel={CONNECTION_LABEL}
        action={{ kind: "button", label: "Create draft", onClick: () => {} }}
      >
        <div>child</div>
      </PublishedContextWrapper>,
    );
    const badge = container.querySelector('[aria-label="Published — live in production"]');
    expect(badge).toBeTruthy();
    expect(getByText(/You.*re viewing the live connection list/)).toBeTruthy();
  });

  test("uses the plural label in the aria-label (irregular plurals supported)", () => {
    // Entity → entities is the paradigmatic irregular plural that a naive
    // `${label}s` implementation would mangle to "entitys".
    const { getByTestId } = render(
      <PublishedContextWrapper
        resourceLabel={ENTITY_LABEL}
        action={{ kind: "button", label: "Create draft", onClick: () => {} }}
      >
        <div>child</div>
      </PublishedContextWrapper>,
    );
    expect(getByTestId("published-context-wrapper").getAttribute("aria-label")).toBe(
      "Published entities, read-only while in developer mode",
    );
  });

  test("renders kind=link action as a Next.js link", () => {
    const { getByRole } = render(
      <PublishedContextWrapper
        resourceLabel={PROMPT_LABEL}
        action={{ kind: "link", label: "Create draft", href: "/admin/prompts/new" }}
      >
        <div>child</div>
      </PublishedContextWrapper>,
    );
    const link = getByRole("link", { name: /Create draft/ });
    expect(link.getAttribute("href")).toBe("/admin/prompts/new");
  });

  test("renders kind=button action as a button that fires the handler", () => {
    let clicked = false;
    const { getByRole } = render(
      <PublishedContextWrapper
        resourceLabel={CONNECTION_LABEL}
        action={{
          kind: "button",
          label: "Create draft",
          onClick: () => { clicked = true; },
        }}
      >
        <div>child</div>
      </PublishedContextWrapper>,
    );
    const button = getByRole("button", { name: /Create draft/ });
    fireEvent.click(button);
    expect(clicked).toBe(true);
  });
});
