/**
 * Stage-0 pre-extraction triage (#5336) — deterministic routing ahead of the
 * extraction fiber's model call.
 *
 * ## What this is, and what it is not
 *
 * Most episodes contain no promotable claim: "on it", "+1", a thumbs-up, the
 * standing noise of a chat channel. Each one still costs the fiber a frontier
 * call today, and when the model obliges with something marginal, a slot in the
 * review queue — the scarcest resource in this arc. Stage 0 kills the OBVIOUS
 * majority with rules an admin can read in one screen: no model, no scoring, no
 * learned weights. Every rule is enumerable in {@link TRIAGE_RULES}, and each
 * carries its rationale beside its predicate so the list is the documentation.
 *
 * The bias is deliberate and one-directional: **a false drop is the expensive
 * direction.** A junk episode that slips through costs one cheap-tier model
 * call; a real claim triaged out is a new way to be quietly wrong — the exact
 * shape migration 0180 legislates against for episodes ("NULL forever is a
 * visible backlog, not a silent drop"). So every rule here must be SATISFIED BY
 * NOTHING that could carry a claim, not merely usually-noise. When in doubt, an
 * episode passes.
 *
 * ## Marked and countable, never stamped
 *
 * This module only DECIDES. The caller (`extract.ts`'s scan) records the
 * verdict as `brain_episodes.triaged_out_at` + `triage_reason` — never as
 * `extracted_at`, because no extraction ran and stamping it would assert one
 * did. A triaged-out episode therefore stays a visible, queryable, re-queueable
 * outcome: clearing the mark (`REQUEUE_TRIAGED_SQL` in `extract.ts`) puts the
 * episode back on the drain at its original `ingested_at` position, with no
 * backfill and no repair sweep. A human does that from
 * `POST /api/v1/admin/brain-triage/requeue`, beside the per-rule counts that
 * motivate it (#5534) — `lib/brain/triage-requeue.ts` is the store module, and
 * carries the record of why that surface is an admin route rather than an
 * operator subcommand.
 *
 * ⚠️ Retiring an id from {@link TRIAGE_RULE_IDS} does NOT clear the marks it
 * wrote — they stay on the rows under a reason this deploy no longer knows.
 * That is survivable rather than a leak: the backlog surface reports such a
 * bucket as `known: false`, and the all-rules re-queue reaches it. But a
 * per-rule re-queue cannot name it, so retiring a rule with a live backlog
 * means re-queueing it first.
 *
 * ## ⚠️ The stage-1 seam (#5336) — an ADAPTER, not an edit
 *
 * The extraction fiber consumes triage through the {@link Triager} dependency
 * (`BrainExtractionDeps.triage`), whose default is {@link deterministicTriager}
 * — the rules below, verbatim. Stage 1 — the ML classifier over a labeled
 * corpus (milestone #98) — is a SECOND adapter composed BEHIND the
 * deterministic one via {@link composeTriagers}: a body stage 0 catches never
 * reaches the classifier, so the deterministic layer stays the explainable
 * floor; stage 1 may only route MORE episodes out, and its verdicts carry
 * `stage: 1` and their own reason id so an admin can tell the two stages apart
 * in the counts. Nothing else in the pipeline changes: the marking, the
 * counters and the re-queue verb are stage-agnostic (`triage_reason` is a
 * plain text column, and `isKnownTriageRule` already narrates unknown ids on
 * the backlog surface instead of choking on them).
 *
 * ## Why body-shape rules only
 *
 * The issue names channel/source scope and thread position as candidate
 * signals. Neither is on the episode row this fiber drains (thread position is
 * not stored at all; source scoping already happens at ingest), so shipping
 * them here would mean joins and config surface stage 0 does not need to kill
 * its majority. Deliberately deferred, not forgotten.
 */

import type { EpisodeRow } from "./extract-contract";

/**
 * The closed vocabulary of stage-0 reason ids. A new rule joins this list
 * first — {@link emptyTriageMatchCounts} then refuses to compile until the
 * seeded counter record knows about it. (The live tally itself is
 * string-keyed since the Triager seam landed, because stage-1 reasons are
 * deliberately outside this union — the seeding is where stage-0
 * exhaustiveness stays compile-checked.)
 */
export const TRIAGE_RULE_IDS = ["below_min_length", "pure_reaction", "known_ack"] as const;

export type TriageRuleId = (typeof TRIAGE_RULE_IDS)[number];

/** One enumerable stage-0 rule: an id (the stored `triage_reason`), the
 * rationale an admin reads, and the predicate itself. */
export interface TriageRule {
  readonly id: TriageRuleId;
  /** Why matching bodies cannot carry a promotable claim. */
  readonly rationale: string;
  /**
   * `trimmed` is the body with surrounding whitespace removed (never empty —
   * whitespace-only bodies belong to the `no_body` skip, not to triage);
   * `normalized` is {@link normalizeForAck}'s folding of the same text.
   */
  readonly matches: (trimmed: string, normalized: string) => boolean;
}

