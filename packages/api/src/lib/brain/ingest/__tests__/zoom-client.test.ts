/**
 * The Zoom transcript client (#4965) — and specifically ADR-0036 §T6's
 * BLOCK-VS-FLAG ASYMMETRY, which is the thing a green suite does not otherwise
 * prove.
 *
 * The two rules pull in opposite directions:
 *
 *   - underivable AUDIENCE  → BLOCK + log. Never ingest ungranted.
 *   - entity-res failure    → FLAG provisional. Never block.
 *
 * A transcript produces plenty of the second, and the dangerous failure is
 * silently producing the first — or, worse, inverting them: blocking on a
 * quality problem (nobody recognised the speaker) or ingesting on a safety one
 * (we could not read who was in the room). Both inversions leave a suite green,
 * so each arm below is written to FAIL against the mutation that would cause
 * it, and each says which mutation.
 */

import { describe, expect, it } from "bun:test";
import { AUDIENCE_PREFIX, ORG_PRINCIPAL, parseGrant } from "@atlas/api/lib/brain/acl";
import { ConnectorRateLimitError } from "@atlas/api/lib/knowledge/connectors";
import {
  createZoomTranscriptClient,
  parseZoomCursor,
} from "@atlas/api/lib/brain/ingest/zoom/client";
import type { ZoomAudienceDeps } from "@atlas/api/lib/brain/ingest/zoom/audience";

const UUID = "4kd8sZTiSHagYbwYtLpMRA==";
const FILE_ID = "a7f3c1e2-4b5d-6789-0abc-def123456789";
const NOW = new Date("2026-03-10T12:00:00Z");

const VTT = `WEBVTT

1
00:00:01.000 --> 00:00:04.000
Alice Smith: revenue closed at 4.2 million
`;

/** One recorded meeting with one transcript file. */
function meetingPage(overrides: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    meetings: [
      {
        uuid: UUID,
        topic: "Q1 review",
        hostId: "host-1",
        startTime: "2026-03-09T15:00:00Z",
        files: [
          { id: FILE_ID, fileType: "TRANSCRIPT", downloadUrl: "https://zoom.us/rec/x", fileSize: 512 },
          { id: "b8e4d2f3-5c6e-7890-1bcd-ef2345678901", fileType: "MP4", downloadUrl: "https://zoom.us/rec/v", fileSize: 99 },
        ],
      },
    ],
    nextPageToken: null,
    dropped: 0,
    ...overrides,
  };
}

interface Harness {
  readonly downloads: string[];
  readonly reconciles: { audienceId: string; userIds: readonly string[] }[];
}

/**
 * Build a client over fakes. `participants` decides the roster read: an array
 * is a complete roster, `"fail"` is a vendor error, `"endless"` never stops
 * paging. Those three are exactly the inputs the block arm turns on.
 */
function harness(options: {
  participants: { email: string | null; name: string | null; userId: string | null }[] | "fail" | "endless";
  resolved?: Map<string, string>;
  pageOverrides?: Record<string, unknown>;
}) {
  const state: Harness = { downloads: [], reconciles: [] };

  const audienceDeps: ZoomAudienceDeps = {
    fetchParticipantsPage: async () => {
      if (options.participants === "fail") {
        return { ok: false as const, error: "transport", retryAfterSeconds: null };
      }
      if (options.participants === "endless") {
        return { ok: true as const, participants: [], nextPageToken: "always-more" };
      }
      return { ok: true as const, participants: options.participants, nextPageToken: null };
    },
    resolve: async () => ({
      resolved: options.resolved ?? new Map<string, string>(),
      unresolvedCount:
        options.participants === "fail" || options.participants === "endless"
          ? 0
          : options.participants.length - (options.resolved?.size ?? 0),
    }),
    reconcile: async (input) => {
      state.reconciles.push({ audienceId: input.audienceId, userIds: input.userIds });
      return { added: input.userIds.length, revoked: 0 };
    },
  };

  const client = createZoomTranscriptClient({
    workspaceId: "ws1",
    accountId: "acc1",
    hosts: [],
    backfillWindowMs: 7 * 86_400_000,
    resolveToken: async () => "tok",
    now: () => NOW,
    audienceDeps,
    api: {
      fetchAccountRecordingsPage: async () => meetingPage(options.pageOverrides ?? {}),
      fetchTranscriptText: async (_token, url) => {
        state.downloads.push(url);
        return { ok: true as const, text: VTT };
      },
    },
  });
  return { client, state };
}

