/**
 * The Coverage Surface's composition (#5214, ADR-0041) — the adversarial suite.
 *
 * ## What this file is defending, and why a friendly suite cannot
 *
 * Every failure this module can have is in the FLATTERING direction. A dropped
 * roster row shrinks a denominator, which RAISES a ratio. A lost map edge makes
 * the map read complete. A missing snapshot read as zero says "nothing to see"
 * about a class nobody has looked at. None of them throws, none of them looks
 * wrong on the page, and the page's whole product is a statement an admin will
 * repeat out loud.
 *
 * So ADR-0041 writes the fixtures a charter rather than leaving them to taste:
 *
 *   > Adversarial fixtures by charter: test vendor rosters are authored
 *   > independently of the snapshots the page reads, and the named mutations
 *   > each redden a specific assertion … A fixture where roster and snapshot
 *   > come from one literal cannot falsify.
 *
 * This file obeys it structurally. {@link SLACK_WORKSPACE} and
 * {@link MAILBOXES} are the VENDOR's truth, authored as literals — what really
 * exists, and when each unit really last moved. {@link OBSERVED} is the ATLAS
 * side, authored SEPARATELY — what Atlas actually holds evidence for and how
 * recent it is. Nothing derives one from the other, which is what makes
 * "backdate an observation" and "plant vendor activity newer than our evidence"
 * two different mutations rather than two spellings of one.
 *
 * The stored rows the page reads are built from both by {@link chatRoster} and
 * friends — that derivation is Atlas's enumerator, modelled — and every named
 * mutation below breaks the derivation on purpose and names the assertion that
 * must redden.
 *
 * ## Why the logger is mocked here rather than in a sibling file
 *
 * `class-contract-logging.test.ts` splits loudness into its own file because the
 * module under test has a fail-closed RETURN VALUE a behavioural suite can
 * check. Here the two are the same claim: an under-report that is silent and an
 * under-report that is announced are the same numbers on the page, and only the
 * `warn` and `countsConsistent` distinguish them. Asserting the numbers without
 * the loudness would pass on precisely the defect this module exists to prevent.
 *
 * ## MUTATIONS THIS CATCHES
 *
 * **GENERATED — see `packages/api/scripts/mutations/coverage-composition.md`**,
 * from `scripts/mutations/coverage-composition.mutations.ts`:
 *
 *     cd packages/api && bun run scripts/mutate.ts scripts/mutations/coverage-composition.mutations.ts
 *
 * ⚠️ Two rows there are worth reading before adding to this file, because both
 * measured **0** first time and both fixes were OUTSIDE this file:
 *
 *   - *green is read off the evidence date alone* — a second
 *     `evidenceAt !== null` at the use site absorbed the mutation, so the rule
 *     the module header calls load-bearing had a test that could not see it
 *     removed. The derivation became single-point and {@link SLACK_WORKSPACE}
 *     gained `#departed`; it now measures 7.
 *   - *the aggregate and the roster tally are no longer compared* — the anchor
 *     disabled ONE of three `||` arms, so the other two kept the cross-check
 *     alive and the row read 0 for a guarantee that was in fact held. A
 *     mutation that under-mutates publishes a number about a change nobody
 *     made, which `mutate.ts`'s own header calls the worse failure.
 */

import { beforeEach, describe, expect, test, mock } from "bun:test";

type LogCall = { level: "error" | "warn" | "info" | "debug"; payload: unknown; message: string };
const logCalls: LogCall[] = [];

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    error: (payload: unknown, message: string) =>
      logCalls.push({ level: "error", payload, message }),
    warn: (payload: unknown, message: string) => logCalls.push({ level: "warn", payload, message }),
    info: (payload: unknown, message: string) => logCalls.push({ level: "info", payload, message }),
    debug: (payload: unknown, message: string) =>
      logCalls.push({ level: "debug", payload, message }),
  }),
  getLogger: () => ({
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
    level: "info",
  }),
  setLogLevel: () => true,
  getRequestContext: () => undefined,
  ACTOR_KINDS: ["human", "agent", "mcp", "scheduler", "api_key"] as const,
  withRequestContext: <T,>(_ctx: unknown, fn: () => T): T => fn(),
  redactPaths: [] as string[],
  scrubErrSerializer: (value: unknown) => value,
  scrubLogFormatter: (obj: unknown) => obj,
  hashShareToken: (token: string) => token,
}));

const { COVERAGE_UNITS_MAX, CoverageCompositionError, composeCoverage } = await import(
  "@atlas/api/lib/brain/coverage"
);
const { coverageLabelPolicy } = await import("@atlas/api/lib/brain/class-contract");
const { EPISODE_SOURCE_CLASSES } = await import("@atlas/api/lib/brain/sources");
type CoverageClassSnapshot = import("@atlas/api/lib/brain/coverage-enumeration").CoverageClassSnapshot;
type CoverageUnitRow = import("@atlas/api/lib/brain/coverage-enumeration").CoverageUnitRow;
type SurveyableSourceClass =
  import("@atlas/api/lib/brain/coverage-enumeration").SurveyableSourceClass;
type BrainCoverage = import("@useatlas/types").BrainCoverage;
type BrainCoverageClass = import("@useatlas/types").BrainCoverageClass;
type BrainCoverageClassAvailable = import("@useatlas/types").BrainCoverageClassAvailable;
type BrainFactOversight = import("@useatlas/types").BrainFactOversight;

// ---------------------------------------------------------------------------
// The VENDOR's truth — one side of the charter
// ---------------------------------------------------------------------------

const WORKSPACE = "ws_5214";
const REQUEST = "req_5214";
const DAY_MS = 24 * 60 * 60_000;

/** The cycle that produced the rosters below. Every class's "as of". */
const CYCLE_AT = "2026-08-17T12:00:00.000Z";

/**
 * When the page is being rendered — ten minutes after the cycle.
 *
 * An explicit instant rather than `Date.now()`, and required by
 * `composeCoverage` for that reason: a `current` verdict rests on a vendor
 * reading taken in the past, so the reading's own age is part of the verdict,
 * and with a hidden clock "the reading expired" is a case a test could only
 * reach by waiting.
 */
const NOW = new Date("2026-08-17T12:10:00.000Z");

/**
 * What Slack really holds — authored here and read by nothing that also decides
 * what Atlas observed.
 *
 * `lastMessageAt` is the VENDOR's activity metadata, not ours. That separation
 * is the charter: with one field serving both sides, "the source moved" and "we
 * saw it" would be the same fact and no lag could ever be measured.
 */
interface VendorChannel {
  readonly id: string;
  readonly name: string;
  readonly isPublic: boolean;
  /** A deliberate act — somebody invited the bot, which is what puts it in scope. */
  readonly botIsMember: boolean;
  readonly lastMessageAt: string | null;
}

