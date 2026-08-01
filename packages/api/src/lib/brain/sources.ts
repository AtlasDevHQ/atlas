/**
 * The closed vocabulary of `brain_episodes.source` — the SOURCE KIND a producer
 * stamps on the evidence it appends.
 *
 * ## What a member is (the mixed grain, made structural)
 *
 * ADR-0036 §T6 sequences connectors class-major, vendor-minor (chat →
 * transcripts → email → docs), but the stored column is NOT purely either.
 * `warehouse` and `human` are CLASSES — neither has a vendor and neither comes
 * from a connector at all. `slack` is a VENDOR within the chat class, and the
 * `<channelId>:<ts>` source-id contract in `ingest/slack/config.ts` is why: the
 * id format is vendor-specific, so collapsing every chat vendor onto one stored
 * value would make two vendors' ids share a dedupe namespace.
 *
 * That mixed grain is a fact about STORAGE and it has not changed. What changed
 * (#4963) is that the grain is now DECLARED rather than described: every member
 * of the vocabulary is an entry in {@link EPISODE_SOURCE_SPECS} naming its
 * CLASS and its VENDOR (`null` for the classes that have none), and the source
 * list and the `EpisodeSource` union are both DERIVED from that one map — whose
 * KEYS are the stored values. So the two axes are separable in code — you can
 * ask what class a stored value belongs to — without collapsing them in the
 * column.
 *
 * A second chat vendor (Teams, Discord) is still a NEW MEMBER here, not a reuse
 * of `slack`; it just now has to name `class: "chat"` as it arrives. That is
 * still a deliberate one-line PR, and `__tests__/sources.test.ts` makes it fail
 * a test first — on BOTH axes, since widening the class set is the other way to
 * change what this file means.
 *
 * ## Why this is a shared constant rather than three string literals
 *
 * `correction.ts`'s tier-1 refusal (`isWarehouseDerived`) is a predicate over
 * this column: a warehouse-derived fact has no correction path, because the fix
 * belongs in the data or the semantic layer rather than in an override the
 * next sync would overwrite. That refusal is an ADR-level invariant, and its
 * ONLY trigger is the stored `provenance.source` — copied verbatim out of the
 * episode by `reconcile.ts` — resolving to the WAREHOUSE CLASS via
 * {@link isWarehouseDerivedSource}.
 *
 * So the refusal is exactly as strong as the agreement between the producer
 * that names the kind and the predicate that reads it. While both sides spelled
 * their own literal, that agreement was a coincidence. ADR-0036 commits to
 * warehouse-derived facts as tier-1 but no milestone in the M1–M6 cut has
 * scoped the producer yet, so the value is one future naming decision away from
 * silence: a producer stamping `"snowflake"`, `"bigquery"` or `"warehouse:prod"`
 * would have stopped tier-1 refusal firing without failing ANYTHING, because
 * every test on the refusal hand-seeded the same literal it asserted against
 * (#4938). Naming the kind here, once, is what makes the two sides one fact.
 *
 * ## Adding a member
 *
 * Two gates, at different producers. `BrainSourceConnector.source` is typed
 * `EpisodeSource`, which stops an in-repo connector inventing a kind at compile
 * time; `registerBrainSourceConnector` re-checks at runtime, because a registry
 * is a data boundary — ADR-0036 M3 makes connectors plugin-shaped, and a plugin
 * compiled separately reaches it as data rather than as a checked type. (No
 * plugin registers a brain source today; the check is there for when one does.)
 *
 * The rule that actually matters: **if the kind you are adding is
 * warehouse-shaped, it must declare `class: WAREHOUSE_CLASS`.**
 *
 * That rule used to read "it must BE `WAREHOUSE_SOURCE`" — the stored value
 * itself — because the predicate compared the stored value directly and there
 * was nowhere else to say it. Now the predicate reads the CLASS: a member that
 * declares the warehouse class inherits the refusal whatever its stored value
 * is, and a member that declares some other class does not.
 *
 * Be precise about what that bought, because it is less than it looks. This is
 * STILL a prose rule — `{ class: "chat", vendor: "snowflake" }` compiles clean
 * and escapes tier-1 refusal exactly as #4938's `"snowflake"` did. What changed
 * is that the decision is now single-sited and readable: the producer and the
 * predicate can no longer disagree about which value means warehouse, because
 * there is one place that says so. Choosing the right class remains a judgement
 * the compiler cannot make, and the pinned key-set in `__tests__/sources.test.ts`
 * is what forces an author to confront it.
 *
 * Prefer `WAREHOUSE_SOURCE` itself regardless — a warehouse connector's vendor
 * identity belongs in the catalog id and in `provenance.producer`, and one
 * stored value per class is one dedupe namespace fewer to reason about. A
 * separate stored value is only warranted if that vendor's source-ids would
 * otherwise collide, which is the same test `slack` passes and the reason the
 * chat class is vendor-grained at all.
 *
 * ## ⚠️ The two axes OVERLAP, and the compiler will not catch it
 *
 * `EpisodeSource` is `slack | warehouse | human`; `EpisodeSourceClass` is
 * `chat | warehouse | human`. Two of three members are spelled IDENTICALLY, so
 * the unions are mutually assignable exactly where confusing them costs most —
 * all of these compile clean:
 *
 *     const a: EpisodeSource = WAREHOUSE_CLASS;        // a class where a kind is wanted
 *     const b: EpisodeSourceClass = WAREHOUSE_SOURCE;  // and the reverse
 *     storedSource === WAREHOUSE_CLASS                 // the #4938 bug, respelled
 *
 * Only `CHAT_CLASS` errors against a stored kind, and that is a coincidence
 * that expires the day a `chat` stored value exists. So do NOT read the split
 * as compiler-enforced separation: it is a separation of MEANING, kept honest
 * by routing every cross-axis question through one predicate.
 *
 * The rule: never `===` a stored source against a CLASS constant. Ask
 * {@link isWarehouseDerivedSource}, or {@link episodeSourceClass} first.
 *
 * ## Why the wire schema does not mirror this enum
 *
 * `packages/schemas/src/brain.ts` deliberately keeps `source: z.string()`
 * rather than a Zod enum over this vocabulary. That is not drift: a Zod enum
 * would fail CLOSED on a bundle written by a newer region, which is precisely
 * the case the region import below exists to let through.
 *
 * The one producer NOT gated is the region import (`admin-migrate.ts`'s `INSERT
 * INTO brain_episodes`), which restores a bundle's stored `source` verbatim so
 * a bundle written by a newer vocabulary still imports. That is the same
 * restore-is-not-a-new-arbitration line `RETRACT_FACT_SQL`'s sole-writer scan
 * draws for `invalidated_at` (`__tests__/correction.test.ts`). It is a real
 * fail-open lane, so the import LOGS an out-of-vocabulary value rather than
 * accepting it silently.
 */

