/**
 * The one reading behind "is this stored row an observation?" (#5340,
 * ADR-0042).
 *
 * ## What this file owns, and what it deliberately does not
 *
 * The SHAPE of the reading: the three populations, the order of the arms, and
 * the fact that an unclassifiable row is its own answer rather than a quiet
 * `false`. Which VALUES count as warehouse-class, and the agreement between the
 * vocabulary and the producers that stamp it, are `__tests__/sources.test.ts`
 * — including the source-text pin that stops `readStoredSource` re-deriving the
 * class instead of asking for it. The two files split that way because the
 * literals were the reason tier-1 refusal could have failed open unnoticed
 * (#4938), and putting them here would be the same mistake in a new file.
 *
 * The gates that CONSUME the reading assert their own inheritance of it —
 * `correction.test.ts` for the refusal set, and, as they land, the publish gate
 * (#5342) and the serving exclusion (#5341). A test at the classifier is not a
 * test at the consumer, which is why ADR-0042 asks for one per consumer.
 */

import { describe, expect, test } from "bun:test";
import { isObservation, readStoredSource } from "@atlas/api/lib/brain/observation";
import {
  EPISODE_SOURCES,
  NON_WAREHOUSE_SOURCES,
  WAREHOUSE_SOURCE,
  WAREHOUSE_SOURCES,
} from "@atlas/api/lib/brain/sources";

describe("readStoredSource", () => {
  test("a warehouse-class row is an observation", () => {
    expect(readStoredSource({ source: WAREHOUSE_SOURCE })).toEqual({ kind: "observation" });
    // Driven off the vocabulary rather than the one literal, so a SECOND
    // warehouse-class member is covered the day its spec declares the class —
    // which is the whole reason this reads the class and not a string.
    expect(WAREHOUSE_SOURCES.length).toBeGreaterThan(0);
    for (const source of WAREHOUSE_SOURCES) {
      expect([source, readStoredSource({ source })]).toEqual([source, { kind: "observation" }]);
    }
  });

  test("every NON-warehouse source in the vocabulary is a belief — the widening guard", () => {
    // ADR-0042's exclusion is on the SOURCE, and it must never widen past the
    // warehouse class. Adding a source kind (a second chat vendor, a Gmail
    // connector) must not silently make its facts unservable and
    // uncorrectable, so this sweeps the complement rather than naming members.
    // `NON_WAREHOUSE_SOURCES` is derived from the same spec map the reading
    // consults, so the sweep grows with the vocabulary automatically.
    expect(NON_WAREHOUSE_SOURCES.length).toBeGreaterThan(0);
    for (const source of NON_WAREHOUSE_SOURCES) {
      expect([source, readStoredSource({ source })]).toEqual([source, { kind: "belief" }]);
      expect([source, isObservation({ source })]).toEqual([source, false]);
    }
    // The two lists together are the whole vocabulary — otherwise a member
    // could fall out of both and this sweep would pass while covering nothing.
    expect([...WAREHOUSE_SOURCES, ...NON_WAREHOUSE_SOURCES].sort()).toEqual(
      [...EPISODE_SOURCES].sort(),
    );
  });

  test("an unresolvable kind is its own answer, never a quiet 'not an observation'", () => {
    // The third population. A stored kind this deployment cannot classify COULD
    // be warehouse-shaped — the region import restores a bundle's `source`
    // verbatim — so every gate has to decide what to do with it explicitly.
    // Collapsing it into `belief` is the fail-open #4964 closed.
    expect(readStoredSource({ source: "snowflake" })).toEqual({
      kind: "unclassifiable",
      source: "snowflake",
      resolvable: true,
    });
    expect(readStoredSource({ source: 42 })).toEqual({
      kind: "unclassifiable",
      source: "[number]",
      resolvable: false,
    });
  });

  test("the warehouse arm is read BEFORE the own-key carve-out", () => {
    // Not cosmetic, and not reachable from `JSON.parse` output either — this is
    // a REFACTOR invariant. `correction.ts` read `provenance.source` (prototype
    // inclusive) for the warehouse question and `Object.hasOwn` for the
    // vocabulary question, in that order, from #4964 to #5340. Merging the two
    // readings preserves it exactly; reordering the arms would make an
    // inherited `warehouse` read as a belief, which is the permissive
    // direction on a gate whose whole job is to refuse.
    expect(readStoredSource(Object.create({ source: WAREHOUSE_SOURCE }))).toEqual({
      kind: "observation",
    });
    // …while an inherited UNRECOGNISED kind still takes the carve-out, because
    // an inherited `source` is not this fact's provenance.
    expect(readStoredSource(Object.create({ source: "snowflake" }))).toEqual({ kind: "belief" });
  });

  test("a row with no source key, or no object at all, is a belief", () => {
    // The carve-out, and the residual it leaves. Facts predating the provenance
    // shape must stay correctable and publishable; the price is that DELETING
    // `source` from a hand-authored import bundle lands a fully correctable
    // fact. Accepted in `observation.ts` — pinned here so it is a decision
    // somebody made rather than a gap somebody missed.
    expect(readStoredSource({})).toEqual({ kind: "belief" });
    expect(readStoredSource({ producer: "warehouse-producer" })).toEqual({ kind: "belief" });
    expect(readStoredSource(null)).toEqual({ kind: "belief" });
    expect(readStoredSource([])).toEqual({ kind: "belief" });
    expect(readStoredSource("warehouse")).toEqual({ kind: "belief" });
  });
});

describe("isObservation", () => {
  test("is the binary projection of the reading, and takes the fail-closed side", () => {
    expect(isObservation({ source: WAREHOUSE_SOURCE })).toBe(true);
    expect(isObservation({ source: "snowflake" })).toBe(false);
    expect(isObservation(null)).toBe(false);
    expect(isObservation([])).toBe(false);
    // Agreement rather than a second implementation: every shape this file
    // exercises must give the same answer through both entry points, so a
    // future short-circuit in one cannot drift from the other.
    for (const provenance of [
      { source: WAREHOUSE_SOURCE },
      { source: "snowflake" },
      { source: null },
      {},
      null,
      [],
      "warehouse",
    ] as const) {
      expect(isObservation(provenance)).toBe(readStoredSource(provenance).kind === "observation");
    }
  });
});
