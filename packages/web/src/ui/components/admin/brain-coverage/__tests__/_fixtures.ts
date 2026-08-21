import type { BrainCoverage } from "@/ui/lib/types";

/**
 * The Coverage Surface's shared test fixtures (#5215).
 *
 * `coverage-honesty.test.tsx` (the rendered page) and `coverage-statement.test.ts`
 * (the pure composer) were each hand-rolling the same authority envelope and the
 * same five-class availability record. Two copies of a fixture whose shape is
 * pinned by a STRICT schema is two things to keep true, and the divergence shows
 * up as one suite going green against a shape the other has already moved past —
 * the dashboards surface hit this and answered it with
 * `ui/components/dashboards/__tests__/_fixtures.tsx`, which this follows.
 *
 * ## What is NOT consolidated here, and why
 *
 * The API-route suite, the schema suite and the Playwright spec keep their own
 * builders. They live in different packages (`@atlas/api`, `@useatlas/schemas`)
 * or outside the source tree entirely (`e2e/browser`), and reaching across those
 * boundaries for a fixture would put a test-only import edge between packages
 * that otherwise only speak over the wire. The duplication there is the cheaper
 * of the two costs; the duplication HERE was not.
 *
 * ## The fixture is typed, deliberately
 *
 * `BrainCoverage`, not `Record<string, unknown>`. A fixture the compiler cannot
 * check is the "fixtures that agree by construction" hazard ADR-0041's charter
 * names — with the type on, a wire-shape change reddens the fixture rather than
 * letting a suite assert against a shape the server can no longer produce. Tests
 * that need an INVALID payload (a class missing, a stray key) cast at their own
 * call site, where the invalidity is the point.
 */

export const AUTHORITY: BrainCoverage["authority"] = {
  buckets: [],
  workspaceTotals: {
    awaitingReview: 7,
    published: 41,
    retracted: 0,
    provisional: 2,
    inTension: 3,
  },
  // Four visible to this reader against seven in the workspace — the delta IS
  // the hidden-backlog disclosure, so it must not be zero here.
  reviewableAwaitingReview: 4,
  countsConsistent: true,
  distinctAudiences: 0,
  bucketsTruncated: false,
};

/**
 * One class carrying all three ADR-0041 states at once, plus every freshness
 * arm — `#general` current, `#launch` stale with real arithmetic, `#archive`
 * unverified since a real date, `#incidents` enumerated and unsurveyed.
 *
 * Three further units are WITHHELD. Their staleness still shows in the tally,
 * which is what makes withholding a name cost the admin nothing they are
 * entitled to.
 *
 * ⚠️ The evidence dates are deliberately NOT in alphabetical order of label
 * (#archive May, #launch Jul, #general Aug) so the oldest-evidence-first
 * ordering is falsifiable — a fixture that sorted the same way under both rules
 * could not tell them apart.
 */
export function chatArm(): Extract<
  BrainCoverage["availability"]["chat"],
  { state: "enumerated" }
> {
  return {
    state: "enumerated",
    asOf: "2026-08-19T02:00:00.000Z",
    ratio: {
      surveyed: 3,
      enumerated: 4,
      enumerable: 7,
      inPerimeterWithoutEvidence: 1,
      unit: "chat-channel-roster",
    },
    freshness: { current: 1, stale: 1, unverified: 1 },
    units: [
      {
        state: "surveyed",
        unitId: "C0001",
        label: "#general",
        clause: "vendor-public",
        newestEvidenceAt: "2026-08-18T09:00:00.000Z",
        freshness: { kind: "current", checkedAt: "2026-08-19T01:00:00.000Z" },
      },
      {
        state: "surveyed",
        unitId: "C0002",
        label: "#launch",
        clause: "vendor-public",
        newestEvidenceAt: "2026-07-02T09:00:00.000Z",
        freshness: {
          kind: "stale",
          vendorActivityAt: "2026-08-17T12:00:00.000Z",
          newestEvidenceAt: "2026-07-02T09:00:00.000Z",
          lagMs: 4_071_600_000,
          cadenceMs: 3_600_000,
        },
      },
      {
        state: "surveyed",
        unitId: "C0003",
        label: "#archive",
        clause: "deliberate-act",
        newestEvidenceAt: "2026-05-01T09:00:00.000Z",
        freshness: {
          kind: "unverified-since",
          since: "2026-08-12T02:00:00.000Z",
          reason: "not-probed",
        },
      },
      {
        state: "enumerated",
        unitId: "C0004",
        label: "#incidents",
        clause: "vendor-public",
        inPerimeter: false,
      },
    ],
    unitsWithheld: 3,
    unitsTruncated: false,
    // State 3 — the map edge, and the only mark on this page.
    mapEdges: ["chat-public-roster-truncated"],
    unavailable: null,
  };
}

