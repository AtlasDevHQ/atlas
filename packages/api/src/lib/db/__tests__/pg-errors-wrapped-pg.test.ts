/**
 * Real-Postgres coverage for unique-violation classification across the two
 * error shapes a caller can be handed (#5272).
 *
 * **Why this suite has to exist.** Every unit test of this classification
 * hand-builds its rejection — `Object.assign(new Error(), { code: "23505" })` —
 * so the fixture agrees with the flat assumption by construction and cannot
 * discriminate the two shapes. That is the #5000 / #5068 class: a test that
 * passes for a reason unrelated to the thing it claims to prove. Four call
 * sites classified on a flat top-level `code` while writing through
 * `internalQuery`, and the whole suite was green while all four 409/duplicate
 * arms were unreachable in production.
 *
 * Only a real database settles it, because the shape is produced by the
 * `@effect/sql` layer wrapping a real driver error — not by anything a fixture
 * can honestly imitate. The measured chain, which the assertions below pin:
 *
 *   `FiberFailureImpl` (own props: message/name/stack ONLY — no `code`, and
 *   critically no `cause`) → `Cause` under a symbol → `Cause.squash` →
 *   `SqlError` (no `code`) → `.cause` → pg `DatabaseError` (`code: "23505"`,
 *   `constraint`, `detail`).
 *
 * The missing `cause` own-property on `FiberFailure` is the load-bearing fact:
 * it is why a plain `.cause` walk — the fix #5272 originally proposed, and the
 * one `routing-id-conflict.ts` shipped — reads `undefined` and stops at depth
 * 0. `asserts the walk is not naive` below is that falsifier.
 *
 * Opt in locally with:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { Effect } from "effect";
import { PgClient } from "@effect/sql-pg";
import { SqlClient } from "@effect/sql";
import { internalQuery, _resetPool } from "@atlas/api/lib/db/internal";
import {
  asUniqueViolation,
  asWrappedUniqueViolation,
  pgErrorLinks,
  PG_UNIQUE_VIOLATION,
} from "@atlas/api/lib/db/pg-errors";
import {
  isRoutingIdUniqueViolation,
  CHAT_ROUTING_ID_UNIQUE_INDEX,
} from "@atlas/api/lib/integrations/install/routing-id-conflict";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

describeIfPg("unique-violation classification against real Postgres", () => {
  // Entropy beyond the timestamp, matching the other `-pg` suites: this repo
  // routinely runs concurrent `-pg` suites from several worktrees against one
  // local Postgres, and `afterAll` DROPs the schema CASCADE.
  const SCHEMA = `s5272_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  let pool: Pool;
  /** The real rejection `internalQuery` produces once the Layer has booted. */
  let wrapped: unknown;
  /** The same collision through a raw `Pool` — the seeders' shape. */
  let flat: unknown;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL, max: 4 });
    await pool.query(`CREATE SCHEMA ${SCHEMA}`);
    await pool.query(`CREATE TABLE ${SCHEMA}.t (id int, name text)`);
    // Named for the routing-id index deliberately, so that when the routing-id
    // classifier is asserted below, the CONSTRAINT NAME cannot be the reason it
    // fails — only the error's shape can be.
    await pool.query(
      `CREATE UNIQUE INDEX ${CHAT_ROUTING_ID_UNIQUE_INDEX} ON ${SCHEMA}.t (name)`,
    );
    await pool.query(`INSERT INTO ${SCHEMA}.t (id, name) VALUES (1, 'dup')`);

    // Shape A — through `internalQuery` with a real SqlClient installed.
    const layer = PgClient.layerFromPool({ acquire: Effect.succeed(pool) as never });
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        _resetPool(null, sql);
        const outcome = yield* Effect.tryPromise({
          try: () => internalQuery(`INSERT INTO ${SCHEMA}.t (id, name) VALUES ($1, $2)`, [2, "dup"]),
          catch: (e) => e,
        }).pipe(Effect.either);
        if (outcome._tag === "Right") throw new Error("expected a unique violation");
        wrapped = outcome.left;
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );

    // Shape B — the raw driver error, which the two catalog seeders see.
    try {
      await pool.query(`INSERT INTO ${SCHEMA}.t (id, name) VALUES ($1, $2)`, [3, "dup"]);
      throw new Error("expected a unique violation");
    } catch (err) {
      flat = err;
    }
  }, PG_TEST_TIMEOUT_MS);

  afterAll(async () => {
    _resetPool(null, null);
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await pool.end();
    }
  }, PG_TEST_TIMEOUT_MS);

  it("the wrapped rejection carries NO top-level code — the premise of #5272", () => {
    expect((wrapped as Record<string, unknown>).code).toBeUndefined();
    // The whole defect in one assertion: the flat classifier, which four call
    // sites used, reports "not a violation" for a real unique violation.
    expect(asUniqueViolation(wrapped)).toBeUndefined();
  });

  it("asserts the walk is not naive — FiberFailure exposes no `cause` own-property", () => {
    // If this ever starts passing, a plain `.cause` walk would suffice and the
    // unwrap step could be simplified. Until then it is why the unwrap exists,
    // and it is the assertion that fails if someone "simplifies" it away.
    expect(Object.getOwnPropertyNames(wrapped as object)).not.toContain("cause");
    expect((wrapped as Record<string, unknown>).cause).toBeUndefined();
  });

  it("classifies the wrapped rejection, with the driver's diagnostics intact", () => {
    const hit = asWrappedUniqueViolation(wrapped);
    expect(hit).toBeDefined();
    expect(hit?.constraint).toBe(CHAT_ROUTING_ID_UNIQUE_INDEX);
    // `detail` is what a caller surfaces to explain WHICH value collided.
    expect(hit?.detail).toContain("dup");
  });

  it("classifies the flat driver error too — one classifier covers both shapes", () => {
    expect(asWrappedUniqueViolation(flat)).toBeDefined();
    expect(asUniqueViolation(flat)).toBeDefined();
  });

  it("reaches the pg DatabaseError through the chain", () => {
    const links = pgErrorLinks(wrapped);
    const codes = links.map((l) => (l as Record<string, unknown> | null)?.code);
    expect(codes).toContain(PG_UNIQUE_VIOLATION);
    // Outermost link is the FiberFailure itself, which carries no code — so a
    // classifier that only read `links[0]` would still be broken.
    expect(codes[0]).toBeUndefined();
  });

  it("the routing-id classifier survives the wrapped shape (#3167 was dead here too)", () => {
    expect(isRoutingIdUniqueViolation(wrapped)).toBe(true);
    expect(isRoutingIdUniqueViolation(flat)).toBe(true);
  });

  it("stays tight: a 23505 on a DIFFERENT index is not a routing-id conflict", async () => {
    await pool.query(`CREATE TABLE ${SCHEMA}.u (name text)`);
    await pool.query(`CREATE UNIQUE INDEX some_other_index ON ${SCHEMA}.u (name)`);
    await pool.query(`INSERT INTO ${SCHEMA}.u (name) VALUES ('x')`);
    let other: unknown;
    try {
      await pool.query(`INSERT INTO ${SCHEMA}.u (name) VALUES ('x')`);
    } catch (err) {
      other = err;
    }
    // It IS a unique violation …
    expect(asWrappedUniqueViolation(other)).toBeDefined();
    // … but NOT the routing-id one. Relabelling it would turn an unrelated
    // failure into "already connected elsewhere".
    expect(isRoutingIdUniqueViolation(other)).toBe(false);
  }, PG_TEST_TIMEOUT_MS);

  it("does not classify a non-violation error", () => {
    expect(asWrappedUniqueViolation(new Error("connection reset"))).toBeUndefined();
    expect(asWrappedUniqueViolation(null)).toBeUndefined();
    expect(asWrappedUniqueViolation(undefined)).toBeUndefined();
    expect(asWrappedUniqueViolation("23505")).toBeUndefined();
  });
});
