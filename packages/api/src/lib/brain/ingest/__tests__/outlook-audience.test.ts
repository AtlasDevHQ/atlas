/**
 * Mail-message audience membership + re-verification (#4966).
 *
 * The guards here are the ones whose failure is INVISIBLE from every surface: a
 * mass revocation looks exactly like correct fail-closed behaviour from `/admin`
 * (the facts are still stored, the sync is still green, the people just cannot
 * see them). So each test below names the mutation it catches.
 */

import { describe, expect, it } from "bun:test";
import {
  MAX_REVERIFY_AUDIENCES_PER_WORKSPACE,
  messageParticipants,
  reconcileEmailAudience,
  redactAudienceDigest,
  reverifyOutlookMessageAudiences,
  type OutlookAudienceDeps,
} from "@atlas/api/lib/brain/ingest/outlook/audience";
import {
  REVERIFY_CANDIDATES_SQL,
  TOUCH_REVERIFY_ATTEMPT_SQL,
} from "@atlas/api/lib/brain/audience/reverify";
import type { OutlookMessage } from "@atlas/api/lib/brain/ingest/outlook/api";
import { emailParticipantsDigest } from "@atlas/api/lib/brain/ingest/grant";

const MAILBOX = "8f14e45f";
const MESSAGE = "a@contoso.com";
/** The participant set the fixture message carries, in the deriver's order. */
const PARTICIPANTS = ["sender@contoso.com", "to@contoso.com", "cc@contoso.com"];
const DIGEST = emailParticipantsDigest(PARTICIPANTS);
const AUDIENCE_ID = `email-message:outlook:${MAILBOX}:${DIGEST}:${MESSAGE}`;
const TOKEN = `audience:${AUDIENCE_ID}`;

function address(addr: string | null) {
  return { address: addr, name: null };
}

function message(overrides: Partial<OutlookMessage> = {}): OutlookMessage {
  return {
    graphId: "AAMkAGx",
    internetMessageId: `<${MESSAGE}>`,
    subject: "Q3 pricing",
    receivedDateTime: "2026-07-01T10:00:00Z",
    from: address("sender@contoso.com"),
    toRecipients: [address("to@contoso.com")],
    ccRecipients: [address("cc@contoso.com")],
    headersComplete: true,
    bodyUnreadable: false,
    bodyText: "hello",
    ...overrides,
  };
}

type QueryFn = NonNullable<OutlookAudienceDeps["query"]>;

/**
 * A typed stand-in for `internalQuery` that answers the install scan, the shared
 * candidate scan, and the attempt stamp from canned rows.
 *
 * Routed by STATEMENT rather than by call order, so a test cannot pass because
 * the statements happened to be issued in the order it assumed.
 *
 * One helper rather than an inline closure per test, because `query` is GENERIC
 * (`<T extends Record<string, unknown>>`) and an inline `async (sql: string)`
 * does not satisfy it — bun runs tests untypechecked, so those stubs were green
 * here and red only in the type gate.
 */
function scanQuery(
  audiences: readonly { token: string; has_members: boolean }[],
  onAudienceScan?: (params?: unknown[]) => void,
  onTouch?: (params?: unknown[]) => void,
): QueryFn {
  return async <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]> => {
    if (sql.includes("workspace_plugins")) {
      return [
        { workspace_id: "ws", install_id: "i", config: { tenantId: "t", mailboxes: ["a@b.com"] } },
      ] as unknown as T[];
    }
    if (sql === TOUCH_REVERIFY_ATTEMPT_SQL) {
      onTouch?.(params);
      return [] as T[];
    }
    if (sql !== REVERIFY_CANDIDATES_SQL) {
      // Routed by statement, so an unrecognised one is a fixture that has
      // drifted from the code rather than something to answer with canned rows.
      throw new Error(`unexpected statement in the Outlook re-verify fixture: ${sql}`);
    }
    onAudienceScan?.(params);
    return audiences as unknown as T[];
  };
}

