/**
 * The per-CLASS contract — ADR-0040's declaration site, carrying ADR-0041's
 * three coverage properties (#5212).
 *
 * ## What this file is, and what it deliberately is not yet
 *
 * ADR-0040 decided that what the Atlas does with a connected source is a
 * property of the source's CLASS, and named the declaration site: "a class-keyed
 * sibling of `lib/brain/sources.ts` — a `Record<EpisodeSourceClass,
 * ClassContract>` — not an extension of `EPISODE_SOURCE_SPECS`, whose keys are
 * vendor-grained and would hand every vendor a slot to restate the trigger in".
 * That Record is {@link CLASS_CONTRACTS}, and this is its first arrival in code.
 *
 * It arrives carrying ADR-0041's three properties ONLY — vendor-public,
 * staleness capability, denominator source. ADR-0040's own arms (on-connect
 * trigger, extraction, ACL derivation, perimeter) are prose in that ADR; they
 * join {@link ClassContract} as siblings of {@link ClassContract.coverage} as
 * each is implemented. The nesting exists for exactly that reason and for no
 * other: the coverage properties are a different decision's, and grouping them
 * keeps a later reader able to see which ADR put each field here without
 * consulting `git blame`.
 *
 * ⚠️ **This is NOT the only class-keyed Record in the tree, and a reader told
 * "ADR-0040's arms join here" will otherwise not find the one that already
 * shipped.** `AUDIENCE_GRAIN` in `ingest/types.ts` is a
 * `Record<EpisodeSourceClass, AudienceGrain>` deciding at what grain each
 * class's audiences are refreshed, and it makes the same completeness-over-
 * membership argument this file does. The boundary between them: that map is
 * INGEST MECHANICS — which classes need a per-object re-verifier registered —
 * while this one is CONTRACT POLICY. They are candidates to merge the day the
 * ACL-derivation arm lands here; until then, edit the one whose question you
 * are answering, and do not assume either is the whole class axis.
 *
 * ## The one structural guarantee
 *
 * Record TOTALITY. `satisfies Record<EpisodeSourceClass, ClassContract>` makes a
 * class added to `EPISODE_SOURCE_CLASSES` (`sources.ts`) without a contract a COMPILE
 * ERROR rather than a silently missing row — ADR-0041's "Totality at compile
 * time" and ADR-0040's "the Record forces the contract into the same one-line PR
 * that adds the class", which is the same requirement stated from both ends.
 *
 * That guarantee holds only for a class the compiler can see. Every DERIVATION
 * below therefore also carries a runtime arm for a class it cannot resolve — a
 * value arriving through a cast, a separately-compiled plugin, a region import —
 * and every one of those arms fails CLOSED and says so in the log. The posture
 * is the one `classifyToken` takes on an unrecognised principal kind
 * (`oversight.ts`), copied deliberately: withhold, loudly, rather than fall
 * through to a plausible answer.
 *
 * ## Why the coverage properties live HERE rather than in `coverage.ts`
 *
 * ADR-0041 makes `lib/brain/coverage.ts` a sibling module composing oversight,
 * and these three fields are its inputs rather than its internals. Two of them
 * gate DISCLOSURE ({@link ClassCoverageContract.vendorPublic}) and the honesty of
 * a verdict ({@link ClassCoverageContract.activityMetadata}); putting them in the
 * consumer would make each new consumer a new place the answer could be decided.
 * The class contract is where a class answers for itself, once.
 *
 * ## Data and types only
 *
 * Nothing here knows how to call a vendor. `chat-channel-roster` names WHERE a
 * denominator comes from; how Slack's `conversations.list` is paged, which
 * scopes it needs and what it does on a 429 stay in connector code, which is
 * ADR-0040's "vendor variation is confined to mechanics" applied to this file.
 * A vendor-shaped import appearing here is the signal that the boundary moved.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { isEpisodeSourceClass, type EpisodeSourceClass } from "@atlas/api/lib/brain/sources";

const log = createLogger("brain-class-contract");

/**
 * Can the class ask its vendor when a survey unit last moved?
 *
 * ADR-0041 defines stale as a MEASURED LAG — "vendor activity metadata shows
 * source movement newer than our newest observed evidence by more than the
 * class's sync cadence" — so a class that cannot read activity metadata cannot
 * compute the lag, and must say "unverified since \<date\>" instead of guessing
 * in either direction. See {@link stalenessVerdict}, which is the only place
 * that consequence is spelled.
 *
 * `absent` is not a defect to be fixed later. For `human` there is no vendor to
 * ask at all, and for `warehouse` the honest answer is that no general one
 * exists: a survey unit there is an (entity, dimension) pair, and asking when it
 * last moved means a freshness query per entity against the customer's own
 * warehouse — which not every entity can answer (many have no timestamp column)
 * and which ADR-0041 rules out on the page anyway ("never live vendor calls on
 * page view"). Declaring `absent` is what makes those units read "unverified
 * since" rather than silently never appearing stale.
 *
 * ## Why the cadence lives INSIDE the `reports` arm (#5214)
 *
 * It was a bare `"reports" | "absent"` until the coverage module needed the
 * threshold, and the two-line union was the shape this file warned about on
 * {@link stalenessVerdict}: *"the cadence it is measured against is a fourth
 * contract property that belongs HERE when the coverage module needs it — not a
 * constant in that module"*. A sibling `syncCadenceMs?: number` beside a
 * `"reports"` string would have satisfied that literally and left the hazard
 * intact — a class could declare the CAPABILITY with no threshold, and the one
 * consumer would then have to invent one or fall back to a default, which is the
 * same "each new consumer is a new place the answer could be decided" failure
 * arriving through an optional field.
 *
 * Nested, the two cannot be declared apart: `measured-lag` and the number it is
 * measured against arrive together or not at all, and {@link stalenessVerdict}
 * hands the consumer both in one value so there is nothing left to substitute.
 */
