/**
 * The denominator-snapshot vocabulary and its derivations (#5213, ADR-0041).
 *
 * The database half — the write, the sweep, the never-zero rule, the readers —
 * is `coverage-snapshot-pg.test.ts`. This file owns the claims a double can
 * actually falsify: that the surveyable-class list agrees with the class
 * contract, that `state` is derived from EVIDENCE rather than configuration, and
 * that the warehouse unit id is injective where a separator-joined one would not
 * be.
 */

import { describe, expect, it } from "bun:test";
import {
  COVERAGE_DEGRADED_ARMS,
  SURVEYABLE_SOURCE_CLASSES,
  isSurveyableSourceClass,
  surveyUnitState,
  surveyableClassOf,
} from "@atlas/api/lib/brain/coverage-enumeration";
import {
  parseWarehouseSurveyUnitId,
  warehouseSurveyUnitId,
} from "@atlas/api/lib/brain/coverage-warehouse";
import { CLASS_CONTRACTS } from "@atlas/api/lib/brain/class-contract";
import { EPISODE_SOURCE_CLASSES, type EpisodeSourceClass } from "@atlas/api/lib/brain/sources";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("the surveyable-class list — pinned against the class contract", () => {
  it("is EXACTLY the classes whose contract declares a denominator", () => {
    // Derived from the contract rather than restated, so a class that argues its
    // way from `surveyable: false` to `true` (or back) reddens here instead of
    // silently gaining or losing a roster.
    // Widened to `string[]` on BOTH sides so the comparison is on the values.
    // Left as `SurveyableSourceClass[]` vs `EpisodeSourceClass[]` the overload
    // does not resolve — and a cast on one side only would let the narrower type
    // silently satisfy the wider one, which is the drift this test exists for.
    const declaredSurveyable: string[] = EPISODE_SOURCE_CLASSES.filter(
      (cls) => CLASS_CONTRACTS[cls].coverage.denominator.surveyable,
    );
    const listed: string[] = [...SURVEYABLE_SOURCE_CLASSES];
    expect(listed.toSorted()).toEqual(declaredSurveyable.toSorted());
  });

  it("EXCLUDES `human`, whose units would be people", () => {
    // Stated separately from the derivation above because it is the one member
    // whose absence is a disclosure decision rather than an implementation gap:
    // ADR-0041 refuses naming "individual persons" by name.
    expect(SURVEYABLE_SOURCE_CLASSES).not.toContain("human" as never);
    expect(CLASS_CONTRACTS.human.coverage.denominator.surveyable).toBe(false);
  });

  it("matches the CHECK constraint the migration writes", () => {
    // The database refuses a class the list does not carry, so the two have to
    // agree or the first write of a newly surveyable class fails at runtime.
    // Read off the migration's source text — nothing else can see a CHECK.
    const migration = readFileSync(
      join(import.meta.dir, "..", "..", "db", "migrations", "0202_brain_coverage_snapshot.sql"),
      "utf8",
    );
    const inList = [...SURVEYABLE_SOURCE_CLASSES].map((c) => `'${c}'`).join(", ");
    expect(migration).toContain(`source_class IN (${inList})`);
    // Both tables, not just the roster — an unconstrained cycle row would let a
    // `human` cycle record exist with no units, which reads on the page as a
    // class that failed to enumerate rather than one that has no universe.
    const occurrences = migration.split(`source_class IN (${inList})`).length - 1;
    expect(occurrences).toBe(2);

    // ⚠️ And the DRIZZLE MIRROR, which nothing else checks:
    // `scripts/check-schema-drift.sh` compares TABLE NAMES only, so `schema.ts`'s
    // copy of this CHECK can drift from the migration silently — and the mirror
    // is what the next `drizzle-kit generate` reads.
    const schema = readFileSync(join(import.meta.dir, "..", "..", "db", "schema.ts"), "utf8");
    const mirrored = schema.split(`source_class IN (${inList})`).length - 1;
    expect(mirrored).toBe(2);
  });

  it("narrows a wider class value, and refuses everything else", () => {
    expect(surveyableClassOf("chat")).toBe("chat");
    expect(surveyableClassOf("warehouse")).toBe("warehouse");
    expect(surveyableClassOf("human" as EpisodeSourceClass)).toBeNull();
    for (const hostile of ["docs", "Chat", "", "slack", "toString", "__proto__"]) {
      expect(isSurveyableSourceClass(hostile)).toBe(false);
    }
    for (const hostile of [null, undefined, 42, {}, ["chat"]]) {
      expect(isSurveyableSourceClass(hostile)).toBe(false);
    }
  });
});

