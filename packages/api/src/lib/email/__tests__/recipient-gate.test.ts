/**
 * Unit tests for the shared email recipient-domain gate (#3341, #4479).
 *
 * Real modules throughout (no `mock.module()`) — the gate's two seams are
 * injectable (`resolveMemberEmails`) or env-backed (settings resolution
 * falls through to env when no internal DB row exists). The deprecation
 * warn itself is asserted in `recipient-gate-warn.test.ts` (which needs a
 * logger mock and so lives in its own file for the isolated runner).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";

import {
  checkRecipientsAllowed,
  normalizeEmailAddress,
  resetRecipientGateWarnsForTests,
  EMAIL_RECIPIENT_DOMAINS_SETTING,
  LEGACY_EMAIL_DOMAINS_ENV,
} from "@atlas/api/lib/email/recipient-gate";

const WSID = "ws-recipient-gate-test";

const ENV_KEYS = [EMAIL_RECIPIENT_DOMAINS_SETTING, LEGACY_EMAIL_DOMAINS_ENV] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  resetRecipientGateWarnsForTests();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const members = (...emails: string[]) => async () => emails;

describe("checkRecipientsAllowed — member + domain boundary", () => {
  it("allows workspace members case-insensitively", async () => {
    const result = await checkRecipientsAllowed(
      WSID,
      ["Member@Corp.Example"],
      members("member@corp.example"),
    );
    expect(result.allowed).toBe(true);
  });

  it("blocks a non-member when no domain allowlist is configured (fail-closed default)", async () => {
    const result = await checkRecipientsAllowed(
      WSID,
      ["outsider@evil.example"],
      members("member@corp.example"),
    );
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.blocked).toEqual(["outsider@evil.example"]);
      expect(result.message).toContain(EMAIL_RECIPIENT_DOMAINS_SETTING);
      expect(result.message).toContain("send to a workspace member");
    }
  });

  it("allows recipients on a domain from the surviving setting", async () => {
    process.env[EMAIL_RECIPIENT_DOMAINS_SETTING] = "partner.example, @Other.Example";
    const result = await checkRecipientsAllowed(
      WSID,
      ["a@partner.example", "b@other.example"],
      members(),
    );
    expect(result.allowed).toBe(true);
  });

  it("normalizes display-name recipients before gating", async () => {
    process.env[EMAIL_RECIPIENT_DOMAINS_SETTING] = "corp.example";
    const result = await checkRecipientsAllowed(
      WSID,
      ["User Name <user@corp.example>"],
      members(),
    );
    expect(result.allowed).toBe(true);
  });

  it("fails closed when member resolution throws", async () => {
    const result = await checkRecipientsAllowed(WSID, ["member@corp.example"], async () => {
      throw new Error("db unavailable");
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.blocked).toEqual(["member@corp.example"]);
      expect(result.message).toMatch(/could not be resolved/i);
    }
  });

  it("gates against domains only when no workspace is active (member half inert)", async () => {
    process.env[EMAIL_RECIPIENT_DOMAINS_SETTING] = "partner.example";
    const resolveMemberEmails = async () => {
      throw new Error("must not be called without a workspace");
    };

    const allowed = await checkRecipientsAllowed(
      undefined,
      ["a@partner.example"],
      resolveMemberEmails,
    );
    expect(allowed.allowed).toBe(true);

    const blocked = await checkRecipientsAllowed(
      undefined,
      ["member@corp.example"],
      resolveMemberEmails,
    );
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      // Member half inert — the message must not recommend a remediation
      // that structurally cannot succeed.
      expect(blocked.message).not.toContain("send to a workspace member");
    }
  });
});

describe("checkRecipientsAllowed — single-address enforcement", () => {
  it("blocks a display-name string smuggling a second address past the gate", async () => {
    // The transport chains parse RFC address lists; approving the first
    // embedded address while forwarding the raw string would deliver to
    // the second, unjudged one — the exfiltration channel this module
    // exists to close.
    const result = await checkRecipientsAllowed(
      WSID,
      ["Alice <member@corp.example>, attacker@evil.example"],
      members("member@corp.example"),
    );
    expect(result.allowed).toBe(false);
  });

  it("blocks comma-joined bare addresses in one string", async () => {
    process.env[EMAIL_RECIPIENT_DOMAINS_SETTING] = "corp.example, evil.example";
    const result = await checkRecipientsAllowed(
      WSID,
      ["a@corp.example, b@evil.example"],
      members(),
    );
    expect(result.allowed).toBe(false);
  });

  it("blocks a recipient with no @ sign", async () => {
    process.env[EMAIL_RECIPIENT_DOMAINS_SETTING] = "corp.example";
    const result = await checkRecipientsAllowed(WSID, ["notanemail"], members());
    expect(result.allowed).toBe(false);
  });

  it("blocks a leading stray address riding as display-name text", async () => {
    // "@" is invalid in an unquoted RFC-5322 display name; a lenient
    // downstream parser could split this into two recipients, so the gate
    // must not judge only the angle-bracket address.
    const result = await checkRecipientsAllowed(
      WSID,
      ["attacker@evil.example <member@corp.example>"],
      members("member@corp.example"),
    );
    expect(result.allowed).toBe(false);
  });
});

describe("checkRecipientsAllowed — legacy ATLAS_EMAIL_ALLOWED_DOMAINS fallback (#4479 → #4663)", () => {
  it("honors the deprecated knob when the surviving setting is unconfigured", async () => {
    process.env[LEGACY_EMAIL_DOMAINS_ENV] = "legacy.example";
    const result = await checkRecipientsAllowed(WSID, ["a@legacy.example"], members());
    expect(result.allowed).toBe(true);
  });

  it("ignores the deprecated knob when the surviving setting is set", async () => {
    process.env[EMAIL_RECIPIENT_DOMAINS_SETTING] = "partner.example";
    process.env[LEGACY_EMAIL_DOMAINS_ENV] = "legacy.example";
    const result = await checkRecipientsAllowed(WSID, ["a@legacy.example"], members());
    expect(result.allowed).toBe(false);
  });

  it("ignores the deprecated knob when the surviving setting is explicitly cleared", async () => {
    // "" is an explicit members-only policy, not an absence — a lingering
    // legacy env var must not silently widen it (#4479 review finding).
    process.env[EMAIL_RECIPIENT_DOMAINS_SETTING] = "";
    process.env[LEGACY_EMAIL_DOMAINS_ENV] = "legacy.example";
    const result = await checkRecipientsAllowed(WSID, ["a@legacy.example"], members());
    expect(result.allowed).toBe(false);
  });

  it("still allows workspace members alongside the legacy domain list", async () => {
    process.env[LEGACY_EMAIL_DOMAINS_ENV] = "legacy.example";
    const result = await checkRecipientsAllowed(
      WSID,
      ["member@corp.example", "a@legacy.example"],
      members("member@corp.example"),
    );
    expect(result.allowed).toBe(true);
  });
});

describe("normalizeEmailAddress", () => {
  it("strips a display-name wrapper", () => {
    expect(normalizeEmailAddress("User <user@corp.example>")).toBe("user@corp.example");
  });

  it("passes bare addresses through", () => {
    expect(normalizeEmailAddress(" user@corp.example ")).toBe("user@corp.example");
  });

  it("returns null for multi-address strings", () => {
    expect(normalizeEmailAddress("A <a@x.example>, B <b@y.example>")).toBeNull();
    expect(normalizeEmailAddress("a@x.example, b@y.example")).toBeNull();
    expect(normalizeEmailAddress("A <a@x.example>, b@y.example")).toBeNull();
    expect(normalizeEmailAddress("a@x.example;b@y.example")).toBeNull();
    expect(normalizeEmailAddress("attacker@evil.example <member@corp.example>")).toBeNull();
  });

  it("returns null for strings that are not a single address", () => {
    expect(normalizeEmailAddress("notanemail")).toBeNull();
    expect(normalizeEmailAddress("a@b@c.example")).toBeNull();
    expect(normalizeEmailAddress("")).toBeNull();
  });
});
