import { describe, expect, test, afterEach, mock } from "bun:test";
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { NotebookEmptyState } from "../components/notebook/notebook-empty-state";

function wrapper({ children }: { children: ReactNode }) {
  // Isolated client per test — retry:false so the 4xx throw test doesn't
  // wait out the default retry schedule.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("NotebookEmptyState", () => {
  afterEach(() => {
    cleanup();
    mock.restore();
  });

  test("renders starter prompts from the adaptive endpoint", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          prompts: [
            { id: "library:a", text: "Hello from the API", provenance: "library" },
          ],
          total: 1,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    try {
      const { findByText } = render(
        <NotebookEmptyState
          apiUrl=""
          isCrossOrigin={false}
          getHeaders={() => ({})}
          onSelectPrompt={() => {}}
          enabled
        />,
        { wrapper },
      );

      expect(await findByText("Hello from the API")).toBeTruthy();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("renders a retry affordance when the query throws (4xx)", async () => {
    let call = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      call++;
      return new Response(
        JSON.stringify({ error: "Forbidden", requestId: "req-xyz" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const { findByTestId, getByRole } = render(
        <NotebookEmptyState
          apiUrl=""
          isCrossOrigin={false}
          getHeaders={() => ({})}
          onSelectPrompt={() => {}}
          enabled
        />,
        { wrapper },
      );

      // The hook throws on 4xx so the user sees a retry path rather than
      // the cold-start CTA (which would mask the real failure).
      // Hook opts `retry: 1` with exponential backoff → allow ~5s for the
      // error state to settle after the retry.
      const errorEl = await findByTestId("starter-prompts-error", {}, { timeout: 5_000 });
      expect(errorEl.textContent).toContain("Couldn't load starter prompts.");

      const retryBtn = getByRole("button", { name: "Retry" });
      const before = call;
      fireEvent.click(retryBtn);
      await waitFor(() => {
        expect(call).toBeGreaterThan(before);
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
