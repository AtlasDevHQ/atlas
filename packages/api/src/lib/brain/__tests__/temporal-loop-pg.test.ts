/**
 * The M2 temporal stack, proven end to end (#4917, ADR-0036 §Temporal,
 * conflict & provenance) — the temporal counterpart of `wedge-loop-pg.test.ts`.
 *
 * ## Why this file exists when every temporal verb already has a suite
 *
 * Each M2 stage suite injects the previous stage's output as a literal — a
 * draft row the test INSERTed, a tension edge the test wrote, a validity
 * window the fixture posed. What none of them can observe is the HANDOFF:
 * whether the edge reconcile actually writes is the edge both read surfaces
 * actually cluster, whether the `valid_to` the publish gate actually stamps is
 * the boundary the `asOf` branch actually reads, and whether the tombstone
 * `correct_fact` actually stamps is hidden by every read that promised to hide
 * it. Five PRs (#4912–#4916) each held one end of those seams. The assertions
 * below are claims about the boundaries:
 *
 *   1. **Does the tension edge RECONCILE writes reach both surfaces?** The
 *      advisory `in-tension-with` edge is written by `reconcile.ts` for a
 *      `single`-cardinality rival and read back by `loadTensionClusters`
 *      behind BOTH the review queue and `searchBrain` — three modules, one
 *      edge row, and the failure mode is a conflict that silently reads as
 *      "nothing contradicts this".
 *   2. **Does the gate's stamp close the window the reads open?** The
 *      `SUPERSEDE_STAMP_SQL` write and `supersedes` edge come from the row
 *      version the promote transaction saw; the default read hides the loser
 *      through `brainFactCurrentClause` and the `asOf` branch re-admits it —
 *      the two branches of `buildFactQuery` against a stamp neither wrote.
 *   3. **Does `correct_fact` retract hide history from EVERY read?** The
 *      tombstone is stamped by `RETRACT_FACT_SQL` inside the correction
 *      transaction; `invalidated_at IS NULL` survives in BOTH temporal
 *      branches of the fact read (#4916 — retraction is the one verb whose
 *      job is hiding history), and the `derives-from` dependents are flagged
 *      through a provenance marker that must not touch any gated column.
 *
 * ## What is faked, precisely
 *
 * Exactly what `wedge-loop-pg.test.ts` fakes, for the reasons its header
 * records: Slack's HTTP surface (the REAL `createSlackHistoryClient` runs on
 * top of a fixture `SlackHistoryApi`) and the extraction model (a
 * `MockLanguageModelV3` returning fixed JSON under the real `generateObject`
 * parse). Everything else — ingest, extraction, reconcile with its tension
 * pass, the publish gate with its supersession collision, the audience sync,
 * `correct_fact`, and both read surfaces — is production code against real
 * Postgres.
 *
 * ## Fixture discipline (inherited from #4775)
 *
 *   - Reader contexts come from `resolvePrincipalContext` against the real
 *     `fact_audience_member` table — a hand-built context would make every ACL
 *     assertion a statement about the fixture rather than the code.
 *   - NO `workspace_plugins` install row is seeded, so
 *     `upsertConnectorSyncState` silently no-ops and every sync reads a null
 *     cursor. The premise is PINNED per sync (see `syncHistory`), because the
 *     re-sync `duplicate` counts below rest on it.
 *   - The clock is injected (`CLOCK`): the 7-day backfill floor would exclude
 *     every fixture message against the real clock.
 *   - `GRANT_UNUSABLE` remains the only gate refusal reachable from the
 *     database; this file never exercises gate refusals — `wedge-loop-pg`
 *     owns that arm.
 *
 * ## Three deliberate pins that are easy to misread as bugs
 *
 *   - **The gate-superseding winner has an UNRECORDED start.** The extraction
 *     schema carries no `validFrom`, so a winner promoted at the gate lands
 *     with `valid_from NULL` — and #4916 admits an unrecorded start at ANY
 *     `asOf`. A reader entitled to both sides therefore sees BOTH claims on a
 *     point read before the publish; only the loser's closed window, not the
 *     winner's open one, encodes the arbitration. Pinned below rather than
 *     "fixed" in the fixture.
 *   - **Supersession is grant-blind.** The collision join never reads
 *     `visible_to`, so an audience-granted winner retires an org-granted
 *     loser for readers who will never see the winner: the org reader's
 *     current belief simply ends. The frozen grant still serves them
 *     yesterday's truth under `asOf` — that asymmetry IS the T5 design.
 *   - **The correction episode never reaches the extraction queue.**
 *     `extracted_at` is stamped at INSERT (#4915), so the drain after a
 *     correction inspects nothing — a human's exact words are never re-derived
 *     into a second, machine-produced claim.
 *
 * The `derives-from` fact→fact edge behind the flag-not-cascade arm is
 * INSERTed by hand: ADR-0036 §M5's write-back is the producer that will mint
 * those edges, and `DEPENDENT_FACTS_SQL` (the retraction's reader) is already
 * live against the shape migration 0180 admits. Same posture as the wedge
 * suite's import-shaped INSERT.
 *
 * Opt in locally with:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { Pool } from "pg";
import { MockLanguageModelV3 } from "ai/test";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS, _resetPool } from "@atlas/api/lib/db/internal";
import { syncBrainEpisodeSource } from "@atlas/api/lib/brain/ingest/episode-sync";
import {
  _resetBrainExtractionFailures,
  llmFactExtractor,
  runBrainExtractionCycle,
  type ResolvedExtractionModel,
} from "@atlas/api/lib/brain/extract";
import { promoteBrainFacts } from "@atlas/api/lib/content-mode/adapters/brain-facts";
import { searchBrainCore } from "@atlas/api/lib/brain/search";
import { loadFactCandidates } from "@atlas/api/lib/brain/candidates";
import { correctFact } from "@atlas/api/lib/brain/correction";
import { createSlackHistoryClient, type SlackHistoryApi } from "@atlas/api/lib/brain/ingest/slack/client";
import { getChatBackfillWindowMs } from "@atlas/api/lib/brain/ingest/slack/connector";
import { SLACK_HISTORY_SOURCE } from "@atlas/api/lib/brain/ingest/slack/config";
import { chatChannelAudienceId } from "@atlas/api/lib/brain/ingest/grant";
import {
  runAudienceSyncCycle,
  type AudienceSyncCycleResult,
  type AudienceSyncDeps,
} from "@atlas/api/lib/brain/audience/sync";
import { resolvePrincipals } from "@atlas/api/lib/brain/audience/resolver";
import { reconcileAudienceMembership } from "@atlas/api/lib/brain/audience/membership";
import type { SlackDirectoryUser, SlackHistoryMessage } from "@atlas/api/lib/slack/api";
import {
  AUDIENCE_PREFIX,
  resolvePrincipalContext,
  type BrainPrincipalContext,
} from "@atlas/api/lib/brain/acl";
import type { BrainSourceConnector } from "@atlas/api/lib/brain/ingest/types";
import type { AtlasMode } from "@useatlas/types/auth";
import type { BrainFactResult, BrainSearchResult } from "@useatlas/types";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

const WORKSPACE = "ws-brain-temporal";
const INSTALL_ID = "slack-history-temporal";
const CATALOG_ID = "slack-history-test";

/** The public channel — `isPrivate: false` resolves to `['org']`. */
const PUBLIC_CHANNEL = "C0PUBLIC";
/** The private channel — resolves to a single `audience:` token. */
const EXEC_CHANNEL = "C0EXEC";

