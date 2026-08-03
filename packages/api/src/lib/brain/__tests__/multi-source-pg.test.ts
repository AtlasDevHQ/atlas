/**
 * The M3 multi-source stack, proven end to end (#4968, ADR-0036 §T6 — source
 * breadth) — the third arc proof, after `wedge-loop-pg.test.ts` (#4775, one
 * source) and `temporal-loop-pg.test.ts` (#4917, one timeline).
 *
 * ## Why this file exists when every M3 stage already has a suite
 *
 * `zoom-client.test.ts` and `outlook-client.test.ts` each drive ONE connector
 * against ONE vendor fixture, and each is structurally blind to the other's
 * existence. Every claim below needs two source CLASSES alive in one workspace
 * at once, which is the one thing a per-connector suite cannot pose:
 *
 *   1. **Cross-class corroboration.** `CORROBORATION_LOOKUP_SQL` matches on
 *      workspace+subject+predicate+object and is deliberately blind to source,
 *      so a claim said in a meeting and repeated in a mail must strengthen ONE
 *      row rather than mint two. This is the first time that lookup sees two
 *      genuinely different classes, and the failure mode is silent: two rows
 *      that each read as a lone, uncorroborated claim.
 *   2. **Cross-class contradiction.** The advisory `in-tension-with` edge must
 *      surface BOTH sides with each side's OWN class provenance and rank
 *      neither. A projection that collapsed provenance across classes, or that
 *      let one class stand in for the other, would leave every per-stage suite
 *      green — they only ever have one class to project.
 *   3. **Per-class ACL isolation under a heterogeneous grant set.** T5's
 *      push-down predicate has never been run against a reader holding
 *      `org` + `audience:meeting:…` but NOT `audience:email-message:…`. The
 *      three grant grammars are minted by three different derivers
 *      (`ingest/grant.ts` keeps them as three functions precisely so the chat
 *      class's public arm cannot spread), and this is where their tokens meet
 *      one reader.
 *   4. **Extraction-lag labelling.** §T7 commits that a best-match episode with
 *      `extracted_at IS NULL` is still returned, tagged
 *      `tier: raw-episode, extraction: pending`. With three connectors landing
 *      episodes into one shared drain (25 episodes / 5 min, process-wide, no
 *      knob — see `brain-sources`) that window is routinely open rather than a
 *      corner case, and the regression to fear is a read that BLOCKS on it.
 *
 * ## What is faked, precisely
 *
 * Three vendor HTTP surfaces, and nothing else:
 *
 *   - **Slack's** — a fixture `SlackHistoryApi` under the REAL
 *     `createSlackHistoryClient` (`wedge-loop-pg.test.ts`'s arrangement).
 *   - **Zoom's** — fixture `fetchAccountRecordingsPage` / `fetchTranscriptText`
 *     / `fetchMeetingParticipantsPage` under the REAL
 *     `createZoomTranscriptClient`. The VTT parse, the source-id builder, the
 *     roster read and `deriveMeetingParticipantGrant` all run for real.
 *   - **Microsoft Graph's** — fixture `fetchMailbox` /
 *     `fetchMailboxMessagesPage` / `fetchMailboxMessagesNextPage` under the REAL
 *     `createOutlookMailClient`. `messageParticipants`, the participants digest,
 *     `deriveEmailRecipientGrant` and `composeEmailBody` all run for real.
 *   - **The extraction model** — a `MockLanguageModelV3` returning fixed JSON
 *     under the real `generateObject` schema parse.
 *
 * NOT on the path, and deliberately: the three connector factories and their
 * config parsers / token resolvers (`slack-connector.test.ts`,
 * `zoom-config.test.ts`, `outlook-connector.test.ts` own those), which is why
 * each connector below is a test-owned shim. Everything else — ingest,
 * extraction, reconcile with its corroboration and tension passes, the publish
 * gate with its #4823 grant widening and its supersession collision, and both
 * read surfaces — is production code against real Postgres.
 *
 * ## Fixture discipline (inherited from #4775 and #4917)
 *
 *   - Reader contexts come from `resolvePrincipalContext` against the real
 *     `fact_audience_member` table. Audience MEMBERSHIP is written by the
 *     connectors' own ingest-time reconcile (`reconcileMeetingAudience`,
 *     `reconcileEmailAudience`) over the real `resolvePrincipals` and
 *     `reconcileAudienceMembership` — a hand-INSERTed membership row would make
 *     every ACL assertion below a statement about the fixture.
 *   - Every audience token is built through the production id helper
 *     (`meetingAudienceId`, `emailMessageAudienceId` + `emailParticipantsDigest`),
 *     so the grant grammar cannot drift out from under the assertions.
 *   - NO `workspace_plugins` install row is seeded, so `upsertConnectorSyncState`
 *     silently no-ops. The premise is PINNED per sync (`syncSource`), because the
 *     `duplicate` counts below rest on it.
 *   - The clock is INJECTED and MOVES (`clockAt`). It is load-bearing twice: the
 *     backfill floors would exclude every fixture record against the real clock,
 *     and the Outlook walk resumes at PASS-START rather than at the newest
 *     message, so the rival mail can only arrive after the clock advances. A
 *     future-dated fixture message would have got the same rows in and hidden
 *     that.
 *
 * ## ⚠️ The three M3-specific traps this file is written around
 *
 * **The email audience is a documented LOWER BOUND, not a complete set.**
 * #4966 shipped From+To+Cc with Bcc ignored *even on the sender's copy that
 * exposes it* — for DETERMINISM (episodes dedupe cross-mailbox on the RFC 5322
 * Message-ID, so which copy wins is undetermined and `bccRecipients` exists only
 * on one of them). The isolation arm below therefore asserts membership as an
 * EQUALITY against that stated bound, with the narratively-BCC'd person named,
 * rather than against "everyone who received the mail". Note the bound is
 * structural here rather than posed: `OutlookMessage` carries no bcc field at
 * all and `$select` never asks for one, so this fixture COULD NOT put a BCC'd
 * recipient on a message if it wanted to. The assertion is over what
 * `messageParticipants` — the production deriver — actually yields.
 *
 * **Staleness suppression is a live path and would fake this file's results.**
 * `acl.ts` suppresses any audience whose `min(synced_at)` is older than
 * `ATLAS_BRAIN_AUDIENCE_MAX_STALENESS_HOURS`, so an audience that went stale
 * would vanish from a reader's context for a reason that has nothing to do with
 * the invariant under test — and "the reader saw nothing" is exactly what half
 * the isolation assertions look like when they PASS. Freshness is therefore a
 * pinned PREMISE (`expectAudiencesFresh`), asserted through the module's own
 * `AUDIENCE_MEMBERSHIP_SQL` before any isolation claim is made. It holds here
 * because the ingest-time reconcile stamps `synced_at`, not because the
 * re-verifier ran: this suite never drives #4971's scan, and
 * `brain_audience_reverify_attempt` (migration 0186) is asserted EMPTY so that a
 * future change which starts running the re-verifier here has to confront what
 * that does to `synced_at` rather than inherit a green suite.
 *
 * **`conversations.history` DOES return `thread_broadcast` copies.** #4969's
 * panel narrowed #4967's backstop claim, so nothing here asserts the absolute
 * "anything the webhook drops, the poll stores". The chat class appears below
 * only as the POLL — the webhook fast-path is `slack-webhook-pg.test.ts`'s.
 *
 * ## The two vacuity traps carried forward from #4917
 *
 *   1. **A naive `asOf` assertion is vacuous by default.** The extraction schema
 *      carries no `validFrom`, so every fact here lands with `valid_from NULL`
 *      and #4916 admits an unrecorded start at ANY instant. A point read
 *      therefore only bites if it brackets a stamp the GATE actually wrote —
 *      which is why this file defines no `AS_OF` constant at all and reads only
 *      at `loser.valid_to ± 1ms` (step 5).
 *   2. **Equality at the half-open bound is unreachable through the API.**
 *      `timestamptz` keeps microseconds; `parseBrainAsOf` round-trips through a
 *      JS `Date` and can only bind milliseconds, so an `asOf` built from
 *      `valid_to.toISOString()` is the stamp TRUNCATED — strictly less than it.
 *      ±1ms is exact regardless. (`search-pg.test.ts` pins the equality
 *      semantics directly, against rows whose bounds it controls.)
 *
 * ## Mutation verification
 *
 * A green multi-source e2e that passes against a broken reconcile is worse than
 * none, so every assertion here was seen RED against a mutation that genuinely
 * REMOVES the behaviour it claims — never against an added no-op, which is the
 * shape that makes a survivor look like a test gap. 31 mutations, each reverted:
 *
 *   - **corroboration** — the lookup disabled outright; the lookup scoped to one
 *     class (`provenance->>'source' = 'outlook'`, i.e. corroboration that only
 *     works WITHIN a class — the exact cross-class regression); the provenance
 *     edge never written; `corroborationCount` collapsed to 1. The row TOTAL and
 *     the cycle counters were each verified separately, with the other lifted.
 *   - **grants and widening** — the fact grant not copied from its episode; the
 *     stored EPISODE grant collapsed to `[org]`;
 *     `deriveMeetingParticipantGrant` given a public arm (the leak `grant.ts`'s
 *     three-function design exists to make unspellable); `widenGrantFromEvidence`
 *     disabled, and separately OVER-applied so the `pre_widening` negatives had
 *     to catch it; `attributionDecision` forced to `disclose`.
 *   - **ACL** — the grant-overlap predicate removed (workspace-only, the leak
 *     direction); audience tokens dropped from the reader's principal set; the
 *     EPISODE query's overlap neutered on its own, which is what pins the tier-3
 *     clause separately from the fact one; the staleness flag forced false, which
 *     is what proves the freshness PREMISE is doing work rather than decorating.
 *   - **contradiction** — the `in-tension-with` edge never written; the withheld
 *     aggregate silently dropped; the counterpart projection collapsed onto one
 *     class, and the review queue's OWN projection collapsed separately (they are
 *     different code paths and only two mutations tell them apart).
 *   - **arbitration and time** — the supersession collision never matching; the
 *     supersede stamp writing no `valid_to`, which is what falsifies the
 *     grant-blind arm; the `asOf` upper-bound predicate removed, which is the
 *     mutation the ±1ms bracket exists for and the only one it catches.
 *   - **extraction lag** — the label hard-coded `complete`, and separately
 *     hard-coded `pending` so the settled-episode control had to catch it; the
 *     episode read filtered to `extracted_at IS NOT NULL`, i.e. §T7's claim
 *     inverted into a blocked read; the meeting audience id made
 *     non-per-meeting, which collapses the two meetings onto one token.
 *   - **source identity** — `outlookEpisodeSourceId` made unstable across passes,
 *     which the `duplicate` counts and the episode lookups catch together;
 *     `messageParticipants` dropping the sender, which is what falsifies the
 *     email lower-bound equality.
 *
 * ⚠️ **One assertion has no faithful mutation, and it is recorded rather than
 * quietly dropped**: "the same call still served the facts" (step 9). It pins the
 * ABSENCE of a degradation path — there is no code today that suppresses the fact
 * list when an episode is queued, so there is nothing to remove, and the only way
 * to make it fail would be to ADD that path, which is precisely the unfaithful
 * mutation this section refuses elsewhere. It is a regression guard for a future
 * change, not a claim about a behaviour under test, and it should be read that
 * way. Its neighbours in the same step — the label, the ACL negative, the settled
 * control — are all mutation-verified.
 *
 * Two further assertions are COMPOSITION guards rather than separately mutatable
 * claims, and are called out so nobody hunts for a mutation that cannot exist:
 * the `asOf` reads' per-class isolation (step 8) and the review queue's
 * counterpart class (step 6) each ride a predicate that another assertion already
 * pins — the shared ACL clause and the shared counterpart projection. Mutating
 * either kills the earlier assertion first, by construction. They earn their
 * place by asserting that the composition holds, which is where a future change
 * would break it: an `asOf` branch that rebuilt its own predicate, or a queue
 * that grew its own counterpart projection.
 *
 * Opt in locally with:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { Pool } from "pg";
import { MockLanguageModelV3 } from "ai/test";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS, _resetPool } from "@atlas/api/lib/db/internal";
import { syncBrainEpisodeSource } from "@atlas/api/lib/brain/ingest/episode-sync";
import {
  _resetBrainExtractionFailures,
  llmFactExtractor,
  runBrainExtractionCycle,
  type ResolvedExtractionModel,
} from "@atlas/api/lib/brain/extract";
import { promoteBrainFacts } from "@atlas/api/lib/content-mode/adapters/brain-facts";
import { searchBrainCore } from "@atlas/api/lib/brain/search";
import { loadFactCandidates } from "@atlas/api/lib/brain/candidates";
import { createSlackHistoryClient, type SlackHistoryApi } from "@atlas/api/lib/brain/ingest/slack/client";
import { getChatBackfillWindowMs } from "@atlas/api/lib/brain/ingest/slack/connector";
import { SLACK_HISTORY_SOURCE } from "@atlas/api/lib/brain/ingest/slack/config";
import { createZoomTranscriptClient } from "@atlas/api/lib/brain/ingest/zoom/client";
import {
  ZOOM_TRANSCRIPT_SOURCE,
  zoomEpisodeSourceId,
} from "@atlas/api/lib/brain/ingest/zoom/config";
import {
  createZoomAudienceReverifier,
  type ZoomAudienceDeps,
} from "@atlas/api/lib/brain/ingest/zoom/audience";
import type { ZoomParticipant, ZoomRecordingMeeting } from "@atlas/api/lib/brain/ingest/zoom/api";
import { createOutlookMailClient } from "@atlas/api/lib/brain/ingest/outlook/client";
import {
  OUTLOOK_MAIL_SOURCE,
  outlookEpisodeSourceId,
} from "@atlas/api/lib/brain/ingest/outlook/config";
import {
  createOutlookAudienceReverifier,
  messageParticipants,
  type OutlookAudienceDeps,
} from "@atlas/api/lib/brain/ingest/outlook/audience";
import type { OutlookMessage } from "@atlas/api/lib/brain/ingest/outlook/api";
import {
  emailMessageAudienceId,
  emailParticipantsDigest,
  meetingAudienceId,
} from "@atlas/api/lib/brain/ingest/grant";
import { resolvePrincipals } from "@atlas/api/lib/brain/audience/resolver";
import { reconcileAudienceMembership } from "@atlas/api/lib/brain/audience/membership";
import type { SlackHistoryMessage } from "@atlas/api/lib/slack/api";
import {
  AUDIENCE_MEMBERSHIP_SQL,
  AUDIENCE_PREFIX,
  getAudienceMaxStalenessSeconds,
  resolvePrincipalContext,
  type BrainPrincipalContext,
} from "@atlas/api/lib/brain/acl";
import type { BrainSourceConnector } from "@atlas/api/lib/brain/ingest/types";
import type { BrainEdgeType, PredicateCardinality } from "@atlas/api/lib/brain/types";
import type { AtlasMode } from "@useatlas/types/auth";
import type {
  BrainEpisodeResult,
  BrainFactResult,
  BrainFactReviewStatus,
  BrainSearchResult,
} from "@useatlas/types";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 90_000;

const WORKSPACE = "ws-brain-multisource";

// ── the three installs ──────────────────────────────────────────────────────

const SLACK_INSTALL = "slack-history-multisource";
const ZOOM_INSTALL = "zoom-transcripts-multisource";
const OUTLOOK_INSTALL = "outlook-mail-multisource";

/** The one PUBLIC chat channel — `isPrivate: false` resolves to `['org']`. */
const ALL_HANDS_CHANNEL = "C0ALLHANDS";