const SLACK_WORKSPACE: readonly VendorChannel[] = [
  {
    id: "C_GENERAL",
    name: "#general",
    isPublic: true,
    botIsMember: true,
    lastMessageAt: "2026-08-17T09:00:00.000Z",
  },
  {
    // ADR-0041's own example of the state-2 display: exists, unsurveyed, and
    // namable ONLY because Slack calls a public channel's name workspace-public.
    id: "C_INCIDENTS",
    name: "#incidents",
    isPublic: true,
    botIsMember: false,
    lastMessageAt: "2026-08-17T10:00:00.000Z",
  },
  {
    // Private AND namable — under the OTHER clause. Somebody invited the bot,
    // and a deliberate act discloses nothing the admin did not do themselves.
    id: "C_LEADERSHIP",
    name: "#leadership",
    isPublic: false,
    botIsMember: true,
    lastMessageAt: "2026-08-16T12:00:00.000Z",
  },
  {
    // The channel the bot was REMOVED from. It is out of the perimeter now, and
    // Atlas still holds everything it read while it was in — so the stored row
    // carries a real `newest_evidence_at` on a unit that is state 2. Authored
    // because the rule it exercises has a converse a reader forgets: green is
    // evidence, AND evidence is not green.
    id: "C_DEPARTED",
    name: "#departed",
    isPublic: true,
    botIsMember: false,
    lastMessageAt: "2026-08-17T07:00:00.000Z",
  },
  {
    // The QUIET channel. Nothing has been said in it since 2024 and the vendor
    // confirms it: `lastMessageAt` is null because there is no message to point
    // at. ADR-0041 calls this current, not stale.
    id: "C_ARCHIVE",
    name: "#archive-2019",
    isPublic: true,
    botIsMember: true,
    lastMessageAt: null,
  },
];

/** What the mail vendor really holds. Counted always, named never. */
interface VendorMailbox {
  readonly address: string;
  readonly inPerimeter: boolean;
  readonly lastMessageAt: string | null;
}

const MAILBOXES: readonly VendorMailbox[] = [
  { address: "ceo@acme.example", inPerimeter: true, lastMessageAt: "2026-08-17T10:00:00.000Z" },
  { address: "support@acme.example", inPerimeter: true, lastMessageAt: "2026-08-15T10:00:00.000Z" },
  { address: "legal@acme.example", inPerimeter: false, lastMessageAt: "2026-08-17T11:00:00.000Z" },
];

// ---------------------------------------------------------------------------
// The ATLAS side — the other side of the charter
// ---------------------------------------------------------------------------

/**
 * Our newest observed evidence per unit, authored INDEPENDENTLY of the vendor
 * literals above.
 *
 * Read the pairs against them: `#general` is half an hour behind Slack (a normal
 * sync), `#leadership` is an hour behind, `#archive-2019` is two years behind a
 * vendor that reports nothing moved (quiet, not stale), and `support@` is five
 * days behind a mailbox that moved two days ago — the one genuinely stale unit
 * in the healthy fixture, and a WITHHELD one, so its staleness can only reach
 * the admin as a count.
 */
const OBSERVED: ReadonlyMap<string, string> = new Map([
  ["C_GENERAL", "2026-08-17T08:30:00.000Z"],
  ["C_LEADERSHIP", "2026-08-16T11:00:00.000Z"],
  ["C_ARCHIVE", "2024-02-02T00:00:00.000Z"],
  // Read while the bot was still a member — see `C_DEPARTED` above.
  ["C_DEPARTED", "2026-07-01T00:00:00.000Z"],
  ["ceo@acme.example", "2026-08-17T09:30:00.000Z"],
  ["support@acme.example", "2026-08-10T10:00:00.000Z"],
  ["wh:orders/status", "2026-08-17T06:00:00.000Z"],
]);

/** A human enrolled these (entity, dimension) pairs — ADR-0039's deliberate act. */
const ENROLLED: readonly string[] = ["wh:orders/status", "wh:customers/tier"];

// ---------------------------------------------------------------------------
// Atlas's enumerator, modelled — the derivation the mutations break
// ---------------------------------------------------------------------------

interface RosterOptions {
  /** Unit ids the cycle did not probe this time — the bounded rotation. */
  readonly unprobed?: ReadonlySet<string>;
  /** Override the vendor's activity reading for one unit — "plant activity". */
  readonly plantActivity?: ReadonlyMap<string, string>;
  /** Override our own observation for one unit — "backdate an observation". */
  readonly backdate?: ReadonlyMap<string, string>;
  /** Unit ids the enumerator dropped — "remove an enumerated unit". */
  readonly drop?: ReadonlySet<string>;
  /** Store a label the current policy would refuse — the stale-disclosure case. */
  readonly forceLabel?: ReadonlySet<string>;
  /**
   * Override WHEN a unit was last probed — the rotation having fallen behind.
   *
   * A separate lever from {@link unprobed}, and the separation is the point: a
   * unit that has never been asked about and one whose answer has gone out of
   * date are different sentences, and only one of them means the rotation is
   * working.
   */
  readonly probedAt?: ReadonlyMap<string, string>;
}

function storedRow(params: {
  readonly cls: SurveyableSourceClass;
  readonly unitId: string;
  readonly label: string;
  readonly deliberateAct: boolean;
  /**
   * Deliberately NOT the same field as {@link deliberateAct}.
   *
   * `EnumeratedSurveyUnit` says they are "usually but NOT always equal", and
   * `email` is the class where they come apart: the install grants access to
   * every mailbox wholesale, so a mailbox is inside the perimeter with no
   * deliberate act naming it — which is exactly why it is counted and never
   * named. Collapsing the two here would have made that case unrepresentable
   * and quietly moved every mailbox out of the surveyed half.
   */
  readonly inPerimeter: boolean;
  readonly vendorReportsPublic: boolean;
  readonly vendorActivityAt: string | null;
  readonly probed: boolean;
  readonly probedAt: string;
  readonly observedAt: string | null;
  readonly forceLabel: boolean;
}): CoverageUnitRow {
  const disclosure = {
    deliberateAct: params.deliberateAct,
    vendorReportsPublic: params.vendorReportsPublic,
  };
  // The WRITE-time decision, made with the real policy because the write path
  // makes it with the real policy. What is deliberately NOT derived from it is
  // the read-time answer: the module under test runs the policy again over
  // `disclosure`, and `forceLabel` exists to drive them apart.
  const written = coverageLabelPolicy(params.cls, disclosure);
  const inPerimeter = params.inPerimeter;
  return {
    unitId: params.unitId,
    state: inPerimeter && params.observedAt !== null ? "surveyed" : "enumerated",
    inPerimeter,
    label: params.forceLabel || written.policy === "name" ? params.label : null,
    disclosure,
    newestEvidenceAt: params.observedAt,
    activity: params.probed
      ? { probed: true, at: params.vendorActivityAt, checkedAt: params.probedAt }
      : { probed: false },
  };
}

