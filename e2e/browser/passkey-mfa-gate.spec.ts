import { test, expect, type CDPSession, type Page } from "@playwright/test";

/**
 * Exercises the WebAuthn enrollment ceremony through `/admin/settings/security`
 * and asserts the resulting session passes the admin MFA gate. The unique
 * value over the unit tests in `admin-mfa-required.test.ts` is end-to-end
 * proof that a real `navigator.credentials.create` round-trip populates
 * `passkey` rows that `resolvePasskeyCount` reads — so a regression in the
 * UI plumbing, the Better Auth plugin wiring, or the `passkeyCount > 0`
 * branch of the gate fails this spec instead of slipping through CI.
 *
 * Why CDP, not `page.context().addVirtualAuthenticator()`:
 * Playwright 1.58 does not expose a first-class virtual authenticator API on
 * `BrowserContext`; the documented pattern is `page.context().newCDPSession(page)`
 * → `WebAuthn.enable` → `WebAuthn.addVirtualAuthenticator`. The `@llm` tag puts
 * this spec on the serial worker (`bun run test:browser:llm`, workers=1) so
 * concurrent tests can't race on the shared `admin@useatlas.dev` user's
 * `passkey` rows while we enroll → assert → clean up.
 *
 * Self-cleaning: `finally{}` deletes the enrolled credential and tears down
 * the virtual authenticator on every exit path. A leaked passkey on the
 * shared admin would silently satisfy the `passkeyCount > 0` branch of the
 * gate for every subsequent spec — masking exactly the regressions this
 * test is designed to catch.
 *
 * Required env: `ATLAS_RPID=localhost` on the dev server. The default
 * (`app.useatlas.dev`) does not match a `localhost:3000` origin and the
 * WebAuthn ceremony will reject every enrollment. The test races the
 * naming-dialog assertion against the destructive-error paragraph that
 * `passkey-tile.tsx` renders so a misconfigured rpID surfaces as a one-
 * sentence failure rather than a 15-second opaque timeout.
 */

test.describe("Passkey enrollment satisfies MFA gate @llm", () => {
  // Slightly higher than default — `addPasskey` round-trip + name dialog +
  // admin-audit page load run back-to-back. 60s leaves room for a cold dev
  // server without being lenient enough to mask a hang.
  test.describe.configure({ timeout: 60_000, mode: "serial" });

  test("enrolls a virtual passkey and reaches /admin/audit", async ({ page }) => {
    let cdp: CDPSession | null = null;
    let authenticatorId: string | null = null;
    let enrolledPasskeyName: string | null = null;

    try {
      // ── 1. Install the virtual authenticator via CDP ────────────────
      // `transport: "internal"` + `hasUserVerification: true` +
      // `isUserVerified: true` produces a platform authenticator that
      // auto-confirms presence + UV — i.e. no OS prompt to dismiss.
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

      // ── 2. Probe the gate BEFORE enrollment ─────────────────────────
      // Without this, a shared `admin@useatlas.dev` that already has TOTP
      // enrolled (or a leaked passkey from a failed cleanup) lets the
      // post-enrollment 200 come from the wrong gate branch — the test
      // would silently pass through a `passkeyCount > 0` regression. We
      // record the starting state and warn loudly when the gate was
      // already reachable so the run is correctly attributed.
      const preEnrollResponse = await page.request.get(
        "/api/v1/admin/audit?limit=1",
      );
      const startedGated = preEnrollResponse.status() === 403;
      if (!startedGated) {
        console.warn(
          `[passkey-mfa-gate] pre-enroll gate returned ${preEnrollResponse.status()} ` +
          "— shared admin already has another factor enrolled. The post-enroll " +
          "200 below does NOT exclusively prove the passkeyCount > 0 branch.",
        );
      }

      // ── 3. Open the security page and click "Add a passkey" ─────────
      await page.goto("/admin/settings/security");
      await expect(page.locator("h1", { hasText: "Security" })).toBeVisible({
        timeout: 15_000,
      });

      // The button copy flips between "Add a passkey" (no enrolled
      // credentials) and "Add another passkey" (>=1 enrolled). Match either
      // so the test is robust to a previous run that left a key behind
      // despite the cleanup at end-of-test.
      const addButton = page.getByRole("button", {
        name: /^Add (a|another) passkey$/,
      });
      await expect(addButton).toBeEnabled({ timeout: 10_000 });
      await addButton.click();

      // ── 4. Race naming dialog vs error paragraph ────────────────────
      // `passkey-tile.tsx` opens the post-enrollment naming dialog on
      // success and renders a `text-destructive` <p> on every other
      // failure path (rpID mismatch, plugin not loaded, network). Without
      // this race, an rpID misconfiguration surfaces as a 15-second
      // "naming dialog never visible" timeout that says nothing actionable.
      // `crypto.randomUUID()` short-suffix avoids `Date.now()` collisions
      // under Playwright's `retries: 1` if a previous run's cleanup leaked.
      enrolledPasskeyName = `e2e-passkey-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
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
          "after clicking 'Add a passkey'. The WebAuthn ceremony is hung or the " +
          "security-page UI has changed shape.",
        );
      }

      // ── 5. Save the enrollment ──────────────────────────────────────
      const nameInput = nameDialog.getByRole("textbox");
      await nameInput.fill(enrolledPasskeyName);
      await nameDialog.getByRole("button", { name: "Save" }).click();

      // The list below the tiles refetches via `refreshPasskeys()` after
      // `onChange()` fires — wait for the row to appear so we know the
      // passkey is durable in the DB before we test the gate.
      await expect(
        page.getByRole("listitem").filter({ hasText: enrolledPasskeyName }),
      ).toBeVisible({ timeout: 10_000 });

      // ── 6. Confirm the MFA gate now accepts the session ─────────────
      // /api/v1/admin/audit goes through `createAdminRouter()` →
      // `mfaRequired`, so this is the exact 403 surface the issue calls
      // out. The 200 here is the test's primary assertion.
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
      // ── 7. Clean up — delete the credential we enrolled ─────────────
      // Best-effort, but failures here MUST be visible in CI: a leaked
      // credential silently satisfies `passkeyCount > 0` for every spec
      // that follows on the shared storage state.
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
            "[passkey-mfa-gate] removeVirtualAuthenticator failed:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      if (cdp) {
        try {
          await cdp.send("WebAuthn.disable");
        } catch (err) {
          console.warn(
            "[passkey-mfa-gate] WebAuthn.disable failed:",
            err instanceof Error ? err.message : String(err),
          );
        }
        try {
          await cdp.detach();
        } catch (err) {
          console.warn(
            "[passkey-mfa-gate] CDP detach failed:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }
  });
});

/** Delete the named passkey via the security-page UI. Best-effort. */
async function cleanupEnrolledPasskey(page: Page, name: string): Promise<void> {
  try {
    await page.goto("/admin/settings/security");
    const row = page.getByRole("listitem").filter({ hasText: name });
    // `Locator.isVisible()` ignores its `timeout` option and returns based
    // on the current snapshot — wait explicitly so a slow render doesn't
    // skip cleanup and leak the credential into subsequent specs.
    const visible = await row
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      // intentionally ignored: page closed mid-cleanup or the row legitimately
      // never rendered (prior cleanup already removed it). Treating as "no
      // cleanup needed" is correct in both cases.
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
      "[passkey-mfa-gate] cleanup of enrolled passkey row failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}
