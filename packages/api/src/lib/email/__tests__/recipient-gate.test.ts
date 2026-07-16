/**
 * Unit tests for the shared email recipient-domain gate (#3341, #4479).
 *
 * Real modules throughout (no `mock.module()`) — the gate's two seams are
 * injectable (`resolveMemberEmails`) or env-backed (the settings registry
 * falls through to env when no internal DB row exists).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";

import {
  checkRecipientsAllowed,
  normalizeEmailAddress,
  resetLegacyKnobWarnForTests,
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
  resetLegacyKnobWarnForTests();
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
});

describe("checkRecipientsAllowed — legacy ATLAS_EMAIL_ALLOWED_DOMAINS fallback (#4479)", () => {
  it("honors the deprecated knob when the surviving setting is unset", async () => {
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
  it("strips display-name wrappers", () => {
    expect(normalizeEmailAddress("User <user@corp.example>")).toBe("user@corp.example");
  });

  it("passes bare addresses through", () => {
    expect(normalizeEmailAddress(" user@corp.example ")).toBe("user@corp.example");
  });
});
