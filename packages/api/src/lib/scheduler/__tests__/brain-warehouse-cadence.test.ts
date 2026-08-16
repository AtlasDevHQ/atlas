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
 *      counted apart from a success. `../brain/__tests__/warehouse-run-lock-pg.test.ts`
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
  type WarehouseEntityLookup,
  type WarehouseProducerReport,
} from "@atlas/api/lib/brain/warehouse-producer";
import type { WarehouseRunLockOutcome } from "@atlas/api/lib/brain/warehouse-run-lock";
import {
  DEFAULT_WAREHOUSE_CADENCE_INTERVAL_MS,
  MIN_WAREHOUSE_CADENCE_INTERVAL_MS,
  WAREHOUSE_CADENCE_PRINCIPAL,
  WAREHOUSE_CADENCE_WORKSPACES_SQL,
  isWarehouseCadenceEnabled,
  runWarehouseCadenceCycle,
  type WarehouseCadenceDeps,
} from "@atlas/api/lib/scheduler/brain-warehouse-cadence";

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
   * fourteen tests.
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

describe("warehouse cadence — the audit trail", () => {
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
    expect(seen[0]).toStartWith("whc-");
    expect(seen[0]).toBe(seen[1] as string);
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
    expect(def?.default).toBe("24");
    // Platform-scoped: the cost it governs — a warehouse read per enrolled
    // workspace per tick — is the operator's.
    expect(def?.scope).toBe("platform");
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