const MEETING_ALPHA_UUID = "4kd8sZTiSHagYbwYtLpMRA==";
const MEETING_ALPHA_FILE = "a7f3c1e2-4b5d-6789-0abc-def123456789";
/** The meeting that lands AFTER the last extraction cycle — the lag window. */
const MEETING_LATE_UUID = "9pQ2xVbnTiaZcWwYtLpMRA==";
const MEETING_LATE_FILE = "c3d5e7f9-1b2d-4568-9abc-de1234567890";

const ZOOM_HOST_ID = "zoom-host-ops";
const MAILBOX_UPN = "ops@multisource.test";
/** Graph's user OBJECT ID for that mailbox — what the audience token carries. */
const MAILBOX_OBJECT_ID = "6f1c9a24";

/**
 * The injected clock. MUTABLE, and load-bearing twice. `T0` is the day
 * everything lands; `T1` is the next day, when the contradicting mail and the
 * late meeting arrive.
 *
 * Against the REAL clock every backfill floor would exclude every fixture
 * record — the reason `wedge-loop-pg.test.ts` injects one at all. What the MOVE
 * buys is the second half: the Zoom walk only enumerates day windows up to
 * `toZoomDate(now())`, so a meeting recorded after `T0` is unreachable until the
 * clock reaches it. Staging a future-dated meeting instead would have got the
 * same rows in while quietly making the walk's own upper bound untested.
 */
const T0 = new Date("2026-07-15T12:00:00.000Z");
const T1 = new Date("2026-07-16T12:00:00.000Z");
let clockAt: Date = T0;
const CLOCK = () => clockAt;

// ── the people ──────────────────────────────────────────────────────────────

/**
 * Four readers, chosen so that every pair differs in exactly one grant.
 *
 * `mallory` is the fail-closed control and is deliberately in NO vendor roster:
 * she exists so that "this reader saw nothing" can be distinguished from "this
 * read is broken", which is the whole difficulty of asserting an ACL negative.
 */
const USERS = [
  { id: "user-admin", email: "admin@multisource.test", role: "admin" as const },
  { id: "user-ada", email: "ada@multisource.test", role: "member" as const },
  { id: "user-bo", email: "bo@multisource.test", role: "member" as const },
  { id: "user-mallory", email: "mallory@multisource.test", role: "member" as const },
] as const;

const EMAIL_OF = Object.fromEntries(USERS.map((u) => [u.id, u.email])) as Record<string, string>;

// ── the vendor fixtures ─────────────────────────────────────────────────────

/**
 * Markers, one per EPISODE.
 *
 * Extraction is keyed on these rather than on the claim sentences, and that is
 * not cosmetic: the transcript body carries THREE claims, so a fixture keyed on
 * a claim sentence would match the first one and silently turn a three-candidate
 * episode into a one-candidate one. One marker per episode, present in exactly
 * one body, keeps the mapping total and unambiguous.
 */
const MARKER = {
  opsReview: "welcome to the weekly ops review",
  pricingRecap: "recapping what we agreed on pricing",
  deployChange: "we are moving the deploy window",
  officeMove: "the office move lands in June",
  lateStandup: "the incident postmortem is on the agenda",
} as const;

const ALPHA_VTT = `WEBVTT

1
00:00:01.000 --> 00:00:04.000
Ada Lovelace: ${MARKER.opsReview}

2
00:00:05.000 --> 00:00:09.000
Ada Lovelace: the Q3 revenue target is 4.2 million and the deploy window is Thursdays

3
00:00:10.000 --> 00:00:14.000
Grace Hopper: the hiring plan is frozen until the target lands
`;

const LATE_VTT = `WEBVTT

1
00:00:01.000 --> 00:00:04.000
Alan Turing: ${MARKER.lateStandup}
`;

function address(addr: string) {
  return { address: addr, name: null };
}

function outlookMessage(overrides: Partial<OutlookMessage> & { internetMessageId: string }): OutlookMessage {
  return {
    graphId: "AAMkAG-fixture",
    subject: null,
    receivedDateTime: null,
    from: null,
    toRecipients: [],
    ccRecipients: [],
    headersComplete: true,
    bodyUnreadable: false,
    bodyText: null,
    ...overrides,
  };
}

/**
 * The mail that CORROBORATES the transcript.
 *
 * ⚠️ In the fixture's narrative `ada` is BCC'd on this message — she was in the
 * meeting and is copied on the recap. She is absent from the fields below
 * because `OutlookMessage` has no bcc field to put her in: #4966's posture is
 * structural, not merely intended. Her absence from this message's audience is
 * asserted directly in step 3, and it is the LOWER BOUND being pinned, not a
 * gap in the fixture.
 */
const MSG_CORROBORATE = outlookMessage({
  internetMessageId: "<recap-q3@multisource.test>",
  subject: "Q3 pricing recap",
  receivedDateTime: "2026-07-14T16:00:00Z",
  from: address(EMAIL_OF["user-admin"]),
  toRecipients: [address(EMAIL_OF["user-bo"])],
  bodyText: `${MARKER.pricingRecap}: the Q3 revenue target is 4.2 million, and the vendor contract renews in March.`,
});

/** The mail that CONTRADICTS the transcript — a day later, a different audience. */
const MSG_RIVAL = outlookMessage({
  internetMessageId: "<deploy-window-change@multisource.test>",
  subject: "deploy window change",
  receivedDateTime: "2026-07-16T09:00:00Z",
  from: address(EMAIL_OF["user-bo"]),
  toRecipients: [address(EMAIL_OF["user-admin"])],
  bodyText: `${MARKER.deployChange} to Fridays, starting this week.`,
});

/** 2026-07-14T10:00:00Z, as a Slack ts. */
const ALL_HANDS_MESSAGE: SlackHistoryMessage = {
  ts: "1784023200.000100",
  text: MARKER.officeMove,
  user: "U_ADA",
  subtype: null,
  botId: null,
};

const ALPHA_ROSTER: readonly ZoomParticipant[] = [
  { email: EMAIL_OF["user-admin"], name: "Admin", userId: "Z_ADMIN" },
  { email: EMAIL_OF["user-ada"], name: "Ada Lovelace", userId: "Z_ADA" },
  // An external guest: a well-established audience that this participant is not
  // in. The FLAG side of #4965's asymmetry — it must not block the meeting.
  { email: "guest@vendor.test", name: "External Guest", userId: "Z_GUEST" },
];

