/**
 * `SemanticGenerator` service (#3506 — MCP V2 Blocker #1).
 *
 * Proves the shared profiling/semantic-generation seam end to end, independent
 * of the CLI:
 *
 *  - `profile` runs the (injected) dialect profiler, applies analysis
 *    heuristics, and surfaces `ProfilingFailedError` for the no-tables /
 *    threshold / unsupported-dbType cases;
 *  - `generate` assembles artifacts (delegates to the shared core);
 *  - `profileAndGenerate` ties them together and **populates the table
 *    whitelist**, so a freshly-profiled connection becomes queryable — the
 *    exact gap that made an MCP-created datasource connected-but-unqueryable.
 *
 * Profiler behavior is injected per-call via `opts.profileFn` (no `mock.module`,
 * no live DB), and the assertions read through the real `whitelist` module so
 * the queryability claim is exercised against production code.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { Effect } from "effect";
import type {
  ColumnProfile,
  ProfilingResult,
  TableProfile,
} from "@useatlas/types";
import {
  SemanticGenerator,
  SemanticGeneratorLive,
  createSemanticGeneratorTestLayer,
  type DatasourceProfiler,
  type ProfileStatusRecordFn,
} from "../semantic-generator";
import {
  getWhitelistedTables,
  _resetWhitelists,
  _resetPluginEntities,
} from "@atlas/api/lib/semantic/whitelist";

// ── Fixtures ─────────────────────────────────────────────────────────

function col(
  over: Partial<ColumnProfile> & Pick<ColumnProfile, "name" | "type">,
): ColumnProfile {
  return {
    name: over.name,
    type: over.type,
    nullable: over.nullable ?? false,
    unique_count: over.unique_count ?? null,
    null_count: over.null_count ?? null,
    sample_values: over.sample_values ?? [],
    is_primary_key: over.is_primary_key ?? false,
    is_foreign_key: over.is_foreign_key ?? false,
    fk_target_table: over.fk_target_table ?? null,
    fk_target_column: over.fk_target_column ?? null,
    is_enum_like: over.is_enum_like ?? false,
    profiler_notes: over.profiler_notes ?? [],
  };
}

function profile(
  over: Partial<TableProfile> & Pick<TableProfile, "table_name">,
): TableProfile {
  return {
    table_name: over.table_name,
    object_type: over.object_type ?? "table",
    row_count: over.row_count ?? 100,
    columns: over.columns ?? [
      col({ name: "id", type: "integer", is_primary_key: true }),
      col({ name: "total", type: "numeric" }),
    ],
    primary_key_columns: over.primary_key_columns ?? ["id"],
    foreign_keys: over.foreign_keys ?? [],
    inferred_foreign_keys: over.inferred_foreign_keys ?? [],
    profiler_notes: over.profiler_notes ?? [],
    table_flags: over.table_flags ?? {
      possibly_abandoned: false,
      possibly_denormalized: false,
    },
  };
}

/** A profiler that returns a fixed result and records that it was called. */
function fakeProfiler(result: ProfilingResult): DatasourceProfiler & { calls: number } {
  const fn = Object.assign(
    () => {
      fn.calls += 1;
      return Promise.resolve(result);
    },
    { calls: 0 },
  );
  return fn;
}

function run<A, E>(effect: Effect.Effect<A, E, SemanticGenerator>): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(SemanticGeneratorLive)));
}

function runExit<A, E>(effect: Effect.Effect<A, E, SemanticGenerator>) {
  return Effect.runPromiseExit(effect.pipe(Effect.provide(SemanticGeneratorLive)));
}

afterEach(() => {
  _resetPluginEntities();
  _resetWhitelists();
});

// ── generate (pure) ──────────────────────────────────────────────────

describe("SemanticGenerator.generate", () => {
  it("assembles entity/catalog/glossary/metric artifacts from analyzed profiles", async () => {
    const result = await run(
      Effect.gen(function* () {
        const svc = yield* SemanticGenerator;
        return svc.generate([profile({ table_name: "orders" })], { dbType: "postgres" });
      }),
    );
    expect(result.entities.map((e) => e.table)).toEqual(["orders"]);
    expect(result.catalog.length).toBeGreaterThan(0);
    expect(result.glossary.length).toBeGreaterThan(0);
    expect(result.metrics.map((m) => m.table)).toEqual(["orders"]);
  });
});

