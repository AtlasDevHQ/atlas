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
 * `EpisodeSource` is `slack | zoom | outlook | warehouse | human`;
 * `EpisodeSourceClass` is `chat | transcript | email | warehouse | human`. Two
 * members are spelled IDENTICALLY on both axes.
 *
 * The UNIONS are not mutually assignable — `slack` and `chat` see to that, and
 * each direction is a TS2322. What IS interchangeable is the literal-typed
 * CONSTANTS, and that is worse, because a constant is what you actually reach
 * for. All of these compile clean:
 *
 *     const a: EpisodeSource = WAREHOUSE_CLASS;        // a class where a kind is wanted
 *     const b: EpisodeSourceClass = WAREHOUSE_SOURCE;  // and the reverse
 *     storedSource === WAREHOUSE_CLASS                 // the #4938 bug, respelled
 *     findBrainSourceConnectors({ vendor: SLACK_SOURCE })  // a kind where a VENDOR is wanted
 *
 * The last one is the axis this refactor added: {@link EpisodeSourceVendor} is
 * `"slack" | "zoom" | "outlook"`, and ALL THREE are also stored kinds.
 * `CHAT_CLASS`, `TRANSCRIPT_CLASS` and `EMAIL_CLASS` are the only constants that
 * error against a stored kind, and that is a coincidence which expires the day a
 * `chat`, `transcript` or `email` stored value exists.
 *
 * `EMAIL_CLASS` is the one most likely to expire, and the trap is worth naming
 * because it reads as the obvious next step rather than as a mistake: a second
 * email vendor arrives and `{ class: "email", vendor: "gmail" }` is correct,
 * while collapsing both onto a stored `"email"` — tempting, since Message-ID
 * really is cross-vendor — is not. See {@link EpisodeSourceSpec}'s
 * vendor-grained arm for why the shared identifier does not license a shared
 * stored value.
 *
 * So do NOT read the split as compiler-enforced separation: it is a separation
 * of MEANING, kept honest by routing every cross-axis question through one
 * predicate.
 *
 * The rule: never `===` a stored source against a CLASS constant. Ask
 * {@link isWarehouseDerivedSource}, or {@link episodeSourceClassOf} first.
 *
 * The one producer NOT gated is the region import (`admin-migrate.ts`'s `INSERT
 * INTO brain_episodes`), which restores a bundle's stored `source` verbatim so
 * a bundle written by a newer vocabulary still imports. That is the same
 * restore-is-not-a-new-arbitration line `RETRACT_FACT_SQL`'s sole-writer scan
 * draws for `invalidated_at` (`__tests__/correction.test.ts`). It is a real
 * fail-open lane, so the import LOGS an out-of-vocabulary value rather than
 * accepting it silently.
 *
 * ## Where that lane is closed, and why not here (#4964)
 *
 * Logging alone was not enough. An imported `"warehouse:prod"` is outside the
 * vocabulary, so it is not warehouse-CLASS, so {@link isWarehouseDerivedSource}
 * answers `false` and tier-1 correction refusal never fires — an ADR-0036 §T4
 * invariant downgraded at a moment no log covers. {@link isWarehouseDerivedSource}'s
 * own docstring, at the BOTTOM of this file, used to call that "the correctable
 * (safe) direction"; that reading holds for a value that had to pass a producer
 * gate to exist, and is precisely wrong for the one lane where no gate ran. It
 * has been corrected at the site — both ends of this reconciliation move
 * together, because a maintainer standing at either one must not read the
 * fail-open as still shipping.
 *
 * The import still does NOT refuse it. Migration 0180 leaves the column plain
 * `text` with no CHECK, so Postgres legally stores any string, and the rule
 * `acl.ts`'s header states for GRANTS holds here for the same reason: Atlas code
 * must not be stricter at import than the database is at rest. (That header
 * argues it against 0180's grant CHECK specifically; this column carries no
 * CHECK at all, so the bar is lower still, not higher.) Bundle validation is
 * all-or-nothing, so refusing one episode strands the whole workspace in its
 * current region, discovered at cutover. Restoring
 * evidence is not arbitration; CORRECTING it is. So the refusal sits at the
 * correction gate instead: `correction.ts`'s `unrecognizedSourceKind` quarantines
 * the correction PATH of a fact whose kind this region cannot classify, under
 * its own refusal reason rather than by pretending the fact is warehouse-derived.
 * Self-healing — deploying the vocabulary that knows the kind restores the
 * correct gate with no data migration.
 *
 * ⚠️ **Since #5033 there are TWO such gates, not one.** The publish gate's tier
 * guard also refuses to stamp `valid_to` on — or with — a fact whose kind this
 * region cannot classify ({@link NON_WAREHOUSE_SOURCES}). Same argument, heavier
 * consequence: a lost correction refusal is recoverable by a deploy, a
 * `valid_to` stamp is recoverable by nothing.
 *
 * The consequence for THIS file, since it is what makes the healing work:
 * adding a member here is still a one-line PR, and that line is what releases
 * every imported fact of that kind from BOTH quarantines — with one carve-out
 * that is easy to miss. If the member you add is WAREHOUSE-CLASS, neither gate
 * reopens: the fact moves from *refused because unclassifiable* to *refused
 * because tier-1*, `correction.ts` swaps `unrecognizedSourceKind` for
 * `warehouseTarget`, and the tier guard keeps holding it back. That is the
 * correct outcome and it is not a healing.
 */

/**
 * The closed set of source CLASSES — ADR-0036 §T6's class-major axis.
 *
 * Not "connector classes": `warehouse` and `human` come from no connector at
 * all; `chat`, `transcript` and `email` name connector classes today.
 *
 * Only classes with a member in {@link EPISODE_SOURCE_SPECS} are listed. The
 * ADR's remaining classes (docs/wiki/code/drive) are deliberately
 * absent: a class with no source that can produce it is dead vocabulary, and a
 * downstream `switch` over it would have an arm nothing ever reaches. Each
 * arrives with its first connector, in the same one-line PR that adds the
 * connector's stored value.
 *
 * SINGULAR, all five. The ADR's prose sequences them as "chat → transcripts →
 * email → docs" and that plural is a list of SUBJECT AREAS; these are the
 * values a stored row's class resolves TO, read one row at a time
 * (`episodeSourceClassOf(row.source) === TRANSCRIPT_CLASS`). Mixing the two
 * conventions in one closed set is how you end up asking whether it is spelled
 * `docs` or `doc` at each of four call sites.
 *
 * The connector classes first, in ADR-0036 §T6's order — `chat` (#4770),
 * `transcript` (#4965), then `email` (#4966) — and then the two that come from
 * no connector at all: `warehouse` is the tier-1 class
 * {@link isWarehouseDerivedSource} keys off, `human` is a person's own recorded
 * words.
 *
 * `email` is where the ordering stops being merely a sequence and starts being
 * the ACL-difficulty gradient §T6 says it is. Chat and transcript audiences are
 * ENUMERABLE — a channel has a roster, a meeting has a participant list, and in
 * both cases the vendor will tell you the whole of it. An email's will not:
 * BCC is invisible to recipients and forwarding mutates the audience after the
 * fact with no signal on the original. So the email class is the first one whose
 * derived grant is a LOWER BOUND on who has seen the content rather than an
 * exact set. `ingest/grant.ts`'s {@link deriveEmailRecipientGrant} is where that
 * posture is decided and argued; it is a property of the CLASS, not of Outlook.
 */
export const EPISODE_SOURCE_CLASSES = Object.freeze([
  "chat",
  "transcript",
  "email",
  "warehouse",
  "human",
] as const);

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
      /**
       * Vendor-grained: two vendors' source-ids would collide in one namespace.
       *
       * `transcript` joined this arm with #4965 rather than getting one of its
       * own, because it passes the SAME test `chat` passes and for the same
       * reason. Zoom's source-id grammar lives in `ingest/zoom/config.ts` and
       * is owned THERE, not restated here — it is stamped into an append-only
       * table, and a contract with two published spellings is exactly the
       * hazard this section is about. (This comment carried a second, WRONG
       * spelling until the review panel caught it, and named #4967's webhook
       * writer as the counterparty until a later pass caught that too — #4967
       * shipped Slack-only and never writes a Zoom episode.) Google Meet's would
       * be a Drive file id and Fireflies' a transcript id. Those are three
       * unrelated id GRAMMARS, so
       * one stored `transcript` value would put them in one dedupe namespace —
       * and a collision there does not error, it silently drops one vendor's
       * meeting as a duplicate of another's.
       *
       * The general rule, since this arm is now the one most members land in:
       * a class belongs here when its vendors mint source-ids independently.
       * That is nearly every connector class, which is why the ADR's remaining
       * classes (docs/wiki/code/drive) should be expected to widen this arm too
       * rather than the one below. `email` was on that list until #4966
       * actually widened it — see the next paragraph, which has said so since.
       *
       * `email` joined it with #4966, and its case is the strongest of the three
       * rather than the weakest — despite email having something chat and
       * transcripts do not: a genuinely CROSS-VENDOR identifier, the RFC 5322
       * `Message-ID`. Outlook's source-id contract (`ingest/outlook/config.ts`)
       * is built on exactly that header, so an Outlook and a Gmail connector
       * WOULD mint identical ids for the same message, and one shared stored
       * value would look like it dedupes them for free.
       *
       * It would not. The stored value is also what every downstream
       * discriminator reads, what the audience re-verifier scans on
       * (`brain_episodes.source = $2`), and what routes a correction; two
       * vendors sharing it means one vendor's re-verifier walking the other's
       * audiences with the wrong credential. The id COLLISION being benign is
       * not the same claim as the SOURCE being shared, and conflating them is
       * how a dedupe convenience becomes a cross-vendor ACL fault.
       */
      readonly class: "chat" | "transcript" | "email";
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
 * same set beside the column and points here; migration 0180 leaves the
 * column plain `text` with no CHECK, which is what lets the region import
 * restore a value this map does not yet know.
 *
 * `satisfies`, not a `: Record<EpisodeSource, EpisodeSourceSpec>` annotation:
 * the annotation would be circular (the union is derived from these keys) and
 * would widen every `class`/`vendor` back to its declared type, costing callers
 * their literal narrowing.
 *
 * Precisely what the gate is, since it moved: the check is against
 * {@link EpisodeSourceSpec}'s union, which after #4963 spells its class
 * literals directly and no longer references {@link EPISODE_SOURCE_CLASSES}.
 * The two lists are held together instead by `_CLASS_AXIS_IN_SYNC` below (both
 * drift directions are a compile error there) plus the orphan sweep in
 * `__tests__/sources.test.ts`. So `satisfies` rejects an unknown class, a
 * class/vendor pairing the union forbids, a missing property, and — via the
 * per-entry checks in the literal — an excess one.
 *
 * ⚠️ What it does NOT do is check that the class is the RIGHT one; nothing in
 * the type system knows what "warehouse-shaped" means. The header's "Adding a
 * member" section carries that argument in full — read it before adding a
 * warehouse-shaped kind, because the residual rule there is still prose.
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
  // The per-entry `satisfies` is not redundant with the map-level one below.
  // `Object.freeze(...)` returns `Readonly<T>` — a CALL RESULT, not a fresh
  // object literal — and TypeScript only runs excess-property checking against
  // a fresh literal. Without these, `{ class: "chat", vendor: "slack", tier: 1 }`
  // compiles clean and an invented field lands in the vocabulary unnoticed.
  // Checking each literal at the point it is still a literal restores that.
  slack: Object.freeze({ class: "chat", vendor: "slack" } as const satisfies EpisodeSourceSpec),
  zoom: Object.freeze({ class: "transcript", vendor: "zoom" } as const satisfies EpisodeSourceSpec),
  outlook: Object.freeze({ class: "email", vendor: "outlook" } as const satisfies EpisodeSourceSpec),
  warehouse: Object.freeze({ class: "warehouse", vendor: null } as const satisfies EpisodeSourceSpec),
  human: Object.freeze({ class: "human", vendor: null } as const satisfies EpisodeSourceSpec),
}) satisfies Record<string, EpisodeSourceSpec>;

/**
 * Compile-time tie between the two spellings of the class axis:
 * {@link EPISODE_SOURCE_CLASSES} (the closed set) and the `class` discriminants
 * of {@link EpisodeSourceSpec}. Mutual assignability, so BOTH drift directions
 * are errors here rather than somewhere downstream.
 *
 * Worth three lines because the drift is otherwise reported far from its cause,
 * or not at all: a union arm added without the array surfaces as a return-type
 * error inside `episodeSourceClass`, and a class added to the ARRAY with no
 * member and no arm produces no compile error whatsoever — only the orphan
 * sweep in `__tests__/sources.test.ts` catches that one.
 */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _CLASS_AXIS_IN_SYNC: MutuallyAssignable<EpisodeSourceSpec["class"], EpisodeSourceClass> = true;
void _CLASS_AXIS_IN_SYNC;

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
  // `EpisodeSource` is `keyof typeof EPISODE_SOURCE_SPECS`, declared
  // just above. Insertion order is guaranteed because none of the keys is
  // integer-like; `__tests__/sources.test.ts` pins the resulting list anyway.
  Object.keys(EPISODE_SOURCE_SPECS) as EpisodeSource[],
);

/**
 * The vendors named by vendor-grained members — `"slack"`, `"zoom"` and
 * `"outlook"` today.
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
 * The transcript class's first vendor — what `ZOOM_TRANSCRIPT_SOURCE` resolves
 * to (#4965).
 *
 * This value and the source-id grammar beside it in `ingest/zoom/config.ts` are
 * a published contract rather than a private naming choice: they are stamped
 * into `brain_episodes.source` and `source_id`, and that table is append-only,
 * so a second writer spelling either differently mints episodes nothing
 * converges.
 *
 * ⚠️ That second writer does not exist. This docblock said #4967's webhook
 * fast-path was "being built in PARALLEL against the Zoom connector" — written
 * while #4967 was in flight, and wrong once it shipped: it is SLACK-only
 * (`webhook.ts` resolves `{ vendor: SLACK_SOURCE }`, and `brain-observer.ts`
 * refuses every non-Slack platform). The contract still stands on the
 * append-only store; it just has one writer today, which is the poll.
 */
export const ZOOM_SOURCE = "zoom" satisfies EpisodeSource;

/**
 * The email class's first vendor — what `OUTLOOK_MAIL_SOURCE` resolves to
 * (#4966). Microsoft Graph, maintainer-confirmed over the issue's own Gmail
 * recommendation: Atlas already ships a Teams adapter, so the Microsoft OAuth
 * surface is partly familiar.
 *
 * Spelled `outlook` and not `microsoft-graph` or `exchange`, because the stored
 * value names the VENDOR SURFACE a user recognises, the way `slack` and `zoom`
 * do. Graph is the transport; a hypothetical future Microsoft source that is not
 * mail (Teams messages, SharePoint) would be its own member under its own class
 * rather than a second meaning for this one.
 */
export const OUTLOOK_SOURCE = "outlook" satisfies EpisodeSource;

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

/**
 * ADR-0036 §T6's second connector class — a recorded meeting's transcript
 * (#4965), the next rung on the ACL-difficulty gradient.
 *
 * "Next rung" and not "same rung": a chat channel's audience is a MUTABLE
 * roster, so #4801 keeps it live through `fact_audience_member`. A meeting's
 * audience is its participant list, which is FROZEN the moment the meeting ends
 * — nobody joins a past meeting. What stays mutable is the RESOLUTION of those
 * participants to Atlas users (people join and leave the org), which is why a
 * transcript grant is still an `audience:` and still needs re-verification
 * rather than being frozen into `user:` tokens at ingest. See
 * `ingest/grant.ts`'s {@link deriveMeetingParticipantGrant}.
 */
export const TRANSCRIPT_CLASS = "transcript" satisfies EpisodeSourceClass;

/**
 * ADR-0036 §T6's third connector class — a mail message (#4966), and the first
 * rung of the ACL gradient where the derived audience is knowingly INCOMPLETE.
 *
 * The distinction from its two predecessors is not degree, it is kind. A chat
 * channel's roster and a meeting's participant list are both sets the vendor can
 * state in full; what varies is whether the set can still change (chat: yes,
 * meeting: no). An email's true audience is stateable by NOBODY — a BCC'd
 * recipient is invisible to every other copy of the message, and a forward
 * enlarges the audience with no trace on the original.
 *
 * So the email class derives a grant that is a LOWER BOUND, deliberately, and
 * accepts under-granting as the price of never over-granting. That decision, and
 * the determinism argument that is its real justification, live at
 * {@link deriveEmailRecipientGrant} in `ingest/grant.ts` — the file a maintainer
 * reaches for when they wonder why a BCC'd colleague cannot see a fact.
 */
export const EMAIL_CLASS = "email" satisfies EpisodeSourceClass;

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
 * unhelpful ways there: an unknown slug throws `undefined is not an object`
 * (bun's wording; V8 says "Cannot read properties of undefined"),
 * which names an internal expression rather than the bad value; and an
 * inherited key (`"toString"`, `"valueOf"`) resolves up the PROTOTYPE CHAIN to
 * a function, whose `.class` is `undefined` — so a class-keyed predicate
 * silently answers "not warehouse". Since #4964 that lands in the correction
 * quarantine rather than in a lost refusal, so it no longer fails OPEN — but it
 * refuses under a reason that names the wrong problem, and `"toString"` is not
 * a source kind anyone should be reasoning about. `Object.hasOwn` refuses both,
 * and throwing names the value.
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

/**
 * The ADR-0036 class a stored source kind belongs to.
 *
 * @throws if `source` is outside the vocabulary — see {@link specOf}. Reading a
 * STORED row? Use {@link episodeSourceClassOf}, which returns `null` instead.
 */
export function episodeSourceClass(source: EpisodeSource): EpisodeSourceClass {
  return specOf(source).class;
}

/**
 * The vendor within that class, or `null` for a class that has none
 * (`warehouse`, `human` — neither comes from a connector).
 *
 * @throws if `source` is outside the vocabulary — see {@link specOf}.
 */
export function episodeSourceVendor(source: EpisodeSource): EpisodeSourceVendor | null {
  return specOf(source).vendor;
}

/**
 * The class of an ARBITRARY stored value, or `null` when it is outside the
 * vocabulary — the total sibling of {@link episodeSourceClass}.
 *
 * This exists because the region import (`admin-migrate.ts`) deliberately
 * writes out-of-vocabulary values into `brain_episodes.source` so a bundle from
 * a newer region still restores. So the codebase GUARANTEES the existence of
 * rows whose `source` would make the throwing accessor throw — and without a
 * total sibling, the only route for a caller reading such a row is
 * `row.source as EpisodeSource`, which is exactly the cast that turns a
 * documented fail-open lane into a 500.
 *
 * Use this to read a stored row. Use {@link episodeSourceClass} when the value
 * is already known to be in the vocabulary and an unknown one would be a
 * programmer error worth surfacing loudly.
 *
 * There is no production caller — zero, not "one elsewhere". #4967's webhook
 * fast-path was predicted to be one and is NOT: it resolves connectors on the
 * VENDOR axis (`findBrainSourceConnectors({ vendor: SLACK_SOURCE })`) and never
 * asks for a class. The region-import lane (`admin-migrate.ts`) has the
 * read-a-stored-row SHAPE this is for and names it in a comment, but does not
 * call it either. Spelled out this far because the docstring this replaced
 * asserted a caller that did not exist, and "names it in a comment" is the same
 * mistake one step smaller.
 */
export function episodeSourceClassOf(value: unknown): EpisodeSourceClass | null {
  return isEpisodeSource(value) ? episodeSourceClass(value) : null;
}

/**
 * Does an arbitrary stored value name a WAREHOUSE-CLASS source? The single
 * trigger behind `correction.ts`'s tier-1 correction refusal — and, since
 * #5033, also the derivation behind {@link NON_WAREHOUSE_SOURCES}, which is
 * what decides whether the publish gate may stamp a fact's `valid_to`. Weigh a
 * change here against BOTH: one costs a refusal a deploy can restore, the other
 * retires a belief nothing can.
 *
 * Takes `unknown` rather than `EpisodeSource` because every caller reads it off
 * a stored JSON payload (`provenance.source`) that no type system has checked —
 * including the region-import fail-open lane, which restores a bundle's value
 * verbatim.
 *
 * An unrecognised value is NOT warehouse-derived. Read that narrowly: it is
 * this predicate declining to claim a class it cannot see, and it does NOT mean
 * such a fact is correctable. It used to. That was called "the correctable
 * (safe) direction" here, on the reasoning that it costs a refusal that should
 * have fired rather than blocking a correction that should have been allowed —
 * sound for a value that had to pass a producer gate to exist, and precisely
 * wrong for the one lane where no gate runs, which is the lane that produces
 * unrecognised values in the first place (#4964). The tier-1 invariant is now
 * held one level up: `correction.ts`'s `unrecognizedSourceKind` quarantines the
 * correction path of a fact whose kind cannot be classified, so an unknown
 * value costs no lost refusal. See this file's header, §"Where that lane is
 * closed", before widening or "simplifying" either predicate.
 */
export function isWarehouseDerivedSource(value: unknown): boolean {
  return isEpisodeSource(value) && episodeSourceClass(value) === WAREHOUSE_CLASS;
}

/**
 * The shape every stored kind must have to be safe as a SQL string literal.
 *
 * Exported because #5033's tier guard SPLICES the vocabulary into a statement
 * (`content-mode/adapters/brain-facts.ts` builds `ARRAY['slack', …]::text[]`
 * from {@link NON_WAREHOUSE_SOURCES}), and the rule that makes that safe is a
 * property of the vocabulary rather than of any one consumer. Spelled once here
 * so the next consumer that splices the list does not re-derive it — and so the
 * assertion below and `__tests__/sources.test.ts` cannot loosen independently,
 * which is the drift that matters: a looser consumer with a stricter test is
 * green until it is a boot failure.
 */
export const EPISODE_SOURCE_SLUG = /^[a-z][a-z0-9_-]*$/;

/**
 * Module-load enforcement of the rule above. THROWS rather than filtering the
 * offender out, because every value here is a compile-time key of
 * {@link EPISODE_SOURCE_SPECS}: this either always throws or never does, so CI
 * is where an author meets it and there is no runtime input that can reach it.
 *
 * ⚠️ Be honest about the blast radius, which is bigger than "the tier guard":
 * this module is on the static import path of `search.ts` and the tool
 * registry, so a throw here takes the API process down at boot, not just
 * publish. That is the correct direction — a vocabulary member that needs SQL
 * escaping is a decision somebody must make deliberately, not one a string
 * splice makes silently — but it is not a localized failure, and the fix is to
 * rename the member rather than to relax the pattern.
 */
for (const source of EPISODE_SOURCES) {
  if (!EPISODE_SOURCE_SLUG.test(source)) {
    throw new Error(
      `Episode source "${source}" is not a bare slug (${String(EPISODE_SOURCE_SLUG)}) — EPISODE_SOURCE_SPECS keys are spliced into SQL by #5033's tier guard, so rename the member or quote it deliberately at every splice site`,
    );
  }
}

