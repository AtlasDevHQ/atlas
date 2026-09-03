/**
 * The synthetic NovaMart corpus, seeded end to end against real Postgres
 * (#5603): ingest → (deterministic) extraction → coverage → approve, then the
 * first-load properties the demo depends on are asserted, so the demo cannot
 * silently decay.
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
 * model's mood. Four arms cover what a live model can do with the
 * contradiction: hint the predicate `single` (reconcile mints the edge at
 * write time) or not (nothing is minted until an admin's sweep, which the
 * seed's declarations make productive); phrase the predicate as something
 * other than the literal surface (the approve phase's keyed declaration is
 * what the sweep then matches, #5620); or phrase the two rivals differently
 * from each other (nothing is declared beyond the literal, both keys named).
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
import { sweepTensionEdges } from "@atlas/api/lib/brain/tension-sweep";
import {
  CHANNELS,
  EPISODES,
  EXPECTED_CLAIMS,
  PEOPLE,
  UNSURVEYED_CHANNEL,
  matchesExpectedClaim,
  type DemoChannelKey,
  type DemoChatMessage,
  type DemoEpisode,
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

/** The demo org, and further rows with the SAME slug, one per arm. */
const DEMO_ORG = "org_nmd_demo_test";
const DEMO_ORG_NO_HINT = "org_nmd_demo_nohint_test";
const DEMO_ORG_REPHRASED = "org_nmd_demo_rephrased_test";
const DEMO_ORG_SPLIT_KEYS = "org_nmd_demo_splitkeys_test";
const TENANT_ORG = "org_nmd_tenant_test";
const APPROVER = "user_nmd_reviewer";

const FAKE_MODEL = {
  model: "fake-model" as unknown as ResolvedExtractionModel["model"],
  modelId: "fake-model",
  batchApiKey: null,
} satisfies ResolvedExtractionModel;

/** The corpus's chat messages in one channel, in corpus order. */
function chatIn(channel: DemoChannelKey): readonly DemoChatMessage[] {
  return EPISODES.filter((e): e is DemoChatMessage => e.kind === "chat" && e.channel === channel);
}

function only<T extends DemoEpisode>(kind: T["kind"]): T {
  const found = EPISODES.filter((e) => e.kind === kind);
  if (found.length !== 1) throw new Error(`corpus has ${found.length} ${kind} episodes, expected 1`);
  return found[0] as T;
}

/** Distinct (source, author) pairs the corpus carries — what identity capture writes. */
function authoringPairs(): number {
  const pairs = new Set<string>();
  for (const e of EPISODES) {
    if (e.kind === "chat") pairs.add(`slack:${e.author}`);
    else if (e.kind === "transcript") pairs.add(`zoom:${e.host}`);
    else pairs.add(`outlook:${e.from}`);
  }
  return pairs.size;
}

/**
 * What each corpus episode was written to yield, keyed by its stored
 * `source_id`. Kept beside the test rather than in the corpus module so the
 * corpus cannot grow a "what the extractor should say" field that a future
 * seed might be tempted to write from.
 *
 * `hintSingle` decides whether the two return-window candidates carry the
 * extractor's per-claim `predicateCardinality: "single"` hint — the thing
 * reconcile's write-time tension pass is gated on. `rivalPredicates` is the
 * surface each rival's predicate is phrased as, in corpus order (30 then 14):
 * the literal by default, or the live extractor's own phrasing, which is what
 * the rows' `predicate_key` — and every cardinality lookup — is made of.
 */