describe("surveyUnitState — green is evidence, never configuration (ADR-0040 rule 3)", () => {
  const at = new Date("2026-08-01T00:00:00.000Z");

  it("is `surveyed` ONLY with both halves", () => {
    expect(surveyUnitState({ inPerimeter: true, newestEvidenceAt: at })).toBe("surveyed");
  });

  it("is `enumerated` for a perimeter unit with NO evidence — the M1 state", () => {
    // The whole point. A channel the bot was invited to that has produced
    // nothing is configured and empty; reporting it surveyed is exactly what let
    // a four-day outage render green.
    expect(surveyUnitState({ inPerimeter: true, newestEvidenceAt: null })).toBe("enumerated");
  });

  it("is `enumerated` for evidence OUTSIDE the perimeter", () => {
    // An excluded channel keeps the episodes it produced before the exclusion.
    // Evidence alone does not put it back in the perimeter.
    expect(surveyUnitState({ inPerimeter: false, newestEvidenceAt: at })).toBe("enumerated");
  });

  it("is `enumerated` for neither", () => {
    expect(surveyUnitState({ inPerimeter: false, newestEvidenceAt: null })).toBe("enumerated");
  });
});

describe("the map-edge vocabulary", () => {
  it("is closed and non-empty, and every member names its class", () => {
    expect(COVERAGE_DEGRADED_ARMS.length).toBeGreaterThan(0);
    for (const arm of COVERAGE_DEGRADED_ARMS) {
      // A mark the page renders needs to say WHICH class's map has the edge; an
      // arm named only for its cause ("missing-scope") could not. The class must
      // also be one that SHIPS an enumerator — an arm for `email` would be a mark
      // no cycle can ever raise, sitting in the vocabulary looking answered.
      const [prefix] = arm.split("-");
      expect(prefix).toBeOneOf(["chat", "warehouse"]);
    }
  });

  it("has no duplicate members", () => {
    expect(new Set(COVERAGE_DEGRADED_ARMS).size).toBe(COVERAGE_DEGRADED_ARMS.length);
  });
});

describe("the warehouse survey-unit id — injective where a separator is not", () => {
  it("round-trips an ordinary pair", () => {
    expect(parseWarehouseSurveyUnitId(warehouseSurveyUnitId("plans", "status"))).toEqual({
      entity: "plans",
      dimension: "status",
    });
  });

  it("distinguishes the pair a printable separator would collide", () => {
    // `brain_enrollment`'s own trap, one seam over: with a `.` or a space,
    // ("plans.status", "tier") and ("plans", "status.tier") build one key — so a
    // colliding id would report ONE survey unit where the semantic layer has
    // two, and the denominator would be quietly short by one.
    const a = warehouseSurveyUnitId("plans.status", "tier");
    const b = warehouseSurveyUnitId("plans", "status.tier");
    expect(a).not.toBe(b);
    expect(parseWarehouseSurveyUnitId(a)).toEqual({ entity: "plans.status", dimension: "tier" });
    expect(parseWarehouseSurveyUnitId(b)).toEqual({ entity: "plans", dimension: "status.tier" });
  });

  it("round-trips names holding the separator character itself", () => {
    const id = warehouseSurveyUnitId("a:b:c", "d:e");
    expect(parseWarehouseSurveyUnitId(id)).toEqual({ entity: "a:b:c", dimension: "d:e" });
  });

  it("refuses an id whose declared length disagrees with its body", () => {
    // A hand-edited or truncated id must not parse to a SHORTER entity name that
    // happens to look plausible — that would attribute one entity's evidence to
    // another.
    expect(parseWarehouseSurveyUnitId("9:plans:status")).toBeNull();
    expect(parseWarehouseSurveyUnitId("2:plans:status")).toBeNull();
  });

  it("refuses malformed ids rather than inventing halves", () => {
    for (const bad of ["", "plans:status", ":plans:status", "-1:x:y", "5:plans", "0::status"]) {
      expect(parseWarehouseSurveyUnitId(bad)).toBeNull();
    }
  });
});
