/**
 * Segmentation drift, and the reach the TENSION scan needs because of it
 * (#5438, ADR-0037 §2).
 *
 * ## The finding this module exists for
 *
 * Two people contradicted each other in writing, in prod, and Atlas did not
 * notice. Reproduced deliberately on 2026-08-25 while building the condition-4
 * fixture (#5425), with the prediction registered before the messages were
 * posted:
 *
 *     A  "Our Series B target raise is $25M."   → Series B          / target raise / $25M
 *     B  "The Series B fundraise goal is $30M." → Series B fundraise / has goal of  / $30M
 *
 * Both claims stored. No `in-tension-with` edge. `TENSION_CANDIDATES_SQL`
 * required `subject_key = $2 AND predicate_key = $3`; **both diverged**, so no
 * scan could match and the two claims coexisted silently.
 *
 * The fixture varied only the PREDICATE wording. **The extractor moved the
 * word** — it absorbed *"fundraise"* into B's SUBJECT, so the two sentences were
 * segmented differently before any matching rule ran. That is what makes this
 * different from #5000, which was closed on the alias-authoring surface
 * (#5025/#5087): recognition works when the extractor segments two claims
 * identically, and still fails when it does not.
 *
 * ## Why the shipped remedy cannot reach it, stated once
 *
 * Authoring `has goal of → target raise` in the predicate vocabulary leaves
 * `series b` and `series b fundraise` as different SUBJECTS, so the pair still
 * never meets. A vocabulary that spanned both positions would close it and is
 * what ADR-0037 §6 forbids by name — a position-agnostic lookup does not merely
 * permit cross-position composition, it compels it, and a predicate approval
 * would silently re-key subjects workspace-wide.
 *
 * So this is not "author one more alias". Identity is computed from the
 * extractor's segmentation, and segmentation is not stable across two sentences
 * expressing one relation — nor even across EPISODES for one phrasing: the
 * control pair in the same workspace keyed `has target raise of` on 2026-08-03
 * where today's extractor produces `target raise` for the same concept. A corpus
 * accumulates slots that can never meet.
 *
 * ## ⚠️ What is measured, and what is therefore NOT available
 *
 * Three mechanisms were designed against this pair and each was falsified
 * against the shipped code before this one was written. They are recorded
 * because each is the obvious next idea, and rediscovering the refutation costs
 * a cycle:
 *
 *   1. **Compare the relation SPAN** (`subject_key ⧺ predicate_key`), so the
 *      boundary between the two positions stops mattering. `series b target
 *      raise` against `series b fundraise has goal of`: the tokens genuinely
 *      differ. No lexical composition of the two positions matches this pair.
 *   2. **Require the two objects to share a comparable DIMENSION** — same tag,
 *      same currency, different value — as structural evidence in
 *      `alias-proposal.ts`'s sense. **`object_cmp` is NULL on both sides.**
 *      `$25M` does not parse: `object-cmp.ts` refuses currency SYMBOLS outright
 *      (`$` is ambiguous across currencies) and `25M` is not a decimal. The
 *      cowardly parser is right, and it means there is no dimension evidence to
 *      gate on for exactly the surfaces people write in chat.
 *   3. **Re-segment the subject against the corpus** — if a candidate's subject
 *      key has a whole-token prefix that is already a live subject key, move the
 *      residue into the predicate. This works, and it is not enough: it makes
 *      the two subjects agree and leaves `target raise` against `fundraise has
 *      goal of`, which still share no slot.
 *
 * Nothing short of semantic matching — embeddings, edit distance, an LLM judge —
 * matches this pair on the predicate, and `alias-proposal.ts` prohibits all
 * three in the strongest terms in this subsystem, against this repo's own
 * corpus: `led_by` and `leads` are live, are INVERSE relations, and are the
 * top-ranked pair any similarity detector returns.
 *
 * ## So the predicate is dropped, and the licence to drop it is the CONSUMER
 *
 * The tension scan is the ONLY identity consumer whose errors are recoverable in
 * BOTH directions. Corroboration attaches evidence and then widens an ACL at the
 * publish gate; supersession stamps `valid_to`. This writes an advisory
 * `in-tension-with` edge, which is SURFACED with both provenances and never
 * ranked (ADR-0036) — nothing is superseded, invalidated or reordered.
 * `reconcile.ts` already prices the two failure directions against each other in
 * those words: *"a missing one costs a reviewer a hint; a spurious one costs a
 * reviewer a glance."*
 *
 * The strictness the scan had was inherited from the SLOT, because the statement
 * was cut from the same relation the destructive consumers use. At this consumer
 * it protects against nothing: the irreversible over-match the slot exists to
 * prevent is not on this path. What it bought instead was the silence above.
 *
 * So {@link tensionReachSql} keeps the exact slot as one arm and adds a second:
 *
 *     same SUBJECT ANCHOR, from a DIFFERENT EPISODE
 *
 * with no predicate arm at all. The enclosing statements supply the rest — the
 * objects must already be *not provably the same* (`objectNotSameSql`), the
 * subjects must not be *provably different entities* (`subjectNotDifferentSql`),
 * both rows must be live, and the pass runs only at `single` cardinality.
 *
 * ⚠️ **That last clause is a GATE THIS MODULE CANNOT OPEN, and it bounds
 * everything above.** `reconcile.ts` issues the scan only when the candidate's
 * `predicateCardinality` is `single` — the extractor's per-claim guess, against a
 * prompt ADR-0037 §3 describes as biased toward `multi`. Answer `multi` for
 * `has goal of` and the measured pair is silent again, with no arm here able to
 * help. `tension-sweep.ts` is stricter and in the other direction: it reads the
 * workspace's APPROVED cardinality entry, so an uncurated predicate is never
 * swept. So this module makes the pair *reachable*; something else still has to
 * say the predicate is `single`. The gate is deliberate (#5027 took cardinality
 * off the destructive path precisely so a stochastic input could not decide what
 * gets retired) and is named as a limit on `docs/prd/company-atlas.md`'s
 * condition 4 rather than worked around here.
 *
 * ## ⚠️ This is the rule `paraphrase-identity.test.ts` forbids, at the one
 * ## consumer where it is allowed — read both before widening either
 *
 * That file's sharpest test pins `price-copula` (one claim, must merge) beside
 * `price-vs-renewal` (two true claims, must not) and shows they have the
 * IDENTICAL key signature — subjects equal, predicates different — with opposite
 * correct verdicts. Its conclusion is that a rule closing the first by lexical
 * proximity closes the second too, *"and at `single` cardinality that stamps
 * `valid_to` on a belief nobody retired."*
 *
 * The harm it names is the STAMP. Under this arm `price-vs-renewal` earns an
 * advisory edge and a reviewer dismisses it, which is the correct handling of a
 * pair that looks like one claim and is not — the merge stays forbidden and no
 * `valid_to` moves. **The argument does not transfer to corroboration or to
 * supersession, and this builder must never be spliced into either.** Their
 * statements are `CORROBORATION_LOOKUP_SQL` and `supersessionCollisionJoin`;
 * both keep the exact slot, and `identity-consumers-pg.test.ts` is where that
 * stays honest.
 *
 * ## The cost, named rather than discovered
 *
 * Precision at the tension surface drops, and the shape of the loss is
 * predictable: a subject carrying several `single`-cardinality predicates will
 * see its claims flagged against each other across episodes. `Series B / lead
 * investor / Acme` beside `Series B fundraise / target raise / $30M` is a
 * spurious edge this arm mints. Two genuinely different entities in a prefix
 * relation — `Series A` and `Series A extension` — are another.
 *
 * Three things bound it, and none of them is an argument that the noise is zero:
 *
 *   - `TENSION_EDGE_CAP` caps the fan-out PER FACT, on both statements — and
 *     {@link exactSlotFirstSql} ranks exact-slot rivals ahead of anchor-only
 *     ones inside that cap, so a larger candidate set cannot push out an edge
 *     the slot alone would have earned.
 *   - The different-episode arm removes the largest false class outright. One
 *     message routinely yields several claims about one subject and they are not
 *     contradictions; condition 4 is about **two people**, so a rival drawn from
 *     the same episode is not the thing being looked for.
 *   - The edge is advisory and idempotent, and `loadTensionClusters` surfaces it
 *     with both provenances, so a reviewer sees what it joined and why.
 *
 * ## …and then MEASURED, twice, in us prod (#5450)
 *
 * The paragraph above was written before the arm had run against a real corpus.
 * It has now, and the prediction held — the observed false pairs are exactly the
 * shape it names, *a subject carrying several `single`-cardinality predicates*.
 *
 * **2026-08-25**, the post-anchor-arm candidate scan over all 34 facts in the
 * workspace, run read-only with the cardinality gate lifted: three candidate
 * pairs corpus-wide, **all anchor-only, one of three a true contradiction**. The
 * two false ones were a price beside a discount flag (`business tier`) and a
 * raise target beside a post-money valuation (`series a`).
 *
 * **2026-08-26**, the same scan, 35 facts (29 live): **two candidate pairs, both
 * already carrying an edge, and nothing fresh left to mint.** The `business
 * tier` false pair had evaporated on its own — the `is priced at` arm stopped
 * being live — and the `series a` one had been MINTED. What minted it is the
 * finding:
 *
 * ⚠️ **The false `series a` edge was written by the CORRECTION path, with no
 * cardinality entry anywhere in the loop.** `correction.ts` hard-codes
 * `predicateCardinality: "single"` on the claim a correction authors, and its
 * comment argues that correctly — since #5027 the field gates `in-tension-with`
 * and nothing else, so the verb may decide it. But that decision predates this
 * module: with a predicate arm, a correction's tension scan reached its own
 * slot; with the anchor arm, it reaches every live claim sharing its subject's
 * prefix. `has target raise of` has no row in `brain_predicate_cardinality` at
 * all, and the edge exists. So the reach of this arm was **not** bounded by
 * approved-predicate coverage on the correction lane — only on the sweep lane.
 *
 * ## The bound the correction lane was missing (#5467) — decided, not deferred
 *
 * The paragraph above was filed as #5467 rather than fixed in place. It is
 * fixed now, and the decision is stated here once because this is the module
 * whose reach made it necessary. The reader who meets the hard-code first finds
 * the same decision on `correction.ts`.
 *
 * **A correction may assert `single` about the slot it CORRECTED. It may not, on
 * the strength of that assertion, reach slots it did not correct.**
 *
 * The verb's argument had two premises and the arm falsified one of them. That
 * the consequence is ADVISORY survives — a wrong flag still costs a reviewer a
 * glance. That *a human superseding a slot has asserted BY THEIR ACTION that it
 * holds one value* does **not**: the action is about ONE slot, and this arm
 * spends it on every live claim under the subject's prefix. #5027's answer to
 * *who may say a predicate is single-valued* is the curated entry — a verb is a
 * repeat-gated PROPOSER that writes `pending`, which the correction's own
 * comment already said. Reaching past the slot is the part that needs the
 * authority the verb does not have.
 *
 * So {@link exactSlotSql} stays licensed by the producer's per-claim hint, and
 * the ANCHOR arm on that lane is licensed by `cardinalitySingleSql` — the same
 * approved entry `TENSION_SWEEP_SQL` reads. `reconcile.ts` carries the gate as
 * one extra conjunct on `TENSION_CANDIDATES_SQL` rather than as a second reach,
 * so this builder's output is byte-identical at both call sites and the two
 * statements still cannot drift about what "in tension" means.
 *
 * ⚠️ **The EXTRACT lane is deliberately untouched, and that is not an
 * oversight.** The extractor's per-claim `single` guess still arms this arm with
 * no curation anywhere. That trade was made WITH this arm in view — #5438 built
 * the arm knowing the gate was a model's guess, and
 * `docs/prd/company-atlas.md`'s condition 4 records it as a named limit ("a
 * model at ingest, or a human at the sweep"). The correction lane's hard-code is
 * the one that was never re-made at this width. Closing the extract lane too
 * would be a weakening of the anchor arm in the general case, which #5467
 * explicitly declines to ask for; if it should close, it closes on its own
 * evidence and its own issue.
 *
 * ⚠️ **One-of-three, and then one-of-two, on a corpus of 35 facts in ONE
 * workspace with two producers, is NOT a precision rate and does not
 * generalize.** It is evidence of exactly one thing: the predicted cost is real
 * and lands where this header predicted it. Nothing here licenses a number for a
 * corpus of any other size or shape.
 *
 * ## What bounds the spike, stated as the correction it is
 *
 * The PRD warns that the first sweep after this arm *"mints anchor-only
 * advisory edges across ALL of history at once"*, which reads as a HISTORY
 * problem. It is not. `TENSION_SWEEP_SQL` gates every candidate on
 * `cardinalitySingleSql`, which needs an entry that is `single` **and**
 * `status = 'approved'` — so the sweep's blast radius is **approved-predicate
 * coverage, not the corpus**. A workspace that has curated nothing sweeps
 * nothing, however long its history.
 *
 * The four entries that would widen it on the measured workspace, named rather
 * than counted, because "the four pending ones" is not something a future
 * reader can act on: **`plan tier`**, **`name`**, **`region`** and
 * **`is active`** — all `single`, all `pending`, all proposed by `warehouse:v1`.
 * Approving any of them arms the sweep for every subject carrying that
 * predicate. (Measured 2026-08-26: on this corpus that is zero edges, for the
 * structural reason given below — but the bound is the curation, and the zero
 * is a property of this workspace's shape rather than of the gate.)
 *
 * ⚠️ **That bound now holds for the CORRECTION lane's anchor arm too, and for
 * nothing else** (#5467, above). Its exact-slot arm and the whole EXTRACT lane
 * still run on the producer's per-claim hint, so "approved-predicate coverage"
 * corrects the PRD about the sweep without being the whole story anywhere else.
 *
 * ## Asking the question before paying the cost
 *
 * Both measurements above were taken by pasting `TENSION_SWEEP_SQL`'s CTEs into
 * `psql` with the gate replaced by `TRUE` — a second spelling of this rule,
 * living on an issue, drifting from the day it was written.
 * `tension-sweep.ts`'s `forecastTensionEdges` is that scan as shipped code — a
 * plain reference rather than a `{@link}`, because this module must not import
 * from the statement that imports it. It runs the sweep's
 * own statement with the INSERT replaced by a count, and takes a counterfactual
 * predicate, so *"how many edges would approving `plan tier` mint?"* is a
 * request rather than a hand-written query. Measured through it on 2026-08-26,
 * the answer for all four of that workspace's pending warehouse predicates was
 * **zero** — the warehouse producer writes one episode per run and one row per
 * `(subject, predicate)` slot, so the anchor arm's different-episode requirement
 * and the exact-slot arm both come up empty. The bound named above ("the
 * different-episode arm removes the largest false class outright") is doing more
 * work in practice than it reads like.
 *
 * ## The anchor is a PREFIX test, and that is not a similarity rule
 *
 * {@link subjectAnchorSql} admits two subject keys when one is a whole-token
 * prefix of the other. That is the exact signature of the drift measured above —
 * the extractor APPENDS the absorbed word to the subject — and it is not a
 * resemblance metric: no stemming, no edit distance, no embedding, no shared-
 * token score. `series b` anchors `series b fundraise`; `series b` and `series c`
 * are unrelated under it, as are `deploy window` and `window deploy`.
 *
 * `starts_with(a, b || ' ')` rather than `LIKE b || ' %'`, and the difference is
 * a real surface rather than a style note: `%` and `_` are LIKE metacharacters
 * and a subject key may contain `%` (`50% owner` norms to `50% owner` — the
 * lexical layer folds case and separators and touches nothing else). `_` cannot
 * survive `lexicalNorm`, `%` can, and under `LIKE` it would match anything.
 * `starts_with` has no pattern semantics at all.
 *
 * The explicit `|| ' '` is what makes it a TOKEN boundary. Without it `series b`
 * anchors `series bridge`, which is two different rounds reading as one.
 * `lexicalNorm` collapses every separator run to exactly one space and trims the
 * edges, so a single literal space is the whole boundary vocabulary and the test
 * is exact rather than approximate.
 *
 * ## Index cost, measured against the shape rather than assumed
 *
 * `idx_brain_facts_subject` is `(workspace_id, subject_key, predicate_key)
 * WHERE invalidated_at IS NULL AND valid_to IS NULL`. The exact arm is an index
 * seek and stays one. The anchor arm is not: `starts_with(subject_key, $2 || ' ')`
 * is prefix-anchored but the database's default collation is not `C`, so it
 * cannot become a range scan, and the reverse direction
 * `starts_with($2, subject_key || ' ')` is not indexable in any collation.
 *
 * What that leaves is a scan of the WORKSPACE's live facts — the index still
 * leads with `workspace_id` and the partial predicate still excludes retracted
 * and superseded rows — filtered by the anchor. It is bounded by one workspace's
 * live corpus, which is the population `loadTensionClusters` already reads in
 * full behind the review queue. Named here because it is a real change to the
 * ingest path's cost profile and a future reader measuring a slow reconcile
 * should find it written down rather than infer it.
 */

