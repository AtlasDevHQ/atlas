/**
 * #5272 — WHAT SHAPE does `internalQuery` reject with once the Effect Layer
 * has booted?
 *
 * Four call sites classify a Postgres `unique_violation` by reading a FLAT,
 * top-level `code` off the caught error:
 *
 *   - `api/routes/admin-prompts.ts`            → 409 on a duplicate collection name
 *   - `api/routes/sub-processor-subscriptions.ts` → 409 on a duplicate webhook URL
 *   - `lib/starter-prompts/favorite-store.ts`  → `DuplicateFavoriteError`
 *   - `lib/suggestions/approval-store.ts`      → duplicate-suggestion path
 *
 * All four write through `internalQuery`, which takes the `_sqlClient` branch
 * whenever the Layer has booted — i.e. always, in production. If `@effect/sql`
 * wraps the driver error under `.cause` with no top-level `code`, every one of
 * those arms is DEAD in production and a routine duplicate surfaces as a 500.
 *
 * ⚠️ THIS CANNOT BE SETTLED WITH A MOCK, WHICH IS THE WHOLE POINT. Every
 * existing test for those four sites hand-builds the rejection as
 * `Object.assign(new Error(...), { code: "23505" })` — a fixture that agrees
 * with the flat assumption by construction, and therefore passes whether the
 * assumption holds or not. This file drives a REAL duplicate through a REAL
 * `PgClient.layerFromPool` client against real Postgres and records what comes
 * back.
 *
 * ⚠️ **THE ANSWER, so nobody re-runs the experiment.** A promise-awaited
 * `internalQuery` rejects with:
 *
 *     FiberFailureImpl                      ← own props: message, name, stack
 *       [Symbol(effect/Runtime/FiberFailure/Cause)] = { _tag: "Fail", error }
 *           SqlError.cause = DatabaseError { code: "23505", constraint, … }
 *
 * No top-level `code`, and **no `.cause` on the FiberFailure** — the cause is
 * symbol-keyed. Both the flat read and a naive `.cause` walk miss it, so every
 * affected arm was surfacing a routine duplicate as a 500.
 *
 * Skipped cleanly when `TEST_DATABASE_URL` is unset.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Cause, Effect, Exit, Layer, Runtime, Scope } from "effect";
import { SqlClient } from "@effect/sql";
import { PgClient } from "@effect/sql-pg";
import { Pool } from "pg";
import { internalQuery, _resetPool } from "@atlas/api/lib/db/internal";
import { asUniqueViolation, asWrappedUniqueViolation } from "@atlas/api/lib/db/pg-errors";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TIMEOUT_MS = 30_000;

/** Every link in an error's `.cause` chain, outermost first. */
function causeChain(err: unknown, max = 8): ReadonlyArray<Record<string, unknown>> {
  const links: Record<string, unknown>[] = [];
  let cur: unknown = err;
  for (let i = 0; i < max; i++) {
    if (typeof cur !== "object" || cur === null) break;
    const o = cur as Record<string, unknown>;
    links.push(o);
    if (o.cause === cur) break;
    cur = o.cause;
  }
  return links;
}

/** The first `code` found anywhere in the chain, with its depth. */
function findCode(err: unknown): { depth: number; code: string } | undefined {
  const links = causeChain(err);
  for (let i = 0; i < links.length; i++) {
    const c = links[i]!.code;
    if (typeof c === "string") return { depth: i, code: c };
  }
  return undefined;
}

