/**
 * "Is this stored fact row an observation?" — asked once, here, for every gate
 * that needs the answer ([ADR-0042](../../../../../docs/adr/0042-warehouse-material-is-an-observation-never-a-published-belief.md)).
 *
 * An **observation** is a recorded reading of a warehouse value at an instant,
 * produced by the warehouse producer for an enrolled `(entity, dimension)`
 * pair. It is stored in `brain_facts`, it is compared against, and it is never
 * reviewed, never served, never corrected. A **belief** is everything else in
 * that table: a claim somebody made, which the review gate exists to bless.
 *
 * ## Why this module exists rather than three call sites
 *
 * The correction path performed this read locally from #4963 until #5340. Under
 * ADR-0042 three more gates need the identical answer — the publish refusal
 * (#5342), the serving exclusion (#5341), and the corroboration lookup (#5332).
 * Without one home each would invent its own spelling of the same question.
 *
 * **That is a documented failure mode in this exact area, not a hypothetical.**
 * #4938 found the tier-1 refusal "one future naming decision away from silently
 * never firing" precisely because the producer and the predicate each spelled
 * their own literal, and every test hand-seeded the same literal it asserted
 * against. The fix then was to name the kind once (`sources.ts`). This is that
 * fix applied one grain up — at the stored ROW rather than the stored VALUE —
 * before three more copies exist rather than after.
 *
 * ## What it reads, and what it must never read
 *
 * The STORED `provenance.source`, and nothing else. This module never issues a
 * warehouse query, and adding one would violate ADR-0037 §5 ("the brain never
 * reads tier-1 live, at any position, for any purpose"). `reconcile.ts` writes
 * `provenance.source` structurally from the episode's stored source kind, so
 * the discriminator is already there on every row this can be handed.
 *
 * It resolves through the source **CLASS** ({@link isWarehouseDerivedSource}),
 * never through a stored literal. A future warehouse-shaped kind that needs its
 * own stored value — the same source-id-collision argument that makes the chat
 * class vendor-grained — is covered the moment its spec declares
 * `class: WAREHOUSE_CLASS`, with nothing to edit here.
 *
 * ## Three answers, not two
 *
 * {@link readStoredSource} is deliberately not a boolean. A row whose stored
 * kind this deployment cannot classify is a THIRD population, and collapsing it
 * into "not an observation" is the fail-open the correction path already
 * refuses to take (#4964): the region import restores a bundle's `source`
 * verbatim (`api/routes/admin-migrate.ts`), so `"snowflake"`, `"warehouse:prod"`
 * and `{ "source": null }` are all reachable at rest, and each of them could be
 * warehouse-shaped. Every gate has to decide what to do with that explicitly.
 * {@link isObservation} exists for the gates whose answer is genuinely binary,
 * and its docstring says which direction it takes and why that is safe there.
 */

import {
  episodeSourceArraySql,
  isEpisodeSource,
  isWarehouseDerivedSource,
  WAREHOUSE_SOURCES,
} from "@atlas/api/lib/brain/sources";

/**
 * A non-null, non-array object — what `jsonb_typeof(...) = 'object'` means.
 *
 * Lives HERE rather than in `promotion.ts`, which defined it from #4769. The
 * move is structural: #5342's publish refusal makes `promotion.ts` a CONSUMER
 * of this module, and a guard defined there and imported back would make the
 * two files mutually dependent — a cycle that `mock.module`-based tests resolve
 * differently depending on which side loads first. Its three consumers
 * (`promotion.ts`, `correction.ts`, and the content-mode adapter) all import it
 * from here; no re-export stands in between.
 */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What a stored fact row's provenance says about the row's nature.
 *
 * `unclassifiable` carries both halves the caller needs and neither can be
 * re-derived without reaching back into an `unknown` payload with a cast:
 *
 *   - `source` — the offending value, rendered for an operator log by
 *     {@link describeSourceValue}. A string is itself; anything else is
 *     reported as its TYPE.
 *   - `resolvable` — whether a FUTURE release could admit it. A string outside
 *     the vocabulary is version skew and heals on a deploy; a non-string never
 *     can, because {@link isEpisodeSource} requires `typeof value === "string"`.
 *     Telling an operator to wait for a deploy on a value no deploy will ever
 *     admit is a false promise on a gate that also blocks `retract`, the
 *     GDPR-erasure verb — which is why the two get different refusal reasons.
 */
export type StoredSourceReading =
  | { readonly kind: "observation" }
  | { readonly kind: "belief" }
  | {
      readonly kind: "unclassifiable";
      readonly source: string;
      readonly resolvable: boolean;
    };

