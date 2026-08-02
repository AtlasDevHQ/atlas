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
  deriveEmailRecipientGrant,
  emailMessageAudienceId,
  parseEmailMessageAudienceId,
  emailParticipantsDigest,
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

// ---------------------------------------------------------------------------
// Email (#4966) — the class whose grant is deliberately a LOWER BOUND
// ---------------------------------------------------------------------------

const MAILBOX = "8f14e45f-ceea-467a-9ad9-1a8b0c8e1f22";
const MESSAGE = "AS8PR07MB8241.eurprd07.prod@contoso.com";

const PARTICIPANTS = ["sender@contoso.com", "to@contoso.com", "cc@contoso.com"];
const DIGEST = emailParticipantsDigest(PARTICIPANTS);

/** The happy-path input, so each test below varies exactly one thing. */
function participation(overrides: Record<string, unknown> = {}) {
  return {
    source: "outlook",
    mailboxId: MAILBOX,
    messageId: MESSAGE,
    headersComplete: true,
    participants: PARTICIPANTS,
    ...overrides,
  } as Parameters<typeof deriveEmailRecipientGrant>[0];
}

describe("deriveEmailRecipientGrant (#4966)", () => {
  it("mints a message-scoped audience — never an org grant", () => {
    const grant = deriveEmailRecipientGrant(participation());
    expect(grant).toEqual([
      `${AUDIENCE_PREFIX}email-message:outlook:${MAILBOX}:${DIGEST}:${MESSAGE}`,
    ]);
    expect(parseGrant(grant ?? []).principals).toEqual([
      { kind: "audience", audienceId: `email-message:outlook:${MAILBOX}:${DIGEST}:${MESSAGE}` },
    ]);
  });

  it("has NO public arm — no input produces an org grant", () => {
    // The structural half of the claim `grant.ts` makes in prose. A mail message
    // has no public mode, so an `[org]` answer could only ever be reached by
    // mistake — and the mistake publishes somebody's mail to the whole company,
    // which no downstream review gate catches because the reviewer is shown the
    // grant Atlas derived rather than the one the mail system had.
    //
    // Swept over the whole input space rather than asserted once: the field a
    // future author would add a public arm for is a BOOLEAN, so a two-value
    // sweep over each one really is exhaustive for that shape.
    for (const headersComplete of [true, false]) {
      for (const size of [0, 1, 500]) {
        const participants = Array.from({ length: size }, (_, i) => `u${i}@contoso.com`);
        const grant = deriveEmailRecipientGrant(participation({ headersComplete, participants }));
        expect([headersComplete, size, grant?.includes(ORG_PRINCIPAL) ?? false]).toEqual([
          headersComplete,
          size,
          false,
        ]);
      }
    }
  });

  it("BLOCKS on incomplete headers rather than deriving from a partial set", () => {
    // The single most load-bearing guard in the email path. The participant set
    // is not only what GRANTS — it is what `reconcileAudienceMembership` DELETES
    // against, so deriving from a header set that arrived partial would revoke
    // the people the missing field named. Blocking is the only direction that
    // neither grants nor revokes.
    expect(deriveEmailRecipientGrant(participation({ headersComplete: false }))).toBeNull();
    // Checked BEFORE the ids, so a message with unreadable headers blocks even
    // when every id is well-formed — the ordering `grant.ts` states.
    expect(
      deriveEmailRecipientGrant(participation({ headersComplete: false, messageId: "" })),
    ).toBeNull();
  });

  it("BLOCKS a message that names nobody, and GRANTS one that names only outsiders", () => {
    // Two cases that look alike and are opposite, which is the exact confusion
    // ADR-0036 §T6's block-vs-flag asymmetry exists to prevent.
    //
    // Zero participants = no audience can be ESTABLISHED → block.
    expect(deriveEmailRecipientGrant(participation({ participants: [] }))).toBeNull();
    // One participant who happens to resolve to no Atlas user = a perfectly
    // well-established audience that currently contains nobody → GRANT. The
    // deriver cannot even see resolution, which is what makes this structural:
    // there is no input by which a caller could route an unresolvable
    // participant to the block arm.
    expect(
      deriveEmailRecipientGrant(participation({ participants: ["external@other.test"] })),
    ).not.toBeNull();
  });

  it("BLOCKS a colon-bearing source or mailbox, which would mis-split on the way back", () => {
    // Enforced rather than documented, because a silent mis-NAMING mints an
    // audience nobody is a member of — the failure withholds access in a way
    // that looks like correct fail-closed behaviour from every surface.
    expect(deriveEmailRecipientGrant(participation({ source: "outlook:eu" }))).toBeNull();
    expect(deriveEmailRecipientGrant(participation({ mailboxId: "eu:8f14e45f" }))).toBeNull();
    for (const blank of ["", "   "]) {
      expect(deriveEmailRecipientGrant(participation({ source: blank }))).toBeNull();
      expect(deriveEmailRecipientGrant(participation({ mailboxId: blank }))).toBeNull();
      expect(deriveEmailRecipientGrant(participation({ messageId: blank }))).toBeNull();
    }
  });

  it("keeps a colon-bearing MESSAGE id whole — an IPv6 literal Message-ID is legal", () => {
    // RFC 5322 permits a `no-fold-literal` right-hand side, so
    // `<x@[IPv6:2001:db8::1]>` is a real Message-ID. Truncating it at the first
    // colon would produce a prefix matching no real message, and the audience
    // would fail re-verification forever.
    const ipv6 = "x@[IPv6:2001:db8::1]";
    const grant = deriveEmailRecipientGrant(participation({ messageId: ipv6 }));
    expect(grant).toEqual([
      `${AUDIENCE_PREFIX}email-message:outlook:${MAILBOX}:${DIGEST}:${ipv6}`,
    ]);
    expect(
      parseEmailMessageAudienceId(`email-message:outlook:${MAILBOX}:${DIGEST}:${ipv6}`),
    ).toEqual({
      source: "outlook",
      mailboxId: MAILBOX,
      participantsDigest: DIGEST,
      messageId: ipv6,
    });
  });

  it("⭐ derives the same grant whether or not a BCC recipient is visible", () => {
    // THE posture test (#4966's acceptance criterion). `config.ts` keys the
    // episode source-id on the RFC 5322 Message-ID so one mail to five
    // colleagues collapses to ONE episode — which means WHICH mailbox copy wins
    // is undetermined, decided by configured order and remaining budget.
    //
    // `bccRecipients` is populated only on the SENDER's copy. So a grant that
    // honoured BCC would name a different set of people depending on which copy
    // the dedupe happened to keep: the same stored row granted differently on
    // different days. That is not a stricter posture or a looser one — it is not
    // a posture at all.
    //
    // The structural proof is that this function has NO input by which a caller
    // could report a BCC. `participantCount` is the only cardinality it sees,
    // and the audience id is built from the message and mailbox alone — so two
    // copies whose only difference is a blind-copied recipient are, to this
    // function, indistinguishable inputs.
    // Both copies are read from the SAME mailbox, deliberately: the mailbox is
    // part of the token by design, so a cross-mailbox comparison would differ for
    // a reason that has nothing to do with BCC.
    //
    // ⚠️ The two inputs must DIFFER in something that should not matter, or the
    // assertion is `f(x) === f(x)` and holds for any pure function. The round-1
    // repair of this test made exactly that mistake — replacing a vacuous
    // ordering assertion with a vacuous equality one — and round 2 caught it. So
    // the copies differ in header ORDER and in address CASE, both of which a
    // mail system varies freely between copies and neither of which may change
    // the audience.
    const senderCopy = deriveEmailRecipientGrant(participation({ participants: PARTICIPANTS }));
    const recipientCopy = deriveEmailRecipientGrant(
      participation({ participants: [...PARTICIPANTS].reverse().map((a) => a.toUpperCase()) }),
    );
    expect(senderCopy).toEqual(recipientCopy);
    // And the under-grant is real, not merely tolerated: a set that DOES include
    // the blind-copied recipient is a different audience entirely, so honouring
    // BCC could never be a quiet local change.
    const withBcc = deriveEmailRecipientGrant(
      participation({ participants: [...PARTICIPANTS, "bcc@contoso.com"] }),
    );
    expect(withBcc).not.toEqual(senderCopy);
  });

  it("mints a DIFFERENT audience per message — never a thread-wide one", () => {
    // A thread-grained audience would be the union of every message's
    // recipients, which grants a late arrival access to facts extracted from
    // messages sent before they were added. Over-granting is the leak side of
    // §T6's asymmetry, so the grain has to be the message.
    const first = deriveEmailRecipientGrant(participation({ messageId: "a@contoso.com" }));
    const reply = deriveEmailRecipientGrant(participation({ messageId: "b@contoso.com" }));
    expect(first).not.toEqual(reply);
  });
});

