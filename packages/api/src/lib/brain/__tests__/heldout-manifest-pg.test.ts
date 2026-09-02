/**
 * Real-Postgres coverage for the frozen held-out manifest (#5338).
 *
 * `heldout-manifest.test.ts` pins the shape and the refusals against a literal
 * handle. Five questions need a real database and none of them can be answered
 * there:
 *
 *   1. **Does the classification SQL actually run?** It composes three of
 *      `gate-export`'s exported predicates into sub-selects the exporter never
 *      writes that way. Only a real Postgres proves the composition parses and
 *      means what it reads like.
 *   2. ⭐ **Do the manifest's classes AGREE with `gate-export`'s?** This is the
 *      load-bearing one. The manifest is per-EPISODE and the bundle is
 *      per-DECISION, and #5338 measures recall against the bundle's population.
 *      Two queries over one seeded workspace must not disagree about which
 *      episodes are positives, or the number is computed over a population the
 *      corpus does not contain.
 *   3. **Does the window window?** The whole no-author claim rests on it.
 *   4. **Does the dial evidence see a real triage mark, a real audit row and a
 *      real settings row?** Each probe reads a different table, and each is a
 *      refusal — a probe that silently matched nothing would turn AC 2 into a
 *      decoration.
 *   5. **Does a purged episode really stop resolving?** That is the property
 *      that makes freezing a manifest safer than freezing a bundle.
 *
 * Opt in locally with:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS } from "@atlas/api/lib/db/internal";
import { WAREHOUSE_SOURCE, HUMAN_SOURCE } from "@atlas/api/lib/brain/sources";
import { loadGateDecisions, type GateExportReader } from "@atlas/api/lib/brain/gate-export";
import {
  HELDOUT_REFUSALS,
  TRIAGE_DIAL_SETTING_KEY,
  cutHeldoutManifest,
  loadTriageDialEvidence,
  resolveHeldoutManifest,
  type HeldoutManifest,
} from "@atlas/api/lib/brain/heldout-manifest";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

/** The window every test cuts over, and an instant safely after it. */
const FROM = "2026-06-01T00:00:00.000Z";
const TO = "2026-07-01T00:00:00.000Z";
const IN_WINDOW = new Date("2026-06-15T00:00:00.000Z");
const BEFORE_WINDOW = new Date("2026-05-01T00:00:00.000Z");
const NOW = new Date("2026-08-01T00:00:00.000Z");

