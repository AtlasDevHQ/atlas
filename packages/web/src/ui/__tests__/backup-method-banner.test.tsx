/**
 * Smoke tests for the lockout-risk backup-method banner.
 *
 * Pins the predicate (`passkeyCount === 1 && !hasPassword && !hasTotp`),
 * the per-session dismissal contract, and the dismissal-clears-once-the-
 * predicate-clears recovery transition. Mirrors the mocking pattern from
 * `security-posture-panel.test.tsx` (mocked `useAdminFetch`, query client
 * wrapper, `cleanup()` between tests).
 */

import { describe, expect, test, mock, afterEach, beforeEach } from "bun:test";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

interface MfaFactors {
  hasPassword: boolean;
  hasTotp: boolean;
  passkeyCount: number;
}

let mockData: MfaFactors | null = null;
let mockLoading = false;
let mockError: { message: string; status?: number } | null = null;

mock.module("next/navigation", () => ({
  usePathname: () => "/admin/settings/security",
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

mock.module("@/ui/hooks/use-admin-fetch", () => ({
  useAdminFetch: () => ({
    data: mockError ? null : mockData,
    loading: mockLoading,
    error: mockError,
    setError: () => {},
    refetch: () => Promise.resolve(),
  }),
  friendlyError: (err: { message?: string }) => err?.message ?? "error",
}));

const { BackupMethodBanner } = await import(
  "../components/admin/security/backup-method-banner"
);

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client }, children);
}

const STORAGE_KEY = "atlas:backup-method-banner:dismissed";

beforeEach(() => {
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  mockData = null;
  mockLoading = false;
  mockError = null;
  window.sessionStorage.clear();
});

describe("BackupMethodBanner — predicate", () => {
  test("renders when passkeyCount === 1 AND no password AND no TOTP", () => {
    mockData = { passkeyCount: 1, hasPassword: false, hasTotp: false };
    render(<BackupMethodBanner onAddPasskey={() => {}} />, { wrapper });
    expect(document.body.textContent).toContain("Add a backup method");
  });

  test("stays silent when passkeyCount === 0 (no factors yet — different surface)", () => {
    mockData = { passkeyCount: 0, hasPassword: false, hasTotp: false };
    render(<BackupMethodBanner onAddPasskey={() => {}} />, { wrapper });
    expect(document.body.textContent).not.toContain("Add a backup method");
  });

  test("stays silent when passkeyCount >= 2 (the count === 1 not >= 1 guard)", () => {
    mockData = { passkeyCount: 2, hasPassword: false, hasTotp: false };
    render(<BackupMethodBanner onAddPasskey={() => {}} />, { wrapper });
    expect(document.body.textContent).not.toContain("Add a backup method");
  });

  test("stays silent when a password is set", () => {
    mockData = { passkeyCount: 1, hasPassword: true, hasTotp: false };
    render(<BackupMethodBanner onAddPasskey={() => {}} />, { wrapper });
    expect(document.body.textContent).not.toContain("Add a backup method");
  });

  test("stays silent when TOTP is enrolled", () => {
    mockData = { passkeyCount: 1, hasPassword: false, hasTotp: true };
    render(<BackupMethodBanner onAddPasskey={() => {}} />, { wrapper });
    expect(document.body.textContent).not.toContain("Add a backup method");
  });

  test("stays silent during the loading flash (avoids a banner that disappears as the snapshot resolves)", () => {
    mockLoading = true;
    render(<BackupMethodBanner onAddPasskey={() => {}} />, { wrapper });
    expect(document.body.textContent).not.toContain("Add a backup method");
  });

  test("stays silent on fetch error", () => {
    mockError = { message: "boom", status: 500 };
    render(<BackupMethodBanner onAddPasskey={() => {}} />, { wrapper });
    expect(document.body.textContent).not.toContain("Add a backup method");
  });
});

describe("BackupMethodBanner — secondary CTA", () => {
  test("'Add a password' is suppressed when no handler is supplied", () => {
    mockData = { passkeyCount: 1, hasPassword: false, hasTotp: false };
    render(<BackupMethodBanner onAddPasskey={() => {}} />, { wrapper });
    expect(document.body.textContent).not.toContain("Add a password");
  });

  test("'Add a password' renders when the parent supplies a handler", () => {
    mockData = { passkeyCount: 1, hasPassword: false, hasTotp: false };
    render(
      <BackupMethodBanner onAddPasskey={() => {}} onAddPassword={() => {}} />,
      { wrapper },
    );
    expect(document.body.textContent).toContain("Add a password");
  });

  test("'Enroll a second passkey' fires the primary callback", () => {
    let calls = 0;
    mockData = { passkeyCount: 1, hasPassword: false, hasTotp: false };
    const { getByRole } = render(
      <BackupMethodBanner onAddPasskey={() => calls++} />,
      { wrapper },
    );
    fireEvent.click(getByRole("button", { name: /Enroll a second passkey/ }));
    expect(calls).toBe(1);
  });
});

describe("BackupMethodBanner — dismissal", () => {
  test("dismiss persists for the session via sessionStorage", () => {
    mockData = { passkeyCount: 1, hasPassword: false, hasTotp: false };
    const { getByLabelText, queryByText, rerender } = render(
      <BackupMethodBanner onAddPasskey={() => {}} />,
      { wrapper },
    );
    expect(queryByText("Add a backup method")).not.toBeNull();
    fireEvent.click(getByLabelText("Dismiss for this session"));
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe("1");
    // Subsequent renders honor the dismissed flag.
    rerender(<BackupMethodBanner onAddPasskey={() => {}} />);
    expect(queryByText("Add a backup method")).toBeNull();
  });

  test("dismissal honored on remount when the predicate is still at-risk", () => {
    window.sessionStorage.setItem(STORAGE_KEY, "1");
    mockData = { passkeyCount: 1, hasPassword: false, hasTotp: false };
    render(<BackupMethodBanner onAddPasskey={() => {}} />, { wrapper });
    expect(document.body.textContent).not.toContain("Add a backup method");
  });

  test("dismissal clears once the predicate clears (next at-risk session sees the banner cleanly)", () => {
    window.sessionStorage.setItem(STORAGE_KEY, "1");
    // Recovered profile — second passkey enrolled.
    mockData = { passkeyCount: 2, hasPassword: false, hasTotp: false };
    render(<BackupMethodBanner onAddPasskey={() => {}} />, { wrapper });
    // The useEffect cleanup runs synchronously after render via React 19 effects.
    // sessionStorage should be empty so a future at-risk transition surfaces the banner.
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