/** A deps bundle whose every vendor/DB call is recorded, none real. */
function deps(overrides: Partial<OutlookAudienceDeps> = {}) {
  const reconciled: { audienceId: string; userIds: readonly string[] }[] = [];
  const base: OutlookAudienceDeps = {
    query: async () => [],
    isEnabled: () => true,
    resolveToken: async () => "tok",
    fetchMessage: async () => ({ ok: true, messages: [message()] }),
    resolve: async (_workspaceId, principals) => ({
      resolved: new Map(principals.map((p) => [p.id, `user-${p.id}`])),
      unresolvedCount: 0,
    }),
    reconcile: async (input) => {
      reconciled.push({ audienceId: input.audienceId, userIds: input.userIds });
      return { added: input.userIds.length, revoked: 0 };
    },
    ...overrides,
  };
  return { deps: base, reconciled };
}

describe("messageParticipants", () => {
  it("takes From + To + Cc, deduped case-insensitively", () => {
    const participants = messageParticipants(
      message({
        from: address("Sender@Contoso.com"),
        toRecipients: [address("to@contoso.com"), address("SENDER@contoso.com")],
        ccRecipients: [address("cc@contoso.com")],
      }),
    );
    expect(participants.map((p) => p.address)).toEqual([
      "sender@contoso.com",
      "to@contoso.com",
      "cc@contoso.com",
    ]);
    // The same person on From and To is ONE participant. Counting them twice
    // inflates `unresolvedCount` into a metric nobody can act on.
    expect(participants).toHaveLength(3);
  });

  it("⭐ cannot include a BCC — the field is not on the type at all", () => {
    // The email class's ACL posture, made structural. `grant.ts` argues it in
    // full: honouring BCC would make the derived grant depend on WHICH mailbox
    // copy the Message-ID dedupe happened to keep, since only the sender's copy
    // carries `bccRecipients`. The same stored row would be granted differently
    // on different days.
    //
    // MUTATION THIS CATCHES: adding a `bcc` field to `OutlookMessage` and
    // pushing it here. There is no other test that would notice.
    const withBcc = { ...message(), bccRecipients: [address("secret@contoso.com")] };
    const participants = messageParticipants(withBcc as OutlookMessage);
    expect(participants.map((p) => p.address)).not.toContain("secret@contoso.com");
  });

  it("labels participants POSITIONALLY, never by address", () => {
    // `resolvePrincipals` logs a sample of unresolved principal ids and its
    // docstring commits to those never being emails. Slack and Zoom get that for
    // free from opaque vendor user ids; email has no non-address identifier, so
    // one is synthesised.
    //
    // The property under test is the PRIVACY one, which holds unconditionally:
    // no address reaches the log. (An earlier version of this comment also
    // claimed the labels were actionable via a correlating log line — they are
    // only partially, and `audience.ts`'s own header now says so. Do not restore
    // that claim here.)
    const participants = messageParticipants(message());
    expect(participants.map((p) => p.id)).toEqual(["from", "to:0", "cc:0"]);
    for (const participant of participants) {
      expect(participant.id).not.toContain("@");
    }
  });

  it("drops entries with no address rather than minting a blank principal", () => {
    const participants = messageParticipants(
      message({ from: address(null), toRecipients: [address(""), address("  ")] }),
    );
    expect(participants.map((p) => p.address)).toEqual(["cc@contoso.com"]);
  });
});

