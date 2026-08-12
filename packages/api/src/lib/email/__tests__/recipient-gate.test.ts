/**
 * Unit tests for the shared email recipient-domain gate (#3341, #4479, #4663).
 *
 * Real modules throughout (no `mock.module()`) — the gate's two seams are
 * injectable (`resolveMemberEmails`) or env-backed (settings resolution
 * falls through to env when no internal DB row exists).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";

import {
  checkRecipientsAllowed,
  normalizeEmailAddress,
  resetRecipientGateWarnsForTests,
  EMAIL_RECIPIENT_DOMAINS_SETTING,
} from "@atlas/api/lib/email/recipient-gate";

const WSID = "ws-recipient-gate-test";

/**
 * The env knob #4663 retired. Named here and nowhere else in the source tree:
 * a removal is only verifiable if something SETS the removed name and watches
 * it do nothing, so this literal is the experiment, not a read.
 */
const RETIRED_DOMAINS_ENV = "ATLAS_EMAIL_ALLOWED_DOMAINS";

const ENV_KEYS = [EMAIL_RECIPIENT_DOMAINS_SETTING, RETIRED_DOMAINS_ENV] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  // Nothing in this file trips the no-internal-DB latch (every test injects
  // `resolveMemberEmails`), and this file uses the real logger so it could
  // not assert on the warn anyway — the assertion lives in
  // `lib/tools/actions/__tests__/email-recipient-gate.test.ts`. This call is
  // hygiene for a future test that drops the injected resolver.
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

describe("checkRecipientsAllowed — unconfigured survivor is members-only (#4663)", () => {
  // #4663 dropped the retired env-only fallback domain list, and the failure
  // mode to fear is a removal that WIDENS the allowed set. So every test here
  // SETS the retired knob to a domain one recipient belongs to: a resolver
  // that consulted it again — the exact regression — admits
  // `b@retired-knob.example` and fails. That set-and-assert-nothing-happens
  // is the only thing that can distinguish this code from its predecessor;
  // asserting the end state alone passes against both.
  //
  // The fixture is also deliberately asymmetric so a resolver that returned
  // some OTHER non-empty domain set cannot slip through: two members pass,
  // two non-members on two distinct domains are blocked, and the blocked
  // list is asserted by equality rather than membership.
  const RECIPIENTS = [
    "Member@Corp.Example",
    "second@corp.example",
    "a@partner.example",
    "b@retired-knob.example",
  ] as const;
  const MEMBERS = members("member@corp.example", "second@corp.example");
  const BLOCKED = ["a@partner.example", "b@retired-knob.example"];

  beforeEach(() => {
    process.env[RETIRED_DOMAINS_ENV] = "retired-knob.example, partner.example";
  });

  it("blocks every non-member when the surviving setting is unset", async () => {
    const result = await checkRecipientsAllowed(WSID, [...RECIPIENTS], MEMBERS);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.blocked).toEqual(BLOCKED);
  });

  it('blocks every non-member when the surviving setting is cleared to ""', async () => {
    // "" is an explicit members-only policy; post-#4663 it is also what an
    // absent setting means, so the two cases must agree — and neither may
    // re-expose the retired knob's list (the #4479 review finding, now the
    // permanent state rather than a fallback precedence rule).
    process.env[EMAIL_RECIPIENT_DOMAINS_SETTING] = "";
    const result = await checkRecipientsAllowed(WSID, [...RECIPIENTS], MEMBERS);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.blocked).toEqual(BLOCKED);
  });

  it("allows only workspace members when nothing is configured", async () => {
    const result = await checkRecipientsAllowed(
      WSID,
      ["Member@Corp.Example", "second@corp.example"],
      MEMBERS,
    );
    expect(result.allowed).toBe(true);
  });

  it("keeps the surviving setting authoritative while the retired knob is set", async () => {
    // The other direction: the survivor is what widens the set, and it does
    // so without the retired knob contributing its own extra domain.
    process.env[EMAIL_RECIPIENT_DOMAINS_SETTING] = "partner.example";
    const result = await checkRecipientsAllowed(WSID, [...RECIPIENTS], MEMBERS);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.blocked).toEqual(["b@retired-knob.example"]);
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
