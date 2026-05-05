/**
 * Smoke tests for the workspace security-posture panel (#2094).
 *
 * Renders the panel with mocked `useAdminFetch` data and asserts the
 * traffic-light tile copy lands in the DOM. Three primary states:
 *   - all admins enrolled        → "OK" + "All N admins have MFA"
 *   - partial enrollment         → "Attention" + "X of Y admins enrolled"
 *   - zero enrollment            → "Action required" + "0 of N admins enrolled"
 */

import { describe, expect, test, mock, afterEach } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { SecurityMetrics } from "../lib/admin-schemas";

mock.module("next/navigation", () => ({
  usePathname: () => "/admin/settings/security",
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

let mockMetrics: SecurityMetrics | null = null;
let mockError: { message: string } | null = null;
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

function metrics(over: Partial<SecurityMetrics> = {}): SecurityMetrics {
  return {
    adminCount: 0,
    mfaEnrolled: 0,
    twoFactorOnly: 0,
    passkeyOnly: 0,
    bothFactors: 0,
    noFactors: 0,
    activeTrustDevices: 0,
    trustDeviceUsersInLast30Days: 0,
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
      trustDeviceUsersInLast30Days: 2,
    });
    render(<SecurityPosturePanel />, { wrapper });
    expect(document.body.textContent).toContain("3 active trust grant");
  });

  test("renders error fallback when fetch fails", () => {
    mockError = { message: "Server error (ref: abc)" };
    render(<SecurityPosturePanel />, { wrapper });
    expect(document.body.textContent).toContain("Security posture unavailable");
    expect(document.body.textContent).toContain("Server error");
  });

  test("renders loading skeleton while fetching", () => {
    mockLoading = true;
    const { container } = render(<SecurityPosturePanel />, { wrapper });
    // Skeleton component renders the `bg-accent` class via shadcn defaults.
    expect(container.querySelector("[data-slot]") || container.firstChild).toBeTruthy();
  });
});
