import { describe, expect, test, afterEach } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import { DeveloperChatEmptyState } from "../components/chat/developer-empty-state";

describe("DeveloperChatEmptyState", () => {
  afterEach(() => {
    cleanup();
  });

  test("renders the dev-mode message and admin connections CTA", () => {
    const { getByText, getByRole, getByTestId } = render(
      <DeveloperChatEmptyState />,
    );
    expect(getByTestId("developer-chat-empty-state")).toBeTruthy();
    expect(
      getByText("No connection configured in developer mode."),
    ).toBeTruthy();
    expect(
      getByText("Connect a database in the admin panel to start testing."),
    ).toBeTruthy();

    const link = getByRole("link", { name: /Go to connections/ });
    expect(link.getAttribute("href")).toBe("/admin/connections");
  });

  test("uses amber accent so admins recognize it as a dev-mode prompt", () => {
    const { getByTestId } = render(<DeveloperChatEmptyState />);
    // Restyles within the amber family are fine — we only care that the
    // developer-mode visual signal is present.
    expect(getByTestId("developer-chat-empty-state").innerHTML).toContain("amber");
  });
});
