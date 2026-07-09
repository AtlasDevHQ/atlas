/**
 * Coverage for the signup success step (#3935 §F4).
 *
 * The change under test swaps the page's hardcoded `STARTER_PROMPTS` constant
 * for the adaptive `useSuccessStarterPrompts` hook (semantic-layer-derived
 * prompts with a shared static fallback). There is no e2e coverage for this
 * page, so this unit test pins the page-owned glue the hook test can't see:
 * the prompts render as clickable rows, and a click navigates to the chat with
 * the `?prompt=<text>` payload that is the whole point of the section.
 *
 * `mock.module(...)` stubs every named export of the modules it touches (per
 * repo rule). The signup shell + trial-status are passthrough/no-op stubs so
 * the test exercises the prompt section, not their dep trees.
 */

import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, waitFor, cleanup, act, screen } from "@testing-library/react";

// ── Mocks ───────────────────────────────────────────────────────────────

// #4018 — "Open Atlas" hands off with a HARD nav (navigatePostAuth), mirroring
// the login front-door, so the app re-bootstraps from the durable cookie.
const navigatePostAuthMock = mock((_path: string) => {});
void mock.module("@/lib/auth/post-auth-nav", () => ({
  navigatePostAuth: navigatePostAuthMock,
}));

const getSessionMock = mock(async () => ({ data: null }));
void mock.module("@/lib/auth/client", () => ({
  authClient: { getSession: getSessionMock },
}));

void mock.module("@/ui/hooks/use-trial-status", () => ({
  // Off-trial / self-hosted → TrialNotice renders nothing. Keeps the test
  // focused on the prompt section.
  useTrialStatus: () => ({ trial: null, loading: false }),
}));

const PROMPTS = [
  "What is our total GMV?",
  "Who are our top customers by spend?",
] as const;
void mock.module("@/ui/hooks/use-success-starter-prompts", () => ({
  useSuccessStarterPrompts: () => ({
    prompts: PROMPTS,
    loading: false,
    isFallback: false,
    isError: false,
    error: null,
  }),
}));

void mock.module("@/ui/components/signup/signup-shell", () => ({
  SignupShell: ({ children }: { children: unknown }) => <div>{children as never}</div>,
}));

import SuccessPage from "./page";

beforeEach(() => {
  navigatePostAuthMock.mockReset();
  getSessionMock.mockReset();
  getSessionMock.mockImplementation(async () => ({ data: null }));
});

afterEach(() => {
  cleanup();
});

// ── Tests ───────────────────────────────────────────────────────────────

describe("SuccessPage — starter prompts (#3935)", () => {
  test("renders the hook's prompts as clickable rows", () => {
    render(<SuccessPage />);

    for (const prompt of PROMPTS) {
      expect(screen.getByRole("button", { name: new RegExp(prompt, "i") })).toBeDefined();
    }
  });

  test("clicking a prompt hands off to the chat with the ?prompt= payload (hard nav)", async () => {
    render(<SuccessPage />);

    const target = PROMPTS[0];
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(target, "i") }));
    });

    // openAtlas hydrates the session first, then hard-navs (#4018) the encoded prompt.
    await waitFor(() => {
      expect(navigatePostAuthMock).toHaveBeenCalledWith(
        `/?prompt=${encodeURIComponent(target)}`,
      );
    });
    expect(getSessionMock).toHaveBeenCalled();
  });

  test("a getSession hiccup never strands the user — still hands off (#4018)", async () => {
    // Best-effort hydration: if getSession throws, openAtlas must still navigate
    // (the durable cookie re-bootstraps the app on the fresh load). A regression
    // that moved the nav inside the try would dead-end the just-signed-up user.
    getSessionMock.mockImplementation(async () => {
      throw new Error("network");
    });
    render(<SuccessPage />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Open Atlas/i }));
    });

    await waitFor(() => {
      expect(navigatePostAuthMock).toHaveBeenCalledWith("/");
    });
  });
});