function deterministicClaims(
  hintSingle: boolean,
  rivalPredicates: readonly [string, string] = ["return window", "return window"],
): ReadonlyMap<string, readonly FactCandidate[]> {
  const out = new Map<string, readonly FactCandidate[]>();
  const set = (episode: DemoEpisode | undefined, claims: readonly FactCandidate[]) => {
    if (episode === undefined) throw new Error("test fixture references an episode the corpus no longer has");
    out.set(corpusSourceId(episode), claims);
  };
  const hint = hintSingle ? { predicateCardinality: "single" as const } : {};
  const [finance30, , financeGmv] = chatIn("finance");
  const [support14] = chatIn("support");
  const [engineeringDecision] = chatIn("engineering");
  const [leadershipThreshold] = chatIn("leadership");

  set(finance30, [{ subject: "NovaMart", predicate: rivalPredicates[0], object: "30 days from delivery", ...hint }]);
  set(financeGmv, [{ subject: "NovaMart", predicate: "GMV for December 2024", object: "about $1.9M" }]);
  set(support14, [{ subject: "NovaMart", predicate: rivalPredicates[1], object: "14 days from delivery", ...hint }]);
  set(engineeringDecision, [
    { subject: "nightly ETL", predicate: "runs at", object: "02:00 UTC" },
    { subject: "nightly ETL", predicate: "owned by", object: "Dana Okafor" },
  ]);
  set(leadershipThreshold, [
    { subject: "NovaMart", predicate: "free-shipping threshold for Q4 2026", object: "$75" },
  ]);
  set(only("transcript"), [
    { subject: "NovaMart support team", predicate: "grows by", object: "two people in Q4 2026" },
  ]);
  set(only("email"), [
    { subject: "NovaMart", predicate: "holiday cutoff for standard shipping", object: "18 December 2026" },
    { subject: "NovaMart", predicate: "holiday cutoff for express shipping", object: "21 December 2026" },
  ]);
  return out;
}

/** The approved `single` keys a workspace holds — what `cardinalitySingleSql` can match. */
async function approvedSingleKeys(pool: Pool, workspaceId: string): Promise<string[]> {
  const { rows } = await pool.query<{ predicate_key: string }>(
    `SELECT predicate_key FROM brain_predicate_cardinality
      WHERE workspace_id = $1 AND cardinality = 'single' AND status = 'approved'
      ORDER BY predicate_key`,
    [workspaceId],
  );
  return rows.map((r) => r.predicate_key);
}

