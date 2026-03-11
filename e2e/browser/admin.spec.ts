import { test, expect } from "@playwright/test";

test.describe("Admin Console", () => {
  test("overview page shows health and resource stats", async ({ page }) => {
    await page.goto("/admin");

    await expect(page.locator("h1", { hasText: "Overview" })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("text=Monitor your Atlas deployment")).toBeVisible();

    await expect(page.locator('button:has-text("Refresh")')).toBeVisible();

    // Resources section
    await expect(page.locator("text=Resources")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("text=Active datasource connections")).toBeVisible();
    await expect(page.locator("text=Tables & views in semantic layer")).toBeVisible();
    await expect(page.locator("text=Installed plugins")).toBeVisible();

    // Component Health section
    await expect(page.locator("text=Component Health")).toBeVisible({ timeout: 10_000 });
  });

  test("connections page lists default connection with test button", async ({ page }) => {
    await page.goto("/admin/connections");

    await expect(page.locator("h1", { hasText: "Connections" })).toBeVisible({ timeout: 15_000 });

    await expect(page.locator("td", { hasText: "default" }).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('button:has-text("Test")').first()).toBeVisible();
    await expect(page.locator('button:has-text("Add Connection")')).toBeVisible();
  });

  test("connections test button works", async ({ page }) => {
    await page.goto("/admin/connections");

    await page.locator("td", { hasText: "default" }).first().waitFor({ timeout: 10_000 });

    const testBtn = page.locator('button:has-text("Test")').first();
    await testBtn.click();

    // Wait for the test to complete and verify success
    await expect(testBtn).toBeEnabled({ timeout: 15_000 });
    await expect(
      page.locator("text=Connected").or(page.locator('[class*="text-green"]')).first(),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("semantic layer page loads with entities", async ({ page }) => {
    await page.goto("/admin/semantic");

    await expect(page.locator("h1", { hasText: "Semantic Layer" })).toBeVisible({ timeout: 15_000 });

    // Entity files should show in the file tree
    await expect(page.locator("text=companies.yml").first()).toBeVisible({ timeout: 10_000 });
  });

  test("semantic layer — click entity shows detail", async ({ page }) => {
    await page.goto("/admin/semantic");

    const companiesItem = page.locator("text=companies.yml").first();
    await companiesItem.waitFor({ timeout: 10_000 });
    await companiesItem.click();

    // Entity detail — the "Pretty" toggle should be active
    await expect(page.getByRole("radio", { name: "Pretty" })).toBeVisible({ timeout: 10_000 });
  });

  test("audit log page loads with log tab", async ({ page }) => {
    await page.goto("/admin/audit");

    await expect(page.locator("h1", { hasText: "Audit Log" })).toBeVisible({ timeout: 15_000 });

    // The Log/Analytics tab list should be visible
    await expect(page.getByRole("tab", { name: "Log" })).toBeVisible({ timeout: 10_000 });
  });

  test("users page loads with user list and invite button", async ({ page }) => {
    await page.goto("/admin/users");

    await expect(page.locator("h1", { hasText: "Users" })).toBeVisible({ timeout: 15_000 });

    await expect(page.locator('button:has-text("Invite user")')).toBeVisible();

    await expect(page.locator("td", { hasText: "admin@atlas.dev" }).first()).toBeVisible({ timeout: 10_000 });
  });

  test("token usage page loads with summary cards", async ({ page }) => {
    await page.goto("/admin/token-usage");

    await expect(page.locator("text=Token Usage").first()).toBeVisible({ timeout: 15_000 });

    // Either token data exists or the empty state is shown
    await expect(
      page.getByText("Total Tokens", { exact: true })
        .or(page.getByText("No token usage data", { exact: true })),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("settings page loads with sections", async ({ page }) => {
    await page.goto("/admin/settings");

    await expect(page.locator("h1", { hasText: "Settings" })).toBeVisible({ timeout: 15_000 });

    await expect(
      page.getByText("Brand Color", { exact: true }),
    ).toBeVisible({ timeout: 10_000 });
  });
});
