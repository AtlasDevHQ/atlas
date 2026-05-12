import { test, expect } from "@playwright/test";

test.describe("Mobile Responsive", () => {
  test("iPhone SE: sidebar hidden, chat input visible, can submit", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto("/");

    const input = page.locator('input[placeholder="Ask a question about your data..."]');
    await input.waitFor({ timeout: 15_000 });
    await expect(input).toBeVisible();

    // Mobile sidebar trigger (shadcn SidebarTrigger renders a button with
    // sr-only "Toggle Sidebar" text).
    const menuBtn = page.getByRole("button", { name: "Toggle Sidebar" }).first();
    await expect(menuBtn).toBeVisible();

    await input.fill("test question");
    await expect(page.locator("button", { hasText: "Ask" })).toBeEnabled();
  });

  test("iPhone SE: mobile sidebar opens and shows rail items", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto("/");

    await page.locator('input[placeholder="Ask a question about your data..."]').waitFor({ timeout: 15_000 });

    await page.getByRole("button", { name: "Toggle Sidebar" }).first().click();

    // The rail's Workspace section and New conversation CTA should both be
    // reachable from the open drawer.
    await expect(page.getByText("Workspace")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole("button", { name: "New conversation" })).toBeVisible();
  });

  test("iPad: layout is not broken, chat works", async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto("/");

    const input = page.locator('input[placeholder="Ask a question about your data..."]');
    await input.waitFor({ timeout: 15_000 });
    await expect(input).toBeVisible();

    await expect(page.getByText("Atlas").first()).toBeVisible();
  });
});
