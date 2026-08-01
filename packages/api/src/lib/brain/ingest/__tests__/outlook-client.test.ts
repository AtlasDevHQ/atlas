/**
 * The Outlook mail walk (#4966).
 *
 * Most of this file is about ONE distinction, because getting it wrong has
 * already cost this milestone an outage once: among the things that stop a
 * message being ingested, some are RETRYABLE (block — freeze the resume point)
 * and some are PERMANENT (skip — advance past it). #4965 routed a permanent
 * size condition down the retry arm, which froze the cursor every pass until it
 * fell below the backfill floor and wedged the source outright.
 *
 * Each test names the mutation it catches, because several of these guards are
 * invisible in production: a frozen cursor and a silent skip both report a
 * perfectly green sync.
 */

import { describe, expect, it } from "bun:test";
import { ConnectorRateLimitError } from "@atlas/api/lib/knowledge/connectors";
import {
  composeEmailBody,
  createOutlookMailClient,
  parseOutlookCursor,
  serialiseOutlookCursor,
  type OutlookMailClientOptions,
} from "@atlas/api/lib/brain/ingest/outlook/client";
import type { OutlookMessage } from "@atlas/api/lib/brain/ingest/outlook/api";
import { emailParticipantsDigest } from "@atlas/api/lib/brain/ingest/grant";

const NOW = new Date("2026-07-15T12:00:00.000Z");
const MAILBOX_ID = "8f14e45f";

function address(addr: string | null) {
  return { address: addr, name: null };
}

function message(overrides: Partial<OutlookMessage> = {}): OutlookMessage {
  return {
    graphId: "AAMkAGx",
    internetMessageId: "<a@contoso.com>",
    subject: "Q3 pricing",
    receivedDateTime: "2026-07-01T10:00:00Z",
    from: address("sender@contoso.com"),
    toRecipients: [address("to@contoso.com")],
    ccRecipients: [],
    headersComplete: true,
    bodyUnreadable: false,
    bodyText: "the number is 42",
    ...overrides,
  };
}

interface Harness {
  readonly reconciled: string[];
  readonly episodesAtReconcile: number[];
}

/** Build a client over canned pages, recording every membership write. */
function client(
  pages: { messages: OutlookMessage[]; nextLink?: string | null; dropped?: number }[],
  options: Partial<OutlookMailClientOptions> & { readonly harness?: Harness } = {},
) {
  const harness: Harness = options.harness ?? { reconciled: [], episodesAtReconcile: [] };
  let pageIndex = 0;
  const readPage = async () => {
    const page = pages[Math.min(pageIndex++, pages.length - 1)];
    return {
      ok: true as const,
      messages: page.messages,
      nextLink: page.nextLink ?? null,
      dropped: page.dropped ?? 0,
    };
  };
  return {
    harness,
    vendor: createOutlookMailClient({
      workspaceId: "ws",
      resolveToken: async () => "tok",
      mailboxes: ["a@contoso.com"],
      backfillWindowMs: 30 * 86_400_000,
      now: () => NOW,
      api: {
        fetchMailbox: async () => ({
          ok: true as const,
          mailbox: { id: MAILBOX_ID, userPrincipalName: "a@contoso.com", mail: "a@contoso.com" },
        }),
        fetchMailboxMessagesPage: readPage,
        fetchMailboxMessagesNextPage: readPage,
      },
      audienceDeps: {
        resolve: async (_ws, principals) => ({
          resolved: new Map(principals.map((p) => [p.id, `user-${p.id}`])),
          unresolvedCount: 0,
        }),
        reconcile: async (input) => {
          harness.reconciled.push(input.audienceId);
          return { added: input.userIds.length, revoked: 0 };
        },
      },
      ...options,
    } as OutlookMailClientOptions),
  };
}

const PARAMS = { mode: "incremental" as const, since: null, cursor: null, maxEpisodes: 100 };

