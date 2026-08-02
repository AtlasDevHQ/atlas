/**
 * Grant derivation at ingest (#4770, ADR-0036 §Access control & residency).
 *
 * ADR-0036 derives a grant AT INGEST and evaluates it read-time-local: the
 * grant is a self-contained principal set frozen onto the row, and the LIVE
 * half — the revocation path — is `audience:` membership. This module is where
 * a source's visibility becomes that principal set.
 *
 * ## Three classes, three derivations, one grammar
 *
 * `chat` (#4770), `transcript` (#4965) and `email` (#4966) each get their own
 * deriver, and they do NOT share a code path even though all three end in a
 * single `audience:` token. The reason is that their SHAPES differ in the one
 * place that matters:
 *
 *   - a chat channel has a public mode, so {@link deriveChatChannelGrant}
 *     branches and `[org]` is a faithful answer for half its inputs;
 *   - a recorded meeting has none, so {@link deriveMeetingParticipantGrant} has
 *     no `[org]` arm at all and could not acquire one by accident;
 *   - a mail message has none either, and additionally cannot state its own
 *     audience exactly, so {@link deriveEmailRecipientGrant} derives a
 *     deliberate LOWER BOUND. Its header carries that decision in full — it is
 *     the class's ACL posture, not one connector's implementation note.
 *
 * A single "generic" deriver taking an optional visibility bit would have made
 * the public arm reachable from the transcript and email paths, and the failure
 * mode there is publishing a private meeting — or somebody's mail — to the whole
 * org, a leak no downstream review gate can catch, because the reviewer is shown
 * the grant Atlas derived rather than the one the vendor had. Three functions,
 * two of which cannot express the dangerous answer, is worth the duplication.
 *
 * The count is the point, incidentally: each new class adds a FUNCTION here, not
 * a branch. That is what has kept `deriveChatChannelGrant`'s public arm from
 * spreading to two classes that must never have one.
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

import { createHash } from "node:crypto";
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

// ---------------------------------------------------------------------------
// Mail messages (#4966) — the email class's grant derivation
// ---------------------------------------------------------------------------

/**
 * The `audience:` id prefix for a source-derived MAIL MESSAGE — the stored form
 * is `audience:email-message:<source>:<mailboxId>:<participantsDigest>:<messageId>`.
 *
 * A third namespace rather than a reuse, on the same lifecycle argument the
 * meeting namespace makes against the chat one, plus one that is specific to
 * this class: an email audience is not merely frozen, it is **not fully
 * knowable** (see {@link deriveEmailRecipientGrant}). A reader that treated an
 * `email-message:` audience as the same kind of object as a `chat-channel:` one
 * would be treating a lower bound as a complete set, and #4825's oversight view
 * exists precisely to tell an admin which is which.
 *
 * ## Why there are THREE segments here and two everywhere else
 *
 * The mailbox is in the token, and it is not decoration. It is the only thing
 * that tells the re-verifier WHERE to re-read the message's headers from: Graph
 * has no tenant-wide message lookup outside eDiscovery, so a message can only be
 * found inside a mailbox. Chat and transcript audiences need no equivalent
 * because a channel id and a meeting uuid are account-global.
 *
 * `mailboxId` is the Graph user OBJECT ID — a GUID — never a
 * userPrincipalName, and that is a deliberate constraint rather than a
 * convenience. A UPN is a personal email address, and this token is stored in
 * `brain_episodes.visible_to`, which is admin-readable and travels verbatim in a
 * region-migration bundle; a GUID carries the same routing information with none
 * of the disclosure. It also survives a rename, which a UPN does not.
 * `outlook/client.ts` resolves the configured mailbox (which an admin may well
 * have typed as a UPN) to its object id once per pass for exactly this reason.
 *
 * ## And why the PARTICIPANT DIGEST is in it — the forgery this closes
 *
 * A Message-ID is chosen by the SENDING system. It is not a secret: it appears
 * in the `References:` and `In-Reply-To:` headers of every reply, so anyone who
 * was ever on a thread — including an external counterparty — knows the ids of
 * the messages in it.
 *
 * Without the digest, the audience id is a pure function of (mailbox,
 * Message-ID), and both are attacker-supplied. Mail a monitored mailbox
 * claiming an existing message's id and the connector derives the SAME audience
 * id, then reconciles it against the forged `To:`/`Cc:` — and
 * `reconcileAudienceMembership` DELETES everyone outside the set it is handed.
 * The stored evidence survives (the episode insert is `ON CONFLICT DO NOTHING`,
 * so no new row lands), but the real recipients lose access to every fact drawn
 * from it, and from `/admin` that is indistinguishable from correct fail-closed
 * behaviour.
 *
 * Binding the digest into the id makes the forged message mint a DIFFERENT
 * audience — one that no episode names, and which is therefore inert — instead
 * of overwriting a real one. The property is structural: an audience id can only
 * ever be reconciled against the participant set it was minted from, because the
 * set is part of the name.
 *
 * It also gives the re-verifier something to VERIFY. `outlook/audience.ts`
 * recomputes the digest from the message it re-read and aborts on a mismatch,
 * so a duplicate or altered header set cannot silently rewrite membership on the
 * clock either.
 */
