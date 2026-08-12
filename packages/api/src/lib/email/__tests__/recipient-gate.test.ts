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
 * The env knob #4663 retired. A removal is only verifiable if something SETS
 * the removed name and watches it do nothing, so this literal is the
 * experiment, not a read — it appears nowhere in shipped code, and every
 * occurrence in a test is a set-and-assert-inert fixture like this one.
 * Each suite declares its own rather than sharing one, so that a grep of
 * shipped code stays the acceptance check and no suite imports a fixture
 * from another suite's file.
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
  // mode to fear is a removal that WIDENS the allowed set. Asserting the end
  // state cannot catch that — "unset survivor ⇒ members only" is true of the
  // code before this change too. So the `beforeEach` SETS the retired knob to
  // domains two recipients belong to, and the three tests with a non-member
  // recipient watch it contribute nothing.
  //
  // Those three are three DIFFERENT falsifiers, not three witnesses to one —
  // no single reintroduction shape reddens all of them, so none is redundant.
  // Measured against this suite (18 tests):
  //
  //   unset survivor          a `?? process.env[retired]` re-add       18 -> 17
  //   survivor cleared to ""  a `||`-shaped re-add reading "" as absent 18 -> 16
  //   survivor authoritative  a union that merges instead of replacing  18 -> 15
  //
  // The middle two cannot redden on a plain `??` re-add: `??` treats both a
  // configured "" and a configured value as present, so the retired tier is
  // never reached. That precedence is the point of the pair.
  //
  // The fixture is also deliberately asymmetric so a resolver that returned
  // some OTHER non-empty domain set cannot slip through: two members pass,
  // two non-members on two distinct domains are blocked, and the blocked
  // list is asserted by equality rather than membership.
  //
  // The fourth test is a positive control and is labelled as such: its
  // recipients are all members, so `memberEmails.has(...)` short-circuits
  // before the domain set is consulted and NO widening mutation can redden
  // it. It is a readable in-block sanity check, nothing more.
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

  // POSITIVE CONTROL, not part of the experiment — see the note above. Its
  // coverage is redundant: the three tests above already prove both members
  // passed the filter (they are absent from the asserted blocked list), and
  // inverting the `blocked.length === 0` allow verdict reddens five tests
  // elsewhere in this file. Kept as a readable in-block sanity check.
  it("allows workspace members when nothing is configured", async () => {
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
