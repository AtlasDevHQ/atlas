/**
 * The staged-write gate, written once (#5571).
 *
 * Every agent write onto the fact graph goes the same way: the tool STAGES onto
 * a confirm card and touches nothing, a human clicks Confirm, and the write
 * fires at a confirm endpoint that re-derives everything server-side. Two verbs
 * do this today — `proposeFact` (#5482) and `correct_fact` (#5496) — and until
 * this module the sequence existed only as two ~480-line routes with the same
 * ladder copied into both, plus the staging preamble copied into each tool.
 *
 * An invariant that lives in two copies is an invariant nobody can change. The
 * ordering below is security-critical (see {@link verifyAndBurnStagedConfirm}),
 * and a third verb deriving it by reading two routes side by side is how the
 * copy that rots becomes the one that ships. `registry.test.ts` already pins the
 * confirm-capable delta as an EXACT set so a third verb has to be named before
 * it ships; this module is what that third verb then INHERITS instead of
 * copying.
 *
 * ## What is here, and what deliberately is not
 *
 * Here: the {@link StagedVerb} descriptor, the degradation preamble, actor
 * re-resolution, and the verify→burn gate. All of it transport-free — this is
 * `lib/`, so it holds no status codes and no `Response` (CLAUDE.md's layering
 * note; `api/routes/shared-correction.ts`'s header makes the same split for
 * correction refusals). The HTTP ladder that maps these tagged results onto
 * status codes and bodies is `api/routes/shared-staged-confirm.ts`.
 *
 * Not here: the crypto. {@link import("@atlas/api/lib/confirm-token")} is the
 * one derivation of the HMAC scheme, the canonicalization, the binding check
 * and the nonce store, and it stays the deep core it already is. This module
 * sits ABOVE it and adds the sequencing every gate shares; it does not
 * re-derive a byte of the scheme.
 *
 * Not here either: what each verb binds, means, or writes. That is the
 * adapter's, and the adapters are `staged-propose.ts` and `staged-correct.ts`.
 */
import {
  burnConfirmNonce,
  mintConfirmToken,
  verifyConfirmToken,
  type ConfirmClaims,
  type ConfirmTokenKind,
  type ConfirmTokenRejection,
  type MintConfirmTokenOptions,
} from "@atlas/api/lib/confirm-token";
import { detectAuthMode } from "@atlas/api/lib/auth/detect";
import { getInternalDB, hasInternalDB } from "@atlas/api/lib/db/internal";
import type { AtlasUser } from "@atlas/api/lib/auth/types";
import {
  BrainReaderIdentityError,
  resolveBrainReaderContext,
} from "@atlas/api/lib/brain/reader-context";
// Type-only, so `acl.ts` never enters the module graph a route test mocks.
import type { BrainPrincipalContext } from "@atlas/api/lib/brain/acl";

/**
 * What one staged verb says at each rung, on both of its surfaces.
 *
 * Per-verb rather than generic, and that is the point of holding it in a
 * descriptor: CLAUDE.md forbids "something went wrong", so "nothing was
 * recorded" (a proposal) and "the fact was not changed" (a correction) are
 * genuinely different sentences about genuinely different consequences. What
 * the seam owns is that each sentence is said at exactly one rung, in the same
 * order, for every verb.
 *
 * The two surfaces are split because they address different readers, not
 * because the copy drifted. {@link StagedVerbStagingCopy} is read by the MODEL
 * mid-turn, so it says what the agent should do next ("nothing was recorded; do
 * not claim it was"); {@link StagedVerbConfirmCopy} is read by a HUMAN who just
 * clicked Confirm, so it says what to do about the card in front of them. One
 * descriptor holds both, so a verb's whole voice is legible in one place.
 */
export interface StagedVerbCopy {
  /** What the staging TOOL tells the model when it refuses to stage. */
  readonly staging: StagedVerbStagingCopy;
  /** What the confirm ENDPOINT returns to the card. */
  readonly confirm: StagedVerbConfirmCopy;
}

