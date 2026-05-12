import { describe, expect, test, mock, beforeEach } from "bun:test";

// Wire the minimum surface area each child component needs. ChatTopBar
// renders OrgSwitcher + UserMenu — both depend on AtlasConfig. We don't
// care what they render here; we just need the gear / no-gear branch.
mock.module("@/ui/components/org-switcher", () => ({
  OrgSwitcher: () => null,
}));
mock.module("@/ui/components/user-menu", () => ({
  UserMenu: () => null,
}));
mock.module("@/ui/components/tour/guided-tour", () => ({
  useTourContext: () => null,
}));

import { render, cleanup } from "@testing-library/react";
import { ChatTopBar } from "../components/chat/chat-top-bar";

beforeEach(() => {
  cleanup();
});

describe("ChatTopBar", () => {
  test("shows the admin gear when the caller is an admin", () => {
    const { container } = render(<ChatTopBar isAdmin />);
    const gear = container.querySelector('a[aria-label="Open admin console"]');
    expect(gear).not.toBeNull();
    expect(gear?.getAttribute("href")).toBe("/admin");
  });

  test("hides the admin gear for non-admins (no cross-link to /admin)", () => {
    const { container } = render(<ChatTopBar isAdmin={false} />);
    expect(container.querySelector('a[aria-label="Open admin console"]')).toBeNull();
  });
});
