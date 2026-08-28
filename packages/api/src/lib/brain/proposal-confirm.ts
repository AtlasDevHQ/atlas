/**
 * Shared contract for the `proposeFact` confirm-before-write flow (#5482,
 * implementing [ADR-0036 §T7]'s `proposeFact` verb under §T9's 2026-08-27b
 * entry-gate amendment).
 *
 * `proposeFact` asserts a NET-NEW claim — the thing the four correction verbs
 * structurally cannot do, since each of them presupposes an existing tier-2
 * fact. Like `correct_fact` since #5496 it **stages**: the tool returns a
 * `needs_confirmation` result carrying a {@link ProposeFactConfirmRequest}, the
 * chat surface renders a confirm card, and the proposal reaches
 * `reconcileFacts` at `POST /api/v1/brain-proposals/confirm` after the human
 * clicks — never silently in the agent loop.
 *
 * This module is the single source of truth for that wire shape + the
 * human-facing summary, so the staging tool and the confirming endpoint cannot
 * drift.
 *
 * ## Why a proposal needs the gate at all, when its output is only a DRAFT
 *
 * The obvious reading of "draft-only" is that the review gate is the safety and
 * an entry gate is belt-and-braces. That reading is wrong on this verb, and
 * #5482's own dependency note is where it is written down: `reconcile.ts`
 * deliberately does not filter corroboration by review state, so a proposal that
 * AGREES with an existing published fact writes a `provenance` edge
 * **immediately, unreviewed** — feeding the distinct-source corroboration count
 * and resetting the staleness anchor. Draft-only is true for NOVEL claims and
 * false for agreeing ones, and the agreeing half is the stealthier of the two:
 * nothing appears on the review surface for a human to catch.
 *
 * So the gate is not redundant with the review gate; it is the only gate the
 * corroboration path has. Both halves stage — see the header on
 * `lib/brain/proposal.ts`, which is where the single entry point that makes
 * that structural lives.
 *
 * ## It mirrors the correction gate; it does not re-derive it
 *
 * `lib/brain/correction-confirm.ts` (#5496) is the shape, and both specialize
 * the ONE crypto implementation in `lib/confirm-token.ts` — differing only in
 * their `typ` domain separator, their TTL env var, and what they bind. The
 * three load-bearing properties are inherited rather than re-argued: token
 * binding, server-side re-validation at the confirm endpoint (which is NOT a
 * trusted fast-path), and the nonce burn that rejects a replay or a looping
 * agent.
 *
 * ## Why THIS card previews the claim, where the correction card refuses to
 *
 * `correction-confirm.ts` deliberately does not render the target claim's
 * subject/predicate/object: reading it takes an ACL-gated query, so previewing
 * it means a second visibility decision on the one surface whose whole job is
 * to be trustworthy.
 *
 * A proposal has no such problem, and the asymmetry is worth stating rather
 * than leaving as an apparent inconsistency. There is no stored target to read:
 * the claim is text the human's own turn produced, echoed back to them. Not
 * previewing it would leave nothing to consent TO — the verb and the fact id
 * are the whole substance of a correction, whereas the whole substance of a
 * proposal is its wording. The card must show exactly what will be asserted, so
 * a confidently wrong sentence in the agent's prose cannot get a differently
 * worded claim confirmed than the one described.
 */
import {
  burnConfirmNonce,
  claimsHash,
  mintConfirmToken,
  verifyConfirmToken,
  type ConfirmClaims,
  type ConfirmTokenKind,
  type ConfirmTokenRejection,
  type ConfirmTokenVerification,
  type MintConfirmTokenOptions,
} from "@atlas/api/lib/confirm-token";

/**
 * The proposal gate's token identity. `typ` is the domain separator carried in
 * the signed header: it is why a REST-write or brain-CORRECTION confirm token —
 * signed with the same keyset — cannot be presented here, and vice versa. A
 * correction token proves a human agreed to change an existing claim; it must
 * not be spendable on asserting a new one.
 */
const PROPOSAL_CONFIRM_KIND: ConfirmTokenKind = {
  typ: "AtlasBrainProposalConfirm",
  ttlEnvVar: "ATLAS_BRAIN_PROPOSAL_CONFIRM_TTL_SECONDS",
};