async function extractWith(claims: ReadonlyMap<string, readonly FactCandidate[]>) {
  const extract: FactExtractor = async ({ episode }) => claims.get(episode.sourceId) ?? [];
  _resetBrainExtractionFailures();
  return Effect.runPromise(
    runBrainExtractionCycle({
      extract,
      resolveModel: async () => FAKE_MODEL,
      loadVocabulary: async () => identityVocabulary,
    }),
  );
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
      `INSERT INTO organization (id, name, slug, "createdAt") VALUES
         ($1, 'NovaMart Demo', $2, now()),
         ($3, 'NovaMart Demo (no hint)', $2, now()),
         ($4, 'Tenant X', 'tenant-x', now()),
         ($5, 'NovaMart Demo (rephrased)', $2, now()),
         ($6, 'NovaMart Demo (split keys)', $2, now())
       ON CONFLICT DO NOTHING`,
      [DEMO_ORG, DEMO_ATLAS_WORKSPACE_SLUG, DEMO_ORG_NO_HINT, TENANT_ORG, DEMO_ORG_REPHRASED, DEMO_ORG_SPLIT_KEYS],
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
    await expect(seedDemoCorpusApprove({ workspaceRef: TENANT_ORG, approvedBy: APPROVER })).rejects.toBeInstanceOf(
      NotTheDemoWorkspaceError,
    );
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM brain_episodes WHERE workspace_id = $1`,
      [TENANT_ORG],
    );
    expect(rows[0]?.n).toBe("0");
  });

  it("ingests every corpus episode through the intake seam, once — a re-run inserts nothing and re-declares cleanly", async () => {
    const first = await seedDemoCorpusIngest({ workspaceRef: DEMO_ORG, authoredBy: APPROVER });
    expect(first.workspaceId).toBe(DEMO_ORG);
    const chatCount = EPISODES.filter((e) => e.kind === "chat").length;
    expect(first.episodes.slack).toEqual({ inserted: chatCount, duplicate: 0, refused: 0 });
    expect(first.episodes.zoom).toEqual({ inserted: 1, duplicate: 0, refused: 0 });
    expect(first.episodes.outlook).toEqual({ inserted: 1, duplicate: 0, refused: 0 });
    expect(first.episodes.warehouse).toBeUndefined();
    expect(first.identitiesCaptured).toBe(authoringPairs());
    expect(first.cardinality).toEqual({ ok: true, cardinality: "single" });

    const again = await seedDemoCorpusIngest({ workspaceRef: DEMO_ORG, authoredBy: APPROVER });
    expect(again.episodes.slack).toEqual({ inserted: 0, duplicate: chatCount, refused: 0 });
    expect(again.episodes.zoom?.inserted).toBe(0);
    expect(again.episodes.outlook?.inserted).toBe(0);
    // The declaration is an upsert, so a re-run is ok again — not a refusal
    // and not a warning about an edge that will not be minted.
    expect(again.cardinality).toEqual({ ok: true, cardinality: "single" });

    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM brain_episodes WHERE workspace_id = $1`,
      [DEMO_ORG],
    );
    expect(rows[0]?.n).toBe(String(EPISODES.length));
  }, PG_TEST_TIMEOUT_MS);

  it("carries the private channel's audience grant and the public channels' org grant, from the real deriver", async () => {
    const [leadership] = chatIn("leadership");
    const [finance] = chatIn("finance");
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

  it("names every authoring actor as a dated directory identity, keyed the way the attribution join composes it — and no one who authored nothing", async () => {
    const { rows } = await pool.query<{ actor: string; state: string; real_name: string | null }>(
      `SELECT actor, state, real_name FROM brain_actor_identity WHERE workspace_id = $1 ORDER BY actor`,
      [DEMO_ORG],
    );
    expect(rows.length).toBe(authoringPairs());
    const priya = rows.find((r) => r.actor === `slack:${PEOPLE.priya.slackId}`);
    expect(priya).toEqual({ actor: `slack:${PEOPLE.priya.slackId}`, state: "directory", real_name: "Priya Natarajan" });
    // Marcus never hosted a recording or sent a mail, so no zoom/outlook row.
    expect(rows.some((r) => r.actor === `zoom:${PEOPLE.marcus.zoomId}`)).toBe(false);
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
    for (const key of Object.keys(CHANNELS) as DemoChannelKey[]) {
      if (key === UNSURVEYED_CHANNEL) continue;
      expect(byId.get(CHANNELS[key].id)?.state).toBe("surveyed");
    }
  });

  it("approves nothing before extraction has run, and reports every expected claim missing rather than inventing one", async () => {
    const report = await seedDemoCorpusApprove({ workspaceRef: DEMO_ORG, approvedBy: APPROVER });
    expect(report.promoted).toEqual([]);
    expect(report.refused).toEqual([]);
    expect(report.missing).toEqual(EXPECTED_CLAIMS.map((c) => c.key));
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM brain_facts WHERE workspace_id = $1`,
      [DEMO_ORG],
    );
    expect(rows[0]?.n).toBe("0");
  });

  it("with a `single` hint: approve promotes exactly the corpus's drafts through the gate, the edge is already minted, and the audit row names the human", async () => {
    const cycle = await extractWith(deterministicClaims(true));
    expect(cycle.status).toBe("success");
    // Both demo orgs' episodes are drained by the one process-wide cycle; only
    // the hinted org's count is pinned here, the other arm reads its own.
    expect(cycle.extracted).toBeGreaterThanOrEqual(EPISODES.length);

    const drafts = await pool.query<{ id: string }>(
      `SELECT id FROM brain_facts WHERE workspace_id = $1 AND status = 'draft' ORDER BY id`,
      [DEMO_ORG],
    );
    expect(drafts.rows.length).toBeGreaterThan(0);

    const report = await seedDemoCorpusApprove({ workspaceRef: DEMO_ORG, approvedBy: APPROVER });
    expect([...report.promoted].sort()).toEqual(drafts.rows.map((r) => r.id).sort());
    expect(report.refused).toEqual([]);
    expect(report.missing).toEqual([]);
    expect(report.expected.every((e) => e.found)).toBe(true);
    // The rivals carry the literal key here, so the keyed declaration lands on
    // the same entry the ingest phase wrote — one entry, not two.
    expect(report.cardinality).toEqual({ kind: "declared", predicateKey: "return window", cardinality: "single" });
    expect(await approvedSingleKeys(pool, DEMO_ORG)).toEqual(["return window"]);

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
    // arbitrated), and reconcile minted the `in-tension-with` edge at write
    // time because the hint was there.
    expect(report.tensionEdges).toBeGreaterThanOrEqual(1);
    const rivals = published.rows.filter((r) => r.predicate.toLowerCase().includes("return window"));
    expect(rivals.length).toBe(2);

    // The audit row's ACTOR is the human — not a system principal with the
    // person in metadata — and the ids on it are the promoted set exactly.
    const audit = await pool.query<{ actor_id: string; metadata: Record<string, unknown> }>(
      `SELECT actor_id, metadata FROM admin_action_log WHERE action_type = 'brain.demo_corpus_seed' AND target_id = $1 ORDER BY timestamp DESC LIMIT 1`,
      [DEMO_ORG],
    );
    expect(audit.rows[0]?.actor_id).toBe(APPROVER);
    expect(audit.rows[0]?.metadata.promotedFactIds).toEqual(report.promoted);
    expect(audit.rows[0]?.metadata.refused).toEqual([]);
  }, PG_TEST_TIMEOUT_MS);

  it("a second approve is a no-op: nothing left to promote, every expected claim still found", async () => {
    const report = await seedDemoCorpusApprove({ workspaceRef: DEMO_ORG, approvedBy: APPROVER });
    expect(report.promoted).toEqual([]);
    expect(report.missing).toEqual([]);
  });

  it("the private-channel claim keeps the channel's audience grant after promotion — it is not widened to the org", async () => {
    const [leadership] = chatIn("leadership");
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

  it("without a `single` hint: nothing is minted at write time, and the ingest phase's declaration is what makes an admin's sweep mint the edge", async () => {
    const ingest = await seedDemoCorpusIngest({ workspaceRef: DEMO_ORG_NO_HINT, authoredBy: APPROVER });
    expect(ingest.workspaceId).toBe(DEMO_ORG_NO_HINT);
    const cycle = await extractWith(deterministicClaims(false));
    expect(cycle.status).toBe("success");

    const report = await seedDemoCorpusApprove({ workspaceRef: DEMO_ORG_NO_HINT, approvedBy: APPROVER });
    expect(report.missing).toEqual([]);
    // What a fresh demo gets when the live model does not hint: both rivals
    // published, no edge yet. The seed does not sweep (one caller, ADR-0037 §7).
    expect(report.tensionEdges).toBe(0);

    // The admin's act, called directly here because tests are outside the
    // one-caller pin. The `single` declaration from ingest is the positive
    // evidence the sweep requires; without it this would mint nothing.
    const sweep = await sweepTensionEdges(DEMO_ORG_NO_HINT);
    expect(sweep.kind).toBe("swept");
    if (sweep.kind !== "swept") throw new Error("unreachable");
    expect(sweep.report.minted).toBeGreaterThanOrEqual(1);
    const edges = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM brain_edges WHERE workspace_id = $1 AND edge_type = 'in-tension-with'`,
      [DEMO_ORG_NO_HINT],
    );
    expect(Number(edges.rows[0]?.n)).toBeGreaterThanOrEqual(1);
  }, PG_TEST_TIMEOUT_MS);

  it("rivals phrased as the live extractor phrases them, no hint: approve declares THEIR key single, additively and idempotently, and the sweep mints the edge (#5620)", async () => {
    const ingest = await seedDemoCorpusIngest({ workspaceRef: DEMO_ORG_REPHRASED, authoredBy: APPROVER });
    expect(ingest.cardinality).toEqual({ ok: true, cardinality: "single" });
    // Only the literal is declared before extraction — the key the rows will
    // carry does not exist yet to be read.
    expect(await approvedSingleKeys(pool, DEMO_ORG_REPHRASED)).toEqual(["return window"]);

    const cycle = await extractWith(deterministicClaims(false, ["has return window of", "has return window of"]));
    expect(cycle.status).toBe("success");

    const report = await seedDemoCorpusApprove({ workspaceRef: DEMO_ORG_REPHRASED, approvedBy: APPROVER });
    expect(report.missing).toEqual([]);
    expect(report.tensionEdges).toBe(0);
    expect(report.cardinality).toEqual({
      kind: "declared",
      predicateKey: "has return window of",
      cardinality: "single",
    });
    // Additive: the literal entry is still there beside the keyed one.
    expect(await approvedSingleKeys(pool, DEMO_ORG_REPHRASED)).toEqual(["has return window of", "return window"]);
    const entry = await pool.query<{ source_class: string; proposed_by: string; reviewed_by: string }>(
      `SELECT source_class, proposed_by, reviewed_by FROM brain_predicate_cardinality WHERE workspace_id = $1 AND predicate_key = $2`,
      [DEMO_ORG_REPHRASED, "has return window of"],
    );
    expect(entry.rows[0]).toEqual({ source_class: "human", proposed_by: APPROVER, reviewed_by: APPROVER });

    // Idempotent: a second approve re-declares the same key and adds no entry.
    const again = await seedDemoCorpusApprove({ workspaceRef: DEMO_ORG_REPHRASED, approvedBy: APPROVER });
    expect(again.promoted).toEqual([]);
    expect(again.cardinality).toEqual({
      kind: "declared",
      predicateKey: "has return window of",
      cardinality: "single",
    });
    expect(await approvedSingleKeys(pool, DEMO_ORG_REPHRASED)).toEqual(["has return window of", "return window"]);

    // The sweep matches on the rows' key. Before #5620 only the literal was
    // declared, the rows carried this key, and this minted nothing.
    const sweep = await sweepTensionEdges(DEMO_ORG_REPHRASED);
    expect(sweep.kind).toBe("swept");
    if (sweep.kind !== "swept") throw new Error("unreachable");
    expect(sweep.report.minted).toBeGreaterThanOrEqual(1);
    const edges = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM brain_edges WHERE workspace_id = $1 AND edge_type = 'in-tension-with'`,
      [DEMO_ORG_REPHRASED],
    );
    expect(Number(edges.rows[0]?.n)).toBeGreaterThanOrEqual(1);
  }, PG_TEST_TIMEOUT_MS);

  it("rivals under DIFFERENT keys: approve warns naming both and declares nothing beyond the literal (#5620)", async () => {
    await seedDemoCorpusIngest({ workspaceRef: DEMO_ORG_SPLIT_KEYS, authoredBy: APPROVER });
    const cycle = await extractWith(deterministicClaims(false, ["return window", "has return window of"]));
    expect(cycle.status).toBe("success");

    const report = await seedDemoCorpusApprove({ workspaceRef: DEMO_ORG_SPLIT_KEYS, approvedBy: APPROVER });
    expect(report.missing).toEqual([]);
    expect(report.cardinality).toEqual({
      kind: "keys-differ",
      predicateKeys: ["has return window of", "return window"],
    });
    // A wrong-key declaration is worse than none: only the ingest phase's
    // literal entry exists, and it is the one a person would alias onto.
    expect(await approvedSingleKeys(pool, DEMO_ORG_SPLIT_KEYS)).toEqual(["return window"]);
  }, PG_TEST_TIMEOUT_MS);
});
