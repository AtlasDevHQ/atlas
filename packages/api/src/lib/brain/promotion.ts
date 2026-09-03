/**
 * The fact class's promotion refusals evaluated at the review gate (#4769):
 * "no-provenance-no-promotion" (T4, ADR-0036 §Temporal, conflict & provenance)
 * and "no-grant-no-promotion" (T5, ADR-0036 §Access control & residency) — and,
 * since #5342, "an observation is never published" (ADR-0042).
 *
 * ## Two kinds of refusal, and the second one is not a defect
 *
 * The first three codes name something REPAIRABLE about a claim: fix the
 * provenance, fix the grant, publish again. `OBSERVATION_NOT_PUBLISHABLE` names
 * what the row IS — a recorded reading of a warehouse value, which `executeSQL`
 * answers live and fresher — so it is terminal, short-circuits before the
 * collected list, and carries prose with no "fix it" tail. Reading it as a
 * fourth repairable defect is the misreading to avoid; it is why the two are
 * structurally separated here rather than sharing the collection loop.
 *
 * ## Why the observation rule is HERE and not in the publish adapter
 *
 * This module is pure and already has three consumers, so one arm is inherited
 * by all three. Be precise about what each inherits, because ADR-0042 and
 * #5342's own body describe the middle one as it was BEFORE #5341 landed:
 *
 *   - the publish adapter's gate refuses the row — the only consumer an
 *     observation actually reaches in production;
 *   - the review queue's pre-flight (`candidates.ts`) would report it as
 *     refused with a reason rather than as something a reviewer could bless.
 *     It never gets the chance: #5341 excludes observations in the candidate
 *     WHERE, which is strictly stronger. The inheritance still matters as a
 *     backstop — relax that exclusion and the queue cannot silently start
 *     advertising an observation as publishable;
 *   - the correction path's replacement screen stays consistent with both, and
 *     likewise cannot reach it: `reconcile.ts` stamps the replacement with the
 *     correction episode's kind, which is always `HUMAN_SOURCE`.
 *
 * ADR-0042 is explicit that enforcement is a TEST and not a grep guard:
 * `scripts/check-brain-fact-promotion.sh` greps for code shapes because a rogue
 * status writer IS a shape, while this rule is a runtime predicate over stored
 * provenance with no shape to grep. Do not add one.
 *
 * ## What "the set of published observations is closed" does and does not mean
 *
 * Closed over rows this deployment can CLASSIFY. The arm below reads
 * `isObservation`, which answers `false` for a source kind outside the
 * vocabulary — so an imported `{"source":"snowflake"}` row that is warehouse-
 * shaped in the region that exported it is still publishable, and still served.
 * That is deliberate and is #4964's standing decision, not an oversight of
 * #5342: the region import is the one producer that is not vocabulary-gated,
 * and refusing what it restores would strand every imported draft in a queue no
 * reviewer could clear. The residual closes the day this region deploys a
 * vocabulary that knows the kind, with no data migration.
 *
 * Pure decisions only — what the gate REFUSES ({@link classifyFactForPromotion})
 * and, for what it admits, what grant it publishes with
 * ({@link widenGrantFromEvidence}, #4823). The transactional half — the SELECT,
 * the scoped UPDATE, and the `PromotionReport` — lives in
 * `lib/content-mode/adapters/brain-facts.ts`, which is the ONLY promotion path
 * (`scripts/check-brain-fact-promotion.sh` proves it). Keeping the rules here,
 * dependency-free, is what lets #4772's review surface pre-flight a candidate
 * and show the same verdict the publish endpoint will reach, without importing
 * the publish machinery or a database handle.
 *
 * ## Why there is anything to refuse at all
 *
 * Migration 0180 already makes most of both rules UNREPRESENTABLE AT REST, and
 * that is the point of reading this comment before assuming these checks are
 * redundant:
 *
 *   - `source_episode_id uuid NOT NULL` + the composite FK onto
 *     `brain_episodes (workspace_id, id)` — a fact with no evidence, or with
 *     another tenant's evidence, cannot be stored.
 *   - `chk_brain_facts_provenance_nonempty` — `jsonb_typeof(provenance) =
 *     'object' AND provenance <> '{}'` refuses an empty claim wearing the shape
 *     of a real one.
 *   - `chk_brain_facts_grant_nonempty` — at least one non-NULL, non-`''`
 *     element in `visible_to`.
 *
 * So `PROVENANCE_MISSING` and `PROVENANCE_EMPTY` are DEFENSE IN DEPTH: no draft
 * row can reach them today, and the live-PG test asserts exactly that — the
 * SCHEMA is what refuses, at INSERT (`NOT NULL` + the FK for the missing
 * episode, the CHECK for the empty payload). They exist because the seam must
 * survive a future schema relaxation, and because a rule ADR-0036 states as an
 * absolute should be enforced where the promotion decision is made, not only
 * where the bytes land.
 *
 * `GRANT_UNUSABLE` is different — it is a LIVE gap, and the reason this module
 * is not ceremony. The 0180 CHECK deliberately admits any non-empty element,
 * including one outside the grant grammar: `visible_to = ['everyone']` is
 * legally storable, has cardinality 1, and grants NOBODY access, because
 * enforcement is array overlap against reader tokens and no reader token is
 * ever malformed (see `acl.ts`).
 *
 * ## Why the stricter rule belongs HERE and not in the CHECK
 *
 * Read `acl.ts`'s rule precisely, because a loose paraphrase of it would
 * condemn this whole module: what it forbids is a stricter REJECTION AT REST
 * OR AT IMPORT — nothing in `acl.ts` may refuse a grant the CHECK admits, and
 * its named counterpart is `grantProblem` in `admin-migrate.ts`. It says
 * outright that its own parser is "deliberately stricter than both". So the
 * rule is not that Atlas may never be stricter than Postgres; it is that
 * Atlas may never make a legally-stored row unstorable or unimportable —
 * because such a row is a workspace that cannot be migrated between regions,
 * and the failure would surface at cutover.
 *
 * A promotion refusal is neither a rejection at rest nor at import. The row
 * stays stored, exportable, importable, and fixable; it is simply not stamped
 * "reviewed and trusted" while it is invisible to every reader. That is
 * precisely why the stricter rule is legitimate at this seam and would not be
 * legitimate as a tightened CHECK.
 *
 * The corollary, worth stating because it is easy to miss: `GRANT_UNUSABLE` is
 * an invariant of the PROMOTION PATH, not of published facts. A region import
 * writes `status` verbatim (`admin-migrate.ts`, the guard's one allowlisted
 * writer), so a workspace can legitimately arrive carrying an already-published
 * fact whose grant this classifier would refuse. That asymmetry is deliberate —
 * an importer stricter than the CHECK is the exact failure the rule above
 * forbids — and `promotion-pg.test.ts` pins it so a future "fix" of one side
 * has to argue with a test.
 *
 * This NARROWS the residual gap `acl.ts` names and tracks on #4797; it does not
 * close it. Still open there: `brain_episodes` (gated by the same predicate but
 * never promoted, so it has no equivalent seam) and facts that arrive already
 * `published` through the import path above.
 */

