/**
 * The drift re-key's OPERATOR-FACING info line (#5109).
 *
 * `rekeyDriftedFacts`' own docstring calls this line *"the operator's only
 * signal that the re-key ran and how wide it reached"*, and since #5047 added
 * the `IS NOT NULL` arm the single number it carried stopped being able to say
 * that. `rekeyed: 0` covers THREE states an operator would act on differently:
 *
 *   - **nothing drifted** — ordinary, healthy, and what a workspace reports on
 *     every approval once its corpus is a fixpoint of its vocabulary;
 *   - **N rows hold `-unkeyable:` placeholders and were declined**
 *     (`skippedDegenerateSurface`) — a corpus still carrying the legacy
 *     degenerate population migration 0194 tombstoned. Nothing to do: the set
 *     is closed and shrinks only, so a flat number is health; and
 *   - **N rows were declined because this workspace's vocabulary maps their
 *     norm to something that normalizes away** (`skippedVocabularyTarget`) —
 *     ⚠️ the one to act on. Their surfaces key fine and they keep the key the
 *     PREVIOUS vocabulary decided, so the closure and the corpus disagree. No
 *     re-key repairs it; the `brain_vocabulary_target` entry is the defect.
 *     (The count is not scoped by `invalidated_at` — this statement
 *     deliberately is not — so it reads as "rows the vocabulary now disagrees
 *     with" rather than strictly "live rows".)
 *
 * ⚠️ The third state is why there are two skip counts and not one. The first
 * cut of #5109 merged them, which re-collapsed the exact distinction the slice
 * was filed to undo — one layer above the arm that draws it, and against the
 * same three-way `cause` that `reconcile.ts`'s `MALFORMED_CLAIM` and the region
 * import's two refusal types both draw over this identical NULL.
 *
 * The counts are computed in SQL and pinned against real Postgres in
 * `vocabulary-rekey-pg.test.ts`. What is pinned HERE is the last hop: that they
 * reach the LINE, and that the line's MESSAGE changes when the actionable one
 * is non-zero. Nothing else in the repo reads them — the values are never
 * returned, never stored, never branched on except for that message — so a
 * `log.info` that quietly stopped carrying one would leave every SQL test green
 * while measuring a number no human is shown.
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
/** Separate sink: the LEVEL is part of what this file pins, not just the payload. */
const warns: Captured[] = [];

/**
 * Every value export of `lib/logger`, replaced.
 *
 * ⚠️ A PARTIAL mock is the trap this repo has recorded: `mock.module` replaces
 * the whole module, so any export left out becomes `undefined` and the module
 * under test throws on first use — which reads as a broken test rather than a
 * missing mock. The factory is SYNCHRONOUS, because an async one deadlocks
 * `bun:test`.
 */
