import { test, expect } from "@playwright/test";
import { ensureChatReady } from "./helpers";

test.describe("Schema Explorer", () => {
  test.beforeEach(async ({ page }) => {
    await ensureChatReady(page);
  });

  test("opens and shows entity list", async ({ page }) => {
    // Click the schema explorer button (TableProperties icon button)
    await page.locator('button[aria-label="Open schema explorer"]').click();

    // Sheet panel scoped selector
    const sheet = page.locator('[data-slot="sheet-content"]');
    await expect(sheet.locator("text=Schema Explorer")).toBeVisible({ timeout: 10_000 });

    // Search input should be visible
    await expect(sheet.locator('input[placeholder="Search tables..."]')).toBeVisible();

    // Demo entities should be listed (companies, people, accounts)
    await expect(sheet.locator("text=companies").first()).toBeVisible({ timeout: 10_000 });
    await expect(sheet.locator("text=people").first()).toBeVisible();
    await expect(sheet.locator("text=accounts").first()).toBeVisible();
  });

  test("search filters entity list", async ({ page }) => {
    await page.locator('button[aria-label="Open schema explorer"]').click();

    const sheet = page.locator('[data-slot="sheet-content"]');
    await sheet.locator("text=Schema Explorer").waitFor({ timeout: 10_000 });

    const searchInput = sheet.locator('input[placeholder="Search tables..."]');
    // Use a nonsense term that matches nothing
    await searchInput.fill("zzzzz_no_match");

    // Should show "No matching entities"
    await expect(sheet.locator("text=No matching entities")).toBeVisible({ timeout: 5_000 });

    // Clear and verify all entities return
    await searchInput.clear();
    await expect(sheet.locator("text=companies").first()).toBeVisible({ timeout: 5_000 });
  });

  test("clear search shows all entities", async ({ page }) => {
    await page.locator('button[aria-label="Open schema explorer"]').click();

    const sheet = page.locator('[data-slot="sheet-content"]');
    await sheet.locator("text=Schema Explorer").waitFor({ timeout: 10_000 });

    const searchInput = sheet.locator('input[placeholder="Search tables..."]');

    await searchInput.fill("accounts");
    await expect(sheet.locator("text=accounts").first()).toBeVisible({ timeout: 5_000 });

    await searchInput.clear();

    await expect(sheet.locator("text=companies").first()).toBeVisible();
    await expect(sheet.locator("text=people").first()).toBeVisible();
    await expect(sheet.locator("text=accounts").first()).toBeVisible();
  });

  test("clicking an entity shows its detail", async ({ page }) => {
    await page.locator('button[aria-label="Open schema explorer"]').click();

    const sheet = page.locator('[data-slot="sheet-content"]');
    await sheet.locator("text=Schema Explorer").waitFor({ timeout: 10_000 });

    // Click on "companies" entity within the sheet
    const companiesBtn = sheet.locator("button", { hasText: "companies" }).first();
    await companiesBtn.waitFor({ timeout: 10_000 });
    await companiesBtn.click();

    // Detail view should show the "Columns" section heading (API fetch may take a few seconds)
    await expect(sheet.locator("h4", { hasText: "Columns" })).toBeVisible({
      timeout: 15_000,
    });
  });

  test("close and reopen resets state", async ({ page }) => {
    // Open explorer
    await page.locator('button[aria-label="Open schema explorer"]').click();

    const sheet = page.locator('[data-slot="sheet-content"]');
    await sheet.locator("text=Schema Explorer").waitFor({ timeout: 10_000 });

    // Click on "companies" entity within the sheet
    const companiesBtn = sheet.locator("button", { hasText: "companies" }).first();
    await companiesBtn.waitFor({ timeout: 10_000 });
    await companiesBtn.click();

    // Wait for detail to load
    await expect(sheet.locator("h4", { hasText: "Columns" })).toBeVisible({ timeout: 15_000 });

    // Close the sheet via the X button (sr-only label "Close")
    await sheet.getByRole("button", { name: "Close" }).click();
    await expect(sheet.locator("text=Schema Explorer")).toBeHidden({ timeout: 5_000 });

    // Reopen
    await page.locator('button[aria-label="Open schema explorer"]').click();
    await sheet.locator("text=Schema Explorer").waitFor({ timeout: 10_000 });

    // Search should be cleared, entity list visible (not detail view)
    const searchInput = sheet.locator('input[placeholder="Search tables..."]');
    await expect(searchInput).toHaveValue("");

    // All entities should be listed
    await expect(sheet.locator("text=companies").first()).toBeVisible();
    await expect(sheet.locator("text=people").first()).toBeVisible();
  });
});
