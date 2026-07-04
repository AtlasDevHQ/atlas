/**
 * Dashboard — per-tile status, the tile is the unit of trust (#4321) @llm
 *
 * A partially-failed parameter render must never silently revert the failed
 * tiles to their old unfiltered numbers. This spec drives a real board through a
 * partial failure and asserts each tile carries its OWN status ON the tile:
 *
 *   - a card whose render SUCCEEDS → `fresh` (shows the new filtered rows),
 *   - a card whose render FAILS but has cached data → `stale`: it KEEPS its old
 *     data (never blanked, never silently swapped) + a color-shifted "Stale"
 *     caption + a one-click retry,
 *   - a card whose render FAILS with no cache → `errored`, visually distinct
 *     from `stale`,
 *   - NO page-level "N cards couldn't be updated" banner — the board reads tile
 *     by tile.
 *
 * The partial failure is forced deterministically by mocking the per-card
 * `/render` endpoint (500 for the failing cards, 200 for the healthy one) — the
 * same route-interception convention the sibling dashboard specs use. Clicking
 * Retry re-renders just that tile; the mock then succeeds and it flips to fresh.
 *
 * @llm tag — same suite segmentation as the sibling dashboard specs.
 */
import { test, expect, type Page, type Route } from "@playwright/test";

const DASH_ID = "44444444-3210-4321-8765-432143214321";
const OLD_AT = "2026-05-01T09:00:00.000Z";

/** A dashboard with one healthy card, one that will fail-with-cache (→ stale),
 *  and one that will fail-with-no-cache (→ errored). One `region` parameter. */
function dashboard() {
  const card = (id: string, title: string, cached: boolean) => ({
    id,
    dashboardId: DASH_ID,
    position: 0,
    title,
    kind: "chart" as const,
    sql: "SELECT stage, amount FROM deals WHERE region = :region",
    chartConfig: { type: "table" as const, categoryColumn: "stage", valueColumns: ["amount"] },
    content: null,
    annotations: [],
    cachedColumns: cached ? ["stage", "amount"] : null,
    cachedRows: cached ? [{ stage: "Discovery", amount: 1240000 }] : null,
    cachedAt: cached ? OLD_AT : null,
    connectionGroupId: null,
    layout: null,
    createdAt: OLD_AT,
    updatedAt: OLD_AT,
  });
  return {
    id: DASH_ID,
    orgId: "org-1",
    ownerId: "u1",
    title: "Trust board",
    description: null,
    shareToken: null,
    shareExpiresAt: null,
    shareMode: "public" as const,
    refreshSchedule: null,
    lastRefreshAt: null,
    nextRefreshAt: null,
    parameters: [{ key: "region", type: "text" as const, default: null, label: "Region" }],
    createdAt: OLD_AT,
    updatedAt: OLD_AT,
    cards: [card("card-ok", "Healthy tile", true), card("card-stale", "Stale tile", true), card("card-err", "Errored tile", false)],
  };
}

interface MockState {
  /** Card ids whose /render should currently FAIL (500). Retry removes an id. */
  failing: Set<string>;
  renderCalls: Record<string, number>;
}

async function installMocks(page: Page, state: MockState): Promise<void> {
  await page.route(`**/api/v1/dashboards/${DASH_ID}`, async (route: Route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(dashboard()) });
  });
  await page.route(`**/api/v1/dashboards/${DASH_ID}/draft/status`, async (route: Route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ hasDraft: false }) });
  });
  await page.route(`**/api/v1/dashboards/${DASH_ID}/stage`, async (route: Route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ stages: [] }) });
  });
  await page.route(`**/api/v1/dashboards/${DASH_ID}/sessions`, async (route: Route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sessions: [] }) });
  });
  await page.route("**/api/v1/dashboards", async (route: Route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ dashboards: [{ id: DASH_ID, title: "Trust board", cardCount: 3, updatedAt: OLD_AT }], total: 1 }),
    });
  });
  // Per-card render: 500 for the failing set, 200 (fresh rows) otherwise.
  await page.route(`**/api/v1/dashboards/${DASH_ID}/cards/*/render*`, async (route: Route) => {
    const match = /\/cards\/([^/]+)\/render/.exec(route.request().url());
    const cardId = match ? match[1] : "";
    state.renderCalls[cardId] = (state.renderCalls[cardId] ?? 0) + 1;
    if (state.failing.has(cardId)) {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ message: "Connection unavailable", requestId: "req-test" }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ columns: ["stage", "amount"], rows: [{ stage: "Enterprise", amount: 999 }], truncated: false, rowCount: 1, executionMs: 3 }),
    });
  });
}

