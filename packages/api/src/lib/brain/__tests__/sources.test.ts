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
 * compares arrives from a connector that **does not exist yet** (#4770/#4771).
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
    // Each named export is a member, so a rename cannot leave a dangling
    // constant that still type-checks against the widened union.
    expect([SLACK_SOURCE, WAREHOUSE_SOURCE, HUMAN_SOURCE].every(isEpisodeSource)).toBe(true);
    // Three distinct classes, not one value aliased three times.
    expect(new Set([SLACK_SOURCE, WAREHOUSE_SOURCE, HUMAN_SOURCE]).size).toBe(3);
  });

  test("narrows an arbitrary stored value, and refuses the vendor names a warehouse connector would reach for", () => {
    // `isEpisodeSource` is the runtime gate `registerBrainSourceConnector`
    // applies to a plugin's connector — the producer half that a compile-time
    // type cannot reach. These four are the concrete regression: every one is
    // a legal source slug, so the pattern check waves them all through.
    for (const vendor of ["snowflake", "bigquery", "warehouse:prod", "warehouse-prod"]) {
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
    // #4770/#4771 would plausibly stamp if the class were spelled at the
    // connector instead of imported. `registerBrainSourceConnector` now
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
    // `CORRECTION_EPISODE_INSERT_SQL` inlines the class as a SQL literal (it is
    // structural to the statement, not a bound parameter), so the constant
    // cannot be imported INTO the statement — asserting the statement against
    // the constant is what keeps the two from drifting apart. A correction
    // episode landing outside the vocabulary would be invisible to every
    // discriminator that reads the column.
    expect(CORRECTION_EPISODE_INSERT_SQL).toContain(`'${HUMAN_SOURCE}'`);
    expect(isEpisodeSource(HUMAN_SOURCE)).toBe(true);
    // And it is NOT the warehouse class: a human's own words must stay
    // correctable, which is the opposite end of the same predicate.
    expect(isWarehouseDerived({ source: HUMAN_SOURCE })).toBe(false);
  });
});
