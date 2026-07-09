import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AtlasProvider, type AtlasAuthClient } from "@/ui/context";
import BrandingPage from "../page";

/**
 * Behavior lock for the branding page's `useConfigForm` migration (#4204):
 *
 *  - the save is dirty-gated (disabled "Saved" on an unchanged form, enabled
 *    "Save changes" after an edit);
 *  - `toPayload` maps empty strings to null on the wire;
 *  - reset-to-defaults re-baselines the form to EMPTY via the refetched
 *    `{ branding: null }` — the old hand-rolled `form.reset(EMPTY)` call and
 *    reset-on-refetch effect are gone.
 */

const stubAuthClient: AtlasAuthClient = {
  signIn: { email: async () => ({}) },
  signUp: { email: async () => ({}) },
  signOut: async () => {},
  useSession: () => ({ data: null, isPending: false }),
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
        children,
      },
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

const SAVED_BRANDING = {
  id: "brand_1",
  orgId: "org_1",
  logoUrl: null,
  logoText: "Acme Corp",
  primaryColor: null,
  faviconUrl: null,
  hideAtlasBranding: false,
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
};

/**
 * Route GET to a mutable branding value; capture PUT bodies; let DELETE flip
 * the GET to `{ branding: null }`. Unrecognized traffic throws loudly.
 */
function mockBrandingApi(initial: unknown) {
  const state = { branding: initial, putBodies: [] as unknown[] };
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (!url.endsWith("/api/v1/admin/branding")) {
      throw new Error(`unexpected ${method} ${url}`);
    }
    if (method === "GET") {
      return jsonResponse({ branding: state.branding });
    }
    if (method === "PUT") {
      state.putBodies.push(JSON.parse(String(init?.body)));
      return jsonResponse({ branding: state.branding });
    }
    if (method === "DELETE") {
      state.branding = null;
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected ${method} ${url}`);
  }) as unknown as typeof fetch;
  return state;
}

function findButton(label: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label,
  );
  expect(button).toBeDefined();
  return button as HTMLButtonElement;
}

async function waitForButton(label: string): Promise<HTMLButtonElement> {
  return waitFor(() => findButton(label));
}

describe("/admin/branding useConfigForm loop (#4204)", () => {
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

  test("save is dirty-gated: disabled on an unchanged form, enabled after an edit", async () => {
    mockBrandingApi(SAVED_BRANDING);
    render(<BrandingPage />, { wrapper: Wrapper });

    const saveButton = await waitForButton("Saved");
    expect(saveButton.disabled).toBe(true);

    const toggle = document.querySelector<HTMLButtonElement>(
      'button[role="switch"]',
    );
    expect(toggle).not.toBeNull();
    await act(async () => {
      fireEvent.click(toggle!);
    });

    expect(findButton("Save changes").disabled).toBe(false);
  });

  test("toPayload maps empty strings to null on the wire", async () => {
    const state = mockBrandingApi(SAVED_BRANDING);
    render(<BrandingPage />, { wrapper: Wrapper });

    await waitForButton("Saved");
    // Expand the Logo text row (pre-filled "Acme Corp") and clear it.
    await act(async () => {
      fireEvent.click(findButton("Edit"));
    });
    const input = document.querySelector<HTMLInputElement>(
      "input#branding-logo-text",
    );
    expect(input).not.toBeNull();
    await act(async () => {
      fireEvent.change(input!, { target: { value: "" } });
    });
    await act(async () => {
      fireEvent.click(findButton("Save changes"));
    });

    await waitFor(() => {
      expect(state.putBodies).toHaveLength(1);
    });
    expect(state.putBodies[0]).toEqual({
      logoUrl: null,
      logoText: null,
      primaryColor: null,
      faviconUrl: null,
      hideAtlasBranding: false,
    });
  });

  test("reset-to-defaults re-baselines the form to EMPTY from the refetched null", async () => {
    mockBrandingApi(SAVED_BRANDING);
    const { getByText, queryByText } = render(<BrandingPage />, {
      wrapper: Wrapper,
    });

    const resetButton = await waitForButton("Reset to defaults");
    getByText("1 of 5 customized");

    await act(async () => {
      fireEvent.click(resetButton);
    });

    await waitFor(() => {
      getByText("Using Atlas defaults");
    });
    // The reset affordance disappears with the branding row, and the form is
    // back to a clean (non-dirty) baseline.
    expect(queryByText("Reset to defaults")).toBeNull();
    expect(findButton("Saved").disabled).toBe(true);
  });
});
