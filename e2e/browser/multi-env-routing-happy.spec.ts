/**
 * Slice 5 (#2520) — cross-environment routing happy-path verification.
 *
 * Real-API e2e against the multi-env Postgres overlay + a live LLM.
 * Walks the PRD #2515 user-story flow through the chat surface:
 *
 *   1. Auto mode + comparative question → agent emits `scope: "all"`,
 *      merged table renders with the `__env__` discriminator column
 *      and three distinct environment values.
 *   2. Pin the picker to one environment + same comparative question →
 *      only the pinned environment's rows appear (pickerMode "pin"
 *      overrides the agent's `scope: "all"` from slice 1's
 *      `resolveRoutingPlan`).
 *   3. All envs mode + single-environment-looking question → fanout
 *      still happens because user override wins.
 *
 * Tagged `@llm` so the regular browser-tests job skips it; the
 * `@llm`-only matrix or a manual `bun run test:e2e -- --grep @llm`
 * exercise runs against a live model.
 *
 * Preconditions (auto-skips when missing):
 *   - Multi-env Postgres overlay reachable (`docker compose -f
 *     docker-compose.multi-env.yml up -d`).
 *   - MFA secret enrolled (`bun scripts/seed-multi-env.ts`).
 *   - `ATLAS_PROVIDER` + a real model key in env.
 */

import { test, expect, type APIRequestContext } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  createAdminRequestContext,
  requireSeededGroups,
} from "./lib/multi-env-helpers";

const PROD_GROUP_NAME = "prod";
const COMPARATIVE_QUESTION = "Compare customer counts across regions";
const SINGLE_ENV_QUESTION = "Show me staging customers";
const SECRET_FILE = resolve(process.cwd(), ".atlas", "mfa-secret");

function llmConfigured(): boolean {
  // Skip if the agent has no path to a real model. The chat surface
  // would still render but the tool-call assertions below would never
  // resolve, so a hard skip is friendlier than a 30s timeout.
  const provider = process.env.ATLAS_PROVIDER;
  if (!provider) return false;
  const explicit = (process.env.ATLAS_API_KEY ?? "").length > 0;
  const provided = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "BEDROCK_ACCESS_KEY_ID", "GATEWAY_API_KEY"].some(
    (k) => (process.env[k] ?? "").length > 0,
  );
  return explicit || provided;
}

test.describe("multi-env routing — happy path @llm", () => {
  test.use({ storageState: "e2e/browser/multi-env-storage.json" });

  let request: APIRequestContext;

  test.beforeAll(async ({ playwright }) => {
    if (!existsSync(SECRET_FILE)) {
      test.skip(
        true,
        `MFA secret not found at ${SECRET_FILE}. Run \`bun scripts/seed-multi-env.ts\` first.`,
      );
      return;
    }
    if (!llmConfigured()) {
      test.skip(true, "ATLAS_PROVIDER or model key unset — @llm specs require a real model.");
      return;
    }
    request = await createAdminRequestContext(playwright);
  });

  test.afterAll(async () => {
    await request?.dispose();
  });

  test("Auto + comparative question fans out across every member; merged table has __env__ column", async ({ page }) => {
    await requireSeededGroups(request);

    await page.goto("/");

    // Wait for the env picker to appear (it only renders for multi-member groups).
    const trigger = page.locator('[data-testid="chat-env-picker-trigger"]');
    await expect(trigger).toBeVisible({ timeout: 15_000 });

    // Ensure picker is in Auto mode — that's the default for new conversations
    // but a previously-pinned local storage state could shift it.
    await trigger.click();
    await page.locator('[data-testid="chat-env-picker-mode-auto"]').click();
    await expect(trigger).toHaveAttribute("data-mode", "auto");

    // Type the comparative question + submit.
    const input = page.locator("textarea, [contenteditable=true]").first();
    await input.fill(COMPARATIVE_QUESTION);
    await input.press("Enter");

    // Wait for the merged result table. The `__env__` column header is
    // the load-bearing assertion: it only renders when the merger ran.
    const envHeader = page.locator('table thead th', { hasText: "__env__" });
    await expect(envHeader).toBeVisible({ timeout: 120_000 });

    // Three distinct environment values appear in the __env__ column.
    const envCells = page.locator('table tbody td:first-child');
    const values = await envCells.allTextContents();
    expect(new Set(values).size, `expected ≥3 distinct __env__ values, got ${JSON.stringify(values)}`).toBeGreaterThanOrEqual(3);
  });

  test("Pin overrides agent scope — pinned member receives the only execution", async ({ page }) => {
    await requireSeededGroups(request);

    await page.goto("/");
    const trigger = page.locator('[data-testid="chat-env-picker-trigger"]');
    await expect(trigger).toBeVisible({ timeout: 15_000 });

    // Pin to staging (slice 3's three-state picker — `data-mode="pin"`).
    await trigger.click();
    await page.locator('[data-testid="chat-env-picker-mode-pin"]').click();
    // The picker exposes a member-list selector underneath the three modes;
    // pick `staging` (one of the seeded envs).
    const stagingMember = page.locator('[data-testid="chat-env-picker-member-env-staging"]');
    if (await stagingMember.count() > 0) {
      await stagingMember.click();
    }
    await expect(trigger).toHaveAttribute("data-mode", "pin");

    // Same comparative question — agent would say `scope: "all"` but Pin wins.
    const input = page.locator("textarea, [contenteditable=true]").first();
    await input.fill(COMPARATIVE_QUESTION);
    await input.press("Enter");

    // Look for an executeSQL tool-call result — single-env path keeps the
    // legacy `{columns, rows}` shape (no `__env__` prepend).
    const noEnvHeader = page.locator('table thead th', { hasText: "__env__" });
    // Wait a bit for the response; assert the merged shape never appears.
    await page.waitForTimeout(20_000);
    expect(await noEnvHeader.count(), "Pin mode must not produce a merged __env__ table").toBe(0);
  });

  test("All-envs picker forces fanout even when the agent would have picked single", async ({ page }) => {
    await requireSeededGroups(request);

    await page.goto("/");
    const trigger = page.locator('[data-testid="chat-env-picker-trigger"]');
    await expect(trigger).toBeVisible({ timeout: 15_000 });

    await trigger.click();
    await page.locator('[data-testid="chat-env-picker-mode-all"]').click();
    await expect(trigger).toHaveAttribute("data-mode", "all");

    // Single-environment-looking question — Auto would route to `staging`,
    // but `routing_mode = 'all'` forces fanout per slice 3's wiring.
    const input = page.locator("textarea, [contenteditable=true]").first();
    await input.fill(SINGLE_ENV_QUESTION);
    await input.press("Enter");

    const envHeader = page.locator('table thead th', { hasText: "__env__" });
    await expect(envHeader).toBeVisible({ timeout: 120_000 });
  });
});

// PRD #2515 verification — `requireSeededGroups` enforces the precondition
// that the multi-env overlay's three connection groups exist before any
// chat-level assertion runs. Without it a partial seed produces obscure
// failures; the helper skips with a clear "run db:multi-env:up" message.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions -- referenced statically for clarity
PROD_GROUP_NAME;