describe("the happy path", () => {
  it("produces one episode keyed on the Message-ID, granted to a message audience", async () => {
    const { vendor, harness } = client([{ messages: [message()] }]);
    const changes = await vendor.fetchEpisodes(PARAMS);
    expect(changes.episodes).toHaveLength(1);
    const episode = changes.episodes[0];
    // The stored key is the bare Message-ID — see `outlook-config.test.ts` for
    // why that and not Graph's own per-mailbox id.
    expect(episode.sourceId).toBe("a@contoso.com");
    const digest = emailParticipantsDigest(["sender@contoso.com", "to@contoso.com"]);
    expect(episode.visibleTo).toEqual([
      `audience:email-message:outlook:${MAILBOX_ID}:${digest}:a@contoso.com`,
    ]);
    // ⭐ Membership is written under EXACTLY the token the episode carries. An
    // off-by-one in the `slice(AUDIENCE_PREFIX.length)` would write it under an
    // id no episode names: every email fact stored, gated, invisible to
    // everyone, sync green — and self-healing a cycle later when the re-verifier
    // repairs it from `visible_to`, which makes the window silent AND hard to
    // diagnose after the fact.
    expect(harness.reconciled).toEqual([episode.visibleTo[0].slice("audience:".length)]);
    // The SENDER, not a recipient: `sourceActor` is the principal who authored
    // the evidence, which a mail header states unambiguously.
    expect(episode.sourceActor).toBe("sender@contoso.com");
    expect(episode.occurredAt?.toISOString()).toBe("2026-07-01T10:00:00.000Z");
    expect(changes.coverageIncomplete).toBeFalsy();
  });

  it("stores the headers as part of the evidence — but never a Bcc line", async () => {
    // "Who said this, to whom, when" is the question every fact extracted from a
    // mail depends on. A Bcc line would disclose, to everyone in the audience,
    // the one fact BCC exists to hide — while the grant continued not to include
    // that person.
    const body = composeEmailBody(
      message({ ccRecipients: [address("cc@contoso.com")] }),
    );
    expect(body).toContain("Subject: Q3 pricing");
    expect(body).toContain("From: sender@contoso.com");
    expect(body).toContain("To: to@contoso.com");
    expect(body).toContain("Cc: cc@contoso.com");
    expect(body).toContain("the number is 42");
    expect(body).not.toMatch(/^Bcc:/im);
  });
});

describe("the block arm — RETRYABLE, freezes the resume point", () => {
  it("⭐ blocks incomplete headers and does NOT advance the cursor past them", async () => {
    // Deriving from a partial header set does not merely under-grant: the same
    // set is what `reconcileAudienceMembership` deletes against, so it would
    // REVOKE the people the missing field named.
    //
    // MUTATION THIS CATCHES: returning `blocked: false`, which lets the resume
    // point advance past the message so no later cycle ever looks at it again —
    // a permanent silent skip on the SAFETY arm.
    const { vendor, harness } = client([
      { messages: [message({ headersComplete: false, receivedDateTime: "2026-07-02T10:00:00Z" })] },
    ]);
    const changes = await vendor.fetchEpisodes(PARAMS);
    expect(changes.episodes).toHaveLength(0);
    expect(changes.coverageIncomplete).toBe(true);
    // No membership was written either — an audience Atlas could not establish
    // must not get rows.
    expect(harness.reconciled).toHaveLength(0);
    // The cursor did not move to the pass instant. It holds the pre-message
    // watermark, so the next cycle re-reads this message.
    const marks = parseOutlookCursor(changes.cursor ?? null);
    expect(marks[MAILBOX_ID]).not.toBe(NOW.toISOString());
    // …and the high-water mark is null, because coverage was incomplete.
    expect(changes.highWaterMark).toBeNull();
    // The operator is told, by message, what was refused.
    expect(changes.warnings?.join(" ")).toMatch(/NOT ingested/);
  });

  it("⭐ blocks the episode when the membership WRITE fails", async () => {
    // The real, testable content of "membership before episodes". The ordering
    // itself is not observable from outside `runMessage` — the caller pushes the
    // episode either way — but its CONSEQUENCE is: an audience Atlas could not
    // write must not get an episode that references it, because that episode's
    // facts would be invisible to everyone until the re-verifier came round.
    //
    // MUTATION THIS CATCHES: wrapping the `reconcileEmailAudience` call in a
    // try/catch that continues, or moving it after the episode is returned so a
    // failure no longer stops it.
    const { vendor } = client([{ messages: [message()] }], {
      audienceDeps: {
        resolve: async (_ws, principals) => ({
          resolved: new Map(principals.map((p) => [p.id, `user-${p.id}`])),
          unresolvedCount: 0,
        }),
        reconcile: async () => {
          throw new Error("membership write failed");
        },
      },
    });
    const changes = await vendor.fetchEpisodes(PARAMS);
    expect(changes.episodes).toHaveLength(0);
    // …and the range stays uncovered, so the next cycle retries it.
    expect(changes.coverageIncomplete).toBe(true);
    expect(changes.highWaterMark).toBeNull();
  });



  it("never falls back to a wider grant on the block arm", async () => {
    // There is no `[org]` answer available anywhere in this path — it would
    // publish somebody's mail to the whole company, and no downstream review
    // gate catches it because the reviewer is shown the grant Atlas derived.
    const { vendor } = client([{ messages: [message({ headersComplete: false })] }]);
    const changes = await vendor.fetchEpisodes(PARAMS);
    expect(JSON.stringify(changes.episodes)).not.toContain("org");
  });
});

