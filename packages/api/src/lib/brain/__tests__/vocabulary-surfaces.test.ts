/**
 * The picker's and the coverage read's FAIL-CLOSED paths, plus `withheldCount`
 * (#5087).
 *
 * ## Why this file exists beside the `-pg` suite
 *
 * `vocabulary-authoring-pg.test.ts` drives these modules against real Postgres,
 * which is right for everything that is a property of SQL. It cannot reach the
 * defensive arms: a real `pg` client does not hand back a row whose `from_claims`
 * is a string, so the branches that decide what happens when one does were
 * documented and unreachable. Each is two lines from a stub reader, and each
 * guards a documented silent-failure mode:
 *
 *   - `loadPairPopulation` reading an unreadable row as EMPTY, which REFUSES the
 *     authoring. If that ever regressed to a permissive default it would admit
 *     exactly the silent-success edge the module exists to prevent.
 *   - `loadObservedSurfaces` dropping a row it cannot narrow — a norm silently
 *     missing from the picker is one an approver concludes does not exist, and
 *     the conclusion that follows is *"I will type it"*.
 *   - `loadVocabularyCoverage` returning zeros — *"0 of your 0 live claims
 *     currently qualify"* reads as an answer while meaning the query did not run.
 *
 * They also RUN LOCALLY, which the `-pg` assertions do not: without
 * `TEST_DATABASE_URL` that whole file is skipped, so the local signal for this
 * subsystem was near zero.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { BrainPrincipalContext } from "@atlas/api/lib/brain/acl";

/** A capturing logger. See `vocabulary-visibility.test.ts` for the hoisting trap. */
const warnCalls: Record<string, unknown>[] = [];
void mock.module("@atlas/api/lib/logger", () => {
  const logger = {
    info: () => {},
    debug: () => {},
    error: () => {},
    warn: (payload: unknown) => {
      if (typeof payload === "object" && payload !== null) {
        warnCalls.push(payload as Record<string, unknown>);
      }
    },
    child: () => logger,
  };
  return {
    createLogger: () => logger,
    getLogger: () => logger,
    getRequestContext: () => ({ requestId: "test-req" }),
    withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
    redactPaths: [] as string[],
    scrubErrSerializer: (err: unknown) => err,
    scrubLogFormatter: (obj: unknown) => obj,
    hashShareToken: (token: string) => token,
    setLogLevel: () => {},
    ACTOR_KINDS: ["user", "system"] as const,
  };
});

const { emptySide, loadObservedSurfaces, loadPairPopulation } = await import(
  "@atlas/api/lib/brain/vocabulary-surfaces"
);
const { loadVocabularyCoverage } = await import("@atlas/api/lib/brain/vocabulary-in-force");
const { withheldCount } = await import("@atlas/api/lib/brain/vocabulary-visibility");

const WS = "ws-surfaces";

const owner: BrainPrincipalContext = {
  origin: "authenticated",
  workspaceId: WS,
  userId: "user-1",
  role: "owner",
  audienceIds: [],
};

/** A reader that answers every statement with one fixed row set. */
const reader = (rows: readonly unknown[]) => ({ query: async () => ({ rows }) });

beforeEach(() => {
  warnCalls.length = 0;
});

describe("the withheld count is never a silent omission (ADR-0037 §6)", () => {
  it("reports the difference, so 'you cannot see 12' is distinguishable from 'none'", () => {
    // THE property the pane exists for. A scoped SELECT renders those two
    // identically, and an approver who cannot tell them apart concludes their
    // workspace has a clean vocabulary when it may have a dozen entries they are
    // blind to.
    expect(withheldCount(15, 3)).toEqual({
      total: 15,
      scoped: 3,
      withheld: 12,
      consistent: true,
    });
    expect(withheldCount(3, 3).withheld).toBe(0);
  });

  it("reports an inverted delta rather than clamping it into a reassuring zero", () => {
    // `loadFactOversight`'s recorded lesson, quoted in `BlastRadiusSide`:
    // silently clamping renders as "nothing is hidden from you", which is the
    // pre-#4825 defect reproduced by its own fix.
    const inverted = withheldCount(2, 5);
    expect(inverted.withheld).toBe(0);
    expect(inverted.consistent).toBe(false);
  });

  it("refuses an unreadable count rather than rendering NaN at an approver", () => {
    const broken = withheldCount(Number.NaN, 4);
    expect(broken.withheld).toBe(0);
    expect(broken.consistent).toBe(false);
  });
});

