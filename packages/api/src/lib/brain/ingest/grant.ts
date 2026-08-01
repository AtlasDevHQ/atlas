/**
 * Grant derivation at ingest (#4770, ADR-0036 §Access control & residency).
 *
 * ADR-0036 derives a grant AT INGEST and evaluates it read-time-local: the
 * grant is a self-contained principal set frozen onto the row, and the LIVE
 * half — the revocation path — is `audience:` membership. This module is where
 * a source's visibility becomes that principal set.
 *
 * ## Two classes, two derivations, one grammar
 *
 * `chat` (#4770) and `transcript` (#4965) each get their own deriver, and they
 * do NOT share a code path even though both end in a single `audience:` token.
 * The reason is that their SHAPES differ in the one place that matters:
 *
 *   - a chat channel has a public mode, so {@link deriveChatChannelGrant}
 *     branches and `[org]` is a faithful answer for half its inputs;
 *   - a recorded meeting has none, so {@link deriveMeetingParticipantGrant} has
 *     no `[org]` arm at all and could not acquire one by accident.
 *
 * A single "generic" deriver taking an optional visibility bit would have made
 * the public arm reachable from the transcript path, and the failure mode there
 * is publishing a private meeting to the whole org — a leak no downstream
 * review gate can catch, because the reviewer is shown the grant Atlas derived
 * rather than the one the vendor had. Two functions, one of which cannot
 * express the dangerous answer, is worth the duplication.
 *
 * What they DO share is the grammar (`acl.ts`'s exported constants), the
 * usability gate ({@link isUsableGrant}), and the rule below.
 *
 * ## The one rule that is easy to get subtly, permanently wrong
 *
 * `chk_brain_episodes_grant_nonempty` admits any grant with one non-NULL,
 * non-`''` element. `['everyone']` passes it. It also grants NOBODY anything,
 * because enforcement is Postgres array overlap against reader tokens and no
 * reader token is ever malformed (`acl.ts`'s load-bearing invariant). So a
 * deriver that emits `['everyone']` writes a row that is legal, invisible, and
 * — once #4771 turns episodes into facts — refused at EVERY publish forever by
 * #4769's `GRANT_UNUSABLE` classifier, with no repair UI until #4772.
 *
 * That is why this module builds every grant token from `acl.ts`'s exported
 * constants — `ORG_PRINCIPAL` and `AUDIENCE_PREFIX` are the two arms a chat
 * source mints; `ROLE_PREFIX`/`USER_PREFIX` exist there for the entry points
 * that need them — never from a literal, and why {@link isUsableGrant} is
 * applied at the ingest seam as defence in depth. #4769's promotion refusal is
 * meant to be the second line, not the first — a refusal that fires in
 * practice is a live trap, not defence in depth. (#4797 tracks the
 * observability half: a fully-malformed grant is invisible to every reader, so
 * nobody is holding the row to log about it.)
 *
 * ## What this module deliberately does NOT do
 *
 * It never REJECTS a grant read from storage, and it is never called on the
 * import path. `acl.ts`'s header forbids being stricter than the CHECK at rest
 * or at import, because a row Postgres legally stores but Atlas refuses is a
 * workspace that cannot be migrated between regions. This is a WRITE-SIDE
 * constructor: it chooses what to mint. Choosing well is unconstrained;
 * refusing what already landed is not.
 */

import {
  AUDIENCE_PREFIX,
  ORG_PRINCIPAL,
  parseGrant,
} from "@atlas/api/lib/brain/acl";
import type { BrainGrant } from "@atlas/api/lib/brain/types";

/**
 * The `audience:` id prefix for a source-derived chat channel — the stored
 * form is `audience:chat-channel:<source>:<channelId>`.
 *
 * Namespaced by SOURCE because `audience_id` is workspace-scoped but NOT
 * source-scoped: a Slack channel `C123` and a (future) Teams channel `C123`
 * would otherwise mint the same audience and merge two unrelated membership
 * sets. `fact_audience_member` has no column to tell them apart, so the
 * namespace has to live in the id.
 */