/**
 * The closed set of source CLASSES — ADR-0036 §T6's class-major axis.
 *
 * Not "connector classes": `warehouse` and `human` come from no connector at
 * all, and only `chat` names a connector class today.
 *
 * Only classes with a member in {@link EPISODE_SOURCE_SPECS} are listed. The
 * ADR's remaining classes (transcripts, email, docs/wiki/code/drive) are
 * deliberately absent: a class with no source that can produce it is dead
 * vocabulary, and a downstream `switch` over it would have an arm nothing ever
 * reaches. Each arrives with its first connector, in the same one-line PR that
 * adds the connector's stored value.
 *
 * `chat` first (the shipped class), then the two that come from no connector at
 * all — `warehouse` is the tier-1 class {@link isWarehouseDerivedSource} keys
 * off, `human` is a person's own recorded words.
 */
export const EPISODE_SOURCE_CLASSES = ["chat", "warehouse", "human"] as const;

export type EpisodeSourceClass = (typeof EPISODE_SOURCE_CLASSES)[number];

/**
 * What one member of the vocabulary declares about itself.
 *
 * A DISCRIMINATED UNION on `class`, not a flat `{ class; vendor: string | null }`,
 * because vendor-ness is a property OF the class and not a free choice per
 * member. A flat shape admitted both of these:
 *
 *     teams:     { class: "chat",      vendor: null }        // vendor-grained, unnamed
 *     snowflake: { class: "warehouse", vendor: "snowflake" } // connectorless, yet vendored
 *
 * …and the first is the damaging one: `chat` is vendor-grained precisely
 * because two chat vendors' source-ids would otherwise share a dedupe
 * namespace, so a chat member that named no vendor would reintroduce the
 * collision the grain exists to prevent, silently. Splitting the union makes
 * both unrepresentable.
 *
 * Adding a class edits this union as well as {@link EPISODE_SOURCE_CLASSES} —
 * which is the right cost: a class arrives with its first connector as a
 * deliberate PR (ADR-0036 §T6), and deciding whether it is vendor-grained is
 * exactly the decision that PR exists to make.
 */
export type EpisodeSourceSpec =
  | {
      /** Vendor-grained: two vendors' source-ids would collide in one namespace. */
      readonly class: "chat";
      readonly vendor: string;
    }
  | {
      /** Class-grained: comes from no connector, so there is no vendor to name. */
      readonly class: "warehouse" | "human";
      readonly vendor: null;
    };

