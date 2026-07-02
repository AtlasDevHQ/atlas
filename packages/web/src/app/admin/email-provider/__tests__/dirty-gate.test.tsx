import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AtlasProvider, type AtlasAuthClient } from "@/ui/context";
import EmailProviderPage from "../page";

/**
 * Regression guard for #4204: the email-provider save had no dirty gate —
 * Save always fired, even on an untouched form. The page now rides
 * `useConfigForm`, whose `dirty` compare derives from `toForm`, so:
 *
 *  - with a saved override and no edits, "Replace" is disabled and no PUT
 *    can fire;
 *  - with no override, "Save" is disabled until the admin types something;
 *  - any edit (credentials or from-address) enables the button.
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

const NO_OVERRIDE_CONFIG = {
  config: {
    baseline: { provider: "resend", fromAddress: "noreply@atlas.dev" },
    override: null,
  },
};

const OVERRIDE_CONFIG = {
  config: {
    baseline: { provider: "resend", fromAddress: "noreply@atlas.dev" },
    override: {
      provider: "resend",
      fromAddress: "sender@acme.com",
      secretLabel: "API key",
      secretMasked: "re_****abcd",
      hints: {},
      installedAt: "2026-06-01T00:00:00.000Z",
    },
  },
};

/**
 * Route GET to the given config. Any write throws — these tests assert the
 * dirty gate keeps writes from firing, so a PUT reaching the mock is itself
 * the failure.
 */
function mockReadOnlyApi(config: unknown) {
  globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (method === "GET" && url.endsWith("/api/v1/admin/email-provider")) {
      return Promise.resolve(jsonResponse(config));
    }
    throw new Error(`unexpected ${method} ${url}`);
  }) as unknown as typeof fetch;
}

function findButton(label: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label,
  );
  expect(button).toBeDefined();
  return button as HTMLButtonElement;
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

describe("/admin/email-provider dirty gate (#4204)", () => {
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

  test("with a saved override and no edits, Replace is disabled (no save can fire)", async () => {
    mockReadOnlyApi(OVERRIDE_CONFIG);

    render(<EmailProviderPage />, { wrapper: Wrapper });

    const replaceButton = await waitFor(() => findButton("Replace"));
    expect(replaceButton.disabled).toBe(true);

    // Clicking the unchanged form must not fire a PUT — the read-only mock
    // throws on any write, so reaching it would fail the test loudly.
    await act(async () => {
      fireEvent.click(replaceButton);
    });
    expect(findButton("Replace").disabled).toBe(true);
  });

  test("editing the from-address on a saved override enables Replace", async () => {
    mockReadOnlyApi(OVERRIDE_CONFIG);

    render(<EmailProviderPage />, { wrapper: Wrapper });

    await waitFor(() => findButton("Replace"));
    await act(async () => {
      typeIntoInput("fromAddress", "new-sender@acme.com");
    });
    expect(findButton("Replace").disabled).toBe(false);
  });

  test("with no override, Save is disabled until a credential is typed", async () => {
    mockReadOnlyApi(NO_OVERRIDE_CONFIG);

    render(<EmailProviderPage />, { wrapper: Wrapper });

    await openEditor();
    expect(findButton("Save").disabled).toBe(true);

    await act(async () => {
      typeIntoInput("resendApiKey", "re_freshkey");
    });
    expect(findButton("Save").disabled).toBe(false);
  });
});
