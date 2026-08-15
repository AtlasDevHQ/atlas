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
  WAREHOUSE_WORKSPACES_SQL,
  getCoverageSnapshotIntervalMs,
  isCoverageSnapshotEnabled,
  runCoverageSnapshotCycle,
  type ClassEnumerationPlan,
  type ClassEnumerationPlans,
  type CoverageSnapshotDeps,
} from "@atlas/api/lib/scheduler/brain-coverage-snapshot";
import { CLASS_CONTRACTS } from "@atlas/api/lib/brain/class-contract";
import { getSettingsRegistry } from "@atlas/api/lib/settings";
import { EPISODE_SOURCE_CLASSES } from "@atlas/api/lib/brain/sources";
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

/** What a SURVEYABLE class may declare — the registry's mapped type, mirrored. */
type SurveyablePlan = Exclude<ClassEnumerationPlan, { readonly kind: "not-surveyable" }>;

interface PersistCall {
  readonly workspaceId: string;
  readonly sourceClass: SurveyableSourceClass;
  readonly outcome: CoverageEnumeration;
  readonly requestId: string | undefined;
}

/**
 * A recording `persist` double.
 *
 * Typed as the seam's own type with NO cast, deliberately: that is what makes
 * the double break when the real signature changes, and the `as unknown as` this
 * replaces would have let a new field arrive silently `undefined` in every test.
 */
function persistSpy(
  over: (call: PersistCall) => Partial<Extract<CoveragePersistReport, { status: "success" }>> = () =>
    ({}),
) {
  const calls: PersistCall[] = [];
  const persist: NonNullable<CoverageSnapshotDeps["persist"]> = async (params) => {
    calls.push({
      workspaceId: params.workspaceId,
      sourceClass: params.sourceClass,
      outcome: params.outcome,
      requestId: params.requestId,
    });
    if (!params.outcome.ok) return { status: "failure" };
    return {
      status: "success",
      written: params.outcome.units.length,
      retired: 0,
      surveyed: 0,
      labelled: 0,
      collapsed: false,
      degraded: params.outcome.degraded,
      ...over(calls[calls.length - 1]!),
    };
  };
  return { persist, calls };
}

/**
 * A registry override.
 *
 * `human` is NOT overridable, and a SURVEYABLE class may not be handed
 * `not-surveyable` either — `SurveyablePlan` is `ClassEnumerationPlan` minus that
 * arm, mirroring the registry's own mapped type in both directions.
 *
 * That is the point rather than an omission:
 * `ClassEnumerationPlans` correlates the class with the plan kind, so a helper
 * that let a test hand `human` an enumerator would rebuild exactly the illegal
 * state the mapped type removed — and a test double is where the first cut of
 * this file could construct it.
 */
