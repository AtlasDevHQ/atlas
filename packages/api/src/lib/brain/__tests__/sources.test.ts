/**
 * The episode-source vocabulary (#4938) — the shared fact behind
 * `brain_episodes.source`.
 *
 * ## What this file is defending
 *
 * Tier-1 correction refusal is an ADR-0036-level invariant: a warehouse-derived
 * fact has NO correction path, because the fix belongs in the data or the
 * semantic layer rather than in an override the next sync overwrites. Its only
 * trigger is `isWarehouseDerived`, a `===` against one string, and the value it
 * compares arrives from a producer ADR-0036 commits to but that **no milestone
 * in the M1–M6 cut has scoped yet**.
 *
 * Before `sources.ts`, the two sides each spelled their own literal and every
 * test on the refusal hand-seeded `{ source: "warehouse" }` and asserted
 * against `"warehouse"` — the test and the code agreed with each other and with
 * nothing else. A connector naming its class `"snowflake"` would have stopped
 * every tier-1 refusal firing while all four verb tests, the 409 route test and
 * the tool-description test stayed green. An ADR invariant failing OPEN with a
 * fully green suite is the failure mode this file exists to make impossible.
 *
 * So the assertions below are deliberately about AGREEMENT, not about values:
 * each one pins two sides to the same constant, and the closed key-set test
 * makes widening the vocabulary something you have to do on purpose.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHAT_CLASS,
  EPISODE_SOURCE_CLASSES,
  EPISODE_SOURCE_SPECS,
  EPISODE_SOURCES,
  HUMAN_SOURCE,
  SLACK_SOURCE,
  WAREHOUSE_CLASS,
  WAREHOUSE_SOURCE,
  episodeSourceClass,
  episodeSourceVendor,
  isEpisodeSource,
  isEpisodeSourceClass,
  isWarehouseDerivedSource,
  type EpisodeSource,
  type EpisodeSourceSpec,
} from "@atlas/api/lib/brain/sources";
import { CORRECTION_EPISODE_INSERT_SQL, isWarehouseDerived } from "@atlas/api/lib/brain/correction";
import { SLACK_HISTORY_SOURCE } from "@atlas/api/lib/brain/ingest/slack/config";

describe("the episode-source vocabulary", () => {
  test("is a CLOSED key set — widening it has to fail this test first", () => {
    // The point of failing here is the header on `sources.ts`: if the KIND
    // being added is warehouse-shaped its spec must declare
    // `class: WAREHOUSE_CLASS`, because that class is what tier-1 refusal
    // reads. A test that merely checked membership would wave `"snowflake"`
    // through. (Preferring the stored value `WAREHOUSE_SOURCE` too is a
    // separate, weaker recommendation — see that header.)
    expect([...EPISODE_SOURCES]).toEqual(["slack", "warehouse", "human"]);
    // Each named export is pinned to its VALUE, not merely to membership. This
    // file exists to defeat self-referential agreement, so it must not commit
    // the same sin: with only an `every(isEpisodeSource)` check, swapping
    // `SLACK_SOURCE` and `WAREHOUSE_SOURCE`'s values leaves every assertion in
    // this file green (the sweep below is driven by the same constant
    // `correction.ts` reads, so the two stay agreed while both are wrong).
    // These three lines are the only place the constants are anchored to
    // strings, and that is deliberate — everything else asserts agreement.
    expect([SLACK_SOURCE, WAREHOUSE_SOURCE, HUMAN_SOURCE]).toEqual([
      "slack",
      "warehouse",
      "human",
    ]);
  });

  test("narrows an arbitrary stored value, and refuses the vendor names a warehouse connector would reach for", () => {
    // `isEpisodeSource` is the runtime gate `registerBrainSourceConnector`
    // applies to a connector arriving as data. Three of these four are legal
    // `SOURCE_SLUG` values, so the pattern check waves them through and only
    // the vocabulary stops them — that is the concrete regression. The fourth,
    // `warehouse:prod`, is caught one gate EARLIER by the slug pattern (the
    // colon); it is here because a narrowing predicate should refuse it too,
    // not because the slug check would miss it.
    for (const vendor of ["snowflake", "bigquery", "warehouse-prod", "warehouse:prod"]) {
      expect([vendor, isEpisodeSource(vendor)]).toEqual([vendor, false]);
    }
    // The mirror of `isEpisodeSourceClass("slack") === false` below: `chat` is
    // a real CLASS name and is NOT a stored source. Asserted directly rather
    // than left to fall out of `isWarehouseDerivedSource("chat")`, where a
    // `false` could come from either arm of that predicate.
    expect(isEpisodeSource("chat")).toBe(false);
    for (const nonString of [null, undefined, 42, { source: "warehouse" }, ["warehouse"]]) {
      expect(isEpisodeSource(nonString)).toBe(false);
    }
  });
});

describe("the class/vendor axes (#4963)", () => {
  test("the CLASS set is CLOSED too — widening it has to fail this test first", () => {
    // The one-line-PR property now spans two axes. Before the split there was
    // one way to change what this vocabulary means (add a stored value); now
    // there are two, and a class arriving without a member is the quieter one
    // — it adds an arm no `switch` ever reaches and no producer ever stamps.
    // ADR-0036's unshipped classes (transcripts, email, docs) are deliberately
    // NOT pre-declared here; each lands with its first connector.
    expect([...EPISODE_SOURCE_CLASSES]).toEqual(["chat", "warehouse", "human"]);
    // Anchored to VALUES, for the same reason the source constants are: every
    // other assertion in this file is about agreement, so if the constants are
    // never pinned to strings, swapping `CHAT_CLASS` and `WAREHOUSE_CLASS`
    // leaves the whole file green while tier-1 refusal points at chat.
    expect([CHAT_CLASS, WAREHOUSE_CLASS]).toEqual(["chat", "warehouse"]);
  });

  test("every stored source declares its class AND its vendor", () => {
    // The whole map at once, pinned to literals. This is the one place the
    // grain of each member is anchored, so adding a member without deciding
    // whether it is class-grained or vendor-grained fails HERE — which is the
    // decision `sources.ts`'s header asks the author to make on purpose.
    expect(
      Object.fromEntries(
        EPISODE_SOURCES.map((source) => [
          source,
          [episodeSourceClass(source), episodeSourceVendor(source)],
        ]),
      ),
    ).toEqual({
      slack: ["chat", "slack"],
      warehouse: ["warehouse", null],
      human: ["human", null],
    });
  });

  test("every member resolves to a TOTAL spec — no undefined arm to fall through", () => {
    // NOT `expect([...EPISODE_SOURCES]).toEqual(Object.keys(EPISODE_SOURCE_SPECS))`:
    // `EPISODE_SOURCES` IS `Object.keys(EPISODE_SOURCE_SPECS)`, so that
    // compares a value to its own derivation and cannot fail. (It also did not
    // compile — `Object.keys` is `string[]` — which is how it was caught.)
    // The falsifiable claim is TOTALITY: a member with no spec would read back
    // `undefined` as its class and silently escape every class-keyed
    // predicate, tier-1 refusal first among them.
    for (const source of EPISODE_SOURCES) {
      expect([source, EPISODE_SOURCE_SPECS[source]]).not.toEqual([source, undefined]);
      expect([source, typeof episodeSourceClass(source)]).toEqual([source, "string"]);
    }
    // …and every class a member names is really in the closed class set, so
    // the two constants cannot drift apart.
    for (const source of EPISODE_SOURCES) {
      expect([source, isEpisodeSourceClass(episodeSourceClass(source))]).toEqual([source, true]);
    }
    // The reverse direction — no ORPHAN class, one that no member produces.
    // The pinned key-set above would catch it incidentally, but only because
    // an author adding a class edits that line anyway; this states the rule.
    for (const cls of EPISODE_SOURCE_CLASSES) {
      expect([cls, EPISODE_SOURCES.some((s) => episodeSourceClass(s) === cls)]).toEqual([
        cls,
        true,
      ]);
    }
  });

  test("the vocabulary is FROZEN — the tier-1 discriminator cannot be rewritten at runtime", () => {
    // `as const` is a type-level assertion and leaves the object mutable. This
    // map is the sole input to tier-1 correction refusal, and the code it
    // replaced compared against a string primitive — unforgeable by
    // construction. One property write would disable the refusal for every
    // warehouse-derived fact with nothing red: every test reads the SAME
    // mutated map, so they stay green and agreed while both are wrong.
    expect(Object.isFrozen(EPISODE_SOURCE_SPECS)).toBe(true);
    for (const source of EPISODE_SOURCES) {
      expect([source, Object.isFrozen(EPISODE_SOURCE_SPECS[source])]).toEqual([source, true]);
    }
    expect(Object.isFrozen(EPISODE_SOURCES)).toBe(true);
    // The class array too: it is the sole input to `isEpisodeSourceClass`, so a
    // `push` here silently widens what `registerBrainSourceConnector` and the
    // orphan sweep admit. Off the tier-1 path, but the same argument.
    expect(Object.isFrozen(EPISODE_SOURCE_CLASSES)).toBe(true);
  });

  test("the class/vendor pairing is UNREPRESENTABLE when wrong — compile-time", () => {
    // `@ts-expect-error` is the only instrument that can pin this: reverting
    // `EpisodeSourceSpec` to the flat `{ class: EpisodeSourceClass; vendor:
    // string | null }` it replaced leaves every runtime assertion in both
    // suites green AND cannot fail typecheck, because the flat shape is
    // strictly more permissive. Each line below fails to compile TODAY, so the
    // revert turns them into "unused @ts-expect-error" errors — which is how a
    // type-level guarantee gets a guard at all.
    // @ts-expect-error a chat member MUST name its vendor — two chat vendors sharing one stored value share a dedupe namespace
    const chatWithoutVendor: EpisodeSourceSpec = { class: "chat", vendor: null };
    // @ts-expect-error a connectorless class has no vendor to name
    const warehouseWithVendor: EpisodeSourceSpec = { class: "warehouse", vendor: "snowflake" };
    // @ts-expect-error a class outside the closed set
    const unknownClass: EpisodeSourceSpec = { class: "email", vendor: null };
    void chatWithoutVendor;
    void warehouseWithVendor;
    void unknownClass;
  });

  test("a spec declares EXACTLY class and vendor — no invented fields", () => {
    // Belt to the per-entry `satisfies`'s braces. Excess-property checking only
    // fires on a fresh object literal, and `Object.freeze(...)` is a call
    // result — so wrapping the entries silently disabled it until each literal
    // got its own `satisfies`. A type cannot assert this after the fact, and a
    // typo'd or invented key (`vendorr`, `tier`) on the map the file calls "the
    // sole input to tier-1 correction refusal" is exactly the shape that
    // produces false confidence in a field nothing reads.
    for (const source of EPISODE_SOURCES) {
      expect([source, Object.keys(EPISODE_SOURCE_SPECS[source]).toSorted()]).toEqual([
        source,
        ["class", "vendor"],
      ]);
    }
  });

  test("the accessors refuse an out-of-vocabulary value LOUDLY, naming it", () => {
    // The parameter is typed `EpisodeSource`, so these need a cast — which is
    // exactly what `row.source as EpisodeSource` off a stored payload is. Two
    // distinct failures the raw index lookup had: an unknown slug threw
    // `undefined is not an object` (naming an internal expression, not the bad
    // value), and an INHERITED key resolved up the prototype chain to a
    // function whose `.class` is `undefined` — so a class-keyed predicate
    // answered "not warehouse" and tier-1 refusal failed OPEN, silently.
    for (const bad of ["snowflake", "toString", "valueOf", "constructor", ""]) {
      expect(() => episodeSourceClass(bad as EpisodeSource)).toThrow(/not in the vocabulary/);
      expect(() => episodeSourceVendor(bad as EpisodeSource)).toThrow(/not in the vocabulary/);
      // The message must name the offending value, or an operator reading a
      // 500 cannot tell which source string caused it.
      expect(() => episodeSourceClass(bad as EpisodeSource)).toThrow(new RegExp(`"${bad}"`));
    }
  });

  test("isEpisodeSourceClass narrows, and does not confuse a VENDOR for a class", () => {
    for (const cls of EPISODE_SOURCE_CLASSES) {
      expect([cls, isEpisodeSourceClass(cls)]).toEqual([cls, true]);
    }
    // `slack` is the sharp one: it is a legal stored source AND a legal vendor,
    // and it is NOT a class. A predicate that conflated the two axes would let
    // a caller ask for "the slack class" and get a plausible-looking answer.
    // (`warehouse` and `human` are spelled identically on BOTH axes, so they
    // cannot discriminate here — which is why `slack` carries this test.)
    // `transcript`/`email`/`docs` are ADR-0036 classes that have not shipped —
    // naming one must stay false until its connector lands.
    for (const notClass of ["slack", "transcript", "email", "docs", "Chat", ""]) {
      expect([notClass, isEpisodeSourceClass(notClass)]).toEqual([notClass, false]);
    }
    for (const nonString of [null, undefined, 42, { class: "chat" }, ["chat"]]) {
      expect(isEpisodeSourceClass(nonString)).toBe(false);
    }
  });

  test("isEpisodeSource is not fooled by inherited Object keys", () => {
    // A regression the array-scan spelling could not have had: the predicate
    // now looks the value up in the spec MAP, so every key on `Object.prototype`
    // is a new way to be wrong. `Object.hasOwn` is what refuses them and a bare
    // `value in EPISODE_SOURCE_SPECS` would not — `isEpisodeSource("toString")`
    // returning true would hand `episodeSourceClass` a function to read `.class`
    // off, and the value would flow on into `brain_episodes.source`.
    for (const inherited of ["toString", "constructor", "hasOwnProperty", "valueOf", "__proto__"]) {
      expect([inherited, isEpisodeSource(inherited)]).toEqual([inherited, false]);
    }
  });
});

describe("tier-1 refusal reads the same fact the producers write", () => {
  test("isWarehouseDerived is anchored to the warehouse VALUE, member by member", () => {
    // The VALUE anchor — the one place tier-1 refusal is tied to a stored
    // string rather than resolved through the class map, so a coordinated
    // rename of both cannot pass unnoticed.
    //
    // Deliberately NOT the universal sweep this used to be
    // (`isWarehouseDerived({source}) === (source === WAREHOUSE_SOURCE)` over
    // every member). That form asserted the PRE-#4963 semantics as a law, so
    // adding a second warehouse-class member — the exact future the split
    // exists to enable — would fail here, and the natural repair would be to
    // make this class-based, silently deleting the file's only value anchor.
    // Stated member by member, it survives that addition instead of blocking
    // it, and the CLASS sweep below is what covers the new member.
    // The literal on at least one line, or this whole test is an agreement
    // assertion wearing a value anchor's name: with `WAREHOUSE_SOURCE` on both
    // sides, renaming the map key AND the constant together passes here.
    expect(isWarehouseDerived({ source: "warehouse" })).toBe(true);
    expect(isWarehouseDerived({ source: WAREHOUSE_SOURCE })).toBe(true);
    expect(isWarehouseDerived({ source: SLACK_SOURCE })).toBe(false);
    expect(isWarehouseDerived({ source: HUMAN_SOURCE })).toBe(false);
  });

  test("isWarehouseDerivedSource selects by CLASS — the property a future member inherits", () => {
    // The behavioural difference #4963 bought. The sweep above pins the answer
    // to the stored VALUE (`=== WAREHOUSE_SOURCE`) and is the value anchor;
    // this one pins it to the CLASS. Both are green today because `warehouse`
    // is that class's only member — and that coincidence is exactly why the
    // old code looked safe. They diverge the moment a warehouse-class member
    // carries a different stored value, and this is the arm that keeps tier-1
    // refusal applying to it.
    for (const source of EPISODE_SOURCES) {
      expect([source, isWarehouseDerivedSource(source)]).toEqual([
        source,
        episodeSourceClass(source) === WAREHOUSE_CLASS,
      ]);
    }
  });

  test("isWarehouseDerivedSource refuses non-members, including a bare class name", () => {
    // `chat` and `human` are real CLASS names and are not stored sources, so
    // asking the source predicate about one must be false rather than
    // accidentally true through the shared spelling of the two axes. The
    // vendor spellings are the #4938 regression, restated against the new
    // predicate so the split cannot quietly reopen it.
    for (const value of [
      "snowflake",
      "bigquery",
      "warehouse:prod",
      "warehouse-prod",
      "Warehouse",
      "chat",
      "slack-history",
    ]) {
      expect([value, isWarehouseDerivedSource(value)]).toEqual([value, false]);
    }
    for (const nonString of [null, undefined, 42, { source: WAREHOUSE_SOURCE }, [WAREHOUSE_SOURCE]]) {
      expect(isWarehouseDerivedSource(nonString)).toBe(false);
    }
  });

  test("correction.ts agrees with the vocabulary on every value", () => {
    // Behavioural half of the delegation claim. Necessary but NOT sufficient —
    // see the source-text pin below for why this one cannot catch a
    // re-derivation.
    for (const source of [...EPISODE_SOURCES, "snowflake", "chat", "warehouse:prod", "human"]) {
      expect([source, isWarehouseDerived({ source })]).toEqual([
        source,
        isWarehouseDerivedSource(source),
      ]);
    }
  });

  test("correction.ts DELEGATES rather than re-deriving — pinned in source text", () => {
    // The one guard in this file that is not about values, because it CANNOT
    // be. Reverting `isWarehouseDerived` to the pre-#4963 comparison —
    //
    //     isJsonObject(provenance) && provenance.source === WAREHOUSE_SOURCE
    //
    // — is behaviourally IDENTICAL today: `warehouse` is the warehouse class's
    // only member, so every assertion above returns the same answer and the
    // whole `correction.ts` half of #4963 reverts with the suite fully green.
    // (Verified by mutation: it does.) The two only diverge on the future
    // warehouse-class member the split exists to protect — which is exactly
    // the "agreement is a coincidence" trap this file's header describes, one
    // level up. A behavioural test cannot see it, so pin the code.
    //
    // Comments are stripped first, the same instrument and the same reason as
    // `episode-sync-archive.test.ts`'s `codeOf`: the prose above `isWarehouseDerived`
    // discusses `=== WAREHOUSE_SOURCE` at length, and a guard that tripped on
    // the explanation would force the explanation to be deleted to stay green.
    const code = readFileSync(join(import.meta.dir, "..", "correction.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    // Scoped to the FUNCTION BODY, not the file. A file-wide `toContain` is
    // vacuous the moment a second call site exists: adding any helper that
    // mentions `isWarehouseDerivedSource` satisfies it while
    // `isWarehouseDerived` itself re-derives, and the whole revert goes green
    // again. (Verified — that is exactly how this pin was first evaded.)
    const body = /export function isWarehouseDerived\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(code)?.[1];
    // Not vacuous: a rename or signature change must fail here rather than
    // silently making every assertion below run against `undefined`.
    expect(body).toBeDefined();
    expect(body).toContain("isWarehouseDerivedSource(");
    // Any `===` in this body is a re-derivation, whatever it compares against
    // and however it is spelled — including the destructure-then-compare form
    // that both of the old `\.source ===` regexes missed.
    expect(body).not.toMatch(/===/);
  });

  test("refuses the vendor spellings the same connector might have used", () => {
    // The literal-agreement failure, stated directly: these are what
    // a future warehouse producer would plausibly stamp if the kind were
    // spelled at the producer instead of imported. `registerBrainSourceConnector` now
    // refuses each of them at wiring time (`episode-sync-archive.test.ts`) —
    // this arm pins what would happen if one ever reached the payload anyway,
    // via the region import, which restores a bundle's `source` verbatim.
    for (const vendor of ["snowflake", "bigquery", "warehouse:prod", "Warehouse", "WAREHOUSE"]) {
      expect([vendor, isWarehouseDerived({ source: vendor })]).toEqual([vendor, false]);
    }
    // Not a JSON object, or no `source` key at all — a fact predating the
    // provenance shape must not be read as warehouse-derived either way.
    expect(isWarehouseDerived(null)).toBe(false);
    expect(isWarehouseDerived("warehouse")).toBe(false);
    expect(isWarehouseDerived({})).toBe(false);
  });

  test("the Slack producer's source IS the vocabulary's chat vendor, not a parallel literal", () => {
    // `SLACK_HISTORY_SOURCE` is what `client.ts` and `connector.ts` stamp on
    // every ingested episode and what `oversight.ts` keys its channel map on.
    // Aliasing rather than re-spelling is what makes the audience/grant side
    // and the correction side the same fact.
    expect(SLACK_HISTORY_SOURCE).toBe(SLACK_SOURCE);
  });

  test("the class/vendor split left the Slack source BYTE-IDENTICAL", () => {
    // #4963's hard constraint: the seam was generalized FROM the Slack
    // connector without changing it. `brain_episodes.source` is a STORED key —
    // it is half of the `(workspace_id, source, source_id)` dedupe tuple — so a
    // changed value here does not migrate anything, it re-ingests every message
    // in every workspace as a fresh episode and re-extracts facts from all of
    // them. This asserts the literal, deliberately, and not `SLACK_SOURCE`:
    // comparing the producer to a constant that moved with it would be exactly
    // the self-referential agreement this file exists to defeat.
    expect(SLACK_HISTORY_SOURCE).toBe("slack");
    // Its grain is what the header always CLAIMED it was — chat class, slack
    // vendor — now readable rather than only described in prose.
    expect([episodeSourceClass(SLACK_SOURCE), episodeSourceVendor(SLACK_SOURCE)]).toEqual([
      "chat",
      "slack",
    ]);
    // And chat is emphatically not the tier-1 class: Slack-derived facts stay
    // correctable, which is the opposite end of the predicate that moved.
    expect(isWarehouseDerivedSource(SLACK_SOURCE)).toBe(false);
  });

  test("the correction episode stamps the vocabulary's human class", () => {
    // `CORRECTION_EPISODE_INSERT_SQL` inlines the kind as a SQL literal rather
    // than binding it, so the two are separate spellings — asserting the
    // statement against the constant is what keeps them from drifting apart.
    // Matched WITH its column position, so a reordered VALUES list that moved
    // `'human'` into another slot fails here rather than passing. A correction
    // episode landing outside the vocabulary would be invisible to every
    // discriminator that reads the column.
    // Whitespace-tolerant: the claim is the column POSITION, not the
    // statement's formatting, and a reflow that broke the line after the comma
    // would otherwise fail a test whose subject had not changed.
    expect(CORRECTION_EPISODE_INSERT_SQL).toMatch(
      new RegExp(String.raw`VALUES\s*\(\s*\$1\s*,\s*'${HUMAN_SOURCE}'\s*,`),
    );
    expect(isEpisodeSource(HUMAN_SOURCE)).toBe(true);
    // And it is NOT the warehouse class: a human's own words must stay
    // correctable, which is the opposite end of the same predicate.
    expect(isWarehouseDerived({ source: HUMAN_SOURCE })).toBe(false);
  });
});