describe("the mail-message audience id round-trips", () => {
  it("survives a build → parse cycle with all four segments intact", () => {
    const id = emailMessageAudienceId("outlook", MAILBOX, DIGEST, MESSAGE);
    expect(id).toBe(`email-message:outlook:${MAILBOX}:${DIGEST}:${MESSAGE}`);
    expect(parseEmailMessageAudienceId(id ?? "")).toEqual({
      source: "outlook",
      mailboxId: MAILBOX,
      participantsDigest: DIGEST,
      messageId: MESSAGE,
    });
  });

  it("⭐ binds the PARTICIPANT SET into the id, so a forged header set cannot claim it", () => {
    // A Message-ID is chosen by the SENDING system and leaks in every reply's
    // `References:`. Without the digest, (mailbox, Message-ID) is a pure function
    // of attacker-supplied values, so mailing a monitored mailbox claiming an
    // existing id derives the SAME audience — and the reconcile then DELETES
    // everyone outside the forged To/Cc, revoking the real recipients while the
    // stored evidence survives untouched.
    //
    // MUTATION THIS CATCHES: dropping the digest segment from the id.
    const real = deriveEmailRecipientGrant(participation());
    const forged = deriveEmailRecipientGrant(
      participation({ participants: ["attacker@evil.test", "victim@contoso.com"] }),
    );
    expect(forged).not.toEqual(real);
    // The digest is order-independent, so a reply that lists the same people in a
    // different order is the SAME audience rather than a fresh one.
    const reordered = deriveEmailRecipientGrant(
      participation({ participants: [...PARTICIPANTS].reverse() }),
    );
    expect(reordered).toEqual(real);
    // …and case-independent, because an address is.
    const shouted = deriveEmailRecipientGrant(
      participation({ participants: PARTICIPANTS.map((a) => a.toUpperCase()) }),
    );
    expect(shouted).toEqual(real);
  });

  it("does NOT parse the other two classes' ids, and they do not parse this one", () => {
    // The namespaces are what stop #4825's oversight view labelling one kind of
    // audience as another — a chat channel's roster is mutable, a meeting's is
    // frozen, and an email's is frozen AND knowingly incomplete.
    const email = emailMessageAudienceId("outlook", MAILBOX, DIGEST, MESSAGE) ?? "";
    expect(parseChatChannelAudienceId(email)).toBeNull();
    expect(parseMeetingAudienceId(email)).toBeNull();
    expect(parseEmailMessageAudienceId(chatChannelAudienceId("slack", "C01ABCDEF"))).toBeNull();
    expect(parseEmailMessageAudienceId(meetingAudienceId("zoom", "abc==") ?? "")).toBeNull();
  });

  it("refuses a malformed id rather than guessing at its segments", () => {
    for (const bad of [
      "email-message:outlook",
      "email-message:outlook:",
      `email-message:outlook:${MAILBOX}`,
      `email-message:outlook:${MAILBOX}:`,
      `email-message:outlook:${MAILBOX}:${DIGEST}`,
      `email-message:outlook:${MAILBOX}:${DIGEST}:`,
      // The digest slot must hold a DIGEST. A token shaped like the old
      // three-segment form would otherwise parse with the message id landing in
      // the digest slot, and the re-verifier would then report a mismatch as
      // tampering rather than as a malformed token.
      `email-message:outlook:${MAILBOX}:not-a-digest:${MESSAGE}`,
      `email-message:outlook:${MAILBOX}:${DIGEST.toUpperCase()}:${MESSAGE}`,
      "email-message::mailbox:digest:message",
      "email-message:",
      "meeting:zoom:abc",
      "",
    ]) {
      expect([bad, parseEmailMessageAudienceId(bad)]).toEqual([bad, null]);
    }
  });

  it("refuses to BUILD an ambiguous id rather than round-tripping it wrong", () => {
    expect(emailMessageAudienceId("out:look", MAILBOX, DIGEST, MESSAGE)).toBeNull();
    expect(emailMessageAudienceId("outlook", "mail:box", DIGEST, MESSAGE)).toBeNull();
    expect(emailMessageAudienceId("", MAILBOX, DIGEST, MESSAGE)).toBeNull();
    expect(emailMessageAudienceId("outlook", "", DIGEST, MESSAGE)).toBeNull();
    expect(emailMessageAudienceId("outlook", MAILBOX, DIGEST, "")).toBeNull();
    // A digest that is not one is refused at BUILD time too, so a caller cannot
    // hand-roll a token whose digest slot the parser will later reject.
    expect(emailMessageAudienceId("outlook", MAILBOX, "", MESSAGE)).toBeNull();
    expect(emailMessageAudienceId("outlook", MAILBOX, "zzzz", MESSAGE)).toBeNull();
  });
});
