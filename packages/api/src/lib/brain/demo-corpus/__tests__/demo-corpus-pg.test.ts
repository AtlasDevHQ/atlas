/**
 * The synthetic NovaMart corpus, seeded end to end against real Postgres
 * (#5603): ingest → (deterministic) extraction → coverage → approve, then the
 * four first-load properties the demo depends on are asserted, so the demo
 * cannot silently decay.
 *
 * Real Postgres and no mocks, for the reason every brain `-pg` suite states:
 * the seed's whole value is that it goes through the SAME seams a customer's
 * data does — `ingestEpisodes`' dedupe, `promoteBrainFacts`' refusals, the
 * coverage CHECK that derives `state` — and a mock of those would pass on
 * whatever shape the seed happened to write.
 *
 * The one thing NOT real here is the extractor: `runBrainExtractionCycle` is
 * driven with a deterministic `extract` that maps each corpus episode to the
 * claims it was written to yield. That is the injection seam the cycle exists
 * to offer, and it is what makes this a test of the SEED rather than of a
 * model's mood. The live path's non-determinism is handled where it belongs —
 * the seed REPORTS missing claims instead of inserting them — and the last
 * test here pins that reporting arm.
 *
 * Run with:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas
 *   bun test packages/api/src/lib/brain/demo-corpus/__tests__/demo-corpus-pg.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { Effect } from "effect";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS, _resetPool } from "@atlas/api/lib/db/internal";
import {
  runBrainExtractionCycle,
  _resetBrainExtractionFailures,
  type FactExtractor,
  type ResolvedExtractionModel,
} from "@atlas/api/lib/brain/extract";
import type { FactCandidate } from "@atlas/api/lib/brain/reconcile";
import { identityVocabulary } from "@atlas/api/lib/brain/identity";
import { readCoverageUnits } from "@atlas/api/lib/brain/coverage-enumeration";
import { chatChannelAudienceId } from "@atlas/api/lib/brain/ingest/grant";
import {
  CHANNELS,
  EPISODES,
  EXPECTED_CLAIMS,
  PEOPLE,
  UNSURVEYED_CHANNEL,
  matchesExpectedClaim,
} from "../corpus";
import {
  DEMO_ATLAS_WORKSPACE_SLUG,
  NotTheDemoWorkspaceError,
  corpusSourceId,
  seedDemoCorpusApprove,
  seedDemoCorpusCoverage,
  seedDemoCorpusIngest,
} from "../seed";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 120_000;

const DEMO_ORG = "org_nmd_demo_test";
const TENANT_ORG = "org_nmd_tenant_test";
const APPROVER = "user_nmd_reviewer";

const FAKE_MODEL = {
  model: "fake-model" as unknown as ResolvedExtractionModel["model"],
  modelId: "fake-model",
  batchApiKey: null,
} satisfies ResolvedExtractionModel;

/**
 * What each corpus episode was written to yield, keyed by its stored
 * `source_id`. Kept beside the test rather than in the corpus module so the
 * corpus cannot grow a "what the extractor should say" field that a future
 * seed might be tempted to write from.
 */
