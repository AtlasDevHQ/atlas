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
  deriveMeetingParticipantGrant,
  isUsableGrant,
  meetingAudienceId,
  parseChatChannelAudienceId,
  parseMeetingAudienceId,
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

describe("deriveMeetingParticipantGrant (#4965)", () => {
  const COMPLETE = { source: "zoom", meetingId: "4kd8sZTiSHagYbwYtLpMRA==", rosterComplete: true };

  it("maps a meeting to a meeting-scoped audience, and the token is USABLE", () => {
    const grant = deriveMeetingParticipantGrant(COMPLETE);
    expect(grant).toEqual([`${AUDIENCE_PREFIX}meeting:zoom:4kd8sZTiSHagYbwYtLpMRA==`]);
    // Asserted through `parseGrant`, not against the literal, for the reason in
    // this file's header: a grant that passes 0180's CHECK but names no
    // principal is legal, invisible, and permanently unpublishable.
    expect(parseGrant(grant ?? []).principals).toEqual([
      { kind: "audience", audienceId: "meeting:zoom:4kd8sZTiSHagYbwYtLpMRA==" },
    ]);
    expect(isUsableGrant(grant ?? [])).toBe(true);
  });

  it("NEVER mints the org principal — a meeting has no public mode", () => {
    // The asymmetry with `deriveChatChannelGrant` stated as a law rather than
    // left implicit. There is no input that should produce `[org]` here, so the
    // sweep is over every shape a caller could plausibly pass — including the
    // ones a "generic" deriver would have routed to the public arm.
    for (const participation of [
      COMPLETE,
      { ...COMPLETE, meetingId: "abc123" },
      { ...COMPLETE, rosterComplete: false },
      { source: "zoom", meetingId: "", rosterComplete: true },
      { source: "", meetingId: "abc", rosterComplete: true },
    ]) {
      const grant = deriveMeetingParticipantGrant(participation);
      expect([participation.meetingId, grant?.includes(ORG_PRINCIPAL) ?? false]).toEqual([
        participation.meetingId,
        false,
      ]);
    }
  });

  // ── The BLOCK arm ────────────────────────────────────────────────────────
  // Each of these must return null so the caller abandons the meeting. The
  // failure they guard against is not "returns the wrong grant" — it is
  // "returns a grant at all", because any grant here is one Atlas could not
  // establish the audience for.

  it("BLOCKS on an incomplete roster — the reconcile would revoke what it failed to fetch", () => {
    // The load-bearing one. A partial roster is not merely an under-grant: it
    // is what `reconcileAudienceMembership` DELETES against, so it would revoke
    // every member the vendor read missed, and the damage looks exactly like
    // correct fail-closed behaviour from every surface.
    expect(deriveMeetingParticipantGrant({ ...COMPLETE, rosterComplete: false })).toBeNull();
    // And it blocks REGARDLESS of how well-formed everything else is — the
    // guard is not reachable only via a malformed id.
    expect(
      deriveMeetingParticipantGrant({
        source: "zoom",
        meetingId: "4kd8sZTiSHagYbwYtLpMRA==",
        rosterComplete: false,
      }),
    ).toBeNull();
  });

  it("BLOCKS on a blank or whitespace meeting id or source", () => {
    for (const participation of [
      { source: "zoom", meetingId: "", rosterComplete: true },
      { source: "zoom", meetingId: "   ", rosterComplete: true },
      { source: "", meetingId: "abc", rosterComplete: true },
      { source: "  ", meetingId: "abc", rosterComplete: true },
    ]) {
      expect(deriveMeetingParticipantGrant(participation)).toBeNull();
    }
  });

  it("BLOCKS on a colon-bearing source rather than mis-splitting it", () => {
    // `zoom:eu` would round-trip to `{ source: "zoom", meetingId: "eu:4kd8…" }`
    // — an audience id nobody is a member of, minted silently. The chat builder
    // documents this constraint; the meeting builder enforces it, because the
    // transcript class ships with a second vendor already on the roadmap.
    expect(deriveMeetingParticipantGrant({ ...COMPLETE, source: "zoom:eu" })).toBeNull();
    expect(meetingAudienceId("zoom:eu", "abc")).toBeNull();
  });
});

describe("the meeting audience id round-trips", () => {
  it("parses back to the halves it was built from", () => {
    const id = meetingAudienceId("zoom", "4kd8sZTiSHagYbwYtLpMRA==");
    expect(id).not.toBeNull();
    expect(parseMeetingAudienceId(id ?? "")).toEqual({
      source: "zoom",
      meetingId: "4kd8sZTiSHagYbwYtLpMRA==",
    });
  });

  it("takes the REMAINDER after the second separator, so a colon-bearing meeting id survives", () => {
    // Zoom's cannot contain a colon (base64), but the id grammar is per-vendor
    // and the next vendor's is not this one's. Truncating to a prefix would
    // match no configured meeting — fail-closed, but for a reason nobody could
    // find.
    expect(parseMeetingAudienceId("meeting:acme:a:b:c")).toEqual({
      source: "acme",
      meetingId: "a:b:c",
    });
  });

  it("refuses ids that do not name a meeting — including the CHAT namespace", () => {
    // The cross-namespace direction is the point: #4825's oversight view labels
    // discovered-vs-configured audiences by parsing them, and a parser that
    // accepted the other namespace would label a chat channel as a meeting.
    for (const notMeeting of [
      chatChannelAudienceId("slack", "C01ABCDEF"),
      "meeting:",
      "meeting:zoom",
      "meeting:zoom:",
      "meeting::abc",
      "audience:meeting:zoom:abc",
      "",
    ]) {
      expect([notMeeting, parseMeetingAudienceId(notMeeting)]).toEqual([notMeeting, null]);
    }
  });

  it("and the chat parser refuses a MEETING id — the namespaces are disjoint both ways", () => {
    const meeting = meetingAudienceId("zoom", "abc");
    expect(parseChatChannelAudienceId(meeting ?? "")).toBeNull();
  });
});
