/**
 * Coverage for the signup region step (#3925).
 *
 * The step auto-skips to /signup/connect when no residency is configured, and
 * — the change under test — pairs a region-load *failure* with an in-place
 * Retry instead of dead-ending the user on a disabled Continue with only the
 * Back link. There is no e2e coverage for this page, so these unit tests pin
 * both the no-dead-end paths (auto-skip on empty, Retry on error).
 *
 * `mock.module(...)` stubs every named export of the modules it touches (per
 * repo rule). The signup shell + region grid are mocked to passthroughs so the
 * test exercises the page's load/retry logic, not their dep trees.
 */

import { describe, expect, test, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { render, fireEvent, waitFor, cleanup, act, screen } from "@testing-library/react";

// ── Mocks ───────────────────────────────────────────────────────────────

const routerReplaceMock = mock((_path: string) => {});
const routerPushMock = mock((_path: string) => {});
// Stable router reference across renders — the real next/navigation useRouter
// is referentially stable, which the page's `useCallback(..., [router])`
// relies on. A fresh object per call would churn the load effect.
const routerMock = { replace: routerReplaceMock, push: routerPushMock, back: () => {} };
mock.module("next/navigation", () => ({
  useRouter: () => routerMock,
}));

// `@/lib/api-url` is used unmocked: with NEXT_PUBLIC_ATLAS_API_URL empty in the
// test env, getApiUrl() → "" and isCrossOrigin() → false (so getApiBase() falls
// back to window.location.origin). No atlas_region cookie is set here, so the
// module's import-time restore is a no-op.
mock.module("@/ui/components/signup/signup-shell", () => ({
  SignupShell: ({ children, back }: { children: unknown; back?: { href: string } }) => (
    <div>
      {back ? <a href={back.href}>Back</a> : null}
      {children as never}
    </div>
  ),
}));

mock.module("@/ui/components/region-picker", () => ({
  RegionCardGrid: () => <div data-testid="region-grid" />,
  ComplianceBadge: () => null,
}));

const fetchMock = mock(async (_input: RequestInfo | URL): Promise<Response> =>
  new Response("not found", { status: 404 }),
);
const originalFetch = globalThis.fetch;
globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

import RegionPage from "./page";

function regionsFailure(): Response {
  return new Response("boom", { status: 500 });
}

function regionsUnconfigured(): Response {
  return new Response(
    JSON.stringify({ configured: false, defaultRegion: "", availableRegions: [] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function regionsConfigured(): Response {
  return new Response(
    JSON.stringify({
      configured: true,
      defaultRegion: "us",
      availableRegions: [{ id: "us", label: "United States", isDefault: true }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

beforeEach(() => {
  routerReplaceMock.mockReset();
  routerPushMock.mockReset();
  fetchMock.mockReset();
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

// ── Tests ───────────────────────────────────────────────────────────────

describe("RegionPage — load failure recovery (#3925)", () => {
  test("a regions load failure shows an error AND an in-place Retry (no dead end)", async () => {
    fetchMock.mockImplementation(async () => regionsFailure());
    render(<RegionPage />);

    await waitFor(() => {
      expect(screen.getByText(/unable to load region options/i)).toBeDefined();
    });
    // The fix: a Retry button, not just a disabled Continue + Back link.
    expect(screen.getByRole("button", { name: /^retry$/i })).toBeDefined();
  });

  test("clicking Retry re-fetches the region options", async () => {
    fetchMock.mockImplementation(async () => regionsFailure());
    render(<RegionPage />);

    const retry = await screen.findByRole("button", { name: /^retry$/i });
    // Don't assert the exact mount count — React StrictMode double-invokes the
    // mount effect. Capture the baseline, then assert the click adds a fetch.
    const callsBeforeRetry = fetchMock.mock.calls.length;

    await act(async () => {
      fireEvent.click(retry);
    });

    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBeforeRetry);
    });
  });

  test("a persistent load failure swaps in support copy + a Contact support link (#3934)", async () => {
    fetchMock.mockImplementation(async () => regionsFailure());
    render(<RegionPage />);

    // First failure: generic copy, Retry only, no support escape yet.
    const retry = await screen.findByRole("button", { name: /^retry$/i });
    expect(screen.queryByRole("link", { name: /contact support/i })).toBeNull();

    // Second failure (retry also fails) => persistent: copy + support path.
    await act(async () => {
      fireEvent.click(retry);
    });

    await waitFor(() => {
      expect(screen.getByText(/still unable to load region options/i)).toBeDefined();
    });
    const support = screen.getByRole("link", { name: /contact support/i });
    expect((support as HTMLAnchorElement).href).toContain("mailto:support@useatlas.dev");
  });

  test("a successful load after failures clears the persistent copy — no leak into later errors (#3945)", async () => {
    // Two failed /regions loads, then success — the persistent-outage copy must
    // not survive the successful load (loadAttempts resets), so a later
    // assign-region failure can't inherit the wrong message.
    let regionsCalls = 0;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).includes("/onboarding/regions")) {
        regionsCalls += 1;
        return regionsCalls <= 2 ? regionsFailure() : regionsConfigured();
      }
      return regionsFailure();
    });
    render(<RegionPage />);

    // Drive into the persistent state (initial load + one retry both fail).
    const retry = await screen.findByRole("button", { name: /^retry$/i });
    await act(async () => {
      fireEvent.click(retry);
    });
    await waitFor(() => {
      expect(screen.getByText(/still unable to load region options/i)).toBeDefined();
    });

    // Retry once more — this load succeeds; persistent copy + support link clear.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^retry$/i }));
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /continue with default region/i })).toBeDefined();
    });
    expect(screen.queryByText(/still unable to load region options/i)).toBeNull();
    expect(screen.queryByRole("link", { name: /contact support/i })).toBeNull();
  });
});

describe("RegionPage — auto-skip when no residency configured", () => {
  test("an unconfigured/empty response advances to /signup/connect (not a dead end)", async () => {
    fetchMock.mockImplementation(async () => regionsUnconfigured());
    render(<RegionPage />);

    await waitFor(() => {
      expect(routerReplaceMock).toHaveBeenCalledWith("/signup/connect");
    });
    // Auto-skip is the deliberate no-dead-end path for the empty case — no
    // error, no Retry button.
    expect(screen.queryByRole("button", { name: /^retry$/i })).toBeNull();
  });
});