void mock.module("@atlas/api/lib/logger", () => {
  const record = (sink: Captured[]) => (payload: unknown, message?: unknown) =>
    sink.push({
      payload: (payload ?? {}) as Record<string, unknown>,
      message: typeof message === "string" ? message : String(payload),
    });
  const capture = {
    info: record(infos),
    warn: record(warns),
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
    warns.length = 0;
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
  /**
   * The completion line and THE SINK IT LANDED IN.
   *
   * ⚠️ Returning the payload alone is not enough, and the first cut of this file
   * did exactly that: dropping the actionable arm from `warn` back to `info`
   * SURVIVED every assertion here, because a helper that merges the sinks cannot
   * see the level. The level is half of what makes this line discoverable — a
   * deployment filtering `info`, which is the ordinary posture for a path this
   * chatty, loses it entirely — so the sink travels with the line.
   */
  function theLineAt(): { line: Captured; level: "info" | "warn" } {
    const hit = (sink: Captured[]) =>
      sink.filter((entry) => entry.message.includes("Drift re-key complete"));
    const atInfo = hit(infos);
    const atWarn = hit(warns);
    const lines = [...atInfo, ...atWarn];
    expect(
      lines,
      "expected exactly one re-key completion line — the approval runs the statement for ONE " +
        "position, and more than one means these assertions are reading an arbitrary member",
    ).toHaveLength(1);
    return { line: lines[0]!, level: atWarn.length === 1 ? "warn" : "info" };
  }

  /** The payload alone, where the level is not what the case is about. */
  const theLine = (): Captured => theLineAt().line;

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
        "the skip counts are not read anywhere else in the product, so dropping one from this " +
        "line deletes the signal outright while every SQL-level test stays green",
    ).toMatchObject({ rekeyed: 2, skippedDegenerateSurface: 1, skippedVocabularyTarget: 0 });
    // The correlation fields, without which the counts name no decision.
    expect(payload).toMatchObject({ workspaceId: WS, position: "object" });
    expect(payload.proposalId).toBeTruthy();
  });

  it("reports zero declined on a corpus with no degenerate rows", async () => {
    // The control, and the half that makes the number readable: on a healthy
    // corpus both skip counts are 0, so a non-zero reading is the exception an
    // operator can act on rather than background noise. A line that hardcoded
    // the count, or wired it to the same expression as `rekeyed`, passes the
    // case above and fails here.
    await land("widget", "is", "friday");

    await approveObjectAlias("friday", "fri");

    const clean = theLineAt();
    expect(clean.line.payload).toMatchObject({
      rekeyed: 1,
      skippedDegenerateSurface: 0,
      skippedVocabularyTarget: 0,
    });
    // INFO on the happy path. The other direction of the level split: a line
    // that warned on every ordinary approval is alert fatigue, which makes the
    // real warning unreadable — the failure mode the conditional exists to avoid.
    expect(clean.level).toBe("info");
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
    ).toMatchObject({ rekeyed: 0, skippedDegenerateSurface: 2, skippedVocabularyTarget: 0 });
    // …and the message stays the ordinary one: a tombstoned population needs no
    // human, so an alarming line here would be the alert fatigue that makes the
    // real one unreadable.
    const degenerateOnly = theLineAt();
    expect(degenerateOnly.line.message).toContain(
      "existing facts now carry the keys this vocabulary decides",
    );
    expect(degenerateOnly.level).toBe("info");
  });

  it("⭐ says so IN THE MESSAGE when a live row was declined by a vocabulary target", async () => {
    // ⚠️ The line's MESSAGE is the assertion, not just its payload. *"existing
    // facts now carry the keys this vocabulary decides"* is FALSE of exactly
    // these rows — they carry the keys the PREVIOUS vocabulary decided — so
    // emitting it here would be a success sentence about the one population
    // that needs a human, and an operator scanning messages rather than fields
    // would never look.
    //
    // The closure is written DIRECTLY because `vocabulary-decide.ts` refuses a
    // `degenerate-norm` target at authoring; that guard is what keeps this
    // population empty in practice and exactly what makes the seam unable to
    // build the fixture. Neither this line nor the `IS NOT NULL` arm rests on
    // the guard staying put.
    await land("billing", "is", "platform team");
    await pool.query(
      `INSERT INTO brain_vocabulary_edge
         (workspace_id, slot_position, from_norm, to_norm, approved_by)
       VALUES ($1, 'object', 'platform team', ' - ', '5109-test')`,
      [WS],
    );
    await pool.query(
      `INSERT INTO brain_vocabulary_target (workspace_id, slot_position, norm, effective_target)
       VALUES ($1, 'object', 'platform team', ' - ')`,
      [WS],
    );

    // An unrelated real approval, so the re-key runs at the object position.
    await approveObjectAlias("friday", "fri");

    const { line, level } = theLineAt();
    expect(line.payload).toMatchObject({ skippedVocabularyTarget: 1, skippedDegenerateSurface: 0 });
    // ⚠️ WARN, not INFO. The payload being right is worth nothing if the record
    // is filtered out before anyone reads it: this is an operator-actionable
    // data-integrity divergence, emitted at the same severity as the routine
    // success line until #5106's review round caught it.
    expect(
      level,
      "the actionable arm went out at `info` — a deployment filtering info-level logs, which is " +
        "the ordinary posture for a path this chatty, loses the only record that live rows were " +
        "left on keys the previous vocabulary decided",
    ).toBe("warn");
    expect(
      line.message,
      "the line reported a clean completion over a live row whose key the vocabulary now " +
        "disagrees with — the count alone is not the signal if the sentence beside it says the " +
        "opposite",
    ).not.toContain("existing facts now carry the keys this vocabulary decides");
    // It names the remedy: the entry, not another re-key.
    expect(line.message).toContain("brain_vocabulary_target");
  });
});
