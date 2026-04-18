import { test, expect } from "@playwright/test";

/**
 * Admin moderation write-side — per slice #1477.
 *
 * Seeded via the Author form (which skips the pending queue) so this
 * test does not depend on 3 distinct users clicking a suggestion. The
 * flow then exercises the Approve → Hide → Unhide reversibility loop
 * and confirms rows migrate between tabs without a page reload.
 */
test.describe("Starter prompt admin moderation @llm", () => {
  test.describe.configure({ timeout: 90_000, mode: "serial" });

  test("admin authors a prompt, hides it, then unhides it — all without reload", async ({
    page,
  }) => {
    // Distinctive text so we can scope assertions to this row.
    const authoredText = `Moderation e2e ${Date.now()}`;

    // 1. Navigate to the moderation page.
    await page.goto("/admin/starter-prompts");
    await expect(
      page.locator("h1", { hasText: "Starter Prompts" }),
    ).toBeVisible({ timeout: 15_000 });

    // 2. Pending tab is the default. The Author form lives behind a
    //    page-level dialog trigger so the empty state stays clean — open
    //    it before filling.
    const pendingTab = page.getByRole("tab", { name: /^Pending/ });
    await expect(pendingTab).toBeVisible();

    await page.getByTestId("starter-prompt-author-open").click();

    const authorTextarea = page.getByTestId("starter-prompt-author-text");
    await expect(authorTextarea).toBeVisible({ timeout: 10_000 });
    await authorTextarea.fill(authoredText);

    await page.getByTestId("starter-prompt-author-submit").click();

    // 3. Authored rows skip the pending queue — they land in Approved.
    const approvedTab = page.getByRole("tab", { name: /^Approved/ });
    await approvedTab.click();
    const authoredRow = page
      .getByRole("row")
      .filter({ hasText: authoredText });
    await expect(authoredRow).toBeVisible({ timeout: 10_000 });

    // 4. Hide the row from the Approved tab. The button is scoped to the
    //    row via row-id data-testid, so the click targets the right button.
    const hideButton = authoredRow.locator(
      '[data-testid^="starter-prompt-hide-"]',
    );
    await expect(hideButton).toBeVisible();
    await hideButton.click();

    // 5. Row moves off the Approved tab without reload. Switch to Hidden
    //    and confirm it appears there.
    await expect(
      approvedTab
        .page()
        .getByRole("row")
        .filter({ hasText: authoredText }),
    ).toHaveCount(0, { timeout: 10_000 });

    const hiddenTab = page.getByRole("tab", { name: /^Hidden/ });
    await hiddenTab.click();
    const hiddenRow = page
      .getByRole("row")
      .filter({ hasText: authoredText });
    await expect(hiddenRow).toBeVisible({ timeout: 10_000 });

    // 6. Unhide — row returns to the Pending tab (per user story 12:
    //    hide is reversible without losing review history).
    const unhideButton = hiddenRow.locator(
      '[data-testid^="starter-prompt-unhide-"]',
    );
    await unhideButton.click();

    await expect(hiddenRow).toHaveCount(0, { timeout: 10_000 });

    await pendingTab.click();
    const pendingRow = page
      .getByRole("row")
      .filter({ hasText: authoredText });
    await expect(pendingRow).toBeVisible({ timeout: 10_000 });

    // 7. Approve from Pending — row returns to Approved.
    const approveButton = pendingRow.locator(
      '[data-testid^="starter-prompt-approve-"]',
    );
    await approveButton.click();

    await expect(pendingRow).toHaveCount(0, { timeout: 10_000 });
    await approvedTab.click();
    await expect(
      page.getByRole("row").filter({ hasText: authoredText }),
    ).toBeVisible({ timeout: 10_000 });
  });
});