export const EMAIL_MESSAGE_AUDIENCE_NAMESPACE = "email-message" as const;

/**
 * Build the mail-message audience id (WITHOUT the `audience:` prefix — that is
 * grammar).
 *
 * `source` and `mailboxId` must both contain NO COLON, and both are ENFORCED
 * rather than documented, for the reason {@link meetingAudienceId} gives: the
 * parser splits at the first two separators, so a colon in either would
 * round-trip into the wrong halves and mint an audience nobody is a member of —
 * silently, and in the direction that mis-NAMES rather than withholds.
 *
 * `messageId` may contain colons and the parser takes the whole remainder. That
 * is not theoretical here the way it was for a Zoom uuid: RFC 5322 permits a
 * `no-fold-literal` right-hand side, so `<x@[IPv6:2001:db8::1]>` is a legal
 * Message-ID. It is rare, it is legal, and truncating it at the first colon
 * would produce a prefix that matches no real message.
 */
export function emailMessageAudienceId(
  source: string,
  mailboxId: string,
  participantsDigest: string,
  messageId: string,
): string | null {
  const cleanSource = source.trim();
  const cleanMailboxId = mailboxId.trim();
  const cleanDigest = participantsDigest.trim();
  const cleanMessageId = messageId.trim();
  if (cleanSource === "" || cleanMailboxId === "" || cleanMessageId === "") return null;
  if (cleanDigest === "" || !PARTICIPANTS_DIGEST_PATTERN.test(cleanDigest)) return null;
  if (cleanSource.includes(":") || cleanMailboxId.includes(":")) return null;
  return `${EMAIL_MESSAGE_AUDIENCE_NAMESPACE}:${cleanSource}:${cleanMailboxId}:${cleanDigest}:${cleanMessageId}`;
}

/** The shape {@link emailParticipantsDigest} produces. Pinned so a malformed
 * digest cannot reach a stored token and quietly widen the `LIKE` scan. */
export const PARTICIPANTS_DIGEST_PATTERN = /^[0-9a-f]{16}$/;

/**
 * A stable, order-independent digest of a message's participant addresses.
 *
 * Sorted and lower-cased first, so the digest depends on the SET and not on
 * header order — the same people in a different `To:` order are the same
 * audience, and a connector that said otherwise would mint a fresh audience for
 * every reply.
 *
 * Truncated to 64 bits. That is a collision bound, not a secrecy one: the point
 * is that an attacker cannot make a DIFFERENT participant set land on an
 * EXISTING audience's name, which costs ~2^64 work. It is deliberately not a
 * privacy mechanism — the addresses are in the episode body, visible to that
 * audience — so nothing here should be read as protecting them.
 */
export function emailParticipantsDigest(addresses: readonly string[]): string {
  const normalized = [...new Set(addresses.map((a) => a.trim().toLowerCase()))]
    .filter((a) => a !== "")
    .sort();
  return createHash("sha256").update(normalized.join("\n")).digest("hex").slice(0, 16);
}

