/**
 * Web seam for the workspace auto-promotion toggle (#4582).
 *
 * The auto-promote/decay trust dial is a workspace-scoped boolean in the
 * settings registry, so the DATA-DRIVEN Workspace Settings page renders it as an
 * editable toggle with no bespoke component (mirrors ATLAS_AUTONOMOUS_IMPROVE_
 * ENABLED). This is its "own settings surface" — distinct from the learned-
 * patterns cockpit. These tests pin that seam: a workspace-scoped boolean for
 * the promote-decay key surfaces under Intelligence and is editable, while a
 * platform-scoped sibling never leaks onto the workspace page.
 */

import { describe, expect, test, mock, afterEach } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NuqsAdapter } from "nuqs/adapters/next/app";

// The promote-decay workspace toggle + a platform-scoped sibling that must be
// filtered off the workspace page. Full SettingWithValue shape so the page's
// grouping/rendering exercises the real contract.
const settingsResponse = {
  manageable: true,
  settings: [
    {
      key: "ATLAS_LEARN_PROMOTE_DECAY_ENABLED",
      section: "Intelligence",
      label: "Auto-Promote Learned Patterns",
      description: "Let Atlas auto-promote this workspace's learned patterns.",
      type: "boolean",
      default: "false",
      envVar: "ATLAS_LEARN_PROMOTE_DECAY_ENABLED",
      scope: "workspace",
      currentValue: "false",
      source: "default",
    },
    {
      // Platform-scoped fiber cadence — must NOT render on the workspace page.
      key: "ATLAS_LEARN_PROMOTE_DECAY_INTERVAL_HOURS",
      section: "Intelligence",
      label: "Auto-Promote / Decay Interval",
      description: "Hours between runs.",
      type: "number",
      default: "24",
      envVar: "ATLAS_LEARN_PROMOTE_DECAY_INTERVAL_HOURS",
      scope: "platform",
      currentValue: "24",
      source: "default",
    },
  ],
};

let deployMode: "saas" | "self-hosted" = "saas";

void mock.module("@/ui/hooks/use-deploy-mode", () => ({
  useDeployMode: () => ({ deployMode, loading: false, error: null, resolved: true }),
}));

void mock.module("@/ui/hooks/use-admin-fetch", () => ({
  useAdminFetch: () => ({
    data: settingsResponse,
    loading: false,
    error: null,
    refetch: () => {},
  }),
  friendlyError: (err: { message?: string }) => err?.message ?? "error",
}));

void mock.module("@/ui/hooks/use-admin-mutation", () => ({
  useAdminMutation: () => ({
    mutate: async () => ({ ok: true }),
    saving: false,
    error: null,
    clearError: () => {},
    reset: () => {},
    isMutating: () => false,
  }),
}));

void mock.module("@/lib/auth/client", () => ({
  authClient: {
    useSession: () => ({
      data: { session: { activeOrganizationId: "ws_test", activeOrganizationName: "Test WS" } },
    }),
  },
}));

const SettingsPage = (await import("../page")).default;

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(NuqsAdapter, null, createElement(QueryClientProvider, { client }, children));
}

afterEach(() => {
  cleanup();
  deployMode = "saas";
});

describe("/admin/settings — workspace auto-promotion toggle (#4582)", () => {
  test("renders the promote-decay toggle under Intelligence for a workspace admin", () => {
    const { container } = render(createElement(SettingsPage), { wrapper });
    const text = container.textContent ?? "";
    expect(text).toContain("Auto-Promote Learned Patterns");
    expect(text).toContain("Intelligence");
    // Manageable → the row exposes an Edit affordance (the toggle is editable).
    expect(text).toContain("Edit");
  });

  test("the platform-scoped interval key never leaks onto the workspace page", () => {
    const { container } = render(createElement(SettingsPage), { wrapper });
    const text = container.textContent ?? "";
    expect(text).not.toContain("Auto-Promote / Decay Interval");
  });

  test("the toggle also surfaces on self-hosted", () => {
    deployMode = "self-hosted";
    const { container } = render(createElement(SettingsPage), { wrapper });
    expect(container.textContent ?? "").toContain("Auto-Promote Learned Patterns");
  });
});