/**
 * The staging tool's degraded paths. Each rides beside a machine-readable
 * `reason`, so a caller can branch without pattern-matching English — the
 * contract `searchBrain` set and both write verbs mirror.
 *
 * The reason CODES stay in the tools: `proposeFact`'s set is `correct_fact`'s
 * minus `refused`, because staging a proposal runs no authority gate to be
 * refused BY, and a reason nothing can emit is exactly the stale contract those
 * objects exist to keep honest.
 */
export interface StagedVerbStagingCopy {
  /** This deployment has no internal database, so there is no brain. */
  readonly storeUnavailable: string;
  /** No workspace is bound to this session. */
  readonly noWorkspace: string;
  /** The actor's identity could not be resolved for the workspace. */
  readonly readerUnresolved: string;
  /** Resolving the actor threw for some other reason. */
  readonly actorFailed: string;
  /** No signing key, so the gate cannot be enforced — refuse rather than stage. */
  readonly mintFailed: string;
}

/** The confirm endpoint's ladder, one sentence per rung. */
export interface StagedVerbConfirmCopy {
  /** No active workspace on the request. */
  readonly noWorkspace: string;
  /** This deployment has no internal database, so there is no brain. */
  readonly storeUnavailable: string;
  /** The actor's identity could not be resolved for the workspace. */
  readonly readerUnresolved: string;
  /** Resolving the actor threw for some other reason. */
  readonly actorFailed: string;
  /** No signing key configured — an operator misconfiguration, not a bad token. */
  readonly tokenUnverifiable: string;
  /** The ONE neutral rejection every attacker-probeable token failure maps to. */
  readonly tokenInvalid: string;
  /** The token verified but its nonce was already spent. */
  readonly tokenReplayed: string;
  /** The workspace's alias vocabulary is half-rebuilt. */
  readonly vocabularyIncomplete: string;
  /** The verb threw on its way to the write. */
  readonly executeFailed: string;
}

/**
 * One staged verb's identity: what its token is, what that token binds, and how
 * the gate talks about it.
 *
 * `claims` is the only behavioural slot, and it is the one thing the seam must
 * NOT generalize. A gate decides what its token binds and re-derives that
 * binding server-side at confirm time; `confirm-token.ts` only guarantees that
 * a token whose claims differ from the expected ones is refused. Hoisting a
 * "standard" claim set here would make every verb bind whatever the first two
 * happened to need.
 *
 * @typeParam TBinding - what this verb re-derives from a confirm request and
 *   signs at staging. The same type on both sides by construction, which is the
 *   defect the two routes could previously have: mint one shape, verify another.
 */
export interface StagedVerb<TBinding> {
  /** Log/telemetry label, e.g. `"proposal"`. Never rendered to a user. */
  readonly name: string;
  /** The `typ` domain separator + TTL env var. See {@link ConfirmTokenKind}. */
  readonly kind: ConfirmTokenKind;
  /** Project this verb's binding onto the claims its token signs. */
  readonly claims: (binding: TBinding) => ConfirmClaims;
  /** What this verb says on each surface, at each rung. */
  readonly copy: StagedVerbCopy;
}

// ─────────────────────────────────────────────────────────────────────
//  The degradation preamble + actor re-resolution
// ─────────────────────────────────────────────────────────────────────

/**
 * Which degradation is reported when BOTH hold — no internal database AND no
 * active workspace.
 *
 * Not a stylistic choice, and not something to unify away. A self-hosted
 * deployment with no `DATABASE_URL` is exactly the case where both are absent,
 * and there the actionable sentence is the STORE one: "no internal database
 * configured" tells an operator what to fix, where "no active workspace" sends
 * them to a workspace picker that cannot exist. So the TOOLS ask
 * `"store-first"`, because their answer is read by a human through the agent.
 *
 * The confirm ROUTES ask `"workspace-first"`, because that is the HTTP contract
 * they already have (400 `no_workspace` before 503 `brain_unavailable`) and
 * #5571 is a refactor: the wire does not move. Both orders are therefore real,
 * and naming the axis is how the difference stays a decision instead of a
 * divergence someone flattens by accident.
 */