describeIfPg("brain held-out manifest (real Postgres)", () => {
  let pool: Pool;
  let reader: GateExportReader;
  const schemaName = `brain_heldout_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    // `search_path` baked into the connection string, not SET from an unawaited
    // `pool.on("connect")` handler — see the note in `acl-visibility-pg.test.ts`.
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
    reader = { query: (sql, params) => pool.query(sql, params) };
  }, PG_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await pool.end();
    }
  }, PG_TEST_TIMEOUT_MS);

  async function seedEpisode(
    workspaceId: string,
    sourceId: string,
    opts: {
      readonly source?: string;
      readonly extracted?: boolean;
      readonly ingestedAt?: Date;
      readonly triagedOut?: boolean;
    } = {},
  ): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_episodes (
         workspace_id, source, source_id, body, visible_to,
         extracted_at, ingested_at, triaged_out_at, triage_reason
       ) VALUES ($1, $2, $3, 'evidence', ARRAY['org']::text[], $4, $5, $6, $7)
       RETURNING id`,
      [
        workspaceId,
        opts.source ?? "slack",
        sourceId,
        opts.extracted === false ? null : IN_WINDOW,
        opts.ingestedAt ?? IN_WINDOW,
        opts.triagedOut === true ? IN_WINDOW : null,
        opts.triagedOut === true ? "known_ack" : null,
      ],
    );
    return rows[0]!.id;
  }

  async function seedFact(
    workspaceId: string,
    episodeId: string,
    opts: {
      readonly predicate?: string;
      readonly status?: string;
      readonly invalidated?: boolean;
      readonly source?: string;
    } = {},
  ): Promise<string> {
    const predicate = opts.predicate ?? "leads";
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_facts (
         workspace_id, subject, predicate, object,
         subject_key, predicate_key, object_key,
         source_episode_id, provenance, status, visible_to, extracted_at, invalidated_at
       ) VALUES (
         $1, 'Ana', $2, 'Platform', 'ana', $3, 'platform',
         $4::uuid, $5::jsonb, $6, ARRAY['org']::text[], now(), $7
       ) RETURNING id`,
      [
        workspaceId,
        predicate,
        predicate,
        episodeId,
        JSON.stringify({ actor: "slack:U1", sourceId: "C1:1", source: opts.source ?? "slack" }),
        opts.status ?? "published",
        opts.invalidated === true ? new Date() : null,
      ],
    );
    return rows[0]!.id;
  }

  /** The human-authored correction episode a real retraction materializes. */
  async function seedHumanRetraction(
    workspaceId: string,
    factId: string,
    sourceId: string,
  ): Promise<void> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_episodes (workspace_id, source, source_id, body, visible_to, ingested_at)
       VALUES ($1, $2, $3, 'retracted by a reviewer', ARRAY['org']::text[], $4)
       RETURNING id`,
      [workspaceId, HUMAN_SOURCE, `correction:${sourceId}`, IN_WINDOW],
    );
    await pool.query(
      `INSERT INTO brain_edges (workspace_id, edge_type, from_fact_id, to_episode_id)
       VALUES ($1, 'derives-from', $2::uuid, $3::uuid)`,
      [workspaceId, factId, rows[0]!.id],
    );
  }

  async function seedCycleAudit(at: Date, triaged: unknown): Promise<void> {
    await pool.query(
      `INSERT INTO admin_action_log (timestamp, scope, action_type, target_type, target_id, request_id, metadata)
       VALUES ($1, 'platform', 'brain.extraction_cycle', 'brain', 'scheduler', $2, $3::jsonb)`,
      [at, `req-${Math.random()}`, JSON.stringify({ skipped: { triaged } })],
    );
  }

  /**
   * Drop every extraction-cycle audit row.
   *
   * ⚠️ Needed because the audit probe is deliberately NOT workspace-scoped —
   * the extraction fiber is process-wide, so a triage drop in ANY workspace is
   * proof the dial was on in the region. That is the right production
   * behaviour and it makes these rows shared state between tests in one schema,
   * so the tests that seed a dirty row clean up after themselves.
   */
  async function clearCycleAudit(): Promise<void> {
    await pool.query(`DELETE FROM admin_action_log WHERE action_type = 'brain.extraction_cycle'`);
  }

  async function cut(workspaceId: string): Promise<
    Awaited<ReturnType<typeof cutHeldoutManifest>>
  > {
    return cutHeldoutManifest(reader, {
      workspaceId,
      apiRegion: null,
      workspaceRegion: null,
      from: FROM,
      to: TO,
      now: NOW,
    });
  }

  async function cutOk(workspaceId: string): Promise<HeldoutManifest> {
    const result = await cut(workspaceId);
    if (!result.ok) throw new Error(`expected a manifest, got ${result.refusal.refusal}`);
    return result.manifest;
  }

  // -------------------------------------------------------------------------

  it("classifies the three arms at the EPISODE grain", async () => {
    const ws = "ws-classes";
    const approved = await seedEpisode(ws, "c:1");
    await seedFact(ws, approved, { predicate: "leads" });

    const retracted = await seedEpisode(ws, "c:2");
    // The retract verb stamps `invalidated_at` and leaves `status` alone; the
    // correction episode is what makes it a HUMAN rejection rather than an
    // import artifact.
    const retractedFact = await seedFact(ws, retracted, {
      predicate: "owns",
      status: "draft",
      invalidated: true,
    });
    await seedHumanRetraction(ws, retractedFact, "c:2");

    const silent = await seedEpisode(ws, "c:3");
    const pending = await seedEpisode(ws, "c:4", { extracted: false });
    const drafted = await seedEpisode(ws, "c:5");
    await seedFact(ws, drafted, { predicate: "reports-to", status: "draft" });

    const manifest = await cutOk(ws);
    const byId = new Map(manifest.entries.map((e) => [e.episodeId, e.class]));
    expect(byId.get(approved)).toBe("positive");
    expect(byId.get(retracted)).toBe("rejected");
    expect(byId.get(silent)).toBe("negative");
    // Pending and undecided belong to no arm — and are COUNTED, not dropped.
    expect(byId.has(pending)).toBe(false);
    expect(byId.has(drafted)).toBe(false);
    // Three, not two: the human correction episode `seedHumanRetraction` mints
    // is itself an episode in this window, and it is never extracted — so it is
    // pending, exactly as `gate-export`'s negative arm also finds it. Worth
    // pinning rather than filtering out: the excluded count is a real
    // population an operator reads, and it includes the review gate's own
    // paper trail.
    expect(manifest.counts.excluded).toBe(3);
  });

  it("collapses one episode's two decisions onto `positive`", async () => {
    const ws = "ws-precedence";
    const both = await seedEpisode(ws, "p:1");
    await seedFact(ws, both, { predicate: "leads", status: "published" });
    const rejectedFact = await seedFact(ws, both, {
      predicate: "owns",
      status: "draft",
      invalidated: true,
    });
    await seedHumanRetraction(ws, rejectedFact, "p:1");

    const manifest = await cutOk(ws);
    expect(manifest.entries).toHaveLength(1);
    // The recall question is "did triage drop an episode that carried a real
    // fact" — and this episode carried one, whatever else the reviewer threw
    // away. Both counts ride along so the collapse is auditable from the file.
    expect(manifest.entries[0]).toMatchObject({
      class: "positive",
      positiveFacts: 1,
      rejectedFacts: 1,
    });
  });

  it("an episode whose only claim is ARCHIVED is a negative, as in the bundle", async () => {
    const ws = "ws-archived";
    const archivedOnly = await seedEpisode(ws, "a:1");
    await seedFact(ws, archivedOnly, { predicate: "leads", status: "archived" });

    const manifest = await cutOk(ws);
    // The spec's wording is "yielded no promoted fact", and an archived claim
    // was not promoted. `gate-export`'s `silent` arm agrees — the cross-check
    // below is what keeps the two from drifting.
    expect(manifest.entries).toEqual([
      { episodeId: archivedOnly, class: "negative", positiveFacts: 0, rejectedFacts: 0 },
    ]);
  });

  it("excludes warehouse episodes, exactly as the bundle does", async () => {
    const ws = "ws-warehouse";
    const reading = await seedEpisode(ws, "w:1", { source: WAREHOUSE_SOURCE });
    await seedFact(ws, reading, { predicate: "measures", source: WAREHOUSE_SOURCE });

    const manifest = await cutOk(ws);
    expect(manifest.entries.map((e) => e.episodeId)).not.toContain(reading);
  });

  it("⭐ agrees with `gate-export` about which episodes are positives", async () => {
    // The load-bearing cross-check. The manifest names the population #5338's
    // recall denominator is computed over, and `gate-export` supplies the rows
    // that population is measured with. If the two ever disagree, the number is
    // computed over a set the corpus does not contain — and the disagreement
    // would be invisible in either suite alone.
    const ws = "ws-agreement";
    const a = await seedEpisode(ws, "g:1");
    await seedFact(ws, a, { predicate: "leads" });
    const b = await seedEpisode(ws, "g:2");
    const rejected = await seedFact(ws, b, {
      predicate: "owns",
      status: "draft",
      invalidated: true,
    });
    await seedHumanRetraction(ws, rejected, "g:2");
    await seedEpisode(ws, "g:3");
    await seedEpisode(ws, "g:4", { extracted: false });
    const archived = await seedEpisode(ws, "g:5");
    await seedFact(ws, archived, { predicate: "leads", status: "archived" });

    const manifest = await cutOk(ws);
    const bundle = await loadGateDecisions(reader, ws);
    expect(bundle.ok).toBe(true);
    if (!bundle.ok) return;

    // The bundle is per-decision, so collapse it the way the header says the
    // manifest does — computed from the BUNDLE's rows, independently of the
    // cut's SQL, so agreement is a real cross-check and not the same query run
    // twice.
    const fromBundle = new Map<string, string>();
    for (const row of bundle.decisions) {
      // `positive` wins; otherwise first writer holds, and the seeded workspace
      // has no episode carrying both `rejected` and `negative` (the classes are
      // disjoint per fact, and a negative episode has no fact at all).
      if (row.decision === "positive" || !fromBundle.has(row.episode.id)) {
        fromBundle.set(row.episode.id, row.decision);
      }
    }
    const fromManifest = new Map<string, string>(
      manifest.entries.map((e) => [e.episodeId, e.class]),
    );
    const byId = (a: readonly [string, string], b: readonly [string, string]): number =>
      a[0].localeCompare(b[0]);
    expect([...fromManifest.entries()].sort(byId)).toEqual([...fromBundle.entries()].sort(byId));
  });

  it("windows on ingested_at — an episode outside [from, to) is not in the set", async () => {
    const ws = "ws-window";
    const inside = await seedEpisode(ws, "t:1", { ingestedAt: IN_WINDOW });
    await seedFact(ws, inside, { predicate: "leads" });
    const before = await seedEpisode(ws, "t:2", { ingestedAt: BEFORE_WINDOW });
    await seedFact(ws, before, { predicate: "leads" });
    // The window is half-open, so an episode ingested exactly at `to` is OUT.
    const atUpperBound = await seedEpisode(ws, "t:3", { ingestedAt: new Date(TO) });
    await seedFact(ws, atUpperBound, { predicate: "leads" });

    const manifest = await cutOk(ws);
    expect(manifest.entries.map((e) => e.episodeId)).toEqual([inside]);
  });

  // -------------------------------------------------------------------------
  // The dial evidence (AC 2) — each probe against its real table
  // -------------------------------------------------------------------------

  it("refuses on a real triaged-out mark inside the window", async () => {
    const ws = "ws-dial-mark";
    await seedEpisode(ws, "d:1");
    await seedEpisode(ws, "d:2", { extracted: false, triagedOut: true });

    const result = await cut(ws);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.refusal).toBe(HELDOUT_REFUSALS.triageActive);
  });

  it("refuses on a real cycle audit row reporting triage, and not on a zero one", async () => {
    const ws = "ws-dial-audit";
    await seedEpisode(ws, "d:3");

    await seedCycleAudit(IN_WINDOW, 0);
    const clean = await cut(ws);
    expect(clean.ok).toBe(true);

    await seedCycleAudit(IN_WINDOW, 7);
    try {
      const dirty = await cut(ws);
      expect(dirty.ok).toBe(false);
      if (dirty.ok) return;
      expect(dirty.refusal.refusal).toBe(HELDOUT_REFUSALS.triageActive);
      expect(dirty.refusal.detail).toContain("audit row");
    } finally {
      await clearCycleAudit();
    }
  });

  it("treats an unparseable skipped.triaged as triage rather than throwing", async () => {
    // The fail-closed direction, run against a real jsonb column: a numeric
    // cast here would raise `invalid input syntax for type numeric` and turn a
    // malformed audit row into an exception instead of into evidence.
    const ws = "ws-dial-garbage";
    await seedCycleAudit(IN_WINDOW, "n/a");
    try {
      const evidence = await loadTriageDialEvidence(reader, {
        workspaceId: ws,
        from: FROM,
        to: TO,
        cutAt: NOW.toISOString(),
      });
      expect(evidence.cyclesReportingTriage).toBeGreaterThan(0);
    } finally {
      await clearCycleAudit();
    }
  });

  it("counts cycles between the window's START and the CUT, not merely the window", async () => {
    // An episode ingested inside the window can be drained at any time up to
    // the cut, so a triage drop recorded AFTER the window still pre-filters it.
    const ws = "ws-dial-span";
    await seedCycleAudit(new Date("2026-07-15T00:00:00.000Z"), 3);
    try {
      const evidence = await loadTriageDialEvidence(reader, {
        workspaceId: ws,
        from: FROM,
        to: TO,
        cutAt: NOW.toISOString(),
      });
      expect(evidence.cyclesReportingTriage).toBeGreaterThan(0);
    } finally {
      await clearCycleAudit();
    }
  });

  it("refuses on a real platform settings row switching the dial on", async () => {
    const ws = "ws-dial-setting";
    await seedEpisode(ws, "d:4");
    await pool.query(
      `INSERT INTO settings (key, value, org_id) VALUES ($1, 'true', NULL)`,
      [TRIAGE_DIAL_SETTING_KEY],
    );
    try {
      const result = await cut(ws);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.refusal.detail).toContain("window has closed");
    } finally {
      await pool.query(`DELETE FROM settings WHERE key = $1`, [TRIAGE_DIAL_SETTING_KEY]);
    }
  });

  // -------------------------------------------------------------------------
  // Re-resolution
  // -------------------------------------------------------------------------

  it("a purged episode stops resolving — loudly, by name", async () => {
    const ws = "ws-purge";
    const kept = await seedEpisode(ws, "r:1");
    await seedFact(ws, kept, { predicate: "leads" });
    const doomed = await seedEpisode(ws, "r:2");
    await seedFact(ws, doomed, { predicate: "owns" });

    const manifest = await cutOk(ws);
    expect(manifest.entries).toHaveLength(2);

    // What `hardDeleteWorkspace` does to these rows, one episode at a time.
    await pool.query(`DELETE FROM brain_facts WHERE source_episode_id = $1::uuid`, [doomed]);
    await pool.query(`DELETE FROM brain_episodes WHERE id = $1::uuid`, [doomed]);

    const resolution = await resolveHeldoutManifest(reader, manifest);
    // The property that makes freezing a MANIFEST safer than freezing a bundle:
    // a committed bundle would still be serving this episode's body.
    expect(resolution).toMatchObject({ checked: 2, resolved: 1, missing: [doomed] });
  });

  it("reports a post-cut retraction as drift, and leaves the frozen label alone", async () => {
    const ws = "ws-drift";
    const episode = await seedEpisode(ws, "s:1");
    const fact = await seedFact(ws, episode, { predicate: "leads" });

    const manifest = await cutOk(ws);
    expect(manifest.entries[0]?.class).toBe("positive");

    await pool.query(`UPDATE brain_facts SET invalidated_at = now() WHERE id = $1::uuid`, [fact]);
    await seedHumanRetraction(ws, fact, "s:1");

    const resolution = await resolveHeldoutManifest(reader, manifest);
    expect(resolution.missing).toEqual([]);
    expect(resolution.drifted).toEqual([
      { episodeId: episode, frozen: "positive", live: "rejected" },
    ]);
    // The manifest owns the label as of its cutAt — decision time is not
    // queryable, so a set that re-derived its labels would silently drift.
    expect(manifest.entries[0]?.class).toBe("positive");
  });
});
