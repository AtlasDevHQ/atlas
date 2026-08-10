/**
 * The drift re-key's OPERATOR-FACING info line (#5109).
 *
 * `rekeyDriftedFacts`' own docstring calls this line *"the operator's only
 * signal that the re-key ran and how wide it reached"*, and since #5047 added
 * the `IS NOT NULL` arm the single number it carried stopped being able to say
 * that. `rekeyed: 0` covers two states an operator would act on differently:
 *
 *   - **nothing drifted** — ordinary, healthy, and what a workspace reports on
 *     every approval once its corpus is a fixpoint of its vocabulary; and
 *   - **N rows hold `-unkeyable:` placeholders and were declined** — a corpus
 *     still carrying the legacy degenerate population migration 0194
 *     tombstoned. That population is closed and shrinks only, so a number that
 *     stays flat across approvals is the signal.
 *
 * `skipped_unkeyable` is computed in SQL and pinned against real Postgres in
 * `vocabulary-rekey-pg.test.ts`. What is pinned HERE is the last hop: that the
 * number reaches the LINE. Nothing else in the repo reads it — the value is
 * never returned, never stored and never branched on — so a `log.info` that
 * quietly stopped carrying it would leave four green SQL tests measuring a
 * number no human is shown.
 *
 * That gap is precisely #5105's, one module over, and this file exists so this
 * slice does not reopen it while closing it.
 *
 * ## Why a separate file
 *
 * `acl-logging.test.ts`'s pattern: mocking the logger means `mock.module`ing
 * **every** value export of `@atlas/api/lib/logger` and importing the module
 * under test DYNAMICALLY, so the mock binds first. That is process-wide, so it
 * cannot share a file with `vocabulary-rekey-pg.test.ts`, which wants real
 * logging.
 *
 * Real Postgres, not a scripted executor: the counts come out of the statement,
 * so a fake that answered them would be asserting this file's own arithmetic.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import { Pool } from "pg";

interface Captured {
  readonly payload: Record<string, unknown>;
  readonly message: string;
}

const infos: Captured[] = [];

/** Every value export of `lib/logger`, replaced — a partial mock link-fails. */
void mock.module("@atlas/api/lib/logger", () => {
  const capture = {
    info: (payload: unknown, message?: unknown) =>
      infos.push({
        payload: (payload ?? {}) as Record<string, unknown>,
        message: typeof message === "string" ? message : String(payload),
      }),
    warn: () => {},
    error: () => {},
    debug: () => {},
    level: "info",
  };
  return {
    createLogger: () => capture,
    getLogger: () => capture,
    setLogLevel: () => true,
    getRequestContext: () => undefined,
    withRequestContext: <T,>(_ctx: unknown, fn: () => T): T => fn(),
    redactPaths: [] as string[],
    scrubErrSerializer: (err: unknown) => err,
    scrubLogFormatter: (obj: unknown) => obj,
    hashShareToken: (token: string) => token,
    ACTOR_KINDS: ["human", "agent", "mcp", "scheduler", "api_key"] as const,
  };
});

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;
const WS = "ws-rekey-log-5109";

// DYNAMIC, after the mock above is installed.
const { runMigrations } = await import("@atlas/api/lib/db/migrate");
const { MANAGED_AUTH_MIGRATIONS, _resetPool } = await import("@atlas/api/lib/db/internal");
const { decideAliasProposal, proposeAliasEdge } = await import(
  "@atlas/api/lib/brain/vocabulary-decide"
);
const { reconcileFacts } = await import("@atlas/api/lib/brain/reconcile");
const { identityVocabulary } = await import("@atlas/api/lib/brain/identity");
type BrainPrincipalContext = import("@atlas/api/lib/brain/acl").BrainPrincipalContext;

