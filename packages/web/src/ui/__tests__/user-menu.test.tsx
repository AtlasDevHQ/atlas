import { describe, expect, test, mock, beforeEach } from "bun:test";
import React from "react";

mock.module("sonner", () => ({
  toast: { error: () => {} },
}));

mock.module("@/ui/hooks/use-dark-mode", () => ({
  setTheme: () => {},
  useThemeMode: () => "system",
}));

let sessionData: { user?: { name?: string; email?: string; role?: string } } | null = null;
mock.module("@/ui/context", () => ({
  useAtlasConfig: () => ({
    apiUrl: "http://localhost:3001",
    isCrossOrigin: false,
    authClient: {
      signOut: () => Promise.resolve(),
      useSession: () => ({ data: sessionData, isPending: false }),
    },
  }),
}));

import { render, cleanup } from "@testing-library/react";
import { UserMenu } from "../components/user-menu";

beforeEach(() => {
  cleanup();
});

describe("UserMenu", () => {
  test("renders nothing when there is no signed-in user", () => {
    sessionData = null;
    const { container } = render(<UserMenu />);
    // No user → no avatar trigger
    expect(container.querySelector('button[aria-label="Account menu"]')).toBeNull();
  });

  test("renders the avatar trigger with derived initials when a user is present", () => {
    sessionData = { user: { name: "Ada Lovelace", email: "ada@example.com" } };
    const { container } = render(<UserMenu />);
    const trigger = container.querySelector('button[aria-label="Account menu"]');
    expect(trigger).not.toBeNull();
    expect(trigger?.textContent).toBe("AL");
  });

  test("falls back to email-derived initials when name is missing", () => {
    sessionData = { user: { email: "ada.lovelace@example.com" } };
    const { container } = render(<UserMenu />);
    const trigger = container.querySelector('button[aria-label="Account menu"]');
    expect(trigger?.textContent).toBe("AL");
  });
});
