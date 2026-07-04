import { test, expect } from "@playwright/test";
import { askQuestion, ensureChatReady } from "./helpers";

/**
 * #4296 — copy button on assistant answers. A finished turn's answer exposes
 * a "Copy answer" affordance (hover-revealed on desktop) that writes the
 * answer's markdown SOURCE to the clipboard with the <suggestions> block
 * stripped — the follow-up chips render separately and must never ride along.
 */
test.describe("Copy answer @llm", () => {
  // LLM turns take 60-120s via gateway.
  test.describe.configure({ timeout: 300_000, mode: "serial" });

  test.beforeEach(async ({ page }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await ensureChatReady(page);
  });

  test("copying an answer puts its text on the clipboard without suggestions markup", async ({ page }) => {
    await askQuestion(page, "how many companies are there?");

    // The finished answer is on screen; the copy button starts hover-hidden
    // on desktop. Playwright's toBeVisible() ignores opacity, so pin the
    // reveal via computed style: 0 before hover, 1 after (toHaveCSS retries,
    // letting the transition settle).
    const answer = page.getByTestId("turn-answer").last();
    await expect(answer).toBeVisible({ timeout: 10_000 });

    const copyButton = page.getByRole("button", { name: "Copy answer" });
    await expect(copyButton.locator("..")).toHaveCSS("opacity", "0");
    await answer.hover();
    await expect(copyButton.locator("..")).toHaveCSS("opacity", "1");
    await copyButton.click();

    // The existing CopyButton feedback confirms the write went through.
    await expect(page.getByRole("button", { name: "Copied!" })).toBeVisible({ timeout: 5_000 });

    // The root tsconfig (which type-checks e2e/) has no DOM lib, and
    // @types/node's Navigator lacks `clipboard` — narrow the browser-side
    // global explicitly.
    const clipboard = await page.evaluate(() =>
      (navigator as unknown as { clipboard: { readText(): Promise<string> } }).clipboard.readText(),
    );

    // The clipboard holds the answer, not the suggestions markup.
    expect(clipboard.trim().length).toBeGreaterThan(0);
    expect(clipboard).not.toContain("<suggestions>");
    expect(clipboard).not.toContain("</suggestions>");

    // And it is THIS answer: the copied markdown source and the rendered
    // answer share vocabulary even after markdown formatting is applied.
    const rendered = (await answer.textContent()) ?? "";
    const words = clipboard.split(/\s+/).filter((w) => /^[a-zA-Z]{5,}$/.test(w));
    expect(words.length).toBeGreaterThan(0);
    expect(words.some((w) => rendered.includes(w))).toBe(true);
  });
});
