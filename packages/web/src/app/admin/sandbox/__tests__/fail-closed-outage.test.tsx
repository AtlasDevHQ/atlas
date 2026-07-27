/**
 * #4837 — a fail-closed deployment must read as an OUTAGE on /admin/sandbox.
 *
 * The SaaS view is the one that matters, and it is the one the issue's
 * `Active: fail-closed` row could not even warn about: this view never rendered
 * `activeBackend` at all. It derived "Managed is live" from `!connectedProviders
 * .some(isActive)`, so a region whose explore was refusing every request showed
 * "Atlas Cloud Sandbox · Live" — a green light on a total outage, on the page an
 * operator opens to diagnose exactly that.
 *
 * Reachable in production: `deploy/api/atlas.config.ts` pins
 * `priority: ["vercel-sandbox"]` with no `just-bash` on staging and all three
 * prod regions, and `VERCEL_TOKEN` is a per-service Railway secret that shared
 * vars do not inherit (#4828).
 */

import { describe, expect, mock, test } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AtlasProvider, type AtlasAuthClient } from "@/ui/context";
import { SaasSandboxView, SandboxOutageNotice } from "../page";
import type { SandboxStatus } from "@/ui/lib/admin-schemas";

const stubAuthClient: AtlasAuthClient = {
  signIn: { email: async () => ({}) },
  signUp: { email: async () => ({}) },
  signOut: async () => {},
  useSession: () => ({ data: null, isPending: false }),
};

function wrapper({ children }: { children: ReactNode }) {
  return createElement(
    QueryClientProvider,
    { client: new QueryClient() },
    createElement(AtlasProvider, {
      config: {
        apiUrl: "http://localhost:3001",
        isCrossOrigin: false as const,
        authClient: stubAuthClient,
      },
      children,
    }),
  );
}

/** The wire payload a fail-closed SaaS region actually sends. */
function failClosedStatus(overrides: Partial<SandboxStatus> = {}): SandboxStatus {
  return {
    activeBackend: null,
    platformDefault: null,
    workspaceOverride: null,
    workspaceSidecarUrl: null,
    availableBackends: [
      { id: "vercel-sandbox", name: "Vercel Sandbox", type: "built-in", available: false },
    ],
    connectedProviders: [],
    failClosed: {
      remediation:
        "Explore tool: UNAVAILABLE — every backend in sandbox.priority (vercel-sandbox) is " +
        "unavailable and the pin has no 'just-bash' fallback, so the tool fails closed and " +
        "refuses every request. For Vercel Sandbox off-Vercel, set VERCEL_TEAM_ID, " +
        "VERCEL_PROJECT_ID, and VERCEL_TOKEN.",
    },
    ...overrides,
  };
}

function healthyStatus(): SandboxStatus {
  return {
    activeBackend: "vercel-sandbox",
    platformDefault: "vercel-sandbox",
    workspaceOverride: null,
    workspaceSidecarUrl: null,
    availableBackends: [
      { id: "vercel-sandbox", name: "Vercel Sandbox", type: "built-in", available: true },
    ],
    connectedProviders: [],
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

describe("SaasSandboxView — fail-closed region (#4837)", () => {
  test("the managed card reads Down, never Live, when the platform default failed closed", () => {
    const { getByText, queryByText } = renderView(failClosedStatus());

    getByText("Down");
    // The regression: "Live" on a region where explore refuses every request.
    expect(queryByText("Live")).toBeNull();
    // "Available" would be just as wrong — it is not available, it is broken.
    expect(queryByText("Available")).toBeNull();
    cleanup();
  });

  test("offers no 'Use this' on the managed card — selecting the broken default is not a fix", () => {
    const { queryAllByText } = renderView(failClosedStatus());
    expect(queryAllByText("Use this").length).toBe(0);
    cleanup();
  });

  test("a healthy region is unchanged — the managed card still reads Live", () => {
    // Guards the other direction: the Down state must be gated on the outage,
    // not accidentally on "no BYOC provider is live", which is the normal case.
    const { getByText, queryByText } = renderView(healthyStatus());
    getByText("Live");
    expect(queryByText("Down")).toBeNull();
    cleanup();
  });

  test("a usable BYOC override keeps running — the managed card is not marked down", () => {
    // The override sits ahead of the platform plan, so this workspace's explore
    // still works. Flagging it down would be a false alarm, and an operator who
    // learns to dismiss one alarm dismisses the next.
    const { queryByText } = renderView(
      failClosedStatus({
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
    expect(queryByText("Down")).toBeNull();
    cleanup();
  });
});

describe("SandboxOutageNotice — remediation (#4837)", () => {
  const { failClosed } = failClosedStatus();

  test("renders the server's remediation verbatim, naming the pin and its credential", () => {
    if (!failClosed) throw new Error("fixture must carry a failClosed block");
    const { getByRole, getByText } = render(
      createElement(SandboxOutageNotice, { failClosed, workspaceStillRunning: false }),
      { wrapper },
    );

    getByRole("alert");
    getByText(/every request is refused/);
    // The AC that separates this from #4828: the operator is told which backend
    // is pinned and which credential it needs — not "install nsjail", which the
    // pin makes impossible to act on.
    getByText(/vercel-sandbox/);
    getByText(/VERCEL_TOKEN/);
    cleanup();
  });

  test("softens the headline when a workspace BYOC backend is still running", () => {
    if (!failClosed) throw new Error("fixture must carry a failClosed block");
    const { getByText, queryByText } = render(
      createElement(SandboxOutageNotice, { failClosed, workspaceStillRunning: true }),
      { wrapper },
    );

    getByText(/this workspace is running on its own backend/i);
    // A blanket "every request is refused" here would be a false alarm for a
    // workspace whose explore demonstrably works.
    expect(queryByText("Explore tool unavailable — every request is refused")).toBeNull();
    cleanup();
  });
});
