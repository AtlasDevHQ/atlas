import { test, expect } from "@playwright/test";
import { dismissTourIfVisible } from "./helpers";

/**
 * Notebook new-cell empty state — adaptive starter prompts.
 *
 * The notebook opens on a fresh conversation with zero cells. The empty
 * state must call `/api/v1/starter-prompts` and render the returned list
 * using the same surface as the chat empty state (provenance badges,
 * ordering preserved, id namespacing). Clicking a prompt inserts the
 * question as the first cell.
 *
 * We mock `/api/v1/starter-prompts` rather than relying on the real
 * server response so the ordering + provenance assertions are
 * deterministic across environments.
 */
test.describe("Notebook new-cell starter prompts", () => {
  test("renders mocked API response with correct ordering and provenance", async ({ page }) => {
    // Ordering is part of the contract — favorite → popular → library.
    // Provenance-specific UI: Pin icon (favorite), Popular badge (popular),
    // no decoration (library). Matching these three tiers exercises every
    // render path StarterPromptList exposes.
    await page.route("**/api/v1/starter-prompts**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          prompts: [
            { id: "favorite:p1", text: "What are my pinned metrics?", provenance: "favorite" },
            { id: "popular:p2", text: "What are team favorites this week?", provenance: "popular" },
            { id: "library:p3", text: "Show me revenue by month", provenance: "library" },
          ],
          total: 3,
        }),
      });
    });

    await page.goto("/notebook");
    await dismissTourIfVisible(page);

    // The notebook page shows a loading state before auth resolves; wait for
    // the empty-state heading so we know the starter prompts had a chance to
    // render.
    await expect(
      page.getByRole("heading", { name: "Start your analysis" }),
    ).toBeVisible({ timeout: 15_000 });

    // Ordering: the chip DOM order matches the response order.
    const chips = page
      .locator('[data-testid^="starter-prompt-"]')
      // The unpin button carries data-testid="unpin-favorite"; the Popular
      // badge carries data-testid="starter-prompt-popular-badge". Filter to
      // just the row wrappers to assert ordering cleanly.
      .locator(':scope[data-testid^="starter-prompt-"]:not([data-testid="starter-prompt-popular-badge"])');
    await expect(chips).toHaveCount(3, { timeout: 10_000 });
    await expect(chips.nth(0)).toHaveAttribute("data-testid", "starter-prompt-favorite");
    await expect(chips.nth(1)).toHaveAttribute("data-testid", "starter-prompt-popular");
    await expect(chips.nth(2)).toHaveAttribute("data-testid", "starter-prompt-library");

    // Provenance badges — Popular label only on the popular row.
    const popularBadges = page.getByTestId("starter-prompt-popular-badge");
    await expect(popularBadges).toHaveCount(1);
    await expect(popularBadges.first()).toHaveText("Popular");

    // Chip text matches the mock payload.
    await expect(page.getByText("What are my pinned metrics?")).toBeVisible();
    await expect(page.getByText("What are team favorites this week?")).toBeVisible();
    await expect(page.getByText("Show me revenue by month")).toBeVisible();
  });

  test("clicking a prompt inserts the question into a new cell", async ({ page }) => {
    await page.route("**/api/v1/starter-prompts**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          prompts: [
            { id: "library:q1", text: "Count orders by status", provenance: "library" },
          ],
          total: 1,
        }),
      });
    });

    // Mock the chat endpoint so this test doesn't require an LLM.
    // The useChat transport sends the user message to /api/v1/chat; we reply
    // with a minimal data-stream payload so the stream closes cleanly.
    await page.route("**/api/v1/chat", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "x-conversation-id": "mock-conv-1" },
        contentType: "text/event-stream",
        // A bare close frame is enough — the user cell renders from client state
        // the moment sendMessage fires; we just need the stream not to hang.
        body: "",
      });
    });

    await page.goto("/notebook");
    await dismissTourIfVisible(page);

    const chip = page.getByRole("button", { name: "Count orders by status" });
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await chip.click();

    // The clicked prompt text becomes the first cell's user message. The
    // empty state disappears and a cell with the prompt text renders.
    await expect(
      page.getByRole("heading", { name: "Start your analysis" }),
    ).toBeHidden({ timeout: 10_000 });
    // Cells render under role="region" with aria-label "Cell N". The prompt
    // text appears inside the cell input display.
    await expect(
      page.locator('[role="region"][aria-label="Cell 1"]'),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.locator('[role="region"][aria-label="Cell 1"]').getByText("Count orders by status"),
    ).toBeVisible();
  });
});
