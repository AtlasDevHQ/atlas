import { test, expect, type APIRequestContext } from "@playwright/test";
import {
  createAdminRequestContext,
  requireSeededGroups,
} from "./lib/multi-env-helpers";

/**
 * Real-API e2e — three-state Auto/Pin/All routing-mode picker (PRD
 * #2515, slice 3 issue #2518).
 *
 * Exercises the picker UI integration end-to-end against the multi-env
 * seed. The unit coverage in `env-picker.test.tsx` locks the component
 * behavior; this layer is the "everything wired together" smoke that
 * catches:
 *
 *   - The picker actually surfaces the three modes in the dropdown
 *     (data-testid hooks survive Tailwind / shadcn refactors).
 *   - Toggling modes updates the trigger's `data-mode` attribute —
 *     proof that the `routingMode` state flows back through `onSelect`.
 *   - The 1×1-group hide-rule from #2408 isn't accidentally broken by
 *     the slice's UI restructuring.
 *
 * Tagged `@llm` because the spec opens a real chat surface; the test
 * doesn't send a message so we don't burn an LLM budget, but the
 * picker only renders inside the same auth-gated chat shell the
 * `@llm` suite exercises.
 */

// Previously tagged `@llm` because the picker renders inside an
// auth-gated chat shell — but the spec sends no messages, so a real
// model isn't required. Re-tagged so the picker UI smoke runs in the
// default browser-tests matrix and not just the LLM-budgeted job; a
// picker-regression should surface on every PR, not only LLM CI.
test.describe("multi-env routing-mode picker", () => {
  test.use({ storageState: "e2e/browser/multi-env-storage.json" });

  let request: APIRequestContext;

  test.beforeAll(async ({ playwright }) => {
    request = await createAdminRequestContext(playwright);
  });

  test.afterAll(async () => {
    await request?.dispose();
  });

  test("picker exposes Auto / Pin / All-envs modes and the trigger reflects the selection", async ({ page }) => {
    // Multi-env seed is the precondition — the picker hides on a 1×1
    // workspace so without `prod` we can't assert anything meaningful.
    await requireSeededGroups(request);

    await page.goto("/");

    // The picker only renders alongside the share dialog once a
    // conversation exists OR when the env picker has multi-env data.
    // Wait for the trigger to show up.
    const trigger = page.locator('[data-testid="chat-env-picker-trigger"]');
    await expect(trigger).toBeVisible({ timeout: 15_000 });

    // Open the dropdown — all three mode rows must be present.
    await trigger.click();
    await expect(page.locator('[data-testid="chat-env-picker-mode-auto"]')).toBeVisible();
    await expect(page.locator('[data-testid="chat-env-picker-mode-pin"]')).toBeVisible();
    await expect(page.locator('[data-testid="chat-env-picker-mode-all"]')).toBeVisible();

    // Pick Auto. The dropdown closes, the trigger's data-mode updates,
    // and the chip label reads "Auto · <group>".
    await page.locator('[data-testid="chat-env-picker-mode-auto"]').click();
    await expect(trigger).toHaveAttribute("data-mode", "auto");
    await expect(page.locator('[data-testid="chat-env-picker-label"]')).toContainText("Auto");

    // Pick All envs.
    await trigger.click();
    await page.locator('[data-testid="chat-env-picker-mode-all"]').click();
    await expect(trigger).toHaveAttribute("data-mode", "all");
    await expect(page.locator('[data-testid="chat-env-picker-label"]')).toContainText("All");

    // Pick Pin — back to the legacy single-member behavior.
    await trigger.click();
    await page.locator('[data-testid="chat-env-picker-mode-pin"]').click();
    await expect(trigger).toHaveAttribute("data-mode", "pin");
  });
});
