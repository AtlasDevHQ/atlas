/**
 * Dashboard drafts — Publish + Discard flow (#2521) @llm
 *
 * Exercises the user-facing surface added in #2521:
 *
 *   1. Editor on /dashboards/[id] sees a "Draft" badge when they have
 *      an active draft.
 *   2. Clicking Publish opens the diff-confirm modal showing added /
 *      changed cards with a field-level breakdown.
 *   3. Confirm commits the draft; the modal closes and the banner
 *      disappears.
 *   4. Discard surfaces an AlertDialog confirm and removes the draft.
 *
 * Backend is fully mocked via `page.route(...)` — keeps the spec
 * independent of the seed scripts and the live DB. The flow exercised
 * mirrors the real API contract (status → draft view → publish /
 * discard) so a regression that changes any wire shape surfaces here.
 *
 * `@llm` tag opts the spec into the serial worker convention used by
 * other route-mock dashboard specs — multiple mocks running in parallel
 * across worker tabs would compete for the same dashboard id.
 */

import { test, expect, type Page, type Route } from "@playwright/test";

const DASH_ID = "11111111-2222-3333-4444-555555555555";
const PUBLISHED_BASELINE_AT = "2026-05-17T10:00:00.000Z";

// ---------------------------------------------------------------------------
// Fixtures matching the wire shapes from
// `packages/api/src/api/routes/dashboards.ts`.
// ---------------------------------------------------------------------------

interface MockState {
  hasDraft: boolean;
  staleBaseline: boolean;
  /** Bumped on each publish so refetches reflect the new state. */
  publishedVersion: number;
  /** Number of publish calls (assertion target). */
  publishCount: number;
  /** Number of discard calls. */
  discardCount: number;
}

// Loose typing on the card builders — Playwright stringifies them into
// the route mock so structural conformance is enough. The page never
// inspects these via @useatlas/types.
interface MockCard {
  id: string;
  dashboardId: string;
  position: number;
  title: string;
  sql: string;
  chartConfig: { type: string; categoryColumn: string; valueColumns: string[] } | null;
  cachedColumns: string[] | null;
  cachedRows: Record<string, unknown>[] | null;
  cachedAt: string | null;
  connectionGroupId: string | null;
  layout: { x: number; y: number; w: number; h: number } | null;
  createdAt: string;
  updatedAt: string;
}

function buildCardA(extra?: Partial<MockCard>): MockCard {
  return {
    id: "card-a",
    dashboardId: DASH_ID,
    position: 0,
    title: "Revenue by month",
    sql: "SELECT month, revenue FROM revenue_summary",
    chartConfig: { type: "bar", categoryColumn: "month", valueColumns: ["revenue"] },
    cachedColumns: ["month", "revenue"],
    cachedRows: [{ month: "Jan", revenue: 1000 }],
    cachedAt: PUBLISHED_BASELINE_AT,
    connectionGroupId: null,
    layout: null,
    createdAt: PUBLISHED_BASELINE_AT,
    updatedAt: PUBLISHED_BASELINE_AT,
    ...extra,
  };
}

function buildCardB(extra?: Partial<MockCard>): MockCard {
  return {
    id: "card-b-new-in-draft",
    dashboardId: DASH_ID,
    position: 1,
    title: "New tile from chat",
    sql: "SELECT COUNT(*) FROM users",
    chartConfig: { type: "table", categoryColumn: "count", valueColumns: ["count"] },
    cachedColumns: null,
    cachedRows: null,
    cachedAt: null,
    connectionGroupId: null,
    layout: null,
    createdAt: PUBLISHED_BASELINE_AT,
    updatedAt: PUBLISHED_BASELINE_AT,
    ...extra,
  };
}

