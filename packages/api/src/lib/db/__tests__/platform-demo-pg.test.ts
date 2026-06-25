/**
 * Real-Postgres tests for the demo tracking read path (#3931).
 *
 * The /platform/demo queries join `token_usage.conversation_id` (text) to
 * `conversations.id` (uuid) via an explicit `::text` cast, and the transcript
 * lookup binds a `uuid[]` — neither is exercisable through the mocked query
 * layer (the unit/route tests stub `queryEffect`). A missing cast would parse
 * fine in TS but ERROR at runtime ("operator does not exist: text = uuid").
 * These run the PRODUCTION SQL against a real Postgres so that regression is
 * caught, and assemble the real rows to confirm the end-to-end shape.
 *
 * Skipped cleanly when `TEST_DATABASE_URL` is unset (matches `migrate-pg` /
 * `pattern-latency-pg`). CI's api-tests workflow provides the Postgres service.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS } from "@atlas/api/lib/db/internal";
import { demoUserId } from "@atlas/api/lib/demo";
import {
  LEADS_SQL,
  LEADS_USAGE_SQL,
  LEADS_CONV_COUNT_SQL,
  METRICS_PER_MODEL_SQL,
  METRICS_LEAD_COUNTS_SQL,
  TRANSCRIPT_CONV_SQL,
  TRANSCRIPT_MSG_SQL,
  LEADS_LIMIT,
  TRANSCRIPT_CONVERSATION_LIMIT,
  assembleLeads,
  assembleMetrics,
  assembleTranscript,
  type LeadRow,
  type UsageRow,
  type ConvCountRow,
  type LeadCountsRow,
  type TranscriptConvRow,
  type TranscriptMsgRow,
} from "@atlas/api/lib/demo-tracking";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;

const PG_TIMEOUT_MS = 30_000;
const HAIKU = "anthropic/claude-haiku-4.5";
const EMAIL = "pg-demo-lead@example.com";

describeIfPg("demo tracking read path (real Postgres, #3931)", () => {
  let pool: Pool;
  const schemaName = `demo_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const uid = demoUserId(EMAIL);
  let convId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`platform-demo-pg: SET search_path failed: ${message}`);
      });
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });

    // Lead with 2 sessions.
    await pool.query(
      `INSERT INTO demo_leads (email, session_count, created_at, last_active_at)
       VALUES ($1, 2, '2026-06-01T00:00:00Z', '2026-06-10T00:00:00Z')`,
      [EMAIL],
    );

    // One demo conversation owned by the hashed lead id.
    const conv = await pool.query<{ id: string }>(
      `INSERT INTO conversations (user_id, surface, title)
       VALUES ($1, 'demo', 'Demo chat') RETURNING id`,
      [uid],
    );
    convId = conv.rows[0]!.id;

    // Two demo turns on that conversation — conversation_id stored as text.
    await pool.query(
      `INSERT INTO token_usage
         (user_id, conversation_id, prompt_tokens, completion_tokens, cache_read_tokens, cache_write_tokens, model, provider, latency_ms)
       VALUES
         ($1, $2, 1000, 200, 100, 0, $3, 'gateway', 1500),
         ($1, $2, 500, 100, 0, 0, $3, 'gateway', 2500)`,
      [uid, convId, HAIKU],
    );

    await pool.query(
      `INSERT INTO messages (conversation_id, role, content)
       VALUES ($1, 'user', '["q"]'::jsonb), ($1, 'assistant', '["a"]'::jsonb)`,
      [convId],
    );
  }, PG_TIMEOUT_MS);

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await pool.end();
  });

  it("LEADS_USAGE_SQL — the text=uuid join executes and aggregates the turns", async () => {
    const res = await pool.query<UsageRow>(LEADS_USAGE_SQL);
    expect(res.rows).toHaveLength(1);
    const row = res.rows[0]!;
    expect(row.user_id).toBe(uid);
    expect(row.model).toBe(HAIKU);
    expect(row.turns).toBe(2);
    expect(Number(row.prompt_tokens)).toBe(1500);
    expect(Number(row.completion_tokens)).toBe(300);
    expect(Number(row.cache_read_tokens)).toBe(100);
    expect(row.avg_latency_ms).toBe(2000); // (1500 + 2500) / 2
    expect(row.latency_count).toBe(2);
  });

  it("assembleLeads over real rows yields the per-email rollup", async () => {
    const [leadRows, usageRows, convCountRows] = await Promise.all([
      pool.query<LeadRow>(LEADS_SQL, [LEADS_LIMIT]),
      pool.query<UsageRow>(LEADS_USAGE_SQL),
      pool.query<ConvCountRow>(LEADS_CONV_COUNT_SQL),
    ]);
    const leads = assembleLeads(leadRows.rows, usageRows.rows, convCountRows.rows);
    expect(leads).toHaveLength(1);
    const lead = leads[0]!;
    expect(lead.email).toBe(EMAIL);
    expect(lead.sessionCount).toBe(2);
    expect(lead.conversationCount).toBe(1);
    expect(lead.usage.turns).toBe(2);
    expect(lead.usage.promptTokens).toBe(1500);
    expect(lead.usage.avgLatencyMs).toBe(2000);
    expect(lead.usage.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("METRICS_PER_MODEL_SQL — the reverse-order join executes and rolls up", async () => {
    const [perModel, leadCounts] = await Promise.all([
      pool.query<UsageRow>(METRICS_PER_MODEL_SQL),
      pool.query<LeadCountsRow>(METRICS_LEAD_COUNTS_SQL),
    ]);
    const metrics = assembleMetrics(perModel.rows, leadCounts.rows);
    expect(metrics.leadCount).toBe(1);
    expect(metrics.sessionCount).toBe(2);
    expect(metrics.totals.turns).toBe(2);
    expect(metrics.totals.avgLatencyMs).toBe(2000);
    expect(metrics.totals.estimatedCostUsd).toBeGreaterThan(0);
    expect(metrics.totals.costComplete).toBe(true);
    expect(metrics.perModel).toHaveLength(1);
    expect(metrics.perModel[0]!.model).toBe(HAIKU);
  });

  it("TRANSCRIPT_*_SQL — uuid + uuid[] binds execute and group messages", async () => {
    const convRes = await pool.query<TranscriptConvRow>(TRANSCRIPT_CONV_SQL, [
      uid,
      TRANSCRIPT_CONVERSATION_LIMIT,
    ]);
    expect(convRes.rows).toHaveLength(1);
    const convIds = convRes.rows.map((r) => r.id);
    const msgRes = await pool.query<TranscriptMsgRow>(TRANSCRIPT_MSG_SQL, [convIds]);
    const transcript = assembleTranscript(EMAIL, convRes.rows, msgRes.rows);
    expect(transcript.conversations).toHaveLength(1);
    expect(transcript.conversations[0]!.id).toBe(convId);
    expect(transcript.conversations[0]!.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  // Runs last: it inserts an orphan turn that the earlier assertions don't expect.
  it("a demo turn with no surviving lead lands in metrics totals but not in leads", async () => {
    const orphanConv = await pool.query<{ id: string }>(
      `INSERT INTO conversations (user_id, surface, title)
       VALUES ('demo:0rphaned00', 'demo', 'Orphan') RETURNING id`,
    );
    const orphanId = orphanConv.rows[0]!.id;
    await pool.query(
      `INSERT INTO token_usage
         (user_id, conversation_id, prompt_tokens, completion_tokens, cache_read_tokens, cache_write_tokens, model, provider, latency_ms)
       VALUES ('demo:0rphaned00', $1, 100, 10, 0, 0, $2, 'gateway', 800)`,
      [orphanId, HAIKU],
    );

    const [leadRows, usageRows, convCountRows, perModel, leadCounts] = await Promise.all([
      pool.query<LeadRow>(LEADS_SQL, [LEADS_LIMIT]),
      pool.query<UsageRow>(LEADS_USAGE_SQL),
      pool.query<ConvCountRow>(LEADS_CONV_COUNT_SQL),
      pool.query<UsageRow>(METRICS_PER_MODEL_SQL),
      pool.query<LeadCountsRow>(METRICS_LEAD_COUNTS_SQL),
    ]);

    // LEADS_USAGE_SQL returns the orphan's row, but assembleLeads drops it.
    expect(usageRows.rows.some((r) => r.user_id === "demo:0rphaned00")).toBe(true);
    const leads = assembleLeads(leadRows.rows, usageRows.rows, convCountRows.rows);
    expect(leads).toHaveLength(1); // orphan not resurrected as a lead
    expect(leads[0]!.usage.turns).toBe(2); // the lead's own turns, unchanged

    // ...but the metrics rollup is lead-independent, so the orphan's turn counts.
    const metrics = assembleMetrics(perModel.rows, leadCounts.rows);
    expect(metrics.totals.turns).toBe(3); // 2 (lead) + 1 (orphan)
  });
});
