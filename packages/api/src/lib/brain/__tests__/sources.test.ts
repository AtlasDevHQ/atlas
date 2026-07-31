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
import {
  EPISODE_SOURCES,
  HUMAN_SOURCE,
  SLACK_SOURCE,
  WAREHOUSE_SOURCE,
  isEpisodeSource,
} from "@atlas/api/lib/brain/sources";
import { CORRECTION_EPISODE_INSERT_SQL, isWarehouseDerived } from "@atlas/api/lib/brain/correction";
import { SLACK_HISTORY_SOURCE } from "@atlas/api/lib/brain/ingest/slack/config";

describe("the episode-source vocabulary", () => {
  test("is a CLOSED key set — widening it has to fail this test first", () => {
    // The point of failing here is the header on `sources.ts`: if the class
    // being added is warehouse-shaped it must BE `WAREHOUSE_SOURCE`, because
    // vendor identity belongs in the catalog id and in `provenance.producer`.
    // A test that merely checked membership would wave `"snowflake"` through.
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
    for (const nonString of [null, undefined, 42, { source: "warehouse" }, ["warehouse"]]) {
      expect(isEpisodeSource(nonString)).toBe(false);
    }
  });
});

describe("tier-1 refusal reads the same fact the producers write", () => {
  test("isWarehouseDerived matches EXACTLY the warehouse class, driven by the constant", () => {
    // Written as a sweep over the vocabulary rather than three literals, so it
    // stays honest when a class is added: a new member defaults to "not
    // warehouse", and a new member that IS warehouse-shaped fails here rather
    // than silently escaping the refusal.
    for (const source of EPISODE_SOURCES) {
      expect([source, isWarehouseDerived({ source })]).toEqual([
        source,
        source === WAREHOUSE_SOURCE,
      ]);
    }
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

  test("the Slack producer's source IS the vocabulary's chat class, not a parallel literal", () => {
    // `SLACK_HISTORY_SOURCE` is what `client.ts` and `connector.ts` stamp on
    // every ingested episode and what `oversight.ts` keys its channel map on.
    // Aliasing rather than re-spelling is what makes the audience/grant side
    // and the correction side the same fact.
    expect(SLACK_HISTORY_SOURCE).toBe(SLACK_SOURCE);
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
