import { type Page, expect } from "@playwright/test";

/** Send a chat message and wait for the response to finish streaming. */
export async function askQuestion(page: Page, question: string) {
  const input = page.locator('input[placeholder="Ask a question about your data..."]');
  await input.fill(question);

  // Click the "Ask" button specifically (not any other submit button like password change)
  await page.locator("button", { hasText: "Ask" }).click();

  // Wait for streaming to complete. The input is disabled while streaming
  // (isLoading = status === "streaming" || status === "submitted"), so we wait
  // for the input to become enabled again. Note: the Ask *button* stays disabled
  // after streaming because the input is empty — so we check the input instead.
  await expect(input).toBeEnabled({ timeout: 180_000 });
}

/** Wait for a SQL result card to appear in the conversation. */
export async function waitForSQLResult(page: Page) {
  // SQL result cards have a blue "SQL" badge
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