describe("redactAudienceDigest", () => {
  it("⭐ blanks the participant digest, keeping the mailbox and message id", () => {
    // The digest is an unsalted hash of a sorted address set, so it is an
    // offline-CONFIRMABLE fingerprint: for a two-party mail inside a known
    // directory, "did these two correspond on this message" is a few thousand
    // hashes. This module synthesises positional participant labels precisely to
    // keep addresses out of the log sink, and shipping the digest there instead
    // would make that pointless.
    //
    // MUTATION THIS CATCHES: returning the audience id unchanged.
    const redacted = redactAudienceDigest(AUDIENCE_ID);
    expect(redacted).not.toContain(DIGEST);
    expect(redacted).toBe(`email-message:outlook:${MAILBOX}:[digest]:${MESSAGE}`);
    // The mailbox and message id SURVIVE — they are what makes a log line
    // joinable to `resolvePrincipals`'s unresolved sample.
    expect(redacted).toContain(MAILBOX);
    expect(redacted).toContain(MESSAGE);
  });

  it("passes through anything that is not a parseable audience id", () => {
    // A token this module did not mint is logged verbatim rather than mangled:
    // the whole point of logging it is to identify the thing that went wrong.
    for (const opaque of ["", "not-an-audience", "meeting:zoom:abc"]) {
      expect([opaque, redactAudienceDigest(opaque)]).toEqual([opaque, opaque]);
    }
  });

  it("⭐ still blanks a digest when the id no longer PARSES — fail-closed, not open", () => {
    // The unparseable branch used to `return audienceId` untouched, which fails
    // OPEN on the one input most likely to carry a real digest. The reachable
    // case is a FORMAT CHANGE: give the id another segment and
    // `parseEmailMessageAudienceId` finds the wrong thing in the digest slot and
    // returns null — so the branch designed to fire on a format change was
    // exactly the branch where the redaction stopped working, and the whole raw
    // id including a valid digest reached the log sink.
    //
    // `parseEmailMessageAudienceId` argues fail-closed for itself; this now
    // matches it, by blanking digest-SHAPED segments rather than trusting
    // position — with the format unknown, position is what cannot be trusted.
    //
    // MUTATION THIS CATCHES: restoring `if (parts === null) return audienceId`.
    const futureFormat = `email-message:outlook:${MAILBOX}:thread-77:${DIGEST}:${MESSAGE}`;
    expect(redactAudienceDigest(futureFormat)).not.toContain(DIGEST);
    // Everything else survives — the point is still to identify what went wrong.
    expect(redactAudienceDigest(futureFormat)).toContain(MAILBOX);
    expect(redactAudienceDigest(futureFormat)).toContain("thread-77");
    // And a genuinely opaque token is still not mangled (asserted above), so the
    // blanking is scoped to segments that actually look like a digest.
    expect(redactAudienceDigest("not-an-audience")).toBe("not-an-audience");
  });
});

describe("reconcileEmailAudience", () => {
  it("reconciles to the resolved set, stamped with this source", async () => {
    const { deps: d, reconciled } = deps();
    const result = await reconcileEmailAudience(
      { workspaceId: "ws", audienceId: AUDIENCE_ID, participants: messageParticipants(message()) },
      d,
    );
    expect(result).toEqual({ added: 3, revoked: 0, unresolved: 0 });
    expect(reconciled[0].userIds).toHaveLength(3);
  });

  it("reconciles a set that resolves to NOBODY to empty — the flag side", async () => {
    // A mail to five external customers has a well-established audience that
    // currently contains no Atlas users. Skipping the reconcile to "protect" the
    // rows would preserve exactly the stale access `fact_audience_member` exists
    // to drop, and it repairs itself the moment one of them gets an account.
    const { deps: d, reconciled } = deps({
      resolve: async () => ({ resolved: new Map(), unresolvedCount: 3 }),
    });
    const result = await reconcileEmailAudience(
      { workspaceId: "ws", audienceId: "email-message:outlook:mb:msg", participants: messageParticipants(message()) },
      d,
    );
    expect(result).toEqual({ added: 0, revoked: 0, unresolved: 3 });
    // The reconcile still RAN — that is the whole point.
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0].userIds).toEqual([]);
  });

  it("THROWS on a resolution fault instead of reconciling to empty", async () => {
    // Swallowing would hand the reconcile an empty set — indistinguishable from
    // "everyone was removed" — and revoke the whole audience during an incident.
    //
    // MUTATION THIS CATCHES: a try/catch around `resolve` returning an empty
    // resolution.
    const { deps: d, reconciled } = deps({
      resolve: async () => {
        throw new Error("db down");
      },
    });
    await expect(
      reconcileEmailAudience(
        { workspaceId: "ws", audienceId: "email-message:outlook:mb:msg", participants: messageParticipants(message()) },
        d,
      ),
    ).rejects.toThrow("db down");
    expect(reconciled).toHaveLength(0);
  });
});

