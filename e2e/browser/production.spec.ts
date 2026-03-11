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
    expect(response?.status()).toBeLessThan(400);

    // Should have some content (the Atlas branding)
    await expect(page.locator("body")).not.toBeEmpty();
  });

  test("docs site loads", async ({ page }) => {
    const response = await page.goto(PROD_DOCS_URL);
    expect(response?.status()).toBeLessThan(400);

    // Docs should have navigation or content
    await expect(page.locator("body")).not.toBeEmpty();
  });

  test("app shows login page", async ({ page }) => {
    const response = await page.goto(PROD_APP_URL);
    expect(response?.status()).toBeLessThan(400);

    // Should show login form or the Atlas UI
    await expect(page.locator("body")).not.toBeEmpty();
  });

  test("API health endpoint returns ok", async ({ request }) => {
    const response = await request.get(`${PROD_API_URL}/api/health`);
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body.status).toBe("ok");
  });
});