const PARAMS = { mode: "incremental" as const, since: null, cursor: null, maxEpisodes: 100 };

describe("the FLAG side — a transcript must ingest despite unresolved people", () => {
  it("ingests a meeting whose roster resolves to NOBODY", () => {
    // The sharpest case, and the one an over-eager "safety" fix breaks. A
    // meeting of five external guests has a perfectly well-ESTABLISHED audience
    // that currently contains no Atlas users. Blocking it would discard
    // evidence permanently on a condition that repairs itself the moment one of
    // them gets an account — which is exactly what the `audience:` indirection
    // buys.
    //
    // MUTATION THIS CATCHES: making `deriveMeetingParticipantGrant` (or this
    // client) return null / skip when the resolution is empty.
    return (async () => {
      const { client, state } = harness({
        participants: [{ email: "guest@acme.example", name: "External Guest", userId: "z1" }],
        resolved: new Map(),
      });
      const changes = await client.fetchEpisodes(PARAMS);

      expect(changes.episodes).toHaveLength(1);
      expect(changes.episodes[0].sourceId).toBe(`${UUID}:${FILE_ID}`);
      // Reconciled to EMPTY rather than skipped — "the meeting resolved to
      // nobody" is a real answer, and skipping the reconcile to "protect" rows
      // would preserve exactly the stale access the table exists to drop.
      expect(state.reconciles).toEqual([
        { audienceId: `meeting:zoom:${UUID}`, userIds: [] },
      ]);
    })();
  });

  it("ingests speaker labels VERBATIM and resolves no entity", async () => {
    // The connector must not resolve speakers at all — that is #4771's job,
    // where a failure flags `provisional`. A body carrying the raw label is the
    // observable proof it did not try.
    const { client } = harness({
      participants: [{ email: "a@x.example", name: "Alice", userId: "z1" }],
      resolved: new Map([["z1", "user-1"]]),
    });
    const changes = await client.fetchEpisodes(PARAMS);
    expect(changes.episodes[0].body).toBe("Alice Smith: revenue closed at 4.2 million");
    // `sourceActor` is the HOST — the one identity Zoom states unambiguously —
    // never a guessed speaker.
    expect(changes.episodes[0].sourceActor).toBe("host-1");
  });

  it("leaves extraction to the async drain — the record cannot carry a mark", async () => {
    // `BrainEpisodeRecord` has no `extractedAt`, so this client cannot stamp
    // one even by accident and the episode lands with `extracted_at IS NULL`.
    // Asserted structurally: a field appearing here later would be the
    // synchronous fast-path ADR-0036 forbids.
    const { client } = harness({ participants: [], resolved: new Map() });
    const changes = await client.fetchEpisodes(PARAMS);
    expect(Object.keys(changes.episodes[0]).toSorted()).toEqual([
      "body",
      "occurredAt",
      "sourceActor",
      "sourceId",
      "visibleTo",
    ]);
  });
});