import { formatPrincipal, isUnknownArray, parseGrant } from "@atlas/api/lib/brain/acl";
import { isJsonObject, isObservation } from "@atlas/api/lib/brain/observation";
import type { PromotionRefusal } from "@atlas/api/lib/content-mode/port";

/**
 * The refusal codes, as a closed vocabulary rather than free strings.
 *
 * The compile-time benefit is real but scoped to `@atlas/api`: a typo here is a
 * type error, and an API-side consumer (#4772's review surface, insofar as it
 * lives in the API) can branch exhaustively via {@link FactRefusal}. `@atlas/web`
 * may never import `@atlas/api` (CLAUDE.md § Code Style), so the web surface
 * reads `reasons` as plain strings off the wire and has no compile-time link to
 * this list — which is exactly why every refusal also carries a prose `detail`
 * the UI can render without knowing any code. If a future surface needs to
 * branch on these in the browser, the vocabulary moves to `@useatlas/types`
 * first.
 */
export const FACT_REFUSAL_REASONS = {
  /** `source_episode_id` is absent — the evidence pointer is the provenance. */
  provenanceMissing: "PROVENANCE_MISSING",
  /** `provenance` is not a non-empty JSON object. */
  provenanceEmpty: "PROVENANCE_EMPTY",
  /** Every `visible_to` token is outside the grant grammar — grants nobody. */
  grantUnusable: "GRANT_UNUSABLE",
  /**
   * The row is an OBSERVATION — a recorded reading of a warehouse value, not a
   * claim anyone believes (ADR-0042, #5342). Terminal and unlike every other
   * code here: the other three name something REPAIRABLE, and this one names
   * what the row IS. Nothing about it can be fixed into publishability, which
   * is why it short-circuits rather than joining the collected list.
   */
  observationNotPublishable: "OBSERVATION_NOT_PUBLISHABLE",
  /**
   * `visible_to` did not arrive as an array at all. `visible_to text[] NOT NULL`
   * (0180) makes that impossible from the database, so this is QUERY DRIFT — a
   * changed SELECT, a mapping mistake — not bad tenant data. Kept distinct from
   * `GRANT_UNUSABLE` because the two send an investigation to opposite places:
   * one says fix the fact, the other says fix the code.
   */
  grantNotAnArray: "GRANT_NOT_AN_ARRAY",
} as const;

