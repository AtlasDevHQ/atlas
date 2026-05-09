/**
 * Regression guard for `WorkspaceIdentityCard` (#2233).
 *
 * Operators previously had to query Postgres or dig through `Set-Cookie` to
 * read their workspace ID. The card is the in-UI surface that closes that
 * gap; losing the readonly input, the copy button, or the caption would
 * reintroduce the original navigation hole.
 */

import { describe, expect, mock, test } from "bun:test";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import { createElement } from "react";
import { WorkspaceIdentityCard } from "../page";

function renderCard(props: { orgId: string | null; orgName: string | null }) {
  return render(createElement(WorkspaceIdentityCard, props));
}

describe("WorkspaceIdentityCard", () => {
  test("renders nothing when no orgId is available", () => {
    const { container } = renderCard({ orgId: null, orgName: null });
    expect(container.textContent).toBe("");
    cleanup();
  });

  test("renders the readonly ID + caption + copy affordance when orgId is present", () => {
    const { container, getByLabelText } = renderCard({
      orgId: "org_abc123",
      orgName: "Atlas Labs",
    });
    const input = container.querySelector<HTMLInputElement>("#workspace-id");
    expect(input).toBeTruthy();
    expect(input?.value).toBe("org_abc123");
    expect(input?.readOnly).toBe(true);

    expect(container.textContent).toContain("Atlas Labs");
    expect(container.textContent).toContain(
      "Use this when configuring the CLI, SDK, or load-test allowlists.",
    );

    expect(getByLabelText("Copy workspace ID")).toBeTruthy();
    cleanup();
  });

  test("omits the Name row when orgName is null", () => {
    const { container } = renderCard({ orgId: "org_xyz", orgName: null });
    expect(container.textContent).not.toContain("Name");
    expect(container.textContent).toContain("Workspace ID");
    cleanup();
  });

  test("copies the orgId to the clipboard and flips the icon to the copied state", async () => {
    const writeText = mock(async () => undefined);
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const { getByLabelText } = renderCard({
      orgId: "org_copy_me",
      orgName: null,
    });

    await act(async () => {
      fireEvent.click(getByLabelText("Copy workspace ID"));
    });

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]?.[0]).toBe("org_copy_me");

    // After the click resolves, the button's accessible label flips so the
    // user knows the copy succeeded — losing this would be a silent regression.
    expect(getByLabelText("Copied workspace ID")).toBeTruthy();

    cleanup();
  });
});
