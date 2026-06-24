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

const routerPushMock = mock((_path: string) => {});
const routerMock = { push: routerPushMock, replace: () => {}, back: () => {} };
mock.module("next/navigation", () => ({
  useRouter: () => routerMock,
}));

const getSessionMock = mock(async () => ({ data: null }));
mock.module("@/lib/auth/client", () => ({
  authClient: { getSession: getSessionMock },
}));

mock.module("@/ui/hooks/use-trial-status", () => ({
  // Off-trial / self-hosted → TrialNotice renders nothing. Keeps the test
  // focused on the prompt section.
  useTrialStatus: () => ({ trial: null, loading: false }),
}));

const PROMPTS = [
  "What is our total GMV?",
  "Who are our top customers by spend?",
] as const;
mock.module("@/ui/hooks/use-success-starter-prompts", () => ({
  useSuccessStarterPrompts: () => ({
    prompts: PROMPTS,
    loading: false,
    isFallback: false,
    isError: false,
    error: null,
  }),
}));

mock.module("@/ui/components/signup/signup-shell", () => ({
  SignupShell: ({ children }: { children: unknown }) => <div>{children as never}</div>,
}));

import SuccessPage from "./page";

beforeEach(() => {
  routerPushMock.mockReset();
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

  test("clicking a prompt navigates to the chat with the ?prompt= payload", async () => {
    render(<SuccessPage />);

    const target = PROMPTS[0];
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(target, "i") }));
    });

    // openAtlas hydrates the session first, then pushes the encoded prompt.
    await waitFor(() => {
      expect(routerPushMock).toHaveBeenCalledWith(
        `/?prompt=${encodeURIComponent(target)}`,
      );
    });
    expect(getSessionMock).toHaveBeenCalled();
  });
});