function deterministicClaims(): ReadonlyMap<string, readonly FactCandidate[]> {
  const out = new Map<string, readonly FactCandidate[]>();
  const byKey = (kind: "chat", channel: string, ts: string) =>
    EPISODES.find((e) => e.kind === kind && e.channel === channel && e.ts === ts);

  const set = (episode: (typeof EPISODES)[number] | undefined, claims: readonly FactCandidate[]) => {
    if (episode === undefined) throw new Error("test fixture references an episode the corpus no longer has");
    out.set(corpusSourceId(episode), claims);
  };

  // `predicateCardinality: "single"` is the extractor's per-claim HINT — what the
  // live model emits for a one-value predicate — and reconcile's write-time
  // tension pass is gated on it (`reconcile.ts`: `if (hint === "single")`).
  // Without the hint no edge is minted at write time and the contradiction
  // waits for an admin's sweep; the fixture carries it so the test exercises
  // the path a correctly-hinting extractor takes.
  set(byKey("chat", "finance", "1752494400.000100"), [
    { subject: "NovaMart", predicate: "return window", object: "30 days from delivery", predicateCardinality: "single" },
  ]);
  set(byKey("chat", "finance", "1754308800.000300"), [
    { subject: "NovaMart", predicate: "GMV for July 2026", object: "about $1.9M" },
  ]);
  set(byKey("chat", "support", "1754121600.000100"), [
    { subject: "NovaMart", predicate: "return window", object: "14 days from delivery", predicateCardinality: "single" },
  ]);
  set(byKey("chat", "engineering", "1753776000.000100"), [
    { subject: "nightly ETL", predicate: "runs at", object: "02:00 UTC" },
    { subject: "nightly ETL", predicate: "owned by", object: "Dana Okafor" },
  ]);
  set(byKey("chat", "leadership", "1755518400.000100"), [
    { subject: "NovaMart", predicate: "free-shipping threshold for Q4 2026", object: "$75" },
  ]);
  const transcript = EPISODES.find((e) => e.kind === "transcript");
  set(transcript, [
    { subject: "NovaMart support team", predicate: "grows by", object: "two people in Q4 2026" },
  ]);
  const mail = EPISODES.find((e) => e.kind === "email");
  set(mail, [
    { subject: "NovaMart", predicate: "holiday cutoff for standard shipping", object: "18 December 2026" },
    { subject: "NovaMart", predicate: "holiday cutoff for express shipping", object: "21 December 2026" },
  ]);
  return out;
}