describe("the skip arm — PERMANENT, advances past", () => {
  it("⭐ skips a message with no Message-ID and still advances the resume point", async () => {
    // A header a message does not have, it never grows. Routing this down the
    // block arm freezes the cursor forever — the failure #4965 shipped.
    //
    // MUTATION THIS CATCHES: returning `blocked: true` for an unidentifiable
    // message. The episode count is unchanged either way, so only the cursor
    // and the coverage flag can tell the two apart.
    const { vendor } = client([
      { messages: [message({ internetMessageId: null, receivedDateTime: "2026-07-02T10:00:00Z" })] },
    ]);
    const changes = await vendor.fetchEpisodes(PARAMS);
    expect(changes.episodes).toHaveLength(0);
    expect(changes.coverageIncomplete).toBeFalsy();
    // The mailbox was walked to the end, so the resume point is the pass
    // instant — the walk is not stuck on this message.
    expect(parseOutlookCursor(changes.cursor ?? null)[MAILBOX_ID]).toBe(NOW.toISOString());
    expect(changes.warnings?.join(" ")).toMatch(/no RFC 5322 Message-ID/);
  });

  it("NEVER falls back to Graph's per-mailbox id for an unidentifiable message", async () => {
    // The fallback is the obvious "fix" and it re-introduces one-episode-per
    // -recipient duplication for exactly the messages whose identity is already
    // doubtful.
    const { vendor } = client([
      { messages: [message({ internetMessageId: null, graphId: "AAMkAGxFALLBACK" })] },
    ]);
    const changes = await vendor.fetchEpisodes(PARAMS);
    expect(JSON.stringify(changes.episodes)).not.toContain("AAMkAGxFALLBACK");
  });

  it("skips an oversize body rather than truncating it, and advances", async () => {
    // Truncating evidence is the one thing an evidence store must not do
    // quietly: half a message reads as a whole message to every downstream
    // consumer, and the extractor produces confident facts from a mail whose
    // ending it never saw.
    const { vendor } = client([
      { messages: [message({ bodyText: "x".repeat(2 * 1024 * 1024) })] },
    ]);
    const changes = await vendor.fetchEpisodes(PARAMS);
    expect(changes.episodes).toHaveLength(0);
    expect(changes.coverageIncomplete).toBeFalsy();
    expect(changes.warnings?.join(" ")).toMatch(/skipped rather than truncated/);
  });

  it("measures the body in BYTES, not UTF-16 units", async () => {
    // The guard's own comment says `String.length` "would pass at up to ~3× the
    // stated bound" — and an ASCII fixture cannot show that, because for ASCII
    // the two are identical. 400k CJK characters are 400k UTF-16 units (well
    // under the 1MB cap by that measure) and 1.2MB of UTF-8.
    //
    // MUTATION THIS CATCHES: `body.length > MAX_EMAIL_BODY_BYTES`.
    const { vendor } = client([{ messages: [message({ bodyText: "あ".repeat(400_000) })] }]);
    const changes = await vendor.fetchEpisodes(PARAMS);
    expect(changes.episodes).toHaveLength(0);
    expect(changes.warnings?.join(" ")).toMatch(/skipped rather than truncated/);
  });

  it("skips a message over the participant cap, and advances", async () => {
    const many = Array.from({ length: 600 }, (_, i) => address(`u${i}@contoso.com`));
    const { vendor } = client([{ messages: [message({ toRecipients: many })] }]);
    const changes = await vendor.fetchEpisodes(PARAMS);
    expect(changes.episodes).toHaveLength(0);
    expect(changes.coverageIncomplete).toBeFalsy();
    expect(changes.warnings?.join(" ")).toMatch(/participant limit/);
  });

  it("⭐ skips a message whose body Graph returned as HTML — never stores headers-only", async () => {
    // Found by this test, not by review. The parser refuses a non-text body (a
    // stored HTML blob would put markup into an evidence body that every reader
    // treats as what somebody wrote) — and the client then composed the header
    // block and stored THAT, producing an episode that reads as a complete
    // message while the thing somebody actually wrote is missing. The extractor
    // would draw confident facts from a mail it never saw the contents of.
    //
    // MUTATION THIS CATCHES: collapsing `bodyUnreadable` back into
    // `bodyText === null`. The subject-only case below is what stops the naive
    // repair — refusing every empty body — from being right either.
    const { vendor } = client([
      { messages: [message({ bodyText: null, bodyUnreadable: true })] },
    ]);
    const changes = await vendor.fetchEpisodes(PARAMS);
    expect(changes.episodes).toHaveLength(0);
    // PERMANENT, so the walk advances: `contentType` is a property of the stored
    // message and retrying reads the same answer forever.
    expect(changes.coverageIncomplete).toBeFalsy();
    expect(changes.warnings?.join(" ")).toMatch(/as HTML rather than the plain text/);
  });

  it("STORES a subject-only message — no body is not the same as a refused body", async () => {
    // The distinction the branch above turns on. A mail with a subject and no
    // body ("approved — EOM") is COMPLETE evidence and must not be dropped; it
    // is only the REFUSED body that would fabricate completeness.
    const { vendor } = client([
      { messages: [message({ bodyText: null, bodyUnreadable: false })] },
    ]);
    const changes = await vendor.fetchEpisodes(PARAMS);
    expect(changes.episodes).toHaveLength(1);
    expect(changes.episodes[0].body).toContain("Subject: Q3 pricing");
  });

  it("⭐ REFUSES a message that names nobody, and still advances past it", async () => {
    // Nothing is ingested and nothing is granted — but the headers of a stored
    // message are IMMUTABLE, so this condition is permanent and the walk must
    // not wait for it. Sitting under the skip arm rather than the block arm is
    // the whole point: routing it to `blocked: true` freezes the resume point at
    // the sliding floor and that mailbox never gets past this one message.
    //
    // MUTATION THIS CATCHES: `blocked: true` on the zero-participant branch.
    // Without the two assertions below it survives — the episode count and the
    // warning text are identical either way.
    const { vendor, harness } = client([
      {
        messages: [
          message({ from: address(null), toRecipients: [], ccRecipients: [] }),
        ],
      },
    ]);
    const changes = await vendor.fetchEpisodes(PARAMS);
    expect(changes.episodes).toHaveLength(0);
    expect(changes.warnings?.join(" ")).toMatch(/no audience to grant it to/);
    // No membership either — an audience Atlas could not establish gets no rows.
    expect(harness.reconciled).toHaveLength(0);
    expect(changes.coverageIncomplete).toBeFalsy();
    expect(parseOutlookCursor(changes.cursor ?? null)[MAILBOX_ID]).toBe(NOW.toISOString());
  });

  it("stores a sender-only message — a header block alone is complete evidence", async () => {
    // No subject, no printable participants, no body — `''` is refused outright
    // by `chk_brain_episodes_body_xor_locator`, so there is nothing to store.
    // Reached only via the block guard's sibling path, so it is asserted through
    // a message that has a sender (to clear the audience guard) and nothing else.
    const { vendor } = client([
      {
        messages: [
          message({ subject: null, bodyText: null, receivedDateTime: null, toRecipients: [] }),
        ],
      },
    ]);
    const changes = await vendor.fetchEpisodes(PARAMS);
    // Named for what it PROVES. The `body === ""` branch it was originally
    // written against is in fact unreachable: a non-zero participant count
    // implies at least one of From/To/Cc is non-empty, which implies a non-empty
    // header block. Kept as a positive assertion rather than deleted, because
    // "a sender-only mail is still evidence" is the claim that stops someone
    // "fixing" the empty-compose guard by refusing every bodyless message.
    expect(changes.episodes).toHaveLength(1);
    expect(changes.episodes[0].body).toBe("From: sender@contoso.com");
  });
});