/**
 * *These two subject keys are the same subject, up to segmentation drift.*
 *
 * Equal, or one a whole-token prefix of the other. See the header for why the
 * boundary is a literal space, why it is `starts_with` and not `LIKE`, and why
 * this is not a similarity rule.
 *
 * Both operands are compared as stored. No re-derivation: ADR-0037 §1
 * materializes keys at the reconcile seam and §8 settles that a consumer never
 * recomputes one.
 *
 * `a` / `b` are interpolated; callers pass column expressions or bind
 * placeholders they control — the same contract as `comparableDifferentSql` and
 * `subjectNotDifferentSql`.
 *
 * PARENTHESIZED for `comparableDifferentSql`'s stated reason: the arms are an
 * `OR`, and an unparenthesized `OR` spliced into an `AND` chain binds looser
 * than the conjunction and re-widens the whole join.
 */
export function subjectAnchorSql(a: string, b: string): string {
  return `(${a} = ${b}
      OR starts_with(${a}, ${b} || ' ')
      OR starts_with(${b}, ${a} || ' '))`;
}

/**
 * The column expressions and binds one side of {@link tensionReachSql} is read
 * from.
 *
 * ⚠️ **The `Expr` suffix is load-bearing, not decoration.** These fields hold a
 * SQL FRAGMENT — a column expression or a bind placeholder — and never a key's
 * VALUE. `keys-not-on-the-wire.test.ts` scans every brain file for a field
 * spelled `subjectKey` / `predicateKey`, deliberately over-broad, because a
 * fact-shaped TYPE that grows a key field is how a key reaches a consumer that
 * can branch on it — and brain reads are raw SQL, so that guard's SELECT-span
 * arm would not see it. The suffix is the same one `cardinalitySingleSql`
 * already uses for a parameter in this position (`predicateKeyExpr`), so it is
 * this subsystem's existing spelling for *"names the column, does not carry it"*
 * rather than a way around the scan. Renaming these fields back trips that suite
 * on THIS file first — it is itself in scan scope, since it names
 * `idx_brain_facts_subject` — and on `reconcile.ts` after, which is the correct
 * outcome in both places.
 */