function chatRoster(opts: RosterOptions = {}): readonly CoverageUnitRow[] {
  return SLACK_WORKSPACE.filter((c) => !opts.drop?.has(c.id)).map((c) =>
    storedRow({
      cls: "chat",
      unitId: c.id,
      label: c.name,
      // For chat the two coincide: inviting the bot is BOTH what puts the
      // channel in scope and the deliberate act that makes it nameable.
      deliberateAct: c.botIsMember,
      inPerimeter: c.botIsMember,
      vendorReportsPublic: c.isPublic,
      vendorActivityAt: opts.plantActivity?.get(c.id) ?? c.lastMessageAt,
      probed: !opts.unprobed?.has(c.id),
      probedAt: opts.probedAt?.get(c.id) ?? CYCLE_AT,
      observedAt: opts.backdate?.get(c.id) ?? OBSERVED.get(c.id) ?? null,
      forceLabel: opts.forceLabel?.has(c.id) ?? false,
    }),
  );
}

function emailRoster(opts: RosterOptions = {}): readonly CoverageUnitRow[] {
  return MAILBOXES.filter((m) => !opts.drop?.has(m.address)).map((m) =>
    storedRow({
      cls: "email",
      unitId: m.address,
      label: m.address,
      // No mailbox is ever a deliberate act in this fixture, and that is the
      // point: `email` declares `vendorPublic: false`, so neither clause fires
      // and every mailbox is counted and never named.
      deliberateAct: false,
      inPerimeter: m.inPerimeter,
      vendorReportsPublic: false,
      vendorActivityAt: opts.plantActivity?.get(m.address) ?? m.lastMessageAt,
      probed: !opts.unprobed?.has(m.address),
      probedAt: opts.probedAt?.get(m.address) ?? CYCLE_AT,
      observedAt: opts.backdate?.get(m.address) ?? OBSERVED.get(m.address) ?? null,
      forceLabel: opts.forceLabel?.has(m.address) ?? false,
    }),
  );
}

function warehouseRoster(opts: RosterOptions = {}): readonly CoverageUnitRow[] {
  return ENROLLED.filter((id) => !opts.drop?.has(id)).map((id) =>
    storedRow({
      cls: "warehouse",
      unitId: id,
      label: id,
      // Enrollment IS the deliberate act (ADR-0039), which is why warehouse
      // units are namable while `vendorPublic` stays false.
      deliberateAct: true,
      inPerimeter: true,
      vendorReportsPublic: false,
      // The class declares `activityMetadata: absent`, so no probe exists. The
      // row still carries the tri-state, unprobed.
      vendorActivityAt: null,
      probed: false,
      probedAt: CYCLE_AT,
      observedAt: opts.backdate?.get(id) ?? OBSERVED.get(id) ?? null,
      forceLabel: opts.forceLabel?.has(id) ?? false,
    }),
  );
}

/**
 * The cycle row, with counts derived from the rows the SAME call produced.
 *
 * Passing a different roster to {@link cycleRow} than to the composition is how
 * "remove an enumerated unit" becomes visible: the aggregate is one statement
 * and the rows are another, and the module reports when they disagree.
 */
function cycleRow(
  cls: SurveyableSourceClass,
  rows: readonly CoverageUnitRow[],
  overrides: Partial<CoverageClassSnapshot> = {},
): CoverageClassSnapshot {
  const surveyed = rows.filter((r) => r.state === "surveyed").length;
  return {
    sourceClass: cls,
    surveyed,
    enumerated: rows.length - surveyed,
    inPerimeterWithoutEvidence: rows.filter((r) => r.state !== "surveyed" && r.inPerimeter).length,
    asOf: CYCLE_AT,
    lastAttemptAt: CYCLE_AT,
    unavailableReason: null,
    degraded: [],
    degradedIncomplete: false,
    ...overrides,
  };
}

/** A minimal authority arm — this file asserts nothing about oversight's own shape. */
const AUTHORITY: BrainFactOversight = {
  buckets: [],
  workspaceTotals: {
    awaitingReview: 3,
    published: 40,
    retracted: 1,
    provisional: 0,
    inTension: 0,
  },
  reviewableAwaitingReview: 2,
  countsConsistent: true,
  distinctAudiences: 0,
  bucketsTruncated: false,
};

interface WorldOptions extends RosterOptions {
  /** Cycle-row overrides, per class — the "sicken a pipe" lever. */
  readonly cycles?: Partial<Record<SurveyableSourceClass, Partial<CoverageClassSnapshot>>>;
  /** Aggregate counts computed BEFORE a roster mutation — the understatement lever. */
  readonly aggregateFrom?: RosterOptions;
  readonly authority?: BrainFactOversight;
}

/**
 * The whole workspace, healthy unless a lever says otherwise.
 *
 * `transcript` deliberately has NO cycle row: a class nothing has ever
 * enumerated is a state the page must be able to say, and it is the one the
 * flat-record shape #5213 shipped could not distinguish from a complete map.
 */
