/**
 * Password reset e2e — request → token from DB → reset → re-login.
 *
 * The dev environment has no email provider wired, so the reset email
 * never leaves the box. Better Auth still creates the verification row
 * before invoking the (no-op) `sendResetPassword` callback, so the test
 * pulls the token directly from `verification.identifier = 'reset-password:*'`
 * via `pg`. This is the same internal DB the dev API writes to.
 *
 * Test password is rotated back at the end so subsequent specs can
 * still log in with the e2e password set up by global-setup.ts.
 */

import { test, expect } from "@playwright/test";
import { Pool } from "pg";

const ADMIN_EMAIL = process.env.ATLAS_ADMIN_EMAIL ?? "admin@useatlas.dev";
const E2E_PASSWORD = process.env.ATLAS_ADMIN_PASSWORD ?? "atlas-e2e-test!";
const NEW_PASSWORD = "atlas-reset-pw!";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://atlas:atlas@localhost:5432/atlas";

/** Pull the most recent unconsumed reset token for `email` from internal Postgres. */
async function getLatestResetToken(email: string): Promise<string | null> {
  const pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 3_000 });
  try {
    // Better Auth stores `reset-password:<token>` in `verification.identifier`,
    // and the user id in `verification.value`. We resolve the user id first
    // so we can scope to the row this test created.
    const userRes = await pool.query<{ id: string }>(
      `SELECT id FROM "user" WHERE LOWER(email) = LOWER($1) LIMIT 1`,
      [email],
    );
    const userId = userRes.rows[0]?.id;
    if (!userId) return null;

    const tokenRes = await pool.query<{ identifier: string }>(
      `SELECT identifier
         FROM verification
        WHERE value = $1
          AND identifier LIKE 'reset-password:%'
          AND "expiresAt" > now()
        ORDER BY "createdAt" DESC
        LIMIT 1`,
      [userId],
    );
    const id = tokenRes.rows[0]?.identifier;
    return id ? id.replace(/^reset-password:/, "") : null;
  } finally {
    await pool.end().catch(() => {});
  }
}

test.describe("Password reset", () => {
  // These tests manage their own auth state — start each unauthenticated.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("/forgot-password renders the form", async ({ page }) => {
    await page.goto("/forgot-password");
    await expect(page.getByRole("heading", { name: /reset|forgot|recover/i })).toBeVisible();
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeVisible();
  });

  test("/forgot-password shows neutral confirmation for any email (no enumeration)", async ({
    page,
  }) => {
    await page.goto("/forgot-password");
    await page.locator('input[type="email"]').fill("nobody-here-please@example.com");
    await page.locator('button[type="submit"]').click();

    // Confirmation is the same regardless of whether the email exists. The
    // copy must NOT say "we couldn't find that email" or "we sent the email"
    // either of which would be an enumeration oracle.
    await expect(page.getByText(/check your (inbox|email)/i).first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test("end-to-end: request → reset → re-login → rotate back", async ({ page, request }) => {
    // 1. Submit the forgot-password form.
    await page.goto("/forgot-password");
    await page.locator('input[type="email"]').fill(ADMIN_EMAIL);
    await page.locator('button[type="submit"]').click();
    await expect(page.getByText(/check your (inbox|email)/i).first()).toBeVisible({
      timeout: 10_000,
    });

    // 2. Pull the issued reset token directly from the verification table.
    let token: string | null = null;
    for (let i = 0; i < 10 && !token; i++) {
      token = await getLatestResetToken(ADMIN_EMAIL);
      if (!token) await page.waitForTimeout(250);
    }
    expect(token, "Better Auth should have issued a reset token").not.toBeNull();

    // 3. Land on /reset-password with the token in the query string and
    //    submit a new password.
    await page.goto(`/reset-password?token=${token}`);
    await page.locator('input[name="password"]').fill(NEW_PASSWORD);
    await page.locator('input[name="confirmPassword"]').fill(NEW_PASSWORD);
    await page.locator('button[type="submit"]').click();

    // The page navigates to /login on success; the success affordance is a
    // visible "sign in" prompt with the new credentials.
    await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 10_000 });

    // 4. Re-login with the new password.
    await page.locator('input[type="email"]').fill(ADMIN_EMAIL);
    await page.locator('input[type="password"]').fill(NEW_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await expect(
      page.locator('input[placeholder="Ask a question about your data..."]'),
    ).toBeVisible({ timeout: 15_000 });

    // 5. Rotate back to the e2e password so other specs can log in.
    //    We use the admin "change my password" route — same one global-setup
    //    uses to migrate from the default seed.
    const res = await request.post("/api/v1/admin/me/password", {
      data: { currentPassword: NEW_PASSWORD, newPassword: E2E_PASSWORD },
    });
    expect(res.ok(), `Failed to rotate password back. Body: ${await res.text()}`).toBe(true);
  });

  test("/reset-password shows an error when no token is present", async ({ page }) => {
    await page.goto("/reset-password");
    await expect(page.getByText(/missing|invalid|expired/i).first()).toBeVisible();
  });

  test("/reset-password rejects mismatched passwords client-side", async ({ page }) => {
    await page.goto("/reset-password?token=fake-token-for-validation-test");
    await page.locator('input[name="password"]').fill("apples-and-pears");
    await page.locator('input[name="confirmPassword"]').fill("apples-and-pies");
    await page.locator('button[type="submit"]').click();
    await expect(page.getByText(/match|mismatch/i).first()).toBeVisible();
  });
});
