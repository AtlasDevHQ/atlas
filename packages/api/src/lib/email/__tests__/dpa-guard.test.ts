/**
 * Tests for the SaaS-region platform email DPA guard (#1969).
 *
 * Covers two checks performed by `assertSaasPlatformEmailIsResend`:
 *   1. Stated intent (`ATLAS_EMAIL_PROVIDER` setting) must be "resend" or
 *      the registry default. Explicit non-Resend → throw.
 *   2. A Resend key must exist; otherwise an `ATLAS_SMTP_URL` bridge would
 *      become the actual transport (DPA-violating) or no mail would send.
 *
 * Per-org `email_installations` (BYOC) are deliberately NOT considered —
 * those are the customer's own vendor relationship, not Atlas's
 * sub-processor. The two BYOC cases below codify that distinction.
 *
 * Tests use dependency injection rather than module mocking so the assertion
 * surface is the function's own contract.
 */

import { describe, it, expect } from "bun:test";
import {
  assertSaasPlatformEmailIsResend,
  DpaInconsistencyError,
  type DpaGuardDeps,
} from "../dpa-guard";

/**
 * Build a deps stub. Defaults model a SaaS region whose registry default
 * `ATLAS_EMAIL_PROVIDER=resend` is in effect but no Resend key has been
 * pasted yet — i.e. the "fail at boot" baseline. Tests opt in to the
 * passing shape by setting `hasResendKey: () => true`.
 */
function deps(overrides: Partial<DpaGuardDeps> = {}): DpaGuardDeps {
  return {
    isSaas: () => true,
    getPlatformProvider: () => "resend",
    hasSmtpUrl: () => false,
    hasResendKey: () => false,
    ...overrides,
  };
}

describe("assertSaasPlatformEmailIsResend", () => {
  // ── SaaS + platform Resend with key → ok ───────────────────────────
  it("does not throw when SaaS + platform=resend AND RESEND_API_KEY set", () => {
    expect(() =>
      assertSaasPlatformEmailIsResend(deps({ hasResendKey: () => true })),
    ).not.toThrow();
  });

  // ── SaaS + platform SendGrid → throws (intent check) ───────────────
  it("throws DpaInconsistencyError when SaaS + ATLAS_EMAIL_PROVIDER=sendgrid", () => {
    let captured: unknown;
    try {
      assertSaasPlatformEmailIsResend(deps({ getPlatformProvider: () => "sendgrid" }));
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(DpaInconsistencyError);
    const err = captured as DpaInconsistencyError;
    expect(err.resolvedProvider).toBe("sendgrid");
    expect(err.message).toContain("DPA");
    expect(err.message).toContain("#1969");
  });

  it("throws when SaaS + ATLAS_EMAIL_PROVIDER=postmark", () => {
    expect(() =>
      assertSaasPlatformEmailIsResend(deps({ getPlatformProvider: () => "postmark" })),
    ).toThrow(DpaInconsistencyError);
  });

  // The silent-failure-hunter scenario: operator stamps non-Resend intent,
  // forgets the key, but happens to have RESEND_API_KEY in env. The actual
  // transport is currently Resend, but a future "key paste" flips traffic to
  // an unlisted vendor. Guard catches the intent at boot.
  it("throws on non-Resend intent even when RESEND_API_KEY is also set", () => {
    expect(() =>
      assertSaasPlatformEmailIsResend(
        deps({ getPlatformProvider: () => "sendgrid", hasResendKey: () => true }),
      ),
    ).toThrow(DpaInconsistencyError);
  });

  // ── SaaS + ATLAS_SMTP_URL only → throws (transport check) ──────────
  it("throws when SaaS + intent=resend but no key + ATLAS_SMTP_URL set", () => {
    let captured: unknown;
    try {
      assertSaasPlatformEmailIsResend(deps({ hasSmtpUrl: () => true }));
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(DpaInconsistencyError);
    const err = captured as DpaInconsistencyError;
    expect(err.resolvedProvider).toBe("smtp-bridge");
    expect(err.message).toContain("ATLAS_SMTP_URL");
    expect(err.message).toContain("#1969");
  });

  // ── SaaS + RESEND_API_KEY only → ok ────────────────────────────────
  // This is the env-var fallback path #4 in `sendEmail`. Intent defaults
  // to "resend" via the settings registry default.
  it("does not throw when SaaS + only RESEND_API_KEY env-var is set", () => {
    expect(() =>
      assertSaasPlatformEmailIsResend(deps({ hasResendKey: () => true })),
    ).not.toThrow();
  });

  // ── SaaS + nothing (default intent, no transport) → throws ─────────
  it("throws when SaaS + intent=resend but no key and no SMTP_URL", () => {
    let captured: unknown;
    try {
      assertSaasPlatformEmailIsResend(deps());
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(DpaInconsistencyError);
    const err = captured as DpaInconsistencyError;
    expect(err.resolvedProvider).toBe("none");
    expect(err.message).toContain("#1969");
  });

  // ── BYOC distinction (load-bearing) ────────────────────────────────
  // Codifies that per-org `email_installations` are NEVER considered.
  // Structurally enforced: the function takes no `orgId` and never imports
  // the email-installation store.

  it("does not throw when SaaS + per-org config exists AND platform Resend works", () => {
    expect(() =>
      assertSaasPlatformEmailIsResend(deps({ hasResendKey: () => true })),
    ).not.toThrow();
  });

  it("throws when SaaS + per-org config exists but no platform transport", () => {
    expect(() => assertSaasPlatformEmailIsResend(deps())).toThrow(DpaInconsistencyError);
  });

  // ── Precedence ─────────────────────────────────────────────────────
  it("does not throw when SaaS + platform Resend + key + ATLAS_SMTP_URL also set", () => {
    // Platform Resend wins over the SMTP bridge in `sendEmail`. A future
    // refactor that reorders the checks (e.g. SMTP-first to "fail fast")
    // would silently start failing this valid SaaS shape.
    expect(() =>
      assertSaasPlatformEmailIsResend(
        deps({ hasResendKey: () => true, hasSmtpUrl: () => true }),
      ),
    ).not.toThrow();
  });

  // ── Self-hosted → never throws ─────────────────────────────────────
  it("does not throw on self-hosted regardless of provider or transport", () => {
    expect(() =>
      assertSaasPlatformEmailIsResend(
        deps({ isSaas: () => false, getPlatformProvider: () => "sendgrid" }),
      ),
    ).not.toThrow();

    expect(() =>
      assertSaasPlatformEmailIsResend(
        deps({ isSaas: () => false, hasSmtpUrl: () => true }),
      ),
    ).not.toThrow();

    expect(() =>
      assertSaasPlatformEmailIsResend(deps({ isSaas: () => false })),
    ).not.toThrow();
  });
});