const OBSERVATION: StoredSourceReading = Object.freeze({ kind: "observation" });
const BELIEF: StoredSourceReading = Object.freeze({ kind: "belief" });

/**
 * Read a stored fact row's provenance and say which of the three populations it
 * belongs to. Total over `unknown` — it is handed driver output, not a checked
 * type.
 *
 * ## The order of the arms is behaviour, not style
 *
 * The warehouse arm is evaluated BEFORE the own-key carve-out, and reads
 * `provenance.source` through the prototype chain rather than via
 * `Object.hasOwn`. That is exactly what `correction.ts`'s two predicates did
 * between them from #4964 to #5340, and it is preserved byte-for-byte:
 * `Object.create({ source: WAREHOUSE_SOURCE })` reads as an observation, and
 * would read as a belief under any tidier ordering. Nothing in `brain_facts`
 * produces a prototype-bearing payload today (`JSON.parse` never does), so this
 * is not load-bearing in production — it is load-bearing as a REFACTOR
 * INVARIANT, and it is pinned by a test for that reason.
 *
 * ## The absent-key carve-out
 *
 * A provenance carrying no own `source` key at all reads as a BELIEF. That
 * shape predates the vocabulary lane, nothing structurally guarantees the key
 * (`promotion.ts`'s refusals check `source_episode_id`, not `provenance.source`),
 * and quarantining it would retire the correction path for facts no import ever
 * touched — a regression dressed as a fix.
 *
 * Be honest about the residual, because that carve-out is an evasion one key
 * away: DELETING `source` from a hand-authored import bundle passes
 * `validateBundle` and lands a fully correctable, fully publishable fact. It is
 * accepted anyway — facts predating the lane are the likelier population, and
 * the import route is operator-privileged, so the adversarial reading is weak.
 * The lane is narrowed, not sealed.
 *
 * A key that is PRESENT and does not resolve is `unclassifiable` whatever its
 * type, which is deliberately wider than "present and a string". `null`, `42`
 * and `[]` are reachable on exactly the import lane this exists to close and on
 * no other: `brain_facts` has two writers, and `reconcile.ts` always spreads
 * `source: episode.source` — a `string` by its own type — AFTER the producer's
 * detail, so it always wins and is always a string. The other writer is the
 * import, whose fact validator requires only that `provenance` be a non-empty
 * object and never inspects `.source`.
 */
export function readStoredSource(provenance: unknown): StoredSourceReading {
  if (!isJsonObject(provenance)) return BELIEF;
  // Prototype-inclusive and first, for the reason in the header above.
  if (isWarehouseDerivedSource(provenance.source)) return OBSERVATION;
  // `hasOwn`, not `"source" in provenance` and not a truthiness check on the
  // value: the absent-key carve-out is the ONLY exemption, so it is the only
  // thing that may be tested for. An inherited `source` is not this fact's
  // provenance, and `{ source: "" }` is present-and-unresolvable like any other
  // bad value.
  if (!Object.hasOwn(provenance, "source")) return BELIEF;
  const { source } = provenance;
  if (isEpisodeSource(source)) return BELIEF;
  return {
    kind: "unclassifiable",
    source: describeSourceValue(source),
    resolvable: typeof source === "string",
  };
}

/**
 * The binary form: is this row an observation?
 *
 * **An unclassifiable row answers `false`, and that is only safe where the
 * caller's failure direction is fail-closed already.** Use this at a gate whose
 * non-observation branch is itself a refusal or a narrowing (the serving
 * exclusion keeps such a row out on the ordinary status arm; the publish gate
 * refuses it under its own reason). Use {@link readStoredSource} — and branch
 * on `unclassifiable` explicitly — at any gate where "not an observation" is
 * the PERMISSIVE answer, which is why the correction path does not call this.
 */
export function isObservation(provenance: unknown): boolean {
  return readStoredSource(provenance).kind === "observation";
}