function world(opts: WorldOptions = {}): BrainCoverage {
  const chat = chatRoster(opts);
  const email = emailRoster(opts);
  const warehouse = warehouseRoster(opts);
  // The aggregate is computed off a possibly DIFFERENT enumeration than the rows
  // — that is the whole mechanism of the understatement mutation.
  const aggregateOpts = opts.aggregateFrom ?? opts;
  return composeCoverage({
    workspaceId: WORKSPACE,
    requestId: REQUEST,
    at: NOW,
    authority: opts.authority ?? AUTHORITY,
    snapshots: [
      cycleRow("chat", chatRoster(aggregateOpts), opts.cycles?.chat),
      cycleRow("email", emailRoster(aggregateOpts), opts.cycles?.email),
      cycleRow("warehouse", warehouseRoster(aggregateOpts), opts.cycles?.warehouse),
    ],
    rosters: new Map<SurveyableSourceClass, readonly CoverageUnitRow[]>([
      ["chat", chat],
      ["email", email],
      ["warehouse", warehouse],
    ]),
  });
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

function available(result: BrainCoverage, cls: "chat" | "email" | "warehouse"): BrainCoverageClassAvailable {
  const arm = result.availability[cls];
  if (arm.state !== "enumerated") {
    throw new Error(`expected ${cls} to be enumerated, got ${arm.state}`);
  }
  return arm;
}

function unit(arm: BrainCoverageClassAvailable, unitId: string) {
  const found = arm.units.find((u) => u.unitId === unitId);
  if (!found) throw new Error(`no named unit ${unitId} — it may have been withheld`);
  return found;
}

function warns(pattern: RegExp): readonly LogCall[] {
  return logCalls.filter((c) => c.level !== "info" && c.level !== "debug" && pattern.test(c.message));
}

beforeEach(() => {
  logCalls.length = 0;
});

// ---------------------------------------------------------------------------

describe("the wire shape is keyed on the class axis — a class cannot go missing", () => {
  test("every class has an arm, always", () => {
    const result = world();
    expect(Object.keys(result.availability).toSorted()).toEqual([...EPISODE_SOURCE_CLASSES].toSorted());
  });

  test("`human` is a DECLARED refusal, not an absence and not a zero", () => {
    // ADR-0041 never assigns `human` a denominator: its units would be people.
    // The arm exists so the page can leave it out of every ratio ON PURPOSE —
    // which an absent key would render as an unfinished class.
    const arm = result_human();
    expect(arm).toEqual({ state: "not-surveyable", reason: "non-surveyable-class" });
    // …and the refusal is structural: there is nowhere on this arm for a count.
    expect("ratio" in arm).toBe(false);
    expect("units" in arm).toBe(false);
  });

  test("a class with NO cycle row says so, and carries no counts", () => {
    // The residue #5213 handed this page: `CoverageClassSnapshot` is flat, so
    // `degraded: []` on a never-enumerated class reads as "the map is complete".
    // The union is the fix — this arm has no `mapEdges` field to read as empty
    // and no ratio to read as zero.
    const arm = world().availability.transcript;
    expect(arm).toEqual({
      state: "never-enumerated",
      reason: "no-cycle-recorded",
      lastAttemptAt: null,
      unavailableReason: null,
    });
    expect("mapEdges" in arm).toBe(false);
    expect("ratio" in arm).toBe(false);
    expect("asOf" in arm).toBe(false);
  });

  test("a class that has TRIED and never succeeded is a different sentence", () => {
    const result = world({
      cycles: {
        chat: {
          asOf: null,
          lastAttemptAt: "2026-08-17T11:00:00.000Z",
          unavailableReason: "Slack returned missing_scope for channels:read — reinstall with the scope granted.",
        },
      },
    });
    const arm = result.availability.chat;
    expect(arm.state).toBe("never-enumerated");
    if (arm.state !== "never-enumerated") throw new Error("unreachable");
    expect(arm.reason).toBe("no-successful-cycle");
    expect(arm.lastAttemptAt).toBe("2026-08-17T11:00:00.000Z");
    expect(arm.unavailableReason).toContain("missing_scope");
    // ⚠️ The counts the cycle row still carried are NOT on the wire. A class
    // that has never succeeded has nothing measured, and `surveyed: 0` beside a
    // date would be a measurement of an empty roster nobody established.
    expect("ratio" in arm).toBe(false);
  });

  test("the available arm's `asOf` is non-null BY TYPE, so an empty roster is a measured empty", () => {
    const arm = available(world(), "chat");
    expect(typeof arm.asOf).toBe("string");
    expect(arm.asOf).toBe(CYCLE_AT);
  });
});

function result_human(): BrainCoverageClass {
  return world().availability.human;
}

describe("ratios exist only per unit — there is nowhere to put a blended number", () => {
  test("every ratio names the ONE unit it is counted in, and no two classes share one", () => {
    const result = world();
    const units = (["chat", "email", "warehouse"] as const).map((c) => available(result, c).ratio.unit);
    expect(units).toEqual(["chat-channel-roster", "mailbox-list", "semantic-layer-enrollment"]);
    // The refusal made structural: adding two of these means adding quantities
    // whose `unit` differs, which is visible at the call site rather than in a
    // comment somebody has to have read.
    expect(new Set(units).size).toBe(units.length);
  });

  test("the denominator is the two states together, and it is CARRIED not inferred", () => {
    const chat = available(world(), "chat");
    // 5 channels: 3 the bot is in WITH evidence (surveyed), and 2 enumerated —
    // one it was never in and one it was removed from.
    expect(chat.ratio).toEqual({
      surveyed: 3,
      enumerated: 2,
      enumerable: 5,
      inPerimeterWithoutEvidence: 0,
      unit: "chat-channel-roster",
    });
    expect(chat.ratio.enumerable).toBe(chat.ratio.surveyed + chat.ratio.enumerated);
  });

  test("NO number anywhere in the response is a percentage, a score, or a blend", () => {
    // A structural sweep rather than a review note. Every numeric leaf in the
    // whole payload is collected and its FIELD NAME checked against a pinned
    // set — so a `coveragePercent`, a `score`, or an `overall` added anywhere in
    // the shape reddens here, including on an arm this file never reads.
    //
    // ADR-0041 says the pressure will arrive ("a dashboard ring, a marketing
    // number, or 'just an approximate blend'"). This is the assertion it has to
    // get past.
    const numericFields = new Set<string>();
    const walk = (node: unknown, key: string): void => {
      if (typeof node === "number") numericFields.add(key);
      else if (Array.isArray(node)) node.forEach((v) => walk(v, key));
      else if (node !== null && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) walk(v, k);
      }
    };
    // Walked over MORE THAN the healthy world, because the arms that carry the
    // most numbers are the unhealthy ones: the stale verdict's arithmetic only
    // exists on a stale unit, and a withheld stale unit contributes a tally
    // entry and no object. A sweep over the happy path alone would leave the
    // `stale` arm — the one a dashboard number would be grafted onto — unswept.
    for (const w of [
      world(),
      world({ backdate: new Map([["C_GENERAL", "2026-08-14T09:00:00.000Z"]]) }),
      world({ cycles: { chat: { unavailableReason: "ratelimited" } } }),
      world({ unprobed: new Set(["C_GENERAL"]) }),
    ]) {
      walk(w, "$root");
    }
    expect([...numericFields].toSorted()).toEqual([
      // The authority arm's counters, unchanged from `/oversight`.
      "awaitingReview",
      "cadenceMs",
      "current",
      "distinctAudiences",
      "enumerable",
      "enumerated",
      "inPerimeterWithoutEvidence",
      "inTension",
      "lagMs",
      "provisional",
      "published",
      "retracted",
      "reviewableAwaitingReview",
      "stale",
      "surveyed",
      "unitsWithheld",
      "unverified",
    ]);
  });
});

