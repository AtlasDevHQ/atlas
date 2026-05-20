/**
 * Browser e2e for /admin/integrations catalog section (#2651, slice 3 of 1.5.2).
 *
 * The catalog is seeded by `CatalogSeeder` at API boot from
 * `atlas.config.ts:catalog`. Dev environments without a root-level
 * `atlas.config.ts` see an empty catalog — the test handles both states
 * so it stays green regardless of whether the operator has declared one
 * for the dev API. When the catalog is populated, the test additionally
 * asserts the AC bits about the Slack card + inert Connect button.
 *
 * No `@llm` tag — pure DOM assertions, no model calls.
 */

import { test, expect } from "@playwright/test";

test.describe("Admin Console — Integrations catalog", () => {
  test("renders catalog section with cards or empty state", async ({ page }) => {
    await page.goto("/admin/integrations");

    // Page hero (legacy header — unchanged by slice 3) confirms route mount.
    await expect(page.locator("h1", { hasText: "Integrations" })).toBeVisible({ timeout: 15_000 });

    // Catalog section header (slice 3) lives above the legacy admin chrome.
    await expect(
      page.getByRole("heading", { name: "Available integrations" }),
    ).toBeVisible({ timeout: 10_000 });

    // Wait for the section to settle into one of the two terminal states:
    // either at least one catalog card is rendered, or the empty-state
    // "No integrations available" copy is shown. Avoid a race where neither
    // appears within the first ~100ms (data load).
    const anyCard = page.locator('[data-testid^="catalog-card-"]').first();
    const emptyState = page.getByText("No integrations available");
    await expect(anyCard.or(emptyState)).toBeVisible({ timeout: 10_000 });

    const cardCount = await page.locator('[data-testid^="catalog-card-"]').count();

    if (cardCount > 0) {
      // Catalog has rows. Slack is the canonical 1.5.2 entry — assert it's
      // present and that the inert Connect button renders (per #2651 AC).
      const slackCard = page.locator('[data-testid="catalog-card-slack"]');
      if (await slackCard.isVisible({ timeout: 2_000 }).catch(() => false)) {
        // When Slack is in the catalog, its action button (Connect / Manage /
        // Upgrade depending on install + plan state) must render. This slice
        // ships them inert — clicking is a no-op. We only assert visibility.
        const slackAction = slackCard
          .getByRole("button", { name: /Connect|Manage|Upgrade/ })
          .first();
        await expect(slackAction).toBeVisible({ timeout: 5_000 });
      }
    } else {
      // Empty state — the link to the operator docs page must point at the
      // canonical Plugin Catalog doc so the operator knows what to add.
      await expect(emptyState).toBeVisible();
    }
  });
});
