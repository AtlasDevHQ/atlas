import { test as setup, expect } from "@playwright/test";
import path from "path";

const ADMIN_EMAIL = process.env.ATLAS_ADMIN_EMAIL ?? "admin@atlas.dev";
const DEFAULT_PASSWORD = "atlas-dev";
const E2E_PASSWORD = "atlas-e2e-test!";
const STORAGE_STATE = path.join(__dirname, "storage-state.json");

setup("authenticate as admin", async ({ page }) => {
  await page.goto("/");

  // Wait for login form
  const emailInput = page.locator('input[type="email"]');
  await emailInput.waitFor({ timeout: 15_000 });

  // Try the e2e password first (if password was already changed), then fall back to default
  async function tryLogin(password: string): Promise<boolean> {
    await emailInput.fill(ADMIN_EMAIL);
    await page.locator('input[type="password"]').fill(password);
    await page.locator('button[type="submit"]').click();

    // Wait for either: chat UI loads, or error appears
    const chatInput = page.locator('input[placeholder="Ask a question about your data..."]');
    const errorMsg = page.locator("text=Invalid email or password");

    const result = await Promise.race([
      chatInput.waitFor({ timeout: 10_000 }).then(() => "chat" as const),
      errorMsg.waitFor({ timeout: 10_000 }).then(() => "error" as const),
    ]).catch(() => "timeout" as const);

    return result === "chat";
  }

  // Try e2e password first (already changed from a previous run)
  let loggedIn = await tryLogin(E2E_PASSWORD);

  if (!loggedIn) {
    // Clear the error and try with default password
    await page.goto("/");
    await emailInput.waitFor({ timeout: 15_000 });
    loggedIn = await tryLogin(DEFAULT_PASSWORD);
  }

  if (!loggedIn) {
    throw new Error("Could not login with either e2e or default password");
  }

  // Handle password change dialog if it appears (only on first login with default password)
  const changePasswordTitle = page.locator("text=Change your password");
  if (await changePasswordTitle.isVisible({ timeout: 3_000 }).catch(() => false)) {
    const newPwInput = page.locator('input[placeholder="At least 8 characters"]');
    await newPwInput.fill(E2E_PASSWORD);

    // Confirm password — 3rd password input in the form
    const passwordInputs = page.locator('form input[type="password"]');
    await passwordInputs.nth(2).fill(E2E_PASSWORD);

    await page.locator('button:has-text("Change password")').click();
    await expect(changePasswordTitle).toBeHidden({ timeout: 10_000 });
  }

  // Save storage state
  await page.context().storageState({ path: STORAGE_STATE });
});