/**
 * Every stored kind that is NOT warehouse-class — the vocabulary half of
 * #5033's tier guard, derived rather than spelled.
 *
 * The complement of {@link isWarehouseDerivedSource} over
 * {@link EPISODE_SOURCES}, in declaration order, so a member added under
 * `class: "warehouse"` LEAVES this list in the same one-line PR that adds it and
 * inherits the guard with no second edit. That is the same property
 * {@link isWarehouseDerivedSource} has and the reason both read the class rather
 * than the stored value (#4963).
 *
 * ⚠️ Membership here is POSITIVE evidence that a row is not tier-1, and the
 * consumer uses it that way: a value outside this list — including one outside
 * the vocabulary entirely — is not thereby "non-warehouse". See
 * `content-mode/adapters/brain-facts.ts`'s tier guard for what that costs and
 * why the unresolvable case is refused rather than admitted, which is #4964's
 * conclusion applied one seam over.
 *
 * ## The residual this INHERITS, and why it is not closed here
 *
 * A member declaring a NEW class that is warehouse-shaped —
 * `{ class: "lakehouse", vendor: null }` — lands in this list by default and is
 * therefore supersedable. So does the header's own example, a warehouse-shaped
 * kind declaring an EXISTING non-warehouse class (`{ class: "chat", vendor:
 * "snowflake" }`) — which is the cheaper edit of the two, since a brand-new
 * class must also widen `EPISODE_SOURCE_CLASSES` and `EpisodeSourceSpec` before
 * it compiles at all. Same family, and the same root: the type system does not
 * know what warehouse-shaped means. It is inherited rather than introduced —
 * {@link isWarehouseDerivedSource} has always had it, and this list is defined
 * as its complement.
 *
 * What CHANGED is the price. Through `correction.ts` the residual costs a lost
 * tier-1 refusal, recoverable by a deploy that re-declares the class. Through
 * this list it costs a `valid_to` stamp, which is recoverable by nothing.
 *
 * A `Record<EpisodeSourceClass, 1 | 2>` tier table would make it a compile
 * error, and was considered and rejected — but NOT on #4938's grounds, which
 * were about two independent string literals agreeing by coincidence. A tier
 * table that {@link isWarehouseDerivedSource} read THROUGH would be one
 * spelling, not two. It is rejected because the product has exactly one tier
 * distinction that any code branches on — warehouse or not — and a numeric
 * column invites readers to invent orderings the ADR has not decided, in the
 * one module whose job is to keep the two axes from multiplying. **So the rule
 * stays prose, and it is this: a warehouse-shaped kind must declare
 * `class: WAREHOUSE_CLASS`.** Revisit the table the day a second tier
 * distinction is real.
 */
