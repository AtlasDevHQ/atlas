import {
  describe,
  expect,
  test,
  beforeAll,
  afterAll,
  afterEach,
  mock,
} from "bun:test";
import { render, cleanup, act } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  notifyManager,
} from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { StarterPrompt } from "@useatlas/types/starter-prompt";
import { NotebookEmptyState } from "../components/notebook/notebook-empty-state";

/**
 * Cross-surface cache contract for starter prompts.
 *
 * AtlasChat's pin/unpin handlers mutate the TanStack cache directly via
 * `queryClient.setQueryData(["atlas", "starter-prompts", apiUrl], ...)`
 * instead of local component state. The notebook empty state reads the
 * same queryKey via `useStarterPromptsQuery`, so pins made in chat must
 * surface on the notebook without a network refetch.
 *
 * We simulate the pin-side mutation here (no need to mount AtlasChat's
 * full dependency tree) and assert the notebook surface reflects the
 * new data while fetch is only called once.
 *
 * Determinism note (#3455): TanStack Query schedules observer notifications
 * on a `setTimeout(0)` macrotask by default (`notifyManager`'s
 * `systemSetTimeoutZero`). Under the parallel isolated runner the box is
 * CPU-saturated and that macrotask can be starved well past the 5s test
 * timeout, so a `setQueryData` mutation never reaches the reader and the
 * assertion hangs. We force synchronous notification for the duration of
 * this file so cache mutations propagate inside `act()`, independent of
 * event-loop scheduling and machine load. This is a test-only knob — it
 * does not change the product code path.
 */

const QUERY_KEY = ["atlas", "starter-prompts", ""] as const;

function buildWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe("starter prompts cache contract", () => {
  beforeAll(() => {
    notifyManager.setScheduler((cb) => cb());
  });

  afterAll(() => {
    // Restore TanStack's documented default (systemSetTimeoutZero).
    notifyManager.setScheduler((cb) => setTimeout(cb, 0));
  });

  afterEach(() => {
    cleanup();
    mock.restore();
  });

  test("setQueryData on the shared key surfaces in useStarterPromptsQuery readers without refetch", async () => {
    const fetchCalls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetchCalls.push(typeof input === "string" ? input : input.toString());
      return new Response(
        JSON.stringify({
          prompts: [
            { id: "library:base", text: "Library row", provenance: "library" },
          ],
          total: 1,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });

      const { findByText, queryByText } = render(
        <NotebookEmptyState
          apiUrl=""
          isCrossOrigin={false}
          getHeaders={() => ({})}
          onSelectPrompt={() => {}}
          enabled
        />,
        { wrapper: buildWrapper(client) },
      );

      // Initial fetch populates the cache with the library row.
      expect(await findByText("Library row")).toBeTruthy();
      expect(fetchCalls.length).toBe(1);

      // Simulate what AtlasChat.handlePin does after a successful POST —
      // prepend the new favorite via setQueryData on the shared key. With the
      // synchronous notifyManager scheduler the observer flush happens inside
      // act(), so the reader updates deterministically before we assert.
      await act(async () => {
        client.setQueryData<StarterPrompt[]>(QUERY_KEY, (prev) => {
          const base = prev ?? [];
          return [
            { id: "favorite:new", text: "Freshly pinned", provenance: "favorite" },
            ...base,
          ];
        });
      });

      // Reader reflects the mutation; the pre-existing row is untouched.
      expect(queryByText("Freshly pinned")).toBeTruthy();
      expect(queryByText("Library row")).toBeTruthy();

      // No additional fetch — proves the reader pulled from cache, not the
      // network. A regression that drops setQueryData in favor of
      // `invalidate + refetch` would bump this count.
      expect(fetchCalls.length).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("unpin mutation via setQueryData removes the row from other surfaces", async () => {
    const fetchCalls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetchCalls.push(typeof input === "string" ? input : input.toString());
      return new Response(
        JSON.stringify({
          prompts: [
            { id: "favorite:existing", text: "Already pinned", provenance: "favorite" },
            { id: "library:base", text: "Library row", provenance: "library" },
          ],
          total: 2,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });

      const { findByText, queryByText } = render(
        <NotebookEmptyState
          apiUrl=""
          isCrossOrigin={false}
          getHeaders={() => ({})}
          onSelectPrompt={() => {}}
          enabled
        />,
        { wrapper: buildWrapper(client) },
      );

      expect(await findByText("Already pinned")).toBeTruthy();

      // Simulate AtlasChat.handleUnpin — drop the row by id. The synchronous
      // scheduler flushes the observer inside act(), so the removal is
      // observable immediately after.
      await act(async () => {
        client.setQueryData<StarterPrompt[]>(QUERY_KEY, (prev) =>
          (prev ?? []).filter((p) => p.id !== "favorite:existing"),
        );
      });

      expect(queryByText("Already pinned")).toBeNull();
      expect(queryByText("Library row")).toBeTruthy();
      expect(fetchCalls.length).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