export const CHAT_CHANNEL_AUDIENCE_NAMESPACE = "chat-channel" as const;

/**
 * Build the audience id (WITHOUT the `audience:` prefix — that is grammar).
 *
 * `source` must contain NO COLON. It is joined on `:` and
 * {@link parseChatChannelAudienceId} splits at the first one, so a source like
 * `slack:enterprise` would round-trip to `{ source: "slack", channelId:
 * "enterprise:C0…" }` — silently, and in the direction that mis-NAMES rather
 * than withholds. `channelId` may contain colons; the parser takes the whole
 * remainder. Every source today is a bare vendor token (`slack`), so this is a
 * constraint on the next one.
 */
export function chatChannelAudienceId(source: string, channelId: string): string {
  return `${CHAT_CHANNEL_AUDIENCE_NAMESPACE}:${source}:${channelId}`;
}

/** The two halves {@link chatChannelAudienceId} joins. */
export interface ChatChannelAudienceParts {
  readonly source: string;
  readonly channelId: string;
}

/**
 * The INVERSE of {@link chatChannelAudienceId} — take an audience id apart
 * again, or `null` when it does not name a chat channel at all.
 *
 * Added for #4825's oversight view, which has to answer "did the admin
 * configure this audience, or did Atlas discover it?" — and answers it by
 * testing the channel id against the install config's channel list.
 *
 * It reads the id apart rather than re-BUILDING one to compare against, and
 * that direction is the whole reason it can live here safely. {@link
 * deriveChatChannelGrant}'s comment warns against calling
 * `chatChannelAudienceId` from a second place, because a second MINTER can
 * disagree with the first about which id a channel gets and the disagreement is
 * silent. A parser cannot: it consumes ids the deriver already produced, and if
 * the format changed under it, it stops matching and the labels fall back to
 * opaque — which is the fail-CLOSED direction for a disclosure decision. The
 * round trip is pinned by test so that fallback is never reached by accident.
 *
 * `channelId` takes the REMAINDER after the second separator rather than
 * splitting on every `:`. A vendor id containing a colon would otherwise be
 * truncated into a prefix that matches no configured channel — again fail-closed,
 * but for a reason nobody could find.
 */
export function parseChatChannelAudienceId(audienceId: string): ChatChannelAudienceParts | null {
  const namespacePrefix = `${CHAT_CHANNEL_AUDIENCE_NAMESPACE}:`;
  if (!audienceId.startsWith(namespacePrefix)) return null;
  const rest = audienceId.slice(namespacePrefix.length);
  const separator = rest.indexOf(":");
  if (separator <= 0 || separator === rest.length - 1) return null;
  return { source: rest.slice(0, separator), channelId: rest.slice(separator + 1) };
}

/** The visibility facts a chat channel exposes, normalised across vendors. */
export interface ChatChannelVisibility {
  /** The connector class (`brain_episodes.source`), e.g. `slack`. */
  readonly source: string;
  /** The vendor's channel identifier. */
  readonly channelId: string;
  /**
   * True when the channel is private / invite-only at the source.
   *
   * A vendor that cannot determine this must pass `true`. "Unknown visibility"
   * and "public" are opposite situations and must not share a branch: guessing
   * public publishes an invite-only channel's contents to the whole org, and
   * that is a leak no review gate downstream can catch, because the reviewer
   * is shown the grant Atlas derived rather than the one Slack had.
   */
  readonly isPrivate: boolean;
}

