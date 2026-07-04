import { test, expect } from "@playwright/test";
import { ensureChatReady } from "./helpers";

/**
 * #4294 — the Stop control. While a turn streams, the composer's send slot
 * becomes a Stop button; clicking it aborts the stream, unlocks the composer
 * immediately (no waiting out the agent-loop budget), renders no error banner,
 * and leaves the conversation ready for the next send.
 */
test.describe("Stop button @llm", () => {
  // One test makes two agent requests; LLM turns take 60-120s via gateway.
  test.describe.configure({ timeout: 300_000, mode: "serial" });

  test.beforeEach(async ({ page }) => {
    await ensureChatReady(page);
  });

  test("stopping an in-flight turn unlocks the composer and the next send succeeds", async ({ page }) => {
    const input = page.locator('input[placeholder="Ask a question about your data..."]');

    await input.fill("how many companies are there?");
    await page.getByRole("button", { name: "Send" }).click();

    // While the agent works, the send slot is a Stop control.
    const stopButton = page.getByRole("button", { name: "Stop" });
    await expect(stopButton).toBeVisible({ timeout: 10_000 });
    await stopButton.click();

    // The composer unlocks immediately — the whole point: no 180s wait.
    await expect(input).toBeEnabled({ timeout: 5_000 });
    await expect(stopButton).not.toBeVisible();

    // A deliberate stop is not an error: neither the empty-stream inline box
    // nor the error banner may appear.
    await expect(
      page.getByText("The response stream was interrupted before producing content"),
    ).not.toBeVisible();

    // The stopped conversation accepts the next message and completes normally.
    await input.fill("how many companies are there?");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(input).toBeDisabled({ timeout: 10_000 });
    await expect(input).toBeEnabled({ timeout: 180_000 });
  });
});
