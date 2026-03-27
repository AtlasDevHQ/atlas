import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * Accessibility audit — axe-core scans of key Atlas pages.
 * Fails on any critical or serious violations.
 */

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];

/** Run axe-core and assert zero critical/serious violations. */
async function assertNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();

  // Sanity check — axe actually scanned meaningful content
  expect(results.passes.length, "axe-core should have evaluated at least one rule").toBeGreaterThan(0);

  const critical = results.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
  const summary = critical.map((v) => `[${v.impact}] ${v.id}: ${v.description} (${v.nodes.length} instance(s))`).join("\n");
  expect(critical, `Axe violations:\n${summary}`).toHaveLength(0);
}

test.describe("Accessibility", () => {
  test("chat page has zero critical/serious axe violations", async ({ page }) => {
    await page.goto("/");
    await page.locator('input[placeholder="Ask a question about your data..."]').waitFor({ timeout: 15_000 });
    await assertNoAxeViolations(page);
  });

  test("admin overview has zero critical/serious axe violations", async ({ page }) => {
    await page.goto("/admin");
    await expect(page.locator("h1", { hasText: "Overview" })).toBeVisible({ timeout: 15_000 });
    await assertNoAxeViolations(page);
  });

  test("admin connections has zero critical/serious axe violations", async ({ page }) => {
    await page.goto("/admin/connections");
    await expect(page.locator("h1", { hasText: "Connections" })).toBeVisible({ timeout: 15_000 });
    // Wait for page content to settle — table, empty state, or error banner
    await expect(
      page.locator("table").or(page.locator("text=No datasource connections")).or(page.locator("[role='alert']:not(#__next-route-announcer__)")),
    ).toBeVisible({ timeout: 10_000 });
    await assertNoAxeViolations(page);
  });

  test("admin audit log has zero critical/serious axe violations", async ({ page }) => {
    await page.goto("/admin/audit");
    await expect(page.locator("h1", { hasText: "Audit Log" })).toBeVisible({ timeout: 15_000 });
    // Wait for page content to settle — table, empty state, or error banner
    await expect(
      page.locator("table").or(page.locator("text=No query activity recorded yet")).or(page.locator("[role='alert']:not(#__next-route-announcer__)")),
    ).toBeVisible({ timeout: 10_000 });
    await assertNoAxeViolations(page);
  });
});
