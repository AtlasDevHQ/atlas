/**
 * The warehouse producer's cadence trigger (#5228, ADR-0039).
 *
 * Four questions, and the order below is the order the issue asked them in:
 *
 *   1. **Enablement** — a workspace that has not opted in gets no scheduled run,
 *      and the default is off. The DEFAULT is asserted against the registry
 *      itself rather than restated, because a test that hardcodes `false` beside
 *      a registry that says `true` is green and wrong.
 *   2. **The lock** — every scheduled run goes through it, and a decline is
 *      counted apart from a success. `../../brain/__tests__/warehouse-run-lock-pg.test.ts`
 *      owns whether the lock actually excludes; this owns whether the cycle uses it.
 *   3. **The principal** — a scheduled run is distinguishable in the log from an
 *      operator-triggered one, and from the ATTRIBUTION principal, which is a
 *      third thing again.
 *   4. **The narrowing question** — why the cadence runs the whole reach. That
 *      one is a decision rather than a behaviour, so it is measured rather than
 *      asserted: `planWarehouseEmission` over a narrowed reach EMITS a pair the
 *      full reach REFUSES. See the block at the bottom.
 */

import { describe, expect, it } from "bun:test";
import { getSettingDefinition } from "@atlas/api/lib/settings";
import { makeProducerReach } from "@atlas/api/lib/brain/enrollment";
import {
  WAREHOUSE_PRODUCER_PRINCIPAL,
  planWarehouseEmission,
  runWarehouseProducer,
  type WarehouseEntityLookup,
  type WarehouseProducerReport,
} from "@atlas/api/lib/brain/warehouse-producer";
import type { WarehouseRunLockOutcome } from "@atlas/api/lib/brain/warehouse-run-lock";
import {
  DEFAULT_WAREHOUSE_CADENCE_INTERVAL_MS,
  MIN_WAREHOUSE_CADENCE_INTERVAL_MS,
  WAREHOUSE_CADENCE_PRINCIPAL,
  WAREHOUSE_CADENCE_DEFAULTS,
  WAREHOUSE_CADENCE_WORKSPACES_SQL,
  getWarehouseCadenceIntervalMs,
  isWarehouseCadenceEnabled,
  listEnrolledWorkspaces,
  runWarehouseCadenceCycle,
  type WarehouseCadenceDeps,
} from "@atlas/api/lib/scheduler/brain-warehouse-cadence";
import { withWarehouseRunLock } from "@atlas/api/lib/brain/warehouse-run-lock";

/** A report with the fields the cycle tallies; the rest are irrelevant here. */
function report(overrides: Partial<WarehouseProducerReport> = {}): WarehouseProducerReport {
  return {
    workspaceId: "ws",
    snapshotAt: "2026-08-16T00:00:00.000Z",
    enrolled: 1,
    entities: [],
    refusals: [],
    created: 0,
    corroborated: 0,
    entityEdges: { kind: "nothing-to-propose", entries: 0, ambiguous: 0, selfEdges: 0, unmintedIds: 0 },
    ...overrides,
  };
}

/**
 * Every seam injected, so the cycle under test is the cycle and nothing else.
 *
 * `withLock` defaults to a PASS-THROUGH that reports it acquired — the honest
 * default for a suite whose subject is the cycle's bookkeeping. A test that wants
 * a decline says so.
 */
function deps(overrides: Partial<WarehouseCadenceDeps> = {}): WarehouseCadenceDeps {
  return {
    listWorkspaces: async () => ["ws-a", "ws-b"],
    isEnabled: () => true,
    runProducer: async () => report(),
    withLock: async <T,>(_workspaceId: string, fn: () => Promise<T>) =>
      ({ acquired: true, value: await fn() }) satisfies WarehouseRunLockOutcome<T>,
    now: () => new Date("2026-08-16T00:00:00.000Z"),
    ...overrides,
  };
}