export interface SlotSide {
  /** `subject_key` — a column expression or a bind placeholder. */
  readonly subjectKeyExpr: string;
  /** `predicate_key` — likewise. */
  readonly predicateKeyExpr: string;
}

/**
 * A {@link SlotSide} plus the episode, for the arm that needs it.
 *
 * SPLIT from {@link SlotSide} rather than one type with an unused field:
 * {@link exactSlotFirstSql} ranks on the slot and has no business naming an
 * episode, and the alternative spelling — one type, callers passing `""` for a
 * field the builder ignores — is an empty string reaching a SQL builder, which
 * is the shape that produces a silently malformed statement the first time
 * someone starts reading it.
 */
export interface TensionReachSide extends SlotSide {
  /** `source_episode_id` — a column expression or a bind placeholder. */
  readonly episodeIdExpr: string;
}

/**
 * *This live claim is close enough to be worth flagging as a rival* — the two
 * arms, replacing the bare `subject_key = … AND predicate_key = …` pair that
 * `TENSION_CANDIDATES_SQL` and `TENSION_SWEEP_SQL` carried before #5438.
 *
 *   - **The exact slot**, unchanged: same subject key AND same predicate key.
 *     Same-episode rivals still qualify here, exactly as they did — this arm is
 *     byte-identical to what shipped, so nothing that earned an edge before
 *     stops earning one.
 *   - **The anchor arm**: same subject ANCHOR, different episode, NO predicate
 *     test. This is what reaches the #5438 pair, and the header carries the
 *     whole argument for why dropping the predicate is admissible HERE and
 *     nowhere else.
 *
 * ⚠️ **`in-tension-with` only.** Splicing this into `CORROBORATION_LOOKUP_SQL`
 * would attach one claim's evidence to a different claim and widen an ACL from
 * it at the publish gate; splicing it into the supersession collision would
 * stamp `valid_to` across a subject's whole predicate fan. Both are the
 * irreversible direction, and neither is licensed by the argument above.
 *
 * ⚠️ **The different-episode arm belongs to the ANCHOR arm alone.** Hoisting it
 * to the top of the conjunction — the obvious tidy-up, since it reads like a
 * property of the pair — silently removes same-episode rivals from the EXACT
 * slot, which is a class the ingest path has flagged since #4912. That is a
 * behaviour change wearing a refactor's clothes, and it subtracts edges rather
 * than adding them, so nothing downstream would report it.
 *
 * `<>` rather than `IS DISTINCT FROM` on the episode: a NULL on either side
 * makes the arm unknown, a `WHERE` reads that as false, and the pair falls back
 * to the exact slot. Fail-closed, which is the direction a widening arm has to
 * fail in.
 */