test.describe("Dashboard — per-tile status (#4321) @llm", () => {
  test.describe.configure({ timeout: 60_000 });

  test("a partial-failure render labels failed tiles stale/errored — never a silent revert, never a page banner", async ({ page }) => {
    const state: MockState = { failing: new Set(["card-stale", "card-err"]), renderCalls: {} };
    await installMocks(page, state);

    // Navigate WITH an active override so the parameter bar fires the render
    // batch on mount (it notifies the page once on mount with the URL's value).
    await page.goto(`/dashboards/${DASH_ID}?dparams=${encodeURIComponent(JSON.stringify({ region: "us" }))}`);

    const okTile = page.locator('[data-tile-status]').filter({ hasText: "Healthy tile" });
    const staleTile = page.locator('[data-tile-status]').filter({ hasText: "Stale tile" });
    const errTile = page.locator('[data-tile-status]').filter({ hasText: "Errored tile" });

    // 1) The healthy tile renders fresh with the NEW filtered rows, and its age
    //    caption resets to "just now" (muted) — the fresh render's `renderedAt`
    //    is fed to the tile, so it does not show a stale red "N days ago".
    await expect(okTile).toHaveAttribute("data-tile-status", "fresh", { timeout: 10_000 });
    await expect(okTile).toContainText("Enterprise");
    await expect(okTile.getByTestId("tile-age-caption")).toHaveAttribute("data-caption-tone", "muted");

    // 2) The failed-with-cache tile is STALE: it keeps its OLD data (never
    //    blanked, never silently swapped to the healthy tile's window) and is
    //    labeled with a color-shifted "Stale" caption + a retry.
    await expect(staleTile).toHaveAttribute("data-tile-status", "stale", { timeout: 10_000 });
    await expect(staleTile).toContainText("Discovery"); // the old cached value, retained
    await expect(staleTile).not.toContainText("Enterprise");
    await expect(staleTile.getByTestId("tile-age-caption")).toContainText("Stale");
    await expect(staleTile.getByTestId("tile-retry")).toBeVisible();

    // 3) The failed-with-no-cache tile is ERRORED — visually distinct from stale.
    await expect(errTile).toHaveAttribute("data-tile-status", "errored", { timeout: 10_000 });
    await expect(errTile.getByTestId("tile-state-errored")).toBeVisible();

    // 4) NO page-level failure banner — the board reads tile by tile.
    await expect(page.getByText(/couldn't be updated with these parameters/i)).toHaveCount(0);

    // 5) Retry the stale tile: the mock now succeeds, the tile flips to fresh.
    state.failing.delete("card-stale");
    await staleTile.getByTestId("tile-retry").click();
    await expect(staleTile).toHaveAttribute("data-tile-status", "fresh", { timeout: 10_000 });
    await expect(staleTile).toContainText("Enterprise");

    // 6) Retry the ERRORED tile (its own placeholder retry, a distinct button /
    //    code path): the mock now succeeds → it flips from errored to fresh.
    state.failing.delete("card-err");
    await errTile.getByTestId("tile-state-errored-retry").click();
    await expect(errTile).toHaveAttribute("data-tile-status", "fresh", { timeout: 10_000 });
    await expect(errTile).toContainText("Enterprise");
  });
});
