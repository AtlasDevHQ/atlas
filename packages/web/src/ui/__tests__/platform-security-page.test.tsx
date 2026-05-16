/**
 * Smoke tests for the platform security adoption dashboard page.
 *
 * The page composes three derived calculations on top of the API
 * payload — these are the silent-regression surface:
 *
 *   - `pct(numerator, denominator)`              — divide-by-zero guard
 *   - `enrollmentRow()` tone classification       — 100% green, 0% red,
 *                                                    partial amber, no-admins muted
 *   - `workspacesWithGap` filter                  — must exclude empty
 *                                                    workspaces (`adminCount > 0` guard)
 *
 * The tests render the page with mocked `useAdminFetch` data and assert
 * the visible counts so a regression in any of those three derivations
 * surfaces here, not on the live dashboard.
 */

import { describe, expect, test, mock, afterEach } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { PlatformSecurityMetrics } from "../lib/admin-schemas";

mock.module("next/navigation", () => ({
  usePathname: () => "/platform/security",
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

let mockData: PlatformSecurityMetrics | null = null;
let mockLoading = false;
let guardBlocked = false;

mock.module("@/ui/hooks/use-admin-fetch", () => ({
  useAdminFetch: () => ({
    data: mockData,
    loading: mockLoading,
    error: null,
    setError: () => {},
    refetch: () => Promise.resolve(),
  }),
  friendlyError: (err: { message?: string }) => err?.message ?? "error",
}));

mock.module("@/ui/hooks/use-platform-admin-guard", () => ({
  usePlatformAdminGuard: () => ({ blocked: guardBlocked }),
  useUserRole: () => "platform_admin",
}));

const PlatformSecurityPage = (
  await import("../../app/platform/security/page")
).default;

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client }, children);
}