describe("warehouse cadence — enablement", () => {
  it("ships OFF by default, per the registry", () => {
    // Read from the registry, not restated. `ATLAS_BRAIN_COVERAGE_SNAPSHOT_ENABLED`
    // and `ATLAS_BRAIN_AUDIENCE_SYNC_ENABLED` both default `"true"`, and copying
    // a neighbour's default is exactly how this one would silently become a
    // sweep — which is the thing ADR-0039 rejects by name.
    const def = getSettingDefinition("ATLAS_BRAIN_WAREHOUSE_CADENCE_ENABLED");
    expect(def?.default).toBe("false");
    // Workspace-scoped: the tenant enrolled the pairs and staffs the review queue.
    expect(def?.scope).toBe("workspace");
  });

  /**
   * ⚠️ **These three exercise `isWarehouseCadenceEnabled` ITSELF, and they exist
   * because the tests around them could not.** Every behavioural test in this
   * file injects `isEnabled`, and the default assertion above reads the registry
   * — so flipping the predicate from `=== "true"` to its neighbours' `!== "false"`
   * killed NOTHING. Measured, not suspected: the mutation ran green across all
   * every test in this file.
   *
   * The two spellings are not equivalent, and the difference is the whole point
   * of the split. They agree on `"true"` and `"false"`; they disagree on
   * everything else, and everything else is where an env-var override lands. The
   * admin PUT route validates a `boolean` setting to exactly `"true"`/`"false"`,
   * but `ATLAS_BRAIN_WAREHOUSE_CADENCE_ENABLED=1` in a deploy config never meets
   * that route.
   */
  describe("the predicate itself", () => {
    function withEnv(value: string | undefined, assertion: () => void): void {
      const prior = process.env.ATLAS_BRAIN_WAREHOUSE_CADENCE_ENABLED;
      if (value === undefined) delete process.env.ATLAS_BRAIN_WAREHOUSE_CADENCE_ENABLED;
      else process.env.ATLAS_BRAIN_WAREHOUSE_CADENCE_ENABLED = value;
      try {
        assertion();
      } finally {
        if (prior === undefined) delete process.env.ATLAS_BRAIN_WAREHOUSE_CADENCE_ENABLED;
        else process.env.ATLAS_BRAIN_WAREHOUSE_CADENCE_ENABLED = prior;
      }
    }

    it("opts a workspace in only on the exact string `true`", () => {
      withEnv("true", () => expect(isWarehouseCadenceEnabled("ws-a")).toBe(true));
    });

    it.each(["1", "yes", "TRUE", ""])(
      "stays OFF for the truthy-looking spelling %p — fail closed, not fail friendly",
      (value) => {
        // This is the arm `!== "false"` gets wrong, and it gets it wrong in the
        // direction ADR-0039 cares about: an operator who typed `1` gets
        // scheduled runs filing drafts into a queue nobody agreed to staff.
        withEnv(value, () => expect(isWarehouseCadenceEnabled("ws-a")).toBe(false));
      },
    );

    it("stays OFF when nothing is set at all", () => {
      withEnv(undefined, () => expect(isWarehouseCadenceEnabled("ws-a")).toBe(false));
    });
  });

  it("runs nothing for a workspace that has not opted in", async () => {
    const attempted: string[] = [];
    const result = await runWarehouseCadenceCycle(
      deps({
        isEnabled: (workspaceId) => workspaceId === "ws-b",
        runProducer: async (p) => {
          attempted.push(p.workspaceId);
          return report();
        },
      }),
    );

    expect(attempted).toEqual(["ws-b"]);
    expect(result.workspacesConsidered).toBe(2);
    expect(result.workspacesSkippedDisabled).toBe(1);
    expect(result.workspacesAttempted).toBe(1);
    expect(result.status).toBe("success");
  });

  it("considers only workspaces that have ENROLLED something", () => {
    // A workspace with an empty reach can only produce an empty report, so
    // dispatching on `brain_enrollment` rather than on the tenant list keeps a
    // fleet-wide read from buying a guaranteed no-op. Pinned as text because the
    // TABLE is the decision — `semantic_entities` is the coverage cycle's answer
    // to a different question and would silently widen this one.
    expect(WAREHOUSE_CADENCE_WORKSPACES_SQL).toContain("FROM brain_enrollment");
    expect(WAREHOUSE_CADENCE_WORKSPACES_SQL).toContain("DISTINCT workspace_id");
    expect(WAREHOUSE_CADENCE_WORKSPACES_SQL).not.toContain("semantic_entities");
  });
});

/**
 * ⚠️ **The production wiring had no reader at all, and that is the same class as
 * the `isEnabled` survivor one file over.** Every seam is optional and the shared
 * `deps()` helper injects all four, so defaulting `withLock` to a pass-through —
 * the scheduled trigger taking NO LOCK, which is the entire subject of this
 * issue — left the whole suite green. Identity assertions are the cheapest
 * thing that can fail here.
 */
