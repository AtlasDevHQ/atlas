import { test, expect } from "@playwright/test";
import { ensureChatReady } from "./helpers";

/**
 * #4300 — the live working phase. From the moment of send a live activity
 * container is visible (no first-turn dead air, no typing-dots gate), results
 * accumulate collapsed while the agent works (no chart/table expands
 * mid-flight), and the turn settles into the collapsed receipt with the
 * answer as the dominant element.
 */
test.describe("Working phase @llm", () => {
  // LLM turns take 60-120s via gateway; run serially.
  test.describe.configure({ timeout: 300_000, mode: "serial" });

  test.beforeEach(async ({ page }) => {
    await ensureChatReady(page);
  });

  test("activity appears on send, accumulates collapsed, settles into receipt + answer", async ({ page }) => {
    const input = page.locator('textarea[placeholder="Ask a question about your data..."]');

    await input.fill("how many companies are there?");
    await page.getByRole("button", { name: "Send" }).click();

    // The activity container is visible immediately — before the first stream
    // part arrives, on the very first turn of a fresh conversation.
    await expect(page.getByTestId("working-activity")).toBeVisible({ timeout: 3_000 });

    // While the turn is in flight, nothing expands: no promoted artifact, no
    // chart. Sample until the composer unlocks (turn complete) — an expansion
    // mid-flight is the exact regression this slice removes. The loop is
    // bounded by the test timeout. Counts are captured first and re-checked
    // against the composer state, so a stream that finishes between the
    // enabled-probe and the sample (promotion + unlock land in one commit)
    // can't fail the assertion spuriously.
    while (!(await input.isEnabled())) {
      const charts = await page.locator(".recharts-wrapper").count();
      const artifacts = await page.getByTestId("answer-artifact").count();
      if (await input.isEnabled()) break; // finished mid-sample — counts are post-promotion
      expect(charts).toBe(0);
      expect(artifacts).toBe(0);
      await page.waitForTimeout(500);
    }

    // Settled: the working feed is gone; the turn reads receipt + answer.
    await expect(page.getByTestId("working-activity")).toHaveCount(0);
    await expect(page.getByTestId("turn-receipt")).toBeVisible();
    await expect(page.getByTestId("turn-answer")).toBeVisible();

    // The receipt settles collapsed and expands on demand to the full work.
    // (.first() — once expanded, the receipt's cards contribute buttons too.)
    const toggle = page.getByTestId("turn-receipt").getByRole("button").first();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
  });
});