export type FactRefusalReason =
  (typeof FACT_REFUSAL_REASONS)[keyof typeof FACT_REFUSAL_REASONS];

/**
 * The columns the classifier reads, straight off `pg`. Deliberately `unknown`
 * where the driver's shape is not guaranteed: `provenance` arrives as a parsed
 * JS value whose type depends on the stored jsonb, and `visible_to` arrives as
 * an array whose elements may be `null`. Typing them optimistically here would
 * move the narrowing into the caller, where it would be skipped.
 */
export interface DraftFactRow {
  readonly id: string;
  /**
   * The SPO claim, for the refusal message. A UUID alone is not actionable —
   * #4772's review surface has not shipped, and the publish PREVIEW (which does
   * render the claim) is a different response the admin cannot cross-reference
   * from a publish result.
   */
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly source_episode_id: string | null;
  readonly provenance: unknown;
  readonly visible_to: unknown;
}

/**
 * A refusal from THIS classifier, with `reasons` narrowed to the closed
 * vocabulary above.
 *
 * `PromotionRefusal` types `reasons` as `readonly string[]` because it is the
 * generic port shape shared by every adapter (and teaching `port.ts` this
 * table's vocabulary would deepen the `port → tables → adapters → port` cycle
 * for no gain). But returning the widened type from here would defeat the whole
 * point of `FACT_REFUSAL_REASONS` being closed: #4772's review surface imports
 * this function directly and must be able to branch exhaustively. Narrowing on
 * the way out costs nothing — it still assigns to `PromotionRefusal`.
 */
export interface FactRefusal extends PromotionRefusal {
  readonly reasons: readonly FactRefusalReason[];
}

/**
 * Decide whether one draft fact may be promoted, and if not, say why in terms
 * an admin can act on.
 *
 * Collects EVERY broken rule rather than stopping at the first: a fact that is
 * both unprovenanced and ungranted needs both fixed, and reporting one at a
 * time turns a single repair into two publish cycles.
 *
 * Returns `null` when the fact is promotable — the common case, and the one
 * that must be cheap.
 */