/**
 * A warehouse arm at the shape that produced #5357 — a large enumerated tail
 * over a handful of surveyed pairs, with the response cap engaged.
 *
 * `enumerable` is a PARAMETER because the invariant the suite pins is stated
 * without a number: *no card's default render is proportional to
 * `ratio.enumerable`*. The only way to assert that rather than a hard-coded row
 * count is to render the same arm at two denominators and compare — a test that
 * asserted `toHaveLength(10)` would go green against a render that tracked the
 * denominator and simply happened to sit at ten for this fixture.
 *
 * ⚠️ `unitCount` is separate from `enumerable` on purpose: the server clips the
 * listing at `COVERAGE_UNITS_MAX` and reports it, so a 281-pair workspace ships
 * 200 units and a 2,810-pair one ships the same 200. The card must be bounded
 * against BOTH — the count it states and the rows it was handed.
 */
export function warehouseArm({
  enumerable = 281,
  surveyed = 4,
  unitCount = 200,
}: { enumerable?: number; surveyed?: number; unitCount?: number } = {}): Extract<
  BrainCoverage["availability"]["warehouse"],
  { state: "enumerated" }
> {
  const surveyedUnits = Array.from({ length: Math.min(surveyed, unitCount) }, (_, i) => ({
    state: "surveyed" as const,
    unitId: `${"organization".length}:organization:dim_${String(i).padStart(3, "0")}`,
    label: `organization.dim_${String(i).padStart(3, "0")}`,
    clause: "deliberate-act" as const,
    // Descending ages, so the oldest-evidence-first ordering is falsifiable here
    // too — a preview that re-sorted would show a different first row.
    newestEvidenceAt: `2026-08-${String(18 - i).padStart(2, "0")}T09:00:00.000Z`,
    freshness: {
      kind: "unverified-since" as const,
      since: "2026-08-12T02:00:00.000Z",
      reason: "no-activity-metadata" as const,
    },
  }));
  const enumeratedUnits = Array.from(
    { length: Math.max(0, unitCount - surveyedUnits.length) },
    (_, i) => ({
      state: "enumerated" as const,
      unitId: `${"audit_log".length}:audit_log:col_${String(i).padStart(3, "0")}`,
      label: `audit_log.col_${String(i).padStart(3, "0")}`,
      clause: "deliberate-act" as const,
      inPerimeter: false,
    }),
  );
  return {
    state: "enumerated",
    asOf: "2026-08-19T02:00:00.000Z",
    ratio: {
      surveyed,
      enumerated: enumerable - surveyed,
      enumerable,
      inPerimeterWithoutEvidence: 0,
      unit: "semantic-layer-enrollment",
    },
    freshness: { current: 0, stale: 0, unverified: surveyed },
    units: [...surveyedUnits, ...enumeratedUnits],
    unitsWithheld: 0,
    // The warehouse class cannot withhold — the admin authored the semantic
    // layer, so every unit is namable and clipping is its only absence.
    unitsTruncated: unitCount < enumerable,
    mapEdges: [],
    unavailable: null,
  };
}

/**
 * The whole surface. Per-class overrides are MERGED into the record rather than
 * replacing it — a spread that replaced `availability` wholesale would leave
 * four classes missing, and every assertion would then pass or fail for the
 * totality reason rather than the one it names.
 */
export function coverage(
  overrides: {
    availability?: Partial<BrainCoverage["availability"]>;
    authority?: BrainCoverage["authority"];
    countsConsistent?: boolean;
  } = {},
): BrainCoverage {
  return {
    availability: {
      chat: chatArm(),
      transcript: {
        state: "never-enumerated",
        reason: "no-cycle-recorded",
        lastAttemptAt: null,
        unavailableReason: null,
      },
      email: {
        state: "never-enumerated",
        reason: "no-successful-cycle",
        lastAttemptAt: "2026-08-19T02:00:00.000Z",
        unavailableReason: "Microsoft Graph refused the mailbox listing.",
      },
      warehouse: { state: "cannot-establish", reason: "unresolvable-class" },
      human: { state: "not-surveyable", reason: "non-surveyable-class" },
      ...overrides.availability,
    },
    authority: overrides.authority ?? AUTHORITY,
    countsConsistent: overrides.countsConsistent ?? true,
  };
}
