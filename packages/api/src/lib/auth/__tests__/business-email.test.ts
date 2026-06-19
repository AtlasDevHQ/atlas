/**
 * Unit coverage for the business-email-only signup policy (#3650, ADR-0018).
 *
 * Pure module — no DB, no Better Auth instance — so these run fast and pin the
 * deny decision (disposable + freemium), the typed-error contract the web/MCP
 * layers depend on, and the rejection classifier the MCP `start_trial`
 * provisioner (#3649) uses to map the shared-signup-path failure to its
 * `business_email_required` envelope.
 */

import { describe, it, expect } from "bun:test";
import { APIError } from "better-auth/api";
import {
  BUSINESS_EMAIL_REQUIRED_CODE,
  BUSINESS_EMAIL_REQUIRED_MESSAGE,
  FREEMIUM_EMAIL_DOMAINS,
  assertBusinessEmail,
  classifyBusinessEmail,
  extractEmailDomain,
  isBusinessEmailRejection,
  isDisposableEmail,
  isFreemiumEmailDomain,
} from "../business-email";

describe("extractEmailDomain", () => {
  it("returns the lower-cased domain after the last @", () => {
    expect(extractEmailDomain("Alice@Acme.COM")).toBe("acme.com");
    expect(extractEmailDomain("weird+a@b@corp.example")).toBe("corp.example");
  });

  it("returns undefined for malformed / domain-less input", () => {
    expect(extractEmailDomain("no-at-sign")).toBeUndefined();
    expect(extractEmailDomain("trailing@")).toBeUndefined();
  });
});

describe("isFreemiumEmailDomain", () => {
  it("denies common consumer domains (case-insensitive)", () => {
    expect(isFreemiumEmailDomain("user@gmail.com")).toBe(true);
    expect(isFreemiumEmailDomain("user@GMAIL.COM")).toBe(true);
    expect(isFreemiumEmailDomain("user@outlook.com")).toBe(true);
    expect(isFreemiumEmailDomain("user@yahoo.co.uk")).toBe(true);
    expect(isFreemiumEmailDomain("user@icloud.com")).toBe(true);
    expect(isFreemiumEmailDomain("user@proton.me")).toBe(true);
  });

  it("allows business domains", () => {
    expect(isFreemiumEmailDomain("user@acme.com")).toBe(false);
    expect(isFreemiumEmailDomain("founder@startup.io")).toBe(false);
  });

  it("matches exactly — a domain that merely ends with a denied host is allowed", () => {
    // `notgmail.com` / a subdomain must not be swept up by `gmail.com`.
    expect(isFreemiumEmailDomain("user@notgmail.com")).toBe(false);
    expect(isFreemiumEmailDomain("user@mail.gmail.com.evil.com")).toBe(false);
  });

  it("keeps the denylist non-empty and lower-case (maintenance guard)", () => {
    expect(FREEMIUM_EMAIL_DOMAINS.size).toBeGreaterThan(20);
    for (const d of FREEMIUM_EMAIL_DOMAINS) {
      expect(d).toBe(d.toLowerCase());
    }
  });
});

describe("isDisposableEmail", () => {
  it("flags throwaway mailboxes via the mailchecker engine", () => {
    expect(isDisposableEmail("foo@mailinator.com")).toBe(true);
    expect(isDisposableEmail("foo@guerrillamail.com")).toBe(true);
    expect(isDisposableEmail("foo@10minutemail.com")).toBe(true);
  });

  it("passes real domains (business and freemium alike — freemium is a separate deny)", () => {
    expect(isDisposableEmail("alice@acme.com")).toBe(false);
    expect(isDisposableEmail("alice@gmail.com")).toBe(false);
  });

  it("is safe (no throw) on empty input — the underlying validateEmail throws on null", () => {
    // Hardening for a direct caller that skips assertBusinessEmail's empty guard
    // (e.g. the MCP start_trial provisioner). Empty is reported not-disposable;
    // Better Auth owns the required-field case.
    expect(isDisposableEmail("")).toBe(false);
  });
});

describe("classifyBusinessEmail", () => {
  it("reports disposable, freemium, and ok", () => {
    expect(classifyBusinessEmail("a@mailinator.com")).toEqual({ ok: false, reason: "disposable" });
    expect(classifyBusinessEmail("a@gmail.com")).toEqual({ ok: false, reason: "freemium" });
    expect(classifyBusinessEmail("a@acme.com")).toEqual({ ok: true });
  });

  it("does not throw on empty input (defers required-field to Better Auth)", () => {
    expect(classifyBusinessEmail("")).toEqual({ ok: true });
  });
});

describe("assertBusinessEmail", () => {
  function thrownBy(fn: () => void): unknown {
    try {
      fn();
    } catch (err) {
      return err;
    }
    return undefined;
  }

  it("rejects a freemium domain with a typed 400 APIError", () => {
    const err = thrownBy(() => assertBusinessEmail("user@gmail.com"));
    expect(err).toBeInstanceOf(APIError);
    const apiErr = err as APIError;
    expect(apiErr.statusCode).toBe(400);
    expect(apiErr.body?.code).toBe(BUSINESS_EMAIL_REQUIRED_CODE);
    expect(apiErr.body?.message).toBe(BUSINESS_EMAIL_REQUIRED_MESSAGE);
    expect((apiErr.body as { reason?: string })?.reason).toBe("freemium");
  });

  it("rejects a disposable domain with the same typed code", () => {
    const err = thrownBy(() => assertBusinessEmail("user@mailinator.com"));
    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).body?.code).toBe(BUSINESS_EMAIL_REQUIRED_CODE);
    expect(((err as APIError).body as { reason?: string })?.reason).toBe("disposable");
  });

  it("allows a legitimate business domain", () => {
    expect(thrownBy(() => assertBusinessEmail("founder@acme.com"))).toBeUndefined();
  });

  it("is a no-op for null/empty email (Better Auth owns the required-field case)", () => {
    expect(thrownBy(() => assertBusinessEmail(null))).toBeUndefined();
    expect(thrownBy(() => assertBusinessEmail(undefined))).toBeUndefined();
    expect(thrownBy(() => assertBusinessEmail(""))).toBeUndefined();
  });
});

describe("isBusinessEmailRejection", () => {
  it("recognizes the thrown business-email rejection by stable code", () => {
    let caught: unknown;
    try {
      assertBusinessEmail("user@gmail.com");
    } catch (err) {
      caught = err;
    }
    expect(isBusinessEmailRejection(caught)).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isBusinessEmailRejection(new Error("boom"))).toBe(false);
    expect(isBusinessEmailRejection(new APIError("BAD_REQUEST", { code: "OTHER" }))).toBe(false);
    expect(isBusinessEmailRejection(undefined)).toBe(false);
    expect(isBusinessEmailRejection({ body: { code: BUSINESS_EMAIL_REQUIRED_CODE } })).toBe(false);
  });
});
