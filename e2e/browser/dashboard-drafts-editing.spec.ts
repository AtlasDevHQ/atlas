/**
 * Dashboard draft-first editing spine (#4315) @llm
 *
 * The foundational browser contract from ADR-0029: entering Edit is explicit,
 * the canvas then renders the caller's DRAFT (not the published copy), a
 * persistent "Editing your draft" bar is shown, and switching back to View
 * shows the untouched published state. The two-view split is simulated with
 * route mocks — `GET /:id` returns published, `GET /:id?view=draft` returns the
 * draft — so the contract that matters (Edit toggles the view + the bar, View
 * shows published) is exercised without a real DB.
 *
 * @llm tag — same suite segmentation as the sibling drafts specs.
 */

import { test, expect, type Page, type Route } from "@playwright/test";

const DASH_ID = "44444444-5555-6666-7777-888888888888";
const AT = "2026-07-04T10:00:00.000Z";

function card(id: string, title: string, sql: string) {
  return {
    id,
    dashboardId: DASH_ID,
    position: 0,
    title,
    sql,
    chartConfig: null,
    cachedColumns: null,
    cachedRows: null,
    cachedAt: null,
    connectionGroupId: null,
    layout: null,
    createdAt: AT,
    updatedAt: AT,
  };
}

function dashboard(title: string, cardTitle: string, cardSql: string) {
  return {
    id: DASH_ID,
    orgId: "org-1",
    ownerId: "u1",
    title,
    description: null,
    shareToken: null,
    shareExpiresAt: null,
    shareMode: "public" as const,
    refreshSchedule: null,
    lastRefreshAt: null,
    nextRefreshAt: null,
    parameters: [],
    createdAt: AT,
    updatedAt: AT,
    cards: [card("card-1", cardTitle, cardSql)],
  };
}

async function installMocks(page: Page, seen: { draftViewFetched: boolean }): Promise<void> {
  // The dashboard resource: `?view=draft` returns the DRAFT board, else the
  // published board. Anchored regex so sub-paths (/draft/status, /stage,
  // /sessions) are NOT captured here.
  await page.route(
    new RegExp(`/api/v1/dashboards/${DASH_ID}(\\?[^/]*)?$`),
    async (route: Route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      const isDraft = route.request().url().includes("view=draft");
      if (isDraft) seen.draftViewFetched = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          isDraft
            ? dashboard("Draft Board", "Draft tile", "SELECT draft")
            : dashboard("Published Board", "Published tile", "SELECT published"),
        ),
      });
    },
  );

  await page.route(`**/api/v1/dashboards/${DASH_ID}/draft/status`, async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        hasDraft: true,
        publishedBaselineAt: AT,
        dashboardUpdatedAt: AT,
        staleBaseline: false,
        updatedAt: AT,
      }),
    });
  });

  await page.route(`**/api/v1/dashboards/${DASH_ID}/stage`, async (route: Route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ stages: [] }) });
  });

  await page.route(`**/api/v1/dashboards/${DASH_ID}/sessions`, async (route: Route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sessions: [] }) });
  });

  // Tile render batch — return a trivial result regardless of view.
  await page.route(`**/api/v1/dashboards/${DASH_ID}/cards/**/render**`, async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ columns: ["n"], rows: [{ n: 1 }], truncated: false, rowCount: 1, executionMs: 1 }),
    });
  });

  await page.route("**/api/v1/dashboards", async (route: Route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        dashboards: [{ id: DASH_ID, title: "Published Board", cardCount: 1, updatedAt: AT }],
        total: 1,
      }),
    });
  });
}

test.describe("Dashboard draft-first editing @llm", () => {
  test.describe.configure({ timeout: 60_000 });

  test("enter Edit renders the draft + persistent bar; View shows published untouched", async ({
    page,
  }) => {
    const seen = { draftViewFetched: false };
    await installMocks(page, seen);

    await page.goto(`/dashboards/${DASH_ID}`);

    // 1) View mode: the canvas shows the PUBLISHED board.
    await expect(page.getByText("Published tile")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("editing-draft-bar")).toHaveCount(0);

    // 2) Entering Edit is explicit — click the Edit control.
    await page.getByRole("button", { name: "Edit" }).click();

    // 3) The canvas now renders the caller's DRAFT (a `?view=draft` fetch).
    await expect(page.getByText("Draft tile")).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => seen.draftViewFetched, { timeout: 10_000 }).toBe(true);

    // 4) A persistent "Editing your draft" bar is shown while editing (the
    //    draft exists → the richer Draft block with Publish/Discard).
    await expect(page.getByTestId("draft-status-banner")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("draft-status-banner")).toContainText(/editing your draft/i);
    await expect(page.getByTestId("draft-publish-button")).toBeVisible();

    // 5) Switching back to View shows the untouched PUBLISHED board.
    await page.getByRole("button", { name: "View" }).click();
    await expect(page.getByText("Published tile")).toBeVisible({ timeout: 10_000 });
  });
});