export type VendorActivityMetadata =
  | {
      readonly kind: "reports";
      /**
       * How far a source may move ahead of our newest observed evidence before
       * the lag is called stale — ADR-0041's *"more than the class's sync
       * cadence"*.
       *
       * ⚠️ **A CONSTANT, deliberately not the runtime sync knob.** ADR-0041:
       * *"No staleness knob — not env, not the settings registry. A tunable
       * threshold lets an admin define staleness away."*
       * `ATLAS_KNOWLEDGE_SYNC_INTERVAL_HOURS` is exactly such a tunable, and
       * reading it here would let a workspace set the interval to a month and
       * watch every unit turn "current" — the flattering direction, chosen by the
       * person the page exists to inform.
       *
       * The consequence, accepted: a deploy whose knob is SLOWER than the value
       * declared here reports lag the page calls stale. That reads correctly —
       * our evidence really is behind the source by more than the class promises
       * — and the fix is the knob, not the threshold.
       */
      readonly syncCadenceMs: number;
    }
  | { readonly kind: "absent" };

/**
 * The cadence the three connector classes actually sync on.
 *
 * All three ride ONE fiber: `scheduler/brain-coverage-snapshot.ts` enumerates
 * rosters, but EVIDENCE arrives through `lib/knowledge/sync.ts` driven by
 * `scheduler/knowledge-bundle-sync.ts` — `ingest/episode-sync.ts`'s header says
 * so outright ("There is no second scheduler"). So the honest per-class answer
 * is the same number three times today, and it is declared three times anyway:
 * the day a class gets its own fiber it edits its own entry, which a shared
 * constant read from one place would have made an invisible cross-class change.
 *
 * ⚠️ Spelled here rather than IMPORTED from the scheduler, and the difference is
 * layering, not taste: this file declares contract policy and the scheduler
 * declares mechanics, so the import would run the wrong way. What keeps the two
 * from drifting is a check rather than this comment —
 * `class-contract.test.ts` pins this constant against
 * `DEFAULT_KNOWLEDGE_SYNC_INTERVAL_MS`, so moving the sync default reddens here
 * and the threshold has to be re-decided rather than silently left behind.
 */
const CONNECTOR_SYNC_CADENCE_MS = 24 * 60 * 60_000;

/**
 * Where a class's enumerable universe comes from — the DENOMINATOR side of every
 * ratio on the Coverage Surface.
 *
 * A closed vocabulary rather than free text, and NO TWO CLASSES SHARE A MEMBER.
 * That is not tidiness: it is ADR-0041's "No single number, permanently" made
 * structural. The layers are incommensurable — a channel is not a mailbox is not
 * an entity-dimension — so any blend across them needs invented weights, and a
 * shared origin slug is the first thing that would make a blend look defensible.
 * `class-contract.test.ts` asserts the uniqueness so a future class cannot
 * quietly reuse one.
 *
 * Every member is also CREDENTIAL-RELATIVE by construction, which is ADR-0041's
 * other refusal: `chat-channel-roster` is the roster under granted scopes, not
 * every channel the workspace has, and `granted-recording-scopes` says so in its
 * name. No member of this vocabulary means "the company".
 */
export type SurveyUnitOrigin =
  /** The channel roster the granted scopes can enumerate. Units are channels. */
  | "chat-channel-roster"
  /** The recordings inside granted recording scopes. Units are recordings. */
  | "granted-recording-scopes"
  /** The mailboxes the install can enumerate. Units are mailboxes — counted, never named. */
  | "mailbox-list"
  /** Semantic-layer entities crossed with the dimensions a human enrolled (ADR-0039). */
  | "semantic-layer-enrollment";

/**
 * A class's denominator, or its explicit refusal to have one.
 *
 * A discriminated union rather than `SurveyUnitOrigin | null`, because
 * `surveyable: false` is a POSITIVE claim this file makes about `human`.
 * ADR-0040's contract table gives that class no connector and no perimeter
 * ("not connectable … the person's own statement"), so no credential enumerates
 * it; *not a surveyable region* is issue #5212's phrasing for that consequence,
 * and this module's name for it — NOT a quote from either ADR. Reading the
 * refusal off an absent field would make "we decided there is no universe here"
 * indistinguishable from "nobody has filled this in yet". The Coverage Surface
 * must render those two differently: the first is a class that correctly never
 * appears in a ratio, the second is a bug.
 */
/**
 * What a class may DECLARE about its universe, in {@link CLASS_CONTRACTS}.
 *
 * `non-surveyable-class` is `human`'s declared refusal — an affirmative product
 * statement, and a class that correctly never appears in a ratio.
 *
 * ⚠️ The fail-closed reason is deliberately NOT in this union. "We could not
 * resolve this class" is never a true statement about an entry sitting in the
 * map, and the map is the only producer of a declared denominator — so a
 * contract declaring it is unrepresentable rather than merely untested.
 */
export type DeclaredDenominator =
  | { readonly surveyable: true; readonly enumeratedFrom: SurveyUnitOrigin }
  | { readonly surveyable: false; readonly reason: "non-surveyable-class" };

/**
 * What a DERIVATION returns — a declaration, or the fail-closed refusal.
 *
 * The reason is what the surface renders differently, and its omission was the
 * original defect: without it the two refusals are byte-identical and only a
 * `log.warn` separates them, which a page cannot read. ADR-0041 calls a silent
 * zero here "a false statement, not an error state", so the page owes a "cannot
 * establish" arm for the fail-closed one rather than a clean absence.
 */
export type ClassDenominator =
  | DeclaredDenominator
  | { readonly surveyable: false; readonly reason: "unresolvable-class" };

/**
 * Which staleness sentence a class's units are entitled to.
 *
 * `measured-lag` licenses the word "stale" — the class can read vendor activity
 * metadata, so the surface may compare source movement against our newest
 * observed evidence and report a lag it actually measured. `unverified-since` is
 * the other sentence and the only other one, and it carries its reason for the
 * same reason {@link ClassDenominator} does: a class that DECLARED it cannot
 * measure lag and a class nobody has written a contract for produce the same
 * sentence, and the second one is a bug the page must be able to see.
 */