describe("the BLOCK side — an unestablished audience must ingest NOTHING", () => {
  it("BLOCKS the meeting when the participant read FAILS", async () => {
    // MUTATION THIS CATCHES: passing `rosterComplete: true` unconditionally, or
    // defaulting a failed roster read to an empty-but-complete one.
    const { client, state } = harness({ participants: "fail" });
    const changes = await client.fetchEpisodes(PARAMS);

    expect(changes.episodes).toEqual([]);
    // Never silently: the pass reports incomplete coverage and names the meeting.
    expect(changes.coverageIncomplete).toBe(true);
    expect((changes.warnings ?? []).join(" ")).toMatch(new RegExp(`Meeting ${UUID.replace(/[+/=]/g, "\\$&")} was NOT ingested`));
    // The high-water mark must NOT advance over a blocked meeting.
    expect(changes.highWaterMark).toBeNull();
    // …and neither must the CURSOR, which is what actually matters: this
    // client never reads `params.since`, so the cursor is its SOLE resume
    // point. Asserting only the mark is what let the original defect through —
    // the mark went null (costing nothing) while the cursor walked past the
    // blocked meeting's date, and it was never re-read.
    //
    // The blocked meeting is dated 2026-03-09 and `now` is 2026-03-10, so a
    // correct pass leaves the resume point at or before 03-09.
    const resume = parseZoomCursor(changes.cursor ?? null);
    expect(resume === null || resume <= "2026-03-09").toBe(true);
    // And nothing was reconciled — writing membership for a roster we could not
    // read would revoke everyone it failed to fetch.
    expect(state.reconciles).toEqual([]);
  });

  it("BLOCKS before spending a single transcript download", async () => {
    // Ordering, asserted directly. A meeting Atlas cannot grant must not have
    // its content fetched at all — establishing the audience is the cheap,
    // decisive read and it goes first.
    //
    // MUTATION THIS CATCHES: moving the grant check after the download loop,
    // which leaves every assertion above green while the content of an
    // ungrantable meeting travels over the wire.
    const { client, state } = harness({ participants: "fail" });
    await client.fetchEpisodes(PARAMS);
    expect(state.downloads).toEqual([]);
  });

  it("BLOCKS when roster paging does not terminate", async () => {
    // A truncated roster is not a degraded input — it is a MASS REVOCATION,
    // because the reconcile deletes everyone outside the set it is handed.
    const { client, state } = harness({ participants: "endless" });
    const changes = await client.fetchEpisodes(PARAMS);
    expect(changes.episodes).toEqual([]);
    expect(state.reconciles).toEqual([]);
    expect((changes.warnings ?? []).join(" ")).toMatch(/paging/);
  });

  it("NEVER falls back to a wider grant", async () => {
    // The failure a wider-grant fallback produces is a leak no downstream gate
    // can catch, because the reviewer is shown the grant Atlas derived rather
    // than the one Zoom had. Swept over both arms: the blocked meeting produces
    // no episode at all, and the ingested one names only its own audience.
    for (const participants of ["fail", [{ email: "a@x.example", name: "A", userId: "z1" }]] as const) {
      const { client } = harness({ participants: participants as never });
      const changes = await client.fetchEpisodes(PARAMS);
      for (const episode of changes.episodes) {
        expect(episode.visibleTo).not.toContain(ORG_PRINCIPAL);
        expect(episode.visibleTo).toEqual([`${AUDIENCE_PREFIX}meeting:zoom:${UUID}`]);
        // And the token is genuinely usable — a grant that parses to no
        // principal is legal, invisible, and permanently unpublishable.
        expect(parseGrant(episode.visibleTo).principals).toEqual([
          { kind: "audience", audienceId: `meeting:zoom:${UUID}` },
        ]);
      }
    }
  });
});

