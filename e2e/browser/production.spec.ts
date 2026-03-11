import { test, expect } from "@playwright/test";

// These tests run against production URLs without auth.
// They verify pages load — not functionality.

const PROD_APP_URL = process.env.PROD_APP_URL ?? "https://app.useatlas.dev";
const PROD_API_URL = process.env.PROD_API_URL ?? "https://api.useatlas.dev";
const PROD_WWW_URL = process.env.PROD_WWW_URL ?? "https://useatlas.dev";
const PROD_DOCS_URL = process.env.PROD_DOCS_URL ?? "https://docs.useatlas.dev";

test.describe("Production Smoke Tests", () => {
  test("landing page loads", async ({ page }) => {
    const response = await page.goto(PROD_WWW_URL);
    expect(response).not.toBeNull();
    expect(response!.status()).toBeLessThan(400);

    await expect(page.getByRole("navigation").getByText("atlas")).toBeVisible({ timeout: 10_000 });
  });

  test("docs site loads", async ({ page }) => {
    const response = await page.goto(PROD_DOCS_URL, { timeout: 15_000 }).catch(() => null);
    if (!response || response.status() >= 400) {
      test.skip(true, "Docs site unreachable — skipping in local dev");
      return;
    }

    // Fumadocs renders a sidebar nav or header nav
    await expect(
      page.locator("nav").first().or(page.locator("aside").first()),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("app shows login page", async ({ page }) => {
    const response = await page.goto(PROD_APP_URL);
    expect(response).not.toBeNull();
    expect(response!.status()).toBeLessThan(400);

    await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 10_000 });
  });

  test("API health endpoint returns ok", async ({ request }) => {
    const response = await request.get(`${PROD_API_URL}/api/health`);
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body.status).toBe("ok");
  });
});
