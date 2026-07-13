/**
 * Regression guard for #4645.
 *
 * The billing page's "Default AI model" picker (ModelRow) must write the
 * per-workspace model-config seam (`PUT /api/v1/admin/model-config`,
 * gateway-on-platform-credits) — NOT the `ATLAS_MODEL` settings key. That
 * key is platform-scoped, so the settings route 403s every workspace admin
 * ("is a platform-level setting and cannot be modified by workspace
 * admins"), and a platform-admin write would land on the GLOBAL row and
 * change the model for every workspace in the region. The bug shipped
 * unnoticed because platform-admin test accounts passed the gate.
 *
 * Also guards the BYOT carve-out: a BYOT workspace's model lives in its own
 * provider configuration (ModelProviderSection under the BYOT toggle);
 * ModelRow must go read-only there so a gateway write can't clobber the
 * saved BYOT provider row.
 *
 * Interaction-level coverage (actually picking a model through the Radix
 * Select) belongs to the browser suite — these tests pin the wiring: which
 * endpoint the mutation is registered against and which affordances render.
 */

import { describe, expect, test, mock, afterEach } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import type { BillingStatus } from "@useatlas/schemas";

void mock.module("next/navigation", () => ({
  usePathname: () => "/admin/billing",
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

// --- Billing data via useAdminFetch ---

let billingData: BillingStatus | null = null;
void mock.module("@/ui/hooks/use-admin-fetch", () => ({
  useAdminFetch: (path: string) => ({
    data: path === "/api/v1/billing" ? billingData : null,
    loading: false,
    error: null,
    refetch: () => {},
  }),
  useInProgressSet: () => new Set<string>(),
  friendlyError: (err: { message?: string }) => err?.message ?? "error",
}));

// --- Mutation capture: record every path/method the page registers ---

interface CapturedMutationConfig {
  path: string;
  method?: string;
}
const capturedMutations: CapturedMutationConfig[] = [];
void mock.module("@/ui/hooks/use-admin-mutation", () => ({
  useAdminMutation: (config: CapturedMutationConfig) => {
    capturedMutations.push(config);
    return {
      mutate: async () => ({ ok: true }),
      saving: false,
      error: null,
      clearError: () => {},
      reset: () => {},
    };
  },
}));

// --- Sibling hooks the page mounts (not under test) ---

void mock.module("@/ui/hooks/use-deploy-mode", () => ({
  useDeployMode: () => ({ deployMode: "saas", error: null, resolved: true }),
}));
void mock.module("@/ui/hooks/use-billing-portal", () => ({
  useBillingPortal: () => ({ openPortal: () => {}, opening: false, error: null }),
}));
void mock.module("@/ui/hooks/use-plan-checkout", () => ({
  usePlanCheckout: () => ({
    startCheckout: () => {},
    pendingPlan: null,
    error: null,
    clearError: () => {},
  }),
}));

// The inline BYOT provider section runs its own fetches/mutations — stub it
// to a marker so its registrations don't pollute `capturedMutations`.
void mock.module("@/ui/components/admin/model-provider-section", () => ({
  ModelProviderSection: () =>
    createElement("div", { "data-testid": "model-provider-section" }),
}));
void mock.module("@/ui/components/admin/trial-countdown-banner", () => ({
  TRIAL_BANNER_PLAN_ANCHOR_ID: "trial-banner-plan-anchor",
  TrialCountdownBanner: () => null,
}));

const BillingPage = (await import("../page")).default;

function wrapper({ children }: { children: ReactNode }) {
  return createElement(NuqsAdapter, null, children);
}

function makeBillingData(overrides: { byot: boolean }): BillingStatus {
  return {
    workspaceId: "org-1",
    plan: {
      tier: "starter",
      displayName: "Starter",
      pricePerSeat: 39,
      includedUsageDollarsPerSeat: 20,
      defaultModel: "anthropic/claude-sonnet-5",
      byot: overrides.byot,
      trialEndsAt: null,
    },
    limits: {
      tokenBudgetPerSeat: 2_000_000,
      totalTokenBudget: 2_000_000,
      totalUsageDollars: 20,
      maxSeats: 10,
      maxConnections: 1,
      maxChatIntegrations: 1,
    },
    usage: {
      queryCount: 10,
      tokenCount: 1000,
      seatCount: 1,
      costUsd: 0.5,
      usageDollarsPercent: 2,
      usageOverageStatus: "ok",
      periodStart: "2026-07-01T00:00:00.000Z",
      periodEnd: "2026-08-01T00:00:00.000Z",
      periodSource: "utc-month",
    },
    seats: { count: 1, max: 10 },
    connections: { count: 1, max: 1 },
    currentModel: "anthropic/claude-sonnet-5",
    subscription: null,
    availablePlans: [],
  };
}

afterEach(() => {
  cleanup();
  billingData = null;
  capturedMutations.length = 0;
});

describe("billing ModelRow — workspace model-config seam (#4645)", () => {
  test("registers the model mutation against /api/v1/admin/model-config, never the ATLAS_MODEL setting", () => {
    billingData = makeBillingData({ byot: false });
    const { container } = render(createElement(BillingPage), { wrapper });

    expect(container.textContent).toContain("Default AI model");
    const paths = capturedMutations.map((m) => m.path);
    expect(paths).toContain("/api/v1/admin/model-config");
    // The exact bug: this path is platform-scoped and 403s workspace admins.
    expect(paths.some((p) => p.includes("/admin/settings/ATLAS_MODEL"))).toBe(false);

    const modelConfig = capturedMutations.find(
      (m) => m.path === "/api/v1/admin/model-config",
    );
    expect(modelConfig?.method).toBe("PUT");
  });

  test("non-BYOT workspace gets the Change affordance", () => {
    billingData = makeBillingData({ byot: false });
    const { getByRole } = render(createElement(BillingPage), { wrapper });
    expect(getByRole("button", { name: /change/i })).toBeTruthy();
  });

  test("BYOT workspace: ModelRow is read-only so a gateway write can't clobber the provider config", () => {
    billingData = makeBillingData({ byot: true });
    const { container, queryByRole } = render(createElement(BillingPage), { wrapper });

    expect(container.textContent).toContain("Default AI model");
    expect(container.textContent).toContain("managed by your provider configuration");
    // No expand/change affordance on the model row.
    expect(queryByRole("button", { name: /change/i })).toBeNull();
    // The BYOT provider section is the model-management surface instead.
    expect(container.querySelector('[data-testid="model-provider-section"]')).toBeTruthy();
  });
});