describe("budget exhaustion — the other way to skip work silently", () => {
  /** A page of `count` distinct meetings, all dated 2026-03-09. */
  function multiMeetingClient(maxEpisodes: number) {
    const uuids = ["AAAAAAAAAAAAAAAAAAAAAA==", "BBBBBBBBBBBBBBBBBBBBBB==", "CCCCCCCCCCCCCCCCCCCCCC=="];
    const client = createZoomTranscriptClient({
      workspaceId: "ws1",
      accountId: "acc1",
      hosts: [],
      backfillWindowMs: 7 * 86_400_000,
      resolveToken: async () => "tok",
      now: () => NOW,
      audienceDeps: {
        fetchParticipantsPage: async () => ({
          ok: true as const,
          participants: [{ email: "a@x.example", name: "A", userId: "z1" }],
          nextPageToken: null,
        }),
        resolve: async () => ({ resolved: new Map([["z1-0", "user-1"]]), unresolvedCount: 0 }),
        reconcile: async () => ({ added: 1, revoked: 0 }),
      },
      api: {
        fetchAccountRecordingsPage: async () => ({
          ok: true as const,
          meetings: uuids.map((uuid) => ({
            uuid,
            topic: "t",
            hostId: "host-1",
            startTime: "2026-03-09T15:00:00Z",
            files: [
              {
                id: FILE_ID,
                fileType: "TRANSCRIPT",
                downloadUrl: "https://zoom.us/rec/x",
                fileSize: 512,
              },
            ],
          })),
          nextPageToken: null,
          dropped: 0,
        }),
        fetchTranscriptText: async () => ({ ok: true as const, text: VTT }),
      },
    });
    return { client, params: { ...PARAMS, maxEpisodes } };
  }

  it("does not advance the cursor past meetings the budget never reached", async () => {
    // The panel found this had NO test, and the mutation harness then found the
    // fix survived without one. `break` (not `break windows`) on the last page
    // of the last window let the loops simply run out: the window was marked
    // covered, the cursor advanced to today, and the unread meetings were gone
    // forever with `coverageIncomplete: false` and no warning at all.
    //
    // MUTATION THIS CATCHES: removing the `walkIncomplete = true` at the
    // meetings-loop budget guard.
    //
    // NOT `break windows` → `break`, which an earlier version of this comment
    // claimed. That mutant SURVIVES, and correctly so: since the cursor advance
    // is gated on `walkIncomplete`, the `break windows` is now redundant for
    // correctness and only bounds how much further the pass walks. Verified by
    // running it rather than assumed. The flag is therefore the single point of
    // failure for cursor safety on all three arms (block, dropped, budget) —
    // which is what this assertion actually guards.
    const { client, params } = multiMeetingClient(1);
    const changes = await client.fetchEpisodes(params);

    expect(changes.episodes).toHaveLength(1);
    expect(changes.coverageIncomplete).toBe(true);
    expect(changes.highWaterMark).toBeNull();
    const resume = parseZoomCursor(changes.cursor ?? null);
    expect(resume === null || resume <= "2026-03-09").toBe(true);
  });

  it("names the RECORD budget, not the page budget — they send an operator to different places", async () => {
    // Blaming the page budget when the record cap bound sends the admin to
    // raise a plan limit that was never the constraint.
    const { client, params } = multiMeetingClient(1);
    const changes = await client.fetchEpisodes(params);
    expect((changes.warnings ?? []).join(" ")).toMatch(/per-sync record budget \(1\)/);
  });

  it("never returns more episodes than the cap it was given", async () => {
    // A hard contract: `episode-sync.ts` REFUSES the whole batch on overshoot,
    // so exceeding the cap loses everything rather than truncating.
    for (const cap of [1, 2, 3]) {
      const { client, params } = multiMeetingClient(cap);
      const changes = await client.fetchEpisodes(params);
      expect([cap, changes.episodes.length <= cap]).toEqual([cap, true]);
    }
  });
});

describe("coverage honesty", () => {
  it("does not advance the mark over entries with no usable identity", async () => {
    // They sit INSIDE the window the pass is about to mark covered, so
    // advancing past them would be the silent skip an append-only store cannot
    // recover from.
    const { client } = harness({ participants: [], pageOverrides: { dropped: 2 } });
    const changes = await client.fetchEpisodes(PARAMS);
    expect(changes.coverageIncomplete).toBe(true);
    expect(changes.highWaterMark).toBeNull();
    // Same negative as the block arm: the resume point must not pass the
    // window whose entries could not be identified.
    const resume = parseZoomCursor(changes.cursor ?? null);
    expect(resume === null || resume <= "2026-03-09").toBe(true);
    expect((changes.warnings ?? []).join(" ")).toMatch(/no usable identity/);
  });

  it("reports a high-water mark only on a fully covered pass", async () => {
    const { client } = harness({
      participants: [{ email: "a@x.example", name: "A", userId: "z1" }],
      resolved: new Map([["z1", "user-1"]]),
    });
    const changes = await client.fetchEpisodes(PARAMS);
    expect(changes.coverageIncomplete).toBe(false);
    expect(changes.highWaterMark).not.toBeNull();
    expect(changes.cursor).toContain('"v":1');
  });

  it("ingests only TRANSCRIPT files, never the video alongside them", async () => {
    const { client, state } = harness({
      participants: [{ email: "a@x.example", name: "A", userId: "z1" }],
      resolved: new Map([["z1", "user-1"]]),
    });
    const changes = await client.fetchEpisodes(PARAMS);
    expect(changes.episodes).toHaveLength(1);
    expect(state.downloads).toEqual(["https://zoom.us/rec/x"]);
  });
});