export const NON_WAREHOUSE_SOURCES: readonly EpisodeSource[] = Object.freeze(
  EPISODE_SOURCES.filter((source) => !isWarehouseDerivedSource(source)),
);

/**
 * Every stored kind that IS warehouse-class — the vocabulary half of #5034's
 * direction rule, derived on {@link NON_WAREHOUSE_SOURCES}'s terms exactly.
 *
 * ⚠️ **NOT the complement of that list as far as any consumer is concerned**,
 * and the gap between them is the whole reason this is a second derivation
 * rather than a `NOT (… = ANY (…))` at the call site. Three populations, not
 * two: a member of this list, a member of that one, and a stored value in
 * NEITHER — `warehouse:prod`, `snowflake`, a value a region import restored
 * verbatim. Membership here is POSITIVE evidence that a row IS warehouse-derived
 * and membership there is positive evidence that it is not; an unrecognised
 * value is evidence of nothing and must fall out of both.
 *
 * The consequence at #5034's call site is smaller than the tier guard's and runs
 * the other way. There an unresolvable kind must not be *stamped*; here it must
 * not be treated as the canonical TARGET of an alias, because the whole reason a
 * warehouse norm is the proposed target is that its space is closed, typed and
 * described (ADR-0037 §4) — a kind this region cannot even classify has none of
 * those properties. Falling out of both lists makes the candidate UNDIRECTED,
 * which routes the decision to a human. That is the fail-closed direction: an
 * approver picks the target instead of the producer guessing it.
 *
 * Inherits the same residual {@link NON_WAREHOUSE_SOURCES} records at length —
 * a warehouse-shaped kind that declares a non-warehouse class is absent here and
 * therefore never proposed as a target. Read that residual there; through THIS
 * list its price is a proposal a human has to direct by hand, which is the
 * cheapest of the three prices the residual carries.
 */
export const WAREHOUSE_SOURCES: readonly EpisodeSource[] = Object.freeze(
  EPISODE_SOURCES.filter((source) => isWarehouseDerivedSource(source)),
);

/**
 * A source vocabulary as a SQL `text[]` literal — the one spelling of the splice
 * that {@link EPISODE_SOURCE_SLUG} makes safe.
 *
 * Lives beside the values rather than beside a consumer, because #5033's tier
 * guard and #5034's direction rule now both splice a list and the escaping rule
 * must not be re-derived per consumer. Nothing user-supplied reaches it: every
 * element is a compile-time key of {@link EPISODE_SOURCE_SPECS}, validated at
 * this module's load.
 *
 * An EMPTY list yields `ARRAY[]::text[]` — valid SQL, false for every row. Both
 * consumers degrade fail-closed on that (the tier guard to *only a `source`-less
 * row may supersede*, the direction rule to *every candidate is undirected*),
 * and `__tests__/sources.test.ts` asserts non-emptiness on both lists so the
 * degradation is a red test rather than a quiet narrowing.
 */
export function episodeSourceArraySql(sources: readonly EpisodeSource[]): string {
  return `ARRAY[${sources.map((source) => `'${source}'`).join(", ")}]::text[]`;
}