/** Built through the real id helper, so the grant grammar cannot drift out from under the assertions. */
const EXEC_AUDIENCE = chatChannelAudienceId(SLACK_HISTORY_SOURCE, EXEC_CHANNEL);
const EXEC_GRANT_TOKEN = `${AUDIENCE_PREFIX}${EXEC_AUDIENCE}`;

/**
 * The injected clock — load-bearing, not decoration: the backfill window is 7
 * days, so against the real clock every fixture message would fall outside the
 * floor and the loop would ingest nothing (see `wedge-loop-pg.test.ts`).
 */
const CLOCK = () => new Date("2026-06-27T00:00:00.000Z");

/**
 * When the correction runs, on the same pinned timeline. Only the correction
 * EPISODE's instants come from this; `invalidated_at` and `valid_to` are
 * stamped by SQL `now()`, which is the production shape and is why the `asOf`
 * instants below sit safely before the real test-run time.
 */
const CORRECTION_CLOCK = () => new Date("2026-06-27T12:00:00.000Z");

/**
 * The point-read instant: after both beliefs were ingested and the loser
 * published, before the publish that superseded it (`valid_to` is stamped at
 * real run time, far later than this). Past-relative-to-now, as
 * `parseBrainAsOf` requires.
 */
const AS_OF = "2026-06-26T12:00:00Z";
const AS_OF_ECHO = "2026-06-26T12:00:00.000Z";

/** Message bodies, named so `EXTRACTIONS` cannot silently drift from the history. */
const BODY = {
  /** The incumbent belief — public channel, org grant. */
  thursdays: "the deploy window is Thursdays",
  /** The claim that will derive from the deploy window — the dependent's source. */
  freeze: "the release freeze is the day before the deploy window",
  /** Small talk in the exec channel; extraction yields nothing. */
  lunch: "lunch?",
  /** The conflicting rival — exec channel, audience grant, arrives a day later. */
  fridays: "the deploy window is Fridays",
} as const;