// ── profile ──────────────────────────────────────────────────────────

describe("SemanticGenerator.profile", () => {
  it("runs the injected profiler and returns analyzed profiles", async () => {
    const fp = fakeProfiler({
      profiles: [profile({ table_name: "orders" }), profile({ table_name: "customers" })],
      errors: [],
    });
    const result = await run(
      Effect.gen(function* () {
        const svc = yield* SemanticGenerator;
        return yield* svc.profile({
          url: "clickhouse://example",
          dbType: "clickhouse",
          profileFn: fp,
        });
      }),
    );
    expect(fp.calls).toBe(1);
    expect(result.profiles.map((p) => p.table_name)).toEqual(["orders", "customers"]);
    expect(result.errors).toEqual([]);
    expect(typeof result.elapsedMs).toBe("number");
  });

  it("fails with ProfilingFailedError(no_tables) when nothing profiles", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const svc = yield* SemanticGenerator;
        return yield* svc.profile({
          url: "postgres://x",
          dbType: "postgres",
          profileFn: fakeProfiler({ profiles: [], errors: [] }),
        });
      }),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const err = exit.cause;
      expect(JSON.stringify(err)).toContain("no_tables");
    }
  });

  it("aborts on threshold breach but continues with force", async () => {
    // 1 success, 3 errors → 75% failure rate (over the 50% threshold).
    const result: ProfilingResult = {
      profiles: [profile({ table_name: "orders" })],
      errors: [
        { table: "a", error: "boom" },
        { table: "b", error: "boom" },
        { table: "c", error: "boom" },
      ],
    };

    const exit = await runExit(
      Effect.gen(function* () {
        const svc = yield* SemanticGenerator;
        return yield* svc.profile({
          url: "postgres://x",
          dbType: "postgres",
          profileFn: fakeProfiler(result),
        });
      }),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(JSON.stringify(exit.cause)).toContain("threshold_exceeded");
    }

    const forced = await run(
      Effect.gen(function* () {
        const svc = yield* SemanticGenerator;
        return yield* svc.profile({
          url: "postgres://x",
          dbType: "postgres",
          force: true,
          profileFn: fakeProfiler(result),
        });
      }),
    );
    expect(forced.profiles.map((p) => p.table_name)).toEqual(["orders"]);
  });

  it("fails with unsupported_db_type when no profiler is available for a non-core dbType", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const svc = yield* SemanticGenerator;
        return yield* svc.profile({ url: "clickhouse://x", dbType: "clickhouse" });
      }),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(JSON.stringify(exit.cause)).toContain("unsupported_db_type");
    }
  });

  it("normalizes a thrown profiler error into ProfilingFailedError(profiler_error)", async () => {
    const throwing: DatasourceProfiler = () =>
      Promise.reject(new Error("connection refused"));
    const exit = await runExit(
      Effect.gen(function* () {
        const svc = yield* SemanticGenerator;
        return yield* svc.profile({
          url: "postgres://x",
          dbType: "postgres",
          profileFn: throwing,
        });
      }),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const json = JSON.stringify(exit.cause);
      expect(json).toContain("profiler_error");
      expect(json).toContain("connection refused");
    }
  });
});

// ── profileAndGenerate (the Blocker #1 entry point) ──────────────────