export type StagedPreambleOrder = "store-first" | "workspace-first";

/** Why the preamble refused, or the resolved actor when it did not. */
export type StagedActorResolution =
  | { readonly ok: true; readonly ctx: BrainPrincipalContext }
  | { readonly ok: false; readonly failure: "no-workspace" }
  | { readonly ok: false; readonly failure: "store-unavailable" }
  | { readonly ok: false; readonly failure: "reader-unresolved"; readonly message: string }
  | { readonly ok: false; readonly failure: "actor-failed"; readonly message: string };

export interface StagedActorInput {
  /** The workspace off the request — `undefined` when no workspace is active. */
  readonly workspaceId: string | undefined;
  /** The request's authenticated user, or `undefined` in `auth: none` mode. */
  readonly user: AtlasUser | undefined;
  readonly requestId: string | undefined;
  readonly order: StagedPreambleOrder;
}

/**
 * The preamble every staged-write surface runs before it does anything else:
 * this deployment has a brain, this session has a workspace, and this actor
 * resolves.
 *
 * The third is the load-bearing one and the reason this is not three inline
 * `if`s per call site. Both confirm endpoints re-resolve the actor from THIS
 * request rather than trusting anything staged, so attribution, grants and ACL
 * visibility are all derived server-side and a session that has since lost its
 * membership is refused even though its token verifies. That property is worth
 * exactly as much as its weakest copy, so there is one.
 *
 * `BrainReaderIdentityError` is separated from a generic throw because the two
 * are different events: the first is a configuration or session problem that
 * would silently NARROW an ACL if it were reported as an empty result, and the
 * second is an ordinary failure. `searchBrain` draws the same line for the same
 * reason.
 */