describe("the cursor", () => {
  it("round-trips, and drops entries a pass was not configured for", async () => {
    // A mailbox removed from the config would otherwise keep its watermark
    // forever, and re-adding it months later would resume from a stale mark and
    // silently skip everything in between — invisible, because an append-only
    // store cannot tell an absence from a not-yet-fetched.
    const stale = serialiseOutlookCursor({
      [MAILBOX_ID]: "2026-07-01T00:00:00.000Z",
      removed: "2026-01-01T00:00:00.000Z",
    });
    expect(parseOutlookCursor(stale)).toEqual({
      [MAILBOX_ID]: "2026-07-01T00:00:00.000Z",
      removed: "2026-01-01T00:00:00.000Z",
    });
    const { vendor } = client([{ messages: [] }]);
    const changes = await vendor.fetchEpisodes({ ...PARAMS, cursor: stale });
    expect(Object.keys(parseOutlookCursor(changes.cursor ?? null))).toEqual([MAILBOX_ID]);
  });

  it("degrades an unreadable cursor to no-mark instead of wedging the source", () => {
    // Throwing would wedge the source permanently on one bad row with no
    // operator-reachable repair; re-crawling from the floor is a deduped no-op.
    for (const bad of ["{", "null", "[]", '{"v":2,"mailboxes":{}}', '{"v":1}']) {
      expect(parseOutlookCursor(bad)).toEqual({});
    }
    // One malformed ENTRY drops only itself — a bad watermark on one mailbox
    // must not re-walk every other mailbox's backfill.
    expect(parseOutlookCursor('{"v":1,"mailboxes":{"a":"2026-01-01T00:00:00Z","b":"nope"}}')).toEqual({
      a: "2026-01-01T00:00:00Z",
    });
  });

  it("⭐ treats a below-floor mark as REPORT-ONLY, never as a reason to freeze", async () => {
    // Gating the cursor on this wedges the connector permanently: the floor
    // advances with the clock, so the mark written by pass N is always older
    // than the floor computed by pass N+1 — the stale branch re-fires forever,
    // the cursor never leaves the floor, and every pass re-walks the whole
    // backfill. #4965 shipped exactly this and its round-2 review caught it.
    //
    // MUTATION THIS CATCHES: setting `walkIncomplete = true` alongside
    // `historyTruncated`. Coverage is reported incomplete either way — that half
    // is right — so only the cursor distinguishes them.
    const ancient = serialiseOutlookCursor({ [MAILBOX_ID]: "2020-01-01T00:00:00.000Z" });
    const { vendor } = client([{ messages: [] }]);
    const changes = await vendor.fetchEpisodes({ ...PARAMS, cursor: ancient });
    expect(changes.coverageIncomplete).toBe(true);
    // The cursor DID advance to the pass instant — the walk covered everything
    // from the floor, so freezing would re-walk that same range every pass.
    expect(parseOutlookCursor(changes.cursor ?? null)[MAILBOX_ID]).toBe(NOW.toISOString());
    expect(changes.warnings?.join(" ")).toMatch(/backfill window/);
  });

  it("resumes at the pass START, not at `now`, when a mailbox completes", async () => {
    // Anything delivered DURING the walk is not guaranteed to have been seen —
    // the `$filter` was evaluated when the pass began. Using pass-start re-reads
    // that sliver next cycle (deduped) instead of jumping over it.
    const { vendor } = client([{ messages: [message()] }]);
    const changes = await vendor.fetchEpisodes(PARAMS);
    expect(parseOutlookCursor(changes.cursor ?? null)[MAILBOX_ID]).toBe(NOW.toISOString());
  });
});