describe("SemanticGenerator.profileAndGenerate", () => {
  it("profiles, generates, and populates the table whitelist (connection becomes queryable)", async () => {
    const connectionId = "mcp_conn_a";
    const fp = fakeProfiler({
      profiles: [profile({ table_name: "orders" }), profile({ table_name: "customers" })],
      errors: [],
    });

    const result = await run(
      Effect.gen(function* () {
        const svc = yield* SemanticGenerator;
        return yield* svc.profileAndGenerate({
          url: "postgres://x",
          dbType: "postgres",
          connectionId,
          profileFn: fp,
        });
      }),
    );

    expect(result.entities.map((e) => e.table)).toEqual(["orders", "customers"]);
    expect(result.profiles).toHaveLength(2);

    // The blocker: before this, the whitelist was empty → every query rejected.
    const whitelist = getWhitelistedTables(connectionId);
    expect(whitelist.has("orders")).toBe(true);
    expect(whitelist.has("customers")).toBe(true);
  });

  it("does not touch the whitelist when registerWhitelist is false", async () => {
    const connectionId = "mcp_conn_b";
    await run(
      Effect.gen(function* () {
        const svc = yield* SemanticGenerator;
        return yield* svc.profileAndGenerate({
          url: "postgres://x",
          dbType: "postgres",
          connectionId,
          registerWhitelist: false,
          profileFn: fakeProfiler({
            profiles: [profile({ table_name: "orders" })],
            errors: [],
          }),
        });
      }),
    );
    expect(getWhitelistedTables(connectionId).has("orders")).toBe(false);
  });

  it("propagates the profiling failure (no artifacts, no whitelist mutation)", async () => {
    const connectionId = "mcp_conn_c";
    const exit = await runExit(
      Effect.gen(function* () {
        const svc = yield* SemanticGenerator;
        return yield* svc.profileAndGenerate({
          url: "postgres://x",
          dbType: "postgres",
          connectionId,
          profileFn: fakeProfiler({ profiles: [], errors: [] }),
        });
      }),
    );
    expect(exit._tag).toBe("Failure");
    expect(getWhitelistedTables(connectionId).size).toBe(0);
  });
});

// ── persist (#3546 — durable, content-mode-aware draft upsert) ───────