export function classifyFactForPromotion(row: DraftFactRow): FactRefusal | null {
  // ADR-0042 (#5342): the producer's output never reaches `published`. The
  // module header carries the argument for why this arm lives in this file and
  // what it is and is not closed over; what is local to the code is the
  // ORDERING.
  //
  // FIRST and ALONE, because it is the one refusal here that is not a defect.
  // The other three say *this claim is broken, repair it*; this one says *this
  // is not a claim*. Collecting it alongside a grant complaint would tell a
  // reviewer to go fix the grant on a row that could never be published with
  // any grant at all, and the shared tail below ("Fix it (or retract it) and
  // publish again") would be a straight lie — there is nothing to fix, and
  // `retract` is refused on it too.
  if (isObservation(row.provenance)) {
    return {
      rowId: row.id,
      reasons: [FACT_REFUSAL_REASONS.observationNotPublishable],
      detail:
        `"${row.subject} ${row.predicate} ${row.object}" (${row.id}) was not published because it is a ` +
        "warehouse observation — a recorded reading of a warehouse value at an instant, not a claim " +
        "anyone believes. Observations are never published: the warehouse answers this question live " +
        "and fresher through `executeSQL`, and a published copy would go stale the moment the row " +
        "changed. There is nothing to fix. It stays a draft, where it still corroborates, still earns " +
        "conflict edges against reviewed facts, and still counts as evidence on the Coverage Surface.",
    };
  }

  const reasons: FactRefusalReason[] = [];
  const details: string[] = [];

  // Defense in depth — `source_episode_id uuid NOT NULL` plus the composite FK
  // make this unreachable from the database, and `uuid` cannot hold whitespace.
  // The `.trim()` is therefore about the OTHER caller: this classifier is pure
  // and #4772 may pre-flight a candidate that has not been inserted yet, where
  // a whitespace-only id is an ordinary form-input mistake.
  if (typeof row.source_episode_id !== "string" || row.source_episode_id.trim() === "") {
    reasons.push(FACT_REFUSAL_REASONS.provenanceMissing);
    details.push("it has no source episode, so the claim has no evidence behind it");
  }

  // Defense in depth — `chk_brain_facts_provenance_nonempty` makes this
  // unreachable today.
  if (!isJsonObject(row.provenance) || Object.keys(row.provenance).length === 0) {
    reasons.push(FACT_REFUSAL_REASONS.provenanceEmpty);
    details.push("its provenance payload is empty, so there is nothing recording where it came from");
  }

  // The live rule. `parseGrant` is the single grammar — duplicating it as a
  // SQL predicate would let the two drift, and the enforcing side (Postgres
  // `&&` against reader tokens) is downstream of THIS parser's notion of a
  // usable principal, not of any SQL restatement of it.
  //
  // A non-array `visible_to` is refused too (fail-closed either way), but under
  // its own code: coercing it to `[]` and reporting "carries no grant" would
  // tell an admin their data is wrong when in fact the query is.
  // `isUnknownArray`, not `Array.isArray` — the latter narrows to `any[]`, which
  // would make the grant elements implicitly `any` in the one call that decides
  // whether this fact is visible to anybody (`acl.ts`'s note on the guard).
  if (!isUnknownArray(row.visible_to)) {
    reasons.push(FACT_REFUSAL_REASONS.grantNotAnArray);
    details.push(
      "its grant did not load as an array, which means the draft-facts query returned an unexpected shape — this is an Atlas bug, not a problem with the fact",
    );
  } else {
    const parsed = parseGrant(row.visible_to);
    if (parsed.principals.length === 0) {
      reasons.push(FACT_REFUSAL_REASONS.grantUnusable);
      details.push(
        parsed.malformed.length > 0
          ? `its grant contains no usable principal — ${describeMalformed(parsed.malformed)} — so it would be invisible to every reader. ${GRANT_GRAMMAR_HINT}`
          : `it carries no grant, so it would be invisible to every reader. ${GRANT_GRAMMAR_HINT}`,
      );
    }
  }

  if (reasons.length === 0) return null;

  // Some details already end in a sentence (the grant arm appends the grammar
  // hint); normalize so the joined prose never reads "…behind it Fix it".
  const because = details.join("; and ");
  const reason = because.endsWith(".") ? because : `${because}.`;

  return {
    rowId: row.id,
    reasons,
    detail: `"${row.subject} ${row.predicate} ${row.object}" (${row.id}) was not published because ${reason} Fix it (or retract it) and publish again — it is still a draft.`,
  };
}