describe("warehouse cadence — the production wiring", () => {
  it("defaults the lock seam to the REAL run lock", () => {
    expect(WAREHOUSE_CADENCE_DEFAULTS.withLock).toBe(withWarehouseRunLock);
  });

  it("defaults the producer, enablement and workspace-scan seams to the real ones", () => {
    expect(WAREHOUSE_CADENCE_DEFAULTS.runProducer).toBe(runWarehouseProducer);
    expect(WAREHOUSE_CADENCE_DEFAULTS.isEnabled).toBe(isWarehouseCadenceEnabled);
    // `listWorkspaces` had only a BEHAVIOUR test (it answers `[]` with no DB),
    // which `async () => []` satisfies — so the substitute that makes the cadence
    // silently consider zero workspaces forever was green.
    expect(WAREHOUSE_CADENCE_DEFAULTS.listWorkspaces).toBe(listEnrolledWorkspaces);
  });

  /**
   * ⚠️ **These two are the ones that matter, and the identity block above is not
   * a substitute for them.** The identity assertions pin the CONSTANT; the cycle
   * reads the constant at its own use site, and nothing tied the two together —
   * so replacing just the `withLock` fallback with a pass-through, leaving
   * `WAREHOUSE_CADENCE_DEFAULTS` untouched, left the whole suite green. Measured.
   * The tests below call the cycle with the seam OMITTED, so they observe the
   * resolution rather than the table.
   */
  it("reaches the REAL lock when the withLock seam is not injected", async () => {
    let produced = 0;
    const result = await runWarehouseCadenceCycle({
      listWorkspaces: async () => ["ws-x"],
      isEnabled: () => true,
      runProducer: async () => {
        produced++;
        return report();
      },
      // withLock deliberately NOT injected.
    });

    // No internal DB in this suite, so the real lock's `connect()` throws, the
    // per-workspace catch counts it, and the producer never runs. A pass-through
    // default would have run it and reported success — which is this issue's
    // entire defect.
    expect(produced).toBe(0);
    expect(result.workspacesFailed).toBe(1);
    expect(result.workspacesSucceeded).toBe(0);
  });

  it("reaches the REAL enablement read when the isEnabled seam is not injected", async () => {
    let produced = 0;
    const result = await runWarehouseCadenceCycle({
      listWorkspaces: async () => ["ws-x"],
      runProducer: async () => {
        produced++;
        return report();
      },
      withLock: async <T,>(_w: string, fn: () => Promise<T>) => ({
        acquired: true as const,
        value: await fn(),
      }),
      // isEnabled deliberately NOT injected — and the env var is unset, so the
      // registry default (`"false"`) is what decides.
    });

    // `() => true` as the default would be the sweep ADR-0039 rejects, arriving
    // as a default rather than as a feature.
    expect(produced).toBe(0);
    expect(result.workspacesSkippedDisabled).toBe(1);
  });

  it("answers NO enrolled workspaces — not an error — when there is no internal DB", async () => {
    // ⚠️ Reachable only because the defaults are hoisted; `listEnrolledWorkspaces`
    // is module-private. Deleting its `hasInternalDB()` guard used to change
    // nothing here, and in production it turns a supported self-hosted
    // configuration into a `status: "failure"` plus an error log every single
    // tick, forever — which the function's own docstring calls "not an outage".
    expect(await WAREHOUSE_CADENCE_DEFAULTS.listWorkspaces()).toEqual([]);
  });
});

describe("warehouse cadence — the lock", () => {
  it("takes the run lock for EVERY scheduled run", async () => {
    const locked: string[] = [];
    await runWarehouseCadenceCycle(
      deps({
        withLock: async <T,>(workspaceId: string, fn: () => Promise<T>) => {
          locked.push(workspaceId);
          return { acquired: true, value: await fn() };
        },
      }),
    );

    expect(locked).toEqual(["ws-a", "ws-b"]);
  });

  it("counts a decline apart from a success, and does not run the producer", async () => {
    let produced = 0;
    const result = await runWarehouseCadenceCycle(
      deps({
        // ws-a declines, ws-b acquires — DIFFERENT counts on purpose. With both
        // declining, `declinedLocked` and `attempted` would be the same number
        // and a fix that conflated them would still pass.
        withLock: async <T,>(workspaceId: string, fn: () => Promise<T>) =>
          workspaceId === "ws-a"
            ? { acquired: false }
            : { acquired: true, value: await fn() },
        runProducer: async () => {
          produced++;
          return report({ created: 3 });
        },
      }),
    );

    expect(produced).toBe(1);
    expect(result.workspacesDeclinedLocked).toBe(1);
    expect(result.workspacesSucceeded).toBe(1);
    expect(result.workspacesAttempted).toBe(2);
    expect(result.created).toBe(3);
    // ⚠️ `success`, not `degraded`. Declining IS the lock working; reporting it
    // as degradation would page somebody every time an operator pressed Run
    // while a tick was in flight.
    expect(result.status).toBe("success");
  });

  it("still reports success when EVERY workspace declined", async () => {
    // The case the result docstring names by hand. With only the mixed test
    // above, a status rule that special-cased "all declined" as degraded stayed
    // green — and it would page an operator every time a tick landed behind a
    // long-running run, which is the ordinary shape of a busy workspace.
    const result = await runWarehouseCadenceCycle(
      deps({ withLock: async () => ({ acquired: false }) }),
    );

    expect(result.workspacesDeclinedLocked).toBe(2);
    expect(result.workspacesSucceeded).toBe(0);
    expect(result.status).toBe("success");
    expect(result.error).toBeNull();
  });

  it("runs workspaces SEQUENTIALLY — never two locked runs in flight at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await runWarehouseCadenceCycle(
      deps({
        listWorkspaces: async () => ["ws-a", "ws-b", "ws-c"],
        runProducer: async () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight--;
          return report();
        },
      }),
    );

    // Each locked run pins one of the internal pool's five clients for its whole
    // duration and checks out more inside itself. A `Promise.all` here would let
    // a handful of tenants starve the pool the whole process shares.
    expect(maxInFlight).toBe(1);
  });
});