describe("SemanticGenerator.persist", () => {
  type UpsertRow = {
    entityType: string;
    name: string;
    yamlContent: string;
    connectionGroupId?: string | null;
  };

  /** A `bulkUpsertEntities`-shaped fake that records its rows. */
  function fakeUpsert(
    behavior?: (orgId: string, rows: readonly UpsertRow[]) => number,
  ): ((orgId: string, rows: readonly UpsertRow[]) => Promise<number>) & {
    calls: Array<{ orgId: string; rows: UpsertRow[] }>;
  } {
    const fn = Object.assign(
      (orgId: string, rows: readonly UpsertRow[]) => {
        fn.calls.push({ orgId, rows: [...rows] });
        return Promise.resolve(behavior ? behavior(orgId, rows) : rows.length);
      },
      { calls: [] as Array<{ orgId: string; rows: UpsertRow[] }> },
    );
    return fn;
  }

  it("persists entities AND metrics as drafts under the install's group scope", async () => {
    const upsert = fakeUpsert();
    const result = await run(
      Effect.gen(function* () {
        const svc = yield* SemanticGenerator;
        return yield* svc.persist({
          orgId: "org_persist",
          connectionGroupId: "g_prod",
          entities: [
            { table: "public.orders", fileName: "orders.yml", yaml: "table: orders" },
            { table: "users", fileName: "users.yml", yaml: "table: users" },
          ],
          metrics: [{ table: "orders", fileName: "orders.metric.yml", yaml: "name: revenue" }],
          upsert,
        });
      }),
    );
    expect(result).toEqual({ entitiesPersisted: 2, metricsPersisted: 1, partial: false });
    // Two upsert calls: one for entities, one for metrics — both scoped to the
    // group and typed correctly.
    expect(upsert.calls).toHaveLength(2);
    const entityCall = upsert.calls[0];
    expect(entityCall.orgId).toBe("org_persist");
    expect(entityCall.rows.every((r) => r.entityType === "entity")).toBe(true);
    expect(entityCall.rows.every((r) => r.connectionGroupId === "g_prod")).toBe(true);
    // Row name mirrors the wizard /save path (`path.basename`): a path-traversal
    // segment is stripped, a schema-qualified dotted name is kept verbatim so
    // two same-named tables in different schemas stay distinct.
    expect(entityCall.rows.map((r) => r.name)).toEqual(["public.orders", "users"]);
    expect(upsert.calls[1].rows[0].entityType).toBe("metric");
  });

  it("skips the metric upsert entirely when there are no metrics", async () => {
    const upsert = fakeUpsert();
    const result = await run(
      Effect.gen(function* () {
        const svc = yield* SemanticGenerator;
        return yield* svc.persist({
          orgId: "org_persist",
          connectionGroupId: null,
          entities: [{ table: "orders", fileName: "orders.yml", yaml: "table: orders" }],
          upsert,
        });
      }),
    );
    expect(result).toEqual({ entitiesPersisted: 1, metricsPersisted: 0, partial: false });
    expect(upsert.calls).toHaveLength(1); // entities only
    expect(upsert.calls[0].rows[0].connectionGroupId).toBeNull();
  });

  it("FAILS LOUD with persist_error when not every entity row lands (no silent partial)", async () => {
    // The upsert reports a short count — a partially-queryable connection.
    const upsert = fakeUpsert(() => 1);
    const exit = await runExit(
      Effect.gen(function* () {
        const svc = yield* SemanticGenerator;
        return yield* svc.persist({
          orgId: "org_persist",
          connectionGroupId: null,
          entities: [
            { table: "orders", fileName: "orders.yml", yaml: "table: orders" },
            { table: "users", fileName: "users.yml", yaml: "table: users" },
          ],
          upsert,
        });
      }),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(JSON.stringify(exit.cause)).toContain("persist_error");
    }
  });

  it("wraps a thrown upsert into ProfilingFailedError(persist_error)", async () => {
    const upsert = Object.assign(
      () => Promise.reject(new Error("DB pool exhausted")),
      { calls: [] },
    );
    const exit = await runExit(
      Effect.gen(function* () {
        const svc = yield* SemanticGenerator;
        return yield* svc.persist({
          orgId: "org_persist",
          connectionGroupId: null,
          entities: [{ table: "orders", fileName: "orders.yml", yaml: "table: orders" }],
          upsert,
        });
      }),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const json = JSON.stringify(exit.cause);
      expect(json).toContain("persist_error");
      expect(json).toContain("DB pool exhausted");
    }
  });

  // ── #3682 — durable partial-profile marker ─────────────────────────
  // A sub-threshold partial profile (some tables failed introspection but
  // stayed under the 20% abort threshold) persists with those tables ABSENT.
  // The durable marker is what makes the incompleteness survive a restart and
  // become visible to the publish flow — not just the transient `errors[]`.

  type StatusCall = {
    orgId: string;
    connectionGroupId: string | null;
    input: { totalTables: number; failedTables: ReadonlyArray<{ table: string; error: string }> };
  };

  /** A `upsertProfileStatus`-shaped fake that records its calls. */
  function fakeRecordStatus(
    behavior?: () => void,
  ): ProfileStatusRecordFn & { calls: StatusCall[] } {
    const fn = Object.assign(
      (orgId: string, connectionGroupId: string | null, input: StatusCall["input"]) => {
        fn.calls.push({ orgId, connectionGroupId, input });
        if (behavior) behavior();
        return Promise.resolve();
      },
      { calls: [] as StatusCall[] },
    );
    return fn;
  }

  it("records a durable partial marker when 1 of 10 tables failed", async () => {
    const recordStatus = fakeRecordStatus();
    const result = await run(
      Effect.gen(function* () {
        const svc = yield* SemanticGenerator;
        return yield* svc.persist({
          orgId: "org_partial",
          connectionGroupId: "g_prod",
          // 9 tables generated; 1 failed → 10 attempted, sub-threshold partial.
          entities: Array.from({ length: 9 }, (_, i) => ({
            table: `t${i}`,
            fileName: `t${i}.yml`,
            yaml: `table: t${i}`,
          })),
          profileStatus: {
            totalTables: 10,
            failedTables: [{ table: "locked_table", error: "permission denied" }],
          },
          upsert: fakeUpsert(),
          recordStatus,
        });
      }),
    );

    // The persisted layer is flagged incomplete...
    expect(result.partial).toBe(true);
    expect(result.entitiesPersisted).toBe(9);
    // ...and the durable marker was written with the failed table and the
    // attempted total — the signal that survives restart / reaches publish.
    expect(recordStatus.calls).toHaveLength(1);
    const call = recordStatus.calls[0];
    expect(call.orgId).toBe("org_partial");
    expect(call.connectionGroupId).toBe("g_prod");
    expect(call.input.totalTables).toBe(10);
    expect(call.input.failedTables).toEqual([
      { table: "locked_table", error: "permission denied" },
    ]);
  });

  it("records a complete marker (partial=false) when no tables failed — clears a prior partial", async () => {
    const recordStatus = fakeRecordStatus();
    const result = await run(
      Effect.gen(function* () {
        const svc = yield* SemanticGenerator;
        return yield* svc.persist({
          orgId: "org_clean",
          connectionGroupId: null,
          entities: [{ table: "orders", fileName: "orders.yml", yaml: "table: orders" }],
          profileStatus: { totalTables: 1, failedTables: [] },
          upsert: fakeUpsert(),
          recordStatus,
        });
      }),
    );
    expect(result.partial).toBe(false);
    // Still recorded — an empty failedTables write is what CLEARS a stale
    // partial marker after a fixed-permission re-profile.
    expect(recordStatus.calls).toHaveLength(1);
    expect(recordStatus.calls[0].input.failedTables).toEqual([]);
  });

  it("does not record any marker when profileStatus is omitted (back-compat)", async () => {
    const recordStatus = fakeRecordStatus();
    const result = await run(
      Effect.gen(function* () {
        const svc = yield* SemanticGenerator;
        return yield* svc.persist({
          orgId: "org_nostatus",
          connectionGroupId: null,
          entities: [{ table: "orders", fileName: "orders.yml", yaml: "table: orders" }],
          upsert: fakeUpsert(),
          recordStatus,
        });
      }),
    );
    expect(result.partial).toBe(false);
    expect(recordStatus.calls).toHaveLength(0);
  });

  it("does NOT fail the persist when the marker write throws (entities already landed)", async () => {
    const recordStatus = fakeRecordStatus(() => {
      throw new Error("status table unavailable");
    });
    // The recorder throws synchronously inside the thunk → routed to the error
    // channel → caught + logged, persist still succeeds (the layer is queryable).
    const result = await run(
      Effect.gen(function* () {
        const svc = yield* SemanticGenerator;
        return yield* svc.persist({
          orgId: "org_marker_fail",
          connectionGroupId: null,
          entities: [{ table: "orders", fileName: "orders.yml", yaml: "table: orders" }],
          profileStatus: {
            totalTables: 2,
            failedTables: [{ table: "x", error: "boom" }],
          },
          upsert: fakeUpsert(),
          recordStatus,
        });
      }),
    );
    expect(result.entitiesPersisted).toBe(1);
    expect(result.partial).toBe(true);
    expect(recordStatus.calls).toHaveLength(1);
  });
});