/** The late meeting's roster is a STRICT SUBSET, so the lag arm has an ACL negative. */
const LATE_ROSTER: readonly ZoomParticipant[] = [
  { email: EMAIL_OF["user-admin"], name: "Admin", userId: "Z_ADMIN" },
];

function meeting(
  uuid: string,
  fileId: string,
  startTime: string,
): ZoomRecordingMeeting {
  return {
    uuid,
    topic: "ops",
    hostId: ZOOM_HOST_ID,
    startTime,
    files: [
      { id: fileId, fileType: "TRANSCRIPT", downloadUrl: `https://zoom.us/rec/${fileId}`, fileSize: 512 },
      { id: `${fileId}-mp4`, fileType: "MP4", downloadUrl: `https://zoom.us/rec/${fileId}v`, fileSize: 99 },
    ],
  };
}

const MEETING_ALPHA = meeting(MEETING_ALPHA_UUID, MEETING_ALPHA_FILE, "2026-07-14T15:00:00Z");
const MEETING_LATE = meeting(MEETING_LATE_UUID, MEETING_LATE_FILE, "2026-07-16T10:00:00Z");

const VTT_BY_FILE: Readonly<Record<string, string>> = {
  [MEETING_ALPHA_FILE]: ALPHA_VTT,
  [MEETING_LATE_FILE]: LATE_VTT,
};
const ROSTER_BY_MEETING: Readonly<Record<string, readonly ZoomParticipant[]>> = {
  [MEETING_ALPHA_UUID]: ALPHA_ROSTER,
  [MEETING_LATE_UUID]: LATE_ROSTER,
};

// ── the grant tokens, built through the production id helpers ───────────────

/**
 * Named throw rather than `!` or `??`: every one of these builders returns
 * `null` on an id it refuses, and a silent `""` here would produce a token that
 * matches nothing and turn every ACL assertion below into a tautology.
 */
function requireAudienceId(built: string | null, what: string): string {
  if (built === null) {
    throw new Error(`fixture: the production id helper refused to build ${what}`);
  }
  return built;
}

const MEETING_ALPHA_AUDIENCE = requireAudienceId(
  meetingAudienceId(ZOOM_TRANSCRIPT_SOURCE, MEETING_ALPHA_UUID),
  `the audience id for meeting ${MEETING_ALPHA_UUID}`,
);
const MEETING_LATE_AUDIENCE = requireAudienceId(
  meetingAudienceId(ZOOM_TRANSCRIPT_SOURCE, MEETING_LATE_UUID),
  `the audience id for meeting ${MEETING_LATE_UUID}`,
);

/**
 * An email audience id, derived the way the connector derives it — through
 * `messageParticipants` (the real From+To+Cc walk) and `emailParticipantsDigest`
 * (the real digest). Spelling the digest by hand would pin a constant rather
 * than the derivation, and the digest is the anti-forgery half of the id.
 */
function emailAudienceFor(message: OutlookMessage, label: string): string {
  const messageId = message.internetMessageId?.replace(/^<|>$/g, "") ?? "";
  return requireAudienceId(
    emailMessageAudienceId(
      OUTLOOK_MAIL_SOURCE,
      MAILBOX_OBJECT_ID,
      emailParticipantsDigest(messageParticipants(message).map((p) => p.address)),
      messageId,
    ),
    `the audience id for ${label}`,
  );
}

const RECAP_AUDIENCE = emailAudienceFor(MSG_CORROBORATE, "the Q3 recap mail");
const RIVAL_AUDIENCE = emailAudienceFor(MSG_RIVAL, "the deploy-window-change mail");

const token = (audienceId: string) => `${AUDIENCE_PREFIX}${audienceId}`;
const MEETING_ALPHA_GRANT = token(MEETING_ALPHA_AUDIENCE);
const MEETING_LATE_GRANT = token(MEETING_LATE_AUDIENCE);
const RECAP_GRANT = token(RECAP_AUDIENCE);
const RIVAL_GRANT = token(RIVAL_AUDIENCE);

// ── what the model "extracts" ───────────────────────────────────────────────

type Candidate = {
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  /**
   * The SSOT union, never hand-listed — `extract.ts`'s `ExtractionSchema`
   * derives the same arm list from `PREDICATE_CARDINALITIES`, and this fixture
   * feeds the REAL `generateObject` parse.
   */
  readonly cardinality: PredicateCardinality;
};

/**
 * The claim asserted in BOTH classes — ONE object, referenced twice.
 *
 * Deliberately a shared constant rather than two literals: corroboration matches
 * on subject+predicate+object exactly, so two hand-spelled copies would drift on
 * the first edit and the file's flagship assertion would silently become "two
 * unrelated facts were created", which is also what a BROKEN corroboration looks
 * like. One binding makes the two observations the same claim by construction.
 */
const CORROBORATED_CLAIM: Candidate = {
  subject: "Q3 revenue target",
  predicate: "is",
  object: "4.2 million",
  cardinality: "multi",
};

/**
 * Keys are COMPUTED from `MARKER`, so editing a marker moves both sides in
 * lockstep, and the `Partial<Record<…>>` type makes a hand-spelled key matching
 * no marker a COMPILE error — which would otherwise turn that episode into the
 * silent empty arm.
 *
 * Both deploy-window claims are `single`: that cardinality, on BOTH sides, is
 * what arms the tension pass and the gate's supersession collision.
 */
const EXTRACTIONS: Partial<Record<(typeof MARKER)[keyof typeof MARKER], readonly Candidate[]>> = {
  [MARKER.opsReview]: [
    CORROBORATED_CLAIM,
    { subject: "deploy window", predicate: "is", object: "Thursdays", cardinality: "single" },
    { subject: "hiring plan", predicate: "is", object: "frozen", cardinality: "multi" },
  ],
  [MARKER.pricingRecap]: [
    CORROBORATED_CLAIM,
    { subject: "vendor contract", predicate: "renews", object: "March", cardinality: "multi" },
  ],
  [MARKER.deployChange]: [
    { subject: "deploy window", predicate: "is", object: "Fridays", cardinality: "single" },
  ],
  [MARKER.officeMove]: [
    { subject: "office move", predicate: "is", object: "June", cardinality: "multi" },
  ],
};

type FactRow = {
  readonly id: string;
  readonly subject: string;
  readonly object: string;
  readonly status: BrainFactReviewStatus;
  readonly predicate_cardinality: PredicateCardinality;
  readonly visible_to: readonly string[];
  readonly pre_widening_visible_to: readonly string[] | null;
  readonly valid_from: Date | null;
  readonly valid_to: Date | null;
  readonly invalidated_at: Date | null;
  readonly provenance: Record<string, unknown>;
};

