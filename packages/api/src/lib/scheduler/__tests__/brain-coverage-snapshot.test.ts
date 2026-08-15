/**
 * The denominator-snapshot cycle's dispatch (#5213, ADR-0041).
 *
 * The write's own guarantees — the never-zero rule, the sweep, the label gate —
 * are `lib/brain/__tests__/coverage-snapshot-pg.test.ts`, against a real server.
 * What is left here is what the DISPATCH decides: which classes have an answer
 * at all, that one workspace's refusal does not stop another's, and that a class
 * whose workspace scan fails does not freeze the classes beside it.
 */

import { describe, expect, it } from "bun:test";
import {
  CLASS_ENUMERATION_PLANS,
  DEFAULT_COVERAGE_SNAPSHOT_INTERVAL_MS,
  getCoverageSnapshotIntervalMs,
  runCoverageSnapshotCycle,
  type ClassEnumerationPlan,
  type CoverageSnapshotDeps,
} from "@atlas/api/lib/scheduler/brain-coverage-snapshot";
import { CLASS_CONTRACTS } from "@atlas/api/lib/brain/class-contract";
import { EPISODE_SOURCE_CLASSES, type EpisodeSourceClass } from "@atlas/api/lib/brain/sources";
import type {
  CoverageEnumeration,
  CoveragePersistReport,
  SurveyableSourceClass,
} from "@atlas/api/lib/brain/coverage-enumeration";