// ── registerWhitelist (direct) ───────────────────────────────────────

describe("SemanticGenerator.registerWhitelist", () => {
  it("registers generated entity tables under the connection id", async () => {
    const connectionId = "mcp_conn_d";
    await run(
      Effect.gen(function* () {
        const svc = yield* SemanticGenerator;
        const generated = svc.generate([profile({ table_name: "orders" })], {
          dbType: "postgres",
        });
        svc.registerWhitelist(connectionId, generated.entities);
      }),
    );
    expect(getWhitelistedTables(connectionId).has("orders")).toBe(true);
  });
});

// ── Test layer factory ───────────────────────────────────────────────

describe("createSemanticGeneratorTestLayer", () => {
  it("provides a working SemanticGenerator", async () => {
    const layer = createSemanticGeneratorTestLayer();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* SemanticGenerator;
        return svc.generate([profile({ table_name: "orders" })], { dbType: "postgres" });
      }).pipe(Effect.provide(layer)),
    );
    expect(result.entities.map((e) => e.table)).toEqual(["orders"]);
  });
});

// ── #3579 — profiler-error messages are DSN-scrubbed ────────────────
// A verbose profiler throw (e.g. a driver that echoes the DSN in its
// error text) must never surface the plaintext connection string.

describe("SemanticGenerator.profile — DSN scrub (#3579)", () => {
  it("strips scheme://user:pass@host from a profiler error message", async () => {
    const DSN = "postgres://admin:hunter2@db.internal:5432/prod";
    const throwing: DatasourceProfiler = () =>
      Promise.reject(new Error(`connect failed: ECONNREFUSED for ${DSN}`));
    const exit = await runExit(
      Effect.gen(function* () {
        const svc = yield* SemanticGenerator;
        return yield* svc.profile({
          url: DSN,
          dbType: "postgres",
          profileFn: throwing,
        });
      }),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const json = JSON.stringify(exit.cause);
      expect(json).toContain("profiler_error");
      // The DSN password and full connection string must be scrubbed.
      expect(json).not.toContain("hunter2");
      expect(json).not.toContain("admin:hunter2");
      // The scrubbed form replaces the userinfo with ***.
      expect(json).toContain("postgres://***@");
    }
  });

  it("strips scheme://user:pass@host from per-table errors[] surfaced to the client", async () => {
    // Plugin profilers push raw driver `err.message` into the per-table
    // `errors[]` array (e.g. ClickHouse's `Fatal database error: ${msg}`). A
    // driver connection error can echo the full DSN; on the wizard route the
    // whole `errors[]` array is returned to the client. The host scrubs each
    // entry at this boundary so no plugin (current or future) leaks credentials.
    const DSN = "clickhouse://admin:hunter2@ch.prod:8123/analytics";
    const result: ProfilingResult = {
      profiles: [profile({ table_name: "a" })],
      errors: [{ table: "events", error: `Fatal database error: connect ${DSN}` }],
    };
    const res = await run(
      Effect.gen(function* () {
        const svc = yield* SemanticGenerator;
        // `force` bypasses the failure-threshold abort so the errors[] flows
        // back to the caller (the path the wizard route returns to the client).
        return yield* svc.profile({
          url: DSN,
          dbType: "clickhouse",
          force: true,
          profileFn: fakeProfiler(result),
        });
      }),
    );
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0].table).toBe("events");
    expect(res.errors[0].error).not.toContain("hunter2");
    expect(res.errors[0].error).not.toContain("admin:hunter2");
    expect(res.errors[0].error).toContain("clickhouse://***@");
  });
});

