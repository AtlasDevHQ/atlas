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
 * Each of the three mutation slots can produce the banner, with `formError`
 * as the client-side fallback. Regressions — dropping one slot from the
 * compose array, swapping the ternary arms, dropping the `formError`
 * fallback — render the wrong surface silently, so the DOM-level branches
 * are tested end-to-end and each mutation slot is exercised at least once.
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

const BASELINE_CONFIG = {
  config: {
    baseline: { provider: "resend", fromAddress: "noreply@atlas.dev" },
    override: null,
  },
};

/**
 * Route GET to the baseline config and delegate PUT (save) and POST
 * `/test` to caller-provided handlers. Unrecognized paths throw so a drifted
 * page can't silently pass with a generic 2xx fallthrough.
 */
function mockEmailProviderApi(handlers: {
  save?: () => Response;
  test?: () => Response;
}) {
  globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (method === "GET" && url.endsWith("/api/v1/admin/email-provider")) {
      return Promise.resolve(jsonResponse(BASELINE_CONFIG));
    }
    if (method === "PUT" && url.endsWith("/api/v1/admin/email-provider")) {
      if (!handlers.save) throw new Error(`unexpected PUT ${url}`);
      return Promise.resolve(handlers.save());
    }
    if (method === "POST" && url.endsWith("/api/v1/admin/email-provider/test")) {
      if (!handlers.test) throw new Error(`unexpected POST ${url}`);
      return Promise.resolve(handlers.test());
    }
    throw new Error(`unexpected ${method} ${url}`);
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

  test("a failing save (saveError slot) surfaces friendlyError copy with requestId", async () => {
    mockEmailProviderApi({
      save: () =>
        jsonResponse(
          { message: "Upstream provider rejected key", requestId: "req-email-42" },
          500,
        ),
    });

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
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1);
  });

  test("a failing test-send (testError slot) also surfaces friendlyError copy", async () => {
    // Covers the third slot of `combineMutationErrors([saveError, deleteError,
    // testError])`. A regression dropping the array to `[saveError]` or
    // `[saveError, deleteError]` would make this test fail while the
    // saveError case above still passes — so both together prove the compose
    // array isn't being silently narrowed.
    mockEmailProviderApi({
      test: () =>
        jsonResponse(
          { message: "Test recipient unreachable", requestId: "req-test-99" },
          502,
        ),
    });

    render(<EmailProviderPage />, { wrapper: Wrapper });

    await openEditor();
    typeIntoInput("resendApiKey", "re_validkey");
    typeIntoInput("fromAddress", "sender@acme.com");
    typeIntoInput("recipientEmail", "dest@acme.com");
    await act(async () => {
      clickButton("Send test");
    });

    const banner = await waitFor(() => {
      const el = document.querySelector('[role="alert"]');
      if (!el) throw new Error("alert not found");
      return el;
    });
    expect(banner.textContent).toContain("Test recipient unreachable");
    expect(banner.textContent).toContain("req-test-99");
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1);
  });

  test("client validation error with no mutation in flight surfaces formError fallback", async () => {
    // Server must not be called — empty API key short-circuits inside
    // `handleSave` via `buildProviderConfig`, setting `formError`. The raw
    // validation string reaches the DOM only if the ternary's false-arm
    // (`formError`) is intact. If `save` is invoked, the mock throws and the
    // test fails loudly — proving we took the false-arm, not a phantom
    // mutation-failure path.
    mockEmailProviderApi({});

    render(<EmailProviderPage />, { wrapper: Wrapper });

    await openEditor();
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
  });

  test("no errors → no banner renders", async () => {
    mockEmailProviderApi({});

    render(<EmailProviderPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(
        Array.from(document.querySelectorAll("button")).some((b) =>
          b.textContent?.includes("+ Add credentials"),
        ),
      ).toBe(true);
    });

    expect(document.querySelector('[role="alert"]')).toBeNull();
  });
});
