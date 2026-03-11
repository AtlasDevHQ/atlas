import { type Page, expect } from "@playwright/test";

/** Send a chat message and wait for the response to finish streaming. */
export async function askQuestion(page: Page, question: string) {
  const input = page.locator('input[placeholder="Ask a question about your data..."]');
  await input.fill(question);

  // Click the "Ask" button specifically (not any other submit button like password change)
  await page.locator("button", { hasText: "Ask" }).click();

  // Verify streaming started — input becomes disabled while the agent is working
  await expect(input).toBeDisabled({ timeout: 10_000 });

  // Wait for streaming to complete. The input is disabled while streaming, so we
  // wait for it to become re-enabled. We check the input (not the Ask button)
  // because the button remains disabled when the input is empty.
  await expect(input).toBeEnabled({ timeout: 180_000 });
}

/** Wait for a SQL result card to appear in the conversation. */
export async function waitForSQLResult(page: Page) {
  // SQL result cards have a blue "SQL" badge (bg-blue-100 class — update if theme changes)
  await page.locator(".bg-blue-100", { hasText: "SQL" }).first().waitFor({ timeout: 60_000 });
}

/** Start a new chat session. */
export async function startNewChat(page: Page) {
  await page.locator('button:has-text("+ New")').click();

  const input = page.locator('input[placeholder="Ask a question about your data..."]');
  await expect(input).toHaveValue("");
}

/** Navigate to home and ensure chat UI is ready. */
export async function ensureChatReady(page: Page) {
  await page.goto("/");
  await page.locator('input[placeholder="Ask a question about your data..."]').waitFor({ timeout: 15_000 });
}