export type StalenessVerdict =
  /**
   * A lag is COMPUTABLE for this class — not "this unit is stale", and not a
   * lag anyone has measured yet.
   *
   * The threshold it is measured against travels ON this arm as of #5214, and
   * that is the whole point of carrying it: an earlier version said the cadence
   * "is NOT in this contract … a consumer must not substitute one", which is a
   * rule a consumer can only obey by having nothing to do. Now the capability
   * and its constant arrive together, so there is nothing to substitute. Stated
   * on the member as well as on the function because a consumer that
   * destructures the union never reads the function's docstring.
   */
  | { readonly kind: "measured-lag"; readonly syncCadenceMs: number }
  | {
      readonly kind: "unverified-since";
      readonly reason: "no-activity-metadata" | "unresolvable-class";
    };

/** ADR-0041's three properties, as one class answers them. */
export interface ClassCoverageContract {
  /**
   * May this class's units EVER qualify for the vendor-public label clause?
   *
   * ⚠️ **A class-level admissibility gate, not a per-unit verdict** — read the
   * two together or you will get this backwards. ADR-0041's second label clause
   * is "vendor-public existence — the unit's existence is unconditionally
   * visible to every member of the vendor workspace (a public Slack channel's
   * name, by Slack's own definition)". Whether a PARTICULAR channel is public is
   * the vendor's answer about that channel; this flag says whether the class has
   * any such notion for the clause to lean on at all.
   *
   * The two are ANDed in {@link coverageLabelPolicy}, so a class declaring
   * `false` cannot be overridden by a caller claiming a unit is public — which
   * is the direction that matters, because the caller's claim comes from vendor
   * data and this flag is where a human decided the vendor's notion of "public"
   * is one Atlas will disclose on.
   *
   * **Defaults closed.** `true` on `chat` alone today, and that entry carries
   * the argument. A class must argue its way open, the same posture
   * `classifyToken` takes on an unrecognised principal kind: the clause leans on
   * each vendor's notion of "public", and a class that has not been examined has
   * not had that notion examined either.
   */
  readonly vendorPublic: boolean;

  /** See {@link VendorActivityMetadata} — whether "stale" is computable at all. */
  readonly activityMetadata: VendorActivityMetadata;

  /** See {@link DeclaredDenominator} — the enumerable universe, or the refusal of one. */
  readonly denominator: DeclaredDenominator;
}

/**
 * What one class declares about itself.
 *
 * One field today. ADR-0040's arms — on-connect trigger, extraction, ACL
 * derivation, perimeter — join as siblings of {@link coverage} when that ADR's
 * implementation is scheduled; nothing about the coverage shape has to move when
 * they do, which is the whole reason for the nesting.
 */
export interface ClassContract {
  readonly coverage: ClassCoverageContract;
}

/**
 * THE contract, per class — ADR-0040's declaration site.
 *
 * Frozen at every level, not merely `as const`. `as const` is a TYPE-level
 * assertion and leaves the object mutable at runtime, and this map is a
 * DISCLOSURE gate: a single write to `CLASS_CONTRACTS.email.coverage.vendorPublic`
 * would open mailbox naming — the disclosure ADR-0041 refuses by name — with no
 * log, no throw and no red test, because every reader would see the same mutated
 * map and stay agreed while all of them were wrong. That is `sources.ts`'s
 * argument for freezing `EPISODE_SOURCE_SPECS`, and it applies with the same
 * force one seam over. The nested objects need their own freeze because
 * `Object.freeze` is shallow, and the gate lives two levels down.
 *
 * `satisfies Record<EpisodeSourceClass, ClassContract>` on the frozen result is
 * the totality gate; the per-entry `satisfies` inside is not redundant with it.
 * `Object.freeze(...)` is a CALL RESULT rather than a fresh object literal, and
 * TypeScript only runs excess-property checking against a fresh literal — so
 * without the inner ones, an invented field (`vendorPublik`, `stale`) lands in
 * the contract unnoticed, on the map whose job is to be the single place a class
 * answers for itself.
 *
 * ⚠️ **A `satisfies` guards only the literal it is ATTACHED TO, and this map is
 * three levels deep — so there is one on every level.** The first draft carried
 * a single `as const satisfies ClassContract` on the outer literal and the
 * docstring claimed it caught invented fields; measured, it did not. That
 * literal is `{ coverage: <call result> }`, so excess-property checking fires on
 * the key `coverage` and stops there: `vendorPublik: true` beside `vendorPublic`
 * and `weight: 3` inside a denominator both compiled clean. `sources.ts` gets
 * this right for free because `EPISODE_SOURCE_SPECS`'s entries are LEAF literals
 * and its `satisfies` sits on them; copying the idiom to a nested shape without
 * moving it down is how the guarantee silently evaporates.
 *
 * What keeps it from evaporating again is a SOURCE-TEXT pin
 * (`class-contract.test.ts`, "carries a `satisfies` at EVERY level"), because
 * nothing else can: a `satisfies` is erased at runtime and asserts nothing about
 * itself, so deleting one here is invisible to `tsc` and to every behavioural
 * test. Measured — removing an entry's level-2 annotation leaves both clean.
 * The `@ts-expect-error` pins beside it are a DIFFERENT guarantee: they hold
 * that {@link ClassCoverageContract} and {@link ClassDenominator} are closed, so
 * that these annotations have something to bite on.
 *
 * ⚠️ What NEITHER check does is verify the answer is RIGHT. Nothing in the type
 * system knows what "vendor-public" means; a new class declaring `vendorPublic:
 * true` compiles clean. The defaults are what make that survivable — a class
 * copied from `human` discloses nothing — and `class-contract.test.ts`'s pinned
 * table is what forces an author to confront each answer deliberately.
 *
 * ⚠️ **Exported for DECLARATION and for the contract tests, not for lookup.**
 * Read a class's answer through {@link coverageLabelPolicy},
 * {@link stalenessVerdict} or {@link classDenominator} — every one of them
 * carries a fail-closed arm and a log line for a class this deploy cannot
 * resolve. Indexing this map directly (`CLASS_CONTRACTS[row.source as
 * EpisodeSourceClass]`) bypasses all three silently, which is precisely the
 * "each new consumer is a new place the answer could be decided" failure the
 * unexported {@link contractOf} exists to prevent — arriving through this
 * export instead.
 */