describe("warehouse cadence — what it tallies", () => {
  it("counts refusals across workspaces", async () => {
    // Every `report()` defaulted to `refusals: []`, so deleting the tally line
    // entirely stayed green — and that counter rides a span attribute, so a
    // fleet where every pair is being refused would report zero refusals.
    const refusal = {
      entity: "accounts",
      dimension: "status",
      reason: "ambiguous-dimension" as const,
      message: "enrolled on two entities",
    };
    const result = await runWarehouseCadenceCycle(
      deps({
        // Deliberately unequal to `created` and `corroborated` so a tally
        // reading the wrong field cannot pass.
        runProducer: async (p) =>
          p.workspaceId === "ws-a"
            ? report({ refusals: [refusal, refusal], created: 1 })
            : report({ refusals: [refusal], created: 1 }),
      }),
    );

    expect(result.refusalsTotal).toBe(3);
    expect(result.created).toBe(2);
  });

  it("flags a run whose ENTITY-EDGE PASS threw, without demoting it to a failure", async () => {
    // The run committed its facts, so it is a success — but `proposeAliasEdges`
    // commits per proposal, so a mid-batch throw has already re-keyed part of
    // the corpus. Dropping this made a partial, corpus-mutating failure
    // byte-identical to a clean run.
    const result = await runWarehouseCadenceCycle(
      deps({
        runProducer: async (p) =>
          p.workspaceId === "ws-a"
            ? report({
                created: 1,
                entityEdges: {
                  kind: "failed",
                  // The LAST phase — a batch that was half-committed, which is
                  // the arm with corpus consequences. `store-read` (never read)
                  // is the harmless end of the same union.
                  reached: {
                    phase: "proposing",
                    entries: 3,
                    ambiguous: 0,
                    selfEdges: 0,
                    unmintedIds: 0,
                    proposalsAttempted: 2,
                  },
                  message: "edge pass threw",
                },
              })
            : report({ created: 1 }),
      }),
    );

    expect(result.workspacesEdgePassFailed).toBe(1);
    // Still counted as succeeded — the facts landed — and the cycle is not
    // degraded, because nothing threw out of the run.
    expect(result.workspacesSucceeded).toBe(2);
    expect(result.status).toBe("success");
    // The span's `error` names it too. Without this, a tick where every edge
    // pass threw reports `status: "success"` and `error: null`, so the two
    // attributes an alert is built on both say nothing happened.
    expect(result.error).toContain("entity-edge pass failed at proposing");
  });

  it("does not flag the HEALTHY `proposed` arm — the union has three members", async () => {
    // ⚠️ The fixtures used only `nothing-to-propose` and `failed`, so widening
    // the check to `!== "nothing-to-propose"` was green — and in production that
    // raises the counter on every clean run that actually had edges to propose,
    // i.e. pages a human about success. The third arm is the whole test.
    const result = await runWarehouseCadenceCycle(
      deps({
        listWorkspaces: async () => ["ws-a", "ws-b", "ws-c"],
        runProducer: async (p) => {
          if (p.workspaceId === "ws-a") {
            return report({
              entityEdges: {
                kind: "failed",
                reached: {
                  phase: "proposing",
                  entries: 3,
                  ambiguous: 0,
                  selfEdges: 0,
                  unmintedIds: 0,
                  proposalsAttempted: 2,
                },
                message: "edge pass threw",
              },
            });
          }
          if (p.workspaceId === "ws-b") {
            return report({
              entityEdges: {
                kind: "proposed",
                entries: 4,
                ambiguous: 0,
                selfEdges: 0,
                unmintedIds: 0,
                counters: {
                  queued: 4,
                  autoApproved: 0,
                  deduped: 0,
                  alreadyApproved: 0,
                  rejected: 0,
                  refused: 0,
                },
              },
            });
          }
          return report();
        },
      }),
    );

    // Exactly ONE — the failed arm. Three succeeded.
    expect(result.workspacesEdgePassFailed).toBe(1);
    expect(result.workspacesSucceeded).toBe(3);
  });
});

