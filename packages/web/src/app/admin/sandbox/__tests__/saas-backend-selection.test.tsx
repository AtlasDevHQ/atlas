/**
 * Regression guard for the SaaS sandbox save-value mapping (#3375).
 *
 * `ATLAS_SANDBOX_BACKEND` stores backend ids. The SaaS view previously
 * wrote bare provider keys ("e2b") for BYOC cards and "sidecar" for the
 * managed card — neither matched anything the explore runtime resolves,
 * so every selection silently fell through to the platform default.
 * These tests pin what each card does: BYOC cards save the provider's
 * backend id; the Managed card clears the override (follow the platform
 * default) instead of writing a value.
 */

import { describe, expect, mock, test } from "bun:test";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AtlasProvider, type AtlasAuthClient } from "@/ui/context";
import { SaasSandboxView } from "../page";
import type { SandboxStatus } from "@/ui/lib/admin-schemas";

// ProviderRow wires useAdminMutation, which reads the Atlas config context
// and the react-query client — the mutations are never fired in these
// tests, but the hooks must mount.
const stubAuthClient: AtlasAuthClient = {
  signIn: { email: async () => ({}) },
  signUp: { email: async () => ({}) },
  signOut: async () => {},
  useSession: () => ({ data: null }),
};

function wrapper({ children }: { children: ReactNode }) {
  return createElement(
    QueryClientProvider,
    { client: new QueryClient() },
    createElement(
      AtlasProvider,
      {
        config: {
          apiUrl: "http://localhost:3001",
          isCrossOrigin: false as const,
          authClient: stubAuthClient,
        },
      },
      children,
    ),
  );
}

function makeStatus(overrides: Partial<SandboxStatus>): SandboxStatus {
  return {
    activeBackend: "vercel-sandbox",
    platformDefault: "vercel-sandbox",
    workspaceOverride: null,
    workspaceSidecarUrl: null,
    availableBackends: [
      { id: "vercel-sandbox", name: "Vercel Sandbox", type: "built-in", available: true },
      { id: "e2b-sandbox", name: "E2B", type: "plugin", available: true },
    ],
    connectedProviders: [],
    ...overrides,
  };
}

function renderView(status: SandboxStatus) {
  const onSelectBackend = mock(async (_backendId: string) => undefined);
  const onSelectManaged = mock(async () => undefined);
  const utils = render(
    createElement(SaasSandboxView, {
      status,
      onSelectBackend,
      onSelectManaged,
      onRefetch: mock(() => {}),
      saving: false,
    }),
    { wrapper },
  );
  return { ...utils, onSelectBackend, onSelectManaged };
}

describe("SaasSandboxView — backend-id save values", () => {
  test("selecting a connected BYOC provider saves its backend id, not the provider key", () => {
    const { getAllByText, onSelectBackend, onSelectManaged } = renderView(
      makeStatus({
        connectedProviders: [
          {
            provider: "e2b",
            displayName: "Acme",
            connectedAt: "2026-06-01T00:00:00.000Z",
            validatedAt: null,
            isActive: false,
          },
        ],
      }),
    );

    // Managed is active (no provider row is live), so the only
    // "Use this" button belongs to the connected e2b row.
    const buttons = getAllByText("Use this");
    expect(buttons.length).toBe(1);
    fireEvent.click(buttons[0]!);

    expect(onSelectBackend).toHaveBeenCalledTimes(1);
    expect(onSelectBackend.mock.calls[0]?.[0]).toBe("e2b-sandbox");
    expect(onSelectManaged).not.toHaveBeenCalled();
    cleanup();
  });

  test("selecting the managed card clears the override (follows the platform default), not a 'sidecar' write", () => {
    const { getAllByText, onSelectBackend, onSelectManaged } = renderView(
      makeStatus({
        activeBackend: "e2b-sandbox",
        workspaceOverride: "e2b-sandbox",
        connectedProviders: [
          {
            provider: "e2b",
            displayName: "Acme",
            connectedAt: "2026-06-01T00:00:00.000Z",
            validatedAt: null,
            isActive: true,
          },
        ],
      }),
    );

    // The e2b row is live, so the only "Use this" button is the managed card's.
    const buttons = getAllByText("Use this");
    expect(buttons.length).toBe(1);
    fireEvent.click(buttons[0]!);

    expect(onSelectManaged).toHaveBeenCalledTimes(1);
    expect(onSelectBackend).not.toHaveBeenCalled();
    cleanup();
  });

  test("managed card reads active from server-derived isActive, not the override string", () => {
    // Legacy contradiction scenario: an override is set but no provider row
    // is live (e.g. the selected backend was unavailable and the runtime
    // fell back). Managed must present as the active card.
    const { getByText, queryAllByText } = renderView(
      makeStatus({
        workspaceOverride: "e2b-sandbox",
        activeBackend: "vercel-sandbox",
        connectedProviders: [
          {
            provider: "e2b",
            displayName: "Acme",
            connectedAt: "2026-06-01T00:00:00.000Z",
            validatedAt: null,
            isActive: false,
          },
        ],
      }),
    );

    getByText("Atlas Cloud Sandbox");
    // Managed active → its "Use this" button is hidden; only e2b's remains.
    expect(queryAllByText("Use this").length).toBe(1);
    cleanup();
  });
});