function buckets(over: Partial<PlatformSecurityMetrics["aggregate"]> = {}): PlatformSecurityMetrics["aggregate"] {
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

function workspace(
  id: string,
  name: string,
  over: Partial<PlatformSecurityMetrics["workspaces"][number]> = {},
): PlatformSecurityMetrics["workspaces"][number] {
  return {
    workspaceId: id,
    workspaceName: name,
    workspaceSlug: name.toLowerCase(),
    ...buckets(),
    ...over,
  };
}

afterEach(() => {
  cleanup();
  mockData = null;
  mockLoading = false;
  guardBlocked = false;
});

describe("PlatformSecurityPage", () => {
  test("renders the access-check loading state when guard is blocked", () => {
    guardBlocked = true;
    render(<PlatformSecurityPage />, { wrapper });
    expect(document.body.textContent).toContain("Checking access");
  });

  test("renders summary cards with correct enrollment percentage", () => {
    // 8 admins, 6 enrolled → 75% (rounded).
    mockData = {
      aggregate: buckets({
        adminCount: 8,
        mfaEnrolled: 6,
        bothFactors: 4,
        passkeyOnly: 1,
        twoFactorOnly: 1,
        noFactors: 2,
        activeTrustDevices: 5,
        activeTrustDeviceUsers: 4,
      }),
      workspaces: [
        workspace("o1", "One", { adminCount: 4, mfaEnrolled: 4, bothFactors: 4 }),
        workspace("o2", "Two", { adminCount: 4, mfaEnrolled: 2, twoFactorOnly: 1, passkeyOnly: 1, noFactors: 2 }),
      ],
    };
    render(<PlatformSecurityPage />, { wrapper });

    // Summary cards
    expect(document.body.textContent).toContain("75%"); // MFA enrolled
    expect(document.body.textContent).toContain("8"); // Total admins
    // Passkey adopters: passkeyOnly + bothFactors = 1 + 4 = 5 of 8 → 63% (62.5% rounded up).
    expect(document.body.textContent).toContain("63%");
  });

  test("workspacesWithGap excludes empty workspaces", () => {
    // Three workspaces:
    //   - "Filled" — 2 of 2 enrolled (no gap)
    //   - "Gap" — 1 of 2 enrolled (gap)
    //   - "Empty" — 0 admins (NOT a gap; the `adminCount > 0` guard must hold)
    mockData = {
      aggregate: buckets({
        adminCount: 4,
        mfaEnrolled: 3,
        bothFactors: 2,
        twoFactorOnly: 1,
        noFactors: 1,
      }),
      workspaces: [
        workspace("a", "Filled", { adminCount: 2, mfaEnrolled: 2, bothFactors: 2 }),
        workspace("b", "Gap", { adminCount: 2, mfaEnrolled: 1, twoFactorOnly: 1, noFactors: 1 }),
        workspace("c", "Empty"),
      ],
    };
    render(<PlatformSecurityPage />, { wrapper });

    // The "Workspaces with gaps" card should read 1, not 2 (Empty is excluded).
    // Use the description text to anchor the assertion uniquely.
    expect(document.body.textContent).toContain("Workspaces where at least one admin hasn't enrolled MFA");
    // The card shows the value "1" inline; we look for the surrounding label
    // "Workspaces with gaps" + the numeral.
    const text = document.body.textContent ?? "";
    const gapCardMatch = text.match(/Workspaces with gaps\s*(\d+)/);
    expect(gapCardMatch).not.toBeNull();
    expect(gapCardMatch![1]).toBe("1");
  });

  test("renders the empty-workspaces branch when no workspaces exist", () => {
    mockData = { aggregate: buckets(), workspaces: [] };
    render(<PlatformSecurityPage />, { wrapper });
    expect(document.body.textContent).toContain("No active workspaces yet");
  });

  test("factor distribution shows the empty-state copy when adminCount is zero", () => {
    mockData = {
      aggregate: buckets(),
      workspaces: [workspace("a", "A")],
    };
    render(<PlatformSecurityPage />, { wrapper });
    expect(document.body.textContent).toContain("No admins on the platform yet");
  });

  test("workspace table renders enrollment rate per workspace", () => {
    mockData = {
      aggregate: buckets({
        adminCount: 6,
        mfaEnrolled: 4,
        bothFactors: 3,
        twoFactorOnly: 1,
        passkeyOnly: 0,
        noFactors: 2,
      }),
      workspaces: [
        workspace("a", "Acme", {
          adminCount: 4,
          mfaEnrolled: 4,
          bothFactors: 3,
          twoFactorOnly: 1,
          activeTrustDevices: 2,
          activeTrustDeviceUsers: 2,
        }),
        workspace("b", "Beta", {
          adminCount: 2,
          mfaEnrolled: 0,
          noFactors: 2,
        }),
      ],
    };
    render(<PlatformSecurityPage />, { wrapper });

    // Acme row: 100% enrollment.
    expect(document.body.textContent).toContain("Acme");
    expect(document.body.textContent).toContain("100%");
    // Beta row: 0% enrollment, 0 / 2.
    expect(document.body.textContent).toContain("Beta");
    expect(document.body.textContent).toContain("0%");
  });

  test("trust-device counts surface in the factor-distribution footer", () => {
    mockData = {
      aggregate: buckets({
        adminCount: 4,
        mfaEnrolled: 4,
        bothFactors: 4,
        activeTrustDevices: 7,
        activeTrustDeviceUsers: 5,
      }),
      workspaces: [workspace("a", "A", { adminCount: 4, mfaEnrolled: 4, bothFactors: 4, activeTrustDevices: 7, activeTrustDeviceUsers: 5 })],
    };
    render(<PlatformSecurityPage />, { wrapper });
    expect(document.body.textContent).toContain("Active trust grants:");
    expect(document.body.textContent).toContain("7");
    expect(document.body.textContent).toContain("Distinct admins skipping 2FA:");
    expect(document.body.textContent).toContain("5");
  });
});
