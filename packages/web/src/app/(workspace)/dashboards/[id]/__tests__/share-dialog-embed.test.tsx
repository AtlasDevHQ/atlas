/**
 * Covers the #4564 additions to the dashboard share dialog:
 *   - the Embed tab emits a working iframe snippet pointing at the share token's
 *     framable `/embed` route, and "Copy embed code" writes that snippet;
 *   - the dialog copy is shareMode-aware — an org share no longer claims
 *     "Anyone with the link" (audit L1).
 *
 * Harness mirrors share-dialog-expiry-sync.test.tsx: real dialog, mocked
 * transport (useAdminMutation + global fetch for status), AtlasProvider wrapper.
 */
import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import React, { type ReactNode } from "react";
import { render, screen, cleanup, fireEvent, act, waitFor } from "@testing-library/react";
import type { AtlasConfig, AtlasAuthClient } from "@/ui/context";

void mock.module("@/ui/hooks/use-admin-mutation", () => ({
  useAdminMutation: () => ({
    mutate: async () => ({ ok: true, data: { token: "tok_live", expiresAt: null, shareMode: "public" } }),
    saving: false,
    error: null,
    clearError: () => {},
    reset: () => {},
  }),
}));

const { DashboardShareDialog } = await import("../share-dialog");
const { AtlasProvider } = await import("@/ui/context");

const testConfig: AtlasConfig = {
  apiUrl: "",
  isCrossOrigin: false,
  authClient: {} as unknown as AtlasAuthClient,
};

function Wrapper({ children }: { children: ReactNode }) {
  return React.createElement(AtlasProvider, { config: testConfig, children });
}

const originalFetch = globalThis.fetch;
let clipboardText: string | null = null;

beforeEach(() => {
  clipboardText = null;
  // navigator.clipboard is a readonly accessor in jsdom — define it directly.
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        clipboardText = text;
      },
    },
  });
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
  await waitFor(() => expect(screen.getByRole("tab", { name: "Embed" })).toBeDefined());
}

describe("DashboardShareDialog — Embed tab (#4564)", () => {
  test("emits an iframe snippet pointing at the token's /embed route, and copies it", async () => {
    await openDialogWithStatus({ shared: true, token: "tok_live", expiresAt: null, shareMode: "public" });

    await act(async () => {
      // Radix activates a tab on mousedown; jsdom's click doesn't move focus so
      // automatic (focus-driven) activation never fires — mousedown does.
      fireEvent.mouseDown(screen.getByRole("tab", { name: "Embed" }));
    });

    const snippet = (await screen.findByLabelText("Embed snippet")) as HTMLTextAreaElement;
    expect(snippet.value).toContain("<iframe");
    expect(snippet.value).toContain(`${window.location.origin}/shared/dashboard/tok_live/embed`);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Copy embed code/ }));
    });
    await waitFor(() => expect(clipboardText).not.toBeNull());
    expect(clipboardText).toContain("/shared/dashboard/tok_live/embed");
    expect(clipboardText).toContain("<iframe");
  });

  test("the appearance control defaults to System (no ?theme=) and regenerates the snippet per choice (#4686)", async () => {
    await openDialogWithStatus({ shared: true, token: "tok_live", expiresAt: null, shareMode: "public" });
    await act(async () => {
      fireEvent.mouseDown(screen.getByRole("tab", { name: "Embed" }));
    });

    const snippet = (await screen.findByLabelText("Embed snippet")) as HTMLTextAreaElement;
    // Default = System → no forced theme param.
    expect(snippet.value).toContain("/shared/dashboard/tok_live/embed\"");
    expect(snippet.value).not.toContain("?theme=");

    // Selecting Dark bakes ?theme=dark into the snippet.
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: /Dark/ }));
    });
    await waitFor(() => expect(snippet.value).toContain("/embed?theme=dark"));

    // Selecting Light swaps it to ?theme=light.
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: /Light/ }));
    });
    await waitFor(() => expect(snippet.value).toContain("/embed?theme=light"));
  });

  test("re-clicking the active appearance keeps the selection (Radix deselect guard) (#4686)", async () => {
    await openDialogWithStatus({ shared: true, token: "tok_live", expiresAt: null, shareMode: "public" });
    await act(async () => {
      fireEvent.mouseDown(screen.getByRole("tab", { name: "Embed" }));
    });
    const snippet = (await screen.findByLabelText("Embed snippet")) as HTMLTextAreaElement;

    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: /Dark/ }));
    });
    await waitFor(() => expect(snippet.value).toContain("/embed?theme=dark"));

    // Re-click the active item — Radix emits "" (deselect). The guard must keep
    // "dark" selected so the snippet never carries an empty/blank ?theme=.
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: /Dark/ }));
    });
    expect(snippet.value).toContain("/embed?theme=dark");
    expect(snippet.value).not.toContain("?theme=\"");
    expect(snippet.value).not.toContain("?theme=&");
  });

  test("the embed caption is shareMode-aware — an org share warns viewers must sign in", async () => {
    await openDialogWithStatus({ shared: true, token: "tok_live", expiresAt: null, shareMode: "org" });

    await act(async () => {
      fireEvent.mouseDown(screen.getByRole("tab", { name: "Embed" }));
    });
    await screen.findByLabelText("Embed snippet");

    expect(
      screen.getByText(/must be signed in to your organization for this embed to load/i),
    ).toBeDefined();
    expect(screen.queryByText(/Anyone who can load the host page/i)).toBeNull();
  });
});

describe("DashboardShareDialog — shareMode-aware copy (#4564, audit L1)", () => {
  test("an org share does NOT claim 'Anyone with the link'", async () => {
    await openDialogWithStatus({ shared: true, token: "tok_live", expiresAt: null, shareMode: "org" });

    expect(
      screen.getByText(/Only authenticated members of your organization can view/i),
    ).toBeDefined();
    expect(screen.queryByText(/Anyone with the link/i)).toBeNull();
  });

  test("a public share keeps the 'Anyone with the link' copy", async () => {
    await openDialogWithStatus({ shared: true, token: "tok_live", expiresAt: null, shareMode: "public" });

    expect(screen.getByText(/Anyone with the link can view this dashboard/i)).toBeDefined();
  });
});