export const CLASS_CONTRACTS = Object.freeze({
  /**
   * The one class that argues its way open on `vendorPublic`, and the only one
   * ADR-0041 names: a public Slack channel's name is visible to every member of
   * the workspace by Slack's own definition, so labelling one on the Coverage
   * Surface discloses to an admin nothing that any member could not already read
   * off the channel browser. Private channels in the same class are NOT thereby
   * disclosable — that is the per-unit half, and {@link coverageLabelPolicy} ANDs
   * the two.
   */
  chat: Object.freeze({
    coverage: Object.freeze({
      vendorPublic: true,
      activityMetadata: Object.freeze({
        kind: "reports",
        syncCadenceMs: CONNECTOR_SYNC_CADENCE_MS,
      } as const satisfies VendorActivityMetadata),
      denominator: Object.freeze({
        surveyable: true,
        enumeratedFrom: "chat-channel-roster",
      } as const satisfies DeclaredDenominator),
    } as const satisfies ClassCoverageContract),
  } as const satisfies ClassContract),

  /**
   * `vendorPublic: false`. A recording's existence is not workspace-public: a
   * meeting is visible to its participants and to whoever holds the recording
   * scope, which is the same population whose ACL the transcript class derives
   * from a frozen participant list (`sources.ts`, `TRANSCRIPT_CLASS`). Naming a
   * recording names a meeting a reader may not have been in.
   */
  transcript: Object.freeze({
    coverage: Object.freeze({
      vendorPublic: false,
      activityMetadata: Object.freeze({
        kind: "reports",
        syncCadenceMs: CONNECTOR_SYNC_CADENCE_MS,
      } as const satisfies VendorActivityMetadata),
      denominator: Object.freeze({
        surveyable: true,
        enumeratedFrom: "granted-recording-scopes",
      } as const satisfies DeclaredDenominator),
    } as const satisfies ClassCoverageContract),
  } as const satisfies ClassContract),

  /**
   * `vendorPublic: false`, and this is the class where the refusal is sharpest:
   * ADR-0041 spells it out — "naming a mailbox is naming a person" — so the
   * email class's state-2 display is "N mailboxes enumerated, M surveyed" with no
   * list. The denominator still exists and is still counted; it is the LABEL that
   * is withheld, which is the whole of the counts-always/labels-by-clause split.
   */
  email: Object.freeze({
    coverage: Object.freeze({
      vendorPublic: false,
      activityMetadata: Object.freeze({
        kind: "reports",
        syncCadenceMs: CONNECTOR_SYNC_CADENCE_MS,
      } as const satisfies VendorActivityMetadata),
      denominator: Object.freeze({
        surveyable: true,
        enumeratedFrom: "mailbox-list",
      } as const satisfies DeclaredDenominator),
    } as const satisfies ClassCoverageContract),
  } as const satisfies ClassContract),

  /**
   * The one surveyable class whose units are freely NAMABLE anyway, and it gets
   * there by the other clause rather than this one. `vendorPublic: false` because
   * a warehouse has no notion of workspace-public entities; the labels appear
   * because enrollment is a DELIBERATE ACT (ADR-0039 — a human enrolled the
   * dimension) and because the admin authored the semantic layer the entities
   * come from. Pinning that distinction is why {@link CoverageLabelDecision}
   * carries the clause that fired rather than a bare boolean.
   *
   * `activityMetadata: "absent"` — see {@link VendorActivityMetadata}.
   */
  warehouse: Object.freeze({
    coverage: Object.freeze({
      vendorPublic: false,
      activityMetadata: Object.freeze({ kind: "absent" } as const satisfies VendorActivityMetadata),
      denominator: Object.freeze({
        surveyable: true,
        enumeratedFrom: "semantic-layer-enrollment",
      } as const satisfies DeclaredDenominator),
    } as const satisfies ClassCoverageContract),
  } as const satisfies ClassContract),

  /**
   * Explicitly non-surveyable, and present for exactly that reason. A person's
   * own recorded words (`correct_fact`'s correction episode) come from no
   * connector, and no credential enumerates "the set of humans who might state
   * something" — ADR-0040's contract table gives the class no perimeter at all
   * ("not connectable"). ADR-0041 never assigns it a denominator because that
   * ADR only ever discusses classes a credential can enumerate.
   *
   * Omitting the class would have said the same thing far more weakly — an
   * absent row is indistinguishable from an unfinished one, and the Record's
   * totality gate exists precisely so that no class is absent. Declaring the
   * refusal is what lets the Coverage Surface leave `human` out of every ratio on
   * purpose rather than by accident.
   */
  human: Object.freeze({
    coverage: Object.freeze({
      vendorPublic: false,
      activityMetadata: Object.freeze({ kind: "absent" } as const satisfies VendorActivityMetadata),
      denominator: Object.freeze({
        surveyable: false,
        reason: "non-surveyable-class",
      } as const satisfies DeclaredDenominator),
    } as const satisfies ClassCoverageContract),
  } as const satisfies ClassContract),
}) satisfies Record<EpisodeSourceClass, ClassContract>;

/**
 * Compile-time tie between the Record's KEYS and the closed class set, in the
 * shape `sources.ts` uses for the same job (`_CLASS_AXIS_IN_SYNC`).
 *
 * The `satisfies` above already makes a MISSING class an error. This catches the
 * other direction — a key that is not a class — which `satisfies` does not,
 * because `Object.freeze(...)` is a call result and excess-property checking
 * only fires on a fresh literal. An extra key is harmless at runtime (nothing
 * would read it) and corrosive on the page: it is a contract somebody wrote for
 * a class that does not exist, and it would sit here looking answered.
 */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _CONTRACT_KEYS_IN_SYNC: MutuallyAssignable<
  keyof typeof CLASS_CONTRACTS,
  EpisodeSourceClass