function publishedDashboard(state: MockState) {
  // After a publish, the dashboard now also contains card-b (the draft
  // landed). Before publish, only card-a is published.
  const cards = [buildCardA()];
  if (state.publishedVersion > 0) {
    cards.push(buildCardB());
  }
  return {
    id: DASH_ID,
    orgId: "org-1",
    ownerId: "u1",
    title: state.publishedVersion > 0 ? "Revamped dashboard" : "Original dashboard",
    description: null,
    shareToken: null,
    shareExpiresAt: null,
    shareMode: "public" as const,
    refreshSchedule: null,
    lastRefreshAt: null,
    nextRefreshAt: null,
    createdAt: PUBLISHED_BASELINE_AT,
    updatedAt:
      state.publishedVersion > 0 ? "2026-05-17T10:05:00.000Z" : PUBLISHED_BASELINE_AT,
    cards,
  };
}

function draftView() {
  // The draft has both cards + a renamed dashboard title — exercises
  // the diff modal's "added" + "meta title" branches.
  return {
    draft: {
      userId: "u1",
      dashboardId: DASH_ID,
      publishedBaselineAt: PUBLISHED_BASELINE_AT,
      updatedAt: "2026-05-17T10:01:00.000Z",
    },
    view: {
      id: DASH_ID,
      orgId: "org-1",
      ownerId: "u1",
      title: "Revamped dashboard",
      description: null,
      shareToken: null,
      shareExpiresAt: null,
      shareMode: "public" as const,
      refreshSchedule: null,
      lastRefreshAt: null,
      nextRefreshAt: null,
      createdAt: PUBLISHED_BASELINE_AT,
      updatedAt: "2026-05-17T10:01:00.000Z",
      cards: [buildCardA(), buildCardB()],
    },
  };
}

async function installMocks(page: Page, state: MockState): Promise<void> {
  // /api/v1/dashboards/:id
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

  // /api/v1/dashboards/:id/draft/status — non-forking presence check.
  await page.route(
    `**/api/v1/dashboards/${DASH_ID}/draft/status`,
    async (route: Route) => {
      if (state.hasDraft) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            hasDraft: true,
            publishedBaselineAt: PUBLISHED_BASELINE_AT,
            dashboardUpdatedAt: state.staleBaseline
              ? "2026-05-17T10:10:00.000Z"
              : PUBLISHED_BASELINE_AT,
            staleBaseline: state.staleBaseline,
            updatedAt: "2026-05-17T10:01:00.000Z",
          }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ hasDraft: false }),
        });
      }
    },
  );

  // /api/v1/dashboards/:id/draft — materialized view (forks on first call
  // server-side; mock just returns the static view shape).
  await page.route(`**/api/v1/dashboards/${DASH_ID}/draft`, async (route: Route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(draftView()),
    });
  });

  // /api/v1/dashboards/:id/draft/publish
  await page.route(
    `**/api/v1/dashboards/${DASH_ID}/draft/publish`,
    async (route: Route) => {
      state.publishCount++;
      state.publishedVersion++;
      state.hasDraft = false;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, opsApplied: 2 }),
      });
    },
  );

  // /api/v1/dashboards/:id/draft/discard
  await page.route(
    `**/api/v1/dashboards/${DASH_ID}/draft/discard`,
    async (route: Route) => {
      state.discardCount++;
      state.hasDraft = false;
      await route.fulfill({
        status: 204,
        body: "",
      });
    },
  );

  // Various other dashboard endpoints the page touches (suggestions,
  // sessions, etc.) — return empty data so they don't 404.
  await page.route(`**/api/v1/dashboards/${DASH_ID}/sessions`, async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ sessions: [] }),
    });
  });
  // List endpoint (touched by the dashboard switcher on the topbar).
  await page.route("**/api/v1/dashboards", async (route: Route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        dashboards: [{ id: DASH_ID, title: "Dashboard", cardCount: 1, updatedAt: PUBLISHED_BASELINE_AT }],
        total: 1,
      }),
    });
  });
}

