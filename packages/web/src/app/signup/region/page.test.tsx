/**
 * Coverage for the signup region step (#3925, #3972).
 *
 * Under ADR-0024 §4 the region is chosen BEFORE account creation: selecting a
 * region repoints the browser at the regional API (`applyRegionSignal`) and
 * hard-navigates to /signup/account (so the Better-Auth client rebuilds against
 * the regional base) — it no longer POSTs the auth-gated /assign-region. When
 * no residency is configured it auto-skips straight to /signup/account.
 *
 * The earlier #3925/#3934 change pairs a region-load *failure* with an in-place
 * Retry instead of dead-ending the user. There is no e2e coverage for this
 * page, so these unit tests pin both the no-dead-end paths and the new pre-auth
 * region-selection contract.
 *
 * `mock.module(...)` stubs every named export of the modules it touches (per
 * repo rule). The signup shell + region grid are mocked to passthroughs so the
 * test exercises the page's load/retry/select logic, not their dep trees.
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

// `@/lib/api-url` — getApiUrl()/isCrossOrigin() keep getApiBase() on the
// same-origin fallback; applyRegionSignal is spied so we can assert the region
// step repoints the browser (and can simulate a rejected base). Mock EVERY
// named value export (repo rule: partial mocks SyntaxError other files).
const applyRegionSignalMock = mock((_region: string, _apiUrl: string) => true);
mock.module("@/lib/api-url", () => ({
  getApiUrl: () => "",
  isCrossOrigin: () => false,
  applyRegionSignal: applyRegionSignalMock,
  getActiveRegion: () => null,
  clearRegionSignal: () => {},
  initRegionFromCookie: () => null,
  secureCookieAttr: () => "",
  REGION_COOKIE: "atlas_region",
  _resetApiUrl: () => {},
}));

// The region→account transition is a HARD nav (rebuilds the regional auth
// client). Mock the one centralized hard-nav helper so we can assert the target.
const navigatePostAuthMock = mock((_path: string) => {});
mock.module("@/lib/auth/post-auth-nav", () => ({
  navigatePostAuth: navigatePostAuthMock,
}));

mock.module("@/ui/components/signup/signup-shell", () => ({
  SignupShell: ({ children, back }: { children: unknown; back?: { href: string } }) => (
    <div>
      {back ? <a href={back.href}>Back</a> : null}
      {children as never}
    </div>
  ),
}));

mock.module("@/ui/components/region-picker", () => ({
  // Interactive passthrough: render a select button per region so a test can
  // pick a NON-default region (the page preselects only the default).
  RegionCardGrid: ({
    regions,
    onSelect,
  }: {
    regions: { id: string }[];
    onSelect: (id: string) => void;
  }) => (
    <div data-testid="region-grid">
      {regions.map((r) => (
        <button key={r.id} type="button" onClick={() => onSelect(r.id)}>
          {`select-${r.id}`}
        </button>
      ))}
    </div>
  ),
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
      // apiUrl rides along (ADR-0024 §4) so the page can repoint the browser.
      availableRegions: [{ id: "us", label: "United States", isDefault: true, apiUrl: "https://api.useatlas.dev" }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

beforeEach(() => {
  routerReplaceMock.mockReset();
  routerPushMock.mockReset();
  fetchMock.mockReset();
  applyRegionSignalMock.mockReset();
  applyRegionSignalMock.mockImplementation(() => true);
  navigatePostAuthMock.mockReset();
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
  test("an unconfigured/empty response advances to /signup/account (not a dead end)", async () => {
    fetchMock.mockImplementation(async () => regionsUnconfigured());
    render(<RegionPage />);

    await waitFor(() => {
      // ADR-0024 §4: with no residency there's one API base, so skip straight to
      // account creation on it (was /signup/connect in the pre-reorder flow).
      expect(routerReplaceMock).toHaveBeenCalledWith("/signup/account");
    });
    // Auto-skip is the deliberate no-dead-end path for the empty case — no
    // error, no Retry button.
    expect(screen.queryByRole("button", { name: /^retry$/i })).toBeNull();
  });
});

describe("RegionPage — region selection repoints pre-auth (ADR-0024 §4, #3972)", () => {
  test("Continue applies the region signal then hard-navigates to /signup/account", async () => {
    fetchMock.mockImplementation(async () => regionsConfigured());
    render(<RegionPage />);

    // The default region ("us") is preselected on load, enabling Continue.
    const cont = await screen.findByRole("button", { name: /continue with default region/i });
    await act(async () => {
      fireEvent.click(cont);
    });

    await waitFor(() => {
      expect(applyRegionSignalMock).toHaveBeenCalledWith("us", "https://api.useatlas.dev");
    });
    // Hard nav (rebuilds the regional auth client) to the account step.
    expect(navigatePostAuthMock).toHaveBeenCalledWith("/signup/account");
  });

  test("Continue does NOT POST the auth-gated /assign-region (region is pre-auth now)", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).includes("/onboarding/regions")) return regionsConfigured();
      return regionsFailure();
    });
    render(<RegionPage />);

    const cont = await screen.findByRole("button", { name: /continue with default region/i });
    await act(async () => {
      fireEvent.click(cont);
    });
    await waitFor(() => expect(navigatePostAuthMock).toHaveBeenCalled());

    const assignCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes("assign-region"),
    );
    expect(assignCalls.length).toBe(0);
  });

  test("a configured region with no apiUrl proceeds without repointing (single-region deploy)", async () => {
    // A region config without apiUrl means one API base — nothing to repoint —
    // so the page must NOT call applyRegionSignal but still advance to account.
    fetchMock.mockImplementation(async () =>
      new Response(
        JSON.stringify({
          configured: true,
          defaultRegion: "local",
          availableRegions: [{ id: "local", label: "Local", isDefault: true }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    render(<RegionPage />);

    const cont = await screen.findByRole("button", { name: /continue with default region/i });
    await act(async () => {
      fireEvent.click(cont);
    });

    await waitFor(() => expect(navigatePostAuthMock).toHaveBeenCalledWith("/signup/account"));
    expect(applyRegionSignalMock).not.toHaveBeenCalled();
  });

  test("refuses a NON-default region missing apiUrl instead of silently using the default base", async () => {
    // A selectable non-default region with no apiUrl is a misconfig; proceeding
    // would create the account in the default (US) region — the silent dead-end
    // #3967/#3971 kill. The page must error and not navigate.
    fetchMock.mockImplementation(async () =>
      new Response(
        JSON.stringify({
          configured: true,
          defaultRegion: "us",
          availableRegions: [
            { id: "us", label: "United States", isDefault: true, apiUrl: "https://api.useatlas.dev" },
            { id: "eu", label: "Europe", isDefault: false }, // misconfig: no apiUrl
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    render(<RegionPage />);

    // Pick the misconfigured non-default region, then Continue.
    const euBtn = await screen.findByRole("button", { name: /select-eu/i });
    await act(async () => {
      fireEvent.click(euBtn);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    });

    await waitFor(() => {
      expect(screen.getByText(/isn.t fully configured for signup/i)).toBeDefined();
    });
    expect(applyRegionSignalMock).not.toHaveBeenCalled();
    expect(navigatePostAuthMock).not.toHaveBeenCalled();
  });

  test("a rejected region signal surfaces an error and does not navigate", async () => {
    // applyRegionSignal returns false for a non-credential-safe base — the page
    // must not hard-navigate (which would create the account in the US region).
    applyRegionSignalMock.mockImplementation(() => false);
    fetchMock.mockImplementation(async () => regionsConfigured());
    render(<RegionPage />);

    const cont = await screen.findByRole("button", { name: /continue with default region/i });
    await act(async () => {
      fireEvent.click(cont);
    });

    await waitFor(() => {
      expect(screen.getByText(/couldn.t route you to the selected region/i)).toBeDefined();
    });
    expect(navigatePostAuthMock).not.toHaveBeenCalled();
  });
});