/**
 * Derive the grant for one chat channel's episodes.
 *
 * - **Public channel → `[org]`.** Everybody in the workspace can already read
 *   it at the source, so the org-wide principal is the faithful mapping — and
 *   ADR-0036 requires the public majority to carry an EXPLICIT `org`, never an
 *   implicit one, so a forgotten grant can never READ as public.
 * - **Private channel → `[audience:chat-channel:<source>:<id>]`.** The grant
 *   names an Atlas-owned audience whose membership `fact_audience_member`
 *   carries; ADR-0036 routes sensitive facts to a synced `audience:` precisely
 *   so revocation flows through membership live rather than waiting for
 *   re-ingest.
 *
 *   Membership is populated by #4801's sync (`lib/brain/audience/`), on its own
 *   periodic fiber. It does NOT re-derive anything: it passes the source's
 *   visibility bit to THIS function and reads the answer out of `parseGrant` —
 *   both the audience id and the public-vs-private branch. So the set it syncs
 *   is by construction the set the facts were granted to, and **a visibility arm
 *   added here is followed by the sync for free.** Two independent derivations
 *   would agree until one changed, and on that day membership would be written
 *   for an audience no fact names — every private fact silently invisible again
 *   while the sync reported success. If you ever tempt yourself into calling
 *   {@link chatChannelAudienceId} from a second place, or into re-deciding
 *   `isPrivate` outside this function, that property is what you are spending.
 *
 *   The naming is what makes the audience arm SAFE to get wrong-ish: membership
 *   can be written, rewritten, or repaired at any time without touching a stored
 *   row, because the grant names a set and the set is resolved live. Contrast
 *   the failure this module exists to prevent — a structurally malformed token
 *   is unrepairable without editing every row that carries it.
 *
 * Returns `null` when no usable grant can be derived — a blank channel id or a
 * blank source, either of which would make the audience id ambiguous.
 * ADR-0036 §T6's block-vs-flag asymmetry puts grant-derivation failure on the
 * BLOCK side: the caller abandons that channel's whole pass (its mark
 * preserved, a warning surfaced) and never falls back to a wider grant. There is no safe default here — `[org]` would publish content
 * whose audience Atlas failed to establish.
 */
export function deriveChatChannelGrant(visibility: ChatChannelVisibility): BrainGrant | null {
  if (!visibility.isPrivate) return [ORG_PRINCIPAL];

  const channelId = visibility.channelId.trim();
  const source = visibility.source.trim();
  if (channelId === "" || source === "") return null;

  const grant: BrainGrant = [
    `${AUDIENCE_PREFIX}${chatChannelAudienceId(source, channelId)}`,
  ];
  // Belt-and-braces: the arm above cannot construct an unusable token today
  // (both halves are non-empty by the guard), but a future edit to the id
  // builder could, and this is the one place that mistake is cheap to catch.
  return isUsableGrant(grant) ? grant : null;
}

// ---------------------------------------------------------------------------
// Meeting transcripts (#4965) — the transcript class's grant derivation
// ---------------------------------------------------------------------------

/**
 * The `audience:` id prefix for a source-derived MEETING — the stored form is
 * `audience:meeting:<source>:<meetingId>`.
 *
 * A separate namespace from {@link CHAT_CHANNEL_AUDIENCE_NAMESPACE} rather than
 * a reuse, because the two audiences have different LIFECYCLES and the
 * namespace is what stops a future reader from treating them alike. A chat
 * channel's roster is mutable and open-ended; a meeting's participant list is
 * closed the moment the meeting ends. `parseChatChannelAudienceId` returning
 * `null` for a meeting id — and vice versa — is the property #4825's oversight
 * view depends on to label them differently.
 *
 * Namespaced by SOURCE for the same reason chat is: `audience_id` is
 * workspace-scoped but NOT source-scoped, and a Zoom meeting and a (future)
 * Google Meet meeting could mint the same id. `fact_audience_member` has no
 * column to tell them apart, so the namespace has to live in the id.
 */
export const MEETING_AUDIENCE_NAMESPACE = "meeting" as const;