describe("the two regressions round 1's fixes INTRODUCED", () => {
  /** A client whose recordings page and transcript download are controllable. */
  function client(opts: {
    cursor?: string | null;
    backfillDays?: number;
    download?: () => Promise<{ ok: true; text: string } | { ok: false; error: string; retryAfterSeconds: number | null }>;
    hosts?: readonly string[];
    hostId?: string | null;
  }) {
    return createZoomTranscriptClient({
      workspaceId: "ws1",
      accountId: "acc1",
      hosts: opts.hosts ?? [],
      backfillWindowMs: (opts.backfillDays ?? 7) * 86_400_000,
      resolveToken: async () => "tok",
      now: () => NOW,
      audienceDeps: {
        fetchParticipantsPage: async () => ({
          ok: true as const,
          participants: [{ email: "a@x.example", name: "A", userId: "z1" }],
          nextPageToken: null,
        }),
        resolve: async () => ({ resolved: new Map([["z1-0", "user-1"]]), unresolvedCount: 0 }),
        reconcile: async () => ({ added: 1, revoked: 0 }),
      },
      api: {
        fetchAccountRecordingsPage: async () => ({
          ...meetingPage(),
          meetings: [
            { ...meetingPage().meetings[0], hostId: opts.hostId === undefined ? "host-1" : opts.hostId },
          ],
        }),
        fetchTranscriptText:
          opts.download ?? (async () => ({ ok: true as const, text: VTT })),
      },
    });
  }

  it("a mark older than the backfill floor must still ADVANCE the cursor", async () => {
    // THE round-2 CRITICAL, and it was caused by round 1's fix. "History older
    // than the floor is lost" is report-only — the floor IS the new start — but
    // it shared one flag with "work inside the walked range was left undone",
    // which gates the resume point. Gating on the union wedged the connector:
    // the sync cadence is daily and the floor moves with it, so the mark written
    // by pass N was always a day older than pass N+1's floor. The stale branch
    // re-fired forever, the cursor never left the floor, and every pass re-walked
    // the entire backfill.
    //
    // MUTATION THIS CATCHES: folding `historyTruncated` back into the cursor gate.
    const stale = JSON.stringify({ v: 1, coveredThrough: "2025-01-01" });
    // The window sequence is recorded, because the final cursor alone does NOT
    // distinguish the two behaviours — a walk from 2025-01-01 also ends at
    // today, so that assertion let the "drop the floor clamp" mutant survive.
    const windows: string[] = [];
    const c = createZoomTranscriptClient({
      workspaceId: "ws1",
      accountId: "acc1",
      hosts: [],
      backfillWindowMs: 7 * 86_400_000,
      resolveToken: async () => "tok",
      now: () => NOW,
      audienceDeps: {
        fetchParticipantsPage: async () => ({
          ok: true as const,
          participants: [{ email: "a@x.example", name: "A", userId: "z1" }],
          nextPageToken: null,
        }),
        resolve: async () => ({ resolved: new Map([["z1-0", "user-1"]]), unresolvedCount: 0 }),
        reconcile: async () => ({ added: 1, revoked: 0 }),
      },
      api: {
        fetchAccountRecordingsPage: async (_t, args) => {
          windows.push(args.from);
          return { ok: true as const, meetings: [], nextPageToken: null, dropped: 0 };
        },
        fetchTranscriptText: async () => ({ ok: true as const, text: VTT }),
      },
    });
    const changes = await c.fetchEpisodes({ ...PARAMS, cursor: stale });

    // Reported honestly — the lost history is real and named…
    expect(changes.coverageIncomplete).toBe(true);
    expect((changes.warnings ?? []).join(" ")).toMatch(/older than the/);
    // …the walk started at the FLOOR, not at the stale mark. Without the clamp
    // it would open ~15 monthly windows against a vendor that serves six months.
    expect(windows).toEqual(["2026-03-03"]);
    // …and the cursor MOVED FORWARD, so the next pass starts from the frontier
    // instead of re-walking the floor window forever.
    expect(parseZoomCursor(changes.cursor ?? null)).toBe("2026-03-10");
  });

  it("an OVER-CAP transcript is skipped, never thrown — it is a permanent condition", async () => {
    // The second regression round 1 introduced. The new Content-Length refusal
    // returned `too_large`, and the client threw on every non-ok download — so a
    // permanently over-cap file froze the cursor on every pass, and ~30 days
    // later the frozen cursor fell below the floor and wedged the source. The
    // pre-existing post-buffer check always skipped correctly; the new
    // pre-buffer one did the opposite, turning a size guard into an outage.
    //
    // MUTATION THIS CATCHES: removing the `too_large` arm so it throws again.
    const changes = await client({
      download: async () => ({ ok: false, error: "too_large", retryAfterSeconds: null }),
    }).fetchEpisodes(PARAMS);

    expect(changes.episodes).toEqual([]);
    expect((changes.warnings ?? []).join(" ")).toMatch(/skipped rather than truncated/);
    // A SKIP, so the window is still covered and the pass is not frozen.
    expect(changes.coverageIncomplete).toBe(false);
    expect(parseZoomCursor(changes.cursor ?? null)).toBe("2026-03-10");
  });

  it("⭐ an UNUSABLE download_url is skipped, never thrown — same permanence as over-cap", async () => {
    // The third route to the same outage, opened by the HTTPS/host pin added in
    // the M3 review panel. Those refusals returned `transport`, which this
    // client throws on — so one non-HTTPS or non-Zoom `download_url` from a
    // hybrid or Meeting-Connector host froze `coveredThrough` at the prior
    // window on EVERY pass, and ~30 days later the frozen cursor fell below the
    // backfill floor and wedged the source.
    //
    // A stored recording's `download_url` is the same string next pass, so this
    // is permanent in exactly the way `too_large` is, and belongs on the same
    // arm. `transport` has to stay retryable — a real network fault IS a bad
    // moment — which is why the refusals needed their own code rather than a
    // change of policy for `transport`.
    //
    // MUTATION THIS CATCHES: returning `transport` from the URL-shape refusals
    // in `zoom/api.ts`, or dropping the `unusable_url` arm in the client.
    const changes = await client({
      download: async () => ({ ok: false, error: "unusable_url", retryAfterSeconds: null }),
    }).fetchEpisodes(PARAMS);

    expect(changes.episodes).toEqual([]);
    expect((changes.warnings ?? []).join(" ")).toMatch(/unusable form/);
    // The window is covered and the cursor advances — that is the whole point.
    expect(changes.coverageIncomplete).toBe(false);
    expect(parseZoomCursor(changes.cursor ?? null)).toBe("2026-03-10");
  });

  it("a transcript Zoom has not published yet is RETRIED, not dropped", async () => {
    // Zoom omits `download_url` while a file is still processing. Bucketing that
    // with permanently-unusable ids let the cursor advance past a transcript
    // that would have been downloadable minutes later.
    const c = createZoomTranscriptClient({
      workspaceId: "ws1",
      accountId: "acc1",
      hosts: [],
      backfillWindowMs: 7 * 86_400_000,
      resolveToken: async () => "tok",
      now: () => NOW,
      audienceDeps: {
        fetchParticipantsPage: async () => ({
          ok: true as const,
          participants: [{ email: "a@x.example", name: "A", userId: "z1" }],
          nextPageToken: null,
        }),
        resolve: async () => ({ resolved: new Map(), unresolvedCount: 1 }),
        reconcile: async () => ({ added: 0, revoked: 0 }),
      },
      api: {
        fetchAccountRecordingsPage: async () => ({
          ...meetingPage(),
          meetings: [
            {
              ...meetingPage().meetings[0],
              files: [{ id: FILE_ID, fileType: "TRANSCRIPT", downloadUrl: null, fileSize: null }],
            },
          ],
        }),
        fetchTranscriptText: async () => ({ ok: true as const, text: VTT }),
      },
    });
    const changes = await c.fetchEpisodes(PARAMS);
    expect(changes.episodes).toEqual([]);
    expect(changes.coverageIncomplete).toBe(true);
    const resume = parseZoomCursor(changes.cursor ?? null);
    expect(resume === null || resume <= "2026-03-09").toBe(true);
  });
});