/**
 * Every source kind that may reach `brain_episodes.source`, and what each one
 * IS — THE definition this whole module derives from.
 *
 * The key is the value stored in the column, verbatim. `db/schema.ts` names the
 * same three beside the column and points here; migration 0180 leaves the
 * column plain `text` with no CHECK, which is what lets the region import
 * restore a value this map does not yet know.
 *
 * `satisfies`, not a `: Record<EpisodeSource, EpisodeSourceSpec>` annotation:
 * the annotation would be circular (the union is derived from these keys) and
 * would widen every `class`/`vendor` back to its declared type, costing callers
 * their literal narrowing. `satisfies` keeps the literals AND still fails
 * compilation on a class outside {@link EPISODE_SOURCE_CLASSES}, or on a
 * class/vendor pairing {@link EpisodeSourceSpec}'s union forbids.
 *
 * ⚠️ What that gate does NOT do — and the header's warehouse rule depends on
 * knowing the difference. The compiler checks that the class you name EXISTS
 * and that its vendor-ness matches. It cannot check that it is the RIGHT class,
 * because nothing in the type system knows what "warehouse-shaped" means:
 *
 *     snowflake: { class: "chat", vendor: "snowflake" }   // compiles clean
 *
 * …and that member escapes tier-1 refusal exactly as #4938's `"snowflake"` did.
 * So #4963 did not make the warehouse rule structural; it made the DECISION
 * single-sited and readable, so the predicate can no longer disagree with the
 * producer about which value means warehouse. Choosing correctly is still a
 * judgement, and the pinned key-set in `__tests__/sources.test.ts` is what
 * forces an author to confront it rather than drift past it.
 *
 * Frozen, not merely `as const`: `as const` is a TYPE-level assertion and
 * leaves the object mutable at runtime. This map is the sole input to tier-1
 * correction refusal, and the code it replaced compared against a string
 * primitive — unforgeable by construction. A single property write here would
 * silently disable that refusal for every warehouse-derived fact with no log,
 * no throw, and no red test (every test reads the same mutated map, so they
 * stay green AND agreed while both are wrong — the exact self-referential
 * failure this vocabulary exists to defeat). Freezing restores the property the
 * primitive comparison had for free.
 */
export const EPISODE_SOURCE_SPECS = Object.freeze({
  slack: Object.freeze({ class: "chat", vendor: "slack" } as const),
  warehouse: Object.freeze({ class: "warehouse", vendor: null } as const),
  human: Object.freeze({ class: "human", vendor: null } as const),
}) satisfies Record<string, EpisodeSourceSpec>;

export type EpisodeSource = keyof typeof EPISODE_SOURCE_SPECS;

/**
 * Every stored source kind, in declaration order.
 *
 * Derived from the spec map rather than spelled a second time, so a member
 * cannot exist without declaring its class — the property that lets
 * {@link isWarehouseDerivedSource} read the class and trust the answer.
 */
export const EPISODE_SOURCES = Object.freeze(
  // The cast is load-bearing and sound ONLY because the map's keys ARE the
  // union: `Object.keys` is typed `string[]` for an arbitrary object, and
  // `EpisodeSource` is defined as `keyof typeof EPISODE_SOURCE_SPECS` directly
  // below. Insertion order is guaranteed because none of the keys is
  // integer-like; `__tests__/sources.test.ts` pins the resulting list anyway.
  Object.keys(EPISODE_SOURCE_SPECS) as EpisodeSource[],
) as readonly EpisodeSource[];

/**
 * The vendors named by vendor-grained members — `"slack"` today.
 *
 * Derived rather than declared so a query cannot ask for a vendor that no
 * member has: `findBrainSourceConnectors({ vendor: "slakc" })` returning an
 * empty array is indistinguishable from "that connector is not installed",
 * which for the M3 webhook fast-path is a dropped event rather than a crash.
 */
export type EpisodeSourceVendor = NonNullable<
  (typeof EPISODE_SOURCE_SPECS)[EpisodeSource]["vendor"]
>;

/**
 * The chat class's first vendor — what `SLACK_HISTORY_SOURCE` resolves to.
 *
 * `satisfies`, not a `: EpisodeSource` annotation, on every named constant
 * below (the classes included): the annotation would widen the constant to the
 * whole union and cost every consumer its `===` narrowing, while `satisfies`
 * keeps the literal type AND still fails compilation if the value leaves its
 * vocabulary.
 */