/**
 * Build the meeting audience id (WITHOUT the `audience:` prefix — that is
 * grammar).
 *
 * `source` must contain NO COLON, and unlike {@link chatChannelAudienceId} that
 * is ENFORCED rather than merely documented: this function returns `null` on a
 * colon-bearing source instead of round-tripping it into the wrong halves.
 * The chat builder's prose constraint was safe because `slack` was the only
 * source that would ever reach it; the transcript class ships with a second
 * vendor already on the roadmap (Meet, Fireflies), so the constraint acquires a
 * real chance to be violated and a silent mis-NAMING is the failure mode —
 * `zoom:eu` would round-trip to `{ source: "zoom", meetingId: "eu:4kd8…" }`,
 * minting an audience nobody is a member of.
 *
 * `meetingId` may contain colons in principle; the parser takes the whole
 * remainder. (Zoom's cannot — a meeting uuid is base64 — but the id grammar is
 * per-vendor and the next vendor's is not this one's.)
 */
export function meetingAudienceId(source: string, meetingId: string): string | null {
  const cleanSource = source.trim();
  const cleanMeetingId = meetingId.trim();
  if (cleanSource === "" || cleanMeetingId === "") return null;
  if (cleanSource.includes(":")) return null;
  return `${MEETING_AUDIENCE_NAMESPACE}:${cleanSource}:${cleanMeetingId}`;
}

/** The two halves {@link meetingAudienceId} joins. */
export interface MeetingAudienceParts {
  readonly source: string;
  readonly meetingId: string;
}

/**
 * The INVERSE of {@link meetingAudienceId}, or `null` when the id does not name
 * a meeting at all.
 *
 * Same direction-of-safety argument as {@link parseChatChannelAudienceId}: a
 * second MINTER could disagree with the first about which id a meeting gets and
 * the disagreement would be silent, but a PARSER cannot — it consumes ids the
 * deriver already produced, and if the format changed under it, it stops
 * matching and the caller falls back to opaque, which is fail-CLOSED for a
 * disclosure decision. The audience re-verifier (`zoom/audience.ts`) is the
 * consumer: it reads the meeting id back out of a stored grant rather than
 * re-deriving one, so it can only ever re-verify audiences that were actually
 * minted.
 */
export function parseMeetingAudienceId(audienceId: string): MeetingAudienceParts | null {
  const namespacePrefix = `${MEETING_AUDIENCE_NAMESPACE}:`;
  if (!audienceId.startsWith(namespacePrefix)) return null;
  const rest = audienceId.slice(namespacePrefix.length);
  const separator = rest.indexOf(":");
  if (separator <= 0 || separator === rest.length - 1) return null;
  return { source: rest.slice(0, separator), meetingId: rest.slice(separator + 1) };
}

/** The visibility facts a recorded meeting exposes, normalised across vendors. */
export interface MeetingParticipation {
  /** The connector's stored source kind (`brain_episodes.source`), e.g. `zoom`. */
  readonly source: string;
  /** The vendor's identifier for this meeting INSTANCE (not the series). */
  readonly meetingId: string;
  /**
   * True only when the participant roster was enumerated COMPLETELY.
   *
   * A vendor that could not finish the enumeration — a paging error, an
   * exhausted retry budget, a per-cycle page cap — must pass `false`, and must
   * NOT pass `true` with a partial list. This is the single most load-bearing
   * field in this module, for a reason that is invisible from the grant alone:
   * the roster does not merely GRANT, it is also what
   * `reconcileAudienceMembership` DELETES against. A partial roster reaching
   * that reconcile is indistinguishable from a mass removal, so it would revoke
   * every member it failed to fetch — and because episodes are gated rather
   * than deleted, the damage looks exactly like correct fail-closed behaviour
   * from every surface. `audience/sync.ts` makes the same complete-or-abort
   * argument for chat rosters; this is the ingest-side half of it.
   */
  readonly rosterComplete: boolean;
}