describe("rate limiting — the engine owns the retry, not this client", () => {
  function throttledClient(bankFirst: boolean) {
    let call = 0;
    return createZoomTranscriptClient({
      workspaceId: "ws1",
      accountId: "acc1",
      hosts: [],
      backfillWindowMs: 7 * 86_400_000,
      resolveToken: async () => "tok",
      now: () => NOW,
      audienceDeps: {
        fetchParticipantsPage: async () => ({
          ok: true as const,
          participants: [{ email: "a@x.example", name: "A", userId: "z1" }],
          nextPageToken: null,
        }),
        resolve: async () => ({ resolved: new Map([["z1-0", "user-1"]]), unresolvedCount: 0 }),
        reconcile: async () => ({ added: 1, revoked: 0 }),
      },
      api: {
        fetchAccountRecordingsPage: async () => ({
          ok: true as const,
          meetings: ["AAAAAAAAAAAAAAAAAAAAAA==", "BBBBBBBBBBBBBBBBBBBBBB=="].map((uuid) => ({
            uuid,
            topic: "t",
            hostId: "host-1",
            startTime: "2026-03-09T15:00:00Z",
            files: [
              { id: FILE_ID, fileType: "TRANSCRIPT", downloadUrl: "https://zoom.us/rec/x", fileSize: 512 },
            ],
          })),
          nextPageToken: null,
          dropped: 0,
        }),
        fetchTranscriptText: async () => {
          call++;
          // With `bankFirst`, the first meeting succeeds so the pass has
          // something to bank before the throttle lands.
          if (bankFirst && call === 1) return { ok: true as const, text: VTT };
          return { ok: false as const, error: "ratelimited", retryAfterSeconds: 30 };
        },
      },
    });
  }

  it("RETHROWS ConnectorRateLimitError when nothing was banked", async () => {
    // ADR-0030's whole point: the shared bounded backoff owns the retry. If this
    // client swallowed the throttle, Atlas would keep polling a vendor that said
    // stop and the engine's backoff would never engage.
    await expect(throttledClient(false).fetchEpisodes(PARAMS)).rejects.toBeInstanceOf(
      ConnectorRateLimitError,
    );
  });

  it("BANKS what it has and returns when the throttle lands mid-pass", async () => {
    // Throwing here would discard the episodes already earned, and because a
    // throttled multi-meeting crawl is the steady state rather than an
    // exception, the same prefix would be re-walked and re-lost every cycle.
    const changes = await throttledClient(true).fetchEpisodes(PARAMS);
    expect(changes.episodes).toHaveLength(1);
    expect(changes.coverageIncomplete).toBe(true);
    expect((changes.warnings ?? []).join(" ")).toMatch(/rate limiting/);
    // And the banked prefix must not carry the cursor past the unread meeting.
    const resume = parseZoomCursor(changes.cursor ?? null);
    expect(resume === null || resume <= "2026-03-09").toBe(true);
  });
});

