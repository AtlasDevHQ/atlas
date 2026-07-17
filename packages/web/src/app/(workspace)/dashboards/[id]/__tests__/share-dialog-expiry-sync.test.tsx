/**
 * Regression guard for #4536 at the WIRING seam — the pure `deriveExpiryKey`
 * mapping is pinned in `share-expiry.test.ts`, but the actual bug lived in the
 * one line that calls it: `setExpiresIn(deriveExpiryKey(status.expiresAt))`
 * inside `fetchShareStatus`. Without that sync the "Link expires" control keeps
 * its `"7d"` mount default, so a trial admin who opens the dialog only to flip
 * visibility re-POSTs `expiresIn: "7d"` and silently collapses a "Never" link to
 * one that dies in 7 days.
 *
 * This test drives the real dialog (real deriveExpiryKey, mocked transport) and
 * asserts the write half of the contract: opening on a NO-EXPIRY share and
 * clicking "Update settings" WITHOUT touching the expiry control must send
 * `expiresIn: "never"`, never `"7d"`. If the sync line is deleted or reordered,
 * this goes red while the pure-function suite stays green.
 */
import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import React, { type ReactNode } from "react";
import { render, screen, cleanup, fireEvent, act, waitFor } from "@testing-library/react";
import type { AtlasConfig, AtlasAuthClient } from "@/ui/context";

interface CapturedCall {
  path: string;
  method?: string;
  body?: Record<string, unknown>;
}

let mutateCalls: CapturedCall[] = [];

void mock.module("@/ui/hooks/use-admin-mutation", () => ({
  useAdminMutation: () => ({
    mutate: async (opts: { path: string; method?: string; body?: Record<string, unknown> }) => {
      mutateCalls.push({ path: opts.path, method: opts.method, body: opts.body });
      return { ok: true, data: { token: "tok_new", expiresAt: null, shareMode: "org" } };
    },
    saving: false,
    error: null,
    clearError: () => {},
    reset: () => {},
  }),
}));

const { DashboardShareDialog } = await import("../share-dialog");
const { AtlasProvider } = await import("@/ui/context");

// Minimal AtlasConfig — the share path reads only apiUrl/isCrossOrigin; authClient
// is never touched here (the mutation hook is mocked, status fetch uses global fetch).
// `as unknown as AtlasAuthClient` (not `as never`) keeps any future authClient
// access type-visible instead of silently satisfying it.
const testConfig: AtlasConfig = {
  apiUrl: "",
  isCrossOrigin: false,
  authClient: {} as unknown as AtlasAuthClient,
};

function Wrapper({ children }: { children: ReactNode }) {
  return React.createElement(AtlasProvider, { config: testConfig, children });
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  mutateCalls = [];
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

async function openDialogWithStatus(status: {
  shared: boolean;
  token: string | null;
  expiresAt: string | null;
  shareMode: "public" | "org";
}): Promise<void> {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(status), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

  render(React.createElement(DashboardShareDialog, { dashboardId: "dash_1" }), { wrapper: Wrapper });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Share/ }));
  });
  // Wait for fetchShareStatus to resolve and the shared-view controls to render.
  await waitFor(() => expect(screen.getByRole("button", { name: /Update settings/ })).toBeDefined());
}

describe("DashboardShareDialog — expiry sync on open (#4536)", () => {
  test("a no-expiry share: visibility-only 'Update settings' sends expiresIn 'never', not the '7d' default", async () => {
    await openDialogWithStatus({ shared: true, token: "tok_live", expiresAt: null, shareMode: "public" });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Update settings/ }));
    });

    await waitFor(() => expect(mutateCalls.length).toBeGreaterThan(0));
    const shareCall = mutateCalls.find((c) => c.path.endsWith("/share"));
    expect(shareCall).toBeDefined();
    // The core regression: the control synced to the share's real (no-)expiry, so
    // the re-POST preserves it instead of stamping the stale "7d" mount default.
    expect(shareCall?.body?.expiresIn).toBe("never");
    // Token-preserving edit — not a rotation.
    expect(shareCall?.body?.rotate).toBe(false);
  });
});
