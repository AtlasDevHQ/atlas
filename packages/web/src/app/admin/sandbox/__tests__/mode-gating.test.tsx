/**
 * Deploy-mode gating for the sandbox page (#3378).
 *
 * `/admin/sandbox` swaps whole mode-specific views on `useDeployMode()` and
 * each view writes a different `ATLAS_SANDBOX_BACKEND` vocabulary, so it sits
 * in the strictest tier of the deploy-mode parity contract (Rule 2 in
 * docs/development/enterprise-gating.md): it must never commit to a guessed
 * mode. These tests pin the three gate states:
 *
 *  - settings-fetch failure (the guess says "saas" on a custom-domain
 *    self-host) → error surface, NOT the SaaS view;
 *  - mode still loading → neutral loading state, no view (and therefore no
 *    reachable save path), while the cosmetic heading may render the guess;
 *  - mode resolved → the matching view renders.
 */

import { describe, expect, mock, test } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import { createElement } from "react";
import { buildFetchError, type FetchError } from "@/ui/lib/fetch-error";
import type { SandboxStatus } from "@/ui/lib/admin-schemas";
import type { DeployMode } from "@/ui/lib/types";

// ── Module mocks ──────────────────────────────────────────────────

// Staged return for the page's `useDeployMode()` call. Mutated per test.
let modeReturn: {
  deployMode: DeployMode;
  loading: boolean;
  error: FetchError | null;
  resolved: boolean;
} = { deployMode: "saas", loading: false, error: null, resolved: true };

mock.module("@/ui/hooks/use-deploy-mode", () => ({
  useDeployMode: () => modeReturn,
}));

function makeStatus(overrides: Partial<SandboxStatus> = {}): SandboxStatus {
  return {
    activeBackend: "vercel-sandbox",
    platformDefault: "vercel-sandbox",
    workspaceOverride: null,
    workspaceSidecarUrl: null,
    availableBackends: [
      { id: "vercel-sandbox", name: "Vercel Sandbox", type: "built-in", available: true },
    ],
    connectedProviders: [],
    ...overrides,
  };
}

// The sandbox-status fetch always succeeds in these tests — the point is
// that a healthy status payload alone must NOT be enough to render a view
// while the deploy mode is still a guess.
mock.module("@/ui/hooks/use-admin-fetch", () => ({
  useAdminFetch: () => ({
    data: makeStatus(),
    loading: false,
    error: null,
    setError: () => {},
    refetch: () => {},
  }),
  useInProgressSet: () => ({
    has: () => false,
    start: () => {},
    stop: () => {},
  }),
  friendlyError: (e: FetchError) => e.message,
}));

mock.module("@/ui/hooks/use-admin-mutation", () => ({
  useAdminMutation: () => ({
    mutate: async () => ({ ok: true as const, data: undefined }),
    saving: false,
    error: null,
    clearError: () => {},
    errorsByItemId: {},
    isMutating: () => false,
    reset: () => {},
  }),
}));

const { default: SandboxPage } = await import("../page");

// ── Markers ───────────────────────────────────────────────────────
// "Bring your own cloud" only exists in SaasSandboxView; "Sandbox backend"
// only in SelfHostedSandboxView.

const SAAS_MARKER = "Bring your own cloud";
const SELF_HOSTED_MARKER = "Sandbox backend";

describe("SandboxPage deploy-mode gating (#3378)", () => {
  test("settings fetch failure does not render the SaaS view from the hostname guess", () => {
    // Custom-domain self-host scenario: /api/v1/admin/settings 403s, so the
    // hook falls back to the public-hostname guess ("saas") with
    // resolved: false. The page must surface the failure, not the guessed
    // SaaS view whose saves write SaaS-vocabulary values.
    modeReturn = {
      deployMode: "saas",
      loading: false,
      error: buildFetchError({ message: "HTTP 403", status: 403 }),
      resolved: false,
    };
    const { queryByText, getByRole } = render(createElement(SandboxPage));

    expect(queryByText(SAAS_MARKER)).toBeNull();
    expect(queryByText(SELF_HOSTED_MARKER)).toBeNull();
    // The mode error surfaces through the page's error path.
    expect(getByRole("alert").textContent).toContain("HTTP 403");
    cleanup();
  });

  test("renders a neutral loading state (no view, no save path) until loading === false", () => {
    modeReturn = { deployMode: "saas", loading: true, error: null, resolved: false };
    const { queryByText, getByText } = render(createElement(SandboxPage));

    expect(queryByText(SAAS_MARKER)).toBeNull();
    expect(queryByText(SELF_HOSTED_MARKER)).toBeNull();
    // Neutral loading presentation from AdminContentWrapper.
    getByText("Loading...");
    // Cosmetic tier is allowed to render from the guess: the heading copy
    // may show the guessed mode's title while the view stays neutral.
    getByText("Execution Environment");
    cleanup();
  });

  test("resolved saas renders the SaaS view", () => {
    modeReturn = { deployMode: "saas", loading: false, error: null, resolved: true };
    const { getByText, queryByText } = render(createElement(SandboxPage));

    getByText(SAAS_MARKER);
    expect(queryByText(SELF_HOSTED_MARKER)).toBeNull();
    cleanup();
  });

  test("resolved self-hosted renders the self-hosted view", () => {
    modeReturn = { deployMode: "self-hosted", loading: false, error: null, resolved: true };
    const { getByText, queryByText } = render(createElement(SandboxPage));

    getByText(SELF_HOSTED_MARKER);
    expect(queryByText(SAAS_MARKER)).toBeNull();
    cleanup();
  });
});