> = true;
void _CONTRACT_KEYS_IN_SYNC;


/**
 * The three reason vocabularies, pinned CLOSED — mutual assignability, so BOTH
 * growth and shrinkage are errors here rather than somewhere downstream.
 *
 * The `@ts-expect-error` pins in `class-contract.test.ts` were believed to do
 * this and measurably do not: an invented literal is not assignable to a union
 * whether or not a fourth member exists, so those directives pin only that the
 * field is not `string`. Adding a fourth reason left `tsc` clean — the module's
 * fourth measured-false guarantee, and by the same ratchet it gets a mechanism
 * rather than a corrected comment.
 *
 * Why it matters: each reason is a different SENTENCE the Coverage Surface says
 * to an admin. A fourth arriving with no consumer forced to handle it is how one
 * of those sentences silently becomes "some other case", which is the fabrication
 * ADR-0041 refuses.
 */
const _LABEL_REASONS_CLOSED: MutuallyAssignable<
  Extract<CoverageLabelDecision, { policy: "count-only" }>["reason"],
  "no-clause" | "non-surveyable-class" | "unresolvable-class"
> = true;
void _LABEL_REASONS_CLOSED;

const _DENOMINATOR_REASONS_CLOSED: MutuallyAssignable<
  Extract<ClassDenominator, { surveyable: false }>["reason"],
  "non-surveyable-class" | "unresolvable-class"
> = true;
void _DENOMINATOR_REASONS_CLOSED;

const _STALENESS_REASONS_CLOSED: MutuallyAssignable<
  Extract<StalenessVerdict, { kind: "unverified-since" }>["reason"],
  "no-activity-metadata" | "unresolvable-class"
> = true;
void _STALENESS_REASONS_CLOSED;

/**
 * …and the DECLARED denominator's reason, which is narrower than the derived
 * one on purpose: the map may never declare the fail-closed reason.
 */
const _DECLARED_DENOMINATOR_REASON_CLOSED: MutuallyAssignable<
  Extract<DeclaredDenominator, { surveyable: false }>["reason"],
  "non-surveyable-class"
> = true;
void _DECLARED_DENOMINATOR_REASON_CLOSED;

/**
 * Diagnostic context a caller attaches to the fail-closed log lines.
 *
 * `workspaceId` is REQUIRED, on `oversight.ts`'s `CountMeta` terms exactly: the
 * whole value of these lines is telling an operator why a class went quiet, and
 * in a 3-region multi-tenant deploy a warn with no workspace cannot do that.
 * Optional-or-complete, never partial — the `meta` parameter itself is what a
 * caller omits.
 */
export interface ClassContractLogMeta {
  readonly workspaceId: string;
  readonly requestId?: string;
}

/**
 * The contract for a class, or `null` when the value is not one this deploy can
 * resolve — the total lookup every derivation below is built on.
 *
 * `unknown` rather than `EpisodeSourceClass` for the same reason
 * `episodeSourceClassOf` takes it: the values that make a fail-closed arm worth
 * having are exactly the ones no type system has checked. A region import
 * restores a bundle's stored `source` verbatim (`sources.ts`, § "Where that lane
 * is closed"), a separately-compiled plugin reaches the registry as data, and
 * `row.source as EpisodeSource` is the cast someone writes when neither of those
 * is on their mind.
 *
 * The narrow is what makes the bare index below safe, and it carries two jobs
 * rather than one. Obviously it refuses `"docs"`. Less obviously it refuses
 * `"toString"` and `"constructor"`: `CLASS_CONTRACTS["toString"]` resolves up the
 * PROTOTYPE CHAIN to a function, whose `.coverage` is `undefined`.
 *
 * ⚠️ **What happens next was MEASURED, and it SPLITS** — which matters, because
 * both of the tidy one-line answers are wrong. For an unknown slug (`"docs"`),
 * for `null`, for a number or a plain object, the bare index yields `undefined`,
 * `!contract` catches it, and the derivations fail closed exactly as they do
 * today — by accident, but correctly. The PROTOTYPE keys are the other half:
 * `CLASS_CONTRACTS["toString"]` resolves to a FUNCTION, which is truthy, so
 * `!contract` misses it and reading through `contract.coverage` throws
 * `TypeError: undefined is not an object` (bun's wording; V8 says "Cannot read
 * properties of undefined").
 *
 * Measured over `class-contract.test.ts`'s hostile corpus: 6 throw, 15 fail
 * closed. So the cost of losing this narrow is a THROWN page render on the six
 * — worse than fail-closed, and worth knowing before anyone decides the narrow
 * is redundant.
 *
 * Deliberately NOT quoting WHICH property the message names. An earlier draft
 * did, and the guard added one commit later (the non-surveyable refusal, which
 * reads `denominator` before anything else) silently made the quote wrong. The
 * three derivations do not even agree with each other — two throw on
 * `denominator`, one on `activityMetadata` — so any single property name would
 * have been wrong for at least one arm from the day it was written.
 *
 * So there is deliberately no `Object.hasOwn` guard on the index, the way
 * `specOf` carries one in `sources.ts`. That function does not narrow its own
 * parameter, so its guard is the BACKSTOP for a caller that skipped
 * `isEpisodeSource` — its own docstring says exactly that, "the backstop, not
 * the gate". Here the narrow is in front of the index, so a second guard behind
 * it would be an arm no input can reach, carrying a comment claiming it does
 * work. `class-contract.test.ts` puts
 * the prototype keys through every derivation, and dropping this narrow reddens
 * exactly three of its tests — which is where the claim is checked rather than
 * asserted.
 *
 * Not exported. Every caller wants one of the three derivations, each of which
 * has its own fail-closed answer and its own log line; handing out the `null`
 * would make each new consumer a new place to decide what `null` means.
 */
function contractOf(value: unknown): ClassContract | null {
  return isEpisodeSourceClass(value) ? CLASS_CONTRACTS[value] : null;
}