describe("loadPairPopulation fails closed on a row it cannot read", () => {
  it("reads BOTH sides as empty when no row comes back, and says so", async () => {
    const population = await loadPairPopulation(reader([]), owner, {
      position: "predicate",
      fromNorm: "alpha",
      toNorm: "beta",
    });
    // Zero REFUSES the authoring. A refusal costs a retry; an admitted edge
    // whose population was never observed is the silent success this module
    // exists to prevent.
    expect(population.from.claims).toBe(0);
    expect(population.to.claims).toBe(0);
    expect(emptySide(population)).toBe("both");
    expect(warnCalls).toHaveLength(1);
  });

  it("⚠️ logs when only the TO side is unreadable", async () => {
    // The one-sided guard was the defect: the check read `from_claims` only, so
    // a drifted `to_claims` yielded 0 in silence — and the approver was told
    // `"<toNorm>" has no live claim` when the corpus was never asked.
    const population = await loadPairPopulation(
      reader([{ from_claims: 4, to_claims: "not-a-number" }]),
      owner,
      { position: "predicate", fromNorm: "alpha", toNorm: "beta" },
    );
    expect(population.from.claims).toBe(4);
    expect(population.to.claims).toBe(0);
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]).toMatchObject({ fromReadable: true, toReadable: false });
  });

  it("POSITIVE CONTROL — stays silent and reports both counts when the row is readable", async () => {
    // Without this, a `loadPairPopulation` that logged unconditionally — or that
    // always returned zeros — would satisfy both assertions above.
    const population = await loadPairPopulation(
      reader([{ from_claims: 4, to_claims: 7 }]),
      owner,
      { position: "predicate", fromNorm: "alpha", toNorm: "beta" },
    );
    expect(population.from.claims).toBe(4);
    expect(population.to.claims).toBe(7);
    expect(emptySide(population)).toBeNull();
    expect(warnCalls).toHaveLength(0);
  });

  it("re-norms both sides, so the check asks about the string the write will use", async () => {
    const population = await loadPairPopulation(reader([{ from_claims: 1, to_claims: 1 }]), owner, {
      position: "predicate",
      fromNorm: "  Is  Priced-At ",
      toNorm: "Priced At",
    });
    expect(population.from.norm).toBe("is priced at");
    expect(population.to.norm).toBe("priced at");
  });
});

describe("loadObservedSurfaces reports dropped rows rather than shrinking in silence", () => {
  it("counts an unreadable row, logs it, and marks the page truncated", async () => {
    // A norm silently missing from the picker is one an approver concludes does
    // not exist — and then goes looking for a text box, which is the affordance
    // this whole module removes.
    const page = await loadObservedSurfaces(
      reader([
        { norm: "alpha", example_surface: "Alpha", claims: 2, variants: 1 },
        { norm: 42, example_surface: "Beta", claims: 1, variants: 1 },
      ]),
      owner,
      { position: "predicate" },
    );
    expect(page.surfaces.map((s) => s.norm)).toEqual(["alpha"]);
    expect(page.truncated).toBe(true);
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]).toMatchObject({ unreadable: 1 });
  });

  it("POSITIVE CONTROL — a clean page is neither truncated nor logged", async () => {
    const page = await loadObservedSurfaces(
      reader([{ norm: "alpha", example_surface: "Alpha", claims: 2, variants: 1 }]),
      owner,
      { position: "predicate" },
    );
    expect(page.truncated).toBe(false);
    expect(warnCalls).toHaveLength(0);
  });

  it("returns an empty page for a denied reader without pretending it is a corpus fact", async () => {
    const denied: BrainPrincipalContext = {
      origin: "unresolved",
      workspaceId: WS,
      userId: null,
      role: null,
      audienceIds: [],
    };
    const page = await loadObservedSurfaces(reader([]), denied, { position: "predicate" });
    expect(page.surfaces).toEqual([]);
    // The DECISION travels, so the caller can say "you were denied" rather than
    // "your workspace has none".
    expect(page.decision).toBe("deny-all");
  });
});

describe("loadVocabularyCoverage refuses to invent an answer", () => {
  it("logs and zeroes when no row comes back", async () => {
    const coverage = await loadVocabularyCoverage(reader([]), WS);
    expect(coverage).toEqual({
      liveFacts: 0,
      comparableFacts: 0,
      pendingProposals: 0,
      pendingCardinalities: 0,
    });
    expect(warnCalls).toHaveLength(1);
  });

  it("⚠️ logs when a SINGLE column drifts, not just when the row is missing", async () => {
    // "0 of your 0 live claims currently qualify" reads as an answer while
    // meaning the query did not run — and it was reachable one column at a time,
    // below the no-row guard that already refuses to produce it.
    const coverage = await loadVocabularyCoverage(
      reader([
        {
          live_facts: 47,
          comparable_facts: null,
          pending_proposals: 0,
          pending_cardinalities: 0,
        },
      ]),
      WS,
    );
    expect(coverage.liveFacts).toBe(47);
    expect(coverage.comparableFacts).toBe(0);
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]).toMatchObject({ unreadable: ["comparable_facts"] });
  });

  it("POSITIVE CONTROL — a complete row is returned intact and silently", async () => {
    const coverage = await loadVocabularyCoverage(
      reader([
        {
          live_facts: 47,
          comparable_facts: 3,
          pending_proposals: 1,
          pending_cardinalities: 2,
        },
      ]),
      WS,
    );
    expect(coverage).toEqual({
      liveFacts: 47,
      comparableFacts: 3,
      pendingProposals: 1,
      pendingCardinalities: 2,
    });
    expect(warnCalls).toHaveLength(0);
  });

  it("returns zeros without a query when there is no workspace", async () => {
    const coverage = await loadVocabularyCoverage(reader([]), "");
    expect(coverage.liveFacts).toBe(0);
    expect(warnCalls).toHaveLength(0);
  });
});
