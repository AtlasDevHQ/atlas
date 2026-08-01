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
  OUTLOOK_MESSAGE_AUDIENCES_SQL,
  messageParticipants,
  reconcileEmailAudience,
  reverifyOutlookMessageAudiences,
  type OutlookAudienceDeps,
} from "@atlas/api/lib/brain/ingest/outlook/audience";
import type { OutlookMessage } from "@atlas/api/lib/brain/ingest/outlook/api";

const MAILBOX = "8f14e45f";
const MESSAGE = "a@contoso.com";
const TOKEN = `audience:email-message:outlook:${MAILBOX}:${MESSAGE}`;

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
 * A typed stand-in for `internalQuery` that answers the install scan and the
 * audience scan from canned rows.
 *
 * One helper rather than an inline closure per test, because `query` is GENERIC
 * (`<T extends Record<string, unknown>>`) and an inline `async (sql: string)`
 * does not satisfy it — bun runs tests untypechecked, so those stubs were green
 * here and red only in the type gate.
 */
function scanQuery(
  audiences: readonly { token: string; synced_at: string | null; has_members: boolean }[],
  onAudienceScan?: (params?: unknown[]) => void,
): QueryFn {
  return (async (sql: string, params?: unknown[]) => {
    if (sql.includes("workspace_plugins")) {
      return [
        { workspace_id: "ws", install_id: "i", config: { tenantId: "t", mailboxes: ["a@b.com"] } },
      ];
    }
    onAudienceScan?.(params);
    return audiences;
  }) as QueryFn;
}

/** A deps bundle whose every vendor/DB call is recorded, none real. */
function deps(overrides: Partial<OutlookAudienceDeps> = {}) {
  const reconciled: { audienceId: string; userIds: readonly string[] }[] = [];
  const base: OutlookAudienceDeps = {
    query: async () => [],
    isEnabled: () => true,
    resolveToken: async () => "tok",
    fetchMessage: async () => ({ ok: true, message: message() }),
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
    // one is synthesised. Positional rather than hashed because it stays
    // actionable: the log line carries the audience id, which names the mailbox
    // and the Message-ID, so an operator can open the message and see who `cc:0`
    // is.
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

describe("reconcileEmailAudience", () => {
  it("reconciles to the resolved set, stamped with this source", async () => {
    const { deps: d, reconciled } = deps();
    const result = await reconcileEmailAudience(
      { workspaceId: "ws", audienceId: `email-message:outlook:${MAILBOX}:${MESSAGE}`, participants: messageParticipants(message()) },
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
  it("orders member-BEARING audiences first, then stalest — two keys, not one", () => {
    // A naive `MIN(synced_at) ASC NULLS FIRST` alone STARVES the audiences that
    // matter: an audience resolving to no Atlas users never gets a
    // `fact_audience_member` row, so its `MIN(synced_at)` is NULL forever and it
    // sorts first on every cycle. Past the cap the scan returns the identical
    // rows every time and no member-bearing audience is re-verified again.
    //
    // MUTATION THIS CATCHES: dropping the `has_members DESC` key.
    expect(OUTLOOK_MESSAGE_AUDIENCES_SQL).toContain(
      "ORDER BY (count(m.user_id) > 0) DESC, MIN(m.synced_at) ASC NULLS FIRST",
    );
    // Sourced from `visible_to`, not from `fact_audience_member`: membership is
    // the thing being repaired, so an audience with no members has no row there
    // and would be invisible to a scan of it — and it is exactly the audience
    // the "someone joined Atlas later" repair exists for.
    expect(OUTLOOK_MESSAGE_AUDIENCES_SQL).toContain("unnest(e.visible_to)");
    expect(OUTLOOK_MESSAGE_AUDIENCES_SQL).toContain("LEFT JOIN fact_audience_member");
  });

  it("skips a token that is not this source's rather than reconciling it", async () => {
    // The scan's `LIKE` is coarser than the parser. A token naming another
    // vendor's message is not this re-verifier's to touch — reconciling it would
    // resolve the wrong roster against the wrong audience.
    const { deps: d, reconciled } = deps({
      query: scanQuery([{ token: "audience:email-message:gmail:mb:msg", synced_at: null, has_members: false },
              { token: "audience:email-message:malformed", synced_at: null, has_members: false }]),
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
      query: scanQuery([{ token: TOKEN, synced_at: null, has_members: true }]),
      fetchMessage: async () => ({ ok: true, message: null }),
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
        query: scanQuery([{ token: TOKEN, synced_at: null, has_members: true }]),
        fetchMessage: async () => ({ ok: true, message: bad }),
      });
      const result = await reverifyOutlookMessageAudiences(d);
      expect(reconciled).toHaveLength(0);
      expect(result.failed).toBe(1);
    }
  });

  it("ABORTS on a vendor read failure, leaving the previous membership standing", async () => {
    const { deps: d, reconciled } = deps({
      query: scanQuery([{ token: TOKEN, synced_at: null, has_members: true }]),
      fetchMessage: async () => ({ ok: false, error: "mailbox_denied", retryAfterSeconds: null }),
    });
    const result = await reverifyOutlookMessageAudiences(d);
    expect(reconciled).toHaveLength(0);
    expect(result.failed).toBe(1);
  });

  it("reconciles a healthy audience and reports what changed", async () => {
    const { deps: d, reconciled } = deps({
      query: scanQuery([{ token: TOKEN, synced_at: null, has_members: true }]),
    });
    const result = await reverifyOutlookMessageAudiences(d);
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0].audienceId).toBe(`email-message:outlook:${MAILBOX}:${MESSAGE}`);
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
      query: scanQuery([{ token: TOKEN, synced_at: null, has_members: true }]),
    });
    await reverifyOutlookMessageAudiences(d);
    expect(reconciled).toHaveLength(0);

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
