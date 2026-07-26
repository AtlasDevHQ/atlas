/**
 * Grant derivation at ingest (#4770, ADR-0036 §Access control & residency).
 *
 * ADR-0036 derives a grant AT INGEST and evaluates it read-time-local: the
 * grant is a self-contained principal set frozen onto the row, and the LIVE
 * half — the revocation path — is `audience:` membership. This module is where
 * a chat source's visibility becomes that principal set.
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

/** Build the audience id (WITHOUT the `audience:` prefix — that is grammar). */
export function chatChannelAudienceId(source: string, channelId: string): string {
  return `${CHAT_CHANNEL_AUDIENCE_NAMESPACE}:${source}:${channelId}`;
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
