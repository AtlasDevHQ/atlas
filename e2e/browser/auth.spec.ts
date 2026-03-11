import { test, expect } from "@playwright/test";

const ADMIN_EMAIL = process.env.ATLAS_ADMIN_EMAIL ?? "admin@atlas.dev";
// After global setup, the password may have been changed from the default
const ADMIN_PASSWORD = process.env.ATLAS_ADMIN_PASSWORD ?? "atlas-e2e-test!";

/** Login helper — fills email/password and submits, then handles password change dialog if shown. */
async function login(page: import("@playwright/test").Page, email: string, password: string) {
  const emailInput = page.locator('input[type="email"]');
  await emailInput.waitFor({ timeout: 15_000 });
  await emailInput.fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
}

async function waitForChatUI(page: import("@playwright/test").Page) {
  await page.locator('input[placeholder="Ask a question about your data..."]').waitFor({ timeout: 15_000 });

  // Dismiss password change dialog if it appears (shouldn't after setup, but just in case)
  const changeDialog = page.locator("text=Change your password");
  if (await changeDialog.isVisible({ timeout: 2_000 }).catch(() => false)) {
    const newPw = "atlas-e2e-auth-test!";
    await page.locator('input[placeholder="At least 8 characters"]').fill(newPw);
    const passwordInputs = page.locator('form input[type="password"]');
    await passwordInputs.nth(2).fill(newPw);
    await page.locator('button:has-text("Change password")').click();
    await expect(changeDialog).toBeHidden({ timeout: 10_000 });
  }
}

test.describe("Auth Flows", () => {
  // These tests manage their own auth state
  test.use({ storageState: { cookies: [], origins: [] } });

  test("login with valid credentials shows chat UI", async ({ page }) => {
    await page.goto("/");
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await waitForChatUI(page);

    await expect(
      page.locator('input[placeholder="Ask a question about your data..."]'),
    ).toBeVisible();
  });

  test("login with wrong password shows error", async ({ page }) => {
    await page.goto("/");
    await login(page, ADMIN_EMAIL, "wrong-password-123");

    // Error message should appear
    await expect(
      page.locator(".text-red-600, .text-red-400, .text-destructive, [class*='text-red']").first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("logout redirects to login form", async ({ page }) => {
    await page.goto("/");
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await waitForChatUI(page);

    // Click "Sign out"
    await page.locator('button:has-text("Sign out")').click();

    // Should redirect back to login
    await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 10_000 });
  });

  test("re-login after logout works", async ({ page }) => {
    await page.goto("/");
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await waitForChatUI(page);

    // Logout
    await page.locator('button:has-text("Sign out")').click();
    await page.locator('input[type="email"]').waitFor({ timeout: 10_000 });

    // Re-login
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await waitForChatUI(page);

    await expect(
      page.locator('input[placeholder="Ask a question about your data..."]'),
    ).toBeVisible();
  });

  test("sign-up form is accessible from login", async ({ page }) => {
    await page.goto("/");

    const emailInput = page.locator('input[type="email"]');
    await emailInput.waitFor({ timeout: 15_000 });

    // Click the sign-up link
    const signUpLink = page.locator("a, button").filter({ hasText: /create one|sign up|no account/i }).first();
    if (await signUpLink.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await signUpLink.click();

      // Should show the sign-up form
      await expect(
        page.locator("button").filter({ hasText: /create account/i }),
      ).toBeVisible({ timeout: 5_000 });
    } else {
      // Sign-up link may not exist if sign-up is disabled — skip gracefully
      test.skip();
    }
  });
});
