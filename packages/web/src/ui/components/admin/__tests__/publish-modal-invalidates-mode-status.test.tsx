/**
 * Regression: a successful publish must invalidate the `mode-status` query.
 *
 * The top-bar {@link PendingChangesPill} reads its "N pending" count from
 * `useModeStatus`, a TanStack query keyed `["mode-status", apiUrl]`. Publishing
 * is the one action that empties that queue, and nothing else in the app
 * invalidates the key — the QueryClient's 30s `staleTime` +
 * `refetchOnWindowFocus` only refresh it once the admin leaves the tab and
 * comes back. So an admin who published and stayed on the page kept reading a
 * stale count until a full reload (found in the 2026-08-03 prod soak: the pill
 * still said "10 pending" with zero drafts left).
 *
 * Asserted against the CACHE rather than a re-render, because the pill lives in
 * a different subtree: what this fix owes the app is an invalidated key, and
 * every consumer of it follows from that.
 *
 * The partial-publish case is asserted too — refused drafts (#4769) stay
 * pending while promoted ones do not, so the counts move on that path as well
 * and the modal deliberately stays OPEN there. An invalidation placed inside
 * the success-and-close branch would miss it.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AtlasProvider } from "@/ui/context";

void mock.module("sonner", () => ({
  toast: { success: () => {}, warning: () => {}, error: () => {} },
}));

import { PublishModal } from "../publish-modal";

const API_URL = "http://localhost:3001";

const testConfig = {
  apiUrl: API_URL,
  isCrossOrigin: false,
  authClient: {
    signIn: { email: async () => ({}) },
    signUp: { email: async () => ({}) },
    signOut: async () => {},
    useSession: () => ({ data: null, isPending: false }),
  },
};

/** One draft so the modal renders a publish button rather than an empty state. */
const PREVIEW = {
  connections: [],
  entities: [],
  entityEdits: [],
  entityDeletes: [],
  prompts: [{ id: "p1", name: "a prompt", updatedAt: null }],
  starterPrompts: [],
};

/** Whatever the publish POST should answer with for a given case. */
function stubFetch(publishBody: Record<string, unknown>): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = url.includes("/publish-preview") ? PREVIEW : publishBody;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}

function renderModal(): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Seed the key the pill reads, so "invalidated" is a state CHANGE rather
  // than the vacuous truth about a key that was never populated.
  queryClient.setQueryData(["mode-status", API_URL], { draftCounts: { prompts: 1 } });
  const ui: ReactElement = (
    <QueryClientProvider client={queryClient}>
      <AtlasProvider config={testConfig}>
        <PublishModal open onOpenChange={() => {}} />
      </AtlasProvider>
    </QueryClientProvider>
  );
  rtlRender(ui);
  return queryClient;
}

function modeStatusInvalidated(qc: QueryClient): boolean {
  return qc.getQueryState(["mode-status", API_URL])?.isInvalidated === true;
}

/**
 * The confirm button is `disabled` while the preview query is in flight, and
 * `fireEvent.click` on a disabled button is a silent no-op — so waiting for it
 * to be ENABLED is load-bearing, not defensive.
 */
async function clickPublish(): Promise<void> {
  const button = await waitFor(() => {
    const match = screen
      .getAllByRole("button")
      .find((b) => /publish/i.test(b.textContent ?? "") && !(b as HTMLButtonElement).disabled);
    if (!match) throw new Error("publish button not enabled yet");
    return match;
  });
  fireEvent.click(button);
}

afterEach(() => {
  cleanup();
});

describe("PublishModal invalidates the pending-pill count", () => {
  test("a clean publish invalidates mode-status", async () => {
    stubFetch({ ok: true });
    const qc = renderModal();

    // The premise: seeded and NOT invalidated before the click. Without this
    // the final assertion would pass against a key that was simply absent.
    expect(qc.getQueryState(["mode-status", API_URL])).toBeDefined();
    expect(modeStatusInvalidated(qc)).toBe(false);

    await clickPublish();
    await waitFor(() => expect(modeStatusInvalidated(qc)).toBe(true));
  });

  test("a PARTIAL publish invalidates it too", async () => {
    // Refused drafts keep the modal open, so this path never reaches the
    // close-and-toast branch. The counts still moved.
    stubFetch({ ok: true, refusedDrafts: [{ id: "f1", detail: "no grant" }], refusedDraftTotal: 1 });
    const qc = renderModal();
    expect(modeStatusInvalidated(qc)).toBe(false);

    await clickPublish();
    await waitFor(() => expect(modeStatusInvalidated(qc)).toBe(true));
  });
});