/** The three halves {@link emailMessageAudienceId} joins. */
export interface EmailMessageAudienceParts {
  readonly source: string;
  /** The Graph user object id of the mailbox the message was read from. */
  readonly mailboxId: string;
  /** The participant-set digest this audience was minted from. */
  readonly participantsDigest: string;
  /** The RFC 5322 Message-ID, angle brackets already stripped. */
  readonly messageId: string;
}

/**
 * The INVERSE of {@link emailMessageAudienceId}, or `null` when the id does not
 * name a mail message at all.
 *
 * Same direction-of-safety argument as its two siblings: a second MINTER could
 * disagree with the first about which id a message gets and the disagreement
 * would be silent, but a PARSER cannot — it consumes ids the deriver already
 * produced, and if the format changed under it, it stops matching and the caller
 * falls back to opaque, which is fail-CLOSED for a disclosure decision. The
 * audience re-verifier (`outlook/audience.ts`) is the consumer, and it reads
 * both the mailbox and the message id back out of a stored grant rather than
 * re-deriving either.
 */
export function parseEmailMessageAudienceId(audienceId: string): EmailMessageAudienceParts | null {
  const namespacePrefix = `${EMAIL_MESSAGE_AUDIENCE_NAMESPACE}:`;
  if (!audienceId.startsWith(namespacePrefix)) return null;
  const rest = audienceId.slice(namespacePrefix.length);
  const firstSeparator = rest.indexOf(":");
  if (firstSeparator <= 0 || firstSeparator === rest.length - 1) return null;
  const source = rest.slice(0, firstSeparator);
  const afterSource = rest.slice(firstSeparator + 1);
  const secondSeparator = afterSource.indexOf(":");
  if (secondSeparator <= 0 || secondSeparator === afterSource.length - 1) return null;
  const mailboxId = afterSource.slice(0, secondSeparator);
  const afterMailbox = afterSource.slice(secondSeparator + 1);
  const thirdSeparator = afterMailbox.indexOf(":");
  if (thirdSeparator <= 0 || thirdSeparator === afterMailbox.length - 1) return null;
  const participantsDigest = afterMailbox.slice(0, thirdSeparator);
  // Validated on the way OUT as well as in: a token whose digest slot does not
  // hold a digest was not minted by `emailMessageAudienceId`, and treating it as
  // one would hand the re-verifier a mismatch it would report as tampering.
  if (!PARTICIPANTS_DIGEST_PATTERN.test(participantsDigest)) return null;
  return {
    source,
    mailboxId,
    participantsDigest,
    messageId: afterMailbox.slice(thirdSeparator + 1),
  };
}

/** The visibility facts one mail message exposes, normalised across vendors. */
export interface EmailMessageParticipation {
  /** The connector's stored source kind (`brain_episodes.source`), e.g. `outlook`. */
  readonly source: string;
  /** The Graph user OBJECT ID of the mailbox this copy was read from. */
  readonly mailboxId: string;
  /** The normalised RFC 5322 Message-ID — see `outlook/config.ts`. */
  readonly messageId: string;
  /**
   * True only when the vendor returned a message whose PARTICIPANT HEADERS were
   * all present and readable.
   *
   * This is the email analogue of `MeetingParticipation.rosterComplete`, and it
   * makes a narrower claim than its name suggests, so read it precisely: it says
   * the FIELDS Atlas asked for came back, not that the resulting set is everyone
   * who saw the message. The latter is unknowable and this module does not
   * pretend otherwise — see the header of {@link deriveEmailRecipientGrant}.
   *
   * A vendor that could not distinguish "this message has no Cc" from "the Cc
   * field was not returned" must pass `false`. The two are opposite situations:
   * a genuinely empty Cc narrows the audience correctly, while an OMITTED Cc
   * narrows it by dropping people who really are in it — and because the roster
   * is also what `reconcileAudienceMembership` deletes against, the second one
   * REVOKES them. `outlook/api.ts` keys this on the presence of the keys rather
   * than on their contents for exactly that reason.
   */
  readonly headersComplete: boolean;
  /**
   * The distinct participant addresses the headers yielded — sender plus To plus
   * Cc, already normalised and deduped by the caller.
   *
   * The SET, not a count. A count is a derived scalar the caller computes from a
   * collection it also passes to the reconcile, so the two could describe
   * different things; taking the set makes the deriver and the membership write
   * licensed by ONE value, and makes the digest in the audience id a property of
   * exactly the people who will be granted.
   *
   * Empty is an audience that cannot be established at all.
   */
  readonly participants: readonly string[];
}

