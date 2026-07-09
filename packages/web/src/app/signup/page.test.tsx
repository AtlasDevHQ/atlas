/**
 * Coverage for the signup email step (ADR-0024 §4, #3972).
 *
 * The first signup step collects an email (NOT an identity write), stashes it
 * in the signup draft, and routes forward: invitees skip the region picker and
 * go straight to /signup/account; everyone else goes to /signup/region. These
 * tests pin that routing fork plus the draft persistence and pre-fill.
 *
 * `mock.module(...)` stubs every named export of the modules it touches (repo
 * rule). The signup shell is a passthrough so the test exercises the page's
 * own logic, not the residency-probe dep tree.
 */

import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, cleanup, screen } from "@testing-library/react";

// ── Mocks ───────────────────────────────────────────────────────────────

const routerPushMock = mock((_path: string) => {});
const routerReplaceMock = mock((_path: string) => {});
const routerMock = { push: routerPushMock, replace: routerReplaceMock, back: () => {} };
let searchString = "";
void mock.module("next/navigation", () => ({
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(searchString),
}));

const savePlanIntentMock = mock((_plan: string | null) => {});
// Mock EVERY value export (repo rule: partial mocks SyntaxError other files).
void mock.module("@/lib/billing/plan-intent", () => ({
  savePlanIntent: savePlanIntentMock,
  PAID_TIERS: ["starter", "pro", "business"] as const,
  isPlanIntent: () => false,
  consumePlanIntent: () => null,
}));

const saveDraftMock = mock((_draft: { email: string; invitationId?: string }) => {});
const readDraftMock = mock((): { email: string; invitationId?: string } | null => null);
void mock.module("@/lib/signup-draft", () => ({
  saveSignupDraft: saveDraftMock,
  readSignupDraft: readDraftMock,
  clearSignupDraft: () => {},
}));

void mock.module("@/ui/components/signup/signup-shell", () => ({
  SignupShell: ({ children }: { children: unknown }) => <div>{children as never}</div>,
}));

import SignupPage from "./page";

function typeEmail(value: string) {
  const input = screen.getByLabelText(/work email/i) as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
}

beforeEach(() => {
  routerPushMock.mockReset();
  routerReplaceMock.mockReset();
  savePlanIntentMock.mockReset();
  saveDraftMock.mockReset();
  readDraftMock.mockReset();
  readDraftMock.mockImplementation(() => null);
  searchString = "";
});

afterEach(() => {
  cleanup();
});

describe("SignupPage — email step routing (#3972)", () => {
  test("a non-invite Continue saves the draft and routes to the region step", () => {
    render(<SignupPage />);
    typeEmail("jane@example.com");
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    expect(saveDraftMock).toHaveBeenCalledWith({ email: "jane@example.com", invitationId: undefined });
    expect(routerPushMock).toHaveBeenCalledWith("/signup/region");
  });

  test("an invitee skips the region picker and goes to the account step", () => {
    searchString = "invitationId=inv-123";
    render(<SignupPage />);
    typeEmail("teammate@acme.com");
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    expect(saveDraftMock).toHaveBeenCalledWith({ email: "teammate@acme.com", invitationId: "inv-123" });
    expect(routerPushMock).toHaveBeenCalledWith("/signup/account");
  });

  test("an empty email shows an error and does not navigate", () => {
    render(<SignupPage />);
    // The button is disabled while empty; submit the form directly to prove the
    // handler guards too (defense in depth).
    const form = screen.getByLabelText(/work email/i).closest("form")!;
    fireEvent.submit(form);

    expect(screen.getByRole("alert")).toBeDefined();
    expect(saveDraftMock).not.toHaveBeenCalled();
    expect(routerPushMock).not.toHaveBeenCalled();
  });

  test("pre-fills the email from an existing draft (Back keeps what was typed)", () => {
    readDraftMock.mockImplementation(() => ({ email: "returning@example.com" }));
    render(<SignupPage />);
    const input = screen.getByLabelText(/work email/i) as HTMLInputElement;
    expect(input.value).toBe("returning@example.com");
  });
});