/**
 * Render malformed grant tokens for an admin.
 *
 * `parseGrant` reports every NON-STRING element (a NULL smuggled in by a
 * hand-authored import bundle) as `''`, which is also what a genuine
 * empty-string element reports as — so a raw `JSON.stringify` join renders
 * `[null, null]` as `"", ""` and sends the reader looking for empty strings
 * that aren't there. Name the empty class instead of quoting it.
 */
function describeMalformed(malformed: readonly string[]): string {
  const named = malformed.filter((t) => t.length > 0);
  const emptyCount = malformed.length - named.length;
  const parts: string[] = [];
  if (named.length > 0) {
    parts.push(`${named.map((t) => JSON.stringify(t)).join(", ")} ${named.length === 1 ? "is not a principal" : "are not principals"}`);
  }
  if (emptyCount > 0) {
    parts.push(`${emptyCount} empty or null entr${emptyCount === 1 ? "y" : "ies"}`);
  }
  return parts.join("; ");
}

/**
 * Valid grant tokens, in prose, appended to every `GRANT_UNUSABLE` refusal.
 *
 * Stated here rather than in the UI so the grammar has ONE prose home next to
 * the parser it describes — and so every surface that renders a refusal
 * (`detail` is passed through verbatim by the web modal, the CLI, and the MCP
 * tool) tells the reader the same thing about how to fix it.
 */
export const GRANT_GRAMMAR_HINT =
  "A grant must contain at least one of: `org`, `role:owner`, `role:admin`, `role:member`, `user:<id>`, or `audience:<name>`.";

/**
 * A grant as it can actually be stored: `text[]`, whose elements arrive off the
 * driver as strings or `null`. Narrower than the `readonly unknown[]` the
 * PARSERS take, on purpose — `parseGrant` must accept anything a hand-authored
 * import bundle smuggled in, but the value on its way BACK INTO an ACL column
 * should not be able to carry a JSON number that `jsonb_array_elements_text`
 * would happily coerce into a principal.
 */
export type StoredGrant = readonly (string | null)[];

/**
 * A grant the evidence actually widened — never a no-op.
 *
 * `added` is `[string, ...string[]]` and the function returns `null` rather
 * than an empty result, so "nothing changed" is unrepresentable here. That
 * pairing is the whole point: the caller must take a different, cheaper path
 * when nothing widened (see `PROMOTE_FACTS_SQL` vs
 * `WIDEN_AND_PROMOTE_FACTS_SQL`), and a shape that let it read `grant` on the
 * no-change branch would compile straight into rewriting `visible_to` on every
 * promoted fact to change none of them.
 */
export interface EvidenceWidenedGrant {
  /** The grant to write: the input's tokens, in order, followed by `added`. */
  readonly grant: StoredGrant;
  /** Tokens the evidence added, in the order the evidence arrived. */
  readonly added: readonly [string, ...string[]];
}

