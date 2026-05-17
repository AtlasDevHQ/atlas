/**
 * Real-Playwright smoke test for the screenshot pipeline (#2367).
 *
 * Skipped locally unless `TEST_SCREENSHOT_BROWSER=true` — the same pattern
 * `migrate-pg.test.ts` uses to skip without `TEST_DATABASE_URL`. The
 * full Chromium download (~150 MB) is too heavy for the default api-tests
 * unit-test runs; this spec is opt-in for dev environments that have
 * already run `bun x playwright install chromium`.
 *
 * Pre-reqs to run locally:
 *   bun x playwright install chromium
 *   bun run db:up
 *   bun run dev   # so http://localhost:3000 serves the dashboard UI
 *   ATLAS_INTERNAL_SCREENSHOT_COOKIE="<cookie from /api/v1/me>" \
 *     TEST_SCREENSHOT_BROWSER=true \
 *     bun test packages/api/src/lib/__tests__/dashboard-screenshot.smoke.test.ts
 */

import { describe, it, expect, afterAll } from "bun:test";
import { _resetScreenshotCache, closeScreenshotBrowser } from "../dashboard-screenshot";

const RUN_SMOKE = process.env.TEST_SCREENSHOT_BROWSER === "true";

const maybeDescribe = RUN_SMOKE ? describe : describe.skip;

maybeDescribe("dashboard-screenshot pipeline (real Chromium)", () => {
  afterAll(async () => {
    _resetScreenshotCache();
    await closeScreenshotBrowser();
  });

  it("imports playwright and launches Chromium without crashing", async () => {
    // Import dynamically so the static graph stays unaffected when this
    // file is skipped.
    const { chromium } = await import("@playwright/test");
    const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    try {
      const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
      const page = await ctx.newPage();
      await page.setContent('<html><body><h1>Atlas test</h1></body></html>');
      const png = await page.screenshot({ type: "png" });
      expect(png.length).toBeGreaterThan(100);
      // PNG magic bytes
      expect(png[0]).toBe(0x89);
      expect(png[1]).toBe(0x50);
      expect(png[2]).toBe(0x4e);
      expect(png[3]).toBe(0x47);
      await page.close();
      await ctx.close();
    } finally {
      await browser.close();
    }
  }, 30_000);
});
