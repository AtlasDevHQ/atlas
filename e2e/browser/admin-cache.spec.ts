import { test, expect, type Page, type Route } from "@playwright/test";

/**
 * Admin cache flush flow — e2e coverage for the Bucket-4 polish page
 * (#1708, follow-up to PR #1705). Rated 4/10 criticality by the
 * test-analyzer: pure CSS/a11y polish, but `/admin/cache` had zero
 * prior browser coverage.
 *
 * Mocks `/api/v1/admin/cache/{stats,flush}` at the page level and
 * mutates a local stats object on POST so the refetch after a
 * successful flush reflects `entryCount: 0`. No `@llm` tag — no
 * model calls.
 *
 * Mirrors the shape of `admin-sessions.spec.ts` (route-mock pattern,
 * `route.abort("failed")` on unexpected methods so real-network
 * passthrough can't mask a regression in CI).
 */

interface MockCacheStats {
  enabled: boolean;
  hits: number;
  misses: number;
  hitRate: number;
  missRate: number;
  entryCount: number;
  maxSize: number;
  ttl: number;
}

function buildStats(overrides: Partial<MockCacheStats> = {}): MockCacheStats {
  return {
    enabled: true,
    hits: 8_500,
    misses: 1_500,
    hitRate: 0.85,
    missRate: 0.15,
    entryCount: 420,
    maxSize: 1_000,
    ttl: 60_000,
    ...overrides,
  };
}

interface MockOptions {
  initial?: Partial<MockCacheStats>;
  /** If set, POST /flush returns a 500 with this requestId. */
  flushFailRequestId?: string;
}

async function installCacheMocks(
  page: Page,
  opts: MockOptions = {},
): Promise<{ stats: MockCacheStats }> {
  const stats: MockCacheStats = buildStats(opts.initial);

  await page.route(/\/api\/v1\/admin\/cache\/stats(?:\?|$)/, async (route: Route) => {
    if (route.request().method() !== "GET") {
      await route.abort("failed");
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(stats),
    });
  });

  await page.route(/\/api\/v1\/admin\/cache\/flush(?:\?|$)/, async (route: Route) => {
    if (route.request().method() !== "POST") {
      await route.abort("failed");
      return;
    }
    if (opts.flushFailRequestId) {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          error: "internal",
          message: "Cache flush failed on the backend",
          requestId: opts.flushFailRequestId,
        }),
      });
      return;
    }
    // Successful flush — drop entries so the subsequent refetch shows
    // an empty cache, which in turn disables the flush button + flips
    // the tooltip copy.
    stats.entryCount = 0;
    stats.hits = 0;
    stats.misses = 0;
    stats.hitRate = 0;
    stats.missRate = 0;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ message: "Cache flushed (420 entries removed)" }),
    });
  });

  return { stats };
}

test.describe("Admin cache flush flow", () => {
  test.describe.configure({ timeout: 30_000 });

  test("golden path: flush → success banner → empty cache disables button", async ({ page }) => {
    await installCacheMocks(page);
    await page.goto("/admin/cache");

    await expect(page.locator("h1", { hasText: "Cache" })).toBeVisible({
      timeout: 15_000,
    });

    // Stats render from the initial GET.
    await expect(page.getByText("Hit Rate", { exact: true })).toBeVisible();
    await expect(page.getByText("85.0%")).toBeVisible();
    await expect(page.getByText("420 / 1,000")).toBeVisible();

    // Flush button enabled; click opens the confirm dialog.
    const flushButton = page.getByRole("button", { name: "Flush Cache", exact: true });
    await expect(flushButton).toBeEnabled();
    await flushButton.click();

    await expect(page.getByRole("heading", { name: "Flush cache?" })).toBeVisible();
    // Confirm dialog describes the entry count accurately.
    await expect(
      page.getByText("This will remove 420 cached entries", { exact: false }),
    ).toBeVisible();

    // Confirm → POST fires → success banner appears via role=status.
    await page.getByRole("button", { name: /flush/i, exact: false }).last().click();

    await expect(
      page.getByRole("status").filter({ hasText: /flushed/i }),
    ).toBeVisible({ timeout: 10_000 });

    // After refetch, the flush button is disabled (entryCount === 0) and
    // hovering reveals the "Cache is empty" tooltip.
    const disabledFlush = page.getByRole("button", { name: "Flush Cache", exact: true });
    await expect(disabledFlush).toBeDisabled({ timeout: 10_000 });
  });

  test("disabled cache renders env-var notice + tooltip explains why flush is gated", async ({ page }) => {
    await installCacheMocks(page, { initial: { enabled: false, entryCount: 0, hits: 0, misses: 0, hitRate: 0 } });
    await page.goto("/admin/cache");

    await expect(page.locator("h1", { hasText: "Cache" })).toBeVisible({
      timeout: 15_000,
    });

    // Amber notice for disabled cache with the env var code-literal.
    await expect(page.getByText(/ATLAS_CACHE_ENABLED/)).toBeVisible();

    // Flush button is disabled (no POST should fire even if clicked).
    const flushButton = page.getByRole("button", { name: "Flush Cache", exact: true });
    await expect(flushButton).toBeDisabled();
  });

  test("flush failure routes through MutationErrorSurface with requestId", async ({ page }) => {
    await installCacheMocks(page, { flushFailRequestId: "req_mock_fail_abc" });
    await page.goto("/admin/cache");

    await expect(page.locator("h1", { hasText: "Cache" })).toBeVisible({
      timeout: 15_000,
    });

    await page.getByRole("button", { name: "Flush Cache", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Flush cache?" })).toBeVisible();
    await page.getByRole("button", { name: /flush/i, exact: false }).last().click();

    // MutationErrorSurface renders the error message; no success banner.
    await expect(page.getByText(/cache flush failed/i)).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByRole("status").filter({ hasText: /flushed \(/i })).toHaveCount(0);
  });
});