/**
 * Derive the grant for one mail message's episode.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ██  THE UNDER-GRANT POSTURE — decided here, for the whole email class
 * ══════════════════════════════════════════════════════════════════════
 *
 * **The grant is `From` + `To` + `Cc`. `Bcc` is IGNORED — even on the copy that
 * exposes it — and forwarding is invisible. The derived grant is therefore a
 * LOWER BOUND on who has seen this content, deliberately, and never an exact
 * set.**
 *
 * ADR-0036 §T6 puts email third in the class-major order precisely because this
 * decision has to be made and every earlier class got to skip it. A chat channel
 * and a meeting have ENUMERABLE audiences: ask the vendor, get the whole set. An
 * email does not, in two independent ways.
 *
 *   - **BCC is invisible to recipients.** Alice BCCs Carol. Bob's copy of the
 *     message carries no trace of Carol at all; only Alice's Sent copy does.
 *   - **Forwarding mutates the audience after the fact**, and leaves NO signal
 *     on the original message. Bob forwards to Dave and the message Atlas
 *     ingested is byte-identical to what it was before. There is nothing to
 *     read, so this half is not even a choice — it is named here only so nobody
 *     later reads its absence as an oversight.
 *
 * ### Why ignore BCC rather than honour it where it IS visible
 *
 * The safety argument is the obvious one and it is the weaker one: under-granting
 * costs a person an affordance (they cannot see Atlas-derived facts about a mail
 * they can still read in their own client), over-granting is a leak, and §T6's
 * asymmetry says prefer the loss. True, and not the reason.
 *
 * The reason is DETERMINISM. `outlook/config.ts` keys the episode's `source_id`
 * on the RFC 5322 Message-ID specifically so that one mail to five colleagues
 * collapses to ONE episode however many of their mailboxes Atlas walks — and a
 * consequence of that collapse is that **which copy wins is undetermined**. It
 * depends on configured mailbox order and on which pass had budget left.
 *
 * `bccRecipients` is populated on the sender's copy and generally not on
 * recipients' copies. So a grant that honoured BCC would name a different set of
 * PEOPLE depending on whether the sender's mailbox happened to be walked before
 * the recipients' — the same stored row, granted differently on different days,
 * for reasons no operator could reconstruct. That is not a stricter posture or a
 * looser one; it is not a posture at all.
 *
 * ⚠️ State the property precisely, because the obvious phrasing is FALSE. The
 * grant TOKEN is not copy-independent: {@link emailMessageAudienceId} embeds the
 * mailbox, deliberately (the re-verifier needs to know where to re-read from),
 * so Alice's copy and Bob's copy mint different tokens. What ignoring BCC buys
 * is that every copy resolves to the IDENTICAL SET OF PEOPLE — and that is what
 * makes the dedupe safe, because whichever copy wins, the membership is the
 * same.
 *
 * The cost of the token being copy-dependent is real and belongs here rather
 * than in a footnote: the winning copy's mailbox is baked into the stored row,
 * so if THAT mailbox later loses `Mail.Read` (an ApplicationAccessPolicy edit, a
 * deleted user) the episode's audience fails re-verification forever and goes
 * invisible at the staleness bound — even though every other recipient's mailbox
 * still holds the message. `outlook/audience.ts` §GRAIN PROBLEM covers what that
 * does to the scan.
 *
 * ⚠️ The two decisions are therefore LOAD-BEARING ON EACH OTHER. If a future
 * change makes the grant depend on which copy was read, the Message-ID dedupe
 * has to be revisited in the same PR, and vice versa. Neither is safe alone.
 *
 * ### What this costs, plainly
 *
 * A BCC'd colleague, and anyone a message was forwarded to, cannot see facts
 * extracted from it through Atlas. They lose an Atlas affordance; they lose no
 * information they ever had, because they still have the mail.
 *
 * ### What every downstream reader must NOT conclude
 *
 * `visible_to` on an email episode does not answer "who has seen this". It
 * answers "who can Atlas prove was addressed". Any feature that reads the grant
 * as a disclosure record — an audit of who knew what, a leak investigation —
 * would be reading a lower bound as a complete set and would be wrong in the
 * direction that exonerates.
 *
 * ## The outcomes
 *
 * There is no `[org]` arm and, as with {@link deriveMeetingParticipantGrant},
 * that is the design rather than an omission. A mail message has no public mode
 * for a vendor field to report, so an org-wide arm could only ever be reached by
 * mistake — and the mistake would publish someone's mail to the whole company,
 * which no downstream review gate can catch because the reviewer is shown the
 * grant Atlas derived rather than the one the mail system had.
 *
 * - **Derivable →
 *   `[audience:email-message:<source>:<mailboxId>:<participantsDigest>:<messageId>]`.**
 *   The digest segment is NOT optional and is not decoration — it is the
 *   anti-forgery half argued at length in {@link EMAIL_MESSAGE_AUDIENCE_NAMESPACE}
 *   above, and an example that omits it reads as licence to drop it. Membership
 *   is written at ingest from the same header set this derivation was licensed
 *   by — the same set the digest is taken over — and re-verified periodically;
 *   `outlook/audience.ts` carries why a header set that CANNOT change still
 *   needs re-verification, and what the per-message audience grain costs at
 *   scale.
 *
 * - **Underivable → `null`, and the caller BLOCKS and logs.** No wider-grant
 *   fallback exists. Three things make it underivable, and all three are
 *   failures to ESTABLISH the audience rather than facts about its size:
 *     - `headersComplete === false` — the participant headers were not readable,
 *       so the set Atlas would reconcile against is not the set the message has;
 *     - zero participants — a message with no sender and no To/Cc names nobody,
 *       so there is no audience to mint;
 *     - a blank or colon-bearing source or mailbox id, or a blank message id,
 *       any of which makes the audience id ambiguous.
 *
 * ⚠️ NOT on that list, and this is the same line {@link
 * deriveMeetingParticipantGrant} draws: **a participant who resolves to no Atlas
 * user.** That is the FLAG side. A mail whose recipients are all external
 * customers has a perfectly well-established audience that currently contains
 * nobody; the faithful result is a stored, gated, invisible episode that repairs
 * itself the moment one of them gets an account. #4966's acceptance criteria ask
 * whether an unresolvable participant should block — it must not, and the reason
 * is that "unresolvable participant" and "unestablishable audience" are answers
 * to different questions. Blocking on the first would discard evidence
 * permanently on a condition that is temporary and routine.
 */