// ── #3581 — OperationCancelledError propagates as a defect ──────────
// A cooperative profiling cancellation (MCP client aborts mid-table)
// must not be erased to `validation_failed`. The Error's `name` is the
// discriminant (avoiding a cross-package import from @atlas/mcp).

describe("SemanticGenerator.profile — cooperative cancellation (#3581)", () => {
  it("re-throws OperationCancelledError as a defect (not a ProfilingFailedError)", async () => {
    // Simulate the MCP progress bridge raising OperationCancelledError by name.
    class OperationCancelledError extends Error {
      override readonly name = "OperationCancelledError";
      constructor() { super("operation cancelled by client"); }
    }
    const cancelling: DatasourceProfiler = () =>
      Promise.reject(new OperationCancelledError());
    const exit = await runExit(
      Effect.gen(function* () {
        const svc = yield* SemanticGenerator;
        return yield* svc.profile({
          url: "postgres://x",
          dbType: "postgres",
          profileFn: cancelling,
        });
      }),
    );
    // A defect (die) surfaces as a Failure with a Die cause — NOT a typed
    // ProfilingFailedError(reason:"profiler_error"). The original error must
    // be recoverable from the cause for the MCP layer to re-throw it.
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const json = JSON.stringify(exit.cause);
      // Must NOT be wrapped as a validation_failed profiler_error.
      expect(json).not.toContain("profiler_error");
      // Must be a defect (die) carrying the original OperationCancelledError.
      expect(json).toContain("OperationCancelledError");
    }
  });
});

// ── #3589 — registerWhitelist:false leaves no queryable residue ──────
// This is the building-block for the deferred-register fix in
// runSemanticProfile: when persist will run, profileAndGenerate is
// called with registerWhitelist:false so a subsequent persist failure
// can't leave the whitelist in an inconsistent state.

describe("SemanticGenerator.profileAndGenerate — registerWhitelist:false (#3589)", () => {
  it("leaves the whitelist empty when registerWhitelist is explicitly false", async () => {
    const connectionId = "conn_3589_noregister";
    await run(
      Effect.gen(function* () {
        const svc = yield* SemanticGenerator;
        return yield* svc.profileAndGenerate({
          url: "postgres://x",
          dbType: "postgres",
          connectionId,
          registerWhitelist: false,
          profileFn: fakeProfiler({
            profiles: [profile({ table_name: "secret_table" })],
            errors: [],
          }),
        });
      }),
    );
    // The table is generated but MUST NOT be in the whitelist yet —
    // the caller (runSemanticProfile in mcp-lifecycle) registers it
    // only after a successful persist.
    expect(getWhitelistedTables(connectionId).has("secret_table")).toBe(false);
  });
});