function message(overrides: Partial<SlackHistoryMessage> & { ts: string; text: string }): SlackHistoryMessage {
  return { user: "U_ADA", subtype: null, botId: null, ...overrides };
}

/**
 * Synthetic Slack history. `ts` values are round instants so a near-miss in
 * the Slack-ts conversion fails loudly on a provenance assertion.
 */
const CHANNEL_HISTORY: Readonly<Record<string, readonly SlackHistoryMessage[]>> = {
  // 2026-06-25T10:00:00Z and 10:05:00Z
  [PUBLIC_CHANNEL]: [
    message({ ts: "1782381600.000100", text: BODY.thursdays, user: "U_ADA" }),
    message({ ts: "1782381900.000200", text: BODY.freeze, user: "U_ADA" }),
  ],
  // 2026-06-25T11:00:00Z
  [EXEC_CHANNEL]: [message({ ts: "1782385200.000300", text: BODY.lunch, user: "U_ALAN" })],
};

/** The rival claim, said in the EXEC channel a day later. 2026-06-26T11:00:00Z. */
const FRIDAYS_MESSAGE = message({ ts: "1782471600.000400", text: BODY.fridays, user: "U_ALAN" });

const PUBLIC_CHANNELS = new Set([PUBLIC_CHANNEL]);

/**
 * Slack's roster per channel. Only the PRIVATE channel's roster is ever read —
 * the audience sync skips public channels — and `U_ADMIN` is what makes the
 * workspace admin a member of the exec audience THROUGH production code
 * (roster → directory email → Atlas user), not by fixture assertion. The org
 * member (`user-member`) is deliberately in no roster: they are the reader the
 * withheld-counterpart and frozen-grant arms below are about.
 */
const CHANNEL_ROSTER: Readonly<Record<string, readonly string[]>> = {
  [PUBLIC_CHANNEL]: ["U_ADA"],
  [EXEC_CHANNEL]: ["U_ADMIN", "U_ALAN"],
};

/** Slack's directory. `U_ALAN`'s address matches no Atlas user — logged, never guessed. */
const SLACK_DIRECTORY: readonly SlackDirectoryUser[] = [
  { id: "U_ADMIN", email: "admin@temporal.test", deleted: false, isBot: false },
  { id: "U_ADA", email: "ada@temporal.test", deleted: false, isBot: false },
  { id: "U_ALAN", email: "nobody@temporal.test", deleted: false, isBot: false },
];

type Candidate = {
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly cardinality: "single" | "multi";
};

/**
 * What the mock model "extracts" from each body. `Partial` + a `BODY`-derived
 * key type: editing a body then fails to COMPILE here rather than silently
 * turning an extraction into the empty arm. Both deploy-window claims are
 * `single` — that cardinality, on both sides, is what arms the tension pass
 * and the gate's supersession collision.
 */
const EXTRACTIONS: Partial<Record<(typeof BODY)[keyof typeof BODY], readonly Candidate[]>> = {
  [BODY.thursdays]: [
    { subject: "deploy window", predicate: "is", object: "Thursdays", cardinality: "single" },
  ],
  [BODY.fridays]: [
    { subject: "deploy window", predicate: "is", object: "Fridays", cardinality: "single" },
  ],
  [BODY.freeze]: [
    {
      subject: "release freeze",
      predicate: "is",
      object: "the day before the deploy window",
      cardinality: "multi",
    },
  ],
};

type FactRow = {
  readonly id: string;
  readonly subject: string;
  readonly object: string;
  readonly status: string;
  readonly predicate_cardinality: string;
  readonly visible_to: string[];
  readonly valid_from: Date | null;
  readonly valid_to: Date | null;
  readonly invalidated_at: Date | null;
  readonly provenance: Record<string, unknown>;
};