/**
 * What each derivation's fail-closed answer COSTS, in the operator's terms.
 *
 * Keyed by derivation so the log line states the consequence rather than the
 * mechanism. "Failing closed" describes what the code did; an operator needs to
 * know which part of the page just went quiet, and the three are genuinely
 * different. Same posture as `oversight.ts`'s opaque-handle warn, which spells
 * out its consequence and even scopes it ("Counts are unaffected").
 */
const FAIL_CLOSED_CONSEQUENCE = {
  coverageLabelPolicy: "no unit of this class will be named; its counts are unaffected",
  stalenessVerdict: 'this class can never report a measured lag; its units read "unverified since"',
  classDenominator: "this class has no enumerable universe, so it falls out of every ratio",
} as const;

/**
 * The derivations that can meet an unresolvable class.
 *
 * ⚠️ This closed set ties the call sites to the MAP above — NOT to the function
 * names. {@link _DERIVATION_NAMES_IN_SYNC} at the bottom of this file is what
 * closes that, and carries the argument.
 */
type ClassContractDerivation = keyof typeof FAIL_CLOSED_CONSEQUENCE;

/**
 * How long the EMITTED `classValue` field may be before it truncates.
 *
 * On the quoted form, not the raw one — see {@link describeClassValue}. Exported
 * so `class-contract-logging.test.ts` asserts the bound against the constant
 * rather than a second copy of the number: a test that spells its own 128 keeps
 * passing when the constant moves, which is the drift that made an earlier
 * `toBeLessThan(200)` unable to see a 128 -> 190 change.
 */
export const CLASS_VALUE_LOG_MAX = 128;

/**
 * Describe an unresolvable class value for the log, without trusting it.
 *
 * `null` is spelled out rather than left to `typeof`, and that is the case most
 * likely to actually occur: the plausible production producer of an unresolvable
 * class is `episodeSourceClassOf(row.source)` (`sources.ts`), which returns
 * `null` for exactly the region-import lane these arms exist for. Under a bare
 * `typeof` that logs as `"object"` — indistinguishable from `{ class: "chat" }`
 * and from `["chat"]`, so the highest-probability real input produced the least
 * legible line.
 *
 * Strings are truncated because `brain_episodes.source` is plain `text` with no
 * CHECK and the region import restores it verbatim, so the value is unbounded.
 * `lib/audit/error-scrub.ts` truncates for the same stated reason — an oversized field
 * pushes the structured ones past log-aggregation size limits, which loses the
 * `workspaceId` this line exists to carry.
 *
 * ⚠️ **Strings are QUOTED, which is the same argument as the `null` spelling
 * applied to the whole class rather than to one instance.** Unquoted, three real
 * inputs were unreadable: `""` looked like a missing field, `"human "` (the
 * whitespace near-miss that is exactly what an operator is debugging) looked
 * like `human`, and a stored value of literally `"null"` was the sentinel for a
 * real `null`. The only discriminant was whether `classValueLength` happened to
 * be present — a rule nobody reading a log knows. `JSON.stringify` also escapes
 * control characters and newlines, so a tenant-controlled value cannot forge a
 * line at a console sink.
 *
 * ⚠️ **Quote FIRST, then bound — the order is the whole point of the bound.**
 * Truncating the input and escaping afterwards bounds the wrong string: escaping
 * expands, so 128 NUL characters emitted a 770-character field, roughly six
 * times the intended size and past the 512 the cited precedent holds. The
 * rationale here is an OUTPUT property, so the bound has to be on the output.
 * The ellipsis goes inside the closing quote so the field still reads as a
 * quoted string rather than as truncated JSON.
 */
function describeClassValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value !== "string") return typeof value;
  const quoted = JSON.stringify(value);
  return quoted.length > CLASS_VALUE_LOG_MAX
    ? `${quoted.slice(0, CLASS_VALUE_LOG_MAX)}…"`
    : quoted;
}

/**
 * Log an unresolvable class, in one voice, from whichever derivation met it.
 *
 * `log.warn` and not `debug`: reaching any of these with a class this deploy
 * cannot resolve means a survey unit is being counted whose contract nobody has
 * written, and the surface is about to under-report it. Not an error — the
 * fail-closed answer is a correct answer, and ADR-0041 wants the page to keep
 * rendering — but it is the line an operator needs to explain why a class went
 * quiet after a deploy.
 *
 * The two context fields are named rather than spread. Excess-property checking
 * only fires on a fresh literal, so `{...meta}` let a caller passing a WIDER
 * variable — a request context, a job record — put every field it happened to
 * carry into a line whose stated job is to stay small enough that `workspaceId`
 * survives aggregation limits. Naming them also makes "a caller cannot shadow
 * the diagnostics" structural instead of a fact about spread order.
 */
function warnUnresolvable(
  value: unknown,
  derivation: ClassContractDerivation,
  meta?: ClassContractLogMeta,
): void {
  log.warn(
    {
      workspaceId: meta?.workspaceId,
      requestId: meta?.requestId,
      derivation,
      classValue: describeClassValue(value),
      classValueLength: typeof value === "string" ? value.length : undefined,
    },
    `brain class contract: no contract for this source class — failing closed; ${FAIL_CLOSED_CONSEQUENCE[derivation]}`,
  );
}

/** Why a survey unit's label may be shown, or why it may not. */
export type CoverageLabelDecision =
  | {
      readonly policy: "name";
      /**
       * Which of ADR-0041's two clauses admitted it. Carried rather than
       * collapsed to a boolean because the clauses are separately revocable and
       * separately arguable, and because a test that cannot tell them apart
       * cannot catch a change that swaps which one is doing the work — the
       * warehouse entry is exactly that case, labelled under `deliberate-act`
       * while declaring `vendorPublic: false`.
       */
      readonly clause: "deliberate-act" | "vendor-public";
    }
  | {
      readonly policy: "count-only";
      /**
       * `no-clause` is the ordinary withhold — an enumerated mailbox nobody
       * named. `unresolvable-class` is the fail-closed arm, kept distinct so the
       * surface can tell "we counted this and correctly did not name it" from
       * "we do not know what this is", which are different sentences to an
       * admin and only one of them is a bug.
       *
       * `non-surveyable-class` is the third, and it is neither: the class
       * declared it has no enumerable units at all, so a caller asking whether
       * to name one is asking about a unit that should not exist. For `human`
       * that unit would be a PERSON, which ADR-0041 refuses by name.
       */
      readonly reason: "no-clause" | "non-surveyable-class" | "unresolvable-class";
    };

