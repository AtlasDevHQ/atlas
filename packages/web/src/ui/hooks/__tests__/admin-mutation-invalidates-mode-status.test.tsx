/**
 * Regression: EVERY admin mutation refreshes the top bar's draft counts.
 *
 * `mode-status` is a plain `useQuery`, not a `useAdminFetch` consumer, so
 * `useAdminMutation`'s `[ADMIN_FETCH_QUERY_KEY]` broadcast never reached it.
 * That produced the same bug twice at two call sites — #5001 (publishing left
 * the pill reading a stale "N pending") and #5002 (rejecting a draft fact did
 * the same) — so the invalidation lives in the hook rather than at each caller.
 * A per-site opt-in is a thing to forget, and forgetting is silent: the pill
 * just keeps showing a number that was true a moment ago.
 *
 * Asserted at the HOOK, not through a page. The claim is "any admin mutation
 * invalidates it", and testing that through one component would only re-pin
 * that component. The reject path is named in a case of its own because it is
 * the one #5002 reported and the one no publish test covers.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AtlasProvider } from "@/ui/context";
import { queryKeys } from "@/ui/lib/query-keys";
import { useAdminMutation } from "../use-admin-mutation";

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

const realFetch = globalThis.fetch;

// The `_input` parameter is load-bearing for the cast, not decoration: a
// zero-arg function doesn't overlap `typeof fetch` enough for TS to accept it.
function stubOk(): void {
  globalThis.fetch = (async (_input: RequestInfo | URL) =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof globalThis.fetch;
}

/** 500 with a JSON body, so the hook takes its failure path rather than throwing on parse. */
function stubFail(): void {
  globalThis.fetch = (async (_input: RequestInfo | URL) =>
    new Response(JSON.stringify({ error: "boom" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })) as typeof globalThis.fetch;
}

function setup(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Seed the key a real session would hold, so "invalidated" is a state change
  // rather than the vacuous truth about a key that was never populated.
  queryClient.setQueryData(queryKeys.modeStatus.forApi(API_URL), {
    draftCounts: { brainFacts: 1 },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <AtlasProvider config={testConfig}>{children}</AtlasProvider>
    </QueryClientProvider>
  );
  const { result } = renderHook(() => useAdminMutation({ path, method: "POST" }), { wrapper });
  return { queryClient, result };
}

function invalidated(qc: QueryClient): boolean {
  return qc.getQueryState(queryKeys.modeStatus.forApi(API_URL))?.isInvalidated === true;
}

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

describe("useAdminMutation refreshes the draft-count query", () => {
  test("the reject/retract path invalidates mode-status (#5002)", async () => {
    stubOk();
    const { queryClient, result } = setup("/api/v1/admin/brain-facts/abc/retract");
    expect(invalidated(queryClient)).toBe(false);

    await act(async () => {
      await result.current.mutate({});
    });

    await waitFor(() => expect(invalidated(queryClient)).toBe(true));
  });

  test("a FAILED mutation does not invalidate", async () => {
    // The counterpart. Without it, an implementation that invalidated
    // unconditionally — on error as readily as on success — would pass the
    // case above while telling the pill to refetch after a write that
    // changed nothing.
    stubFail();
    const { queryClient, result } = setup("/api/v1/admin/brain-facts/abc/retract");

    await act(async () => {
      const res = await result.current.mutate({});
      expect(res.ok).toBe(false);
    });

    expect(invalidated(queryClient)).toBe(false);
  });
});