describeIfPg("the drift re-key's info line (#5109)", () => {
  let pool: Pool;
  const schemaName = `brain_5109log_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let priorDatabaseUrl: string | undefined;

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
    _resetPool(pool);
  }, PG_TEST_TIMEOUT_MS);

  afterAll(async () => {
    _resetPool(null);
    if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDatabaseUrl;
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await pool.end();
    }
  }, PG_TEST_TIMEOUT_MS);

  afterEach(async () => {
    // Targets BEFORE edges — `fk_brain_vocabulary_target_edge` is RESTRICT.
    await pool.query("DELETE FROM brain_vocabulary_target");
    await pool.query("DELETE FROM brain_vocabulary_edge");
    await pool.query("DELETE FROM brain_vocabulary_proposal");
    await pool.query("DELETE FROM brain_edges");
    await pool.query("DELETE FROM brain_facts");
    await pool.query("DELETE FROM brain_episodes");
    infos.length = 0;
  });

  const owner = (): BrainPrincipalContext => ({
    origin: "authenticated",
    workspaceId: WS,
    userId: "user-owner",
    role: "owner",
    audienceIds: ["org"],
  });

  let episodeSeq = 0;
  async function seedEpisode(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_episodes
         (workspace_id, source, source_id, source_actor, body, occurred_at, visible_to)
       VALUES ($1, 'slack', $2, 'U123', 'evidence', '2026-06-21T09:00:00.000Z'::timestamptz,
               ARRAY['org'])
       RETURNING id`,
      [WS, `C01:5109.${episodeSeq++}`],
    );
    return rows[0]!.id;
  }

  /** Land one claim through the REAL ingest stage, under the EMPTY vocabulary. */
  async function land(subject: string, predicate: string, object: string): Promise<void> {
    const id = await seedEpisode();
    const report = await reconcileFacts({
      vocabulary: identityVocabulary,
      episode: {
        id,
        workspaceId: WS,
        source: "slack",
        sourceId: `C01:5109.land.${episodeSeq}`,
        sourceActor: "U123",
        occurredAt: new Date("2026-06-21T09:00:00.000Z"),
        visibleTo: ["org"],
      },
      candidates: [{ subject, predicate, object }],
      producer: "rekey-5109",
      extractedAt: new Date("2026-06-21T10:00:00.000Z"),
    });
    // `reconcileFacts` reports a domain refusal as a counted outcome and never
    // throws, so without this a refused candidate would leave an empty corpus
    // and the counts below would be zero for the wrong reason.
    expect(report.outcomes[0], `"${subject} ${predicate} ${object}" was refused`).not.toMatchObject({
      kind: "blocked",
    });
  }

  /** One TOMBSTONED placeholder row, built the way migration 0194 builds them. */
  async function landDegenerate(objectSurface: string, placeholder: string): Promise<void> {
    const episodeId = await seedEpisode();
    await pool.query(
      `INSERT INTO brain_facts
         (workspace_id, subject, predicate, object,
          subject_key, predicate_key, object_key,
          source_episode_id, provenance, visible_to, invalidated_at)
       VALUES ($1, 'widget', 'is', $2, 'widget', 'is', $3, $4,
               '{"actor":"u1"}'::jsonb, ARRAY['org'], now())`,
      [WS, objectSurface, placeholder, episodeId],
    );
  }

  async function approveObjectAlias(fromNorm: string, toNorm: string): Promise<void> {
    const queued = await proposeAliasEdge(WS, {
      position: "object",
      fromNorm,
      toNorm,
      directed: true,
      sourceClass: "human",
      confidence: 1,
      proposedBy: "user-owner",
    });
    expect(queued.kind).toBe("queued");
    if (queued.kind !== "queued") throw new Error("unreachable");
    const decided = await decideAliasProposal({
      id: queued.id,
      workspaceId: WS,
      decision: "approved",
      approver: { kind: "human", ctx: owner() },
    });
    expect(decided.kind, `approving ${fromNorm} → ${toNorm} did not land`).toBe("approved");
  }

  /** The one re-key completion line, refused if there is not exactly one. */
  function theLine(): Captured {
    const lines = infos.filter((entry) => entry.message.includes("Drift re-key complete"));
    expect(
      lines,
      "expected exactly one re-key completion line — the approval runs the statement for ONE " +
        "position, and more than one means these assertions are reading an arbitrary member",
    ).toHaveLength(1);
    return lines[0]!;
  }

  it("carries BOTH counts — the declined rows beside the moved ones", async () => {
    // ⭐ The assertion this file exists for. Two healthy rows drift onto the
    // approved target; two degenerate rows hold 0194's placeholders and are
    // declined. Distinct values (2 and 2 would pass a line that logged the same
    // number twice — so the fixture uses 2 and 1).
    await land("widget", "is", "friday");
    await land("gadget", "is", "friday");
    await landDegenerate("-", "-unkeyable:seed-a");

    await approveObjectAlias("friday", "fri");

    const { payload } = theLine();
    expect(
      payload,
      "the info line stopped distinguishing `nothing drifted` from `N rows were declined` — " +
        "`skippedUnkeyable` is not read anywhere else in the product, so dropping it from this " +
        "line deletes the signal outright while every SQL-level test stays green",
    ).toMatchObject({ rekeyed: 2, skippedUnkeyable: 1 });
    // The correlation fields, without which the counts name no decision.
    expect(payload).toMatchObject({ workspaceId: WS, position: "object" });
    expect(payload.proposalId).toBeTruthy();
  });

  it("reports zero declined on a corpus with no degenerate rows", async () => {
    // The control, and the half that makes the number readable: on a healthy
    // corpus `skippedUnkeyable` is 0, so a non-zero reading is the exception an
    // operator can act on rather than background noise. A line that hardcoded
    // the count, or wired it to the same expression as `rekeyed`, passes the
    // case above and fails here.
    await land("widget", "is", "friday");

    await approveObjectAlias("friday", "fri");

    expect(theLine().payload).toMatchObject({ rekeyed: 1, skippedUnkeyable: 0 });
  });

  it("distinguishes `nothing drifted` from `everything was declined`", async () => {
    // ⚠️ THE two states #5109 is about, side by side in one assertion. Both
    // report `rekeyed: 0`, and before this slice they were the same line.
    await landDegenerate("-", "-unkeyable:seed-a");
    await landDegenerate("___", "-unkeyable:seed-b");
    // A real alias that moves nothing: no fact carries `friday` at the object,
    // so the approval is a no-op for the healthy population.
    await approveObjectAlias("friday", "fri");

    expect(
      theLine().payload,
      "`rekeyed: 0` with two declined rows read identically to `rekeyed: 0` on a clean corpus",
    ).toMatchObject({ rekeyed: 0, skippedUnkeyable: 2 });
  });
});
