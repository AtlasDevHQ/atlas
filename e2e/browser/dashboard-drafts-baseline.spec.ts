/**
 * Dashboard drafts — "baseline changed" banner + Rebase (#2521) @llm
 *
 * Two-user scenario: user A publishes while user B has an open draft.
 * User B's `/dashboards/[id]` page surfaces a "Your published baseline
 * has changed" banner with a Rebase action. Clicking Rebase calls
 * `POST /:id/draft/rebase` and the banner disappears.
 *
 * The "two users" piece is simulated entirely via mocks — the
 * `/draft/status` endpoint returns `staleBaseline: true` once user A's
 * publish bumps the dashboard `updatedAt`. Real multi-tab + multi-user
 * is out of scope for a browser e2e; the contract that matters (UI
 * branches on `staleBaseline`, calls rebase, then refetches) is fully
 * exercised here.
 *
 * @llm tag — same suite segmentation as the sibling Publish spec.
 */

import { test, expect, type Page, type Route } from "@playwright/test";

const DASH_ID = "22222222-3333-4444-5555-666666666666";
const ORIGINAL_AT = "2026-05-17T11:00:00.000Z";
const POST_PUBLISH_AT = "2026-05-17T11:10:00.000Z";

interface MockState {
  staleBaseline: boolean;
  rebaseCount: number;
}

function publishedDashboard(state: MockState) {
  return {
    id: DASH_ID,
    orgId: "org-1",
    ownerId: "u1",
    title: state.staleBaseline ? "Updated by teammate" : "Original title",
    description: null,
    shareToken: null,
    shareExpiresAt: null,
    shareMode: "public" as const,
    refreshSchedule: null,
    lastRefreshAt: null,
    nextRefreshAt: null,
    createdAt: ORIGINAL_AT,
    updatedAt: state.staleBaseline ? POST_PUBLISH_AT : ORIGINAL_AT,
    cards: [
      {
        id: "card-1",
        dashboardId: DASH_ID,
        position: 0,
        title: state.staleBaseline ? "Teammate's title" : "My tile",
        sql: "SELECT 1",
        chartConfig: null,
        cachedColumns: null,
        cachedRows: null,
        cachedAt: null,
        connectionGroupId: null,
        layout: null,
        createdAt: ORIGINAL_AT,
        updatedAt: state.staleBaseline ? POST_PUBLISH_AT : ORIGINAL_AT,
      },
    ],
  };
}

async function installMocks(page: Page, state: MockState): Promise<void> {
  await page.route(`**/api/v1/dashboards/${DASH_ID}`, async (route: Route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(publishedDashboard(state)),
    });
  });

  await page.route(
    `**/api/v1/dashboards/${DASH_ID}/draft/status`,
    async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          hasDraft: true,
          publishedBaselineAt: ORIGINAL_AT,
          dashboardUpdatedAt: state.staleBaseline ? POST_PUBLISH_AT : ORIGINAL_AT,
          staleBaseline: state.staleBaseline,
          updatedAt: "2026-05-17T11:01:00.000Z",
        }),
      });
    },
  );

  await page.route(
    `**/api/v1/dashboards/${DASH_ID}/draft/rebase`,
    async (route: Route) => {
      state.rebaseCount++;
      // Rebase clears the staleBaseline flag — the draft has caught up.
      state.staleBaseline = false;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          snapshot: { dashboardId: DASH_ID, title: "Rebased", description: null, cards: [] },
          publishedBaselineAt: POST_PUBLISH_AT,
        }),
      });
    },
  );

  await page.route(`**/api/v1/dashboards/${DASH_ID}/sessions`, async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ sessions: [] }),
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
        dashboards: [{ id: DASH_ID, title: "Dashboard", cardCount: 1, updatedAt: ORIGINAL_AT }],
        total: 1,
      }),
    });
  });
}

test.describe("Dashboard drafts — baseline-changed banner @llm", () => {
  test.describe.configure({ timeout: 60_000 });

  test("staleBaseline=true surfaces the banner; Rebase clears it", async ({ page }) => {
    const state: MockState = { staleBaseline: true, rebaseCount: 0 };
    await installMocks(page, state);

    await page.goto(`/dashboards/${DASH_ID}`);

    // 1) Draft badge still renders (user has a draft).
    await expect(page.getByTestId("draft-badge")).toBeVisible({ timeout: 10_000 });

    // 2) Baseline-changed banner appears with Rebase affordance.
    const banner = page.getByTestId("baseline-changed-banner");
    await expect(banner).toBeVisible({ timeout: 5_000 });
    await expect(banner).toContainText(/baseline has changed/i);

    // 3) Publish is disabled while baseline is stale — the user MUST
    //    rebase first (the page's `disabled={publishing || discarding ||
    //    staleBaseline}` invariant).
    await expect(page.getByTestId("draft-publish-button")).toBeDisabled();

    // 4) Click Rebase.
    await page.getByTestId("draft-rebase-button").click();

    await expect.poll(() => state.rebaseCount, { timeout: 10_000 }).toBe(1);

    // 5) Banner clears after the refetch.
    await expect(banner).toBeHidden({ timeout: 5_000 });

    // 6) Publish re-enables.
    await expect(page.getByTestId("draft-publish-button")).toBeEnabled({
      timeout: 5_000,
    });
  });

  test("no banner when baseline is in sync (regression — false positives are noisy)", async ({
    page,
  }) => {
    const state: MockState = { staleBaseline: false, rebaseCount: 0 };
    await installMocks(page, state);

    await page.goto(`/dashboards/${DASH_ID}`);

    await expect(page.getByTestId("draft-badge")).toBeVisible({ timeout: 10_000 });
    // The banner-changed banner should NOT appear when staleBaseline is false.
    await expect(page.getByTestId("baseline-changed-banner")).toHaveCount(0);
    // And Publish is enabled.
    await expect(page.getByTestId("draft-publish-button")).toBeEnabled();
  });
});