/** What the caller knows about ONE survey unit, as opposed to about its class. */
export interface SurveyUnitDisclosureFacts {
  /**
   * Did a human deliberately act on this unit — install-form entry, membership,
   * exclusion, enrollment? ADR-0041's first label clause, unchanged from
   * `classifyToken`'s `configured` arm: the admin typed the id, so showing it
   * back discloses nothing they did not supply.
   */
  readonly deliberateAct: boolean;

  /**
   * Does the VENDOR report this unit's existence as unconditionally visible to
   * every member of the vendor workspace?
   *
   * Named apart from {@link ClassCoverageContract.vendorPublic} on purpose.
   * `sources.ts`'s header spends a section on two axes spelled identically and
   * the constants that make them interchangeable; two booleans both called
   * `vendorPublic` would be that hazard rebuilt at a disclosure gate, where
   * swapping them silently turns a class-level refusal into a per-unit one.
   * This one is the vendor's answer about this unit; that one is whether the
   * class will lean on the vendor's answer at all.
   */
  readonly vendorReportsPublic: boolean;
}

/**
 * May the Coverage Surface NAME this survey unit, or only count it?
 *
 * ADR-0041's label rule, whole: **counts are always disclosable; a label appears
 * only under the deliberate-act clause or the vendor-public clause.** Everything
 * else is counted and never named.
 *
 * Deliberate-act is checked FIRST, and the order is visible in the result rather
 * than hidden: when both clauses would admit a unit the decision reports
 * `deliberate-act`, because that clause is the older one, is the one that does
 * not depend on any vendor's notion of "public", and is the one whose
 * justification survives the vendor changing that notion.
 *
 * ## The fail-closed arm, and why it suppresses BOTH clauses
 *
 * A class this deploy cannot resolve yields `count-only` /
 * `unresolvable-class` — no label, under either clause, whatever the caller
 * passed.
 *
 * The deliberate-act clause is not itself class-dependent, so suppressing it
 * needs its own argument, and it is this: every act the clause enumerates is
 * CLASS-SPECIFIC MACHINERY — an install form for chat, an exclusion list, an
 * enrollment for the warehouse. A class with no contract here has none of that
 * machinery built, so a caller asserting `deliberateAct: true` for one is
 * asserting a fact about a form that does not exist. The flag would be arriving
 * from somewhere that cannot have computed it correctly, and a disclosure gate
 * is the wrong place to extend the benefit of the doubt.
 *
 * ## A NON-SURVEYABLE class gets no label either, and that arm is about `human`
 *
 * A class declaring `surveyable: false` has no enumerable units, so a caller
 * asking whether to name one is asking about a unit that should not exist. The
 * answer is to withhold — and for `human` this is the sharpest disclosure in the
 * module, because that class's "units" are PEOPLE, and ADR-0041 refuses them by
 * name: "Everything else is counted, never named: mailboxes …, recording owners,
 * individual persons."
 *
 * Checked BEFORE either clause, so it also suppresses deliberate-act. The
 * posture was otherwise inverted: a class this deploy cannot resolve got a loud
 * withhold, while a class that had positively declared it has no units got a
 * silent name off a single caller-supplied boolean.
 *
 * ## Counts are untouched by any of this
 *
 * {@link classDenominator} decides separately whether the class has a universe
 * to count, and ADR-0041's whole point is that a count carries no claim content
 * and no audience content.
 *
 * ⚠️ One obligation this hands the caller, since nothing here can enforce it: a
 * unit whose decision is `unresolvable-class` or `non-surveyable-class` must not
 * be totalled into a ratio. Both reasons travel with a denominator that refuses
 * to exist, so accumulating a numerator against them yields "N of 0" — a number
 * with no universe behind it, which is the fabrication ADR-0041 refuses. It is
 * also what keeps the warn above from firing per unit: a class with no
 * denominator should never have had its units enumerated in the first place.
 */
export function coverageLabelPolicy(
  cls: unknown,
  unit: SurveyUnitDisclosureFacts,
  meta?: ClassContractLogMeta,
): CoverageLabelDecision {
  // Order is load-bearing: the non-surveyable check must precede both clauses,
  // or a caller-supplied `deliberateAct` names a person. See § "A NON-SURVEYABLE
  // class gets no label either"; the input-class table is in `db8c5fc85`.
  const contract = contractOf(cls);
  if (!contract) {
    warnUnresolvable(cls, "coverageLabelPolicy", meta);
    return { policy: "count-only", reason: "unresolvable-class" };
  }
  if (!contract.coverage.denominator.surveyable) {
    if (unit.deliberateAct || unit.vendorReportsPublic) {
      // A caller ASSERTED a disclosure fact about a unit of a class that
      // declares it has none — for `human` that unit would be a PERSON.
      // Refused either way; logged because the assertion cannot have been
      // computed correctly, and because this arm is otherwise the module's
      // sharpest attempted disclosure with no trace at all. Predicated on the
      // assertion rather than on the arm, so the volume is bounded by a caller
      // bug instead of by unit count.
      log.warn(
        {
          workspaceId: meta?.workspaceId,
          requestId: meta?.requestId,
          derivation: "coverageLabelPolicy",
          classValue: describeClassValue(cls),
        },
        "brain class contract: a disclosure fact was asserted for a non-surveyable class — refusing; no unit of this class is ever named",
      );
    }
    return { policy: "count-only", reason: "non-surveyable-class" };
  }
  if (unit.deliberateAct) return { policy: "name", clause: "deliberate-act" };
  if (contract.coverage.vendorPublic && unit.vendorReportsPublic) {
    return { policy: "name", clause: "vendor-public" };
  }
  return { policy: "count-only", reason: "no-clause" };
}

