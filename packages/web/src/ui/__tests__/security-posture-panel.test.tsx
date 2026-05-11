/**
 * Smoke tests for the workspace security-posture panel.
 *
 * Renders the panel with mocked `useAdminFetch` data and asserts the
 * traffic-light tile copy lands in the DOM. Five primary states:
 *   - all admins enrolled        → "OK" + "All N admins have MFA"
 *   - partial enrollment         → "Attention" + "X of Y admins enrolled"
 *   - zero enrollment            → "Action required" + "0 of N admins enrolled"
 *   - empty workspace            → "No admins yet"
 *   - passkey-only fallback      → "Attention" + "no fallback codes"
 *
 * Plus the error-fallback branches: 404 (no-DB) suppresses the Retry button;
 * other errors keep it.
 */

import { describe, expect, test, mock, afterEach } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { SecurityBuckets } from "../lib/admin-schemas";

mock.module("next/navigation", () => ({
  usePathname: () => "/admin/account-security",
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

let mockMetrics: SecurityBuckets | null = null;
let mockError: { message: string; status?: number; code?: string } | null = null;
let mockLoading = false;

mock.module("@/ui/hooks/use-admin-fetch", () => ({
  useAdminFetch: () => ({
    data: mockError ? null : mockMetrics,
    loading: mockLoading,
    error: mockError,
    setError: () => {},
    refetch: () => Promise.resolve(),
  }),
  friendlyError: (err: { message?: string }) => err?.message ?? "error",
}));

const { SecurityPosturePanel } = await import(
  "../components/admin/security/security-posture-panel"
);

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client }, children);
}

function metrics(over: Partial<SecurityBuckets> = {}): SecurityBuckets {
  return {
    adminCount: 0,
    mfaEnrolled: 0,
    twoFactorOnly: 0,
    passkeyOnly: 0,
    bothFactors: 0,
    noFactors: 0,
    activeTrustDevices: 0,
    activeTrustDeviceUsers: 0,
    ...over,
  };
}

afterEach(() => {
  cleanup();
  mockMetrics = null;
  mockError = null;
  mockLoading = false;
});

describe("SecurityPosturePanel", () => {
  test("renders OK state when all admins have MFA", () => {
    mockMetrics = metrics({
      adminCount: 3,
      mfaEnrolled: 3,
      bothFactors: 2,
      passkeyOnly: 1,
    });
    render(<SecurityPosturePanel />, { wrapper });
    expect(document.body.textContent).toContain("All 3 admins have MFA");
    expect(document.body.textContent).toContain("OK");
  });

  test("renders attention state when enrollment is partial", () => {
    mockMetrics = metrics({
      adminCount: 4,
      mfaEnrolled: 2,
      twoFactorOnly: 1,
      bothFactors: 1,
      noFactors: 2,
    });
    render(<SecurityPosturePanel />, { wrapper });
    expect(document.body.textContent).toContain("2 of 4 admins enrolled");
    expect(document.body.textContent).toContain("Attention");
  });

  test("renders red state when zero admins enrolled", () => {
    mockMetrics = metrics({ adminCount: 2, noFactors: 2 });
    render(<SecurityPosturePanel />, { wrapper });
    expect(document.body.textContent).toContain("0 of 2 admins enrolled");
    expect(document.body.textContent).toContain("Action required");
  });

  test("renders muted copy when there are no admins", () => {
    mockMetrics = metrics();
    render(<SecurityPosturePanel />, { wrapper });
    expect(document.body.textContent).toContain("No admins yet");
  });

  test("surfaces trust-device counts", () => {
    mockMetrics = metrics({
      adminCount: 2,
      mfaEnrolled: 2,
      bothFactors: 2,
      activeTrustDevices: 3,
      activeTrustDeviceUsers: 2,
    });
    render(<SecurityPosturePanel />, { wrapper });
    expect(document.body.textContent).toContain("3 active trust grant");
  });

  test("renders muted trust-device tile when no grants are active", () => {
    mockMetrics = metrics({ adminCount: 2, mfaEnrolled: 2, bothFactors: 2 });
    render(<SecurityPosturePanel />, { wrapper });
    expect(document.body.textContent).toContain("No active trust grants");
  });

  test("renders amber backup-codes tile for passkey-only enrollment", () => {
    mockMetrics = metrics({
      adminCount: 1,
      mfaEnrolled: 1,
      passkeyOnly: 1,
    });
    render(<SecurityPosturePanel />, { wrapper });
    expect(document.body.textContent).toContain("Passkey-only admins have no fallback codes");
  });

  test("backup-codes tile copy reflects 'TOTP enrolled' rather than overclaiming code possession", () => {
    mockMetrics = metrics({
      adminCount: 2,
      mfaEnrolled: 2,
      bothFactors: 1,
      twoFactorOnly: 1,
    });
    render(<SecurityPosturePanel />, { wrapper });
    // The tile must not claim to know how many admins HAVE codes — codes
    // can be consumed; the API only knows TOTP-enrollment status.
    expect(document.body.textContent).toContain("admins with TOTP enrolled");
  });

  test("renders error fallback when fetch fails", () => {
    mockError = { message: "Server error (ref: abc)", status: 500 };
    render(<SecurityPosturePanel />, { wrapper });
    expect(document.body.textContent).toContain("Security posture unavailable");
    expect(document.body.textContent).toContain("Server error");
    // Generic 500 — Retry should still be available.
    expect(document.body.textContent).toContain("Retry");
  });

  test("suppresses Retry button when error is 404 not_available (S5)", () => {
    // Internal DB not configured — pressing Retry will hit the same wall.
    mockError = {
      message: "Security metrics require an internal database.",
      status: 404,
      code: "not_available",
    };
    render(<SecurityPosturePanel />, { wrapper });
    expect(document.body.textContent).toContain("Security posture unavailable");
    expect(document.body.textContent).not.toContain("Retry");
  });

  test("renders loading skeleton while fetching", () => {
    mockLoading = true;
    const { container } = render(<SecurityPosturePanel />, { wrapper });
    // Skeleton component renders an animate-pulse element; assert that we
    // rendered at least the four skeleton blocks expected (header + three tiles).
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThanOrEqual(3);
  });
});