/**
 * Widen a draft fact's grant to cover every episode that is already evidence
 * for it (#4823, ADR-0036 §T5 amendment 2026-07-26).
 *
 * ## The problem this exists to fix
 *
 * A fact's grant is inherited verbatim from the episode it was FIRST extracted
 * from, and `reconcile.ts` deliberately never touches it again: a later episode
 * asserting the same claim corroborates, adding a `provenance` edge and nothing
 * else. That is right in the direction it was written for — a NARROWER
 * re-observation must not shrink anything — and over-restricts in the inverse
 * one. Say the same sentence in a private channel and then in a public one:
 * Atlas ends up holding an `{org}` episode as evidence for a fact it serves
 * only to the private channel's audience. Nothing leaks (the direction is
 * fail-closed), but public information is invisible, and it is invisible in the
 * one way nobody can report — you cannot notice a fact you cannot read.
 *
 * ## Why HERE and not at corroboration
 *
 * ADR-0036 §T5 makes a grant an immutable per-version snapshot and §T9 states
 * "widening happens only at the review gate". Publish IS the review gate, so
 * doing it here satisfies that literally rather than by analogy, and it rides
 * the existing bulk promote — so it introduces no per-fact affirmative verb,
 * which #4772's inverted review model (reject-then-publish, no `approve`
 * button) forbade. ⚠️ That model was reversed by #5635, which added
 * `POST /api/v1/admin/brain-facts/approve` — but the reversal does not reach
 * this paragraph's argument, and the distinction matters. #5635 added an
 * affirmative verb whose SCOPE is a set of facts; it did not add a per-fact
 * SIDE EFFECT to promotion. Widening still rides the bulk promote and still
 * introduces no per-row verb of its own, which is what this sentence is about.
 *
 * Widening at corroboration time would instead let any
 * unattended ingest pass mutate an ACL field, which is the same side-effect
 * class that #4771 refused for predicate cardinality.
 *
 * ## The rule, stated exactly, because this is the one direction that leaks
 *
 * - **Append-only.** The fact's own tokens are preserved verbatim and in order,
 *   including malformed ones. Nothing is ever removed, so this can never narrow
 *   a grant, and it cannot silently "repair" a grant an operator has to see
 *   (that stays `logGrantAnomalies`'s job). "Verbatim" is bounded by
 *   {@link StoredGrant}: a non-string, non-null element cannot reach here from
 *   a `text[]`, and the adapter coerces one to `null` if query drift ever
 *   produced it rather than passing it through.
 * - **Evidence only, and only grammar-valid evidence.** A token is added only
 *   if some episode's grant PARSED it as a principal — `parseGrant` then
 *   `formatPrincipal`, which round-trips byte-exactly. Malformed evidence
 *   tokens are dropped rather than copied: they grant nobody anything, so
 *   propagating them would spread noise into a second row for no reader.
 *   Note this is a token union, not a READER union: `impliedRoles` makes role
 *   matching monotone, so adding `role:owner` to a fact already granted
 *   `role:member` admits nobody new. `added` is therefore syntactic — an upper
 *   bound on what changed, not a count of readers gained.
 * - **Union, not "pick the widest".** Widest is not a total order —
 *   `audience:A` and `audience:B` are incomparable — but visibility is token
 *   overlap, so the set of readers a grant admits is monotone in its tokens and
 *   the union IS the least upper bound. It is also *usually* the honest reading:
 *   the claim was stated in A and in B, and a reader of either already saw it
 *   said.
 *
 *   ⚠️ **That sentence is the safety argument, and TWO DIFFERENT THINGS FALSIFY
 *   IT.** The first is #5391, and it is the one this function structurally
 *   cannot see; subject homonymy is the second, below. Read the sentence
 *   literally and it is about PEOPLE SPEAKING. A warehouse OBSERVATION is a
 *   machine reading a column — nobody said anything in the producer's
 *   `org`-wide room — so a warehouse episode corroborating a PRIVATE belief
 *   (row 4 of #5332's class matrix, deliberately kept alive) would union `org`
 *   into that belief's grant at publish and put a private claim's BODY in front
 *   of the whole org. Unlike the homonym case the merge itself is CORRECT — it
 *   really is the same claim — which is why no `subject_cmp`-shaped fix reaches
 *   it and why the fix is not here: **this function takes bare grant arrays and
 *   structurally cannot know what produced them.** ADR-0042 (amended
 *   2026-08-24) rules that an observation is not widening evidence, and the
 *   exclusion lives at the two places that CHOOSE the evidence —
 *   `EVIDENCE_GRANTS_SQL` in the adapter (the act) and `willWidenRowsSql` in
 *   `oversight.ts` (the notice), which carry the identical arm so they cannot
 *   disagree. Anyone adding a THIRD evidence source inherits that obligation,
 *   and nothing in this function's signature will remind them.
 *
 *   **SUBJECT HOMONYMY MAKES IT FALSE TOO (#5032, ADR-0037 §5).** It was
 *   written here unqualified and should not have been. `CORROBORATION_LOOKUP_SQL` (`reconcile.ts`) matches on the SLOT
 *   KEYS, and a key is a function of the SURFACE — so two different entities
 *   sharing a name (`Acme Corp` the vendor, `Acme Corp` the account) land in one
 *   slot, and a public episode about one becomes EVIDENCE for a private fact
 *   about the other. The claim was not stated in B. A *different entity's* claim
 *   was, and this function then hands its audience the private claim's BODY —
 *   which is a strictly worse disclosure than the attribution one below, because
 *   no read-time narrowing withholds it. Corroboration is the only identity
 *   consumer with no grant arm and no cardinality arm, so nothing else stops it.
 *
 *   `brain_facts.subject_cmp` (migration 0193, `lib/brain/subject-cmp.ts`) is
 *   what closes the reachable half: when the entity store proves the two
 *   subjects are different entities the corroboration lookup does not match at
 *   all, so no evidence edge is written and there is nothing here to union.
 *   **It does not close all of it, and that is permanent** — only a
 *   warehouse-backed subject can supply a `subject_cmp`, so the
 *   extractor↔extractor homonym (the case that occurs today) stays live. It is
 *   guarded rather than prevented, by `loadWideningPreview`'s review-gate
 *   notice, which fires exactly when {@link EvidenceWidenedGrant.added} would be
 *   non-empty. Read that as *"a human is told, and may click through"*, not as
 *   *"this cannot happen"*.
 *
 *   The rest of the argument is about the CLAIM only —
 *   ADR-0036 §T5 has provenance ride the fact's grant, and a fact's provenance
 *   names its FIRST episode (`sourceId`, `actor`, `occurredAt`). So a reader
 *   gained by widening learns nothing new about the claim *when the two rows
 *   really are about one entity*, and WOULD learn who
 *   said it first, in which channel, and when. #4823 accepted that price;
 *   #4836 no longer does. The attribution triple is now narrowed at READ time:
 *   `attributionDecision` (`lib/brain/attribution.ts`) withholds it from any
 *   reader who does not match `brain_facts.pre_widening_visible_to` — the
 *   grant THIS function's output overwrites. See ADR-0036 §T5's
 *   `Amendment (2026-07-27, #4836)`.
 *
 *   Two obligations follow for anyone editing here. First, that column is
 *   written by `WIDEN_AND_PROMOTE_FACTS_SQL` on the same UPDATE that
 *   overwrites `visible_to`, and this function's non-null return is the only
 *   thing that selects that statement — so a change that widens through some
 *   other path must carry the same write, or the disclosure returns silently
 *   and nothing fails. Second, "no information gain" still must not be
 *   restated as a property of the widening alone: it is a property of the
 *   widening PLUS the read-time narrowing, which live in different files.
 * - **No `org` collapse.** `['audience:X', 'org']` is left as-is rather than
 *   reduced to `['org']`, even though `org` subsumes everything. The pair
 *   records that the claim was made both privately and publicly; collapsing
 *   would discard that and turn an append into a rewrite.
 *
 * The caller decides WHICH episodes count as evidence (see
 * `EVIDENCE_GRANTS_SQL` in the adapter — `provenance` edges, workspace-scoped
 * on both sides). This function is pure and trusts what it is handed; it is not
 * a place to check tenancy.
 *
 * Returns `null` when the evidence adds nothing — the common case by a wide
 * margin, and the caller's signal to take the blanket promote that never
 * touches `visible_to`.
 */
export function widenGrantFromEvidence(
  factGrant: StoredGrant,
  evidenceGrants: readonly (readonly unknown[])[],
): EvidenceWidenedGrant | null {
  // Seeded from the RAW array so the dedupe is over exactly the bytes stored.
  // `null` elements are skipped because they are not tokens and match nothing;
  // a malformed string lands in the set and is inert there, since the only
  // candidates for appending are `parseGrant`'d principals.
  const held = new Set<string>();
  for (const token of factGrant) {
    if (token !== null) held.add(token);
  }

  const added: string[] = [];
  for (const evidence of evidenceGrants) {
    for (const principal of parseGrant(evidence).principals) {
      const token = formatPrincipal(principal);
      if (held.has(token)) continue;
      held.add(token);
      added.push(token);
    }
  }

  const [first, ...rest] = added;
  if (first === undefined) return null;
  return { grant: [...factGrant, ...added], added: [first, ...rest] };
}
