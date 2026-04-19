import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AtlasProvider, type AtlasAuthClient } from "@/ui/context";
import EmailProviderPage from "../page";

/**
 * Regression guard for the three-way error chain at `email-provider/page.tsx`:
 *
 *   const structuredError = combineMutationErrors([saveError, deleteError, testError]);
 *   const mutationError = structuredError ? friendlyError(structuredError) : formError;
 *
 * Three mutation errors fall through to a local `formError` when none failed.
 * A regression — swapping the ternary arms, dropping the `formError` fallback,
 * or rewiring the composition — would silently lose either the server-side
 * requestId-bearing copy or the client-side validation hint. Both paths hit
 * the same `ErrorBanner`, so only a rendered-DOM test catches the swap.
 */

const stubAuthClient: AtlasAuthClient = {
  signIn: { email: async () => ({}) },
  signUp: { email: async () => ({}) },
  signOut: async () => {},
  useSession: () => ({ data: null }),
};

let testQueryClient: QueryClient;

function Wrapper({ children }: { children: ReactNode }) {
  return createElement(
    QueryClientProvider,
    { client: testQueryClient },
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

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Baseline payload the page expects from the initial GET — empty override so
 * the editor renders fresh and the "+ Add credentials" affordance is wired up.
 */
const BASELINE_CONFIG = {
  config: {
    baseline: { provider: "resend", fromAddress: "noreply@atlas.dev" },
    override: null,
  },
};

/**
 * Mock fetch with:
 *   - GET `/email-provider`         → 200 baseline config
 *   - PUT `/email-provider`         → caller-provided save handler
 *   - POST `/email-provider/test`   → 200 (not exercised by these tests)
 */
function mockEmailProviderApi(
  saveHandler: () => Response,
) {
  globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET") return Promise.resolve(jsonResponse(BASELINE_CONFIG));
    if (method === "PUT") return Promise.resolve(saveHandler());
    return Promise.resolve(jsonResponse({ success: true, message: "ok" }));
  }) as unknown as typeof fetch;
}

async function openEditor() {
  const addButton = await waitFor(() => {
    const b = Array.from(document.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("+ Add credentials"),
    );
    if (!b) throw new Error("+ Add credentials button not found");
    return b;
  });
  await act(async () => {
    fireEvent.click(addButton);
  });
}

function typeIntoInput(id: string, value: string) {
  const el = document.querySelector<HTMLInputElement>(`input#${id}`);
  expect(el).not.toBeNull();
  fireEvent.change(el!, { target: { value } });
}

function clickButton(label: string) {
  const button = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label,
  );
  expect(button).toBeDefined();
  fireEvent.click(button!);
}

describe("/admin/email-provider mutation error chain", () => {
  beforeEach(() => {
    testQueryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { retry: false },
      },
    });
  });

  afterEach(() => {
    testQueryClient.clear();
    cleanup();
    globalThis.fetch = originalFetch;
  });

  test("a failing save mutation surfaces friendlyError copy with requestId", async () => {
    // Valid client input reaches the wire; server rejects it. The banner must
    // render the translated, requestId-bearing copy — not the raw `formError`
    // string or the unfriendly `message` from the body.
    mockEmailProviderApi(() =>
      jsonResponse(
        { message: "Upstream provider rejected key", requestId: "req-email-42" },
        500,
      ),
    );

    render(<EmailProviderPage />, { wrapper: Wrapper });

    await openEditor();
    typeIntoInput("resendApiKey", "re_validkey");
    typeIntoInput("fromAddress", "sender@acme.com");
    await act(async () => {
      clickButton("Save");
    });

    const banner = await waitFor(() => {
      const el = document.querySelector('[role="alert"]');
      if (!el) throw new Error("alert not found");
      return el;
    });
    // Preserves the server's body message AND the requestId — both are what
    // `friendlyError` produces for a 500. A swap to a flattened or
    // requestId-less copy would drop one or both halves.
    expect(banner.textContent).toContain("Upstream provider rejected key");
    expect(banner.textContent).toContain("req-email-42");
  });

  test("client validation error with no mutation in flight surfaces formError fallback", async () => {
    // Server is never called — empty API key short-circuits inside `handleSave`
    // via `buildProviderConfig`, setting `formError`. The banner copy is the
    // raw validation string, which *only* reaches the DOM if the ternary's
    // false-arm (`formError`) is intact.
    const saveHandler = mock(() => jsonResponse({ success: true }));
    mockEmailProviderApi(saveHandler);

    render(<EmailProviderPage />, { wrapper: Wrapper });

    await openEditor();
    // Intentionally skip typing the API key — buildProviderConfig returns
    // `{ ok: false, error: "API key is required." }`.
    typeIntoInput("fromAddress", "sender@acme.com");
    await act(async () => {
      clickButton("Save");
    });

    const banner = await waitFor(() => {
      const el = document.querySelector('[role="alert"]');
      if (!el) throw new Error("alert not found");
      return el;
    });
    expect(banner.textContent).toContain("API key is required.");
    // No network call fired — the chain's false-arm is being exercised, not
    // a phantom mutation failure.
    expect(saveHandler).not.toHaveBeenCalled();
  });

  test("no errors → no banner renders", async () => {
    mockEmailProviderApi(() => jsonResponse({ success: true }));

    render(<EmailProviderPage />, { wrapper: Wrapper });

    // Wait for initial GET to settle so the editor affordance is mounted and
    // `formError` / mutation errors have had a chance to populate from any
    // stray render cycle.
    await waitFor(() => {
      expect(
        Array.from(document.querySelectorAll("button")).some((b) =>
          b.textContent?.includes("+ Add credentials"),
        ),
      ).toBe(true);
    });

    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  test("structured mutation error wins over a pre-existing formError", async () => {
    // Drives the full ternary — `formError` is set first by a client-side
    // failure, then a subsequent save triggers a server error. Once the
    // mutation fails, `structuredError` is truthy so the banner copy MUST
    // switch to the friendlyError arm even though `formError` was visible
    // moments earlier. Swapping the ternary would leave the stale form copy
    // in place and silently hide the server's requestId.
    let saveShouldFail = false;
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") return Promise.resolve(jsonResponse(BASELINE_CONFIG));
      if (method === "PUT") {
        if (saveShouldFail) {
          return Promise.resolve(
            jsonResponse(
              { message: "SMTP auth rejected", requestId: "req-win" },
              500,
            ),
          );
        }
        return Promise.resolve(jsonResponse({ success: true }));
      }
      return Promise.resolve(jsonResponse({ success: true }));
    }) as unknown as typeof fetch;

    render(<EmailProviderPage />, { wrapper: Wrapper });

    await openEditor();
    // Step 1 — client validation fires, formError renders.
    typeIntoInput("fromAddress", "sender@acme.com");
    await act(async () => {
      clickButton("Save");
    });
    await waitFor(() => {
      const el = document.querySelector('[role="alert"]');
      expect(el?.textContent).toContain("API key is required.");
    });

    // Step 2 — fix the validation error and drive a server failure. The
    // banner must now render the friendlyError copy (with requestId), not
    // the previous formError string.
    typeIntoInput("resendApiKey", "re_validkey");
    saveShouldFail = true;
    await act(async () => {
      clickButton("Save");
    });

    await waitFor(() => {
      const el = document.querySelector('[role="alert"]');
      expect(el?.textContent).toContain("SMTP auth rejected");
    });
    const banner = document.querySelector('[role="alert"]')!;
    expect(banner.textContent).toContain("req-win");
    expect(banner.textContent).not.toContain("API key is required.");
  });
});