describe("budgets and throttling", () => {
  it("stops at maxEpisodes INSIDE a page and says so", async () => {
    // A bare `break` here was a silent skip in the Zoom connector: on the last
    // page the loops simply ran out, the range was marked covered, and every
    // unread message was gone forever with `coverageIncomplete: false`.
    const messages = Array.from({ length: 5 }, (_, i) =>
      message({ internetMessageId: `<m${i}@contoso.com>`, receivedDateTime: `2026-07-0${i + 1}T10:00:00Z` }),
    );
    const { vendor } = client([{ messages }]);
    const changes = await vendor.fetchEpisodes({ ...PARAMS, maxEpisodes: 2 });
    expect(changes.episodes).toHaveLength(2);
    expect(changes.coverageIncomplete).toBe(true);
    expect(changes.highWaterMark).toBeNull();
    expect(changes.warnings?.join(" ")).toMatch(/record budget/);
    // The resume point is the last message actually processed, so the unread
    // tail is re-read rather than skipped.
    expect(parseOutlookCursor(changes.cursor ?? null)[MAILBOX_ID]).toBe("2026-07-02T10:00:00Z");
  });

  it("truncates on a page with dropped entries rather than marking it covered", async () => {
    const { vendor } = client([{ messages: [message()], dropped: 2 }]);
    const changes = await vendor.fetchEpisodes(PARAMS);
    expect(changes.coverageIncomplete).toBe(true);
    expect(changes.warnings?.join(" ")).toMatch(/unreadable message entr/);
  });

  it("RETHROWS a rate limit only when nothing was banked", async () => {
    // Throwing after banking would discard the episodes already earned, and the
    // same prefix would be re-walked and re-lost every cycle. Only a pass with
    // nothing to bank rethrows, so the ENGINE's backoff owns the retry.
    const throttled = { ok: false as const, error: "ratelimited" as const, retryAfterSeconds: 30 };
    const empty = createOutlookMailClient({
      workspaceId: "ws",
      resolveToken: async () => "tok",
      mailboxes: ["a@contoso.com"],
      backfillWindowMs: 30 * 86_400_000,
      now: () => NOW,
      api: {
        fetchMailbox: async () => ({
          ok: true as const,
          mailbox: { id: MAILBOX_ID, userPrincipalName: null, mail: null },
        }),
        fetchMailboxMessagesPage: async () => throttled,
        fetchMailboxMessagesNextPage: async () => throttled,
      },
      audienceDeps: {},
    });
    await expect(empty.fetchEpisodes(PARAMS)).rejects.toBeInstanceOf(ConnectorRateLimitError);

    // With something banked it RETURNS, reporting incomplete coverage.
    let call = 0;
    const banked = createOutlookMailClient({
      workspaceId: "ws",
      resolveToken: async () => "tok",
      mailboxes: ["a@contoso.com"],
      backfillWindowMs: 30 * 86_400_000,
      now: () => NOW,
      api: {
        fetchMailbox: async () => ({
          ok: true as const,
          mailbox: { id: MAILBOX_ID, userPrincipalName: null, mail: null },
        }),
        fetchMailboxMessagesPage: async () => ({
          ok: true as const,
          messages: [message()],
          nextLink: "https://graph.microsoft.com/next",
          dropped: 0,
        }),
        fetchMailboxMessagesNextPage: async () => {
          call++;
          return throttled;
        },
      },
      audienceDeps: {
        resolve: async (_ws, principals) => ({
          resolved: new Map(principals.map((p) => [p.id, `u-${p.id}`])),
          unresolvedCount: 0,
        }),
        reconcile: async () => ({ added: 1, revoked: 0 }),
      },
    });
    const changes = await banked.fetchEpisodes(PARAMS);
    expect(changes.episodes).toHaveLength(1);
    expect(changes.coverageIncomplete).toBe(true);
    expect(call).toBe(1);
  });

  it("⭐ a mailbox the pass never REACHED keeps the mark it came in with", async () => {
    // THE cursor-loss defect three reviewers found, and it was invisible because
    // every throttle test configured exactly ONE mailbox.
    //
    // `serialiseOutlookCursor` writes a whole-cursor REPLACEMENT and the state
    // upsert only COALESCEs a NULL cursor forward, so a mailbox absent from
    // `nextMarks` has its watermark DELETED — it restarts at the sliding backfill
    // floor, and everything between its old frontier and that floor is never
    // fetched. The "stored mark was older than the window" warning cannot fire
    // either, because by then there is no stored mark.
    //
    // MUTATION THIS CATCHES: deleting the carry-forward loop after the walk.
    const ids: Record<string, string> = { "a@contoso.com": "mb-a", "b@contoso.com": "mb-b" };
    const stored = serialiseOutlookCursor({
      "mb-a": "2026-07-10T00:00:00.000Z",
      "mb-b": "2026-07-11T00:00:00.000Z",
    });
    const vendor = createOutlookMailClient({
      workspaceId: "ws",
      resolveToken: async () => "tok",
      mailboxes: ["a@contoso.com", "b@contoso.com"],
      backfillWindowMs: 30 * 86_400_000,
      now: () => NOW,
      api: {
        fetchMailbox: async (_t, mailbox) => ({
          ok: true as const,
          mailbox: { id: ids[mailbox], userPrincipalName: mailbox, mail: mailbox },
        }),
        // The FIRST mailbox throttles, which stops the whole pass before the
        // second is ever visited.
        fetchMailboxMessagesPage: async () => ({
          ok: false as const,
          error: "ratelimited" as const,
          retryAfterSeconds: 30,
        }),
        fetchMailboxMessagesNextPage: async () => ({
          ok: false as const,
          error: "ratelimited" as const,
          retryAfterSeconds: 30,
        }),
      },
      audienceDeps: {},
    });
    // Nothing banked, so the throttle rethrows and the ENGINE owns the retry —
    // which is correct, and is why the carry-forward has to survive a THROW too.
    await expect(vendor.fetchEpisodes({ ...PARAMS, cursor: stored })).rejects.toBeInstanceOf(
      ConnectorRateLimitError,
    );

    // Now the same shape with something banked, so the pass RETURNS and we can
    // inspect the cursor it wrote.
    let firstCall = true;
    const banking = createOutlookMailClient({
      workspaceId: "ws",
      resolveToken: async () => "tok",
      mailboxes: ["a@contoso.com", "b@contoso.com"],
      backfillWindowMs: 30 * 86_400_000,
      now: () => NOW,
      api: {
        fetchMailbox: async (_t, mailbox) => ({
          ok: true as const,
          mailbox: { id: ids[mailbox], userPrincipalName: mailbox, mail: mailbox },
        }),
        fetchMailboxMessagesPage: async () => {
          if (firstCall) {
            firstCall = false;
            return {
              ok: true as const,
              messages: [message()],
              nextLink: "https://graph.microsoft.com/next",
              dropped: 0,
            };
          }
          return { ok: false as const, error: "ratelimited" as const, retryAfterSeconds: 30 };
        },
        fetchMailboxMessagesNextPage: async () => ({
          ok: false as const,
          error: "ratelimited" as const,
          retryAfterSeconds: 30,
        }),
      },
      audienceDeps: {
        resolve: async (_ws, principals) => ({
          resolved: new Map(principals.map((p) => [p.id, `u-${p.id}`])),
          unresolvedCount: 0,
        }),
        reconcile: async () => ({ added: 1, revoked: 0 }),
      },
    });
    const changes = await banking.fetchEpisodes({ ...PARAMS, cursor: stored });
    expect(changes.episodes).toHaveLength(1);
    const marks = parseOutlookCursor(changes.cursor ?? null);
    // mailbox B was never visited — its mark must survive untouched.
    expect(marks["mb-b"]).toBe("2026-07-11T00:00:00.000Z");
    // …and A, which was walked and interrupted, resumes at the message it read.
    expect(marks["mb-a"]).toBe("2026-07-01T10:00:00Z");
  });

  it("⭐ one unresolvable mailbox does not starve the mailboxes after it", async () => {
    // With a single mailbox configured, `continue` and `break mailboxes` are
    // indistinguishable — so the original version of this test could not tell
    // isolation from abandonment. In production one deleted or unlicensed user
    // at position 1 of a 50-mailbox install would silently starve the other 49.
    //
    // MUTATION THIS CATCHES: `continue` → `break mailboxes` on the identity-read
    // failure.
    const vendor = createOutlookMailClient({
      workspaceId: "ws",
      resolveToken: async () => "tok",
      mailboxes: ["gone@contoso.com", "b@contoso.com"],
      backfillWindowMs: 30 * 86_400_000,
      now: () => NOW,
      api: {
        fetchMailbox: async (_t, mailbox) =>
          mailbox === "gone@contoso.com"
            ? { ok: false as const, error: "not_found" as const, retryAfterSeconds: null }
            : {
                ok: true as const,
                mailbox: { id: "mb-b", userPrincipalName: mailbox, mail: mailbox },
              },
        fetchMailboxMessagesPage: async () => ({
          ok: true as const,
          messages: [message()],
          nextLink: null,
          dropped: 0,
        }),
        fetchMailboxMessagesNextPage: async () => ({
          ok: true as const,
          messages: [],
          nextLink: null,
          dropped: 0,
        }),
      },
      audienceDeps: {
        resolve: async (_ws, principals) => ({
          resolved: new Map(principals.map((p) => [p.id, `u-${p.id}`])),
          unresolvedCount: 0,
        }),
        reconcile: async () => ({ added: 1, revoked: 0 }),
      },
    });
    const changes = await vendor.fetchEpisodes(PARAMS);
    // The SECOND mailbox was still walked.
    expect(changes.episodes).toHaveLength(1);
    expect(changes.coverageIncomplete).toBe(true);
    expect(changes.warnings?.join(" ")).toMatch(/no longer recognises/);
    // Nothing was pruned: one mailbox did not resolve, so this pass cannot prove
    // any stored key left the config.
    expect(parseOutlookCursor(changes.cursor ?? null)["mb-b"]).toBe(NOW.toISOString());
  });

  it("isolates an unresolvable mailbox without losing the pass", async () => {
    const vendor = createOutlookMailClient({
      workspaceId: "ws",
      resolveToken: async () => "tok",
      mailboxes: ["gone@contoso.com"],
      backfillWindowMs: 30 * 86_400_000,
      now: () => NOW,
      api: {
        fetchMailbox: async () => ({
          ok: false as const,
          error: "not_found" as const,
          retryAfterSeconds: null,
        }),
        fetchMailboxMessagesPage: async () => {
          throw new Error("must not be reached");
        },
        fetchMailboxMessagesNextPage: async () => {
          throw new Error("must not be reached");
        },
      },
      audienceDeps: {},
    });
    const changes = await vendor.fetchEpisodes(PARAMS);
    expect(changes.episodes).toHaveLength(0);
    expect(changes.coverageIncomplete).toBe(true);
    expect(changes.warnings?.join(" ")).toMatch(/no longer recognises/);
  });
});