/**
 * Derive the grant for one recorded meeting's transcript episodes.
 *
 * **There is no public arm, and that is the design.** `deriveChatChannelGrant`
 * branches on `isPrivate` because a Slack channel genuinely has two modes and
 * the public one is faithfully `[org]`. A recorded meeting does not: its
 * audience is the people who were in it, always, and Zoom exposes no
 * "everyone at the company may watch this" bit that would license `[org]`.
 * Adding such an arm later on the strength of some vendor field that LOOKS like
 * one is the leak this module exists to prevent — the reviewer downstream is
 * shown the grant Atlas derived, not the one the vendor had, so nothing catches
 * it.
 *
 * So the only outcomes are the audience and the block:
 *
 * - **Derivable → `[audience:meeting:<source>:<meetingId>]`.** The grant names
 *   an Atlas-owned audience whose membership `fact_audience_member` carries.
 *   Membership is written at ingest from the same complete roster this
 *   derivation was licensed by, and re-verified periodically — see
 *   `zoom/audience.ts` for why a set of humans that CANNOT change still needs
 *   re-verification (the humans are fixed; which of them are Atlas users in
 *   this workspace is not, and `acl.ts` suppresses an audience nobody has
 *   verified within `ATLAS_BRAIN_AUDIENCE_MAX_STALENESS_HOURS`).
 *
 * - **Underivable → `null`, and the caller BLOCKS and logs.** ADR-0036 §T6 puts
 *   grant-derivation failure on the BLOCK side of the block-vs-flag asymmetry:
 *   the caller abandons that meeting (its mark preserved, a warning surfaced)
 *   and never falls back to a wider grant. There is no safe default — `[org]`
 *   would publish a meeting whose audience Atlas failed to establish.
 *
 * Three things make it underivable, and they are all failures to ESTABLISH the
 * audience rather than facts about its size:
 *   - an incomplete roster (see {@link MeetingParticipation.rosterComplete});
 *   - a blank meeting id or a blank source, either of which makes the audience
 *     id ambiguous;
 *   - a source containing a colon, which would mis-split on the way back out.
 *
 * ⚠️ What is deliberately NOT on this list: **a roster that resolves to no
 * Atlas users.** That is the FLAG side, and conflating the two is the specific
 * mistake this asymmetry exists to prevent. A meeting of five external guests
 * has a perfectly well-established audience that currently contains nobody; the
 * faithful result is a stored, gated, invisible episode — not a block. Blocking
 * it would discard evidence permanently on a condition that repairs itself the
 * moment one of those people gets an Atlas account, which is exactly what the
 * `audience:` indirection buys. `membership.ts` makes the same call from the
 * other end: "the channel resolved to nobody" reconciles to an empty audience
 * rather than skipping the delete.
 */
export function deriveMeetingParticipantGrant(
  participation: MeetingParticipation,
): BrainGrant | null {
  // Checked FIRST, before the id is even built. An incomplete roster is not a
  // malformed input — every id below may be perfectly well-formed — so a
  // reader scanning for the guard would not find it among the string checks.
  if (!participation.rosterComplete) return null;

  const audienceId = meetingAudienceId(participation.source, participation.meetingId);
  if (audienceId === null) return null;

  const grant: BrainGrant = [`${AUDIENCE_PREFIX}${audienceId}`];
  // Belt-and-braces, the same one `deriveChatChannelGrant` carries: the arm
  // above cannot construct an unusable token today, but a future edit to the id
  // builder could, and this is the one place that mistake is cheap to catch.
  return isUsableGrant(grant) ? grant : null;
}

/**
 * Does this grant name at least one principal a reader could ever match?
 *
 * The write-side gate that keeps #4769's `GRANT_UNUSABLE` promotion refusal a
 * genuine second line of defence. Uses `parseGrant` — the SAME parser the
 * refusal classifier uses — so the two can never disagree about what "usable"
 * means; a hand-rolled shape check here would drift the first time the grammar
 * gained an arm.
 */
export function isUsableGrant(grant: readonly unknown[]): boolean {
  return parseGrant(grant).principals.length > 0;
}