/**
 * Render a rejected `source` for an operator log, without trusting it.
 *
 * A string is itself. Anything else is reported as its TYPE, and neither
 * `String()` nor `JSON.stringify` is used to do better:
 *
 *   * `String()` THROWS on `{"toString": 1, "valueOf": 2}` — `ToPrimitive`
 *     finds both own properties shadowing `Object.prototype` and neither
 *     callable. That object survives `JSON.parse`, and the import's fact
 *     validator only requires a non-empty `provenance` object, so it reaches
 *     here from a bundle. A throw at this point escapes the refusal path
 *     entirely: it unwinds through the rollback as a non-`CorrectionRefusedError`,
 *     the caller gets a generic 500 instead of the designed 409, and the one
 *     log line naming the offending value never emits. Turning a deliberate
 *     refusal into a 500 by formatting its own error message is the failure
 *     this function exists to prevent.
 *   * `JSON.stringify` is total over `JSON.parse` output but renders
 *     `["warehouse"]` as content an operator reads as an in-vocabulary member,
 *     which contradicts the very refusal being logged.
 *
 * The type is the actionable fact anyway: a non-string is not a kind at all,
 * and every caller's log carries the fact id, so the row itself is one query
 * away.
 */
function describeSourceValue(source: unknown): string {
  if (typeof source === "string") return source;
  if (source === null) return "null";
  return `[${typeof source}]`;
}

// ---------------------------------------------------------------------------
// The SQL side of the same question
// ---------------------------------------------------------------------------

/**
 * The warehouse vocabulary as a SQL `text[]` literal.
 *
 * Built once at module load from the same spec map {@link readStoredSource}
 * consults, so the two sides of this file cannot disagree about which stored
 * values are warehouse-class. `EPISODE_SOURCE_SLUG` is enforced over the whole
 * vocabulary at `sources.ts`'s load, which is what makes the splice safe;
 * nothing user-supplied reaches it.
 */
const WAREHOUSE_SOURCE_ARRAY_SQL = episodeSourceArraySql(WAREHOUSE_SOURCES);

/**
 * *This row IS an observation* — the SQL sibling of {@link isObservation}, for
 * the gates that have to answer the question inside a WHERE rather than over a
 * loaded row.
 *
 * It must be a WHERE-clause term and not a post-fetch filter wherever it gates
 * what a reader sees: a predicate applied after ranking leaks existence through
 * result counts and latency even when the rows never render (see
 * `lib/brain/search.ts`'s header on push-down).
 *
 * ## Three populations, and only the first is TRUE
 *
 * The same three {@link readStoredSource} returns, and the mapping is
 * deliberate rather than incidental:
 *
 * | stored `provenance` | this predicate | {@link readStoredSource} |
 * |---|---|---|
 * | no `source` key | NULL | `belief` |
 * | `{"source":"slack"}` | false | `belief` |
 * | `{"source":"snowflake"}` | false | `unclassifiable` |
 * | `{"source":"warehouse"}` | true | `observation` |
 *
 * A positive allowlist, never the negation of a non-warehouse list, and the
 * divergence is the `unclassifiable` row: a kind this region cannot classify is
 * evidence of nothing, so it must not be treated as an observation on a guess.
 * Under this predicate such a row stays SERVED — which is the permissive
 * direction, chosen because the alternative silently hides facts a newer
 * region legitimately exported, and because it keeps this predicate agreeing
 * with {@link isObservation} rather than being a second, stricter rule wearing
 * the same name. The gates that must not be permissive about an unclassifiable
 * row are the ones that refuse it under its own reason (`correction.ts`), and
 * they read the row rather than a WHERE.
 *
 * ⚠️ The NULL arm is why {@link notAnObservationSql} exists rather than callers
 * writing `NOT (…)`. `NOT NULL` is NULL, which a WHERE treats as false — so the
 * naive negation drops every `source`-less fact from the serving path, and
 * those are exactly the facts that predate the provenance shape.
 *
 * `alias` is interpolated; callers pass a plain identifier they control — the
 * same contract as `brainFactStatusClause` and `comparableDifferentSql`.
 */
export function observationSql(alias: string): string {
  return `(${alias}.provenance->>'source' = ANY (${WAREHOUSE_SOURCE_ARRAY_SQL}))`;
}

/**
 * *This row is NOT an observation* — ADR-0042's serving exclusion, in one
 * spelling.
 *
 * `IS NOT TRUE` rather than `NOT`, and that is the whole reason this is a
 * function rather than a call-site negation: it folds the NULL of a
 * `source`-less row to TRUE, so such a fact is still served. See the ⚠️ on
 * {@link observationSql}.
 *
 * This is the exclusion the serving path and the review queue compose, and it
 * is on the SOURCE, not on the status — deliberately, because developer mode is
 * `status IN ('published','draft')` and an exclusion expressed as "never
 * published" would leave the entire comparison surface served under the `/ee`
 * developer overlay (ADR-0042).
 */
export function notAnObservationSql(alias: string): string {
  return `(${observationSql(alias)} IS NOT TRUE)`;
}