/**
 * Shortest trimmed body that could conceivably state a claim: the floor
 * routes out SINGLE-character bodies only ("k", "y", "^"-noise), in UTF-16
 * units. Two characters is already past it on purpose — "no" is a complete
 * answer to a factual question, and the answer-shape exclusion documented on
 * {@link KNOWN_ACK_SHAPES} would be hollow if the length rule quietly ate its
 * two-character member. The common 2-char noise ("+1", "ok", "ty", "np") is
 * enumerated in the ack set instead, where each entry is a reviewable
 * decision. Raising this is how a false drop gets introduced; don't.
 */
export const TRIAGE_MIN_MEANINGFUL_CHARS = 2;

/**
 * Exact known-negative shapes, matched only after {@link normalizeForAck}.
 *
 * Membership test: could this string, standing alone as an entire message with
 * no thread context (the extractor sees only the episode body), state anything
 * about the world? Every entry is a bare acknowledgement, greeting, or
 * reaction. Compounds ("thanks, will ship Friday") never match — the test is
 * exact equality, not containment, which is the conservative direction.
 *
 * ⚠️ ANSWER-SHAPES ARE DELIBERATELY EXCLUDED. Bare "yes", "no", "sure",
 * "agreed", "makes sense" were in an earlier draft and were removed on
 * review: each is the entire content of an answer to a factual question
 * ("does prod use us-east-1?" → "no"), so it sits directly in front of a
 * claim-bearing exchange in a way "+1" or "thanks" does not. Today's
 * extractor sees only the body and could not recover that claim either — but
 * a later prompt that includes thread context could, and a triage rule must
 * not quietly pre-empt it. They pass through; do not re-add them. (The
 * length floor was lowered to single characters for the same reason — see
 * {@link TRIAGE_MIN_MEANINGFUL_CHARS} — so two-character "no" passes too.)
 */
const KNOWN_ACK_SHAPES: ReadonlySet<string> = new Set([
  "+1",
  "-1",
  "+100",
  "ok",
  "okay",
  "k",
  "kk",
  "ack",
  "noted",
  "on it",
  "got it",
  "will do",
  "done",
  "thanks",
  "thank you",
  "thanks so much",
  "thx",
  "ty",
  "tyvm",
  "np",
  "no problem",
  "no worries",
  "you're welcome",
  "yw",
  "welcome",
  "sounds good",
  "sounds good to me",
  "sgtm",
  "lgtm",
  "works for me",
  "wfm",
  "cool",
  "nice",
  "great",
  "awesome",
  "perfect",
  "sweet",
  "amazing",
  "love it",
  "nice one",
  "good call",
  "well done",
  "congrats",
  "congratulations",
  "haha",
  "lol",
  "lmao",
  "same",
  "this",
  "^",
  "^^",
  "brb",
  "omw",
  "one sec",
  "sec",
  "hi",
  "hello",
  "hey",
  "morning",
  "good morning",
  "gm",
  "good night",
  "gn",
  "bye",
  "later",
  "ttyl",
  "nvm",
  "never mind",
  "all good",
  "woohoo",
  "yay",
]);

/**
 * Fold a body into the shape {@link KNOWN_ACK_SHAPES} is written in: lowercase,
 * straight apostrophes, single spaces, and no leading/trailing punctuation —
 * so "Thanks!!", "thanks." and " THANKS " all resolve to "thanks". Interior
 * punctuation survives, so "thanks, deploy is at 5" can never fold into a bare
 * "thanks".
 */
export function normalizeForAck(trimmed: string): string {
  return trimmed
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .replace(/^[.!?,;:…~\s]+/, "")
    .replace(/[.!?,;:…~\s]+$/, "");
}

/**
 * Every character is emoji machinery or whitespace. `Emoji_Component` alone
 * also matches digits, `#` and `*` (keycap bases), so the second test requires
 * at least one actual pictograph — "123" must NOT read as a reaction.
 */
const EMOJI_MACHINERY_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Component}\s]+$/u;
const HAS_PICTOGRAPH = /\p{Extended_Pictographic}/u;

