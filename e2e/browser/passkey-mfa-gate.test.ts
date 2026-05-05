import { test, expect, type CDPSession } from "@playwright/test";

/**
 * Passkey enrollment → MFA gate acceptance — closes the e2e gap from #2090.
 *
 * #2082 shipped passkey enrollment + the multi-method MFA gate, but its
 * stated "browser e2e: at least one `@llm`-tagged path that enrolls a
 * virtual authenticator" was never landed. Without this test, a regression
 * that breaks the WebAuthn ceremony at the security-page level — or the
 * `passkeyCount > 0` branch in `mfaRequired` — would slip past `bun run
 * test:browser` because no spec exercises the actual `navigator.credentials
 * .create` path against the Better Auth `@better-auth/passkey` plugin.
 *
 * Why CDP, not a `page.context().addVirtualAuthenticator()` helper:
 * Playwright 1.58's `BrowserContext` does not expose a first-class virtual
 * authenticator API; the documented pattern is to drive Chrome DevTools
 * Protocol's `WebAuthn.*` domain directly. The `@llm` tag puts the spec on
 * the serial worker (see `package.json` "test:browser:llm") so concurrent
 * tests can't race on the shared `admin@useatlas.dev` user's `passkey`
 * rows while we enroll → assert → clean up.
 *
 * The test is self-cleaning: it tears down the virtual authenticator on
 * every exit path AND deletes the enrolled passkey via the security UI
 * after assertions. A leftover credential on the shared admin would make
 * the `mfaRequired` gate satisfied for every subsequent test — masking
 * regressions in completely unrelated specs.
 */

test.describe("Passkey enrollment satisfies MFA gate @llm", () => {
  // Slightly higher than default — the `addPasskey` round-trip + name dialog
  // + admin-audit page load all happen back-to-back. 60s is comfortable
  // for a cold dev server without being lenient enough to mask a hang.
  test.describe.configure({ timeout: 60_000, mode: "serial" });

  test("enrolls a virtual passkey and reaches /admin/audit", async ({ page }) => {
    let cdp: CDPSession | null = null;
    let authenticatorId: string | null = null;
    let enrolledPasskeyName: string | null = null;

    try {
      // ── 1. Install the virtual authenticator via CDP ────────────────
      // `transport: "internal"` + `hasUserVerification: true` +
      // `isUserVerified: true` produces a platform authenticator that
      // auto-confirms presence + UV — i.e. no OS prompt to dismiss. This
      // matches what the security page treats as the "recommended" path
      // (see `passkey-tile.tsx`'s `platformAuthenticator` branch).
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

      // ── 2. Open the security page and click "Add a passkey" ─────────
      await page.goto("/admin/settings/security");
      await expect(page.locator("h1", { hasText: "Security" })).toBeVisible({
        timeout: 15_000,
      });

      // The button copy flips between "Add a passkey" (no enrolled
      // credentials) and "Add another passkey" (>=1 enrolled). Match
      // either so the test is robust to a previous run that left a key
      // behind despite the cleanup at end-of-test.
      const addButton = page.getByRole("button", {
        name: /^Add (a|another) passkey$/,
      });
      await expect(addButton).toBeEnabled({ timeout: 10_000 });
      await addButton.click();

      // ── 3. Save the enrollment with a recognizable name ─────────────
      // The post-enrollment naming dialog is what `passkey-tile.tsx`
      // opens on success. Using a unique name (with a timestamp) makes
      // the cleanup step below deterministic even if a parallel suite
      // raced and left an "E2E passkey" of its own.
      enrolledPasskeyName = `e2e-passkey-${Date.now()}`;
      const nameDialog = page.getByRole("alertdialog").filter({
        hasText: "Name this passkey",
      });
      await expect(nameDialog).toBeVisible({ timeout: 15_000 });
      const nameInput = nameDialog.getByRole("textbox");
      await nameInput.fill(enrolledPasskeyName);
      await nameDialog.getByRole("button", { name: "Save" }).click();

      // The list below the tiles refetches via `refreshPasskeys()` after
      // `onChange()` fires — wait for the row to appear so we know the
      // passkey is durable in the DB before we test the gate.
      await expect(
        page.getByRole("listitem").filter({ hasText: enrolledPasskeyName }),
      ).toBeVisible({ timeout: 10_000 });

      // ── 4. Confirm the MFA gate now accepts the session ─────────────
      // /api/v1/admin/audit goes through `createAdminRouter()` →
      // `mfaRequired`, so this is the exact 403 surface the issue calls
      // out. The 200 here is the test's actual assertion: passkey-only
      // enrollment satisfies `isMfaEnrolled()` via the `passkeyCount > 0`
      // branch added in #2082.
      const gateResponse = await page.request.get(
        "/api/v1/admin/audit?limit=1",
      );
      expect(
        gateResponse.status(),
        `Expected /api/v1/admin/audit to be reachable after passkey ` +
          `enrollment, got ${gateResponse.status()}: ${await gateResponse.text()}`,
      ).toBe(200);

      // Bonus: the rendered admin page also loads (covers the layout
      // wrapper's `useAdminFetch` paths, which 403'd pre-enrollment).
      await page.goto("/admin/audit");
      await expect(page.locator("h1").first()).toBeVisible({ timeout: 15_000 });
    } finally {
      // ── 5. Clean up — delete the credential we enrolled ─────────────
      // Best-effort cleanup. We don't fail the test on cleanup errors —
      // the virtual-authenticator tear-down is the load-bearing piece.
      if (enrolledPasskeyName) {
        try {
          await page.goto("/admin/settings/security");
          const row = page
            .getByRole("listitem")
            .filter({ hasText: enrolledPasskeyName });
          if (await row.isVisible({ timeout: 5_000 }).catch(() => false)) {
            await row
              .getByRole("button", { name: `Delete ${enrolledPasskeyName}` })
              .click();
            const confirm = page.getByRole("alertdialog").filter({
              hasText: "Delete passkey?",
            });
            await confirm
              .getByRole("button", { name: "Delete" })
              .click();
            await expect(row).toHaveCount(0, { timeout: 10_000 });
          }
        } catch (err) {
          console.debug(
            "[passkey-mfa-gate] cleanup of enrolled passkey row failed:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      if (cdp && authenticatorId) {
        try {
          await cdp.send("WebAuthn.removeVirtualAuthenticator", {
            authenticatorId,
          });
        } catch (err) {
          console.debug(
            "[passkey-mfa-gate] removeVirtualAuthenticator failed:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      if (cdp) {
        try {
          await cdp.send("WebAuthn.disable");
          await cdp.detach();
        } catch (err) {
          console.debug(
            "[passkey-mfa-gate] CDP teardown failed:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }
  });
});