describe("warehouse cadence — the audit trail", () => {
  it("passes the producer EXACTLY the run context, and nothing that narrows it", async () => {
    // ⚠️ Asserted as a WHOLE OBJECT. Collecting `workspaceId`/`triggeredBy`/
    // `requestId` into three separate arrays let a fourth key — say an
    // `entities: [...]` narrowing argument, which is precisely the whole-reach
    // decision this issue records — be added with every test still green. A
    // deep-equal is what makes that decision enforceable rather than merely
    // documented.
    const calls: unknown[] = [];
    await runWarehouseCadenceCycle(
      deps({
        listWorkspaces: async () => ["ws-a"],
        runProducer: async (p) => {
          calls.push(p);
          return report();
        },
      }),
    );

    expect(calls).toEqual([
      {
        workspaceId: "ws-a",
        triggeredBy: WAREHOUSE_CADENCE_PRINCIPAL,
        requestId: expect.stringMatching(/^whc-/) as unknown,
      },
    ]);
  });

  it("triggers under a principal distinguishable from an operator's and from the attribution", async () => {
    const seen: string[] = [];
    await runWarehouseCadenceCycle(
      deps({
        runProducer: async (p) => {
          seen.push(p.triggeredBy);
          return report();
        },
      }),
    );

    expect(seen).toEqual([WAREHOUSE_CADENCE_PRINCIPAL, WAREHOUSE_CADENCE_PRINCIPAL]);
    // A `system:` stem an operator's user id cannot wear, so a log grep splits
    // the two without knowing any user id.
    expect(WAREHOUSE_CADENCE_PRINCIPAL.startsWith("system:")).toBe(true);
    // ⚠️ And NOT the attribution principal. Those are different fields answering
    // different questions — `WAREHOUSE_PRODUCER_PRINCIPAL` is who the claim is
    // FROM (the machine that read the warehouse, on both triggers), this is who
    // ASKED. Collapsing them would make a scheduled run and an operator's
    // indistinguishable at rest, which is the criterion.
    expect(WAREHOUSE_CADENCE_PRINCIPAL).not.toBe(WAREHOUSE_PRODUCER_PRINCIPAL);
  });

  it("gives the whole tick one correlation id, stemmed so it is not mistaken for a request id", async () => {
    const seen: string[] = [];
    await runWarehouseCadenceCycle(
      deps({
        runProducer: async (p) => {
          seen.push(p.requestId);
          return report();
        },
      }),
    );

    // The producer's own log lines are keyed by `requestId`, and a background
    // fiber has none — without this, a `snapshot-failed` refusal (which returns
    // successfully and exists nowhere but the log) has nothing to group by.
    // ⚠️ The instant is asserted, not just the stem: `whc-` alone was satisfied
    // by a hardcoded constant, which makes two ticks share one id and defeats
    // the "pull a whole tick out of the log" purpose entirely.
    expect(seen[0]).toMatch(/^whc-\d{4}-\d{2}-\d{2}T[\d:.]+Z-[a-z0-9]+$/);
    expect(seen[0]).toBe(seen[1] as string);
  });

  it("mints a DIFFERENT correlation id per tick, from the injected clock", async () => {
    const idOf = async (at: string): Promise<string> => {
      const seen: string[] = [];
      await runWarehouseCadenceCycle(
        deps({
          listWorkspaces: async () => ["ws-a"],
          now: () => new Date(at),
          runProducer: async (p) => {
            seen.push(p.requestId);
            return report();
          },
        }),
      );
      return seen[0] as string;
    };

    const first = await idOf("2026-08-16T00:00:00.000Z");
    const second = await idOf("2026-08-17T00:00:00.000Z");

    // Two ticks, two ids. A constant satisfied every other assertion in the file.
    expect(first).not.toBe(second);
    // And the `now` seam is actually read — otherwise it is dead weight the
    // tests pretend to exercise.
    expect(first).toContain("2026-08-16T00:00:00.000Z");
    expect(second).toContain("2026-08-17T00:00:00.000Z");
  });
});