/**
 * The proposed claim as it travels on the wire.
 *
 * `validFrom` is an ISO-8601 string here, not a `Date`, and that is load-bearing
 * for `correction-confirm.ts`'s reason exactly: the token binds a hash of THIS
 * shape, so mint and verify must canonicalize identical bytes. A `Date` would
 * serialize one way at staging and (after a JSON round-trip through the browser)
 * another at confirm, and the binding check would reject every proposal that
 * carried one. The conversion to `Date` happens once, past the gate, on its way
 * into `proposeFact`.
 */
export interface ProposalClaim {
  /** The claim's subject surface, as the human stated it. */
  readonly subject: string;
  /** The claim's predicate surface. */
  readonly predicate: string;
  /** The claim's object surface — the asserted value. */
  readonly object: string;
  /** When the claim began to hold. ISO-8601 with offset. */
  readonly validFrom?: string;
  /** The user's stated rationale, recorded verbatim in the proposal episode. */
  readonly reason?: string;
}

/**
 * The session a staged proposal originated in (#5486) — mirrored from
 * `lib/brain/proposal.ts`'s `ProposalSessionRef` as a wire shape rather than
 * imported, because THIS module is the wire contract and that one is the verb.
 * Stamped by the staging tool from the request context (never by the model —
 * the tool's `inputSchema` does not admit it), bound into the confirm token,
 * and re-validated against the conversation's ownership at the write.
 */
export interface ProposalSessionWireRef {
  /** The conversation the proposal was staged in. */
  readonly conversationId: string;
}

/**
 * The replay payload for a staged proposal — the exact body the confirm card
 * POSTs to `POST /api/v1/brain-proposals/confirm`.
 *
 * Mirror this shape on the web-local types
 * (`packages/web/src/ui/lib/propose-fact-types.ts`); the card POSTs it verbatim
 * and never inspects `token` (nor `session`).
 */
export interface ProposeFactConfirmRequest extends ProposalClaim {
  /**
   * The originating session, when the proposal was staged in one (#5486).
   * Travels so the confirm endpoint can hand `proposeFact` the session whose
   * episode the fact derives from and whose ACL context seeds its grant.
   * Bound in the token: a payload whose session was added, dropped, or
   * swapped after staging fails verification, so the provenance the human
   * consented to is the provenance that lands.
   */
  readonly session?: ProposalSessionWireRef;
  /**
   * Server-signed, single-use confirm token binding this exact staged claim to
   * `(workspace, canonical subject+predicate+object+validFrom+reason, nonce,
   * exp)`. Minted by {@link mintProposalConfirmToken} at staging; required +
   * verified + burned by the confirm endpoint. Opaque to the card.
   */
  readonly token: string;
}

/** The binding a proposal confirm token is signed over and re-verified against. */
export interface ProposalConfirmBinding {
  readonly workspaceId: string;
  /** Bound via a canonical hash, so the token stays small and leaks nothing readable. */
  readonly claim: ProposalClaim;
  /**
   * The originating session, hashed into the same binding (#5486). Absent and
   * `undefined` hash identically — a session-less proposal's token is
   * byte-compatible with the pre-#5486 shape, so nothing staged before this
   * landed fails its own confirm.
   */
  readonly session?: ProposalSessionWireRef;
}

export type MintProposalConfirmTokenOptions = MintConfirmTokenOptions;
export type ProposalConfirmTokenRejection = ConfirmTokenRejection;
export type ProposalConfirmTokenVerification = ConfirmTokenVerification;