/** `hasInternalDB()` reads DATABASE_URL; set inside tests, never at top level. */
function withDatabaseUrl<T>(fn: () => Promise<T>): Promise<T> {
  const prior = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://stub/stub";
  return fn().finally(() => {
    if (prior === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prior;
  });
}

const OK: CoverageEnumeration = { ok: true, units: [], degraded: [] };

/**
 * A recording `persist` double.
 *
 * It records what it was ASKED to do and reports what the real one would — it
 * does NOT stand in for the write's guarantees, which is why the never-zero rule
 * is tested against a real database instead of here.
 */
function persistSpy(
  over: (call: { workspaceId: string; sourceClass: string; outcome: CoverageEnumeration }) =>
    | Partial<CoveragePersistReport>
    | undefined = () => undefined,
) {
  const calls: { workspaceId: string; sourceClass: string; outcome: CoverageEnumeration }[] = [];
  const persist = async (params: {
    workspaceId: string;
    sourceClass: SurveyableSourceClass;
    outcome: CoverageEnumeration;
    cycleAt: Date;
  }): Promise<CoveragePersistReport> => {
    const call = {
      workspaceId: params.workspaceId,
      sourceClass: params.sourceClass,
      outcome: params.outcome,
    };
    calls.push(call);
    return {
      status: params.outcome.ok ? "success" : "failure",
      written: params.outcome.ok ? params.outcome.units.length : 0,
      retired: 0,
      surveyed: 0,
      labelled: 0,
      degraded: params.outcome.ok ? params.outcome.degraded : [],
      ...over(call),
    };
  };
  return { persist: persist as unknown as CoverageSnapshotDeps["persist"], calls };
}

function plans(
  over: Partial<Record<EpisodeSourceClass, ClassEnumerationPlan>>,
): Record<EpisodeSourceClass, ClassEnumerationPlan> {
  return {
    chat: { kind: "awaiting-connector" },
    transcript: { kind: "awaiting-connector" },
    email: { kind: "awaiting-connector" },
    warehouse: { kind: "awaiting-connector" },
    human: { kind: "not-surveyable" },
    ...over,
  };
}

describe("the class registry — totality at compile time (ADR-0041)", () => {
  it("answers for EVERY episode source class", () => {
    expect(Object.keys(CLASS_ENUMERATION_PLANS).toSorted()).toEqual(
      [...EPISODE_SOURCE_CLASSES].toSorted(),
    );
  });

  it("marks `human` NON-SURVEYABLE, matching its contract's own declaration", () => {
    // The distinction that makes the totality mean something: `human` has
    // positively declared it has no enumerable units, while `transcript` and
    // `email` have a declared denominator nothing enumerates YET. Collapsing
    // both to a null would say the same thing about a decision and a gap.
    expect(CLASS_ENUMERATION_PLANS.human.kind).toBe("not-surveyable");
    expect(CLASS_CONTRACTS.human.coverage.denominator.surveyable).toBe(false);
  });

  it("never marks a SURVEYABLE class non-surveyable", () => {
    for (const cls of EPISODE_SOURCE_CLASSES) {
      const declaredSurveyable = CLASS_CONTRACTS[cls].coverage.denominator.surveyable;
      const plannedNonSurveyable = CLASS_ENUMERATION_PLANS[cls].kind === "not-surveyable";
      expect(plannedNonSurveyable).toBe(!declaredSurveyable);
    }
  });

  it("ships enumerators for chat and warehouse, and only those, today", () => {
    // Pinned as a literal so adding an enumerator is a deliberate edit here —
    // #5213's stated scope, with transcript and email following their
    // connectors' coverage work.
    const enumerating = EPISODE_SOURCE_CLASSES.filter(
      (cls) => CLASS_ENUMERATION_PLANS[cls].kind === "enumerates",
    );
    expect([...enumerating].toSorted()).toEqual(["chat", "warehouse"]);
  });
});

describe("runCoverageSnapshotCycle", () => {
  it("does nothing at all with no internal database", async () => {
    const prior = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const spy = persistSpy();
      const result = await runCoverageSnapshotCycle({ plans: plans({}), persist: spy.persist });
      expect(result).toMatchObject({ status: "success", workspacesInspected: 0 });
      expect(spy.calls.length).toBe(0);
    } finally {
      if (prior !== undefined) process.env.DATABASE_URL = prior;
    }
  });

  it("enumerates every workspace of every class that HAS an enumerator", async () => {
    const spy = persistSpy();
    const result = await withDatabaseUrl(() =>
      runCoverageSnapshotCycle({
        persist: spy.persist,
        isEnabled: () => true,
        plans: plans({
          chat: {
            kind: "enumerates",
            listWorkspaces: async () => ["ws-1", "ws-2"],
            enumerate: async () => ({ ok: true, units: [], degraded: [] }),
          },
          warehouse: {
            kind: "enumerates",
            listWorkspaces: async () => ["ws-1"],
            enumerate: async () => OK,
          },
        }),
      }),
    );
    // 2 chat + 1 warehouse. Deliberately unequal per class, so an
    // implementation that ran one class's workspace list for both still moves
    // this number.
    expect(result.workspacesInspected).toBe(3);
    expect(spy.calls.map((c) => `${c.sourceClass}:${c.workspaceId}`).toSorted()).toEqual([
      "chat:ws-1",
      "chat:ws-2",
      "warehouse:ws-1",
    ]);
    // A class with no enumerator is not persisted for at all — an
    // `awaiting-connector` class must not land an empty roster, which would read
    // on the page as "we looked and there is nothing there".
    expect(spy.calls.some((c) => c.sourceClass === "email")).toBe(false);
  });

  it("skips a workspace that switched the snapshot OFF, and counts the skip", async () => {
    const spy = persistSpy();
    const result = await withDatabaseUrl(() =>
      runCoverageSnapshotCycle({
        persist: spy.persist,
        isEnabled: (workspaceId) => workspaceId !== "ws-off",
        plans: plans({
          chat: {
            kind: "enumerates",
            listWorkspaces: async () => ["ws-on", "ws-off"],
            enumerate: async () => OK,
          },
        }),
      }),
    );
    expect(result).toMatchObject({ workspacesInspected: 1, workspacesSkippedDisabled: 1 });
    expect(spy.calls.map((c) => c.workspaceId)).toEqual(["ws-on"]);
  });

  it("records a REFUSAL and carries on to the next workspace", async () => {
    const spy = persistSpy();
    const result = await withDatabaseUrl(() =>
      runCoverageSnapshotCycle({
        persist: spy.persist,
        isEnabled: () => true,
        plans: plans({
          chat: {
            kind: "enumerates",
            listWorkspaces: async () => ["ws-broken", "ws-fine"],
            enumerate: async (workspaceId) =>
              workspaceId === "ws-broken"
                ? { ok: false, error: "No Slack connection for this workspace." }
                : { ok: true, units: [], degraded: [] },
          },
        }),
      }),
    );
    // One workspace's revoked token must not stop the next workspace's roster
    // being refreshed — hence the POSITIVE CONTROL beside the failure.
    expect(result).toMatchObject({ status: "degraded", classesFailed: 1, classesEnumerated: 1 });
    expect(spy.calls.map((c) => c.workspaceId)).toEqual(["ws-broken", "ws-fine"]);
    expect(spy.calls[0]?.outcome.ok).toBe(false);
  });

  it("converts a THROWING enumerator into a refusal rather than losing the cycle", async () => {
    const spy = persistSpy();
    const result = await withDatabaseUrl(() =>
      runCoverageSnapshotCycle({
        persist: spy.persist,
        isEnabled: () => true,
        plans: plans({
          chat: {
            kind: "enumerates",
            listWorkspaces: async () => ["ws-1", "ws-2"],
            enumerate: async (workspaceId) => {
              if (workspaceId === "ws-1") throw new Error("relation does not exist");
              return OK;
            },
          },
        }),
      }),
    );
    expect(result.classesFailed).toBe(1);
    expect(result.classesEnumerated).toBe(1);
    const refusal = spy.calls[0]?.outcome;
    expect(refusal?.ok).toBe(false);
    // The refusal path is the one that KEEPS the previous roster, which is
    // exactly what a broken enumerator should produce.
    expect(refusal?.ok === false && refusal.error).toContain("relation does not exist");
  });

  it("a class whose WORKSPACE SCAN fails does not freeze the class beside it", async () => {
    const spy = persistSpy();
    const result = await withDatabaseUrl(() =>
      runCoverageSnapshotCycle({
        persist: spy.persist,
        isEnabled: () => true,
        plans: plans({
          chat: {
            kind: "enumerates",
            listWorkspaces: async () => {
              throw new Error("chat_cache unreadable");
            },
            enumerate: async () => OK,
          },
          warehouse: {
            kind: "enumerates",
            listWorkspaces: async () => ["ws-1"],
            enumerate: async () => OK,
          },
        }),
      }),
    );
    expect(result.status).toBe("failure");
    expect(result.error).toContain("chat_cache unreadable");
    // The POSITIVE CONTROL: the warehouse roster was still refreshed.
    expect(spy.calls.map((c) => c.sourceClass)).toEqual(["warehouse"]);
  });

  it("a PERSIST failure is a failed class, not a dead cycle", async () => {
    const calls: string[] = [];
    const persist = (async (params: { workspaceId: string }) => {
      calls.push(params.workspaceId);
      if (params.workspaceId === "ws-1") throw new Error("deadlock detected");
      return {
        status: "success" as const,
        written: 0,
        retired: 0,
        surveyed: 0,
        labelled: 0,
        degraded: [],
      };
    }) as unknown as CoverageSnapshotDeps["persist"];
    const result = await withDatabaseUrl(() =>
      runCoverageSnapshotCycle({
        persist,
        isEnabled: () => true,
        plans: plans({
          chat: {
            kind: "enumerates",
            listWorkspaces: async () => ["ws-1", "ws-2"],
            enumerate: async () => OK,
          },
        }),
      }),
    );
    expect(result).toMatchObject({ status: "degraded", classesFailed: 1, classesEnumerated: 1 });
    expect(calls).toEqual(["ws-1", "ws-2"]);
  });

  it("tallies units, retirements and MAP EDGES separately", async () => {
    const spy = persistSpy(() => ({
      status: "success",
      written: 5,
      retired: 2,
      surveyed: 3,
      labelled: 4,
      degraded: ["chat-public-roster-truncated"],
    }));
    const result = await withDatabaseUrl(() =>
      runCoverageSnapshotCycle({
        persist: spy.persist,
        isEnabled: () => true,
        plans: plans({
          chat: {
            kind: "enumerates",
            listWorkspaces: async () => ["ws-1"],
            enumerate: async () => OK,
          },
        }),
      }),
    );
    // Four DIFFERENT numbers, so a tally that summed the wrong field cannot
    // pass: 5 written, 2 retired, 3 surveyed, 1 edge.
    expect(result).toMatchObject({
      unitsWritten: 5,
      unitsRetired: 2,
      unitsSurveyed: 3,
      mapEdges: 1,
    });
  });
});

describe("getCoverageSnapshotIntervalMs", () => {
  it("falls back to the default when the knob is unset", () => {
    expect(getCoverageSnapshotIntervalMs()).toBe(DEFAULT_COVERAGE_SNAPSHOT_INTERVAL_MS);
  });

  it("is an HOUR by default, not a minute — a roster changes on a human timescale", () => {
    expect(DEFAULT_COVERAGE_SNAPSHOT_INTERVAL_MS).toBe(60 * 60_000);
  });
});