describe("warehouse cadence — failure handling", () => {
  it("keeps going when one workspace's run throws, and reports degraded", async () => {
    const result = await runWarehouseCadenceCycle(
      deps({
        listWorkspaces: async () => ["ws-a", "ws-b", "ws-c"],
        runProducer: async (p) => {
          if (p.workspaceId === "ws-a") throw new Error("warehouse unreachable");
          return report({ created: 2, corroborated: 5 });
        },
      }),
    );

    expect(result.status).toBe("degraded");
    expect(result.workspacesFailed).toBe(1);
    // The other two still ran — one tenant's broken datasource must not stop the
    // fleet's cadence.
    expect(result.workspacesSucceeded).toBe(2);
    expect(result.created).toBe(4);
    expect(result.corroborated).toBe(10);
    expect(result.error).toContain("warehouse unreachable");
    // PREFIXED with the workspace. Bare, a fleet-wide fault reads
    // "connection terminated; connection terminated; …" and an operator cannot
    // tell one tenant retrying from three tenants down.
    expect(result.error).toContain("ws-a");
  });

  it("does not lose the whole tick when a workspace's ENABLEMENT read throws", async () => {
    // `isEnabled` used to sit outside the per-workspace try. A settings read
    // throwing for one workspace aborted the cycle, discarded every counter
    // already accumulated, and produced no result and no span at all — a fourth
    // outcome the `status` union cannot express.
    const result = await runWarehouseCadenceCycle(
      deps({
        listWorkspaces: async () => ["ws-a", "ws-b"],
        isEnabled: (workspaceId) => {
          if (workspaceId === "ws-a") throw new Error("settings cache corrupt");
          return true;
        },
      }),
    );

    expect(result.status).toBe("degraded");
    expect(result.workspacesFailed).toBe(1);
    expect(result.workspacesSucceeded).toBe(1);
    expect(result.error).toContain("settings cache corrupt");
    // ⚠️ And it says WHICH fault. Folded into the run's catch, the same throw
    // reads "a scheduled producer run failed" — for a workspace where no run was
    // attempted and nothing touched the warehouse, sending an operator to the
    // customer's datasource for a defect in Atlas's settings path. Asserting only
    // the counters left that message free to be wrong.
    expect(result.error).toContain("enablement read failed");
    // NOT attempted: the run never started, so the counter must not claim it did.
    expect(result.workspacesAttempted).toBe(1);
  });

  it("puts a workspace in exactly ONE bucket when the producer's report is malformed", async () => {
    // ⚠️ **The guard is the ORDER of two statements, and only a drifted report
    // can see it.** Every read off `report` happens before `workspacesSucceeded++`
    // — with the increment first, a report missing `refusals` threw AFTER the
    // workspace was counted succeeded, the catch then counted it failed, and the
    // counters stopped partitioning: `succeeded + failed > attempted`, with
    // `status: degraded` blaming the producer for a report-shape defect.
    //
    // Every other fixture in this file is well-formed, so the ordering was
    // unfalsifiable until this test existed.
    const result = await runWarehouseCadenceCycle(
      deps({
        listWorkspaces: async () => ["ws-a"],
        runProducer: async () =>
          // A report that lost `refusals` — the degraded-report case the route
          // suite models the same way.
          ({ ...report(), refusals: undefined }) as unknown as WarehouseProducerReport,
      }),
    );

    expect(result.workspacesAttempted).toBe(1);
    expect(result.workspacesSucceeded + result.workspacesFailed).toBe(1);
    expect(result.workspacesSucceeded).toBe(0);
    expect(result.workspacesFailed).toBe(1);
  });

  it("keeps identically-failing workspaces DISTINCT rather than collapsing them", async () => {
    // ⚠️ Renamed from "de-duplicates one fault shared by many workspaces", which
    // was the opposite of what it asserted: three reasons from three
    // identically-failing workspaces is the NON-deduplicated answer. The old name
    // described a `reasons.includes` guard that the workspace prefix had already
    // made unreachable — deleting that guard changed nothing, so the test was
    // certifying dead code.
    const result = await runWarehouseCadenceCycle(
      deps({
        listWorkspaces: async () => ["ws-a", "ws-b", "ws-c"],
        runProducer: async () => {
          throw new Error("internal db unreachable");
        },
      }),
    );

    expect(result.workspacesFailed).toBe(3);
    // The CONTENT, not just the count: three tenants down must be attributable to
    // three tenants, which is the whole reason the prefix exists.
    expect(result.error?.split("; ").map((r) => r.split(":")[0])).toEqual([
      "ws-a",
      "ws-b",
      "ws-c",
    ]);
  });

  it("bounds the reason list, keeps the FIRST five, and counts the overflow", async () => {
    const result = await runWarehouseCadenceCycle(
      deps({
        listWorkspaces: async () => ["w1", "w2", "w3", "w4", "w5", "w6", "w7"],
        runProducer: async () => {
          throw new Error("warehouse down");
        },
      }),
    );

    expect(result.workspacesFailed).toBe(7);
    const parts = result.error?.split("; ") ?? [];
    // ⚠️ WHICH five, not just how many. Asserting only the length let a bound
    // that keeps the LAST five (push-then-shift) pass identically — and the two
    // differ for an operator reading a truncated list.
    expect(parts.slice(0, 5).map((r) => r.split(":")[0])).toEqual(["w1", "w2", "w3", "w4", "w5"]);
    // The overflow ANNOUNCES itself. A truncated string with no "+N more" is one
    // an operator reads as the complete list of what went wrong.
    expect(parts[5]).toContain("+2 further faults");
    expect(parts[5]).toContain("whc-");
  });

  it("reports FAILURE, not success, when the workspace scan itself throws", async () => {
    const result = await runWarehouseCadenceCycle(
      deps({
        listWorkspaces: async () => {
          throw new Error("internal db down");
        },
      }),
    );

    // A cycle that does not know which workspaces exist has nothing it can
    // honestly do — and "zero workspaces, all fine" is the reading that would
    // hide a fleet-wide outage behind a green tick.
    expect(result.status).toBe("failure");
    expect(result.workspacesConsidered).toBe(0);
    expect(result.error).toContain("internal db down");
  });
});