describe("labels obey the two clauses, re-derived at READ time", () => {
  test("a public channel is named under the VENDOR-PUBLIC clause", () => {
    // ADR-0041's own example of the useful state-2 display: "#incidents exists
    // and is unsurveyed" names a channel no deliberate act ever touched, and it
    // is admissible only because Slack calls a public channel's name visible to
    // every member of the workspace.
    const named = unit(available(world(), "chat"), "C_INCIDENTS");
    expect(named.label).toBe("#incidents");
    expect(named.clause).toBe("vendor-public");
    expect(named.state).toBe("enumerated");
  });

  test("a PRIVATE channel the bot was invited to is named under the DELIBERATE-ACT clause", () => {
    // The clause that does not depend on any vendor's notion of "public", and
    // the one whose justification survives the vendor changing it. Carried on
    // the wire rather than collapsed to a boolean precisely so this case is
    // distinguishable from the one above.
    const named = unit(available(world(), "chat"), "C_LEADERSHIP");
    expect(named.clause).toBe("deliberate-act");
  });

  test("mailboxes are COUNTED and never named — the whole roster, every time", () => {
    const email = available(world(), "email");
    expect(email.units).toEqual([]);
    expect(email.unitsWithheld).toBe(MAILBOXES.length);
    // The count is the disclosure, and it is exact: "N mailboxes enumerated, M
    // surveyed" with no list, which is ADR-0041's spelling of this class's
    // state-2 display.
    expect(email.ratio.enumerable).toBe(MAILBOXES.length);
    expect(email.ratio.surveyed).toBe(2);
    // Nothing anywhere in the payload carries an address.
    expect(JSON.stringify(world())).not.toContain("@acme.example");
  });

  test("warehouse entities ARE named — by the other clause, not by `vendorPublic`", () => {
    // `warehouse` declares `vendorPublic: false` and its units are still named,
    // because a human enrolled them. Pinning the CLAUSE rather than a boolean is
    // what makes this case distinguishable from a `vendorPublic` that drifted
    // open.
    const wh = available(world(), "warehouse");
    expect(wh.units.map((u) => [u.label, u.clause])).toEqual([
      ["wh:orders/status", "deliberate-act"],
      ["wh:customers/tier", "deliberate-act"],
    ]);
  });

  test("a STORED label no clause still admits is withheld at read time, and loudly", () => {
    // The write path applied the policy before the insert. If the CONTRACT
    // changed since — a class argued shut on `vendorPublic` — the row is a
    // disclosure sitting at rest that the current policy refuses, and it stays
    // there until the next cycle rewrites it. Trusting the stored NULL would
    // make the contract's closing date the date the last cycle ran.
    const result = world({
      forceLabel: new Set(["ceo@acme.example", "support@acme.example"]),
    });
    const email = available(result, "email");
    expect(email.units).toEqual([]);
    expect(email.unitsWithheld).toBe(MAILBOXES.length);
    expect(JSON.stringify(result)).not.toContain("@acme.example");
  });

  test("…and the refusals are reported ONCE per class, with a count", () => {
    // Volume bounded by the FAULT, not by unit count. The trigger is a
    // contract-wide change, so a per-row line is thousands of identical warns
    // per request on a large roster — which buries the `workspaceId` the line
    // exists to carry. `coverageLabelPolicy` makes the same choice one seam over.
    world({ forceLabel: new Set(["ceo@acme.example", "support@acme.example"]) });
    const found = warns(/stored unit labels are no longer admitted/);
    expect(found).toHaveLength(1);
    expect(found[0]?.payload).toMatchObject({
      workspaceId: WORKSPACE,
      requestId: REQUEST,
      sourceClass: "email",
      units: 2,
    });
  });

  test("the withheld units' STALENESS still reaches the admin — as a count", () => {
    // Why withholding a mailbox's name costs the admin nothing they are entitled
    // to. `support@` is five days behind a mailbox that moved two days ago; the
    // name is refused and the fact is not.
    const email = available(world(), "email");
    expect(email.freshness).toEqual({ current: 1, stale: 1, unverified: 0 });
    expect(email.units).toEqual([]);
  });
});

