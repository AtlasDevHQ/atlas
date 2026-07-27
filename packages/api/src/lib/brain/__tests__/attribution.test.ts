/**
 * `attributionDecision` — who is entitled to a widened fact's first-episode
 * attribution (#4836, ADR-0036 §T5).
 *
 * The narrowing is worth exactly one property, and it is the one asserted
 * hardest here: a reader gained by publish-time widening (#4823) is NOT the
 * same set as a reader of the fact. Every test below is written as a pair —
 * the reader who was always entitled and the reader who was not — because
 * either half alone passes under two different broken implementations
 * ("withhold from everybody" degrades the review surface; "disclose to
 * everybody" is the bug).
 */

import { describe, expect, it } from "bun:test";
import { attributionDecision } from "@atlas/api/lib/brain/attribution";
import type { BrainPrincipalContext } from "@atlas/api/lib/brain/acl";

const WS = "ws-attribution";
/** A Slack private channel's derived audience — `<channelId>` is the leak. */
const PRIVATE = "audience:chat-channel:slack:C-FOUNDERS";

function ctx(
  partial: Partial<Extract<BrainPrincipalContext, { origin: "authenticated" }>> = {},
): BrainPrincipalContext {
  return {
    origin: "authenticated",
    workspaceId: WS,
    userId: "user-1",
    role: "member",
    audienceIds: [],
    ...partial,
  };
}

const row = (pre_widening_visible_to: unknown) => ({ id: "fact-1", pre_widening_visible_to });

describe("attributionDecision — the widened-fact disclosure (#4836)", () => {
  it("withholds from a reader who reaches the fact ONLY through widening", () => {
    // The exact shape of the leak: stated first in a private channel, restated
    // publicly, published as the union. An org member matches `org` on the
    // widened grant and nothing on the original.
    expect(attributionDecision(row([PRIVATE]), ctx())).toBe("withhold");
  });

  it("discloses to a reader entitled to the ORIGINAL grant", () => {
    // The half that must not regress. Degrading attribution for the private
    // channel's own members would make the review surface worse for exactly
    // the people who can act on it — #4836 refuses that trade explicitly.
    expect(
      attributionDecision(row([PRIVATE]), ctx({ audienceIds: ["chat-channel:slack:C-FOUNDERS"] })),
    ).toBe("disclose");
  });

  it("discloses when the fact was never widened", () => {
    // NULL is the overwhelming majority — every fact promoted through
    // `PROMOTE_FACTS_SQL`, and every fact published before migration 0183.
    // Nobody gained access through widening, so every reader is an original.
    expect(attributionDecision(row(null), ctx())).toBe("disclose");
  });

  it("WITHHOLDS when the column is absent from the row, rather than reading it as NULL", () => {
    // The distinction this module most had to get right. `pg` returns `null`
    // for SQL NULL and `undefined` only when the column was not SELECTed, so
    // `undefined` means the query drifted rather than that the fact is
    // unwidened. Collapsing the two would hand a new read surface that forgot
    // `f.pre_widening_visible_to` silent full disclosure: the required third
    // argument to `projectProvenance` forces a new surface to ASK the
    // question, but nothing forces it to select the column.
    expect(attributionDecision(row(undefined), ctx({ role: "owner" }))).toBe("withhold");
  });

  it("discloses when the original grant already covered the reader by role", () => {
    // Role implication is monotone (`impliedRoles`), so an `owner` reading a
    // fact originally granted `role:member` was always entitled. A naive
    // exact-token compare would withhold here and quietly strip attribution
    // from admins across the whole queue.
    expect(attributionDecision(row(["role:member"]), ctx({ role: "owner" }))).toBe("disclose");
  });

  it("withholds from a reader in a DIFFERENT audience than the original", () => {
    // `audience:A` and `audience:B` are incomparable — being in one private
    // channel confers nothing about another's membership, and the union grant
    // is precisely what makes this reader able to see the fact at all.
    expect(
      attributionDecision(row([PRIVATE]), ctx({ audienceIds: ["chat-channel:slack:C-OTHER"] })),
    ).toBe("withhold");
  });

  it("withholds when the stored grant is not an array — unknown entitlement is a deny", () => {
    // Unreachable from a `text[]` column. If query drift ever produced it, the
    // reader's entitlement is unknown, and unknown on an ACL boundary is a
    // deny — never the disclose that a `?? []`-shaped fallback would give.
    for (const junk of ["org", 42, {}, true]) {
      expect(attributionDecision(row(junk), ctx({ role: "owner" }))).toBe("withhold");
    }
  });

  it("ignores NULL elements in the stored grant rather than matching on them", () => {
    // `text[]` admits NULL elements and migration 0180's CHECK only requires
    // one USABLE principal, so `[null, PRIVATE]` is legal at rest. The null
    // must be inert: matching on it would make every reader an original reader.
    expect(attributionDecision(row([null, PRIVATE]), ctx())).toBe("withhold");
    expect(
      attributionDecision(
        row([null, PRIVATE]),
        ctx({ audienceIds: ["chat-channel:slack:C-FOUNDERS"] }),
      ),
    ).toBe("disclose");
    // A grant of nothing but nulls grants nobody anything.
    expect(attributionDecision(row([null, null]), ctx({ role: "owner" }))).toBe("withhold");
  });

  it("withholds an EMPTY original grant from everyone, including an owner", () => {
    // `[]` overlaps nothing, so nobody was entitled before the widening. The
    // check is array-overlap-shaped (via `isVisibleTo`) rather than
    // parse-based, deliberately — what it must agree with is Postgres's `&&`.
    // A fully-malformed grant lands here identically: it overlaps nothing, so
    // it discloses to nobody.
    expect(attributionDecision(row([]), ctx({ role: "owner" }))).toBe("withhold");
  });

  it("withholds from an unauthenticated-local reader unless the original was org-wide", () => {
    // `auth: none` resolves to the `org` principal ONLY, deliberately narrower
    // than what the rest of Atlas hands that mode. A local operator must not
    // read a private channel's first speaker out of a widened fact.
    const local: BrainPrincipalContext = {
      origin: "unauthenticated-local",
      workspaceId: WS,
      userId: null,
      role: null,
      audienceIds: [],
    };
    expect(attributionDecision(row([PRIVATE]), local)).toBe("withhold");
    expect(attributionDecision(row(["org"]), local)).toBe("disclose");
  });

  it("withholds from an unresolved reader even on an org-wide original grant", () => {
    // `principalTokens` returns `[]` for `unresolved`, so `isVisibleTo` denies.
    // The read surfaces throw `BrainReaderUnresolvedError` long before this —
    // but a mirror that disagreed with the predicate in the PERMISSIVE
    // direction is worse than no mirror, and this is that assertion.
    const unresolved: BrainPrincipalContext = {
      origin: "unresolved",
      workspaceId: WS,
      userId: null,
      role: null,
      audienceIds: [],
    };
    expect(attributionDecision(row(["org"]), unresolved)).toBe("withhold");
  });
});