export async function resolveStagedActor(
  input: StagedActorInput,
): Promise<StagedActorResolution> {
  const { workspaceId, user, requestId, order } = input;

  // Two ordered guards rather than an array of predicates: the array read as
  // configurable when there are exactly two orders and both are named above, and
  // it hid `workspaceId`'s narrowing from the compiler, which then needed a
  // provably-dead re-check to satisfy. `hasInternalDB()` is a pure env read, so
  // it is asked once and the ORDER of the two answers is all that varies.
  const storeMissing = !hasInternalDB();
  if (order === "store-first" && storeMissing) {
    return { ok: false, failure: "store-unavailable" };
  }
  if (!workspaceId) return { ok: false, failure: "no-workspace" };
  if (storeMissing) return { ok: false, failure: "store-unavailable" };

  try {
    const ctx = await resolveBrainReaderContext(getInternalDB(), {
      workspaceId,
      mode: detectAuthMode(),
      user,
      ...(requestId !== undefined ? { requestId } : {}),
    });
    return { ok: true, ctx };
  } catch (err) {
    // Not swallowed, and NOT the `intentionally ignored` case — that marker is
    // for a catch that emits no signal at all (CLAUDE.md). The narrowed message
    // is carried out on the tagged result, and every caller logs it before
    // mapping the arm: `shared-staged-confirm.ts` on the confirm side,
    // `propose-fact.ts` / `correct-fact.ts` on the staging side. Logging HERE
    // too would double every actor failure in the log, and the second copy
    // would be the one missing the caller's own fields (the factId and verb a
    // correction needs to be findable).
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof BrainReaderIdentityError) {
      return { ok: false, failure: "reader-unresolved", message };
    }
    return { ok: false, failure: "actor-failed", message };
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Minting (staging) and the verify→burn gate (confirming)
// ─────────────────────────────────────────────────────────────────────

/**
 * Mint the single-use token binding a staged write.
 *
 * Throws when no signing key is configured, and every staging caller maps that
 * throw to a "can't stage this" refusal rather than offering an unverifiable
 * confirm — see {@link import("@atlas/api/lib/confirm-token").mintConfirmToken}.
 * The throw is the contract: a human-in-the-loop gate must not degrade silently
 * to an unsigned, forgeable token.
 */
export function mintStagedConfirmToken<TBinding>(
  verb: StagedVerb<TBinding>,
  binding: TBinding,
  options: MintConfirmTokenOptions = {},
): string {
  return mintConfirmToken(verb.kind, verb.claims(binding), options);
}

/**
 * Verify a staged-write token against the binding re-derived from THIS confirm
 * request. Pure — it does not touch the nonce store.
 *
 * This is the half that answers *"does this token bind this request?"*, and it
 * is what the per-verb binding tests exercise: `staged-write.test.ts` asks it
 * WHICH field a tamper broke, a question the gate deliberately flattens into one
 * neutral arm. Every production confirm path calls
 * {@link verifyAndBurnStagedConfirm}, which is this plus the burn, in the one
 * order.
 */
export function verifyStagedConfirmToken<TBinding>(
  verb: StagedVerb<TBinding>,
  token: string,
  expected: TBinding,
  nowSeconds: number = Math.floor(Date.now() / 1000),
) {
  return verifyConfirmToken(verb.kind, token, verb.claims(expected), nowSeconds);
}

/** Why the gate refused. Each arm is a different HTTP answer — see `api/routes/shared-staged-confirm.ts`. */
export type StagedConfirmGate =
  | { readonly ok: true }
  /** No signing key: an operator misconfiguration, correlated and 500 — never the neutral 400. */
  | { readonly ok: false; readonly failure: "unverifiable" }
  /** Missing / malformed / forged / expired / mis-bound. `reason` is for the server log ONLY. */
  | {
      readonly ok: false;
      readonly failure: "invalid";
      readonly reason: ConfirmTokenRejection;
    }
  /** Verified, but the nonce was already spent. */
  | { readonly ok: false; readonly failure: "replayed" };

/**
 * ⭐ **The staged-write invariant, implemented once.** Verify the token binds
 * this re-resolved request, then burn its nonce — and nothing in between.
 *
 * ## Why this is one function and not two calls at a call site
 *
 * The burn must happen SYNCHRONOUSLY with the verification, with no intervening
 * `await`. `burnConfirmNonce`'s check-and-set is synchronous, so within a
 * process two concurrent replays of one token cannot both win: the first burns
 * it, the second is told it is spent. Slip a single `await` between the two —
 * a vocabulary load, an ACL read, an audit write — and both replays verify
 * before either burns, and both proceed. Every write this gate protects is one
 * where twice is materially different from once: two proposals against the
 * corroboration path are two ATTESTATIONS, not a duplicate row, which is exactly
 * the self-echo the distinct-source count exists to discount.
 *
 * That property was previously a copy-pasted comment above two copy-pasted call
 * sites. A comment cannot hold an ordering. This function can: there is no
 * signature by which a caller can obtain a verified token and burn it later, so
 * the third verb inherits the ordering rather than being trusted to repeat it.
 *
 * ## The nonce is spent on the ATTEMPT
 *
 * `ok: true` means burned, whatever the verb goes on to do. A refused or failed
 * write does NOT return the nonce, deliberately: otherwise one confirmation
 * could be re-fired against many claims or many target states, which is a graph
 * probe. The user re-states and the agent stages a fresh one.
 *
 * `nowSeconds` is threaded into BOTH halves so verification and eviction agree
 * on one clock — a test that verifies against a fixed `now` and burns against
 * wall-clock is testing two different moments.
 */
export function verifyAndBurnStagedConfirm<TBinding>(
  verb: StagedVerb<TBinding>,
  token: string,
  expected: TBinding,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): StagedConfirmGate {
  const verification = verifyStagedConfirmToken(verb, token, expected, nowSeconds);
  if (!verification.ok) {
    if (verification.reason === "no-key") return { ok: false, failure: "unverifiable" };
    return { ok: false, failure: "invalid", reason: verification.reason };
  }
  // ⚠️ No `await`, no I/O, no logging call that could become async, between the
  // line above and the line below. See this function's header.
  if (!burnConfirmNonce(verification.nonce, verification.expSeconds, nowSeconds)) {
    return { ok: false, failure: "replayed" };
  }
  return { ok: true };
}