export const SLACK_SOURCE = "slack" satisfies EpisodeSource;

/**
 * The tier-1 kind: facts derived from the warehouse itself.
 *
 * The only member of {@link WAREHOUSE_CLASS} today, and so the only value
 * {@link isWarehouseDerivedSource} recognises. A producer of warehouse-derived
 * episodes should stamp this — see the header for when a separate stored value
 * is warranted, and what it must declare if it is.
 */
export const WAREHOUSE_SOURCE = "warehouse" satisfies EpisodeSource;

/**
 * A human's own words, recorded as evidence — today only `correct_fact`'s
 * correction episode. Never re-extracted: the episode is pre-stamped off the
 * extraction queue so a human's statement is not re-derived into a second,
 * machine-produced claim (#4915).
 */
export const HUMAN_SOURCE = "human" satisfies EpisodeSource;

/**
 * The tier-1 class. Named separately from {@link WAREHOUSE_SOURCE} because the
 * two are now different facts: the source is what a producer STAMPS, the class
 * is what the refusal READS, and the whole point of #4963's split is that a
 * future member could carry a different stored value under this same class.
 */
export const WAREHOUSE_CLASS = "warehouse" satisfies EpisodeSourceClass;

/** The shipped connector class — chat, ADR-0036's first and easiest ACL tier. */
export const CHAT_CLASS = "chat" satisfies EpisodeSourceClass;

/** Narrow an arbitrary value — a config string, a stored row — to the vocabulary. */
export function isEpisodeSource(value: unknown): value is EpisodeSource {
  return typeof value === "string" && Object.hasOwn(EPISODE_SOURCE_SPECS, value);
}

/** Narrow an arbitrary value to the closed class set. */
export function isEpisodeSourceClass(value: unknown): value is EpisodeSourceClass {
  return (
    typeof value === "string" && (EPISODE_SOURCE_CLASSES as readonly string[]).includes(value)
  );
}

/**
 * The spec for a source kind, or a loud error naming the offending value.
 *
 * The parameter is typed `EpisodeSource`, so why check at all? Because this
 * module's whole premise is that the value arrives from somewhere no type
 * system has seen — a stored `provenance.source`, a bundle being imported, a
 * separately-compiled plugin — and `row.source as EpisodeSource` is the obvious
 * next thing someone writes. A bare `EPISODE_SOURCE_SPECS[source]` fails in two
 * unhelpful ways there: an unknown slug throws `undefined is not an object`,
 * which names an internal expression rather than the bad value; and an
 * inherited key (`"toString"`, `"valueOf"`) resolves up the PROTOTYPE CHAIN to
 * a function, whose `.class` is `undefined` — so a class-keyed predicate
 * silently answers "not warehouse" and tier-1 refusal fails OPEN with nothing
 * logged. `Object.hasOwn` refuses both, and throwing names the value.
 *
 * Callers that expect untrusted input must still narrow with
 * {@link isEpisodeSource} first — this is the backstop, not the gate.
 */
function specOf(source: EpisodeSource): (typeof EPISODE_SOURCE_SPECS)[EpisodeSource] {
  if (!Object.hasOwn(EPISODE_SOURCE_SPECS, source)) {
    throw new Error(
      `Episode source "${String(source)}" is not in the vocabulary (${EPISODE_SOURCES.join(", ")}) — narrow it with isEpisodeSource() before asking for its class or vendor`,
    );
  }
  return EPISODE_SOURCE_SPECS[source];
}

/** The ADR-0036 class a stored source kind belongs to. */
export function episodeSourceClass(source: EpisodeSource): EpisodeSourceClass {
  return specOf(source).class;
}

/**
 * The vendor within that class, or `null` for a class that has none
 * (`warehouse`, `human` — neither comes from a connector).
 */
export function episodeSourceVendor(source: EpisodeSource): EpisodeSourceVendor | null {
  return specOf(source).vendor;
}

/**
 * Does an arbitrary stored value name a WAREHOUSE-CLASS source? The single
 * trigger behind `correction.ts`'s tier-1 correction refusal.
 *
 * Takes `unknown` rather than `EpisodeSource` because every caller reads it off
 * a stored JSON payload (`provenance.source`) that no type system has checked —
 * including the region-import fail-open lane, which restores a bundle's value
 * verbatim. An unrecognised value is NOT warehouse-derived, which is the
 * correctable (safe) direction: it costs a refusal that should have fired
 * rather than blocking a correction that should have been allowed.
 */
export function isWarehouseDerivedSource(value: unknown): boolean {
  return isEpisodeSource(value) && episodeSourceClass(value) === WAREHOUSE_CLASS;
}