export function deriveEmailRecipientGrant(
  participation: EmailMessageParticipation,
): BrainGrant | null {
  // Checked FIRST, before the id is built, for the same reason
  // `rosterComplete` is: unreadable headers are not a malformed input — every id
  // below may be perfectly well-formed — so a reader scanning for the guard
  // would not find it among the string checks.
  if (!participation.headersComplete) return null;
  // A message that names nobody. Distinct from "names people Atlas does not
  // know", which is the flag side above and must reach the audience arm.
  if (participation.participants.length === 0) return null;

  const audienceId = emailMessageAudienceId(
    participation.source,
    participation.mailboxId,
    emailParticipantsDigest(participation.participants),
    participation.messageId,
  );
  if (audienceId === null) return null;

  const grant: BrainGrant = [`${AUDIENCE_PREFIX}${audienceId}`];
  // Belt-and-braces, the same one both siblings carry: the arm above cannot
  // construct an unusable token today, but a future edit to the id builder
  // could, and this is the one place that mistake is cheap to catch.
  //
  // Deliberately UNTESTABLE, and verified so: removing this line leaves the
  // whole suite green, because `emailMessageAudienceId` has already refused
  // every input that could produce an unusable token. That is the guard being
  // genuinely redundant TODAY rather than a test gap — writing a test for it
  // would mean reaching past the id builder to construct a state this function
  // cannot be handed, and would pin the redundancy rather than the property.
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