test.describe("Dashboard drafts — Publish + Discard @llm", () => {
  test.describe.configure({ timeout: 60_000 });

  test("editor sees draft badge → Publish opens diff modal → Confirm commits draft", async ({
    page,
  }) => {
    const state: MockState = {
      hasDraft: true,
      staleBaseline: false,
      publishedVersion: 0,
      publishCount: 0,
      discardCount: 0,
    };
    await installMocks(page, state);

    await page.goto(`/dashboards/${DASH_ID}`);

    // 1) Draft badge appears.
    const badge = page.getByTestId("draft-badge");
    await expect(badge).toBeVisible({ timeout: 10_000 });
    await expect(badge).toContainText(/draft/i);

    // The banner copy mentions "unpublished changes".
    await expect(page.getByTestId("draft-status-banner")).toContainText(
      /unpublished changes/i,
    );

    // 2) Publish opens the diff modal.
    await page.getByTestId("draft-publish-button").click();

    const modal = page.getByTestId("publish-diff-modal");
    await expect(modal).toBeVisible({ timeout: 5_000 });

    // 3) Diff sections render: title meta change + added card + (no
    // removed in this scenario).
    await expect(page.getByTestId("publish-diff-meta-title")).toBeVisible();
    await expect(page.getByTestId("publish-diff-meta-title")).toContainText(
      "Revamped dashboard",
    );
    await expect(page.getByTestId("publish-diff-added")).toBeVisible();
    await expect(page.getByTestId("publish-diff-added")).toContainText(
      "New tile from chat",
    );
    await expect(page.getByTestId("publish-diff-empty")).toHaveCount(0);

    // 4) Confirm commits.
    await page.getByTestId("publish-diff-confirm").click();

    // Server received the POST.
    await expect.poll(() => state.publishCount, { timeout: 10_000 }).toBe(1);

    // Modal closes.
    await expect(modal).toBeHidden({ timeout: 5_000 });

    // Banner gone (draft cleared).
    await expect(badge).toBeHidden({ timeout: 5_000 });
  });

  test("Discard button opens confirm AlertDialog and removes draft on confirm", async ({
    page,
  }) => {
    const state: MockState = {
      hasDraft: true,
      staleBaseline: false,
      publishedVersion: 0,
      publishCount: 0,
      discardCount: 0,
    };
    await installMocks(page, state);

    await page.goto(`/dashboards/${DASH_ID}`);
    await expect(page.getByTestId("draft-badge")).toBeVisible({ timeout: 10_000 });

    await page.getByTestId("draft-discard-button").click();

    // shadcn AlertDialog uses role="alertdialog".
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(dialog).toContainText(/discard draft/i);

    await page.getByTestId("draft-discard-confirm").click();

    await expect.poll(() => state.discardCount, { timeout: 10_000 }).toBe(1);

    // Banner is gone.
    await expect(page.getByTestId("draft-badge")).toBeHidden({ timeout: 5_000 });
  });

  test("Publish modal renders the empty state when draft matches published", async ({
    page,
  }) => {
    // Mock the draft endpoint to return a view identical to published so
    // `diffDashboards` reports `empty: true`.
    const state: MockState = {
      hasDraft: true,
      staleBaseline: false,
      publishedVersion: 0,
      publishCount: 0,
      discardCount: 0,
    };
    await installMocks(page, state);

    // Override the draft view to mirror published exactly.
    await page.route(
      `**/api/v1/dashboards/${DASH_ID}/draft`,
      async (route: Route) => {
        if (route.request().method() !== "GET") {
          await route.fallback();
          return;
        }
        const published = publishedDashboard(state);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            draft: {
              userId: "u1",
              dashboardId: DASH_ID,
              publishedBaselineAt: PUBLISHED_BASELINE_AT,
              updatedAt: "2026-05-17T10:01:00.000Z",
            },
            view: published,
          }),
        });
      },
    );

    await page.goto(`/dashboards/${DASH_ID}`);
    await expect(page.getByTestId("draft-badge")).toBeVisible({ timeout: 10_000 });

    await page.getByTestId("draft-publish-button").click();
    await expect(page.getByTestId("publish-diff-empty")).toBeVisible({
      timeout: 5_000,
    });

    // Confirm button disabled in the empty state.
    await expect(page.getByTestId("publish-diff-confirm")).toBeDisabled();
  });
});
