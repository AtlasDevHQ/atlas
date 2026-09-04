/**
 * `ui/components/user-menu` — the avatar menu and its deriveInitials helper.
 *
 * Merged 2026-09-04; formerly also user-menu-initials.test.ts.
 */

import { describe, expect, test, mock, beforeEach } from "bun:test";
import React from "react";

void mock.module("sonner", () => ({
  toast: { error: () => {} },
}));

void mock.module("@/ui/hooks/use-dark-mode", () => ({
  setTheme: () => {},
  useThemeMode: () => "system",
}));

let sessionData: { user?: { name?: string; email?: string; role?: string } } | null = null;
void mock.module("@/ui/context", () => ({
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
import { UserMenu, deriveInitials } from "../components/user-menu";

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

describe("deriveInitials", () => {
  test("uses first letter of two name parts", () => {
    expect(deriveInitials("Ada Lovelace", null)).toBe("AL");
  });

  test("falls back to email when name is missing", () => {
    expect(deriveInitials(null, "ada.lovelace@example.com")).toBe("AL");
  });

  test("returns single letter for one-word name", () => {
    expect(deriveInitials("Ada", null)).toBe("A");
  });

  test("falls back to '?' when both inputs are blank", () => {
    expect(deriveInitials(null, null)).toBe("?");
    expect(deriveInitials("", "")).toBe("?");
    expect(deriveInitials("   ", "   ")).toBe("?");
  });

  test("name takes precedence over email", () => {
    expect(deriveInitials("Bob Builder", "ada@example.com")).toBe("BB");
  });

  test("handles email-only input with single local part", () => {
    expect(deriveInitials(null, "ada@example.com")).toBe("AE");
  });
});
