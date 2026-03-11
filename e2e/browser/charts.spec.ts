import { test, expect } from "@playwright/test";
import { askQuestion, waitForSQLResult, ensureChatReady, startNewChat } from "./helpers";

test.describe("Chat — Charts @llm", () => {
  // LLM responses take 60-120s via gateway; run serially to avoid overwhelming the API.
  test.describe.configure({ timeout: 240_000, mode: "serial" });

  test.beforeEach(async ({ page }) => {
    await ensureChatReady(page);
  });

  test("bar chart renders for categorical + numeric query", async ({ page }) => {
    await askQuestion(page, "companies by industry");
    await waitForSQLResult(page);

    // Recharts wrapper div should be visible (SVG <g> elements don't pass toBeVisible)
    await expect(page.locator(".recharts-wrapper").first()).toBeVisible({ timeout: 10_000 });
    // Bar rectangles should exist in the DOM
    await expect(page.locator(".recharts-bar-rectangle").first()).toBeAttached({ timeout: 5_000 });
  });

  test("line chart renders for time-series query", async ({ page }) => {
    await askQuestion(page, "accounts created per month");
    await waitForSQLResult(page);

    await expect(page.locator(".recharts-wrapper").first()).toBeVisible({ timeout: 10_000 });
  });

  test("pie chart renders for distribution query", async ({ page }) => {
    await askQuestion(page, "show me plan distribution");
    await waitForSQLResult(page);

    await expect(page.locator(".recharts-wrapper").first()).toBeVisible({ timeout: 10_000 });
  });

  test("chart/table view toggle works", async ({ page }) => {
    await askQuestion(page, "companies by industry");
    await waitForSQLResult(page);

    // Default view is "both" — chart and table should be visible
    const chartToggle = page.locator('button:has-text("Chart")');
    const tableToggle = page.locator('button:has-text("Table")');

    // Click "Table" to show only table
    await tableToggle.click();
    // The recharts wrapper should be hidden
    await expect(page.locator(".recharts-wrapper")).toBeHidden({ timeout: 5_000 });
    // Table should be visible (look for table element inside the result card)
    await expect(page.locator("table").first()).toBeVisible();

    // Click "Chart" to show only chart
    await chartToggle.click();
    await expect(page.locator(".recharts-wrapper").first()).toBeVisible({ timeout: 5_000 });
  });

  test("SQL can be shown and hidden", async ({ page }) => {
    await askQuestion(page, "companies by industry");
    await waitForSQLResult(page);

    // Click "Show SQL"
    const showSqlBtn = page.locator('button:has-text("Show SQL")');
    await showSqlBtn.click();

    // SQL code block should be visible
    await expect(page.locator("pre code").first()).toBeVisible();

    // Click "Hide SQL"
    await page.locator('button:has-text("Hide SQL")').click();
    await expect(page.locator("pre code")).toBeHidden({ timeout: 3_000 });
  });

  test("CSV download button is present", async ({ page }) => {
    await askQuestion(page, "companies by industry");
    await waitForSQLResult(page);

    const csvBtn = page.locator('button[title="Download CSV"]');
    await expect(csvBtn).toBeVisible();
  });

  test("Excel download button is present", async ({ page }) => {
    await askQuestion(page, "companies by industry");
    await waitForSQLResult(page);

    const excelBtn = page.locator('button[title="Download Excel"]');
    await expect(excelBtn).toBeVisible();
  });
});
