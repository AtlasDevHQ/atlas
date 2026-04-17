import { test, expect } from "@playwright/test";
import { askQuestion, ensureChatReady, startNewChat } from "./helpers";

/**
 * Per-user favorites — pin → persist → unpin flow.
 *
 * User asks a question (creating a user-authored chat message), hovers to
 * reveal the pin affordance, pins it, starts a new chat, confirms the pin
 * shows in the empty-state grid with its Pin icon, reloads the page
 * (proving the pin is server-persisted, not just optimistic state), and
 * unpins from the empty state itself.
 */
test.describe("Starter prompt favorites @llm", () => {
  // Pin/unpin requests are fast, but this test makes a real agent call
  // first so the test gets a user-authored message to pin.
  test.describe.configure({ timeout: 300_000, mode: "serial" });

  test.beforeEach(async ({ page }) => {
    await ensureChatReady(page);
  });

  test("pin a user message, reload, see it in empty state, then unpin", async ({ page }) => {
    // Use a question distinctive enough to assert uniquely in the empty state.
    const pinText = "How many companies are in the accounts table?";

    // 1. Ask — creates a user-authored chat message.
    await askQuestion(page, pinText);

    // 2. Hover the user message bubble to reveal the pin affordance.
    const userMsg = page.getByRole("article", { name: "Message from you" }).first();
    await userMsg.hover();

    const pinBtn = userMsg.getByTestId("pin-user-message");
    await expect(pinBtn).toBeVisible({ timeout: 5_000 });
    await pinBtn.click();

    // 3. Pin should succeed — transient "Pinned as starter prompt." banner.
    await expect(page.getByText("Pinned as starter prompt.")).toBeVisible({
      timeout: 5_000,
    });

    // 4. Start a new chat — empty state should include the new favorite.
    await startNewChat(page);

    // Favorite rows are marked with data-testid starter-prompt-favorite and
    // a visible Pin icon. Narrow to that tier so we don't accidentally match
    // a library or popular prompt.
    const favoriteRow = page
      .getByTestId("starter-prompt-favorite")
      .filter({ hasText: pinText });
    await expect(favoriteRow).toBeVisible({ timeout: 10_000 });

    // 5. Reload — the pin must persist to the server, not just live in
    //    client state, so a fresh session sees the same favorite.
    await page.reload();
    await ensureChatReady(page);

    const favoriteRowAfterReload = page
      .getByTestId("starter-prompt-favorite")
      .filter({ hasText: pinText });
    await expect(favoriteRowAfterReload).toBeVisible({ timeout: 10_000 });

    // 6. Unpin from the empty state.
    await favoriteRowAfterReload.hover();
    const unpinBtn = favoriteRowAfterReload.getByTestId("unpin-favorite");
    await expect(unpinBtn).toBeVisible({ timeout: 5_000 });
    await unpinBtn.click();

    // Favorite disappears from the grid without a page reload.
    await expect(favoriteRowAfterReload).toBeHidden({ timeout: 5_000 });

    // Sanity: reload one more time to confirm the unpin was server-side.
    await page.reload();
    await ensureChatReady(page);
    const reloadedGone = page
      .getByTestId("starter-prompt-favorite")
      .filter({ hasText: pinText });
    await expect(reloadedGone).toHaveCount(0, { timeout: 10_000 });
  });
});
