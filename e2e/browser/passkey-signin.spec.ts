import { test, expect, type CDPSession, type Page } from "@playwright/test";

/**
 * Wave 2A of the MFA hardening track (#2091): proves a user enrolled with a
 * passkey can complete sign-in without typing a password. The unit-level
 * coverage in `packages/web/src/app/login/page.test.tsx` verifies the
 * button wires `signIn.passkey()` correctly; this spec is the only barrier
 * that catches a regression in the full flow:
 *
 *   1. The browser registers a credential.
 *   2. Better Auth persists it under the user's id.
 *   3. The login page invokes `signIn.passkey()` against the virtual
 *      authenticator and the assertion verifies server-side.
 *   4. A real session cookie is issued — *without the password being typed*.
 *
 * If any one of those steps regresses (e.g. `signIn.passkey()` is renamed,
 * the rpID mismatches, the conditional-UI autofill ceremony bricks the
 * explicit-button flow), this test fails red.
 *
 * Why CDP, not `page.context().addVirtualAuthenticator()`:
 * Same rationale as `passkey-mfa-gate.spec.ts` — Playwright 1.58 exposes
 * the CDP path only. Tagged `@llm` so the spec runs on the serial worker
 * (`bun run test:browser:llm`, workers=1) — concurrent specs would race
 * on the shared `admin@useatlas.dev` user's `passkey` rows.
 *
 * Self-cleaning: every exit path deletes the credential. A leaked passkey
 * bypasses subsequent `signIn.passkey()` flows on the shared admin and
 * masks exactly the regressions this test exists to catch.
 *
 * Required env: `ATLAS_RPID=localhost` on the dev server. The default
 * (`app.useatlas.dev`) does not match `localhost:3000` and the WebAuthn
 * ceremony will reject every assertion with `NotAllowedError`.
 */

