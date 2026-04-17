import { test as setup, expect } from "@playwright/test";
import path from "path";

const ADMIN_EMAIL = process.env.ATLAS_ADMIN_EMAIL ?? "admin@useatlas.dev";
const DEFAULT_PASSWORD = "atlas-dev";
const E2E_PASSWORD = "atlas-e2e-test!";
const STORAGE_STATE = path.join(__dirname, "storage-state.json");

setup("authenticate as admin", async ({ page }) => {
  await page.goto("/");

  // Dismiss the guided tour if it appears before login (fresh DB — tour overlay
  // covers the viewport and blocks the login form below it)
  async function dismissTourIfVisible() {
    const skipTourBtn = page.locator('button:has-text("Skip tour")');
    if (await skipTourBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      try {
        await skipTourBtn.click();
        await skipTourBtn.waitFor({ state: "hidden", timeout: 5_000 });
      } catch (err) {
        // Best-effort dismissal — downstream assertions will catch real problems
        console.debug("[setup] could not dismiss tour:", err instanceof Error ? err.message : String(err));
      }
    }
  }

  await dismissTourIfVisible();

  const emailInput = page.locator('input[type="email"]');
  await emailInput.waitFor({ timeout: 15_000 });

  // Try the e2e password first (if password was already changed), then fall back to default
  async function tryLogin(password: string): Promise<boolean> {
    await dismissTourIfVisible();
    await emailInput.fill(ADMIN_EMAIL);
    await page.locator('input[type="password"]').fill(password);
    await dismissTourIfVisible();
    await page.locator('button[type="submit"]').click();

    // Wait for either: chat UI loads, or error appears (locator.or avoids dangling promises)
    const chatInput = page.locator('input[placeholder="Ask a question about your data..."]');
    const errorMsg = page.locator("text=Invalid email or password");
    const outcome = chatInput.or(errorMsg);

    try {
      await outcome.waitFor({ timeout: 10_000 });
    } catch (err) {
      if (err instanceof Error && err.message.includes("Timeout")) {
        return false;
      }
      throw err;
    }

    return await chatInput.isVisible();
  }

  let loggedIn = await tryLogin(E2E_PASSWORD);
  let usedDefaultPassword = false;

  if (!loggedIn) {
    // Clear the error and try with default password
    await page.goto("/");
    await emailInput.waitFor({ timeout: 15_000 });
    loggedIn = await tryLogin(DEFAULT_PASSWORD);
    usedDefaultPassword = loggedIn;
  }

  if (!loggedIn) {
    throw new Error(
      `Could not login with either e2e or default password. ` +
      `Admin email: ${ADMIN_EMAIL}. ` +
      `Ensure the dev server is running and the account exists.`,
    );
  }

  // When login succeeded with the default password, rotate it to E2E_PASSWORD so
  // all subsequent tests can log in deterministically. The UI may or may not
  // surface a "Change your password" dialog depending on session state — call
  // the admin API directly so we don't depend on that UI flow.
  if (usedDefaultPassword) {
    const res = await page.request.post("/api/v1/admin/me/password", {
      data: { currentPassword: DEFAULT_PASSWORD, newPassword: E2E_PASSWORD },
    });
    if (!res.ok()) {
      throw new Error(
        `Failed to rotate admin password from default to e2e via API. ` +
        `Status: ${res.status()}. Body: ${await res.text()}`,
      );
    }
    // If the rotation dialog is modal-blocking the app, dismiss it now — it should
    // auto-close once the password_change_required flag is cleared, but be defensive.
    const changeDialog = page.locator("text=Change your password");
    if (await changeDialog.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await page.reload();
      await page.locator('input[placeholder="Ask a question about your data..."]').waitFor({ timeout: 15_000 });
    }
  }

  // Dismiss the guided tour if it appears (fresh DB / first login)
  await dismissTourIfVisible();

  await page.context().storageState({ path: STORAGE_STATE });
});
