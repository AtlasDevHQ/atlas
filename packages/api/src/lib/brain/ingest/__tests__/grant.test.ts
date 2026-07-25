/**
 * The grant deriver (#4770) — the write side of ADR-0036 §T5.
 *
 * The property under test is narrow and the whole slice leans on it: every
 * grant this module mints must be USABLE by `parseGrant`. A grant that passes
 * migration 0180's CHECK but names no principal is legal, invisible, and — once
 * #4771 turns episodes into facts — refused at every publish forever with no
 * repair UI until #4772. So the tests assert against `parseGrant` itself rather
 * than against expected strings: an assertion on the literal `"org"` would
 * still pass if the grammar moved underneath it.
 */

import { describe, expect, it } from "bun:test";
import {
  AUDIENCE_PREFIX,
  ORG_PRINCIPAL,
  parseGrant,
} from "@atlas/api/lib/brain/acl";
import {
  chatChannelAudienceId,
  deriveChatChannelGrant,
  isUsableGrant,
} from "@atlas/api/lib/brain/ingest/grant";

describe("deriveChatChannelGrant", () => {
  it("maps a public channel to the explicit org principal", () => {
    const grant = deriveChatChannelGrant({
      source: "slack",
      channelId: "C01ABCDEF",
      isPrivate: false,
    });
    expect(grant).toEqual([ORG_PRINCIPAL]);
    // ADR-0036: "visible to everyone" is a STATED grant, so a forgotten grant
    // can never read as public.
    expect(parseGrant(grant ?? []).principals).toEqual([{ kind: "org" }]);
  });

  it("maps a private channel to a channel-scoped audience", () => {
    const grant = deriveChatChannelGrant({
      source: "slack",
      channelId: "G01SECRET",
      isPrivate: true,
    });
    const parsed = parseGrant(grant ?? []);
    expect(parsed.principals).toEqual([
      { kind: "audience", audienceId: chatChannelAudienceId("slack", "G01SECRET") },
    ]);
    expect(parsed.malformed).toEqual([]);
  });

  it("namespaces the audience id by SOURCE, so two vendors' channels can't merge", () => {
    // `fact_audience_member` has no column that tells vendors apart, so the
    // namespace has to live in the id itself.
    const slack = deriveChatChannelGrant({ source: "slack", channelId: "C1", isPrivate: true });
    const teams = deriveChatChannelGrant({ source: "teams", channelId: "C1", isPrivate: true });
    expect(slack).not.toEqual(teams);
  });

  it("builds tokens from the exported prefixes, never a literal", () => {
    const grant = deriveChatChannelGrant({ source: "slack", channelId: "C1", isPrivate: true });
    expect(grant?.[0]?.startsWith(AUDIENCE_PREFIX)).toBe(true);
  });

  it("refuses rather than widening when the channel id is blank", () => {
    // ADR-0036 §T6 puts grant-derivation failure on the BLOCK side. There is no
    // safe default: `[org]` would publish content whose audience Atlas failed
    // to establish.
    expect(deriveChatChannelGrant({ source: "slack", channelId: "   ", isPrivate: true })).toBeNull();
    expect(deriveChatChannelGrant({ source: "", channelId: "C1", isPrivate: true })).toBeNull();
  });

  it("treats unknown visibility as PRIVATE at every call site that can pass it", () => {
    // The contract `ChatChannelVisibility.isPrivate` states: a vendor that
    // cannot determine visibility passes `true`. This pins the consequence —
    // `true` never produces the org-wide grant.
    const grant = deriveChatChannelGrant({ source: "slack", channelId: "C1", isPrivate: true });
    expect(grant).not.toContain(ORG_PRINCIPAL);
  });

  it("never mints a grant parseGrant finds unusable", () => {
    for (const isPrivate of [true, false]) {
      for (const channelId of ["C1", "G0123456789", "CABCDEFGHIJ"]) {
        const grant = deriveChatChannelGrant({ source: "slack", channelId, isPrivate });
        expect(grant).not.toBeNull();
        expect(isUsableGrant(grant ?? [])).toBe(true);
      }
    }
  });
});

describe("isUsableGrant", () => {
  it("rejects the grants the 0180 CHECK admits but nobody can match", () => {
    // Each of these has cardinality ≥ 1 and would be stored happily.
    expect(isUsableGrant(["everyone"])).toBe(false);
    expect(isUsableGrant(["team:eng"])).toBe(false);
    expect(isUsableGrant(["ROLE:admin"])).toBe(false);
    expect(isUsableGrant(["role:platform_admin"])).toBe(false);
    expect(isUsableGrant(["user:"])).toBe(false);
    expect(isUsableGrant([`${AUDIENCE_PREFIX}`])).toBe(false);
  });

  it("accepts a grant with at least ONE usable principal among malformed ones", () => {
    // The `['user:abc', 'everyone']` case `logGrantAnomalies` exists for: the
    // row IS reachable, so refusing it here would drop evidence over a stray
    // token.
    expect(isUsableGrant(["user:abc", "everyone"])).toBe(true);
  });

  it("rejects an empty grant and one made only of NULL/empty elements", () => {
    expect(isUsableGrant([])).toBe(false);
    expect(isUsableGrant([null, ""])).toBe(false);
  });

  it("accepts every arm of the grammar", () => {
    expect(isUsableGrant([ORG_PRINCIPAL])).toBe(true);
    expect(isUsableGrant(["role:owner"])).toBe(true);
    expect(isUsableGrant(["role:admin"])).toBe(true);
    expect(isUsableGrant(["role:member"])).toBe(true);
    expect(isUsableGrant(["user:u-1"])).toBe(true);
    expect(isUsableGrant([`${AUDIENCE_PREFIX}x`])).toBe(true);
  });
});
