import { describe, expect, test, afterEach } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import {
  DeveloperChatEmptyState,
  shouldShowDevChatEmpty,
  type ShouldShowDevChatEmptyArgs,
} from "../components/chat/developer-empty-state";

describe("DeveloperChatEmptyState", () => {
  afterEach(() => {
    cleanup();
  });

  test("renders the no-connections message and admin connections CTA", () => {
    const { getByText, getByRole, getByTestId } = render(
      <DeveloperChatEmptyState />,
    );
    expect(getByTestId("developer-chat-empty-state")).toBeTruthy();
    expect(getByText("No connections configured.")).toBeTruthy();
    expect(
      getByText("Connect a database in the admin panel to start querying."),
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

describe("shouldShowDevChatEmpty", () => {
  // A loaded env-groups query with one published SQL connection (the staging
  // repro: 5 published connections, 0 drafts). The old draft-count gate fired
  // here; the new gate must NOT. Group members are irrelevant to the gate (only
  // list length matters), so a bare `{}` stands in for a connection group.
  const loadedWithConnection: ShouldShowDevChatEmptyArgs = {
    mode: "developer",
    hasLoaded: true,
    error: null,
    reason: null,
    groups: [{}],
    restDatasources: [],
  };

  const loadedEmpty: ShouldShowDevChatEmptyArgs = {
    ...loadedWithConnection,
    groups: [],
    restDatasources: [],
  };

  test("does NOT show the empty state when a published connection is visible (the #3883 bug)", () => {
    expect(shouldShowDevChatEmpty(loadedWithConnection)).toBe(false);
  });

  test("does NOT show the empty state when only a REST datasource is visible", () => {
    expect(
      shouldShowDevChatEmpty({ ...loadedEmpty, restDatasources: [{}] }),
    ).toBe(false);
  });

  test("shows the empty state in developer mode with zero connections", () => {
    expect(shouldShowDevChatEmpty(loadedEmpty)).toBe(true);
  });

  test("never shows outside developer mode, even with zero connections", () => {
    expect(shouldShowDevChatEmpty({ ...loadedEmpty, mode: "published" })).toBe(
      false,
    );
  });

  test("waits for the env-groups fetch to settle (no flash before load)", () => {
    expect(shouldShowDevChatEmpty({ ...loadedEmpty, hasLoaded: false })).toBe(
      false,
    );
  });

  test("does not hard-block chat on a transport error", () => {
    expect(shouldShowDevChatEmpty({ ...loadedEmpty, error: "HTTP 503" })).toBe(
      false,
    );
  });

  test("does not hard-block on a degraded reason (legacy no-internal-DB deploy is still queryable)", () => {
    expect(
      shouldShowDevChatEmpty({ ...loadedEmpty, reason: "no_internal_db" }),
    ).toBe(false);
  });

  test("does not hard-block during an org-switch race (no_active_org)", () => {
    expect(
      shouldShowDevChatEmpty({ ...loadedEmpty, reason: "no_active_org" }),
    ).toBe(false);
  });
});