describeIfPg("brain M3 multi-source loop (real Postgres)", () => {
  let pool: Pool;
  let priorDatabaseUrl: string | undefined;
  const schemaName = `brain_4968_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  /** Markers the model was asked about — the "was the seam even exercised" pin. */
  let modelCalls: string[] = [];
  /** Meetings Zoom answers with this pass. The late one is staged mid-test. */
  let zoomMeetings: readonly ZoomRecordingMeeting[] = [];
  /** Messages Graph answers with this pass. The rival is staged mid-test. */
  let outlookMessages: readonly OutlookMessage[] = [];

  const mockModel = new MockLanguageModelV3({
    doGenerate: async (options) => {
      const prompt = JSON.stringify(options.prompt);
      const marker = (Object.keys(EXTRACTIONS) as (keyof typeof EXTRACTIONS)[]).find((candidate) =>
        prompt.includes(candidate),
      );
      modelCalls.push(marker ?? "(no match)");
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ facts: marker ? EXTRACTIONS[marker] : [] }) },
        ],
        finishReason: { unified: "stop" as const, raw: "end_turn" },
        usage: {
          inputTokens: { total: 50, noCache: 50, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 30, text: 30, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });

  const EXTRACTION_MODEL = {
    model: mockModel,
    modelId: "mock-extractor",
  } satisfies ResolvedExtractionModel;

  beforeAll(async () => {
    // `hasInternalDB()` reads `DATABASE_URL`, not the pool — without this the
    // extraction cycle takes its "no database" path. Set inside the hook per the
    // test-discipline rule; restored in `afterAll`.
    priorDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = TEST_DB_URL;
    pool = new Pool({
      connectionString: TEST_DB_URL,
      options: `-c search_path="${schemaName}",public`,
    });
    const bootstrap = new Pool({ connectionString: TEST_DB_URL });
    try {
      await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    } finally {
      await bootstrap.end();
    }
    await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });
    // Better-Auth-owned tables, stubbed for `wedge-loop-pg.test.ts`'s reasons:
    // `organization` feeds the tier-cap lookup (missing TABLE fails closed and
    // aborts the sync; missing ROW is the self-hosted "no tier cap" arm), and
    // `"user"` + `member` feed the audience resolution every connector performs.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS organization (
        id TEXT PRIMARY KEY,
        name TEXT,
        slug TEXT,
        workspace_status TEXT,
        plan_tier TEXT,
        byot BOOLEAN,
        "stripeCustomerId" TEXT,
        trial_ends_at TIMESTAMPTZ,
        suspended_at TIMESTAMPTZ,
        suspension_source TEXT,
        plan_override_until TIMESTAMPTZ,
        deleted_at TIMESTAMPTZ,
        region TEXT,
        region_assigned_at TIMESTAMPTZ,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "user" (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS member (
        id TEXT PRIMARY KEY,
        "organizationId" TEXT NOT NULL,
        "userId" TEXT NOT NULL,
        role TEXT
      )
    `);
    for (const user of USERS) {
      await pool.query(
        `INSERT INTO "user" (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
        [user.id, user.email],
      );
      await pool.query(
        `INSERT INTO member (id, "organizationId", "userId", role)
         VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
        [`m-${user.id}`, WORKSPACE, user.id, user.role],
      );
    }
    // The ingest/extraction/promotion stages write through the module-level
    // pool, so it has to BE this schema-scoped one.
    _resetPool(pool);
  }, PG_TEST_TIMEOUT_MS);

  afterAll(async () => {
    _resetPool(null);
    if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDatabaseUrl;
    if (pool) {
      // `DROP SCHEMA … CASCADE` over a fully-migrated schema is slow under a
      // loaded runner, and a lingering lock can make it throw outright. The
      // `finally` covers the THROW: `pool.end()` still runs, so a failed drop
      // leaks only the schema and not the pool's open handles, which would keep
      // the bun process alive.
      let dropErr: Error | undefined;
      try {
        await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      } catch (err) {
        dropErr = err instanceof Error ? err : new Error(String(err));
      } finally {
        await pool.end();
      }
      if (dropErr !== undefined) {
        // Thrown, not logged: `scripts/test-isolated.ts` prints a file's captured
        // output ONLY on a non-zero exit, so a `console.debug` here would be
        // discarded in precisely the case it exists to report — a green run that
        // leaked a schema into a shared test database.
        throw new Error(
          `afterAll(): DROP SCHEMA "${schemaName}" failed — scratch schema leaked, drop it by hand: ${dropErr.message}`,
        );
      }
    }
  }, PG_TEST_TIMEOUT_MS);

  afterEach(async () => {
    // One atomic statement + a `finally` reset, for `wedge-loop-pg.test.ts`'s
    // reason: a part-way failure must not cascade into the next test.
    // `brain_audience_reverify_attempt` (0186) is in the list even though this
    // suite never writes it — the emptiness assertion in step 3 is only a
    // premise if nothing can carry a row in from a previous test.
    try {
      await pool.query(
        `TRUNCATE brain_edges, brain_facts, brain_episodes, fact_audience_member,
                  brain_audience_reverify_attempt, knowledge_sync_state, admin_action_log`,
      );
    } finally {
      _resetBrainExtractionFailures();
      modelCalls = [];
      zoomMeetings = [];
      outlookMessages = [];
      clockAt = T0;
    }
  });

  // ── shared DB seams ─────────────────────────────────────────────────────

  const poolQuery = async <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]> => {
    const { rows } = await pool.query(sql, params);
    return rows as T[];
  };

  const poolTransaction = async <T>(
    fn: (tx: { query: (sql: string, params?: unknown[]) => Promise<{ rows: readonly unknown[] }> }) => Promise<T>,
  ): Promise<T> => {
    const client = await pool.connect();
    // `undefined` ⇒ safe to recycle; set ⇒ destroy on release. One binding
    // rather than a boolean plus a discarded error, so the reason the client is
    // being destroyed is the ROLLBACK failure that actually poisoned it.
    let destroyReason: Error | undefined;
    try {
      await client.query("BEGIN");
      const out = await fn({
        query: async (sql, params) => {
          const res = await client.query(sql, params);
          return { rows: res.rows as readonly unknown[] };
        },
      });
      await client.query("COMMIT");
      return out;
    } catch (err) {
      // Surfaced, not swallowed, and NARROWED: a failed rollback would otherwise
      // present as the ORIGINAL error over a silently poisoned connection.
      await client.query("ROLLBACK").catch((rbErr: unknown) => {
        destroyReason = rbErr instanceof Error ? rbErr : new Error(String(rbErr));
        console.debug("poolTransaction(): ROLLBACK failed after a fixture transaction error", destroyReason.message);
      });
      throw err;
    } finally {
      // In a `finally` so EVERY path releases exactly once. A client that never
      // returns to the pool makes `afterEach`'s TRUNCATE block until the hook
      // times out, reporting a hook timeout instead of the reconcile error that
      // actually happened.
      client.release(destroyReason);
    }
  };

  /**
   * The audience half every connector shares — the REAL resolver and the REAL
   * membership reconcile, against the scratch schema.
   *
   * This is the single most load-bearing piece of fixture discipline in the
   * file: every ACL assertion below is a claim about rows these two production
   * functions wrote, not about rows the test INSERTed.
   */
  const audienceDbDeps = {
    resolve: (workspaceId: string, principals: Parameters<typeof resolvePrincipals>[1]) =>
      resolvePrincipals(workspaceId, principals, { query: poolQuery }),
    reconcile: (input: Parameters<typeof reconcileAudienceMembership>[0]) =>
      reconcileAudienceMembership(input, { withTransaction: poolTransaction }),
  };

  // ── the three connector shims ───────────────────────────────────────────

  const slackApi: SlackHistoryApi = {
    getConversationInfo: (_token, channelId) =>
      Promise.resolve({
        ok: true as const,
        channel: {
          id: channelId,
          name: channelId.toLowerCase(),
          // The one public channel in the fixture — this is what makes the org
          // arm of `deriveChatChannelGrant` reachable, and the org arm is the
          // positive control every ACL negative below is measured against.
          isPrivate: false,
          isMember: true,
          isArchived: false,
        },
      }),
    fetchConversationHistoryPage: (_token, params) => {
      if (params.channel !== ALL_HANDS_CHANNEL) {
        return Promise.resolve({ ok: false as const, error: "channel_not_found" as const, retryAfterSeconds: null });
      }
      const oldest = params.oldest === undefined ? null : Number(params.oldest);
      if (oldest !== null && Number.isNaN(oldest)) {
        throw new Error(`fixture: non-numeric oldest bound ${params.oldest} — the Slack-ts format changed`);
      }
      const messages =
        oldest === null || Number(ALL_HANDS_MESSAGE.ts) > oldest ? [ALL_HANDS_MESSAGE] : [];
      return Promise.resolve({ ok: true as const, messages, nextCursor: null, dropped: 0 });
    },
  };

  const slackConnector: BrainSourceConnector<typeof SLACK_HISTORY_SOURCE> = {
    catalogId: "slack-history-multisource-test",
    source: SLACK_HISTORY_SOURCE,
    // Channel-scoped grants, reconciled by the Slack-scoped walk in
    // `audience/sync.ts` rather than by a registered re-verifier.
    audience: { kind: "externally-synced" },
    createClient: () =>
      createSlackHistoryClient({
        token: "xoxb-test",
        channels: [ALL_HANDS_CHANNEL],
        backfillWindowMs: getChatBackfillWindowMs(),
        api: slackApi,
        now: CLOCK,
      }),
  };

  /**
   * Zoom's recordings surface, WINDOW-AWARE.
   *
   * The client walks `[from, to]` day ranges and may issue several per pass, so
   * a fixture that answered every window with the same page would hand the same
   * meeting back two or three times and the `batchDuplicate` counter — the
   * ingest core's silent-drop-prevention signal — would carry the fixture's
   * defect rather than the code's. Filtering on the meeting's own date is also
   * what makes the second pass's `inserted: 1, duplicate: 0` a statement about
   * the CURSOR rather than about dedupe.
   */
  const zoomAudienceDeps: ZoomAudienceDeps = {
    ...audienceDbDeps,
    fetchParticipantsPage: (_token, meetingUuid) => {
      const roster = ROSTER_BY_MEETING[meetingUuid];
      if (roster === undefined) {
        return Promise.resolve({ ok: false as const, error: "not_found" as const, retryAfterSeconds: null });
      }
      return Promise.resolve({ ok: true as const, participants: roster, nextPageToken: null });
    },
  };

  const zoomConnector: BrainSourceConnector<typeof ZOOM_TRANSCRIPT_SOURCE> = {
    catalogId: "zoom-transcripts-multisource-test",
    source: ZOOM_TRANSCRIPT_SOURCE,
    // A transcript audience is derived per meeting, so the type admits no arm
    // but this one. NEVER DRIVEN here: this connector goes to `syncSource` and
    // never to `registerBrainSourceConnector`, and the suite asserts
    // `brain_audience_reverify_attempt` stays EMPTY (see the module header —
    // #4971's scan is out of scope for this file). `zoomAudienceDeps` carries no
    // `resolveToken` for the same reason. The arm is stated so the fixture is
    // honest about what production registers, not because it runs.
    audience: { kind: "reverified", reverifier: createZoomAudienceReverifier(zoomAudienceDeps) },
    createClient: () =>
      createZoomTranscriptClient({
        workspaceId: WORKSPACE,
        accountId: "acct-multisource",
        // Empty means the whole account — the fixture's meetings all share one
        // host, so a host filter would only add a way to get the fixture wrong.
        hosts: [],
        backfillWindowMs: 30 * 86_400_000,
        resolveToken: () => Promise.resolve("zoom-token"),
        now: CLOCK,
        audienceDeps: zoomAudienceDeps,
        api: {
          fetchAccountRecordingsPage: (_token, params) => {
            const meetings = zoomMeetings.filter((m) => {
              if (m.startTime === null) return false;
              const day = m.startTime.slice(0, 10);
              return day >= params.from && day <= params.to;
            });
            return Promise.resolve({ ok: true as const, meetings, nextPageToken: null, dropped: 0 });
          },
          fetchTranscriptText: (_token, url) => {
            const fileId = url.slice(url.lastIndexOf("/") + 1);
            const vtt = VTT_BY_FILE[fileId];
            if (vtt === undefined) {
              throw new Error(`fixture: no VTT staged for recording file ${fileId}`);
            }
            return Promise.resolve({ ok: true as const, text: vtt });
          },
        },
      }),
  };

  const outlookAudienceDeps: OutlookAudienceDeps = { ...audienceDbDeps };

  const outlookConnector: BrainSourceConnector<typeof OUTLOOK_MAIL_SOURCE> = {
    catalogId: "outlook-mail-multisource-test",
    source: OUTLOOK_MAIL_SOURCE,
    // Same as Zoom above: a mail audience is derived per message, so the type
    // admits no other arm — and this one is equally never driven.
    audience: {
      kind: "reverified",
      reverifier: createOutlookAudienceReverifier(outlookAudienceDeps),
    },
    createClient: () =>
      createOutlookMailClient({
        workspaceId: WORKSPACE,
        mailboxes: [MAILBOX_UPN],
        backfillWindowMs: 30 * 86_400_000,
        resolveToken: () => Promise.resolve("graph-token"),
        now: CLOCK,
        audienceDeps: outlookAudienceDeps,
        api: {
          fetchMailbox: () =>
            Promise.resolve({
              ok: true as const,
              mailbox: { id: MAILBOX_OBJECT_ID, userPrincipalName: MAILBOX_UPN, mail: MAILBOX_UPN },
            }),
          // `$filter` is `receivedDateTime ge since`, so the fixture compares
          // INSTANTS rather than strings: `since` arrives with millisecond
          // precision and the fixture's timestamps do not, and a lexical
          // comparison of the two happens to work today for reasons no reader
          // should have to verify. A `NaN` is a loud throw for the same reason
          // the Slack `oldest` guard is — a silently-unfiltered page would make
          // every duplicate count below meaningless.
          fetchMailboxMessagesPage: (_token, params) => {
            const since = Date.parse(params.since);
            if (Number.isNaN(since)) {
              throw new Error(`fixture: unparseable since bound ${params.since} — the Graph filter format changed`);
            }
            const messages = outlookMessages.filter((m) => {
              if (m.receivedDateTime === null) return false;
              const at = Date.parse(m.receivedDateTime);
              if (Number.isNaN(at)) {
                throw new Error(`fixture: unparseable receivedDateTime ${m.receivedDateTime}`);
              }
              return at >= since;
            });
            return Promise.resolve({ ok: true as const, messages, nextLink: null, dropped: 0 });
          },
          fetchMailboxMessagesNextPage: () => {
            throw new Error("fixture: the walk paged, but every fixture page is the last one");
          },
        },
      }),
  };

  // ── stage drivers ───────────────────────────────────────────────────────

  /** `syncBrainEpisodeSource` never throws — the outcome is asserted here once. */
  async function syncSource(connector: BrainSourceConnector, installId: string) {
    const outcome = await syncBrainEpisodeSource({
      connector,
      workspaceId: WORKSPACE,
      installId,
      config: null,
      now: CLOCK,
    });
    expect(outcome).toMatchObject({
      status: "success",
      error: null,
      coverageIncomplete: false,
      warnings: [],
    });
    // The CURSOR-LESS premise, and it is load-bearing for every `duplicate`
    // count below rather than decoration. With no install row,
    // `upsertConnectorSyncState` silently no-ops, so `knowledge_sync_state` stays
    // empty and EVERY pass reads a null cursor and a null high-water mark: each
    // source re-walks its whole backfill window and re-offers records it has
    // already stored, which the source-id dedupe absorbs. Both counts are
    // asserted because they fail independently — an install row would restore
    // the cursor, a state row alone would restore the mark — and either would
    // silently rewrite what the numbers in this file mean.
    const { rows: premise } = await pool.query<{ installs: string; state: string }>(
      `SELECT (SELECT count(*)::text FROM workspace_plugins
                WHERE workspace_id = $1 AND install_id = $2) AS installs,
              (SELECT count(*)::text FROM knowledge_sync_state
                WHERE workspace_id = $1) AS state`,
      [WORKSPACE, installId],
    );
    expect(premise[0]).toEqual({ installs: "0", state: "0" });
    return outcome;
  }

  /** The extraction fiber, driving the real `llmFactExtractor`. */
  async function extract() {
    // Scoped to the CYCLE, not the suite: this loop drives `extract()` three
    // times, and a suite-lifetime recorder would let a later call's assertion
    // pass on an earlier call's entry.
    const resolveModelCalls: string[] = [];
    const cycle = await Effect.runPromise(
      runBrainExtractionCycle({
        extract: llmFactExtractor,
        // RECORDED here, ASSERTED below — never `expect`-ed inside the callback.
        // The per-episode apply runs under `Effect.tryPromise`, which converts
        // any throw into a counted `failed` outcome, so an `expect` here would
        // be diverted into a scrubbed `log.warn` line and never reach the test's
        // failure diff.
        resolveModel: async (workspaceId) => {
          resolveModelCalls.push(workspaceId);
          return EXTRACTION_MODEL;
        },
      }),
    );
    expect(cycle).toMatchObject({
      status: "success",
      failed: 0,
      blockedEpisodes: 0,
      factsBlocked: 0,
      outageRefunded: 0,
    });
    expect(cycle.skipped).toEqual({ model_unavailable: 0, no_body: 0, quarantined: 0 });
    // WHICH workspace and HOW MANY times, in one assertion: the cycle must
    // resolve for the EPISODE's workspace, exactly once, because `modelFor`
    // memoizes per workspace per cycle. Keyed off `inspected` so a cycle that
    // drained nothing is not blamed on model resolution.
    expect(resolveModelCalls).toEqual(cycle.inspected > 0 ? [WORKSPACE] : []);
    return cycle;
  }

  /** The review gate, in a transaction, as `/admin/publish` runs it. */
  async function publish() {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const report = await Effect.runPromise(promoteBrainFacts(client, WORKSPACE));
      await client.query("COMMIT");
      client.release();
      return report;
    } catch (err) {
      await client.query("ROLLBACK").catch((rollbackErr: unknown) => {
        console.debug(
          "publish(): ROLLBACK failed after a promote error",
          rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
        );
      });
      // Destroyed, not recycled — a client with an open transaction holds the
      // `FOR UPDATE` locks and would block `afterEach`'s TRUNCATE.
      client.release(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  /** The fused read. `asOf` present ⇒ the bi-temporal point read (#4916). */
  function search(
    ctx: BrainPrincipalContext,
    options: { mode?: AtlasMode; query?: string; asOf?: string } = {},
  ) {
    return searchBrainCore(pool, {
      ctx,
      mode: options.mode ?? "published",
      query: options.query,
      include: ["fact", "raw-episode"],
      expand: false,
      limit: 50,
      ...(options.asOf !== undefined ? { asOf: options.asOf } : {}),
    });
  }

  /** Reader contexts, resolved the way production resolves them. */
  function readerFor(userId: string, role: "admin" | "member"): Promise<BrainPrincipalContext> {
    return resolvePrincipalContext(pool, {
      workspaceId: WORKSPACE,
      mode: "managed",
      userId,
      resolvedRole: { role, orgId: WORKSPACE },
    });
  }

  /** In the meeting AND on both mails — the only reader entitled to every class. */
  const admin = () => readerFor("user-admin", "admin");
  /** In the meeting, narratively BCC'd on the recap — the lower-bound reader. */
  const ada = () => readerFor("user-ada", "member");
  /** On both mails, in no meeting — the mirror-image of `ada`. */
  const bo = () => readerFor("user-bo", "member");
  /** Org-only, in no roster at all — the fail-closed control. */
  const mallory = () => readerFor("user-mallory", "member");

  // ── row helpers ─────────────────────────────────────────────────────────

  async function facts(): Promise<readonly FactRow[]> {
    const { rows } = await pool.query<FactRow>(
      `SELECT id, subject, object, status, predicate_cardinality, visible_to,
              pre_widening_visible_to, valid_from, valid_to, invalidated_at, provenance
         FROM brain_facts ORDER BY subject, object`,
    );
    return rows;
  }

  /** Named throws, not `!` — a failure must name the row a stage failed to write. */
  function factByClaim(rows: readonly FactRow[], subject: string, object: string): FactRow {
    const row = rows.find((f) => f.subject === subject && f.object === object);
    if (!row) {
      throw new Error(
        `no brain_facts row asserting "${subject} … ${object}"; saw [${rows
          .map((f) => `${f.subject} … ${f.object}`)
          .join(", ")}]`,
      );
    }
    return row;
  }

  async function episodeIdBySourceId(source: string, sourceId: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id::text AS id FROM brain_episodes
        WHERE workspace_id = $1 AND source = $2 AND source_id = $3`,
      [WORKSPACE, source, sourceId],
    );
    const id = rows[0]?.id;
    if (id === undefined) {
      throw new Error(`no brain_episodes row for ${source}/${sourceId} — ingest did not store it`);
    }
    return id;
  }

  /**
   * Edges of one type between two named endpoints.
   *
   * `to` is an exclusive union, not an all-optional pair: the two-optional shape
   * admits `{}`, which binds `undefined` → SQL NULL → a count of 0, and this
   * file asserts several `toBe(0)` negatives that would then pass vacuously.
   */
  async function edgeCount(
    edgeType: BrainEdgeType,
    fromFactId: string,
    to: { readonly factId: string } | { readonly episodeId: string },
  ): Promise<number> {
    const [toClause, toId] =
      "factId" in to
        ? ([`to_fact_id = $4::uuid`, to.factId] as const)
        : ([`to_episode_id = $4::uuid`, to.episodeId] as const);
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM brain_edges
        WHERE workspace_id = $1 AND edge_type = $2 AND from_fact_id = $3::uuid AND ${toClause}`,
      [WORKSPACE, edgeType, fromFactId, toId],
    );
    return Number(rows[0]?.n ?? "0");
  }

  /**
   * Who production's own membership write put in an audience.
   *
   * Sorted in JS rather than by SQL `ORDER BY`, so the expectations below are
   * not a statement about the test database's collation — which differs between
   * a developer's container and CI's, and would make this file's membership
   * equalities pass or fail on an environment detail.
   */
  async function audienceMembers(audienceId: string): Promise<readonly string[]> {
    const { rows } = await pool.query<{ user_id: string }>(
      `SELECT user_id FROM fact_audience_member
        WHERE workspace_id = $1 AND audience_id = $2`,
      [WORKSPACE, audienceId],
    );
    return rows.map((r) => r.user_id).toSorted(byCodeUnit);
  }

  /**
   * The staleness PREMISE, through `acl.ts`'s own statement.
   *
   * Asserted rather than assumed because the suppression path and a correct
   * ACL denial are indistinguishable from the reader's side: both produce a
   * reader who cannot see the fact. If `synced_at` ever drifted past the bound,
   * every isolation assertion below would still pass — for the wrong reason,
   * and it would keep passing after the invariant they exist to defend broke.
   */
  async function expectAudiencesFresh(userId: string, expected: readonly string[]): Promise<void> {
    const { rows } = await pool.query<{ audience_id: string; fresh: boolean }>(
      AUDIENCE_MEMBERSHIP_SQL,
      [WORKSPACE, userId, getAudienceMaxStalenessSeconds()],
    );
    expect(rows.map((r) => r.audience_id).toSorted(byText)).toEqual([...expected].toSorted(byText));
    // BOTH halves: the ids the membership table holds, and that none of them is
    // being suppressed. `audienceIds` on the resolved context only shows the
    // survivors, so a suppressed audience is invisible there by construction.
    expect(rows.filter((r) => r.fresh !== true)).toEqual([]);
  }

  // Typed as the union, not `{ tier: string }`: that is what keeps the compiler
  // checking the literal against the discriminant, so a tier rename in
  // `@useatlas/types` is a TS2367 rather than a filter that silently returns `[]`
  // and satisfies every empty-list assertion in the file.
  const isFact = (r: BrainSearchResult): r is BrainFactResult => r.tier === "fact";
  const isEpisode = (r: BrainSearchResult): r is BrainEpisodeResult => r.tier === "raw-episode";

  const byText = (a: string, b: string) => a.localeCompare(b);
  /**
   * Code-unit order, for IDENTIFIERS rather than prose.
   *
   * `localeCompare` deprioritises punctuation, and every id this file sorts
   * carries some (`user-ada` vs `user-admin`, `meeting:zoom:…` vs
   * `email-message:outlook:…`). The two orders agree today, and relying on that
   * would make an equality below depend on the runtime's collation data rather
   * than on the ids. Explicit is also what the type-aware lint asks for — a bare
   * `.toSorted()` is an error, and the right fix is to say which order was meant.
   */
  const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const subjectsOf = (results: readonly BrainSearchResult[]) =>
    results.filter(isFact).map((f) => f.subject).toSorted(byText);
  const sourcesOf = (results: readonly BrainSearchResult[]) =>
    results.filter(isEpisode).map((e) => e.source).toSorted(byText);
  /** The deploy-window objects a read served — the contradiction's projection. */
  const deployObjectsOf = (results: readonly BrainSearchResult[]) =>
    results
      .filter(isFact)
      .filter((f) => f.subject === "deploy window")
      .map((f) => f.object)
      .toSorted(byText);
  const factNamed = (results: readonly BrainSearchResult[], subject: string) =>
    results.filter(isFact).find((f) => f.subject === subject);

  // ── the loop ────────────────────────────────────────────────────────────

  it(
    "walks three source classes through corroboration, contradiction, per-class ACL isolation and extraction lag, end to end",
    async () => {
      // ---- 1. chat + transcript land, and are extracted --------------------
      zoomMeetings = [MEETING_ALPHA];
      const chatSync = await syncSource(slackConnector, SLACK_INSTALL);
      // BY VALUE, not `toMatchObject`: `refused` and `batchDuplicate` are the
      // ingest core's entire silent-drop-prevention mechanism, and a subset
      // match discards exactly them.
      expect(chatSync.episodes).toEqual({
        inserted: 1,
        duplicate: 0,
        batchDuplicate: 0,
        refused: { blank_source_id: 0, blank_body: 0, unusable_grant: 0, invalid_occurred_at: 0 },
      });
      const transcriptSync = await syncSource(zoomConnector, ZOOM_INSTALL);
      expect(transcriptSync.episodes).toEqual({
        inserted: 1,
        duplicate: 0,
        batchDuplicate: 0,
        refused: { blank_source_id: 0, blank_body: 0, unusable_grant: 0, invalid_occurred_at: 0 },
      });

      const firstCycle = await extract();
      // `factsCorroborated: 0` even here, where there is nothing yet to
      // corroborate: it is the assertion that catches a claim silently merged
      // into an unrelated one, and omitting it would make the cross-class pin
      // below look like the special case.
      expect(firstCycle).toMatchObject({
        inspected: 2,
        extracted: 2,
        factsCreated: 4,
        factsCorroborated: 0,
      });
      expect(modelCalls.toSorted(byText)).toEqual(
        [MARKER.opsReview, MARKER.officeMove].toSorted(byText),
      );

      // The two grant GRAMMARS, each on its own class's episode. Asserted here
      // rather than only through the readers below, because "the reader saw
      // nothing" has three possible causes and this eliminates two of them.
      const { rows: grants } = await pool.query<{ source: string; visible_to: string[] }>(
        `SELECT source, visible_to FROM brain_episodes ORDER BY source`,
      );
      expect(grants).toEqual([
        { source: SLACK_HISTORY_SOURCE, visible_to: ["org"] },
        { source: ZOOM_TRANSCRIPT_SOURCE, visible_to: [MEETING_ALPHA_GRANT] },
      ]);

      // ---- 2. the SAME claim arrives in a second class ---------------------
      // A separate sync + cycle rather than one combined drain, so the direction
      // of corroboration is DECIDED rather than inherited from whatever order
      // the drain happened to inspect in: the transcript creates, the mail
      // corroborates. An ambiguous direction would make the provenance and
      // grant assertions below unwriteable.
      outlookMessages = [MSG_CORROBORATE];
      const emailSync = await syncSource(outlookConnector, OUTLOOK_INSTALL);
      expect(emailSync.episodes).toEqual({
        inserted: 1,
        duplicate: 0,
        batchDuplicate: 0,
        refused: { blank_source_id: 0, blank_body: 0, unusable_grant: 0, invalid_occurred_at: 0 },
      });

      const emailCycle = await extract();
      // ⭐ THE CROSS-CLASS CORROBORATION COUNTER. The mail asserted two claims:
      // one that already exists (from a transcript) and one that does not. One
      // created, one corroborated — the whole claim of this step, as counters.
      expect(emailCycle).toMatchObject({
        inspected: 1,
        extracted: 1,
        factsCreated: 1,
        factsCorroborated: 1,
      });
      expect(modelCalls.toSorted(byText)).toEqual(
        [MARKER.opsReview, MARKER.officeMove, MARKER.pricingRecap].toSorted(byText),
      );

      let rows = await facts();
      // ⭐ FIVE rows, not six. This is the assertion the whole step exists for,
      // and it is stated as a total rather than only as "one Q3 row": a
      // corroboration lookup that silently narrowed by source would mint a
      // second Q3 row, and a lookup that silently WIDENED would swallow one of
      // the four unrelated claims. Only a total catches both directions.
      expect(rows).toHaveLength(5);
      const q3 = factByClaim(rows, CORROBORATED_CLAIM.subject, CORROBORATED_CLAIM.object);
      const thursdays = factByClaim(rows, "deploy window", "Thursdays");
      const hiring = factByClaim(rows, "hiring plan", "frozen");
      const vendor = factByClaim(rows, "vendor contract", "March");
      const officeMove = factByClaim(rows, "office move", "June");

      const transcriptEpisodeId = await episodeIdBySourceId(
        ZOOM_TRANSCRIPT_SOURCE,
        zoomEpisodeSourceId(MEETING_ALPHA_UUID, MEETING_ALPHA_FILE),
      );
      const recapEpisodeId = await episodeIdBySourceId(
        OUTLOOK_MAIL_SOURCE,
        outlookEpisodeSourceId("recap-q3@multisource.test"),
      );

      // ⭐ ONE claim, TWO classes of evidence. The provenance edges are what
      // "corroborated rather than duplicated" MEANS at the row level, and they
      // are asserted per-endpoint rather than as a count: a count of 2 is also
      // what a double-written edge to the same episode looks like, which is a
      // corroboration that never happened.
      expect(await edgeCount("provenance", q3.id, { episodeId: transcriptEpisodeId })).toBe(1);
      expect(await edgeCount("provenance", q3.id, { episodeId: recapEpisodeId })).toBe(1);

      // The re-observation recorded EVIDENCE and rewrote nothing. `visible_to`
      // is still the transcript's alone — `reconcile.ts` is explicit that a
      // re-observation at ANY grant never rewrites the row's, because a grant is
      // immutable per fact version and widening is the review gate's business.
      expect(q3).toMatchObject({
        status: "draft",
        visible_to: [MEETING_ALPHA_GRANT],
        pre_widening_visible_to: null,
        valid_to: null,
        invalidated_at: null,
      });
      // …and the provenance stayed the FIRST observer's, which is what makes
      // the attribution-narrowing assertion in step 3 meaningful: the claim a
      // mail reader will shortly be able to see was said in a meeting.
      expect(q3.provenance).toMatchObject({ source: ZOOM_TRANSCRIPT_SOURCE });

      // The class-exclusive claims, each carrying its own class's grant. Without
      // these the isolation arm below could be satisfied by every fact having
      // accidentally landed on one grant.
      // Collapsed to one comparison: a grant-derivation regression typically
      // moves several of these at once, and bun's first-failure-shadows rule
      // would report only the earliest — making a systemic break read as a
      // single fact's bug.
      expect({
        hiring: hiring.visible_to,
        vendor: vendor.visible_to,
        officeMove: officeMove.visible_to,
        thursdays: thursdays.visible_to,
      }).toEqual({
        hiring: [MEETING_ALPHA_GRANT],
        vendor: [RECAP_GRANT],
        officeMove: ["org"],
        thursdays: [MEETING_ALPHA_GRANT],
      });

      // ---- 3. the gate publishes, and the cross-class evidence WIDENS ------
      const firstPublish = await publish();
      expect(firstPublish.promoted).toBe(5);
      expect(firstPublish.refused).toEqual([]);
      // Nothing published before this, so the supersession machinery must be
      // inert — or every assertion about it in step 5 is noise.
      expect(firstPublish.superseded).toEqual([]);

      rows = await facts();
      const q3Published = factByClaim(rows, CORROBORATED_CLAIM.subject, CORROBORATED_CLAIM.object);
      // ⭐ #4823 AT A CLASS BOUNDARY. The claim was granted to a meeting and
      // corroborated by a mail, so publish — the review gate, the one place
      // ADR-0036 §T5 permits widening — promotes it with the UNION. The
      // ordering is the evidence's arrival order, so it is asserted as a SET.
      expect([...q3Published.visible_to].toSorted(byText)).toEqual(
        [MEETING_ALPHA_GRANT, RECAP_GRANT].toSorted(byText),
      );
      expect(q3Published.pre_widening_visible_to).toEqual([MEETING_ALPHA_GRANT]);
      // The negative that makes the positive mean something: widening is RARE
      // by construction and fires only where the evidence is genuinely wider.
      // A change that widened every published fact to its evidence union — the
      // plausible over-application — dies here rather than in a leak report.
      expect(factByClaim(rows, "hiring plan", "frozen").pre_widening_visible_to).toBeNull();
      expect(factByClaim(rows, "vendor contract", "March").pre_widening_visible_to).toBeNull();
      expect(factByClaim(rows, "deploy window", "Thursdays").pre_widening_visible_to).toBeNull();

      // ---- 4. per-class ACL isolation under the heterogeneous grant set ----
      // The MEMBERSHIP premise first, written by the connectors' own reconciles.
      expect(await audienceMembers(MEETING_ALPHA_AUDIENCE)).toEqual(["user-ada", "user-admin"]);
      // ⭐ THE DOCUMENTED LOWER BOUND, asserted as an equality with the missing
      // person NAMED. `ada` is BCC'd on this mail in the fixture's narrative and
      // is deliberately absent: #4966 ignores Bcc even where it is visible, for
      // determinism, so the derived audience is From+To+Cc and no more. A test
      // that asserted "everyone on the mail" would be asserting a posture Atlas
      // does not have — and one that only asserted `ada ∉ audience` would pass
      // just as well against an audience that had lost `bo` too.
      expect(await audienceMembers(RECAP_AUDIENCE)).toEqual(["user-admin", "user-bo"]);
      // The production deriver's own answer, so the bound is pinned where it is
      // DECIDED and not merely where it lands.
      expect(messageParticipants(MSG_CORROBORATE).map((p) => p.address)).toEqual([
        EMAIL_OF["user-admin"],
        EMAIL_OF["user-bo"],
      ]);
      expect(messageParticipants(MSG_CORROBORATE).map((p) => p.address)).not.toContain(
        EMAIL_OF["user-ada"],
      );

      // Staleness is a live suppression path (#4971 / 0186) and would fake every
      // negative below — see the header. Pinned as a premise, per reader.
      await expectAudiencesFresh("user-admin", [MEETING_ALPHA_AUDIENCE, RECAP_AUDIENCE]);
      await expectAudiencesFresh("user-ada", [MEETING_ALPHA_AUDIENCE]);
      await expectAudiencesFresh("user-bo", [RECAP_AUDIENCE]);
      await expectAudiencesFresh("user-mallory", []);
      // …and the freshness above comes from the INGEST-time reconcile, not from
      // a re-verification: this suite never drives #4971's scan. Asserted so a
      // future change that wires the re-verifier in has to confront what its
      // abort arms do to `synced_at`, rather than inheriting a green file.
      const { rows: attempts } = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM brain_audience_reverify_attempt`,
      );
      expect(attempts[0]?.n).toBe("0");

      const adminCtx = await admin();
      const adaCtx = await ada();
      const boCtx = await bo();
      const malloryCtx = await mallory();

      const adminView = await search(adminCtx);
      const adaView = await search(adaCtx);
      const boView = await search(boCtx);
      const malloryView = await search(malloryCtx);

      // ⭐ THE ISOLATION MATRIX. Each reader's whole served set, by value —
      // never "does not contain X", which is satisfied by a read that returned
      // nothing at all. Every negative below is paired with the positive that
      // proves the reader is reading.
      // ONE assertion over all four readers, not four in sequence. bun has no
      // `expect.soft`, so the first failure SHADOWS every assertion after it —
      // and these four are mutually independent: a widening regression usually
      // affects several readers at once, and reported one at a time it looks
      // like a single reader's bug until you fix it and the next one appears.
      // Compared as one object, every wrong reader diffs simultaneously.
      expect({
        mallory: subjectsOf(malloryView.results),
        ada: subjectsOf(adaView.results),
        bo: subjectsOf(boView.results),
        admin: subjectsOf(adminView.results),
      }).toEqual({
        mallory: ["office move"],
        ada: ["Q3 revenue target", "deploy window", "hiring plan", "office move"].toSorted(byText),
        bo: ["Q3 revenue target", "office move", "vendor contract"].toSorted(byText),
        admin: [
          "Q3 revenue target",
          "deploy window",
          "hiring plan",
          "office move",
          "vendor contract",
        ].toSorted(byText),
      });

      // The same isolation at tier 3, and collapsed for the same reason. Facts
      // and episodes are gated by separate clauses over separate tables
      // (`search.ts`: the episode ACL is a FRESH clause, never the fact
      // predicate reused), so a regression in one is invisible in the other.
      expect({
        mallory: sourcesOf(malloryView.results),
        ada: sourcesOf(adaView.results),
        bo: sourcesOf(boView.results),
      }).toEqual({
        mallory: [SLACK_HISTORY_SOURCE],
        ada: [SLACK_HISTORY_SOURCE, ZOOM_TRANSCRIPT_SOURCE].toSorted(byText),
        bo: [OUTLOOK_MAIL_SOURCE, SLACK_HISTORY_SOURCE].toSorted(byText),
      });

      // ⭐ WIDENED IN, BUT NOT TOLD WHO SAID IT. `bo` reaches the Q3 claim only
      // through #4823's union; he matches none of `pre_widening_visible_to`, so
      // `attributionDecision` withholds. He learns the claim — which is the
      // point of widening — and not that it was said in a meeting he was not in,
      // by a host he has no other way to learn about. `ada`, who matches the
      // pre-widening grant, gets the actor.
      const boQ3 = factNamed(boView.results, CORROBORATED_CLAIM.subject);
      if (boQ3 === undefined) {
        throw new Error("the widened-in reader was served no Q3 fact — the attribution arm would be vacuous");
      }
      expect(boQ3.provenance).toMatchObject({ attribution: { visible: false } });
      // Both classes reach him — the corroboration is not hidden along with the
      // attribution — so the withholding is scoped to WHO, not to WHETHER.
      expect(boQ3.corroborationCount).toBe(2);
      const adaQ3 = factNamed(adaView.results, CORROBORATED_CLAIM.subject);
      expect(adaQ3?.provenance).toMatchObject({
        source: ZOOM_TRANSCRIPT_SOURCE,
        attribution: { visible: true, actor: `${ZOOM_TRANSCRIPT_SOURCE}:${ZOOM_HOST_ID}` },
      });

      // ---- 5. the contradicting mail — a day later, in the other class -----
      clockAt = T1;
      outlookMessages = [MSG_CORROBORATE, MSG_RIVAL];
      const rivalSync = await syncSource(outlookConnector, OUTLOOK_INSTALL);
      // `duplicate: 1` is the CURSOR-LESS premise showing through, not a defect:
      // with no state row the walk restarts at the backfill floor every pass, so
      // the recap is re-offered and absorbed by the Message-ID dedupe while the
      // rival is new. That the re-offer costs nothing is the source-id contract
      // (`ingest/types.ts`) doing its job across two passes — a connector whose
      // id was not byte-stable between passes would insert a second copy here,
      // and the count would read `inserted: 2`.
      expect(rivalSync.episodes).toEqual({
        inserted: 1,
        duplicate: 1,
        batchDuplicate: 0,
        refused: { blank_source_id: 0, blank_body: 0, unusable_grant: 0, invalid_occurred_at: 0 },
      });
      const rivalCycle = await extract();
      expect(rivalCycle).toMatchObject({
        inspected: 1,
        extracted: 1,
        factsCreated: 1,
        factsCorroborated: 0,
      });

      rows = await facts();
      const fridays = factByClaim(rows, "deploy window", "Fridays");
      // A DRAFT, on its own message's audience — a second email audience, not
      // the recap's: the email class's grain is per MESSAGE, so two mails
      // between overlapping people are two audiences.
      expect(fridays).toMatchObject({
        status: "draft",
        predicate_cardinality: "single",
        visible_to: [RIVAL_GRANT],
        valid_to: null,
        invalidated_at: null,
      });
      expect(RIVAL_GRANT).not.toBe(RECAP_GRANT);
      expect(await audienceMembers(RIVAL_AUDIENCE)).toEqual(["user-admin", "user-bo"]);

      // ⭐ THE WHOLE EDGE PICTURE IN ONE COMPARISON: the advisory edge reconcile
      // wrote (newer claim → incumbent, once), and NEITHER RANKED, stated as the
      // absence of every arbitration artefact. Reconcile recorded a conflict; it
      // retired nothing, in either direction, and did not decide that a mail
      // outranks a meeting or the reverse.
      //
      // One object rather than four awaits in sequence: these four counts are a
      // single claim about the edge table, and with bun's first-failure-shadows
      // rule a regression that wrote BOTH `supersedes` directions would surface
      // as one of them until fixed, then the other. Together they diff at once.
      expect({
        tensionForward: await edgeCount("in-tension-with", fridays.id, { factId: thursdays.id }),
        tensionReverse: await edgeCount("in-tension-with", thursdays.id, { factId: fridays.id }),
        supersedesForward: await edgeCount("supersedes", fridays.id, { factId: thursdays.id }),
        supersedesReverse: await edgeCount("supersedes", thursdays.id, { factId: fridays.id }),
      }).toEqual({
        tensionForward: 1,
        tensionReverse: 0,
        supersedesForward: 0,
        supersedesReverse: 0,
      });
      const stillLive = factByClaim(rows, "deploy window", "Thursdays");
      expect(stillLive).toMatchObject({
        status: "published",
        valid_to: null,
        invalidated_at: null,
      });

      // ⭐ A PRINCIPAL CONTEXT IS A SNAPSHOT, and the email class is where that
      // starts to bite. `adminCtx` was resolved in step 4, before this mail
      // existed; the mail minted a BRAND NEW audience and put him in it, and his
      // held context knows nothing about it. Chat and transcript audiences are
      // per-container and per-meeting — a reader's set grows slowly — but email's
      // grain is per MESSAGE, so every mail a reader receives invalidates their
      // context. Both directions are asserted: without the stale half, a resolver
      // that had silently started returning every audience in the workspace would
      // satisfy the fresh half.
      expect(adminCtx.audienceIds).not.toContain(RIVAL_AUDIENCE);
      const adminLive = await admin();
      const boLive = await bo();
      expect(adminLive.audienceIds).toContain(RIVAL_AUDIENCE);
      expect(boLive.audienceIds).toContain(RIVAL_AUDIENCE);
      // …and the older grants survive the re-resolve rather than being replaced
      // by the newest one, which is the failure a per-message grain invites.
      expect(adminLive.audienceIds.toSorted(byCodeUnit)).toEqual(
        [MEETING_ALPHA_AUDIENCE, RECAP_AUDIENCE, RIVAL_AUDIENCE].toSorted(byCodeUnit),
      );

      // ---- 6. surfaced-both-with-provenance, ACROSS the class boundary -----
      const adminContested = await search(adminLive);
      // The draft rival is not itself served in published mode; it reaches the
      // reader only as the incumbent's counterpart.
      expect(deployObjectsOf(adminContested.results)).toEqual(["Thursdays"]);
      const adminIncumbent = factNamed(adminContested.results, "deploy window");
      if (adminIncumbent === undefined) {
        throw new Error("the admin was served no deploy-window fact — the cluster assertion would be vacuous");
      }
      expect(adminIncumbent.tensions).toHaveLength(1);
      // ⭐ THE COUNTERPART CARRIES ITS OWN CLASS. This is the assertion a
      // single-class suite cannot write and the one a collapsed projection
      // fails: the incumbent is a transcript claim, the counterpart is a mail
      // claim, and the counterpart's provenance says so with the mail's own
      // sender as actor. A projection that reused the OWNER's provenance for its
      // counterparts would be green everywhere except here.
      expect(adminIncumbent.tensions[0]).toMatchObject({
        visible: true,
        factId: fridays.id,
        // The edge points newer → incumbent, so from the incumbent's side the
        // counterpart sits on the `from` end.
        edgeDirection: "from",
        object: "Fridays",
        status: "draft",
        invalidatedAt: null,
        validTo: null,
        provenance: {
          source: OUTLOOK_MAIL_SOURCE,
          attribution: { visible: true, actor: `${OUTLOOK_MAIL_SOURCE}:${EMAIL_OF["user-bo"]}` },
        },
      });

      // ⭐ THE WITHHELD COUNTERPART, ACROSS CLASSES. `ada` is in the meeting and
      // on neither mail. She is told a contradiction exists — which is what stops
      // an agent asserting the claim as settled — and is told nothing about the
      // class she cannot read. Reported, never dropped: an omitted conflict reads
      // as "nothing contradicts this".
      const adaContested = await search(adaCtx);
      const adaIncumbent = factNamed(adaContested.results, "deploy window");
      expect(adaIncumbent).toMatchObject({ object: "Thursdays", status: "published" });
      expect(adaIncumbent?.tensions).toEqual([{ visible: false, withheldCount: 1 }]);

      // The mirror image, and the fail-closed direction: `bo` OWNS the rival's
      // class and still sees nothing about the deploy window, because the
      // incumbent is meeting-granted and his own rival is an unpublished draft.
      // Paired with a positive so this is isolation rather than a broken read.
      const boContested = await search(boLive);
      expect(deployObjectsOf(boContested.results)).toEqual([]);
      expect(subjectsOf(boContested.results)).toEqual(
        ["Q3 revenue target", "office move", "vendor contract"].toSorted(byText),
      );

      // The REVIEWER's queue holds the rival with the incumbent as its
      // counterpart — same edge, other surface, per-rival projection, and the
      // classes swap sides. `candidates.ts` re-decides attribution per
      // counterpart through its OWN projection, so a regression that dropped
      // cross-class provenance from the reviewer's side while leaving search
      // intact would pass everything above.
      const queue = await loadFactCandidates(pool, { ctx: adminLive, limit: 50, offset: 0 });
      expect(queue.total).toBe(1);
      expect(queue.candidates[0]).toMatchObject({
        id: fridays.id,
        object: "Fridays",
        provenance: {
          source: OUTLOOK_MAIL_SOURCE,
          attribution: { visible: true, actor: `${OUTLOOK_MAIL_SOURCE}:${EMAIL_OF["user-bo"]}` },
        },
      });
      expect(queue.candidates[0]?.tensions).toEqual([
        expect.objectContaining({
          visible: true,
          factId: thursdays.id,
          edgeDirection: "to",
          object: "Thursdays",
          status: "published",
          provenance: expect.objectContaining({
            source: ZOOM_TRANSCRIPT_SOURCE,
            attribution: expect.objectContaining({
              visible: true,
              actor: `${ZOOM_TRANSCRIPT_SOURCE}:${ZOOM_HOST_ID}`,
            }),
          }),
        }),
      ]);

      // ---- 7. the human gate arbitrates ACROSS classes ---------------------
      // Advisory tension is not arbitration; a reviewer publishing IS. The gate
      // picks by the supersession collision — subject+predicate+`single` — and
      // is blind to class, which is the property this step pins.
      const gate = await publish();
      expect(gate.promoted).toBe(1);
      expect(gate.refused).toEqual([]);
      expect(gate.superseded).toEqual([{ rowId: fridays.id, superseded: [thursdays.id] }]);

      rows = await facts();
      const loser = factByClaim(rows, "deploy window", "Thursdays");
      const winner = factByClaim(rows, "deploy window", "Fridays");
      // The stamp closed the loser's window and ONLY its window: still
      // published (the review verdict stands), still not retracted.
      expect(loser.valid_to).not.toBeNull();
      expect(loser).toMatchObject({ status: "published", invalidated_at: null });
      // The winner is current with an UNRECORDED start — the extraction schema
      // carries no `validFrom`, so only the loser's closed window encodes the
      // arbitration. Pinned rather than "fixed" in the fixture, and it is
      // exactly why step 8's bracket is written the way it is.
      expect(winner).toMatchObject({ status: "published", valid_to: null, valid_from: null });
      expect(await edgeCount("supersedes", winner.id, { factId: loser.id })).toBe(1);

      // ⭐ SUPERSESSION IS GRANT-BLIND, AND NOW ACROSS A CLASS BOUNDARY. The
      // collision join never reads `visible_to`, so a mail nobody in the meeting
      // can read has just retired the meeting's belief for them: `ada`'s current
      // answer for the deploy window is not "Thursdays" and not "Fridays" — it
      // simply ENDS. That is a real consequence of two decisions that are each
      // correct alone, no ADR states it, and it is pinned here so a change to it
      // has to argue with a test. Paired with a positive, so this is a lost
      // belief and not a lost reader.
      // All three readers at once. The handover is a single event with three
      // simultaneous consequences, and asserting them in sequence lets bun's
      // first failure hide the other two — so a regression that broke the
      // handover for BOTH winners would read as one reader's problem.
      const adaAfterGate = await search(adaCtx);
      expect({
        adaDeploy: deployObjectsOf(adaAfterGate.results),
        adaStillReads: subjectsOf(adaAfterGate.results),
        // The readers who own the WINNER's class gain the belief in the same
        // instant — the other half of grant-blindness, and what makes this a
        // handover rather than a deletion.
        boDeploy: deployObjectsOf((await search(boLive)).results),
        adminDeploy: deployObjectsOf((await search(adminLive)).results),
      }).toEqual({
        adaDeploy: [],
        adaStillReads: ["Q3 revenue target", "hiring plan", "office move"].toSorted(byText),
        boDeploy: ["Fridays"],
        adminDeploy: ["Fridays"],
      });

      // ---- 8. the point read, at the bound the GATE stamped ----------------
      // THE UPPER BOUND, falsified by BRACKETING. Every fact in this file has
      // `valid_from NULL`, which #4916 admits at ANY instant, so an `asOf` read
      // at an arbitrary past moment is satisfied through that arm and the
      // far-future upper bound: delete both temporal predicates and it still
      // passes. This pair cannot — one millisecond either side of the stamp
      // flips whether the superseded claim answers — and the bound is the value
      // `SUPERSEDE_STAMP_SQL` wrote rather than one the fixture chose.
      //
      // BRACKETED rather than read AT the stamp: `timestamptz` keeps
      // MICROseconds while `parseBrainAsOf` round-trips through a JS `Date`, so
      // an `asOf` built from `valid_to.toISOString()` is the stamp TRUNCATED and
      // the loser stays visible through `valid_to > asOf`. Equality at the
      // half-open bound is unreachable through this API; ±1ms is exact.
      if (loser.valid_to === null) {
        throw new Error("the gate stamped no valid_to — the bracket below would be vacuous");
      }
      const stampMs = loser.valid_to.getTime();
      // The bracket is ONE claim — "the bound is exactly here" — so both sides
      // are compared together. Split, a predicate that admitted everything would
      // fail only on the `justAfter` half, and the `justBefore` half that proves
      // the read still works at all would never be reached to say so.
      const justAfter = await search(adminLive, { asOf: new Date(stampMs + 1).toISOString() });
      const justBefore = await search(adminLive, { asOf: new Date(stampMs - 1).toISOString() });
      expect({
        justAfter: deployObjectsOf(justAfter.results),
        justBefore: deployObjectsOf(justBefore.results),
      }).toEqual({
        justAfter: ["Fridays"],
        justBefore: ["Fridays", "Thursdays"],
      });
      // The point read rewinds the FACTS, never the grants of a class the
      // reader never held: `bo` gets the mail-granted winner at both instants
      // and never the meeting-granted loser, so `asOf` is not a way around the
      // per-class isolation of step 4.
      const boJustBefore = await search(boLive, { asOf: new Date(stampMs - 1).toISOString() });
      expect(deployObjectsOf(boJustBefore.results)).toEqual(["Fridays"]);

      // ---- 9. the extraction-lag window ------------------------------------
      // A fourth episode lands in a class whose earlier episodes are all
      // extracted, and NOTHING drains it. That is the ordinary state of a
      // multi-connector workspace — one shared drain, 25 episodes per 5 minutes,
      // no knob — rather than a corner case, and §T7 commits that the read
      // degrades to a LABELLED raw answer instead of blocking.
      zoomMeetings = [MEETING_ALPHA, MEETING_LATE];
      const lateSync = await syncSource(zoomConnector, ZOOM_INSTALL);
      // One new, one re-offered — the cursor-less premise again (`syncSource`).
      // The re-offered meeting matters here beyond the count: it is re-fetched,
      // its roster is re-read and its audience re-reconciled, and it must NOT
      // re-enter the extraction queue. The `extracted_at IS NULL` premise below
      // is what pins that, and it would be a much weaker statement if this pass
      // had only ever seen one meeting.
      expect(lateSync.episodes).toEqual({
        inserted: 1,
        duplicate: 1,
        batchDuplicate: 0,
        refused: { blank_source_id: 0, blank_body: 0, unusable_grant: 0, invalid_occurred_at: 0 },
      });
      // The premise: exactly one episode is queued, and it is the new one. Not
      // asserting this would let "the label is `pending`" pass against a read
      // that mislabelled an already-extracted episode.
      const { rows: queued } = await pool.query<{ source_id: string }>(
        `SELECT source_id FROM brain_episodes WHERE extracted_at IS NULL`,
      );
      expect(queued.map((r) => r.source_id)).toEqual([
        zoomEpisodeSourceId(MEETING_LATE_UUID, MEETING_LATE_FILE),
      ]);

      // Re-resolved, for step 6's reason — the late meeting minted a THIRD
      // audience and a held context predates it. Both readers are re-resolved,
      // and ada's is the one that matters: her "does not contain" below has to be
      // an ACL exclusion, and against a context resolved before this meeting
      // existed it would be satisfied by staleness alone. The premise is stated
      // in both directions so neither reading is available.
      const adminLagCtx = await admin();
      const adaLagCtx = await ada();
      expect(adminLagCtx.audienceIds).toContain(MEETING_LATE_AUDIENCE);
      expect(adaLagCtx.audienceIds).not.toContain(MEETING_LATE_AUDIENCE);
      expect(adaLagCtx.audienceIds).toEqual([MEETING_ALPHA_AUDIENCE]);

      const adminLagged = await search(adminLagCtx);
      const lateEpisode = adminLagged.results
        .filter(isEpisode)
        .find((e) => e.sourceId === zoomEpisodeSourceId(MEETING_LATE_UUID, MEETING_LATE_FILE));
      // Named throw, not `?.`: `expect(undefined?.extraction).toBe("pending")`
      // would fail with a message about `undefined` rather than about the read
      // having dropped the episode, and "the lagged episode was not returned at
      // all" is precisely the regression this step exists to catch.
      if (lateEpisode === undefined) {
        throw new Error(
          "the unextracted episode was not served — the extraction-lag window BLOCKED the read instead of labelling it",
        );
      }
      // ⭐ THE LABEL, as the discriminated pair. `extraction` and `extractedAt`
      // are one union in `@useatlas/types` precisely so `{complete, null}` is
      // unspellable, and asserting both halves is what pins that.
      expect(lateEpisode).toMatchObject({
        tier: "raw-episode",
        trustTier: 3,
        source: ZOOM_TRANSCRIPT_SOURCE,
        extraction: "pending",
        extractedAt: null,
      });
      // The positive control: every OTHER episode in the same response carries
      // the complete label with a real timestamp. Without it, a projection that
      // hard-coded `pending` would satisfy the assertion above.
      const settled = adminLagged.results
        .filter(isEpisode)
        .filter((e) => e.sourceId !== zoomEpisodeSourceId(MEETING_LATE_UUID, MEETING_LATE_FILE));
      // By CLASS rather than by count: "4" says nothing about which episodes
      // these are, and the point of the control is that the settled set spans
      // every class this workspace holds — so a `pending` label leaking onto one
      // of them, or a whole class dropping out of the response, is visible here.
      expect(settled.map((e) => e.source).toSorted(byText)).toEqual(
        [
          SLACK_HISTORY_SOURCE,
          ZOOM_TRANSCRIPT_SOURCE,
          OUTLOOK_MAIL_SOURCE,
          OUTLOOK_MAIL_SOURCE,
        ].toSorted(byText),
      );
      expect(settled.every((e) => e.extraction === "complete" && e.extractedAt !== null)).toBe(true);

      // ⭐ LABELLED, NOT BLOCKING. The same call still served the facts — the
      // read did not degrade, stall, or narrow because an episode was queued.
      expect(deployObjectsOf(adminLagged.results)).toEqual(["Fridays"]);
      expect(subjectsOf(adminLagged.results)).toEqual(
        [
          "Q3 revenue target",
          "deploy window",
          "hiring plan",
          "office move",
          "vendor contract",
        ].toSorted(byText),
      );

      // …and the lagged episode is ACL-gated like any other. Its meeting had a
      // strictly smaller roster, so `ada` — who could read the FIRST meeting —
      // must not reach this one. An unextracted episode is evidence with a
      // grant, not a free pass through the tier-3 clause.
      const adaLagged = await search(adaLagCtx);
      expect(adaLagged.results.filter(isEpisode).map((e) => e.sourceId)).not.toContain(
        zoomEpisodeSourceId(MEETING_LATE_UUID, MEETING_LATE_FILE),
      );
      expect(sourcesOf(adaLagged.results)).toEqual(
        [SLACK_HISTORY_SOURCE, ZOOM_TRANSCRIPT_SOURCE].toSorted(byText),
      );
      expect(await audienceMembers(MEETING_LATE_AUDIENCE)).toEqual(["user-admin"]);
      // …and the episode the lag arm is about carries that meeting's OWN grant,
      // not the first meeting's. Without this, "ada cannot see it" would hold
      // just as well if the late episode had landed ungranted or on some third
      // token — which is a different bug wearing the same green.
      const { rows: lateGrant } = await pool.query<{ visible_to: string[] }>(
        `SELECT visible_to FROM brain_episodes
          WHERE workspace_id = $1 AND source = $2 AND source_id = $3`,
        [WORKSPACE, ZOOM_TRANSCRIPT_SOURCE, zoomEpisodeSourceId(MEETING_LATE_UUID, MEETING_LATE_FILE)],
      );
      expect(lateGrant[0]?.visible_to).toEqual([MEETING_LATE_GRANT]);
    },
    PG_TEST_TIMEOUT_MS,
  );
});
