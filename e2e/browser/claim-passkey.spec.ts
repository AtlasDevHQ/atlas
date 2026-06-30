import { test, expect, type CDPSession } from "@playwright/test";

/**
 * Claim interstitial passkey ceremony → admin-MFA gate (#4135).
 *
 * Proves the security-sensitive half of `/claim`: that enrolling a WebAuthn
 * passkey through the interstitial clears the `admin-mfa-required` gate
 * (`passkeyCount>0`), so a freshly-claimed owner reaches admin actions with no
 * password-reset detour (AC B2). The passkey ceremony is driven through a CDP
 * virtual authenticator, exactly like passkey-mfa-gate.spec.ts.
 *
 * The OTP step is deliberately NOT driven here: email OTPs are stored hashed
 * (`storeOTP: "hashed"`), so there is no headless way to read one, and the OTP
 * form itself is the already-shipped, unit-covered `VerifyEmailOTPForm`. We use
 * the authenticated storage-state session (`admin@useatlas.dev`), which makes
 * `/claim` take its verified-session re-entry path and resume directly at the
 * credential step — isolating the new surface (the passkey ceremony + the gate
 * clearance) that warrants browser coverage.
 *
 * @llm + serial: it mutates the shared admin's passkey rows, so it must not race
 * the other passkey specs. Self-cleaning — every exit path removes the passkey
 * it enrolled (name-independent: it diffs the Better Auth passkey list).
 */

interface PasskeySummary {
  id: string;
}

/** Current passkey ids for the signed-in user via the Better Auth plugin REST. */
async function listPasskeyIds(request: {
  get: (url: string) => Promise<{ ok(): boolean; json(): Promise<unknown> }>;
}): Promise<string[]> {
  const res = await request.get("/api/auth/passkey/list-user-passkeys");
  if (!res.ok()) return [];
  const body = (await res.json()) as PasskeySummary[] | { passkeys?: PasskeySummary[] };
  const rows = Array.isArray(body) ? body : (body.passkeys ?? []);
  return rows.map((p) => p.id).filter((id): id is string => typeof id === "string");
}

test.describe("Claim interstitial: passkey enrollment clears the admin-MFA gate @llm", () => {
  test.describe.configure({ timeout: 90_000, mode: "serial" });

  test("enroll a passkey via /claim → /api/v1/admin/audit returns 200", async ({ page }) => {
    let cdp: CDPSession | null = null;
    let authenticatorId: string | null = null;
    let preExistingIds: string[] = [];

    try {
      // ── 1. Virtual authenticator (auto-confirms presence + UV, no OS prompt) ──
      cdp = await page.context().newCDPSession(page);
      await cdp.send("WebAuthn.enable", { enableUI: false });
      const { authenticatorId: id } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
        options: {
          protocol: "ctap2",
          transport: "internal",
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      });
      authenticatorId = id;

      // Snapshot existing passkeys so cleanup deletes ONLY what this test adds —
      // name-independent, since /claim enrolls without a naming dialog.
      preExistingIds = await listPasskeyIds(page.request);

      // Pre-enroll gate probe (mirrors passkey-mfa-gate.spec.ts): if the shared
      // admin already carries a factor (TOTP, or a leaked passkey), the gate is
      // already 200 and the post-enroll 200 below proves nothing — warn loudly
      // so a false-positive is visible rather than silently green.
      const preEnroll = await page.request.get("/api/v1/admin/audit?limit=1");
      if (preEnroll.status() !== 403) {
        console.warn(
          `[claim-passkey] pre-enroll gate returned ${preEnroll.status()} (expected 403) — ` +
            "shared admin already has a second factor, so the post-enroll 200 is not " +
            "solely attributable to this claim enrollment.",
        );
      }

      // ── 2. /claim resumes at the credential step for a verified session ──
      await page.goto("/claim");
      const enrollButton = page.getByRole("button", { name: "Create a passkey" });
      await expect(
        enrollButton,
        "Expected /claim to skip OTP for the authenticated session and show the passkey step",
      ).toBeVisible({ timeout: 20_000 });

      // ── 3. Enroll the passkey (virtual authenticator auto-confirms) ──
      await enrollButton.click();
      await expect(
        page.getByText("Passkey added.", { exact: false }),
        "Passkey enrollment did not confirm — WebAuthn ceremony hung or ATLAS_RPID is mismatched",
      ).toBeVisible({ timeout: 20_000 });

      // ── 4. Accept ToS + finish into the app ──
      await page.getByRole("checkbox", { name: /Terms of Service/i }).check();
      const finishButton = page.getByRole("button", { name: /Finish & go to your workspace/i });
      await expect(finishButton).toBeEnabled();
      await finishButton.click();

      // ── 5. The gate is cleared: an admin route is now reachable (was 403) ──
      const gateResponse = await page.request.get("/api/v1/admin/audit?limit=1");
      expect(
        gateResponse.status(),
        "Expected /api/v1/admin/audit to be reachable after the claim passkey enrollment",
      ).toBe(200);
    } finally {
      // Delete every passkey this run added (best-effort, name-independent). The
      // delete calls are swallowed (a teardown hiccup shouldn't mask the test
      // result), but the leak ASSERTION lives outside the catch — an actual leak
      // onto the shared admin (which would break sibling passkey specs) must
      // fail this test, not warn-and-pass.
      try {
        const after = await listPasskeyIds(page.request);
        const added = after.filter((pid) => !preExistingIds.includes(pid));
        for (const pid of added) {
          await page.request.post("/api/auth/passkey/delete-passkey", { data: { id: pid } });
        }
      } catch (err) {
        console.warn(
          "[claim-passkey] passkey cleanup delete failed:",
          err instanceof Error ? err.message : String(err),
        );
      }

      // Guard each CDP teardown call so one failure doesn't skip the rest.
      if (cdp && authenticatorId) {
        await cdp
          .send("WebAuthn.removeVirtualAuthenticator", { authenticatorId })
          .catch((err: unknown) =>
            console.warn(
              "[claim-passkey] removeVirtualAuthenticator failed:",
              err instanceof Error ? err.message : String(err),
            ),
          );
      }
      if (cdp) {
        await cdp
          .send("WebAuthn.disable")
          .catch((err: unknown) =>
            console.warn(
              "[claim-passkey] WebAuthn.disable failed:",
              err instanceof Error ? err.message : String(err),
            ),
          );
        await cdp.detach().catch((err: unknown) =>
          console.warn(
            "[claim-passkey] CDP detach failed:",
            err instanceof Error ? err.message : String(err),
          ),
        );
      }

      // Leak guard — NOT swallowed. A passkey left on the shared admin fails CI.
      const remaining = (await listPasskeyIds(page.request)).filter(
        (pid) => !preExistingIds.includes(pid),
      );
      expect(
        remaining,
        "Leaked a passkey onto the shared admin — would break sibling passkey specs",
      ).toHaveLength(0);
    }
  });
});
