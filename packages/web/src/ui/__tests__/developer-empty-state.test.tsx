import { describe, expect, test, afterEach } from "bun:test";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { Database } from "lucide-react";
import { DeveloperEmptyState } from "../components/admin/developer-empty-state";

describe("DeveloperEmptyState", () => {
  afterEach(() => {
    cleanup();
  });

  test("renders title and description", () => {
    const { getByText } = render(
      <DeveloperEmptyState
        icon={Database}
        title="Connect your first database to start building."
        description="Add a connection to get going."
      />,
    );
    expect(getByText("Connect your first database to start building.")).toBeTruthy();
    expect(getByText("Add a connection to get going.")).toBeTruthy();
  });

  test("uses developer-mode amber styling so admins recognize it as a dev prompt", () => {
    const { getByTestId } = render(
      <DeveloperEmptyState icon={Database} title="Test title" />,
    );
    const wrapper = getByTestId("developer-empty-state");
    // The amber accent is the signal that this is a dev-mode empty state;
    // assert a broad "amber" match so restyles within the amber family
    // don't break the test.
    expect(wrapper.innerHTML).toContain("amber");
  });

  test("renders href-style CTA as a link", () => {
    const { getByRole } = render(
      <DeveloperEmptyState
        icon={Database}
        title="Connect your first database"
        action={{ label: "Go to connections", href: "/admin/connections" }}
      />,
    );
    const link = getByRole("link", { name: "Go to connections" });
    expect(link.getAttribute("href")).toBe("/admin/connections");
  });

  test("renders onClick-style CTA as a button that fires the handler", () => {
    let clicked = false;
    const { getByRole } = render(
      <DeveloperEmptyState
        icon={Database}
        title="Connect your first database"
        action={{ label: "Add connection", onClick: () => { clicked = true; } }}
      />,
    );
    const button = getByRole("button", { name: "Add connection" });
    fireEvent.click(button);
    expect(clicked).toBe(true);
  });

  test("omits the CTA when no action is provided", () => {
    const { queryByRole } = render(
      <DeveloperEmptyState icon={Database} title="Nothing to diff" />,
    );
    expect(queryByRole("button")).toBeNull();
    expect(queryByRole("link")).toBeNull();
  });
});