describeIfPg("brain M2 temporal loop (real Postgres)", () => {
  let pool: Pool;
  let priorDatabaseUrl: string | undefined;
  const schemaName = `brain_4917_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  /** Bodies the model was asked about — the "was the seam even exercised" pin. */
  let modelCalls: string[] = [];
  /** Extra messages appended to a channel between sync passes (the rival's arrival). */
  let extraMessages: Readonly<Record<string, readonly SlackHistoryMessage[]>> = {};

  const mockModel = new MockLanguageModelV3({
    doGenerate: async (options) => {
      const prompt = JSON.stringify(options.prompt);
      const body = (Object.keys(EXTRACTIONS) as (keyof typeof EXTRACTIONS)[]).find(
        (candidate) => prompt.includes(candidate),
      );
      modelCalls.push(body ?? "(no match)");
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ facts: body ? EXTRACTIONS[body] : [] }) },
        ],
        finishReason: { unified: "stop" as const, raw: "end_turn" },
        usage: {
          inputTokens: { total: 50, noCache: 50, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 30, text: 30, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });

  const EXTRACTION_MODEL = {
    model: mockModel,
    modelId: "mock-extractor",
  } satisfies ResolvedExtractionModel;

  beforeAll(async () => {
    // `hasInternalDB()` reads `DATABASE_URL`, not the pool — without this the
    // extraction cycle takes its "no database" path. Set inside the hook per
    // the test-discipline rule; restored in `afterAll`.
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
    // Better-Auth-owned tables, stubbed for `wedge-loop-pg.test.ts`'s reasons:
    // `organization` feeds the tier-cap lookup (missing TABLE fails closed and
    // aborts the sync; missing ROW is the self-hosted "no tier cap" arm), and
    // `"user"` + `member` feed the audience sync's email resolution.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS organization (
        id TEXT PRIMARY KEY,
        name TEXT,
        slug TEXT,
        workspace_status TEXT,
        plan_tier TEXT,
        byot BOOLEAN,
        "stripeCustomerId" TEXT,
        trial_ends_at TIMESTAMPTZ,
        suspended_at TIMESTAMPTZ,
        suspension_source TEXT,
        plan_override_until TIMESTAMPTZ,
        deleted_at TIMESTAMPTZ,
        region TEXT,
        region_assigned_at TIMESTAMPTZ,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "user" (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS member (
        id TEXT PRIMARY KEY,
        "organizationId" TEXT NOT NULL,
        "userId" TEXT NOT NULL,
        role TEXT
      )
    `);
    await pool.query(
      `INSERT INTO "user" (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
      ["user-admin", "admin@temporal.test"],
    );
    await pool.query(
      `INSERT INTO member (id, "organizationId", "userId", role)
       VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
      ["m-admin", WORKSPACE, "user-admin", "admin"],
    );
    // The ingest/extraction/correction stages write through the module-level
    // pool, so it has to BE this schema-scoped one.
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
    // One atomic statement + a `finally` reset, for `wedge-loop-pg.test.ts`'s
    // reason: a part-way failure must not cascade into the next test.
    try {
      await pool.query(
        `TRUNCATE brain_edges, brain_facts, brain_episodes, fact_audience_member, knowledge_sync_state, admin_action_log`,
      );
    } finally {
      _resetBrainExtractionFailures();
      modelCalls = [];
      extraMessages = {};
    }
  });

  // ── stage drivers (the wedge suite's, minus what this loop never uses) ──

  const slackApi: SlackHistoryApi = {
    getConversationInfo: (_token, channelId) =>
      Promise.resolve({
        ok: true as const,
        channel: {
          id: channelId,
          name: channelId.toLowerCase(),
          isPrivate: !PUBLIC_CHANNELS.has(channelId),
          isMember: true,
          isArchived: false,
        },
      }),
    fetchConversationHistoryPage: (_token, params) => {
      const known = CHANNEL_HISTORY[params.channel];
      if (known === undefined) {
        return Promise.resolve({ ok: false as const, error: "channel_not_found" as const, retryAfterSeconds: null });
      }
      const all = [...known, ...(extraMessages[params.channel] ?? [])];
      const oldest = params.oldest === undefined ? null : Number(params.oldest);
      if (oldest !== null && Number.isNaN(oldest)) {
        throw new Error(`fixture: non-numeric oldest bound ${params.oldest} — the Slack-ts format changed`);
      }
      const messages = oldest === null ? all : all.filter((m) => Number(m.ts) > oldest);
      return Promise.resolve({ ok: true as const, messages, nextCursor: null, dropped: 0 });
    },
  };

  const connector: BrainSourceConnector = {
    catalogId: CATALOG_ID,
    source: SLACK_HISTORY_SOURCE,
    createClient: () =>
      createSlackHistoryClient({
        token: "xoxb-test",
        channels: [PUBLIC_CHANNEL, EXEC_CHANNEL],
        backfillWindowMs: getChatBackfillWindowMs(),
        api: slackApi,
        now: CLOCK,
      }),
  };

  /** `syncBrainEpisodeSource` never throws — the outcome is asserted here once. */
  async function syncHistory() {
    const outcome = await syncBrainEpisodeSource({
      connector,
      workspaceId: WORKSPACE,
      installId: INSTALL_ID,
      config: null,
      now: CLOCK,
    });
    expect(outcome).toMatchObject({
      status: "success",
      error: null,
      coverageIncomplete: false,
      warnings: [],
    });
    // The cursor-less premise the `duplicate` counts below rest on — see the
    // header's fixture-discipline bullet and the wedge suite's fuller note.
    const { rows: premise } = await pool.query<{ installs: string; state: string }>(
      `SELECT (SELECT count(*)::text FROM workspace_plugins WHERE workspace_id = $1 AND install_id = $2) AS installs,
              (SELECT count(*)::text FROM knowledge_sync_state WHERE workspace_id = $1) AS state`,
      [WORKSPACE, INSTALL_ID],
    );
    expect(premise[0]).toEqual({ installs: "0", state: "0" });
    return outcome;
  }

  /** The extraction fiber, driving the real `llmFactExtractor`. */
  async function extract() {
    const cycle = await Effect.runPromise(
      runBrainExtractionCycle({
        extract: llmFactExtractor,
        resolveModel: async (workspaceId) => {
          expect(workspaceId).toBe(WORKSPACE);
          return EXTRACTION_MODEL;
        },
      }),
    );
    expect(cycle).toMatchObject({
      status: "success",
      failed: 0,
      blockedEpisodes: 0,
      factsBlocked: 0,
      outageRefunded: 0,
    });
    expect(cycle.skipped).toEqual({ model_unavailable: 0, no_body: 0, quarantined: 0 });
    return cycle;
  }

  /** The review gate, in a transaction, as `/admin/publish` runs it. */
  async function publish() {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const report = await Effect.runPromise(promoteBrainFacts(client, WORKSPACE));
      await client.query("COMMIT");
      client.release();
      return report;
    } catch (err) {
      await client.query("ROLLBACK").catch((rollbackErr: unknown) => {
        console.debug(
          "publish(): ROLLBACK failed after a promote error",
          rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
        );
      });
      // Destroyed, not recycled — a client with an open transaction holds the
      // `FOR UPDATE` locks and would block `afterEach`'s TRUNCATE.
      client.release(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  /** The fused read. `asOf` present ⇒ the bi-temporal point read (#4916). */
  function search(
    ctx: BrainPrincipalContext,
    options: { mode?: AtlasMode; query?: string; asOf?: string } = {},
  ) {
    return searchBrainCore(pool, {
      ctx,
      mode: options.mode ?? "published",
      query: options.query,
      include: ["fact", "raw-episode"],
      expand: false,
      limit: 25,
      ...(options.asOf !== undefined ? { asOf: options.asOf } : {}),
    });
  }

  /** Reader contexts, resolved the way production resolves them. */
  function readerFor(userId: string, role: "admin" | "member"): Promise<BrainPrincipalContext> {
    return resolvePrincipalContext(pool, {
      workspaceId: WORKSPACE,
      mode: "managed",
      userId,
      resolvedRole: { role, orgId: WORKSPACE },
    });
  }

  /** The reviewer/corrector — a member of the exec audience via the roster sync. */
  const admin = () => readerFor("user-admin", "admin");
  /** An org member in no audience — the withheld-arm and frozen-grant reader. */
  const member = () => readerFor("user-member", "member");

  /** The real audience-membership sync (#4801), on the wedge suite's seams. */
  async function syncAudiences(): Promise<AudienceSyncCycleResult> {
    const result = await runAudienceSyncCycle({
      api: {
        getConversationInfo: slackApi.getConversationInfo,
        fetchConversationMembersPage: (_token, params) => {
          const roster = CHANNEL_ROSTER[params.channel];
          if (roster === undefined) {
            return Promise.resolve({
              ok: false as const,
              error: "channel_not_found" as const,
              retryAfterSeconds: null,
            });
          }
          return Promise.resolve({ ok: true as const, memberIds: roster, nextCursor: null });
        },
        fetchUsersListPage: () =>
          Promise.resolve({
            ok: true as const,
            users: SLACK_DIRECTORY,
            nextCursor: null,
            dropped: 0,
          }),
      },
      query: (<T extends Record<string, unknown>>() =>
        Promise.resolve([
          { workspace_id: WORKSPACE, install_id: INSTALL_ID, config: { channels: [PUBLIC_CHANNEL, EXEC_CHANNEL] } },
        ] as unknown as T[])) as AudienceSyncDeps["query"],
      resolveToken: () => Promise.resolve("xoxb-test"),
      resolve: (workspaceId, principals) =>
        resolvePrincipals(workspaceId, principals, { query: poolQuery }),
      reconcile: (input) =>
        reconcileAudienceMembership(input, { withTransaction: poolTransaction }),
    });
    expect(result.status).toBe("success");
    return result;
  }

  const poolQuery = async <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]> => {
    const { rows } = await pool.query(sql, params);
    return rows as T[];
  };

  const poolTransaction = async <T>(
    fn: (tx: { query: (sql: string, params?: unknown[]) => Promise<{ rows: readonly unknown[] }> }) => Promise<T>,
  ): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn({
        query: async (sql, params) => {
          const res = await client.query(sql, params);
          return { rows: res.rows as readonly unknown[] };
        },
      });
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK").catch((rbErr: unknown) => {
        console.debug("fixture rollback failed", rbErr);
      });
      throw err;
    } finally {
      client.release();
    }
  };

  // ── row helpers ─────────────────────────────────────────────────────────

  async function facts(): Promise<readonly FactRow[]> {
    const { rows } = await pool.query<FactRow>(
      `SELECT id, subject, object, status, predicate_cardinality, visible_to,
              valid_from, valid_to, invalidated_at, provenance
         FROM brain_facts ORDER BY subject, object`,
    );
    return rows;
  }

  /** Named throws, not `!` — a failure must name the row a stage failed to write. */
  function factByClaim(rows: readonly FactRow[], subject: string, object: string): FactRow {
    const row = rows.find((f) => f.subject === subject && f.object === object);
    if (!row) {
      throw new Error(
        `no brain_facts row asserting "${subject} … ${object}"; saw [${rows
          .map((f) => `${f.subject} … ${f.object}`)
          .join(", ")}]`,
      );
    }
    return row;
  }

  async function edgeCount(
    edgeType: string,
    fromFactId: string,
    to: { factId?: string; episodeId?: string },
  ): Promise<number> {
    const toClause = to.factId !== undefined ? `to_fact_id = $4::uuid` : `to_episode_id = $4::uuid`;
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM brain_edges
        WHERE workspace_id = $1 AND edge_type = $2 AND from_fact_id = $3::uuid AND ${toClause}`,
      [WORKSPACE, edgeType, fromFactId, to.factId ?? to.episodeId],
    );
    return Number(rows[0]?.n ?? "0");
  }

  const isFact = (r: BrainSearchResult): r is BrainFactResult => r.tier === "fact";

  const byText = (a: string, b: string) => a.localeCompare(b);
  const subjectsOf = (results: readonly BrainSearchResult[]) =>
    results.filter(isFact).map((f) => f.subject).toSorted(byText);
  /** The deploy-window objects a read served — the loop's central projection. */
  const deployObjectsOf = (results: readonly BrainSearchResult[]) =>
    results
      .filter(isFact)
      .filter((f) => f.subject === "deploy window")
      .map((f) => f.object)
      .toSorted(byText);

  // ── the loop ────────────────────────────────────────────────────────────

  it(
    "walks conflict → advisory tension → gate supersession → asOf → correct_fact retract, end to end",
    async () => {
      // ---- 1. the incumbent belief, published -----------------------------
      const sync = await syncHistory();
      expect(sync.episodes).toMatchObject({ inserted: 3, duplicate: 0 });
      const cycle = await extract();
      expect(cycle).toMatchObject({ inspected: 3, extracted: 3, factsCreated: 2 });
      expect(modelCalls.toSorted(byText)).toEqual(
        [BODY.thursdays, BODY.freeze, "(no match)"].toSorted(byText),
      );
      const firstPublish = await publish();
      expect(firstPublish.promoted).toBe(2);
      expect(firstPublish.refused).toEqual([]);
      // Nothing published before it — the supersession machinery must be inert
      // on a conflict-free publish, or every later assertion about it is noise.
      expect(firstPublish.superseded).toEqual([]);

      const synced = await syncAudiences();
      expect(synced.membersAdded).toBe(1);

      let rows = await facts();
      const thursdays = factByClaim(rows, "deploy window", "Thursdays");
      const freeze = factByClaim(rows, "release freeze", "the day before the deploy window");
      expect(thursdays).toMatchObject({
        status: "published",
        predicate_cardinality: "single",
        visible_to: ["org"],
        valid_to: null,
        invalidated_at: null,
      });

      // ---- 2. the rival arrives — draft + advisory tension edge -----------
      extraMessages = { [EXEC_CHANNEL]: [FRIDAYS_MESSAGE] };
      const second = await syncHistory();
      expect(second.episodes).toMatchObject({ inserted: 1, duplicate: 3 });
      const rivalCycle = await extract();
      expect(rivalCycle).toMatchObject({ inspected: 1, extracted: 1, factsCreated: 1, factsCorroborated: 0 });

      rows = await facts();
      const fridays = factByClaim(rows, "deploy window", "Fridays");
      // The rival is a DRAFT with the exec channel's derived grant — reconcile
      // recorded the conflict, it arbitrated nothing.
      expect(fridays).toMatchObject({
        status: "draft",
        predicate_cardinality: "single",
        visible_to: [EXEC_GRANT_TOKEN],
        valid_to: null,
        invalidated_at: null,
      });
      expect(factByClaim(rows, "deploy window", "Thursdays").status).toBe("published");
      // The edge reconcile wrote: newer claim → incumbent, exactly once.
      expect(await edgeCount("in-tension-with", fridays.id, { factId: thursdays.id })).toBe(1);

      // ---- 3. surfaced-both-with-provenance, on BOTH read surfaces --------
      // The org member sees the incumbent, and the rival they may not read is
      // REPORTED rather than dropped — the withheld arm (negative: a reader
      // who cannot see one side).
      const memberCtx = await member();
      const memberView = await search(memberCtx);
      expect(subjectsOf(memberView.results)).toEqual(["deploy window", "release freeze"]);
      const memberIncumbent = memberView.results.filter(isFact).find((f) => f.subject === "deploy window");
      expect(memberIncumbent).toMatchObject({ object: "Thursdays", status: "published" });
      expect(memberIncumbent?.tensions).toEqual([{ visible: false, withheldCount: 1 }]);

      // The exec-audience admin sees the SAME cluster with the rival's full
      // claim and provenance — surfaced-both, never ranked.
      const adminCtx = await admin();
      const adminView = await search(adminCtx);
      // The draft rival is not itself served in published mode; it reaches the
      // reader only as the incumbent's counterpart.
      expect(deployObjectsOf(adminView.results)).toEqual(["Thursdays"]);
      const adminIncumbent = adminView.results.filter(isFact).find((f) => f.subject === "deploy window");
      expect(adminIncumbent?.tensions).toHaveLength(1);
      expect(adminIncumbent?.tensions[0]).toMatchObject({
        visible: true,
        factId: fridays.id,
        // The edge points newer → incumbent, so from the incumbent's side the
        // counterpart sits on the `from` end.
        edgeDirection: "from",
        object: "Fridays",
        status: "draft",
        invalidatedAt: null,
        provenance: {
          source: SLACK_HISTORY_SOURCE,
          attribution: { visible: true, actor: "slack:U_ALAN" },
        },
      });

      // The REVIEWER's queue holds the rival with the incumbent as its
      // counterpart — same edge, other surface, per-rival projection.
      const queue = await loadFactCandidates(pool, { ctx: adminCtx, limit: 50, offset: 0 });
      expect(queue.total).toBe(1);
      expect(queue.candidates[0]).toMatchObject({
        id: fridays.id,
        object: "Fridays",
        provenance: { source: SLACK_HISTORY_SOURCE, attribution: { visible: true, actor: "slack:U_ALAN" } },
      });
      expect(queue.candidates[0]?.tensions).toEqual([
        expect.objectContaining({
          visible: true,
          factId: thursdays.id,
          edgeDirection: "to",
          object: "Thursdays",
          status: "published",
          invalidatedAt: null,
        }),
      ]);

      // ---- 4. the reviewer publishes — supersession at the gate -----------
      const gate = await publish();
      expect(gate.promoted).toBe(1);
      expect(gate.refused).toEqual([]);
      expect(gate.superseded).toEqual([{ rowId: fridays.id, superseded: [thursdays.id] }]);

      rows = await facts();
      const loser = factByClaim(rows, "deploy window", "Thursdays");
      const winner = factByClaim(rows, "deploy window", "Fridays");
      // The stamp closed the loser's window and ONLY its window: still
      // published (the review verdict stands), still not retracted.
      expect(loser.valid_to).not.toBeNull();
      expect(loser).toMatchObject({ status: "published", invalidated_at: null });
      // The winner is current, with an UNRECORDED start — the extraction
      // schema carries no validFrom, so only the loser's closed window encodes
      // the arbitration (see the header pin).
      expect(winner).toMatchObject({ status: "published", valid_to: null, valid_from: null });
      // The arbitration record, new → old.
      expect(await edgeCount("supersedes", winner.id, { factId: loser.id })).toBe(1);

      // ---- 5. default reads: the survivor only ----------------------------
      const adminNow = await search(adminCtx);
      expect(deployObjectsOf(adminNow.results)).toEqual(["Fridays"]);
      expect("asOf" in adminNow).toBe(false);
      // Supersession is grant-blind (header pin): the org member's belief
      // simply ENDS — the loser is no longer current and the winner's frozen
      // audience grant withholds it.
      const memberNow = await search(memberCtx);
      expect(subjectsOf(memberNow.results)).toEqual(["release freeze"]);

      // ---- 6. asOf: yesterday's truth under the frozen grant --------------
      // The org member's point read serves the superseded claim again — gated
      // by the row's own frozen `['org']` grant, with its provenance intact —
      // and the winner stays withheld by ITS frozen grant.
      const memberThen = await search(memberCtx, { asOf: AS_OF });
      expect(memberThen.asOf).toBe(AS_OF_ECHO);
      expect(deployObjectsOf(memberThen.results)).toEqual(["Thursdays"]);
      const memberThenFact = memberThen.results.filter(isFact).find((f) => f.subject === "deploy window");
      expect(memberThenFact?.validTo).not.toBeNull();
      expect(memberThenFact?.provenance).toMatchObject({
        source: SLACK_HISTORY_SOURCE,
        attribution: { visible: true, actor: "slack:U_ADA" },
      });
      // A reader entitled to BOTH sides sees both at the instant: the winner's
      // unrecorded start is admitted at any `asOf` by design (#4916 — the
      // point read must not diverge from the default read on NULL
      // `valid_from`). Pinned, not worked around.
      const adminThen = await search(adminCtx, { asOf: AS_OF });
      expect(deployObjectsOf(adminThen.results)).toEqual(["Fridays", "Thursdays"]);

      // ---- 7. correct_fact retract: tombstone + flag, never cascade -------
      // The write-back-shaped lineage edge (header note): the freeze claim
      // derives from the deploy-window belief being retracted.
      await pool.query(
        `INSERT INTO brain_edges (workspace_id, edge_type, from_fact_id, to_fact_id)
         VALUES ($1, 'derives-from', $2::uuid, $3::uuid)`,
        [WORKSPACE, freeze.id, winner.id],
      );

      const correction = await correctFact(
        { ctx: adminCtx, factId: winner.id, verb: "retract", reason: "wrong side of the rename" },
        { now: CORRECTION_CLOCK },
      );
      if (correction.kind !== "corrected") {
        throw new Error(`retract did not apply: ${JSON.stringify(correction)}`);
      }
      expect(correction.result).toMatchObject({
        verb: "retract",
        factId: winner.id,
        supersededBy: null,
        validTo: null,
        flaggedForReReview: [freeze.id],
      });
      expect(correction.result.invalidatedAt).not.toBeNull();

      // The immutable human record: a `human` episode carrying the target's
      // own grant, pre-stamped off the extraction queue (#4915).
      const { rows: correctionEpisodes } = await pool.query<{
        source: string;
        source_actor: string | null;
        visible_to: string[];
        extracted_at: Date | null;
      }>(
        `SELECT source, source_actor, visible_to, extracted_at FROM brain_episodes WHERE id = $1::uuid`,
        [correction.result.correctionEpisodeId],
      );
      expect(correctionEpisodes[0]).toMatchObject({
        source: "human",
        source_actor: "user-admin",
        visible_to: [EXEC_GRANT_TOKEN],
      });
      expect(correctionEpisodes[0]?.extracted_at).not.toBeNull();
      // Lineage, fact → correction episode: `derives-from`, not evidence.
      expect(
        await edgeCount("derives-from", winner.id, {
          episodeId: correction.result.correctionEpisodeId,
        }),
      ).toBe(1);
      // …and the drain confirms the pre-stamp: nothing queued, nothing
      // re-derived from the human's words.
      const afterCorrection = await extract();
      expect(afterCorrection).toMatchObject({ inspected: 0, extracted: 0, factsCreated: 0 });

      // The dependent was FLAGGED, not cascaded: marker in provenance, every
      // gated column untouched, still served.
      rows = await facts();
      const flagged = factByClaim(rows, "release freeze", "the day before the deploy window");
      expect(flagged).toMatchObject({ status: "published", valid_to: null, invalidated_at: null });
      expect(flagged.provenance.reReview).toMatchObject({
        reason: "derives-from-retracted",
        retractedFactId: winner.id,
        correctionEpisodeId: correction.result.correctionEpisodeId,
      });

      // ---- 8. the tombstone is hidden from EVERY read ---------------------
      // Default read: the retracted survivor is gone; the flagged dependent is
      // not (flag ≠ cascade, through the reader's eyes).
      const adminAfter = await search(adminCtx);
      expect(deployObjectsOf(adminAfter.results)).toEqual([]);
      expect(subjectsOf(adminAfter.results)).toEqual(["release freeze"]);
      // The point read hides it too — retraction is the one verb whose job is
      // hiding history (#4916) — while the SUPERSEDED claim's history
      // survives: retracting the winner does not resurrect or destroy the
      // loser's window.
      const adminThenAfter = await search(adminCtx, { asOf: AS_OF });
      expect(deployObjectsOf(adminThenAfter.results)).toEqual(["Thursdays"]);
      const memberThenAfter = await search(memberCtx, { asOf: AS_OF });
      expect(deployObjectsOf(memberThenAfter.results)).toEqual(["Thursdays"]);
    },
    PG_TEST_TIMEOUT_MS,
  );
});
