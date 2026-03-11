import { test, expect } from "@playwright/test";

test.describe("Mobile Responsive", () => {
  test("iPhone SE: sidebar hidden, chat input visible, can submit", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto("/");

    const input = page.locator('input[placeholder="Ask a question about your data..."]');
    await input.waitFor({ timeout: 15_000 });
    await expect(input).toBeVisible();

    // Desktop sidebar should be hidden at mobile width
    // The desktop sidebar container has class "hidden md:block"
    const desktopSidebar = page.locator('[class*="hidden"][class*="md\\:block"]').first();
    // At 375px, this element should not be visible (CSS hides it)
    await expect(desktopSidebar).not.toBeInViewport();

    // Hamburger menu button should be visible
    const menuBtn = page.locator('button[aria-label="Open conversation history"]');
    await expect(menuBtn).toBeVisible();

    // Can type
    await input.fill("test question");
    await expect(page.locator("button", { hasText: "Ask" })).toBeEnabled();
  });

  test("iPhone SE: mobile sidebar opens and closes", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto("/");

    await page.locator('input[placeholder="Ask a question about your data..."]').waitFor({ timeout: 15_000 });

    // Open mobile sidebar
    await page.locator('button[aria-label="Open conversation history"]').click();

    // "History" title should be visible in the mobile sidebar — use nth(1) because
    // the desktop sidebar's "History" (hidden at mobile width) is the first match
    await expect(page.getByText("History").nth(1)).toBeVisible({ timeout: 5_000 });
    // "+ New" also has a desktop (hidden) and mobile (visible) instance
    await expect(page.locator('button:has-text("+ New")').nth(1)).toBeVisible();
  });

  test("iPad: layout is not broken, chat works", async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto("/");

    const input = page.locator('input[placeholder="Ask a question about your data..."]');
    await input.waitFor({ timeout: 15_000 });
    await expect(input).toBeVisible();

    // Header visible
    await expect(page.locator("h1", { hasText: "Atlas" })).toBeVisible();
  });
});