/** One or more `:emoji_code:` tokens and nothing else — Slack's colon form. */
const EMOJI_CODES_ONLY = /^(?::[\w+'-]+:\s*)+$/;

/**
 * The stage-0 rule set, in evaluation order (first match wins). ONE place, as
 * the issue demands: a rule added anywhere else in the pipeline is a bug, and
 * the drain query never encodes a triage predicate of its own.
 */
export const TRIAGE_RULES: readonly TriageRule[] = [
  {
    id: "below_min_length",
    rationale:
      `A trimmed body under ${TRIAGE_MIN_MEANINGFUL_CHARS} characters — a single ` +
      `character ("k", "y", "?") — cannot state a subject-predicate-object claim. ` +
      `Two characters and up is already past this floor: "no" is a complete answer ` +
      `to a factual question, so the common two-character noise is enumerated in ` +
      `the acknowledgement set instead.`,
    matches: (trimmed) => trimmed.length < TRIAGE_MIN_MEANINGFUL_CHARS,
  },
  {
    id: "pure_reaction",
    rationale:
      "A body that is nothing but emoji (Unicode pictographs or Slack `:code:` tokens) " +
      "is a reaction, not a statement — there are no words to extract a claim from.",
    matches: (trimmed) =>
      (EMOJI_MACHINERY_ONLY.test(trimmed) && HAS_PICTOGRAPH.test(trimmed)) ||
      EMOJI_CODES_ONLY.test(trimmed),
  },
  {
    id: "known_ack",
    rationale:
      "An exact match (after case/whitespace/edge-punctuation folding) against the " +
      "enumerated acknowledgement shapes — bare acks, greetings and reactions that " +
      "carry no claim standing alone. Exact equality only; compounds always pass.",
    matches: (_trimmed, normalized) => KNOWN_ACK_SHAPES.has(normalized),
  },
];

/**
 * The stage-0 verdict for one episode body: the id of the first matching rule,
 * or `null` — which means "reaches the model", and is the answer for anything
 * this module is not SURE about.
 *
 * A whitespace-only body returns `null` deliberately: `extract.ts` already
 * routes it to the `no_body` skip (it is by-reference evidence territory, not
 * noise), and two modules claiming the same bodies would make the counters
 * disagree about what happened.
 */
export function triageEpisodeBody(body: string): TriageRuleId | null {
  const trimmed = body.trim();
  if (trimmed === "") return null;
  const normalized = normalizeForAck(trimmed);
  for (const rule of TRIAGE_RULES) {
    if (rule.matches(trimmed, normalized)) return rule.id;
  }
  // ⚠️ Stage 1 does NOT run here. The seam is the {@link Triager} adapter the
  // extraction fiber injects — see the module header. This function stays the
  // pure, synchronous stage-0 floor.
  return null;
}

/**
 * An episode as a triager sees it: the drain's row shape with the body
 * guaranteed present and non-whitespace. The extraction fiber owns that guard
 * — body-less and whitespace-only episodes belong to its `no_body` skip and
 * never reach a triager (two owners for one body class would make the
 * counters disagree about what happened).
 */
export type TriageableEpisode = EpisodeRow & { readonly body: string };

/**
 * One triage decision about one episode.
 *
 * `reason` is stored verbatim as `brain_episodes.triage_reason`, so it must be
 * stable, lowercase-snake-case, and OUTSIDE {@link TRIAGE_RULE_IDS} for any
 * non-deterministic stage — the per-rule counters, the backlog surface and the
 * per-rule re-queue all key on it, and reusing a stage-0 id would make two
 * stages indistinguishable in every count.
 *
 * `confidence` is the adapter's own signal (a stage-1 classifier thresholds on
 * it internally and returns `null` below its cutoff). The fiber records the
 * verdict, not the confidence — there is no column for it — so the field
 * exists for adapter-side logging and tests, and nothing downstream may grow
 * a dependency on it without adding storage first.
 */
export interface TriageVerdict {
  /** Which layer decided: 0 = deterministic rules, 1 = the learned classifier. */
  readonly stage: 0 | 1;
  /** The stored reason id (`triage_reason`). Non-empty; see above. */
  readonly reason: string;
  readonly confidence?: number;
}

/**
 * The triage seam the extraction fiber injects (`BrainExtractionDeps.triage`).
 * `null` means "reaches the model" — the answer for anything the adapter is
 * not SURE about, because a false drop stays the expensive direction whoever
 * is deciding. May be async: the deterministic default never is, but a
 * stage-1 adapter batching against a local model will be.
 */
export type Triager = (
  episode: TriageableEpisode,
) => TriageVerdict | null | Promise<TriageVerdict | null>;

/**
 * The default adapter: {@link TRIAGE_RULES}, verbatim, as a {@link Triager}.
 * Injecting this explicitly and injecting nothing are the same thing —
 * `extract-triage.test.ts` pins that the gate-off cycle is byte-identical to
 * the pre-triage one, and that pin survives stage 1 unchanged because it
 * constrains the fiber, not the adapter.
 */
export const deterministicTriager: Triager = (episode) => {
  const rule = triageEpisodeBody(episode.body);
  return rule === null ? null : { stage: 0, reason: rule };
};

/**
 * Compose triagers into one: evaluated in order, first verdict wins. This is
 * how stage 1 mounts without demoting the deterministic floor:
 *
 *     composeTriagers(deterministicTriager, distilledModelTriager)
 *
 * A body the rules catch never reaches the classifier (the floor stays
 * explainable and free), and the classifier may only route MORE episodes out.
 */
export function composeTriagers(...triagers: readonly Triager[]): Triager {
  return async (episode) => {
    for (const triager of triagers) {
      const verdict = await triager(episode);
      if (verdict !== null) return verdict;
    }
    return null;
  };
}

/** A zeroed per-rule counter record — every rule present, so a new rule cannot
 * silently land in no counter. */
export function emptyTriageMatchCounts(): Record<TriageRuleId, number> {
  const counts = {} as Record<TriageRuleId, number>;
  for (const id of TRIAGE_RULE_IDS) counts[id] = 0;
  return counts;
}
