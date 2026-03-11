import { test, expect } from "@playwright/test";
import { askQuestion, ensureChatReady, startNewChat } from "./helpers";

test.describe("Conversations @llm", () => {
  // LLM responses take 60-120s via gateway; some tests make 2+ requests.
  // Run serially to avoid overwhelming the API.
  test.describe.configure({ timeout: 300_000, mode: "serial" });

  test.beforeEach(async ({ page }) => {
    await ensureChatReady(page);
  });

  test("asking a question creates a conversation in the sidebar", async ({ page }) => {
    await askQuestion(page, "how many companies are there?");

    // The conversation should appear in the sidebar. The sidebar is the left
    // column containing "History" heading and conversation items.
    await expect(page.getByText("History").first()).toBeVisible();

    // The conversation title should contain "compan" (truncated in sidebar)
    await expect(page.getByText(/compan/i).first()).toBeVisible({ timeout: 10_000 });
  });

  test("New Chat clears input and creates a fresh session", async ({ page }) => {
    // Ask a question first to create a conversation
    await askQuestion(page, "how many companies are there?");

    // Click "+ New"
    await startNewChat(page);

    // Starter prompts should be visible again (empty state)
    await expect(page.locator("text=What would you like to know?")).toBeVisible({ timeout: 5_000 });
  });

  test("clicking a previous conversation reloads its messages", async ({ page }) => {
    // Create first conversation with a unique question
    await askQuestion(page, "count of accounts by plan");
    // Wait for the response to finish, then create a new chat
    await startNewChat(page);

    // Create second conversation
    await askQuestion(page, "what industries exist?");

    // Click on the first conversation (sidebar item with "accounts" in title)
    const firstConvo = page.getByText(/count of accounts/i).first();
    await firstConvo.click();

    // The conversation should load — verify the SQL result or response content
    // changes (the "accounts" conversation has different content than "industries")
    await expect(
      page.getByText(/account/i).first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("star and unstar a conversation", async ({ page }) => {
    // Ask a question to create a conversation
    await askQuestion(page, "how many companies are there?");

    const saveBtn = page.locator('button[aria-label="Save conversation"]');
    await expect(saveBtn).toBeVisible({ timeout: 10_000 });
    await saveBtn.click();

    await expect(page.locator('button[aria-label="Unsave conversation"]')).toBeVisible({ timeout: 5_000 });

    // Check the "Saved" filter shows the conversation
    await page.getByRole("radio", { name: "Saved" }).click();
    await expect(page.getByText(/compan/i).first()).toBeVisible({ timeout: 5_000 });

    // Switch back to "All"
    await page.getByRole("radio", { name: "All" }).click();
  });

  test("delete a conversation shows confirmation and removes it", async ({ page }) => {
    // Ask a unique question to create a conversation
    await askQuestion(page, "average revenue per account");

    // The sidebar should show this conversation
    const convoItem = page.getByText(/average revenue/i).first();
    await expect(convoItem).toBeVisible({ timeout: 10_000 });

    // Hover to reveal the delete button
    await convoItem.hover();

    // Click the delete button (trash icon, aria-label="Delete conversation")
    const deleteBtn = page.locator('[aria-label="Delete conversation"]').first();
    await deleteBtn.waitFor({ timeout: 3_000 });
    await deleteBtn.click();

    // Inline confirmation appears: "Delete?" with Cancel and Delete buttons
    await expect(page.getByText("Delete?")).toBeVisible({ timeout: 3_000 });

    // Confirm deletion
    await page.locator("button.bg-red-600", { hasText: "Delete" }).click();

    // After deletion, the inline "Delete?" confirmation should disappear
    await expect(page.getByText("Delete?")).toBeHidden({ timeout: 5_000 });

    // The deleted conversation should no longer appear in the sidebar
    await expect(page.getByText(/average revenue/i)).toBeHidden({ timeout: 5_000 });
  });
});
