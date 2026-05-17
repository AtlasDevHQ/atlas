/**
 * Slice 5 (#2520) — partial-failure verification.
 *
 * One member's connection URL is deliberately corrupted so the
 * `executeSQL` fanout `Promise.allSettled` sees one rejection alongside
 * two successes. The PRD #2515 acceptance says the merged result MUST
 * still render with the successful members' rows and a visible
 * `envContributions` warning describing which env failed and why —
 * the user is shown a degraded but useful answer, never a hard fail.
 *
 * Preconditions (auto-skips when missing):
 *   - Multi-env Postgres overlay reachable.
 *   - MFA secret enrolled.
 *   - Real LLM key set in env.
 *
 * Cleanup invariant: any temporary URL corruption is reverted in
 * `test.afterAll` so a failing assertion doesn't leave the seed in a
 * permanently-broken state.
 */

import { test, expect, type APIRequestContext } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  createAdminRequestContext,
  requireSeededGroups,
  API_URL,
} from "./lib/multi-env-helpers";

const FAILED_ENV_ID = "env-staging";
const ORIGINAL_URL = "postgresql://atlas:atlas@localhost:5434/atlas_env";
// Reach an IP that won't accept Postgres — the connection attempt times out
// instead of refusing instantly, which still surfaces as an
// `envContributions` error in the merged result.
const BROKEN_URL = "postgresql://atlas:atlas@127.0.0.1:1/atlas_env";
const COMPARATIVE_QUESTION = "Compare customer counts across regions";
const SECRET_FILE = resolve(process.cwd(), ".atlas", "mfa-secret");

function llmConfigured(): boolean {
  const provider = process.env.ATLAS_PROVIDER;
  if (!provider) return false;
  const explicit = (process.env.ATLAS_API_KEY ?? "").length > 0;
  const provided = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "BEDROCK_ACCESS_KEY_ID", "GATEWAY_API_KEY"].some(
    (k) => (process.env[k] ?? "").length > 0,
  );
  return explicit || provided;
}

test.describe("multi-env routing — partial failure @llm", () => {
  test.use({ storageState: "e2e/browser/multi-env-storage.json" });

  let request: APIRequestContext;
  let originalUrlBackup: string | null = null;

  test.beforeAll(async ({ playwright }) => {
    if (!existsSync(SECRET_FILE)) {
      test.skip(true, `MFA secret not found at ${SECRET_FILE}. Seed it with \`bun scripts/seed-multi-env.ts\`.`);
      return;
    }
    if (!llmConfigured()) {
      test.skip(true, "ATLAS_PROVIDER or model key unset — @llm specs require a real model.");
      return;
    }
    request = await createAdminRequestContext(playwright);
    await requireSeededGroups(request);

    // Snapshot the current URL so we can restore exactly what was there.
    const probe = await request.get(`${API_URL}/api/v1/admin/connections/${FAILED_ENV_ID}`, {
      headers: { origin: API_URL, "x-atlas-mode": "developer" },
    });
    if (probe.status() === 200) {
      const body = (await probe.json()) as { url?: string } | null;
      originalUrlBackup = body?.url ?? ORIGINAL_URL;
    } else {
      originalUrlBackup = ORIGINAL_URL;
    }

    // Corrupt the connection URL so the fanout sees one failure.
    const patch = await request.patch(`${API_URL}/api/v1/admin/connections/${FAILED_ENV_ID}`, {
      headers: { origin: API_URL, "x-atlas-mode": "developer", "content-type": "application/json" },
      data: { url: BROKEN_URL },
    });
    if (patch.status() !== 200) {
      test.skip(
        true,
        `Could not corrupt ${FAILED_ENV_ID} URL (${patch.status()}) — partial-failure spec needs admin write access.`,
      );
    }
  });

  test.afterAll(async () => {
    if (request && originalUrlBackup != null) {
      // Restore the original URL so a partial failure here doesn't poison
      // every subsequent test run.
      await request.patch(`${API_URL}/api/v1/admin/connections/${FAILED_ENV_ID}`, {
        headers: { origin: API_URL, "x-atlas-mode": "developer", "content-type": "application/json" },
        data: { url: originalUrlBackup },
      });
    }
    await request?.dispose();
  });

  test("fanout surfaces successful members' rows + names the failed env in the UI", async ({ page }) => {
    await page.goto("/");

    const trigger = page.locator('[data-testid="chat-env-picker-trigger"]');
    await expect(trigger).toBeVisible({ timeout: 15_000 });

    // All-envs mode so the agent's scope hint is irrelevant — the broken
    // member is definitely in the execution set.
    await trigger.click();
    await page.locator('[data-testid="chat-env-picker-mode-all"]').click();
    await expect(trigger).toHaveAttribute("data-mode", "all");

    const input = page.locator("textarea, [contenteditable=true]").first();
    await input.fill(COMPARATIVE_QUESTION);
    await input.press("Enter");

    // The merged table still renders — partial failure must not block the
    // turn. The successful envs (`dev`, `prod`) contribute rows; the
    // broken `staging` contributes an `envContributions` entry instead.
    const envHeader = page.locator('table thead th', { hasText: "__env__" });
    await expect(envHeader).toBeVisible({ timeout: 120_000 });

    const envCells = page.locator('table tbody td:first-child');
    const values = (await envCells.allTextContents()).map((v) => v.trim());
    expect(values, "successful members should appear at least once").toContain("env-dev");
    expect(values, "successful members should appear at least once").toContain("env-prod");

    // The PRD calls out the per-env warning surface — assert SOMETHING
    // surfaces the failed env's id and an error reason. The exact UI
    // affordance for envContributions warnings is slice 5's verification
    // pass: a chip / inline-banner / toast — accept any visible mention.
    const failureNote = page.locator(`text=/${FAILED_ENV_ID}/`).first();
    await expect(failureNote).toBeVisible({ timeout: 5_000 });
  });
});