describe("warehouse cadence — the interval knob", () => {
  function withIntervalEnv(value: string | undefined, assertion: () => void): void {
    const prior = process.env.ATLAS_BRAIN_WAREHOUSE_CADENCE_INTERVAL_HOURS;
    if (value === undefined) delete process.env.ATLAS_BRAIN_WAREHOUSE_CADENCE_INTERVAL_HOURS;
    else process.env.ATLAS_BRAIN_WAREHOUSE_CADENCE_INTERVAL_HOURS = value;
    try {
      assertion();
    } finally {
      if (prior === undefined) delete process.env.ATLAS_BRAIN_WAREHOUSE_CADENCE_INTERVAL_HOURS;
      else process.env.ATLAS_BRAIN_WAREHOUSE_CADENCE_INTERVAL_HOURS = prior;
    }
  }

  it("has a constant FLOOR below the configurable value", () => {
    // The knob is open in the safe direction (longer) and stopped by a constant
    // in the unsafe one, which is `WAREHOUSE_ROW_CAP`'s argument applied to time:
    // a shorter cadence is a claim about how much a human can review.
    expect(MIN_WAREHOUSE_CADENCE_INTERVAL_MS).toBeLessThan(
      DEFAULT_WAREHOUSE_CADENCE_INTERVAL_MS,
    );
    expect(MIN_WAREHOUSE_CADENCE_INTERVAL_MS).toBe(60 * 60_000);
    expect(DEFAULT_WAREHOUSE_CADENCE_INTERVAL_MS).toBe(24 * 60 * 60_000);
  });

  it("declares the interval where a human can change it without a deploy", () => {
    const def = getSettingDefinition("ATLAS_BRAIN_WAREHOUSE_CADENCE_INTERVAL_HOURS");
    expect(def?.type).toBe("number");
    // Platform-scoped: the cost it governs — a warehouse read per enrolled
    // workspace per tick — is the operator's.
    expect(def?.scope).toBe("platform");
    // ⚠️ Tied ARITHMETICALLY to the constant rather than restated as `"24"`.
    // The registry default, `DEFAULT_WAREHOUSE_CADENCE_INTERVAL_MS` and the
    // customer-facing description are three hand-maintained spellings of one
    // number; a literal here agrees with the registry by construction and lets
    // all three drift together while staying green.
    expect(Number(def?.default) * 60 * 60_000).toBe(DEFAULT_WAREHOUSE_CADENCE_INTERVAL_MS);
    expect(def?.description).toContain("default 24");
  });

  /**
   * ⚠️ **`getWarehouseCadenceIntervalMs` had NO caller in this suite**, so the
   * clamp, the non-finite guard and — worse — the setting KEY itself were all
   * unfalsifiable. A typo in the key compiles, returns `undefined`, and silently
   * yields the default forever. Its `isWarehouseCadenceEnabled` sibling was
   * pinned through the real env path; this one was not.
   */
  describe("read through the real settings path", () => {
    it("returns the default when unset", () => {
      withIntervalEnv(undefined, () =>
        expect(getWarehouseCadenceIntervalMs()).toBe(DEFAULT_WAREHOUSE_CADENCE_INTERVAL_MS),
      );
    });

    it("honours a LONGER cadence — the safe, unbounded direction", () => {
      withIntervalEnv("48", () =>
        expect(getWarehouseCadenceIntervalMs()).toBe(48 * 60 * 60_000),
      );
    });

    it("CLAMPS a shorter-than-floor cadence instead of honouring it", () => {
      // Without the clamp a `0.01` setting is a 36-second polling loop against a
      // customer warehouse, filing drafts faster than anyone can review them.
      withIntervalEnv("0.5", () =>
        expect(getWarehouseCadenceIntervalMs()).toBe(MIN_WAREHOUSE_CADENCE_INTERVAL_MS),
      );
    });

    it.each(["0", "-3"])(
      "falls back to the default — not the floor — on the non-positive value %p",
      (value) => {
        // ⚠️ Deleting `|| hours <= 0` was green, because these two inputs then
        // reach the CLAMP and come back as one hour. The registry description
        // promises "non-positive or unparseable values fall back to the default",
        // so the clamp answer is a documented-contract violation — and it is
        // distinguishable only because MIN (1h) and DEFAULT (24h) differ.
        withIntervalEnv(value, () =>
          expect(getWarehouseCadenceIntervalMs()).toBe(DEFAULT_WAREHOUSE_CADENCE_INTERVAL_MS),
        );
      },
    );

    it("falls back to the default on an unparseable value", () => {
      withIntervalEnv("abc", () =>
        expect(getWarehouseCadenceIntervalMs()).toBe(DEFAULT_WAREHOUSE_CADENCE_INTERVAL_MS),
      );
    });

    it("falls back to the default on a non-finite value", () => {
      // `Infinity` parses and is positive, so only the `Number.isFinite` guard
      // catches it. Left through, the fiber starts and never ticks — no error,
      // no log, just a cadence that silently does not exist.
      withIntervalEnv("Infinity", () =>
        expect(getWarehouseCadenceIntervalMs()).toBe(DEFAULT_WAREHOUSE_CADENCE_INTERVAL_MS),
      );
    });

    it("reads the numeric prefix of a trailing-unit value", () => {
      // `Number.parseFloat("48h")` is 48; `Number("48h")` is NaN, which falls
      // through to the default. This pins WHICH parser is in use, on exactly the
      // input an operator is most likely to type.
      //
      // ⚠️ **`48h`, not `24h`, and that is the whole test.** With `24h` the
      // parseFloat branch yields 24h and the NaN branch yields the DEFAULT —
      // which is also 24h — so the assertion could not tell them apart and the
      // `parseFloat` → `Number` mutation survived it. Measured, not spotted: the
      // first draft of this test passed against both parsers. The expected value
      // has to differ from the default for the branch to be observable.
      withIntervalEnv("48h", () =>
        expect(getWarehouseCadenceIntervalMs()).toBe(48 * 60 * 60_000),
      );
      expect(48 * 60 * 60_000).not.toBe(DEFAULT_WAREHOUSE_CADENCE_INTERVAL_MS);
    });
  });
});

