import { test, expect } from "@playwright/test";
import { ensureChatReady } from "./helpers";

/**
 * #4295 — the multiline composer. Shift+Enter inserts a newline (and the
 * textarea grows to show it), growth caps at max-h-40 (160px) with inner
 * scroll, and Enter sends the whole two-line message as one user turn. The
 * non-send assertions (value, growth, cap) run before the send so they cost
 * no LLM tokens if they fail.
 */
test.describe("Multiline composer @llm", () => {
  // The send is a real agent turn; LLM turns take 60-120s via gateway.
  test.describe.configure({ timeout: 300_000 });

  test("Shift+Enter produces a two-line message; Enter sends it", async ({ page }) => {
    await ensureChatReady(page);
    const composer = page.locator('textarea[placeholder="Ask a question about your data..."]');

    await composer.fill("how many companies are there?");
    const singleLineBox = await composer.boundingBox();
    expect(singleLineBox, "composer must be visible before Shift+Enter").not.toBeNull();

    await composer.press("Shift+Enter");
    await composer.pressSequentially("answer in one short sentence.");

    // Shift+Enter inserted a literal newline — one value, two lines.
    await expect(composer).toHaveValue(
      "how many companies are there?\nanswer in one short sentence.",
    );

    // The composer grew to fit the second line (auto-grow, not inner scroll).
    const twoLineBox = await composer.boundingBox();
    expect(twoLineBox).not.toBeNull();
    expect(twoLineBox!.height).toBeGreaterThan(singleLineBox!.height);

    // Growth caps at max-h-40 (160px), after which the textarea scrolls
    // instead of eating the viewport.
    for (let i = 0; i < 12; i++) await composer.press("Shift+Enter");
    const cappedBox = await composer.boundingBox();
    expect(cappedBox).not.toBeNull();
    expect(cappedBox!.height).toBeLessThanOrEqual(161);
    expect(
      await composer.evaluate((el) => el.scrollHeight > el.clientHeight),
      "content beyond the cap must scroll inside the textarea",
    ).toBe(true);

    // Restore the two-line message for the send.
    await composer.fill("how many companies are there?\nanswer in one short sentence.");

    // Enter sends the two-line message as ONE user turn. Playwright's text
    // matcher normalizes the newline to a space, so a single-locator hit on
    // the joined text shows both lines landed together (the toHaveValue
    // assertion above is what rules out a split send).
    await composer.press("Enter");
    await expect(
      page.getByText("how many companies are there? answer in one short sentence."),
    ).toBeVisible({ timeout: 10_000 });

    // The composer cleared, shrank back to a single line, and locked for the
    // streaming turn…
    await expect(composer).toHaveValue("");
    const clearedBox = await composer.boundingBox();
    expect(clearedBox).not.toBeNull();
    expect(clearedBox!.height).toBe(singleLineBox!.height);
    await expect(composer).toBeDisabled({ timeout: 10_000 });

    // …and unlocks when the turn completes, leaving a clean state behind.
    await expect(composer).toBeEnabled({ timeout: 180_000 });
  });
});
