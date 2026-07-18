import { afterEach, describe, expect, mock, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import type { FetchResult } from "../share-result";
import type { SharedDashboard } from "../types";

// next/link needs no router for a plain anchor render — stub it to the bare <a>.
void mock.module("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement("a", { href }, children),
}));
// SharedTile mounts a dynamic chart + useDarkMode at import; stub them so the
// view renders in the test DOM without pulling recharts (same as view.test.tsx).
void mock.module("@/ui/components/chart/result-chart", () => ({
  ResultChart: () => <div data-testid="result-chart">chart</div>,
}));
void mock.module("next/dynamic", () => ({
  default: () => () => <div data-testid="result-chart">chart</div>,
}));
void mock.module("@/ui/hooks/use-dark-mode", () => ({ useDarkMode: () => false }));

// Drive the client resolution from a module-level mutable. Factory stays sync
// (async mock.module factories deadlock under bun:test) and mocks ALL exports.
let mockResolve: () => Promise<FetchResult> = () =>
  Promise.resolve({ ok: false, reason: "login-required" });
function setResult(result: FetchResult) {
  mockResolve = () => Promise.resolve(result);
}
void mock.module("../org-share-client", () => ({
  resolveOrgShareClient: () => mockResolve(),
  hashShareTokenClient: async () => "deadbeefdeadbeef",
}));

import { OrgShareResolver } from "../org-share-resolver";

const TOKEN = "abc123def456ghi789jkl";

function dashboard(over: Partial<SharedDashboard> = {}): SharedDashboard {
  return {
    title: "Quarterly Revenue",
    description: null,
    shareMode: "org",
    cards: [],
    parameterSummary: [],
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-02T00:00:00.000Z",
    lastRefreshAt: null,
    ...over,
  };
}

// #4718 — the client-side org-share resolution branch, at the component seam:
// the resolver must render the SAME success/error surfaces the SSR path does,
// with the #4690 login/membership split now driven by the viewer's real session.
describe("OrgShareResolver (#4718)", () => {
  afterEach(cleanup);

  test("success: renders the shared dashboard view for an authenticated org member", async () => {
    setResult({ ok: true, data: dashboard() });
    render(<OrgShareResolver token={TOKEN} />);
    expect(await screen.findByText("Quarterly Revenue")).toBeDefined();
  });

  test("login-required: renders the auth wall with the login redirect back to the share", async () => {
    setResult({ ok: false, reason: "login-required" });
    render(<OrgShareResolver token={TOKEN} />);
    const login = await screen.findByText("Log in");
    expect(login.closest("a")?.getAttribute("href")).toBe(
      `/login?redirect=${encodeURIComponent(`/shared/dashboard/${TOKEN}`)}`,
    );
  });

  test("membership-required: explains the org requirement and NEVER offers a login CTA", async () => {
    setResult({ ok: false, reason: "membership-required" });
    render(<OrgShareResolver token={TOKEN} />);
    expect(
      await screen.findByText(/don’t have access to this dashboard/i),
    ).toBeDefined();
    const loginHrefs = screen
      .queryAllByRole("link")
      .map((a) => a.getAttribute("href") ?? "")
      .filter((h) => h.startsWith("/login"));
    expect(loginHrefs).toEqual([]);
  });

  test("embed variant renders the navigation-free embed error surface", async () => {
    setResult({ ok: false, reason: "membership-required" });
    render(<OrgShareResolver token={TOKEN} variant="embed" />);
    expect(
      await screen.findByText(/organization you’re not a member of/i),
    ).toBeDefined();
    // Navigation-free: no login/home/retry links inside a partner's iframe —
    // only the external "Powered by Atlas" attribution anchor remains.
    const internalLinks = screen
      .queryAllByRole("link")
      .map((a) => a.getAttribute("href") ?? "")
      .filter((h) => !h.startsWith("https://www.useatlas.dev"));
    expect(internalLinks).toEqual([]);
  });

  test("shows an accessible resolving state while the client fetch is in flight", () => {
    // Never-resolving promise pins the loading state.
    mockResolve = () => new Promise(() => {});
    render(<OrgShareResolver token={TOKEN} />);
    expect(screen.getByRole("status")).toBeDefined();
  });
});