/**
 * ## Why the cadence runs the WHOLE reach — measured, not asserted
 *
 * #5228 asks whether an on-enrollment trigger should emit for the newly enrolled
 * pair alone. The answer is no, and the reason is not cost: a narrowed plan does
 * not compute a cheaper version of the same answer, it computes a DIFFERENT one.
 *
 * ADR-0037 §4's fail-closed rule refuses a dimension name that is ambiguous
 * *across the entities it is producing from*, and `planWarehouseEmission` reads
 * "the entities it is producing from" off the reach it was handed. Narrow the
 * reach and the rule is evaluated over a narrower set.
 *
 * The pair of tests below is that difference, in the direction that matters: the
 * full reach REFUSES both sides, and the narrowed one EMITS. Emitting is the
 * irreversible direction — `warehouse-producer.ts` states it as *"a missing
 * warehouse fact is recoverable; a wrong `valid_to` stamp is not."*
 */
describe("warehouse cadence — the whole-reach decision", () => {
  const yaml = (table: string): WarehouseEntityLookup => ({
    kind: "found",
    entity: {
      name: table,
      table,
      connection: null,
      dimensions: [
        { name: "id", sql: "id", primaryKey: true },
        // ⚠️ `sql` differs from `name`, as every sibling suite's fixture does:
        // with them equal, emitting the COLUMN EXPRESSION as a predicate is
        // indistinguishable from emitting the bare name, and the bare name is
        // the whole emission contract.
        { name: "status", sql: "lifecycle_status", primaryKey: false },
      ],
      measures: new Set<string>(),
    },
  });
  const entities = new Map<string, WarehouseEntityLookup>([
    ["accounts", yaml("accounts")],
    ["contracts", yaml("contracts")],
  ]);
  const pair = (entity: string) => ({ entity, dimension: "status", naming: false });

  it("the FULL reach refuses `status` on both entities", () => {
    const plan = planWarehouseEmission(
      makeProducerReach([pair("accounts"), pair("contracts")]),
      entities,
    );

    expect(plan.emit).toHaveLength(0);
    expect(plan.refused.map((r) => `${r.entity}/${r.reason}`).sort()).toEqual([
      "accounts/ambiguous-dimension",
      "contracts/ambiguous-dimension",
    ]);
  });

  it("a reach NARROWED to the newly enrolled pair emits it instead — the fail-closed rule inverted", () => {
    // Exactly what an "emit for the newly enrolled pair only" trigger would
    // build: the reach is the one pair somebody just enrolled.
    const plan = planWarehouseEmission(makeProducerReach([pair("contracts")]), entities);

    // It EMITS. A `contracts / status / signed` claim would land beside the
    // `accounts / status / active` a full run refuses to choose between — which
    // is the collision ADR-0037 §4 refuses rather than arbitrates.
    expect(plan.refused).toHaveLength(0);
    expect(plan.emit).toHaveLength(1);
    expect(plan.emit[0]?.entity.name).toBe("contracts");
    expect(plan.emit[0]?.dimensions.map((d) => d.name)).toEqual(["status"]);
  });
});