describeIfPg("internalQuery's rejection shape on the Effect path (#5272)", () => {
  let pool: Pool;
  let scope: Scope.CloseableScope;
  const schemaName = `errshape_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    pool = new Pool({
      connectionString: TEST_DB_URL,
      options: `-c search_path="${schemaName}"`,
      max: 3,
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await pool.query(`
      CREATE TABLE dup_probe (
        id   TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE
      )
    `);

    // ⚠️ A REAL `@effect/sql` client over that pool — the same construction
    // `initInternalDB` uses (`PgClient.layerFromPool`). Injecting a hand-rolled
    // stand-in here would reintroduce the very agree-by-construction problem
    // this file exists to remove.
    scope = Effect.runSync(Scope.make());
    const layer = PgClient.layerFromPool({
      acquire: Effect.succeed(pool),
      applicationName: "atlas-errshape-test",
    });
    const ctx = await Effect.runPromise(
      Scope.extend(Layer.build(layer), scope) as Effect.Effect<never, never, never>,
    );
    const sqlClient = await Effect.runPromise(
      Effect.provide(SqlClient.SqlClient, ctx as never) as Effect.Effect<
        SqlClient.SqlClient,
        never,
        never
      >,
    );
    _resetPool(pool as never, sqlClient);
  }, PG_TIMEOUT_MS);

  afterAll(async () => {
    _resetPool(null, null);
    if (scope) await Effect.runPromise(Scope.close(scope, Exit.void));
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await pool.end();
    }
  }, PG_TIMEOUT_MS);

  /** Insert `name` twice; return whatever the second attempt rejects with. */
  async function raiseDuplicate(name: string): Promise<unknown> {
    await internalQuery(`INSERT INTO dup_probe (id, name) VALUES ($1, $2)`, [`${name}-1`, name]);
    try {
      await internalQuery(`INSERT INTO dup_probe (id, name) VALUES ($1, $2)`, [`${name}-2`, name]);
    } catch (err) {
      return err;
    }
    throw new Error("expected the duplicate INSERT to reject, but it succeeded");
  }

  it("⭐ the SQLSTATE is NOT on the rejection, and NOT on its .cause chain", async () => {
    const raised = await raiseDuplicate("shape");

    // This is the defect, measured. Both readings a caller would naturally
    // reach for come back empty.
    expect(findCode(raised)).toBeUndefined();
    expect(causeChain(raised)).toHaveLength(1); // no `.cause` at all
    expect(asUniqueViolation(raised)).toBeUndefined();
  }, PG_TIMEOUT_MS);

  it("⭐ it is reachable ONLY through the FiberFailure's symbol-keyed Cause", async () => {
    // Where it actually lives. Asserted through Effect's public API rather
    // than the raw symbol, which is also how the fix reads it.
    const raised = await raiseDuplicate("symbol");
    expect(Runtime.isFiberFailure(raised)).toBe(true);

    const squashed = Cause.squash(
      (raised as Record<symbol, Cause.Cause<unknown>>)[Runtime.FiberFailureCauseId],
    );
    // `SqlError` itself carries no code; its `.cause` is the pg DatabaseError.
    expect(asUniqueViolation(squashed)).toBeUndefined();
    expect(asUniqueViolation((squashed as { cause?: unknown }).cause)?.constraint).toBe(
      "dup_probe_name_key",
    );
  }, PG_TIMEOUT_MS);

  it("⭐ asWrappedUniqueViolation classifies it — the arm the four call sites now use", async () => {
    const raised = await raiseDuplicate("classified");
    const collision = asWrappedUniqueViolation(raised);
    expect(collision).toBeDefined();
    expect(collision?.constraint).toBe("dup_probe_name_key");
    expect(String(collision?.detail)).toContain("already exists");
  }, PG_TIMEOUT_MS);

  it("does NOT classify a different SQLSTATE raised through the same transport", async () => {
    // The guard on the guard: the unwrapping must not turn every Effect-wrapped
    // failure into a benign collision. `42P01` = undefined_table.
    let raised: unknown;
    try {
      await internalQuery(`INSERT INTO no_such_table (x) VALUES ($1)`, ["y"]);
    } catch (err) {
      raised = err;
    }
    expect(raised).toBeDefined();
    expect(asWrappedUniqueViolation(raised)).toBeUndefined();
  }, PG_TIMEOUT_MS);
});