describe("the re-verify scan", () => {
  it("scans with the NAMESPACE prefix and this source's own kind", async () => {
    // The three things that stayed source-specific when #4971 moved the ordering
    // into `audience/reverify.ts`. `email-message:` rather than
    // `email-message:outlook:`, deliberately: the scan is coarser than the parser
    // so another vendor's token comes back and gets LOGGED by the parse check
    // rather than silently skipped.
    //
    // MUTATION THIS CATCHES: narrowing the prefix to the vendor, or passing
    // another source's kind (which would scan the wrong episodes entirely).
    let scanParams: unknown[] | undefined;
    const { deps: d } = deps({
      query: scanQuery([{ token: TOKEN, has_members: true }], (params) => {
        scanParams = params;
      }),
    });
    await reverifyOutlookMessageAudiences(d);
    expect(scanParams?.slice(0, 3)).toEqual(["ws", "outlook", "audience:email-message:"]);
    expect(scanParams?.[4]).toBe(MAX_REVERIFY_AUDIENCES_PER_WORKSPACE);
  });

  it("skips a token that is not this source's rather than reconciling it", async () => {
    // The scan's prefix is coarser than the parser. A token naming another
    // vendor's message is not this re-verifier's to touch — reconciling it would
    // resolve the wrong roster against the wrong audience.
    const { deps: d, reconciled } = deps({
      query: scanQuery([
        { token: `audience:email-message:gmail:mb:${DIGEST}:msg`, has_members: false },
        { token: "audience:email-message:malformed", has_members: false },
        // A token whose digest slot does not hold a digest was not minted by
        // `emailMessageAudienceId`. The parser refuses it, so the re-verifier
        // skips it rather than reporting the inevitable mismatch as tampering.
        { token: `audience:email-message:outlook:${MAILBOX}:nope:${MESSAGE}`, has_members: false },
      ]),
    });
    const result = await reverifyOutlookMessageAudiences(d);
    expect(reconciled).toHaveLength(0);
    // Not counted as failures — nothing failed.
    expect(result.failed).toBe(0);
    expect(result.reconciled).toBe(0);
  });

  it("⭐ ABORTS on a message Graph no longer returns — never reconciles it to empty", async () => {
    // An email's headers are immutable, so "no participants now" is never a
    // legitimate transition for an audience that was minted from some. A message
    // that is gone (deleted, or its mailbox's access revoked) is an UNREADABLE
    // header set, and reconciling it would revoke everyone — which from `/admin`
    // is indistinguishable from correct fail-closed behaviour.
    //
    // MUTATION THIS CATCHES: treating `message: null` as a message with no
    // recipients and falling through to the reconcile.
    const { deps: d, reconciled } = deps({
      query: scanQuery([{ token: TOKEN, has_members: true }]),
      fetchMessage: async () => ({ ok: true, messages: [] }),
    });
    const result = await reverifyOutlookMessageAudiences(d);
    expect(reconciled).toHaveLength(0);
    // Counted as failed, so `failed > 0` makes the cycle report `degraded`
    // rather than looking clean.
    expect(result.failed).toBe(1);
  });

  it("ABORTS on incomplete headers and on a complete-but-empty participant set", async () => {
    for (const bad of [
      message({ headersComplete: false }),
      message({ from: address(null), toRecipients: [], ccRecipients: [] }),
    ]) {
      const { deps: d, reconciled } = deps({
        query: scanQuery([{ token: TOKEN, has_members: true }]),
        fetchMessage: async () => ({ ok: true, messages: [bad] }),
      });
      const result = await reverifyOutlookMessageAudiences(d);
      expect(reconciled).toHaveLength(0);
      expect(result.failed).toBe(1);
    }
  });

  it("⭐ ABORTS when the re-read message's participants do not match the token's digest", async () => {
    // The audience id NAMES the participant set it was minted from, so a message
    // that now describes a different one is not this audience's message. An
    // email's headers are immutable, so the realistic causes are a DIFFERENT
    // message claiming the same Message-ID (a forged header — the id is chosen by
    // the sending system and leaks in every reply's `References:`) or vendor
    // drift. Either way, reconciling would hand the deletes-everyone-outside-this
    // set a roster this audience was never named for.
    //
    // MUTATION THIS CATCHES: dropping the digest comparison in `reverifyWorkspace`.
    const { deps: d, reconciled } = deps({
      query: scanQuery([{ token: TOKEN, has_members: true }]),
      fetchMessage: async () => ({
        ok: true,
        messages: [message({
          from: address("attacker@evil.test"),
          toRecipients: [address("victim@contoso.com")],
          ccRecipients: [],
        })],
      }),
    });
    const result = await reverifyOutlookMessageAudiences(d);
    expect(reconciled).toHaveLength(0);
    expect(result.failed).toBe(1);
  });

  it("⭐ RESOLVES a benign same-mailbox duplicate rather than refusing it", async () => {
    // `/users/{id}/messages` is the MAILBOX-WIDE collection, spanning every
    // folder — so a user who CCs themselves, or a shared mailbox that mails a
    // distribution list it belongs to, has one copy in Sent Items and one in the
    // Inbox with the SAME Message-ID. That is ordinary mail, not an attack.
    //
    // An earlier cut refused every multi-match outright, which turned that
    // routine habit into an audience failing EVERY cycle — and #4971's
    // starvation then spreads one such failure across the whole workspace. The
    // discriminator is the digest: both copies carry identical From/To/Cc, so
    // both match, and the reconcile proceeds.
    //
    // MUTATION THIS CATCHES: refusing when `lookup.messages.length > 1`.
    const { deps: d, reconciled } = deps({
      query: scanQuery([{ token: TOKEN, has_members: true }]),
      fetchMessage: async () => ({ ok: true, messages: [message(), message()] }),
    });
    const result = await reverifyOutlookMessageAudiences(d);
    expect(reconciled).toHaveLength(1);
    expect(result.reconciled).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("⭐ picks the MATCHING copy when a forged one sits beside the real message", async () => {
    // The forgery and the benign duplicate arrive in the same shape, so the
    // guard has to tell them apart rather than refuse both. The real copy is
    // selected by digest; the forged one is simply not a candidate, so it can
    // neither rewrite membership nor deny service to the real message.
    const forged = message({
      from: address("attacker@evil.test"),
      toRecipients: [address("victim@contoso.com")],
      ccRecipients: [],
    });
    const { deps: d, reconciled } = deps({
      query: scanQuery([{ token: TOKEN, has_members: true }]),
      fetchMessage: async () => ({ ok: true, messages: [forged, message()] }),
    });
    const result = await reverifyOutlookMessageAudiences(d);
    expect(result.reconciled).toBe(1);
    // Reconciled against the REAL participant set — three principals, not the
    // forged pair. Asserting the count is what distinguishes "picked one" from
    // "picked the right one".
    expect(reconciled[0].userIds).toHaveLength(3);
  });

  it("ABORTS on a vendor read failure, leaving the previous membership standing", async () => {
    const { deps: d, reconciled } = deps({
      query: scanQuery([{ token: TOKEN, has_members: true }]),
      fetchMessage: async () => ({ ok: false, error: "mailbox_denied", retryAfterSeconds: null }),
    });
    const result = await reverifyOutlookMessageAudiences(d);
    expect(reconciled).toHaveLength(0);
    expect(result.failed).toBe(1);
  });

  it("reconciles a healthy audience and reports what changed", async () => {
    const { deps: d, reconciled } = deps({
      query: scanQuery([{ token: TOKEN, has_members: true }]),
    });
    const result = await reverifyOutlookMessageAudiences(d);
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0].audienceId).toBe(AUDIENCE_ID);
    expect(result.reconciled).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.membersAdded).toBe(3);
  });

  it("NEVER throws past its own isolation, and never silently no-ops", async () => {
    // It is drained by `runRegisteredAudienceReverifiers`; a throw there costs
    // the other sources their pass.
    const { deps: d } = deps({
      query: async () => {
        throw new Error("scan exploded");
      },
    });
    const result = await reverifyOutlookMessageAudiences(d);
    expect(result.failed).toBe(1);

    // A missing token resolver is LOUD (failed: 1), not a quiet zero. A
    // re-verifier that quietly does nothing lets every audience age past the
    // staleness bound while the cycle reports success — the exact failure the
    // module exists to prevent.
    //
    // MUTATION THIS CATCHES: returning ZERO_REVERIFY instead of {failed: 1}.
    const noResolver = await reverifyOutlookMessageAudiences({ query: async () => [] });
    expect(noResolver.failed).toBe(1);
  });

  it("respects the workspace enable gate and the per-cycle cap", async () => {
    const { deps: d, reconciled } = deps({
      isEnabled: () => false,
      query: scanQuery([{ token: TOKEN, has_members: true }]),
    });
    const disabled = await reverifyOutlookMessageAudiences(d);
    expect(reconciled).toHaveLength(0);
    // A skip, not a failure — the operator asked for this. It is LOGGED rather
    // than silent (ingest keeps minting audiences regardless of the flag, so they
    // age past the staleness bound and stop granting), but a deliberate setting
    // must not make the cycle report `degraded`.
    expect(disabled.failed).toBe(0);

    // The cap is passed as the scan's LIMIT rather than applied in JS, or the
    // query would return every audience in the workspace before bounding.
    let limitParam: unknown;
    const { deps: capped } = deps({
      query: scanQuery([], (params) => {
        limitParam = params?.[4];
      }),
    });
    await reverifyOutlookMessageAudiences(capped);
    expect(limitParam).toBe(MAX_REVERIFY_AUDIENCES_PER_WORKSPACE);
  });
});