describe("host scoping", () => {
  it("ingests ONLY the configured hosts — the inverse is a scope-widening leak", async () => {
    // Inverting this filter silently ingests every meeting in the account, each
    // with its own audience, on an install the admin deliberately narrowed.
    const scoped = createZoomTranscriptClient({
      workspaceId: "ws1",
      accountId: "acc1",
      hosts: ["host-2"],
      backfillWindowMs: 7 * 86_400_000,
      resolveToken: async () => "tok",
      now: () => NOW,
      audienceDeps: {
        fetchParticipantsPage: async () => ({
          ok: true as const,
          participants: [{ email: "a@x.example", name: "A", userId: "z1" }],
          nextPageToken: null,
        }),
        resolve: async () => ({ resolved: new Map([["z1-0", "user-1"]]), unresolvedCount: 0 }),
        reconcile: async () => ({ added: 1, revoked: 0 }),
      },
      api: {
        // The fixture meeting is hosted by `host-1`, which is NOT configured.
        fetchAccountRecordingsPage: async () => meetingPage(),
        fetchTranscriptText: async () => ({ ok: true as const, text: VTT }),
      },
    });
    const changes = await scoped.fetchEpisodes(PARAMS);
    expect(changes.episodes).toEqual([]);
    // Out of scope is not undone work — the admin asked for exactly these hosts.
    expect(changes.coverageIncomplete).toBe(false);
  });
});

describe("parseZoomCursor degrades, never throws", () => {
  it("returns null for every unreadable shape", () => {
    // Throwing would wedge the source permanently on one bad row with no
    // operator-reachable repair; re-crawling from the floor is a deduped no-op.
    for (const raw of [
      null,
      "",
      "{",
      "[]",
      "null",
      '"a string"',
      '{"v":2,"coveredThrough":"2026-03-01"}',
      '{"v":1}',
      '{"v":1,"coveredThrough":"2026-3-9"}',
      '{"v":1,"coveredThrough":42}',
    ]) {
      expect([String(raw), parseZoomCursor(raw)]).toEqual([String(raw), null]);
    }
  });

  it("round-trips a valid cursor", () => {
    expect(parseZoomCursor('{"v":1,"coveredThrough":"2026-03-09"}')).toBe("2026-03-09");
  });
});