/**
 * Which staleness sentence a class's units are entitled to.
 *
 * `measured-lag` licenses "stale" — the class can read vendor activity metadata,
 * so the surface may compare source movement against our newest observed
 * evidence and report a lag it actually measured. `unverified-since` is the
 * other sentence and the only other one: "unverified since \<date of last
 * successful cycle\>", which claims nothing about whether the source moved.
 *
 * ⚠️ This answers the CAPABILITY question only. A class that can measure the lag
 * still shows "unverified since" whenever the pipe is sick, because a broken
 * cycle means we did not look — ADR-0041 puts both cases on the same sentence.
 * That arm is runtime state and belongs to the coverage module; nothing in this
 * file can see it, so `measured-lag` here means "stale is computable for this
 * class", never "this unit is stale".
 *
 * ⚠️ **The THRESHOLD this licenses TRAVELS ON the verdict, as of #5214.** The
 * `measured-lag` arm carries `syncCadenceMs`, so the capability and the number
 * it is measured against arrive in one value and a consumer has nothing left to
 * invent. That is the fourth contract property #5212 said "belongs HERE when the
 * coverage module needs it — not a constant in that module", claimed by the
 * module that needed it; see {@link VendorActivityMetadata} for why it is nested
 * inside the `reports` arm rather than added beside it.
 *
 * ADR-0041 defines the lag as exceeding "the class's sync cadence — a divergence
 * whose only constant is the cadence the class contract already owns", and then
 * forbids a knob for it: "No staleness knob — not env, not the settings
 * registry." So the number here is a CONSTANT and is deliberately not read from
 * `ATLAS_KNOWLEDGE_SYNC_INTERVAL_HOURS`, which is a tunable an admin could use
 * to define staleness away.
 *
 * Unresolvable class → `unverified-since` / `unresolvable-class`. Fail-closed in
 * the honest direction: the alternative would let a class nobody has written a
 * contract for produce the word "stale" about a source no code in this deploy
 * knows how to look at. The reason discriminates that from `warehouse`'s and
 * `human`'s DECLARED `no-activity-metadata`, which is the same sentence for a
 * completely different reason and is not a bug.
 */
export function stalenessVerdict(cls: unknown, meta?: ClassContractLogMeta): StalenessVerdict {
  const contract = contractOf(cls);
  if (!contract) {
    warnUnresolvable(cls, "stalenessVerdict", meta);
    return { kind: "unverified-since", reason: "unresolvable-class" };
  }
  const activity = contract.coverage.activityMetadata;
  return activity.kind === "reports"
    ? { kind: "measured-lag", syncCadenceMs: activity.syncCadenceMs }
    : { kind: "unverified-since", reason: "no-activity-metadata" };
}

/**
 * The class's enumerable universe, or its refusal to have one.
 *
 * Unresolvable class → `{ surveyable: false, reason: "unresolvable-class" }`.
 * This is the arm ADR-0041's fabrication discipline decides: a denominator for a
 * class whose enumeration nothing in this deploy knows how to perform would be a
 * number with no universe behind it, and "a silent zero here is a false
 * statement, not an error state". Refusing to be surveyable makes the class fall
 * out of every ratio, which is the same shape the map edge takes: a mark, never
 * a number.
 *
 * ⚠️ The reason is what stops that being the same answer `human` gets. Both
 * refuse a universe; only one of them is a decision. ADR-0041 wants the page to
 * render "cannot establish" for the second — a page cannot read a `log.warn`,
 * so the distinction has to travel in the return value.
 */
export function classDenominator(cls: unknown, meta?: ClassContractLogMeta): ClassDenominator {
  const contract = contractOf(cls);
  if (!contract) {
    warnUnresolvable(cls, "classDenominator", meta);
    return { surveyable: false, reason: "unresolvable-class" };
  }
  return contract.coverage.denominator;
}


/**
 * Ties every {@link FAIL_CLOSED_CONSEQUENCE} key to the EXPORT that logs under
 * it — SHORTHAND properties, so renaming a derivation without renaming its key
 * fails to compile here ("No value exists in scope for the shorthand property").
 * The diagnostic NUMBER is deliberately not quoted; that is the detail a `tsc`
 * upgrade renumbers, and this module has already shipped one wrong one.
 *
 * The mechanism the type alias above cannot be. `ClassContractDerivation` is
 * `keyof typeof FAIL_CLOSED_CONSEQUENCE`, which ties the call sites to the MAP
 * and says nothing about the functions: rename `coverageLabelPolicy` and the
 * key, the call-site literal and the logged `derivation` all keep the dead name
 * with `tsc` clean and the logging test green, because that test asserts the
 * string `"coverageLabelPolicy"` rather than the binding. An operator then greps
 * a `derivation` field naming a function that no longer exists.
 *
 * Written as a mechanism rather than as a warning because a comment asserting
 * this tie was the third measured-false guarantee in this module, and the repo's
 * rule is that a principle violated twice gets a check rather than a third
 * comment.
 *
 * Placed BELOW the declarations it references, so it binds however they are
 * spelled. (Do not "simplify" by moving it up on the belief that hoisting
 * protects it: the moment any derivation becomes an arrow const, a reference
 * above it is a use-before-declaration error. Compile-caught rather than silent,
 * but there is no reason to invite it.)
 *
 * The shorthand is load-bearing and it is a CONVENTION, not a guarantee: writing
 * `coverageLabelPolicy: "anything"` binds nothing and silently retires the tie.
 * The function-shaped value type below is what makes that at least type-visible.
 */
const _DERIVATION_NAMES_IN_SYNC: Record<
  ClassContractDerivation,
  (...args: never[]) => unknown
> = {
  coverageLabelPolicy,
  stalenessVerdict,
  classDenominator,
};
void _DERIVATION_NAMES_IN_SYNC;
