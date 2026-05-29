/**
 * Real-Postgres integration tests for the email-outbox flusher.
 *
 * Skipped cleanly when `TEST_DATABASE_URL` is unset (matches
 * `migrate-pg.test.ts` + the lead-outbox PG test). Exercises the actual
 * CLAIM_SQL backoff gate (the `COALESCE(retry_after, created_at +
 * CASE...)` WHERE clause), MARK_* statements, and the recovery sweep
 * against real Postgres — the regex-matching FakeEmailOutboxDB in
 * `outbox.test.ts` can't catch a SQL planning error.
 *
 * Each test runs against a unique per-test schema so concurrent shards
 * don't collide; the email_outbox migration is applied via the runner
 * inside that schema. Dispatchers are local lambdas — no real provider.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS } from "@atlas/api/lib/db/internal";
import {
  enqueue,
  flushBatch,
  recoverInFlight,
  type EmailOutboxDB,
  type EmailDispatcher,
} from "../outbox";

const MSG = { to: "user@example.com", subject: "Reset", html: "<p>link</p>" };

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TIMEOUT_MS = 30_000;

describeIfPg("email-outbox (real Postgres)", () => {
  let pool: Pool;
  const schemaName = `email_outbox_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`email-outbox-pg: SET search_path failed: ${message}`);
      });
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });
  }, PG_TIMEOUT_MS);

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await pool.end();
  });

  function dbFor(): EmailOutboxDB {
    return {
      query: async <T extends Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const result = await pool.query<T>(sql, params);
        return result.rows;
      },
    };
  }

  async function truncate(): Promise<void> {
    await pool.query("TRUNCATE email_outbox");
  }

  async function statusOf(id: string): Promise<{ status: string; attempts: number; last_error: string | null }> {
    const r = await pool.query<{ status: string; attempts: number; last_error: string | null }>(
      "SELECT status, attempts, last_error FROM email_outbox WHERE id = $1",
      [id],
    );
    return r.rows[0];
  }

  const ok: EmailDispatcher = async () => ({ kind: "ok" });
  const transient: EmailDispatcher = async () => ({ kind: "transient", message: "Resend 503" });
  const permanent: EmailDispatcher = async () => ({ kind: "permanent", message: "bad api key" });

  it(
    "enqueue → flushBatch → done (happy path against real SQL)",
    async () => {
      await truncate();
      const db = dbFor();
      const id = await enqueue(db, { emailType: "password-reset", message: MSG });
      const result = await flushBatch(db, ok, 10);
      expect(result).toEqual({ claimed: 1, ok: 1, transient: 0, permanent: 0 });
      const row = await statusOf(id);
      expect(row.status).toBe("done");
      expect(row.attempts).toBe(1);
    },
    PG_TIMEOUT_MS,
  );

  it(
    "transient failure returns to pending and is NOT re-claimable until the backoff tier elapses",
    async () => {
      await truncate();
      const db = dbFor();
      const id = await enqueue(db, { emailType: "password-reset", message: MSG });

      // First flush fails transiently → MARK_TRANSIENT stamps
      // retry_after = now() + tier(1) = now()+30s (measured from the
      // failure moment, via the GREATEST(now() + CASE..., $3) SQL).
      const first = await flushBatch(db, transient, 10);
      expect(first.transient).toBe(1);
      expect((await statusOf(id)).status).toBe("pending");

      // Immediately: retry_after (now+30s) > now → CLAIM_SQL excludes it.
      const second = await flushBatch(db, transient, 10);
      expect(second.claimed).toBe(0);

      // Backdate retry_after into the past — now the COALESCE gate admits
      // it. Proves the real `GREATEST(now() + CASE..., $3)` retry_after was
      // stamped and the claim WHERE honors it.
      await pool.query(
        "UPDATE email_outbox SET retry_after = now() - interval '1 second' WHERE id = $1",
        [id],
      );
      const third = await flushBatch(db, ok, 10);
      expect(third.claimed).toBe(1);
      expect((await statusOf(id)).status).toBe("done");
    },
    PG_TIMEOUT_MS,
  );

  it(
    "retry_after overrides the tier — a far-future retry_after blocks an otherwise-due row",
    async () => {
      await truncate();
      const db = dbFor();
      const id = await enqueue(db, { emailType: "password-reset", message: MSG });
      // attempts=0 + created_at now → would be immediately due, but a
      // future retry_after must win via COALESCE.
      await pool.query(
        "UPDATE email_outbox SET retry_after = now() + interval '1 hour' WHERE id = $1",
        [id],
      );
      const result = await flushBatch(db, ok, 10);
      expect(result.claimed).toBe(0);
      expect((await statusOf(id)).status).toBe("pending");
    },
    PG_TIMEOUT_MS,
  );

  it(
    "permanent failure dead-letters immediately",
    async () => {
      await truncate();
      const db = dbFor();
      const id = await enqueue(db, { emailType: "password-reset", message: MSG });
      const result = await flushBatch(db, permanent, 10);
      expect(result.permanent).toBe(1);
      const row = await statusOf(id);
      expect(row.status).toBe("dead");
      expect(row.last_error).toBe("bad api key");
    },
    PG_TIMEOUT_MS,
  );

  it(
    "recoverInFlight resets a stale in_flight row and dead-letters a stale exhausted one, but leaves a fresh exhausted row for the active sender",
    async () => {
      await truncate();
      const db = dbFor();
      const staleId = await enqueue(db, { emailType: "password-reset", message: MSG });
      const exhaustedId = await enqueue(db, { emailType: "verification-otp", message: MSG });
      const freshExhaustedId = await enqueue(db, { emailType: "password-reset", message: MSG });

      // Stale: in_flight, claimed long ago, attempts under budget → reset.
      await pool.query(
        "UPDATE email_outbox SET status='in_flight', attempts=1, claimed_at = now() - interval '10 minutes' WHERE id = $1",
        [staleId],
      );
      // Stale + exhausted: in_flight at budget, claimed long ago → dead.
      await pool.query(
        "UPDATE email_outbox SET status='in_flight', attempts=6, claimed_at = now() - interval '10 minutes' WHERE id = $1",
        [exhaustedId],
      );
      // Fresh + exhausted: a peer just claimed it for its final attempt and
      // is mid-send → recovery must NOT dead-letter it (codex #2972).
      await pool.query(
        "UPDATE email_outbox SET status='in_flight', attempts=6, claimed_at = now() WHERE id = $1",
        [freshExhaustedId],
      );

      const result = await recoverInFlight(db);
      expect(result.reset).toBe(1);
      expect(result.deadLettered).toBe(1);
      expect((await statusOf(staleId)).status).toBe("pending");
      expect((await statusOf(exhaustedId)).status).toBe("dead");
      expect((await statusOf(freshExhaustedId)).status).toBe("in_flight");
    },
    PG_TIMEOUT_MS,
  );

  it(
    "claims in created_at order up to the batch limit",
    async () => {
      await truncate();
      const db = dbFor();
      for (let i = 0; i < 4; i++) {
        await enqueue(db, { emailType: "password-reset", message: { ...MSG, to: `u${i}@x.co` } });
      }
      const result = await flushBatch(db, ok, 2);
      expect(result.claimed).toBe(2);
      const pending = await pool.query("SELECT count(*)::int AS n FROM email_outbox WHERE status='pending'");
      expect(pending.rows[0].n).toBe(2);
    },
    PG_TIMEOUT_MS,
  );

  it(
    "round-trips the message through the encrypt-at-rest path (decrypt yields the original)",
    async () => {
      await truncate();
      const db = dbFor();
      const secret = { ...MSG, html: "<a href='https://x/reset?token=SECRET123'>reset</a>" };
      await enqueue(db, { emailType: "password-reset", message: secret });

      // The flusher decrypts before dispatch — the dispatched message
      // equals the original even though the stored column is opaque.
      const delivered: Array<{ to: string; subject: string; html: string }> = [];
      const capturing: EmailDispatcher = async (row) => {
        delivered.push(row.message);
        return { kind: "ok" };
      };
      const result = await flushBatch(db, capturing, 10);
      expect(result.ok).toBe(1);
      expect(delivered[0]).toEqual(secret);
    },
    PG_TIMEOUT_MS,
  );

  it(
    "dead-letters an expired row WITHOUT dispatching it",
    async () => {
      await truncate();
      const db = dbFor();
      const id = await enqueue(db, {
        emailType: "password-reset",
        message: MSG,
        expiresAt: new Date(Date.now() - 1_000), // already past
      });
      let dispatched = false;
      const dispatcher: EmailDispatcher = async () => {
        dispatched = true;
        return { kind: "ok" };
      };
      const result = await flushBatch(db, dispatcher, 10);
      expect(dispatched).toBe(false);
      expect(result.permanent).toBe(1);
      const row = await statusOf(id);
      expect(row.status).toBe("dead");
      expect(row.last_error).toMatch(/expired before delivery/);
    },
    PG_TIMEOUT_MS,
  );
});