describeIfPg("demo corpus seed (real Postgres)", () => {
  let pool: Pool;
  let priorDatabaseUrl: string | undefined;
  const schemaName = `nmd_demo_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    priorDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = TEST_DB_URL;
    pool = new Pool({
      connectionString: TEST_DB_URL,
      options: `-c search_path="${schemaName}",public`,
    });
    const bootstrap = new Pool({ connectionString: TEST_DB_URL });
    try {
      await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    } finally {
      await bootstrap.end();
    }
    await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });
    // Better Auth owns the real `organization` table and its migrations are
    // skipped above; the seed's guard reads `id` and `slug`, so a stub with
    // those columns keeps the refusal real without the auth stack — and
    // creating it in the test schema shadows any `public.organization` a
    // local dev DB carries, so the assertions never read dev data.
    await pool.query(
      `CREATE TABLE IF NOT EXISTS organization (id text PRIMARY KEY, name text, slug text, "createdAt" timestamptz)`,
    );
    _resetPool(pool);
    await pool.query(
      `INSERT INTO organization (id, name, slug, "createdAt") VALUES ($1, 'NovaMart Demo', $2, now()), ($3, 'Tenant X', 'tenant-x', now())
       ON CONFLICT DO NOTHING`,
      [DEMO_ORG, DEMO_ATLAS_WORKSPACE_SLUG, TENANT_ORG],
    );
  }, PG_TEST_TIMEOUT_MS);

  afterAll(async () => {
    _resetPool(null);
    if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDatabaseUrl;
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await pool.end();
    }
  });

  it("refuses any workspace whose slug is not the demo's — by id, by slug, and when absent", async () => {
    await expect(seedDemoCorpusIngest({ workspaceRef: TENANT_ORG, authoredBy: APPROVER })).rejects.toBeInstanceOf(
      NotTheDemoWorkspaceError,
    );
    await expect(seedDemoCorpusIngest({ workspaceRef: "tenant-x", authoredBy: APPROVER })).rejects.toBeInstanceOf(
      NotTheDemoWorkspaceError,
    );
    await expect(seedDemoCorpusCoverage({ workspaceRef: "org_does_not_exist" })).rejects.toBeInstanceOf(
      NotTheDemoWorkspaceError,
    );
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM brain_episodes WHERE workspace_id = $1`,
      [TENANT_ORG],
    );
    expect(rows[0]?.n).toBe("0");
  });

  it("ingests every corpus episode through the intake seam, once — a re-run inserts nothing", async () => {
    const first = await seedDemoCorpusIngest({ workspaceRef: DEMO_ATLAS_WORKSPACE_SLUG, authoredBy: APPROVER });
    expect(first.workspaceId).toBe(DEMO_ORG);
    const chatCount = EPISODES.filter((e) => e.kind === "chat").length;
    expect(first.episodes.slack).toEqual({ inserted: chatCount, duplicate: 0, refused: 0 });
    expect(first.episodes.zoom).toEqual({ inserted: 1, duplicate: 0, refused: 0 });
    expect(first.episodes.outlook).toEqual({ inserted: 1, duplicate: 0, refused: 0 });
    expect(first.identitiesCaptured).toBe(Object.keys(PEOPLE).length * 3);
    expect(first.cardinality).toBe("declared:single");

    const again = await seedDemoCorpusIngest({ workspaceRef: DEMO_ORG, authoredBy: APPROVER });
    expect(again.episodes.slack).toEqual({ inserted: 0, duplicate: chatCount, refused: 0 });
    expect(again.episodes.zoom.inserted).toBe(0);
    expect(again.episodes.outlook.inserted).toBe(0);

    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM brain_episodes WHERE workspace_id = $1`,
      [DEMO_ORG],
    );
    expect(rows[0]?.n).toBe(String(EPISODES.length));
  }, PG_TEST_TIMEOUT_MS);

  it("carries the private channel's audience grant and the public channels' org grant, from the real deriver", async () => {
    const leadership = EPISODES.find((e) => e.kind === "chat" && e.channel === "leadership");
    const finance = EPISODES.find((e) => e.kind === "chat" && e.channel === "finance");
    if (!leadership || !finance) throw new Error("corpus lost a channel the test relies on");
    const { rows } = await pool.query<{ source_id: string; visible_to: string[] }>(
      `SELECT source_id, visible_to FROM brain_episodes WHERE workspace_id = $1 AND source_id = ANY($2::text[])`,
      [DEMO_ORG, [corpusSourceId(leadership), corpusSourceId(finance)]],
    );
    const byId = new Map(rows.map((r) => [r.source_id, r.visible_to]));
    expect(byId.get(corpusSourceId(finance))).toEqual(["org"]);
    expect(byId.get(corpusSourceId(leadership))).toEqual([
      `audience:${chatChannelAudienceId("slack", CHANNELS.leadership.id)}`,
    ]);
  });

  it("names every fictional author as a dated directory identity, keyed the way the attribution join composes it", async () => {
    const { rows } = await pool.query<{ actor: string; state: string; real_name: string | null }>(
      `SELECT actor, state, real_name FROM brain_actor_identity WHERE workspace_id = $1 ORDER BY actor`,
      [DEMO_ORG],
    );
    const priya = rows.find((r) => r.actor === `slack:${PEOPLE.priya.slackId}`);
    expect(priya).toEqual({ actor: `slack:${PEOPLE.priya.slackId}`, state: "directory", real_name: "Priya Natarajan" });
    expect(rows.every((r) => r.state === "directory")).toBe(true);
  });

  it("persists the roster with #warehouse-ops enumerated-but-unsurveyed and every other channel surveyed", async () => {
    const report = await seedDemoCorpusCoverage({ workspaceRef: DEMO_ORG, now: new Date("2026-09-03T00:00:00Z") });
    expect(report.units).toBe(Object.keys(CHANNELS).length);
    expect(report.unsurveyed).toEqual([`#${CHANNELS[UNSURVEYED_CHANNEL].name}`]);
    expect(report.persist).toBe("success");

    const units = await readCoverageUnits(DEMO_ORG, "chat");
    const byId = new Map(units.map((u) => [u.unitId, u]));
    const empty = byId.get(CHANNELS[UNSURVEYED_CHANNEL].id);
    expect(empty?.state).toBe("enumerated");
    expect(empty?.inPerimeter).toBe(true);
    expect(empty?.newestEvidenceAt).toBeNull();
    for (const key of Object.keys(CHANNELS) as (keyof typeof CHANNELS)[]) {
      if (key === UNSURVEYED_CHANNEL) continue;
      expect(byId.get(CHANNELS[key].id)?.state).toBe("surveyed");
    }
  });

  it("approves nothing before extraction has run, and reports every expected claim missing rather than inventing one", async () => {
    const report = await seedDemoCorpusApprove({ workspaceRef: DEMO_ORG, approvedBy: APPROVER });
    expect(report.promoted).toEqual([]);
    expect(report.missing).toEqual(EXPECTED_CLAIMS.map((c) => c.key));
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM brain_facts WHERE workspace_id = $1`,
      [DEMO_ORG],
    );
    expect(rows[0]?.n).toBe("0");
  });

  it("after a deterministic extraction pass, approve promotes exactly the corpus's drafts through the gate and mints the contradiction's tension edge", async () => {
    const claims = deterministicClaims();
    const extract: FactExtractor = async ({ episode }) => claims.get(episode.sourceId) ?? [];
    _resetBrainExtractionFailures();
    const cycle = await Effect.runPromise(
      runBrainExtractionCycle({
        extract,
        resolveModel: async () => FAKE_MODEL,
        loadVocabulary: async () => identityVocabulary,
      }),
    );
    expect(cycle.status).toBe("success");
    expect(cycle.extracted).toBe(EPISODES.length);

    const drafts = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM brain_facts WHERE workspace_id = $1 AND status = 'draft'`,
      [DEMO_ORG],
    );
    expect(Number(drafts.rows[0]?.n)).toBeGreaterThan(0);

    const report = await seedDemoCorpusApprove({ workspaceRef: DEMO_ORG, approvedBy: APPROVER });
    expect(report.promoted.length).toBe(Number(drafts.rows[0]?.n));
    expect(report.refused).toBe(0);
    expect(report.missing).toEqual([]);
    expect(report.expected.every((e) => e.found)).toBe(true);

    // Every published corpus claim matches at least one expected claim — the
    // reporting contract is two-sided, or a stray extraction could publish
    // unnoticed.
    const published = await pool.query<{ subject: string; predicate: string; object: string }>(
      `SELECT subject, predicate, object FROM brain_facts WHERE workspace_id = $1 AND status = 'published'`,
      [DEMO_ORG],
    );
    for (const row of published.rows) {
      expect(EXPECTED_CLAIMS.some((c) => matchesExpectedClaim(row, c))).toBe(true);
    }

    // The contradiction: both return-window claims are published (nobody
    // arbitrated), and an `in-tension-with` edge joins them.
    const tension = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM brain_edges WHERE workspace_id = $1 AND edge_type = 'in-tension-with'`,
      [DEMO_ORG],
    );
    expect(Number(tension.rows[0]?.n)).toBeGreaterThanOrEqual(1);
    const rivals = published.rows.filter((r) => r.predicate.toLowerCase().includes("return window"));
    expect(rivals.length).toBe(2);

    // The audit row names the human, never a fiction, and carries the ids.
    const audit = await pool.query<{ actor_id: string; metadata: Record<string, unknown> }>(
      `SELECT actor_id, metadata FROM admin_action_log WHERE action_type = 'brain.demo_corpus_seed' AND target_id = $1 ORDER BY timestamp DESC LIMIT 1`,
      [DEMO_ORG],
    );
    expect(audit.rows[0]?.metadata.approvedBy).toBe(APPROVER);
    expect(audit.rows[0]?.metadata.promotedFactIds).toEqual(report.promoted);
  }, PG_TEST_TIMEOUT_MS);

  it("a second approve is a no-op: nothing left to promote, every expected claim still found", async () => {
    const report = await seedDemoCorpusApprove({ workspaceRef: DEMO_ORG, approvedBy: APPROVER });
    expect(report.promoted).toEqual([]);
    expect(report.missing).toEqual([]);
  });

  it("the private-channel claim keeps the channel's audience grant after promotion — it is not widened to the org", async () => {
    const leadership = EPISODES.find((e) => e.kind === "chat" && e.channel === "leadership");
    if (!leadership) throw new Error("corpus lost the leadership channel");
    const { rows } = await pool.query<{ visible_to: string[] }>(
      `SELECT f.visible_to
         FROM brain_facts f
         JOIN brain_episodes e ON e.workspace_id = f.workspace_id AND e.id = f.source_episode_id
        WHERE f.workspace_id = $1 AND e.source_id = $2 AND f.status = 'published'`,
      [DEMO_ORG, corpusSourceId(leadership)],
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.visible_to).not.toContain("org");
    expect(rows[0]?.visible_to).toContain(`audience:${chatChannelAudienceId("slack", CHANNELS.leadership.id)}`);
  });
});
