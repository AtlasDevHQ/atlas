/**
 * Tests for the SaaS-region platform email DPA guard (#1969).
 *
 * The guard locks SaaS regions to Resend at the **platform** level so the
 * /dpa sub-processor table stays accurate. Per-org `email_installations`
 * (BYOC) are deliberately NOT considered — those are the customer's own
 * vendor relationship, not Atlas's sub-processor. The two "per-org"
 * cases below are the load-bearing assertions of that distinction.
 *
 * Tests use dependency-injection rather than mock.module so the assertion
 * surface is the function's own contract (no module-graph coupling).
 */

import { describe, it, expect } from "bun:test";
import {
  assertSaasPlatformEmailIsResend,
  DpaInconsistencyError,
  type DpaGuardDeps,
} from "../dpa-guard";

/** Build a deps stub. Defaults to the safe SaaS+nothing-configured shape (which throws). */
function deps(overrides: Partial<DpaGuardDeps> = {}): DpaGuardDeps {
  return {
    isSaas: () => true,
    getPlatformProvider: () => null,
    hasSmtpUrl: () => false,
    hasResendKey: () => false,
    ...overrides,
  };
}

describe("assertSaasPlatformEmailIsResend", () => {
  // ── SaaS + platform Resend → ok ────────────────────────────────────
  it("does not throw when SaaS + platform provider is resend", () => {
    expect(() =>
      assertSaasPlatformEmailIsResend(deps({ getPlatformProvider: () => "resend" })),
    ).not.toThrow();
  });

  // ── SaaS + platform SendGrid → throws ──────────────────────────────
  it("throws DpaInconsistencyError when SaaS + platform provider is sendgrid", () => {
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

  it("throws when SaaS + platform provider is postmark", () => {
    expect(() =>
      assertSaasPlatformEmailIsResend(deps({ getPlatformProvider: () => "postmark" })),
    ).toThrow(DpaInconsistencyError);
  });

  // ── SaaS + ATLAS_SMTP_URL → throws ────────────────────────────────
  it("throws when SaaS + no platform provider but ATLAS_SMTP_URL is set", () => {
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

  // ── SaaS + only RESEND_API_KEY → ok ────────────────────────────────
  it("does not throw when SaaS + only RESEND_API_KEY env-var is set", () => {
    expect(() =>
      assertSaasPlatformEmailIsResend(deps({ hasResendKey: () => true })),
    ).not.toThrow();
  });

  // ── SaaS + nothing → throws ────────────────────────────────────────
  it("throws when SaaS + no platform config and no env transports", () => {
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
  // These two cases codify that per-org `email_installations` are NEVER
  // considered by the guard. The function does not even take an orgId
  // and never queries the email-installation store, so the only thing
  // we can assert here is that platform-level resolution alone decides
  // the outcome — which is exactly the point.

  it("does not throw when SaaS + per-org config exists AND platform is resend", () => {
    // Per-org installation existence is irrelevant — the guard never queries it.
    // Resolution stays at the platform layer (resend), so this passes.
    expect(() =>
      assertSaasPlatformEmailIsResend(deps({ getPlatformProvider: () => "resend" })),
    ).not.toThrow();
  });

  it("throws when SaaS + per-org config exists but no platform transport", () => {
    // Even if a customer has BYOC sendgrid wired into their org, the SaaS
    // platform itself has no sub-processor configured — that's a DPA bug
    // because Atlas-originated mail (e.g. password reset for unauthenticated
    // /forgot-password requests) has nowhere to go that's covered by the DPA.
    let captured: unknown;
    try {
      assertSaasPlatformEmailIsResend(deps());
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(DpaInconsistencyError);
  });

  // ── Self-hosted → never throws ─────────────────────────────────────
  it("does not throw on self-hosted regardless of provider", () => {
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
