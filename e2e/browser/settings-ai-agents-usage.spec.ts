import { test, expect, type Page, type Route } from "@playwright/test";

/**
 * Settings → AI Agents — live MCP usage chip (#2216).
 *
 * Surfaces per-OAuth-client weighted-request usage so users see the
 * approaching quota before a 429 lands. Acceptance criteria from the
 * issue:
 *
 *   1. The chip is visible on every connected agent row.
 *   2. The chip refreshes within 10s while the page is foregrounded.
 *   3. The chip stops polling when the page is backgrounded — verified
 *      by the network observation: zero `/me/mcp-usage` hits during
 *      the hidden window.
 *
 * No `@llm` tag — no model calls, deterministic mocks.
 */

interface MockOAuthClient {
  clientId: string;
  clientName: string | null;
  redirectUris: string[];
  createdAt: string;
  updatedAt: string | null;
  disabled: boolean;
  type: string | null;
  lastUsedAt: string | null;
  tokenCount: number;
  tokenState: "active" | "reconnect_required" | "revoked";
  // Schema fields the page's Zod parse rejects without — required to
  // get the row to render at all. The defaults match what the API
  // returns for a brand-new DCR-issued client.
  rateLimitPerMinute: number | null;
  workspaceScope: "single" | "multi";
  grantedWorkspaceIds: string[];
}

interface MockUsageEntry {
  clientId: string;
  currentMinuteWeightedRequests: number;
  ceiling: number;
  percentUsed: number;
  resetAt: string;
}

function buildClientFixture(): MockOAuthClient[] {
  return [
    {
      clientId: "claude-desktop",
      clientName: "Claude Desktop",
      redirectUris: ["http://127.0.0.1:6274/callback"],
      createdAt: "2026-04-12T10:00:00.000Z",
      updatedAt: "2026-04-12T10:00:00.000Z",
      disabled: false,
      type: "public",
      lastUsedAt: "2026-05-01T15:30:00.000Z",
      tokenCount: 3,
      tokenState: "active",
      rateLimitPerMinute: null,
      workspaceScope: "single",
      grantedWorkspaceIds: [],
    },
  ];
}

interface UsageMockHandle {
  /** Number of GET /me/mcp-usage requests the page has issued so far. */
  count: number;
  /** Mutate to return this entry on the next refetch. */
  next: MockUsageEntry;
}

async function installMocks(
  page: Page,
  initialUsage: MockUsageEntry,
): Promise<UsageMockHandle> {
  const handle: UsageMockHandle = {
    count: 0,
    next: initialUsage,
  };

  const clients = buildClientFixture();

  // Clients list — shape matches the page's MeOAuthClientsResponseSchema.
  await page.route(
    /\/api\/v1\/me\/oauth-clients(?:\?[^/]*)?$/,
    async (route: Route) => {
      const req = route.request();
      if (req.method() !== "GET") {
        await route.abort("failed");
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ clients, deployMode: "saas" }),
      });
    },
  );

  // Live usage — counter lets the spec verify both refetch (foreground)
  // and the absence of refetch (background).
  await page.route(
    /\/api\/v1\/me\/mcp-usage(?:\?[^/]*)?$/,
    async (route: Route) => {
      const req = route.request();
      if (req.method() !== "GET") {
        await route.abort("failed");
        return;
      }
      handle.count += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ clients: [handle.next] }),
      });
    },
  );

  // Prompts preview also fires on the page — return an empty,
  // schema-valid payload so the preview block doesn't crash the page
  // and pollute the foreground assertions.
  await page.route(
    /\/api\/v1\/me\/mcp-prompts(?:\?[^/]*)?$/,
    async (route: Route) => {
      const req = route.request();
      if (req.method() !== "GET") {
        await route.abort("failed");
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          prompts: [],
          canonicalGate: {
            exposed: false,
            toggle: "auto",
            reason: "no-demo-signal",
          },
        }),
      });
    },
  );

  return handle;
}

function makeUsage(weighted: number, ceiling: number): MockUsageEntry {
  const pct = Math.min(100, Math.round((weighted / ceiling) * 100));
  return {
    clientId: "claude-desktop",
    currentMinuteWeightedRequests: weighted,
    ceiling,
    percentUsed: pct,
    resetAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

test.describe("Settings → AI Agents — live MCP usage chip", () => {
  test.describe.configure({ timeout: 45_000 });

  test("chip renders on every connected agent row", async ({ page }) => {
    await installMocks(page, makeUsage(12, 60));
    await page.goto("/settings/ai-agents");

    await expect(
      page.locator("h1", { hasText: "AI Agents" }),
    ).toBeVisible({ timeout: 15_000 });

    // The chip is a span with role=img + aria-label including the
    // percent context. Anchor on aria-label so a future style refactor
    // (gauge → progress bar, etc.) doesn't break the contract.
    const chip = page.getByRole("img", {
      name: /20% used \(12 of 60 weighted requests this minute\)/,
    });
    await expect(chip).toBeVisible({ timeout: 10_000 });
  });

  test("chip refetches within 10s while page is foregrounded", async ({ page }) => {
    const handle = await installMocks(page, makeUsage(0, 60));
    await page.goto("/settings/ai-agents");

    // Wait for the first foreground fetch to land.
    await expect
      .poll(() => handle.count, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(1);

    const before = handle.count;
    handle.next = makeUsage(45, 60); // 75% — neutral, just below soft-warn

    // The refetch interval is 10s. Allow a generous window for the
    // poller's internal scheduling + render to settle.
    await expect
      .poll(() => handle.count, { timeout: 20_000, intervals: [500, 1000, 2000] })
      .toBeGreaterThan(before);

    // The chip should re-render with the new value once the response
    // lands and TanStack Query invalidates.
    const updated = page.getByRole("img", {
      name: /75% used \(45 of 60 weighted requests this minute\)/,
    });
    await expect(updated).toBeVisible({ timeout: 5_000 });
  });

  test("polling stops while the page is backgrounded", async ({ page }) => {
    const handle = await installMocks(page, makeUsage(8, 60));
    await page.goto("/settings/ai-agents");

    // Wait for the first foreground fetch.
    await expect
      .poll(() => handle.count, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(1);

    const beforeHide = handle.count;

    // Switch to a hidden visibility state from inside the page so the
    // hook's `visibilitychange` listener fires. Playwright doesn't
    // expose tab-level visibility on a single-page test so we fake it
    // via Object.defineProperty + manual event dispatch — the
    // production hook reads `document.visibilityState` and listens
    // for `visibilitychange`, both of which the fake covers.
    // String form keeps the spec compiling under the repo's
    // `lib: ["esnext"]` tsconfig (no DOM types) — Playwright accepts a
    // raw expression and runs it in the page context, which has the
    // real Document + Event classes available. Other e2e specs use a
    // `(window as any).…` cast for the same reason.
    await page.evaluate(`(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    })()`);

    // Park for longer than one polling interval. A regression that
    // ignored the visibility gate would bump the counter at least once
    // during this window. We allow a short buffer beyond the 10s
    // interval so any in-flight tick has time to land.
    await page.waitForTimeout(12_000);

    expect(handle.count).toBe(beforeHide);

    // Restore visibility — the hook should refetch immediately on the
    // hidden → visible transition. This branch exists because waiting
    // out a full interval after restoring visibility would otherwise
    // make the test slow without proving the prompt-refetch contract.
    handle.next = makeUsage(20, 60);
    await page.evaluate(`(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    })()`);

    await expect
      .poll(() => handle.count, { timeout: 5_000 })
      .toBeGreaterThan(beforeHide);
  });
});