/**
 * The signed claims.
 *
 * ONE hash over the WHOLE claim, where `correctionClaims` binds `factId` and
 * `verb` as readable claims beside its payload hash. Two reasons, and neither is
 * economy. A correction's substance is an id and an enum — short, non-secret,
 * and useful in a server log; a proposal's substance is up to three 2,000-char
 * free-text surfaces, which have no business travelling readable through a
 * browser in a token nobody is meant to inspect. And every slot here is
 * equally load-bearing: there is no field a tamper could change that would not
 * change what the human agreed to assert, so there is nothing to gain from
 * separating them. Swap any one of subject, predicate, object, `validFrom` or
 * `reason` after staging and the binding check fails.
 *
 * The claim is normalized before hashing rather than hashed as received: `{}`,
 * `{ reason: undefined }` and a claim with an absent `reason` are the same
 * proposal and must hash the same, or a client that round-trips the staged JSON
 * (dropping `undefined` keys, as `JSON.stringify` does) would fail its own
 * confirm. `canonicalize` already drops `undefined` values, so this is
 * belt-and-braces on the fields where the difference is observable.
 */
function proposalClaims(binding: ProposalConfirmBinding): ConfirmClaims {
  const { subject, predicate, object, validFrom, reason } = binding.claim;
  return {
    /** Workspace (org) id. */
    w: binding.workspaceId,
    /**
     * sha256(canonical subject + predicate + object + validFrom + reason
     * + sessionConversationId). The session id joins the one hash rather than
     * travelling as a readable claim, on the same grounds as the claim text:
     * every bound field is equally load-bearing — a swapped session changes
     * whose conversation becomes the fact's provenance and whose ACL context
     * seeds its grant, which changes what the human agreed to exactly as a
     * swapped object would. Spread-when-present, so a session-less binding
     * hashes byte-identically to the pre-#5486 shape.
     */
    ch: claimsHash({
      subject,
      predicate,
      object,
      ...(validFrom !== undefined ? { validFrom } : {}),
      ...(reason !== undefined ? { reason } : {}),
      ...(binding.session !== undefined
        ? { sessionConversationId: binding.session.conversationId }
        : {}),
    }),
  };
}

/**
 * Mint a single-use confirm token binding a staged proposal.
 *
 * Throws when no signing key is configured — the human-in-the-loop gate must NOT
 * degrade silently to an unsigned (forgeable) token. The staging tool maps the
 * throw to a structured "can't stage this proposal" result, so the operator
 * gates the verb on real key material rather than discovering it after a forged
 * confirm.
 */
export function mintProposalConfirmToken(
  binding: ProposalConfirmBinding,
  options: MintProposalConfirmTokenOptions = {},
): string {
  return mintConfirmToken(PROPOSAL_CONFIRM_KIND, proposalClaims(binding), options);
}

/**
 * Verify a confirm token against the binding re-derived from THIS confirm
 * request. Pure — the caller {@link burnProposalConfirmNonce}s the returned
 * nonce once the rest of validation passes. The route maps every `ok: false` arm
 * to one neutral 400 so an attacker cannot probe which check tripped.
 */
export function verifyProposalConfirmToken(
  token: string,
  expected: ProposalConfirmBinding,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): ProposalConfirmTokenVerification {
  return verifyConfirmToken(PROPOSAL_CONFIRM_KIND, token, proposalClaims(expected), nowSeconds);
}

/**
 * Atomically consume a proposal confirm nonce. `true` = newly burned (proceed),
 * `false` = already burned (a replay — reject). MUST be called synchronously with
 * no intervening `await` between verification and the write, so two concurrent
 * replays cannot both pass.
 *
 * The nonce store is shared with every other confirm gate, which is safe and
 * deliberate: `mintConfirmToken` draws 16 random bytes per token, so a
 * collision across gates is not a reachable state, and one store means one
 * expiry sweep rather than a per-gate copy that rots.
 */
export const burnProposalConfirmNonce = burnConfirmNonce;

/**
 * A concise, factual one-line description of a staged proposal for the card
 * header, e.g. `propose — record "Ana" · "is the DRI for" · "billing" as a draft`.
 *
 * Derives ONLY from the claim the tool staged; it takes no agent prose, so the
 * card cannot misstate what will be asserted even when the agent's surrounding
 * sentence is wrong. See the module header for why this one previews the claim
 * where the correction card does not.
 */
export function buildProposalSummary(claim: ProposalClaim): string {
  return `propose — record ${JSON.stringify(claim.subject)} · ${JSON.stringify(
    claim.predicate,
  )} · ${JSON.stringify(claim.object)} as a draft for review`;
}