describe("stale is a measured lag; quiet is not stale; unverified is not stale", () => {
  test("a source that has not moved is CURRENT, however old its newest evidence", () => {
    // `#archive-2019`: our newest evidence is from 2024 and the vendor reports
    // no activity at all. ADR-0041: "Quiet ≠ stale". The implementation this
    // guards against is the reasonable one — treating a NULL vendor reading as
    // "missing" rather than as the answer it is.
    const arm = available(world(), "chat");
    const archive = unit(arm, "C_ARCHIVE");
    if (archive.state !== "surveyed") throw new Error("unreachable");
    expect(archive.freshness).toEqual({ kind: "current", checkedAt: CYCLE_AT });
    expect(archive.newestEvidenceAt).toBe("2024-02-02T00:00:00.000Z");
  });

  test("evidence WITHOUT the perimeter is not green — and carries no freshness at all", () => {
    // `#departed`: the bot was removed, and Atlas still holds what it read while
    // it was in. Counting the surviving date as green would leave the unit
    // permanently surveyed on a source nobody can read any more — and it would
    // then carry a freshness verdict about a source Atlas is not reading.
    const chat = available(world(), "chat");
    const departed = unit(chat, "C_DEPARTED");
    expect(departed.state).toBe("enumerated");
    // Structural, not a null: the enumerated arm has no `freshness` field, so
    // there is nowhere for a verdict about an unread source to be written.
    expect("freshness" in departed).toBe(false);
    expect("newestEvidenceAt" in departed).toBe(false);
    expect(chat.freshness.current + chat.freshness.stale + chat.freshness.unverified).toBe(3);
  });

  test("a normal sync lag is current — the cadence is a band, not a deadline", () => {
    const general = unit(available(world(), "chat"), "C_GENERAL");
    if (general.state !== "surveyed") throw new Error("unreachable");
    expect(general.freshness).toEqual({ kind: "current", checkedAt: CYCLE_AT });
  });

  test("a class with no activity metadata NEVER says stale — it says unverified since", () => {
    // `warehouse` declares `activityMetadata: absent`, and ADR-0041 makes that a
    // sentence rather than a silence: without this arm those units would simply
    // never appear stale, which reads as an all-clear.
    const wh = available(world(), "warehouse");
    const enrolled = wh.units[0];
    if (enrolled?.state !== "surveyed") throw new Error("unreachable");
    expect(enrolled.freshness).toEqual({
      kind: "unverified-since",
      since: CYCLE_AT,
      reason: "no-activity-metadata",
    });
    expect(wh.freshness).toEqual({ current: 0, stale: 0, unverified: 1 });
  });

  test("a unit the rotation has not reached is unverified, NOT current", () => {
    // The probe rotation is bounded, so most units are unprobed on most cycles.
    // Expected — and emphatically not an all-clear about a source nobody asked
    // about, which is what a `probed: false` collapsed to "no activity" would be.
    const chat = available(world({ unprobed: new Set(["C_GENERAL"]) }), "chat");
    const general = unit(chat, "C_GENERAL");
    if (general.state !== "surveyed") throw new Error("unreachable");
    expect(general.freshness).toEqual({
      kind: "unverified-since",
      since: CYCLE_AT,
      reason: "not-probed",
    });
  });

  test("a reading OLDER than the cadence stops licensing `current`", () => {
    // ⚠️ The arm that stops "current" resting on a reading of unbounded age, and
    // the rotation makes that age real rather than theoretical:
    // `CHAT_ACTIVITY_PROBES_PER_CYCLE` is 20 per hourly cycle and the upsert
    // carries an unprobed unit's previous reading forward, so a large workspace
    // re-probes each unit every several days. Without this, a ten-day-old vendor
    // answer would be compared against a 24-hour threshold and reported as a
    // confident present-tense all-clear.
    const behind = world({
      probedAt: new Map([["C_GENERAL", "2026-08-07T12:00:00.000Z"]]),
    });
    const general = unit(available(behind, "chat"), "C_GENERAL");
    if (general.state !== "surveyed") throw new Error("unreachable");
    expect(general.freshness).toEqual({
      kind: "unverified-since",
      // The READING's own date, not the cycle's — the stronger statement, and
      // the one the probe rotation can act on.
      since: "2026-08-07T12:00:00.000Z",
      reason: "reading-expired",
    });
  });

  test("…and it is NOT called stale, because nothing measured a lag", () => {
    // The same unit, with the vendor claiming movement we would otherwise call
    // stale. We did not look recently enough to know either way, and ADR-0041
    // refuses the guess in both directions.
    const behind = world({
      probedAt: new Map([["C_GENERAL", "2026-08-07T12:00:00.000Z"]]),
      backdate: new Map([["C_GENERAL", "2026-08-01T09:00:00.000Z"]]),
    });
    const general = unit(available(behind, "chat"), "C_GENERAL");
    if (general.state !== "surveyed") throw new Error("unreachable");
    expect(general.freshness.kind).toBe("unverified-since");
  });

  test("a reading INSIDE the cadence still licenses it, and says when we asked", () => {
    // `current` carries its own date for the reason `stale` carries its
    // arithmetic: the flattering arm must not be the only opaque one.
    const general = unit(available(world(), "chat"), "C_GENERAL");
    if (general.state !== "surveyed" || general.freshness.kind !== "current") {
      throw new Error("unreachable");
    }
    expect(general.freshness.checkedAt).toBe(CYCLE_AT);
  });

  test("an expired reading is a DIFFERENT sentence from a never-probed one", () => {
    // Both refuse `current` and neither claims movement, but only one of them
    // means the rotation is working. Collapsing them would make a rotation that
    // has fallen days behind indistinguishable from one doing its job.
    const never = unit(available(world({ unprobed: new Set(["C_GENERAL"]) }), "chat"), "C_GENERAL");
    const expired = unit(
      available(world({ probedAt: new Map([["C_GENERAL", "2026-08-07T12:00:00.000Z"]]) }), "chat"),
      "C_GENERAL",
    );
    if (never.state !== "surveyed" || expired.state !== "surveyed") throw new Error("unreachable");
    expect(never.freshness).not.toEqual(expired.freshness);
  });

  test("the freshness tally sums to the surveyed count, for every class", () => {
    // The identity that makes the withheld units' freshness trustworthy: the
    // tally is over EVERY surveyed unit, named or not.
    const result = world();
    for (const cls of ["chat", "email", "warehouse"] as const) {
      const arm = available(result, cls);
      const { current, stale, unverified } = arm.freshness;
      expect([cls, current + stale + unverified]).toEqual([cls, arm.ratio.surveyed]);
    }
    expect(result.countsConsistent).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The four named mutations — ADR-0041's fixture charter, one describe each
// ---------------------------------------------------------------------------

describe("MUTATION 1 — remove an enumerated unit (the understatement must be LOUD)", () => {
  /**
   * The enumerator drops `#incidents` while the cycle aggregate still counts it.
   *
   * This is the flattering failure in its purest form: the denominator shrinks
   * from 4 to 3 and the numerator is untouched, so the ratio RISES from 3/4 to
   * 3/3 — the page reports full coverage of a workspace that just lost a
   * channel. Nothing throws and no number looks wrong.
   */
  const mutated = (): BrainCoverage =>
    world({ drop: new Set(["C_INCIDENTS"]), aggregateFrom: {} });

  test("the ratio really does move in the flattering direction", () => {
    expect(available(world(), "chat").ratio.enumerable).toBe(5);
    expect(available(mutated(), "chat").ratio.enumerable).toBe(4);
  });

  test("…and the response says its arithmetic cannot be trusted", () => {
    expect(world().countsConsistent).toBe(true);
    expect(mutated().countsConsistent).toBe(false);
  });

  test("…and an operator gets a line naming both readings", () => {
    mutated();
    const found = warns(/aggregate and the roster rows disagree/);
    expect(found).toHaveLength(1);
    expect(found[0]?.payload).toMatchObject({
      workspaceId: WORKSPACE,
      requestId: REQUEST,
      sourceClass: "chat",
      aggregate: { surveyed: 3, enumerated: 2 },
      tallied: { surveyed: 3, enumerated: 1 },
    });
  });
});

describe("MUTATION 2 — backdate an observation past the cadence (stale fires)", () => {
  /** Our evidence for `#general` moves three days back. The vendor is untouched. */
  const mutated = (): BrainCoverage =>
    world({ backdate: new Map([["C_GENERAL", "2026-08-14T09:00:00.000Z"]]) });

  test("the unit that was current becomes stale", () => {
    const before = unit(available(world(), "chat"), "C_GENERAL");
    expect(before.state === "surveyed" && before.freshness.kind).toBe("current");
    const after = unit(available(mutated(), "chat"), "C_GENERAL");
    if (after.state !== "surveyed") throw new Error("unreachable");
    expect(after.freshness.kind).toBe("stale");
  });

  test("…and the verdict carries the arithmetic it was reached by", () => {
    const after = unit(available(mutated(), "chat"), "C_GENERAL");
    if (after.state !== "surveyed" || after.freshness.kind !== "stale") {
      throw new Error("unreachable");
    }
    // The vendor said 09:00 on the 17th; we last saw 09:00 on the 14th.
    expect(after.freshness).toEqual({
      kind: "stale",
      vendorActivityAt: "2026-08-17T09:00:00.000Z",
      newestEvidenceAt: "2026-08-14T09:00:00.000Z",
      lagMs: 3 * DAY_MS,
      cadenceMs: DAY_MS,
    });
  });

  test("…and the class tally moves with it", () => {
    expect(available(world(), "chat").freshness).toEqual({ current: 3, stale: 0, unverified: 0 });
    expect(available(mutated(), "chat").freshness).toEqual({ current: 2, stale: 1, unverified: 0 });
  });

  test("a lag of EXACTLY one cadence is the sync arriving on time, not a fault", () => {
    // ADR-0041 says "by MORE THAN the class's sync cadence". The boundary is
    // where a threshold silently becomes a deadline, and off-by-one here would
    // turn every workspace syncing exactly on schedule permanently amber.
    const onTime = world({
      backdate: new Map([["C_GENERAL", "2026-08-16T09:00:00.000Z"]]),
    });
    const general = unit(available(onTime, "chat"), "C_GENERAL");
    if (general.state !== "surveyed") throw new Error("unreachable");
    expect(general.freshness).toEqual({ kind: "current", checkedAt: CYCLE_AT });
  });
});

describe("MUTATION 3 — plant vendor activity newer than our newest evidence (lag is MEASURED)", () => {
  /**
   * A separate mutation from backdating, and only because the two sides are
   * authored separately: here our observation is untouched and the SOURCE moves.
   * With one literal feeding both, this and mutation 2 would be the same edit.
   */
  const mutated = (): BrainCoverage =>
    world({ plantActivity: new Map([["C_LEADERSHIP", "2026-08-18T11:00:00.000Z"]]) });

  test("the lag is the measured difference, not a flag", () => {
    const before = unit(available(world(), "chat"), "C_LEADERSHIP");
    expect(before.state === "surveyed" && before.freshness.kind).toBe("current");
    const after = unit(available(mutated(), "chat"), "C_LEADERSHIP");
    if (after.state !== "surveyed" || after.freshness.kind !== "stale") {
      throw new Error("unreachable");
    }
    // We observed 11:00 on the 16th and never moved; the SOURCE is now claimed
    // to have moved at 11:00 on the 18th. Both instants travel, so the verdict
    // is checkable rather than assertable.
    expect(after.freshness).toEqual({
      kind: "stale",
      vendorActivityAt: "2026-08-18T11:00:00.000Z",
      newestEvidenceAt: "2026-08-16T11:00:00.000Z",
      lagMs: 2 * DAY_MS,
      cadenceMs: DAY_MS,
    });
  });

  test("movement INSIDE the cadence is the source and the sync keeping pace", () => {
    // The same mutation, one day smaller. It is the pair that shows the number
    // is measured: `stale` is not "the vendor moved after we looked", it is
    // "the vendor moved further ahead than this class promises to close".
    const inside = world({
      plantActivity: new Map([["C_LEADERSHIP", "2026-08-17T11:00:00.000Z"]]),
    });
    const after = unit(available(inside, "chat"), "C_LEADERSHIP");
    if (after.state !== "surveyed") throw new Error("unreachable");
    expect(after.freshness).toEqual({ kind: "current", checkedAt: CYCLE_AT });
  });
});

describe('MUTATION 4 — sicken the pipe ("unverified since" replaces "stale")', () => {
  /**
   * The chat cycle's latest attempt failed. ADR-0041 puts a sick pipe on the
   * SAME sentence as a class that cannot ask: "Where activity metadata doesn't
   * exist, or the pipe is sick, the unit is 'unverified since \<date of last
   * successful cycle\>'".
   *
   * Applied ON TOP of mutation 2, because the claim is a REPLACEMENT: a unit
   * that would otherwise read stale must stop reading stale, and a fixture with
   * nothing stale in it cannot show that.
   */
  const SICK = "Slack returned ratelimited on conversations.list — the roster will refresh next cycle.";
  const staleOnly = (): BrainCoverage =>
    world({ backdate: new Map([["C_GENERAL", "2026-08-14T09:00:00.000Z"]]) });
  const mutated = (): BrainCoverage =>
    world({
      backdate: new Map([["C_GENERAL", "2026-08-14T09:00:00.000Z"]]),
      cycles: { chat: { unavailableReason: SICK } },
    });

  test("the stale unit stops reading stale", () => {
    const before = unit(available(staleOnly(), "chat"), "C_GENERAL");
    expect(before.state === "surveyed" && before.freshness.kind).toBe("stale");
    const after = unit(available(mutated(), "chat"), "C_GENERAL");
    if (after.state !== "surveyed") throw new Error("unreachable");
    expect(after.freshness).toEqual({
      kind: "unverified-since",
      since: CYCLE_AT,
      reason: "enumeration-unavailable",
    });
  });

  test("EVERY unit of the class does, and the tally says so", () => {
    // Not only the stale one: a failed cycle means nobody looked, so no reading
    // taken before it may be reported as a verdict about now.
    expect(available(mutated(), "chat").freshness).toEqual({
      current: 0,
      stale: 0,
      unverified: 3,
    });
  });

  test('the dated counts SURVIVE, captioned "unavailable since" rather than zeroed', () => {
    // The rule that shapes every write in #5213, restated on the read side: a
    // failed cycle never zeroes the prior snapshot. The counts are not wrong,
    // they are older than they look — and `since` is the last SUCCESS, which is
    // the date they are true as of, never the failed attempt's time.
    const arm = available(mutated(), "chat");
    expect(arm.ratio.enumerable).toBe(5);
    expect(arm.unavailable).toEqual({ since: CYCLE_AT, reason: SICK });
  });

  test("a healthy class carries no `unavailable` caption at all", () => {
    expect(available(world(), "chat").unavailable).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("degradation matches oversight — no reassuring zeros, and it travels", () => {
  test("a surveyed row with no evidence behind it is resolved AGAINST green", () => {
    // Unreachable through the writers (`surveyUnitState` derives it and a
    // database CHECK re-derives it), and the one contradiction whose flattering
    // direction is total: it moves a unit out of the unsurveyed half and into
    // the green one. ADR-0040 rule 3 applied to a row that lost its evidence.
    const rows: CoverageUnitRow[] = [
      {
        unitId: "C_GHOST",
        state: "surveyed",
        inPerimeter: true,
        label: "#ghost",
        disclosure: { deliberateAct: true, vendorReportsPublic: true },
        newestEvidenceAt: null,
        activity: { probed: false },
      },
    ];
    const result = composeCoverage({
      workspaceId: WORKSPACE,
      requestId: REQUEST,
      at: NOW,
      authority: AUTHORITY,
      snapshots: [cycleRow("chat", rows)],
      rosters: new Map([["chat", rows]]),
    });
    const chat = available(result, "chat");
    expect(chat.ratio.surveyed).toBe(0);
    expect(chat.ratio.enumerated).toBe(1);
    expect(result.countsConsistent).toBe(false);
    expect(warns(/stored as surveyed with no evidence/)).toHaveLength(1);
  });

  test("the M1 blind count is cross-checked too, not only the two beside it", () => {
    // "Invited, configured, reading nothing" is derived by a different SQL
    // expression from the other two (`state = 'enumerated' AND in_perimeter`),
    // so a mis-derivation of it alone is exactly the shape that would ship under
    // two green comparisons.
    const rows = chatRoster();
    const result = composeCoverage({
      workspaceId: WORKSPACE,
      requestId: REQUEST,
      at: NOW,
      authority: AUTHORITY,
      snapshots: [cycleRow("chat", rows, { inPerimeterWithoutEvidence: 7 })],
      rosters: new Map([["chat", rows]]),
    });
    expect(result.countsConsistent).toBe(false);
    const found = warns(/aggregate and the roster rows disagree/);
    expect(found).toHaveLength(1);
    expect(found[0]?.payload).toMatchObject({
      aggregate: { inPerimeterWithoutEvidence: 7 },
      tallied: { inPerimeterWithoutEvidence: 0 },
    });
  });

  test("a timestamp that will not parse is unverified, never current", () => {
    const rows: CoverageUnitRow[] = [
      {
        unitId: "C_BROKEN",
        state: "surveyed",
        inPerimeter: true,
        label: "#broken",
        disclosure: { deliberateAct: true, vendorReportsPublic: true },
        newestEvidenceAt: "not-a-timestamp",
        activity: { probed: true, at: "2026-08-17T10:00:00.000Z", checkedAt: CYCLE_AT },
      },
    ];
    const result = composeCoverage({
      workspaceId: WORKSPACE,
      requestId: REQUEST,
      at: NOW,
      authority: AUTHORITY,
      snapshots: [cycleRow("chat", rows)],
      rosters: new Map([["chat", rows]]),
    });
    const broken = unit(available(result, "chat"), "C_BROKEN");
    if (broken.state !== "surveyed") throw new Error("unreachable");
    expect(broken.freshness).toEqual({
      kind: "unverified-since",
      since: CYCLE_AT,
      reason: "unreadable-reading",
    });
    expect(result.countsConsistent).toBe(false);
    expect(warns(/did not parse/)).toHaveLength(1);
  });

  test("a degraded AUTHORITY arm clears the page's signal too", () => {
    // One banner, two arms. A client should not have to know there are two
    // fields that both mean "the arithmetic disagreed" — and the authority arm's
    // own flag stays on the wire untouched for a client that wants to say which.
    const result = world({ authority: { ...AUTHORITY, countsConsistent: false } });
    expect(result.countsConsistent).toBe(false);
    expect(result.authority.countsConsistent).toBe(false);
  });

  test("two cycle rows for one class is loud, not an arbitrary winner in silence", () => {
    const rows = chatRoster();
    const result = composeCoverage({
      workspaceId: WORKSPACE,
      requestId: REQUEST,
      at: NOW,
      authority: AUTHORITY,
      snapshots: [cycleRow("chat", rows), cycleRow("chat", rows, { asOf: "2020-01-01T00:00:00.000Z" })],
      rosters: new Map([["chat", rows]]),
    });
    expect(result.countsConsistent).toBe(false);
    expect(warns(/two cycle rows came back for one class/)).toHaveLength(1);
    // The FIRST row wins, so the page's date is at least a date some cycle
    // actually wrote rather than a merge of two.
    expect(available(result, "chat").asOf).toBe(CYCLE_AT);
  });

  test("the map edges travel as marks, and they carry no number", () => {
    const result = world({
      cycles: { chat: { degraded: ["chat-public-roster-truncated", "chat-activity-unreadable"] } },
    });
    const arm = available(result, "chat");
    expect(arm.mapEdges).toEqual(["chat-public-roster-truncated", "chat-activity-unreadable"]);
    // ADR-0041: "shown as a mark, never a number: any denominator that includes
    // it is fabricated". There is no shape here that could hold one.
    for (const edge of arm.mapEdges) expect(typeof edge).toBe("string");
  });

  test("map-edge marks this deploy cannot render clear the signal", () => {
    // The direction is the flattering one and it is REACHABLE: roll a deploy
    // back below the build that first wrote a new arm and the stored value has
    // no sentence here, so it is dropped — leaving an empty edge list that the
    // page renders as a complete map. `readDegradedArms` logs it; a page cannot
    // read a log line, so the loss travels.
    const result = world({ cycles: { chat: { degradedIncomplete: true } } });
    expect(result.countsConsistent).toBe(false);
    // …and it is NOT invented as a fourth mark: what is unknown is which edges
    // exist, not where one is.
    expect(available(result, "chat").mapEdges).toEqual([]);
  });

  test("the listing clips, the COUNTS do not", () => {
    // `OVERSIGHT_BUCKET_MAX`'s argument one surface over: a clipped list reads
    // as the whole roster, and the counts beside it would then look like they
    // disagreed with the rows.
    const many: CoverageUnitRow[] = Array.from({ length: COVERAGE_UNITS_MAX + 5 }, (_, i) => ({
      unitId: `C_${i}`,
      state: "enumerated" as const,
      inPerimeter: false,
      label: `#chan-${i}`,
      disclosure: { deliberateAct: false, vendorReportsPublic: true },
      newestEvidenceAt: null,
      activity: { probed: false as const },
    }));
    const result = composeCoverage({
      workspaceId: WORKSPACE,
      requestId: REQUEST,
      at: NOW,
      authority: AUTHORITY,
      snapshots: [cycleRow("chat", many)],
      rosters: new Map([["chat", many]]),
    });
    const arm = available(result, "chat");
    expect(arm.units).toHaveLength(COVERAGE_UNITS_MAX);
    expect(arm.unitsTruncated).toBe(true);
    expect(arm.ratio.enumerable).toBe(COVERAGE_UNITS_MAX + 5);
    expect(warns(/more namable units than one response carries/)).toHaveLength(1);
  });
});

describe("the false-all-clear throw", () => {
  test("carries the workspace, the class and the requestId an operator correlates on", () => {
    // ⚠️ The ARM ITSELF is unreachable on a healthy deploy, deliberately: it
    // fires only when a class's contract declares an enumerable universe while
    // `coverage-enumeration.ts` holds no roster for it, and
    // `coverage-enumeration.test.ts` pins those two declarations equal. That is
    // why it is a throw rather than a degraded arm — it cannot fire unless the
    // declarations have already diverged, and every available answer at that
    // point is a false statement in the flattering direction.
    //
    // What IS testable is the artifact the throw hands the operator, which is
    // the half ADR-0041 asks for ("the false-all-clear direction throws with a
    // requestId").
    const err = new CoverageCompositionError(WORKSPACE, "chat", REQUEST);
    expect(err.name).toBe("CoverageCompositionError");
    expect(err.message).toContain(WORKSPACE);
    expect(err.message).toContain(REQUEST);
    expect(err.message).toContain("chat");
    expect(err).toBeInstanceOf(Error);
  });
});