test.describe("Passkey-only sign-in (no password) @llm", () => {
  // The flow does enrollment + sign-out + passkey sign-in back-to-back;
  // 90s leaves room for a cold dev server while still failing fast on a
  // genuine hang in the WebAuthn ceremony. Higher than passkey-mfa-gate
  // because the sign-out + re-sign-in adds two full-page navigations.
  test.describe.configure({ timeout: 90_000, mode: "serial" });

  // The signed-in storage state from global-setup gives us a logged-in
  // session for the enrollment phase. We sign out mid-test to exercise
  // the actual passkey sign-in.
  test("enrolls a passkey, signs out, signs back in via passkey only", async ({ page }) => {
    let cdp: CDPSession | null = null;
    let authenticatorId: string | null = null;
    let enrolledPasskeyName: string | null = null;

    try {
      // ── 1. Install a virtual authenticator via CDP ──────────────────
      // `transport: "internal"` + UV pre-confirmed produces a platform
      // authenticator that auto-completes both `create()` and `get()`
      // without an OS prompt — matching the conditions Better Auth's
      // sign-in passkey flow expects from a real Touch ID / Face ID device.
      cdp = await page.context().newCDPSession(page);
      await cdp.send("WebAuthn.enable", { enableUI: false });
      const { authenticatorId: id } = await cdp.send(
        "WebAuthn.addVirtualAuthenticator",
        {
          options: {
            protocol: "ctap2",
            transport: "internal",
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            automaticPresenceSimulation: true,
          },
        },
      );
      authenticatorId = id;

      // ── 2. Enroll a passkey from the security page ──────────────────
      await page.goto("/admin/settings/security");
      await expect(page.locator("h1", { hasText: "Security" })).toBeVisible({
        timeout: 15_000,
      });

      // Pre-flight — fail fast if a previous run leaked an `e2e-signin-*`
      // row. A leaked credential silently bypasses the password
      // requirement on the shared admin and would mask exactly the
      // regression this spec catches; the actionable error here is far
      // better than a confusingly-passing run.
      const leakedRow = page
        .getByRole("listitem")
        .filter({ hasText: /^e2e-signin-/ });
      const leakedCount = await leakedRow.count();
      if (leakedCount > 0) {
        const leakedNames = await leakedRow.allTextContents();
        throw new Error(
          `Previous run leaked ${leakedCount} passkey(s) onto the shared admin: ` +
          `${leakedNames.join(", ")}. Delete them via /admin/settings/security or ` +
          `via the Better Auth API before re-running this spec.`,
        );
      }

      const addButton = page.getByRole("button", {
        name: /^Add (a|another) passkey$/,
      });
      await expect(addButton).toBeEnabled({ timeout: 10_000 });
      await addButton.click();

      // Race the success dialog against the destructive-error paragraph.
      // Without this, a misconfigured rpID surfaces as an opaque 15s
      // "naming dialog never visible" timeout that says nothing actionable.
      enrolledPasskeyName = `e2e-signin-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
      const nameDialog = page.getByRole("alertdialog").filter({
        hasText: "Name this passkey",
      });
      const errorParagraph = page.locator("p.text-destructive").first();
      const winner = await Promise.race([
        nameDialog
          .waitFor({ state: "visible", timeout: 15_000 })
          .then(() => "dialog" as const),
        errorParagraph
          .waitFor({ state: "visible", timeout: 15_000 })
          .then(() => "error" as const),
      ]).catch(() => "timeout" as const);

      if (winner === "error") {
        const text = (await errorParagraph.textContent())?.trim() ?? "(no text)";
        throw new Error(
          `Passkey enrollment failed before the naming dialog opened. UI surfaced: ` +
          `"${text}". Common cause: ATLAS_RPID does not match the page origin ` +
          `(default app.useatlas.dev vs localhost:3000 — set ATLAS_RPID=localhost ` +
          `on the dev server).`,
        );
      }
      if (winner === "timeout") {
        throw new Error(
          "Neither the naming dialog nor an error paragraph appeared within 15s " +
          "after clicking 'Add a passkey'. The WebAuthn ceremony is hung.",
        );
      }

      const nameInput = nameDialog.getByRole("textbox");
      await nameInput.fill(enrolledPasskeyName);
      await nameDialog.getByRole("button", { name: "Save" }).click();

      // The list refetches after `onChange()` fires — wait for the row to
      // appear so we know the credential is durable in the DB before we
      // sign out.
      await expect(
        page.getByRole("listitem").filter({ hasText: enrolledPasskeyName }),
      ).toBeVisible({ timeout: 10_000 });

      // ── 3. Sign out — must clear the session cookie completely ──────
      // The passkey assertion below has to create a session from scratch
      // to prove the password isn't being typed. We sign out via the UI
      // (not the API) so any cleanup the UI does (clearing in-memory
      // state, redirecting) runs as in production.
      await page.goto("/");
      await page.locator('button:has-text("Sign out")').click();
      await expect(page.locator('input[type="email"]')).toBeVisible({
        timeout: 10_000,
      });

      // ── 4. Capture the password input state BEFORE the passkey click ─
      // Reading the input AFTER a successful passkey sign-in is vacuous
      // because we navigate away from /login — the field no longer exists
      // in the DOM. Reading here, while the form is still mounted, catches
      // the failure mode the test is designed to surface: a regression
      // where browser autofill (or a prefill from a previous session)
      // leaked a saved password into the input even though we intend to
      // bypass it entirely.
      const passwordBeforeClick = await page
        .locator('input[type="password"]')
        .inputValue();
      expect(
        passwordBeforeClick,
        "Password input was prefilled before the passkey click — the assertion " +
          "that signIn.passkey() bypasses the password depends on the field being empty.",
      ).toBe("");

      // ── 5. Sign in via the passkey button (no password) ─────────────
      // The button only renders when WebAuthn is supported — the virtual
      // authenticator above ensures this is true. If the button is
      // missing, the gating regression itself is the primary signal.
      const passkeyButton = page.getByRole("button", {
        name: /sign in with a passkey/i,
      });
      await expect(passkeyButton).toBeVisible({ timeout: 10_000 });
      await expect(passkeyButton).toBeEnabled();
      await passkeyButton.click();

      // ── 6. Assert a session was issued without typing a password ────
      // After a successful signIn.passkey(), the page navigates to "/".
      // Reaching the chat UI proves an authenticated session exists.
      await expect(
        page.locator('input[placeholder="Ask a question about your data..."]'),
      ).toBeVisible({ timeout: 15_000 });

      // Sanity: an authenticated route is reachable. /api/v1/admin/audit
      // goes through the same admin-auth + MFA-required pipeline as the
      // rest of the admin console, so a non-5xx here proves the session
      // cookie is set and trusted. We accept any 4xx/2xx — a 403 still
      // means "session present, MFA gate decided" rather than "session
      // missing", which is what this assertion is guarding against.
      const auditRes = await page.request.get("/api/v1/admin/audit?limit=1");
      expect(
        auditRes.status(),
        `Expected /api/v1/admin/audit to be reachable after passkey-only sign-in, got ${auditRes.status()}`,
      ).toBeLessThan(500);
    } finally {
      // ── 7. Clean up — delete the credential and tear down the authn ─
      // Best-effort. The cleanup helper warns + continues on inner failures
      // (page closed, row never rendered) — a hard fail in the finally
      // block would mask the underlying assertion failure that brought us
      // here. The pre-flight detection below at the start of subsequent
      // runs is what catches a genuinely leaked credential.
      if (enrolledPasskeyName) {
        await cleanupEnrolledPasskey(page, enrolledPasskeyName);
      }

      if (cdp && authenticatorId) {
        try {
          await cdp.send("WebAuthn.removeVirtualAuthenticator", {
            authenticatorId,
          });
        } catch (err) {
          console.warn(
            "[passkey-signin] removeVirtualAuthenticator failed:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      if (cdp) {
        try {
          await cdp.send("WebAuthn.disable");
        } catch (err) {
          console.warn(
            "[passkey-signin] WebAuthn.disable failed:",
            err instanceof Error ? err.message : String(err),
          );
        }
        try {
          await cdp.detach();
        } catch (err) {
          console.warn(
            "[passkey-signin] CDP detach failed:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }
  });
});

/**
 * Delete the named passkey via the security-page UI. We're already signed
 * back in (via passkey) at this point, so the same admin route works.
 * Best-effort — failures are warned but don't fail the test.
 */
async function cleanupEnrolledPasskey(page: Page, name: string): Promise<void> {
  try {
    await page.goto("/admin/settings/security");
    const row = page.getByRole("listitem").filter({ hasText: name });
    const visible = await row
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      // intentionally ignored: page closed mid-cleanup or row legitimately
      // never rendered (test failed before sign-back-in completed).
      .catch(() => false);
    if (!visible) return;

    await row.getByRole("button", { name: `Delete ${name}` }).click();
    const confirm = page.getByRole("alertdialog").filter({
      hasText: "Delete passkey?",
    });
    await confirm.getByRole("button", { name: "Delete" }).click();
    await expect(row).toHaveCount(0, { timeout: 10_000 });
  } catch (err) {
    console.warn(
      "[passkey-signin] cleanup of enrolled passkey row failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}