describe("rotation — this source inherits the shared attempt stamp (#4971)", () => {
  // The ORDER BY is executed against a real schema in
  // `audience/__tests__/audience-sync-pg.test.ts`, and the scan/stamp coupling is
  // pinned in `audience/__tests__/reverify-scan.test.ts`. What is source-specific
  // — and what this connector could regress on its own — is whether Outlook's own
  // abort paths still go through that seam. They matter more here than anywhere:
  // a mailbox whose Graph access is revoked fails EVERY audience minted from it,
  // all at once, so before rotation one Exchange admin action could park the
  // whole workspace's re-verification on a set that can never succeed.

  /** One pass over `audiences`, returning the ids it stamped as attempted. */
  async function stampedIds(
    audiences: readonly { token: string; has_members: boolean }[],
    overrides: Partial<OutlookAudienceDeps> = {},
  ): Promise<readonly string[]> {
    let stamped: readonly string[] = [];
    const { deps: d } = deps({
      query: scanQuery(audiences, undefined, (params) => {
        stamped = (params?.[1] as string[] | undefined) ?? [];
      }),
      ...overrides,
    });
    await reverifyOutlookMessageAudiences(d);
    return stamped;
  }

  it("stamps an attempt for a message whose Graph read FAILS every cycle", async () => {
    // The revoked-mailbox case. Before #4971 this audience advanced no column the
    // scan ordered on, so it held a slot at the front forever and everything
    // behind it aged past the staleness bound with `acl.ts` suppressing it — the
    // outage being fail-CLOSED does not make it less of an outage.
    //
    // MUTATION THIS CATCHES: reverting `reverifyWorkspace` to its own scan SQL,
    // or moving the stamp into the success branch.
    expect(
      await stampedIds([{ token: TOKEN, has_members: true }], {
        fetchMessage: async () => ({ ok: false, error: "forbidden", retryAfterSeconds: null }),
      }),
    ).toEqual([AUDIENCE_ID]);
  });

  it("stamps an attempt for a message Graph no longer returns", async () => {
    // The deleted-or-moved case, which aborts rather than reconciling to empty
    // because an email's headers are immutable. It aborts on every cycle for as
    // long as the message stays gone, which is forever.
    expect(
      await stampedIds([{ token: TOKEN, has_members: true }], {
        fetchMessage: async () => ({ ok: true, messages: [] }),
      }),
    ).toEqual([AUDIENCE_ID]);
  });

  it("stamps an attempt for the digest-MISMATCH refusal", async () => {
    // The refusal that protects membership from a forged Message-ID. It is also
    // permanent by construction — the stored token names a participant set the
    // mailbox no longer holds — so leaving it unstamped would let one forged
    // header park a slot for good.
    //
    // MUTATION THIS CATCHES: stamping only the audiences that reach the reconcile.
    expect(
      await stampedIds([{ token: TOKEN, has_members: true }], {
        fetchMessage: async () => ({
          ok: true,
          messages: [message({ toRecipients: [address("someone-else@contoso.com")] })],
        }),
      }),
    ).toEqual([AUDIENCE_ID]);
  });

  it("stamps an attempt for a token that does not parse as this source's", async () => {
    // A token nothing can ever reconcile is the worst possible thing to leave
    // unstamped: it would sit on a NULL attempt time forever and pin the front of
    // every future scan — #4971's starvation rebuilt out of its one irreparable
    // case.
    //
    // MUTATION THIS CATCHES: stamping inside the loop, after the parse check.
    expect(
      await stampedIds([{ token: "audience:email-message:malformed", has_members: false }]),
    ).toEqual(["email-message:malformed"]);
  });

  it("counts a FAILED scan or stamp as a workspace failure, doing no vendor work", async () => {
    // The other half of `selectReverifyCandidates`'s contract: it throws, and
    // the caller counts. Only the throw was covered — this pins the catch.
    //
    // Untested, a `catch { return ZERO_REVERIFY }` around the call restores
    // #4971's exact signature: a source that re-verifies nothing while the cycle
    // reports `success`, because "scan failed" and "nothing to do" are the same
    // empty result.
    //
    // MUTATION THIS CATCHES: swallowing the throw, or dropping the `failed + 1`
    // in the per-workspace catch.
    for (const failing of [REVERIFY_CANDIDATES_SQL, TOUCH_REVERIFY_ATTEMPT_SQL]) {
      let vendorCalls = 0;
      const query: QueryFn = async <T extends Record<string, unknown>>(
        sql: string,
      ): Promise<T[]> => {
        if (sql.includes("workspace_plugins")) {
          return [
            {
              workspace_id: "ws",
              install_id: "i",
              config: { tenantId: "t", mailboxes: ["a@b.com"] },
            },
          ] as unknown as T[];
        }
        if (sql === failing) throw new Error("relation does not exist");
        return [{ token: TOKEN, has_members: true }] as unknown as T[];
      };
      const { deps: d, reconciled } = deps({
        query,
        fetchMessage: async () => {
          vendorCalls++;
          return { ok: true, messages: [message()] };
        },
      });
      const out = await reverifyOutlookMessageAudiences(d);
      expect([out.failed, out.reconciled]).toEqual([1, 0]);
      // A page that could not be stamped must not be WORKED — working it without
      // rotating is the starvation this whole change removes.
      expect(vendorCalls).toBe(0);
      expect(reconciled).toHaveLength(0);
    }
  });
});