export function tensionReachSql(a: TensionReachSide, b: TensionReachSide): string {
  return `(${exactSlotSql(a, b)}
      OR (${subjectAnchorSql(a.subjectKeyExpr, b.subjectKeyExpr)}
          AND ${a.episodeIdExpr} <> ${b.episodeIdExpr}))`;
}

/**
 * *These two claims are in the same slot* — {@link tensionReachSql}'s first arm.
 *
 * Named rather than inlined at both sites because {@link exactSlotFirstSql} has
 * to rank on the SAME test this arm admits on, and two spellings drift.
 *
 * EXPORTED since #5467 for a third consumer with the same requirement:
 * `reconcile.ts` exempts this arm from the correction lane's cardinality gate,
 * so the exemption has to be spelled by the arm itself. A hand-written copy
 * there would be a fourth place that decides what "the same slot" means, and
 * the one it would disagree with is the arm that admits the pair.
 */
export function exactSlotSql(a: SlotSide, b: SlotSide): string {
  return `(${a.subjectKeyExpr} = ${b.subjectKeyExpr} AND ${a.predicateKeyExpr} = ${b.predicateKeyExpr})`;
}

/**
 * *Rank exact-slot rivals ahead of anchor-only ones* — the leading `ORDER BY`
 * term both tension statements take.
 *
 * ## ⚠️ Without this the widening SUBTRACTS edges, which it must not
 *
 * `TENSION_EDGE_CAP` is 10 and both statements are `ORDER BY … LIMIT`, so the
 * cap bites on the CANDIDATE SET — and {@link tensionReachSql} makes that set
 * strictly larger. A subject anchor carrying more than ten live
 * `single`-cardinality claims across episodes can therefore fill the cap with
 * anchor-only rivals that happen to be newer, pushing out the exact-slot rival
 * that earned an edge before #5438.
 *
 * That is a REGRESSION wearing a widening's clothes. It removes a true
 * contradiction from the review queue, and NOTHING would report it: a missing
 * advisory edge is indistinguishable from agreement, which is the whole failure
 * mode this issue exists to close. Found by reading the cap rather than by a
 * test, so the fixture that would catch it is named as absent — the corpus lands
 * two claims per workspace and cannot reach a cap of ten.
 *
 * Ranking the exact slot first makes *"#5438 adds recall and trades none away"*
 * true rather than nearly true. Postgres sorts `true` before `false` under
 * `DESC`, so this is one term and no `CASE`.
 *
 * It is also the better order on its own terms, independent of the cap: a rival
 * sharing the whole slot is stronger evidence of a contradiction than one
 * sharing only a subject anchor, so when the cap must drop something, the
 * anchor-only rivals are what should go.
 *
 * ⚠️ `tension-sweep.ts` records that its ORDER BY and the ingest scan's already
 * differ in the TAIL — it carries an `id` tiebreak the ingest path does not — and
 * that the "same edge set" claim is exact only up to the cap's tail. This term
 * goes at the HEAD of both, so that difference is untouched and the two
 * statements still agree about which rivals are PREFERRED.
 */
export function exactSlotFirstSql(a: SlotSide, b: SlotSide): string {
  return `${exactSlotSql(a, b)} DESC`;
}