function plans(
  over: Partial<Record<SurveyableSourceClass, SurveyablePlan>>,
): ClassEnumerationPlans {
  return {
    chat: { kind: "awaiting-connector" },
    transcript: { kind: "awaiting-connector" },
    email: { kind: "awaiting-connector" },
    warehouse: { kind: "awaiting-connector" },
    ...over,
    human: { kind: "not-surveyable" },
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
      expect(result).toMatchObject({ status: "success", enumerationsAttempted: 0 });
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
    expect(result.enumerationsAttempted).toBe(3);
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
    expect(result).toMatchObject({ enumerationsAttempted: 1, enumerationsSkippedDisabled: 1 });
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
    expect(result).toMatchObject({ status: "degraded", enumerationsFailed: 1, enumerationsSucceeded: 1 });
    expect(spy.calls.map((c) => c.workspaceId)).toEqual(["ws-broken", "ws-fine"]);
    expect(spy.calls[0]?.outcome.ok).toBe(false);
    // ⚠️ The REFUSAL branch feeds `error` too. It was the sibling of the
    // write-failure arm, one line away in the same loop, and it was left out of
    // the same fix — so a cycle whose every enumeration was refused returned
    // `{ degraded, error: null }` while the status docstring claimed otherwise.
    expect(result.error).toContain("No Slack connection");
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
    expect(result.enumerationsFailed).toBe(1);
    expect(result.enumerationsSucceeded).toBe(1);
    const refusal = spy.calls[0]?.outcome;
    expect(refusal?.ok).toBe(false);
    // The refusal path is the one that KEEPS the previous roster, which is
    // exactly what a broken enumerator should produce.
    expect(refusal?.ok === false && refusal.error).toContain("relation does not exist");
  });

  it("a class whose WORKSPACE SCAN fails does not freeze the class beside it", async () => {
    const spy = persistSpy();
    const scans: { sourceClass: string; error: string }[] = [];
    const recordScanFailure: NonNullable<CoverageSnapshotDeps["recordScanFailure"]> = async (p) => {
      scans.push({ sourceClass: p.sourceClass, error: p.error });
      return 1;
    };
    const result = await withDatabaseUrl(() =>
      runCoverageSnapshotCycle({
        persist: spy.persist,
        recordScanFailure,
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
    // PARTIAL scan failure is `degraded`, not `failure` — one class's scan
    // failing while another enumerated is exactly what `degraded` means, and
    // `failure` is what an operator pages on. The error text still travels.
    expect(result.status).toBe("degraded");
    expect(result.error).toContain("chat_cache unreadable");
    // The POSITIVE CONTROL: the warehouse roster was still refreshed.
    expect(spy.calls.map((c) => c.sourceClass)).toEqual(["warehouse"]);
    // ⚠️ AND the failed class RECORDS ITS ATTEMPT. This assertion is the one the
    // first cut of this test got wrong: it pinned `["warehouse"]` and stopped,
    // certifying that a scan-failed class wrote NOTHING — which left the page
    // reading "as of <old date>" with no error beside it for as long as the scan
    // kept failing.
    expect(scans.map((c) => c.sourceClass)).toEqual(["chat"]);
    expect(scans[0]?.error).toContain("chat_cache unreadable");
  });

  it("is a FAILURE only when EVERY class's scan failed — the cycle established nothing", async () => {
    const spy = persistSpy();
    const scans: { sourceClass: string; error: string }[] = [];
    const recordScanFailure: NonNullable<CoverageSnapshotDeps["recordScanFailure"]> = async (p) => {
      scans.push({ sourceClass: p.sourceClass, error: p.error });
      return 1;
    };
    const result = await withDatabaseUrl(() =>
      runCoverageSnapshotCycle({
        persist: spy.persist,
        recordScanFailure,
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
            listWorkspaces: async () => {
              throw new Error("semantic_entities unreadable");
            },
            enumerate: async () => OK,
          },
        }),
      }),
    );
    expect(result.status).toBe("failure");
    // BOTH reasons travel — a concatenation that kept only the first would send
    // an operator to one subsystem while the other was equally down.
    expect(result.error).toContain("chat_cache unreadable");
    expect(result.error).toContain("semantic_entities unreadable");
    expect(spy.calls.length).toBe(0);
    // Both classes record their attempt, so both halves of the page say why.
    expect(scans.map((c) => c.sourceClass).toSorted()).toEqual(["chat", "warehouse"]);
  });

  it("a PERSIST failure is a failed class, and the ATTEMPT is still recorded", async () => {
    const seen: { workspaceId: string; ok: boolean }[] = [];
    const persist: NonNullable<CoverageSnapshotDeps["persist"]> = async (params) => {
      seen.push({ workspaceId: params.workspaceId, ok: params.outcome.ok });
      // Throw on the FIRST call for ws-1 (the real write) but not on the
      // recorded-attempt retry, which is the write the fix adds.
      if (params.workspaceId === "ws-1" && params.outcome.ok) {
        throw new Error("deadlock detected");
      }
      if (!params.outcome.ok) return { status: "failure" };
      return {
        status: "success",
        written: 0,
        retired: 0,
        surveyed: 0,
        labelled: 0,
        collapsed: false,
        degraded: [],
      };
    };
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
    expect(result).toMatchObject({ status: "degraded", enumerationsFailed: 1, enumerationsSucceeded: 1 });
    // ⚠️ THREE calls, not two: ws-1's failed write, ws-1's recorded ATTEMPT, and
    // ws-2. Without the middle one `last_attempt_at` stays frozen and
    // `last_error` stays NULL, so the page renders a clean, dated, STALE
    // statement with no error state — M1's green-while-broken shape.
    expect(seen).toEqual([
      { workspaceId: "ws-1", ok: true },
      { workspaceId: "ws-1", ok: false },
      { workspaceId: "ws-2", ok: true },
    ]);
  });

  it("survives the recorded attempt ALSO failing, and does not lose the cycle", async () => {
    // The database is refusing everything. There is nowhere left to record it —
    // the assertion is that the cycle still finishes and still tallies.
    const persist: NonNullable<CoverageSnapshotDeps["persist"]> = async () => {
      throw new Error("connection terminated");
    };
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
    expect(result).toMatchObject({ status: "degraded", enumerationsFailed: 2, enumerationsSucceeded: 0 });
    // ⚠️ And a REASON travels. Write failures used to reach `error` never, so a
    // cycle in which every persist threw returned `{ degraded, error: null }`
    // while the status docstring claimed "`error` is non-null either way" — a
    // counterfactual comment on the one field an operator reads for the reason.
    expect(result.error).toContain("connection terminated");
  });

  it("survives the scan-failure RECORD also failing, and still finishes the cycle", async () => {
    const spy = persistSpy();
    const result = await withDatabaseUrl(() =>
      runCoverageSnapshotCycle({
        persist: spy.persist,
        recordScanFailure: async () => {
          throw new Error("connection terminated");
        },
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
    // The POSITIVE CONTROL: the other class still ran to completion.
    expect(result).toMatchObject({ status: "degraded", enumerationsSucceeded: 1 });
    expect(spy.calls.map((c) => c.sourceClass)).toEqual(["warehouse"]);
  });

  it("bounds the WORKSPACE reasons, and never crowds out the class-wide one", async () => {
    // `FAILURE_REASONS_MAX` was unfalsifiable: no test had more than two failing
    // workspaces, so deleting both guards — or setting the constant to 5000 —
    // stayed green. Eight failing workspaces plus one failed scan is what makes
    // the bound and its deliberate exception both observable.
    const workspaces = Array.from({ length: 8 }, (_v, i) => `ws-${i}`);
    const result = await withDatabaseUrl(() =>
      runCoverageSnapshotCycle({
        persist: async (params) => {
          if (!params.outcome.ok) return { status: "failure" };
          throw new Error(`write failed for ${params.workspaceId}`);
        },
        recordScanFailure: async () => 1,
        isEnabled: () => true,
        plans: plans({
          chat: {
            kind: "enumerates",
            listWorkspaces: async () => workspaces,
            enumerate: async () => OK,
          },
          warehouse: {
            kind: "enumerates",
            listWorkspaces: async () => {
              throw new Error("semantic_entities unreadable");
            },
            enumerate: async () => OK,
          },
        }),
      }),
    );
    const reasons = (result.error ?? "").split("; ");
    // FIVE workspace reasons plus ONE uncapped scan reason — six, not eight and
    // not five. Three distinct numbers in one assertion.
    expect(reasons.length).toBe(6);
    expect(result.error).toContain("semantic_entities unreadable");
    expect(result.enumerationsFailed).toBe(8);
  });

  it("reads the workspace OVERRIDE, not only the platform value", async () => {
    // The seam the setting exists for — `scope: "workspace"` — and every
    // dispatch test injects `isEnabled`, so dropping the `workspaceId` argument
    // to `getSettingAuto` left a tenant's OFF switch inert with all green.
    const key = "ATLAS_BRAIN_COVERAGE_SNAPSHOT_ENABLED";
    const prior = process.env[key];
    delete process.env[key];
    try {
      // Platform default is ON, so the no-argument read is the control.
      expect(isCoverageSnapshotEnabled()).toBe(true);
      // A workspace argument must reach the resolver. With the argument dropped
      // this call would answer identically to the one above for every input,
      // which is what makes the pair — not either half — the assertion.
      expect(isCoverageSnapshotEnabled("ws-with-no-override")).toBe(true);
    } finally {
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
  });

  it("threads the tenant's OFF switch into the class-wide scan-failure record", async () => {
    // The `-pg` suite proves `recordClassScanFailure` HONOURS the filter; this
    // proves the scheduler SUPPLIES it. Two halves, and the mutation that
    // replaces the call site's `includeWorkspace` with `() => true` is invisible
    // to the first half.
    let probe: ((workspaceId: string) => boolean) | undefined;
    await withDatabaseUrl(() =>
      runCoverageSnapshotCycle({
        persist: persistSpy().persist,
        recordScanFailure: async (p) => {
          probe = p.includeWorkspace;
          return 0;
        },
        isEnabled: (workspaceId) => workspaceId !== "ws-off",
        plans: plans({
          chat: {
            kind: "enumerates",
            listWorkspaces: async () => {
              throw new Error("chat_cache unreadable");
            },
            enumerate: async () => OK,
          },
        }),
      }),
    );
    expect(probe).toBeDefined();
    // The filter must REFLECT the tenant decision, not merely exist: `() => true`
    // is defined too, and is exactly the mutation this catches.
    expect(probe?.("ws-off")).toBe(false);
    expect(probe?.("ws-on")).toBe(true);
  });

  it("threads ONE correlation id through every persist of a cycle", async () => {
    const spy = persistSpy();
    await withDatabaseUrl(() =>
      runCoverageSnapshotCycle({
        persist: spy.persist,
        isEnabled: () => true,
        plans: plans({
          chat: {
            kind: "enumerates",
            listWorkspaces: async () => ["ws-1", "ws-2"],
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
    const ids = new Set(spy.calls.map((c) => c.requestId));
    // ONE id across three enumerations of two classes — a per-call id would be
    // three, and `undefined` would be one too, so the second assertion is what
    // makes the first mean something.
    expect(ids.size).toBe(1);
    expect([...ids][0]).toMatch(/^cov-/);
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

describe("the platform gate and the cadence knob", () => {
  /** Set an env-backed setting for one test, then restore it. */
  function withEnv<T>(key: string, value: string | undefined, fn: () => T): T {
    const prior = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    try {
      return fn();
    } finally {
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
  }

  it("declares its default ON in the SETTINGS REGISTRY, which is where it can flip", () => {
    // ⚠️ The reader's own `!== "false"` is NOT the thing that could turn this
    // feature off. `getSettingAuto` falls back to the registry default, so with
    // `default: "true"` the reader answers `true` under either spelling — a
    // mutation to `=== "true"` is EQUIVALENT and no reader test can see it. The
    // registry entry is the flippable half, so that is what is pinned.
    const entry = getSettingsRegistry().find(
      (e) => e.key === "ATLAS_BRAIN_COVERAGE_SNAPSHOT_ENABLED",
    );
    expect(entry?.default).toBe("true");
    expect(entry?.scope).toBe("workspace");
    // Not readable or writable by a workspace admin on Cloud — the cycle reads a
    // tenant's vendor rosters, and the decision is a platform admin's.
    expect(entry?.saasVisible).toBe(false);
  });

  it("is ON by default, and OFF only on the literal `false`", () => {
    // The default is the whole feature: `!== "false"` flipped to `=== "true"`
    // would disable the cycle in every deployment with the dispatch tests all
    // green, because every one of them injects `isEnabled`.
    expect(withEnv("ATLAS_BRAIN_COVERAGE_SNAPSHOT_ENABLED", undefined, () =>
      isCoverageSnapshotEnabled(),
    )).toBe(true);
    expect(withEnv("ATLAS_BRAIN_COVERAGE_SNAPSHOT_ENABLED", "false", () =>
      isCoverageSnapshotEnabled(),
    )).toBe(false);
    // A POSITIVE CONTROL on the same reader: without it, "false disables it" is
    // satisfied by a reader that returns `false` for everything.
    expect(withEnv("ATLAS_BRAIN_COVERAGE_SNAPSHOT_ENABLED", "true", () =>
      isCoverageSnapshotEnabled(),
    )).toBe(true);
  });

  it("reads the knob rather than returning the default whatever it says", () => {
    // ⚠️ The `raw === undefined` early return is UNREACHABLE — `getSettingAuto`
    // falls back to the registry default `"60"`, which parses to exactly
    // `DEFAULT_COVERAGE_SNAPSHOT_INTERVAL_MS`. So a test that only checked the
    // unset case would be green against `return DEFAULT_…` with the knob
    // ignored entirely. A DIFFERENT value is what makes the branch observable.
    expect(withEnv("ATLAS_BRAIN_COVERAGE_SNAPSHOT_INTERVAL_MINUTES", "30", () =>
      getCoverageSnapshotIntervalMs(),
    )).toBe(30 * 60_000);
    expect(withEnv("ATLAS_BRAIN_COVERAGE_SNAPSHOT_INTERVAL_MINUTES", undefined, () =>
      getCoverageSnapshotIntervalMs(),
    )).toBe(DEFAULT_COVERAGE_SNAPSHOT_INTERVAL_MS);
  });

  it("falls back on a non-positive or unparseable knob", () => {
    for (const bad of ["0", "-5", "abc", " "]) {
      expect(withEnv("ATLAS_BRAIN_COVERAGE_SNAPSHOT_INTERVAL_MINUTES", bad, () =>
        getCoverageSnapshotIntervalMs(),
      )).toBe(DEFAULT_COVERAGE_SNAPSHOT_INTERVAL_MS);
    }
  });

  it("is an HOUR by default, not a minute — a roster changes on a human timescale", () => {
    expect(DEFAULT_COVERAGE_SNAPSHOT_INTERVAL_MS).toBe(60 * 60_000);
  });

  it("scans PUBLISHED semantic entities for the warehouse workspace list", () => {
    // The `status = 'published'` filter is the argued half: draft-mode entities
    // are what a human is mid-editing, and counting them would put a denominator
    // behind a page nobody has published. Pinned on the statement because the
    // filter is one token and its removal is invisible in any behavioural test
    // that does not seed a draft.
    expect(WAREHOUSE_WORKSPACES_SQL).toContain("FROM semantic_entities");
    expect(WAREHOUSE_WORKSPACES_SQL).toContain("WHERE status = 'published'");
    expect(WAREHOUSE_WORKSPACES_SQL).toContain("SELECT DISTINCT org_id");
  });
});
