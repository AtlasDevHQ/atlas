/**
 * The M1 thin wedge, proven end to end (#4775, ADR-0036).
 *
 * ## Why this file exists when every stage already has a suite
 *
 * Each stage suite injects the PREVIOUS stage's output as a literal — a
 * `BrainEpisodeRecord` the test wrote, a `FactCandidate` the test wrote, a
 * draft row the test INSERTed. That is the right shape for pinning a stage's
 * decisions, and it means the thing none of them can observe is the
 * **handoff**: whether the value stage N actually emits is the value stage N+1
 * actually reads. Five PRs each held one end of four seams.
 *
 * So the assertions below are deliberately NOT a re-run of the stage suites.
 * Each is a claim about a boundary:
 *
 *   1. **Does the grant the Slack client derives survive to the stored fact?**
 *      `client.ts` classifies the channel's `isPrivate` and calls
 *      `deriveChatChannelGrant`; the episode stores the result; reconcile
 *      INHERITS it onto the fact. Three modules, one array — and the failure
 *      mode is silent over-sharing. `acl.ts` enforces whatever array it is
 *      handed and has no way to notice a grant that was DERIVED correctly and
 *      INHERITED wrongly, so faithful propagation is a property only an
 *      end-to-end test can hold.
 *   2. **Does the drain read back the episode the INGEST WRITER wrote?**
 *      `extract-reconcile-pg.test.ts` already pins `occurredAt` through the
 *      drain, but from an episode a hand `INSERT … $6::timestamptz` created.
 *      Here the row came from `episodes.ts`'s `(rec->>'occurredAt')::timestamptz`,
 *      so the whole Slack-ts → Date → jsonb → timestamptz → Date round trip is
 *      on the path before provenance stamps it.
 *   3. **Does the review gate classify the row RECONCILE wrote?** The
 *      classifier's `DraftFactRow` is hand-built in `promotion.test.ts`. Here
 *      it reads whatever the reconciler actually committed — the only way to
 *      catch a column the writer stopped populating.
 *   4. **Does `searchBrain` label the fact the gate promoted?** Trust tier,
 *      status, provenance and corroboration all come off a row that walked the
 *      whole loop rather than one an INSERT posed as its output.
 *
 * ## What is faked, precisely
 *
 * Two things, and the boundary matters:
 *
 *   - **Slack's HTTP surface** — a fixture `SlackHistoryApi` (`conversations.info`
 *     + `conversations.history`). The REAL `createSlackHistoryClient` runs on
 *     top of it, so channel classification, `deriveChatChannelGrant`'s only
 *     production call site, source-id minting, and the bot/subtype/empty-text
 *     screens are all on this test's path. NOT on the path:
 *     `createSlackHistoryConnector` itself — `parseSlackHistoryConfig` and
 *     `resolveSlackHistoryToken`, which `slack-connector.test.ts` owns — because
 *     it builds its client without the `api` injection point. The connector
 *     shim below is therefore the test's; the client under it is production.
 *   - **The extraction model** — a `MockLanguageModelV3` returning fixed JSON.
 *     `llmFactExtractor` itself runs, so the real prompt-build and
 *     `generateObject` schema-conformance parse are exercised. Injecting a
 *     `FactExtractor` instead, as `extract-reconcile-pg.test.ts` does, would
 *     skip exactly the step that turns a model's answer into a candidate.
 *
 * Reader identity is NOT faked: contexts come from `resolvePrincipalContext`
 * against the real `fact_audience_member` table, so the membership → token
 * expansion is on the path too. A hand-built `BrainPrincipalContext` would make
 * every ACL assertion below a statement about the fixture rather than the code.
 *
 * ## Two seams deliberately NOT on this path
 *
 *   - **Sync-state persistence.** `upsertConnectorSyncState` only writes when a
 *     matching `workspace_plugins` install row exists, and this test seeds none
 *     — so no `knowledge_sync_state` row is ever written, every pass reads a
 *     null cursor, and the high-water-mark round trip is inert here. That is
 *     load-bearing for how the re-sync assertions below read: `duplicate: 4`
 *     proves the ingest core's source-id dedupe (`ON CONFLICT DO NOTHING`), NOT
 *     the client's mark discipline, which `slack-client.test.ts` owns. The
 *     idempotence test PINS the absence with an assertion rather than trusting
 *     this paragraph, because seeding an install row later would silently
 *     change what `duplicate: 4` means.
 *   - **Grant-derivation FAILURE.** `client.ts` throws when
 *     `deriveChatChannelGrant` returns null, which degrades that channel and
 *     sets `coverageIncomplete`. `syncHistory()` hard-asserts
 *     `coverageIncomplete: false`, so the arm is unreachable from this file by
 *     construction; `episodes-pg.test.ts` covers the screen and
 *     `slack-client.test.ts` the per-channel isolation.
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
import { createSlackHistoryClient, type SlackHistoryApi } from "@atlas/api/lib/brain/ingest/slack/client";
import { getChatBackfillWindowMs } from "@atlas/api/lib/brain/ingest/slack/connector";
import { SLACK_HISTORY_SOURCE, slackEpisodeSourceId } from "@atlas/api/lib/brain/ingest/slack/config";
import { chatChannelAudienceId } from "@atlas/api/lib/brain/ingest/grant";
import {
  runAudienceSyncCycle,
  type AudienceSyncCycleResult,
  type AudienceSyncDeps,
} from "@atlas/api/lib/brain/audience/sync";
import { resolvePrincipals } from "@atlas/api/lib/brain/audience/resolver";
import { reconcileAudienceMembership } from "@atlas/api/lib/brain/audience/membership";
import type { SlackDirectoryUser } from "@atlas/api/lib/slack/api";
import {
  AUDIENCE_PREFIX,
  resolvePrincipalContext,
  type BrainPrincipalContext,
} from "@atlas/api/lib/brain/acl";
import type { BrainSourceConnector } from "@atlas/api/lib/brain/ingest/types";
import type { SlackHistoryMessage } from "@atlas/api/lib/slack/api";
import type { AtlasMode } from "@useatlas/types/auth";
import type {
  BrainEpisodeResult,
  BrainFactResult,
  BrainSearchResult,
} from "@useatlas/types";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

const WORKSPACE = "ws-brain-wedge";
const INSTALL_ID = "slack-history-wedge";
const CATALOG_ID = "slack-history-test";

/** The public channel — the client's `isPrivate: false` arm resolves to `['org']`. */
const PUBLIC_CHANNEL = "C0PUBLIC";
/** The private channel — resolves to a single `audience:` token. */
const EXEC_CHANNEL = "C0EXEC";

/** Built through the real id helper, so the grant grammar cannot drift out from under the assertions. */
const EXEC_AUDIENCE = chatChannelAudienceId(SLACK_HISTORY_SOURCE, EXEC_CHANNEL);
const EXEC_GRANT_TOKEN = `${AUDIENCE_PREFIX}${EXEC_AUDIENCE}`;

/**
 * The clock both the sync engine and the Slack client read.
 *
 * Load-bearing, not decoration: the backfill window is 7 days, so against the
 * REAL clock every fixture message below would fall outside the floor and the
 * loop would ingest nothing. That failure is loud — every test here carries a
 * positive count assertion — but it would read as a broken pipeline rather
 * than a stale fixture, so the clock is pinned instead.
 */
const CLOCK = () => new Date("2026-06-27T00:00:00.000Z");

/** Message bodies, named so `EXTRACTIONS` cannot silently drift from `HISTORY`. */
const BODY = {
  deploy: "the deploy window is Thursdays",
  smallTalk: "morning all",
  acquisition: "the acquisition target is Northwind",
  lunch: "lunch?",
  /** Restates `deploy` in a later message — the corroboration fixture. */
  deployAgain: "the deploy window is Thursdays",
} as const;

function message(overrides: Partial<SlackHistoryMessage> & { ts: string; text: string }): SlackHistoryMessage {
  return { user: "U_ADA", subtype: null, botId: null, ...overrides };
}

/**
 * Synthetic Slack history, per channel.
 *
 * `ts` values are chosen so the derived instants are exact round numbers — a
 * near-miss in the Slack-ts → epoch-ms conversion then fails loudly on the
 * provenance assertion rather than drifting by microseconds unnoticed.
 */
const CHANNEL_HISTORY: Readonly<Record<string, readonly SlackHistoryMessage[]>> = {
  // 2026-06-25T10:00:00Z and 10:05:00Z
  [PUBLIC_CHANNEL]: [
    message({ ts: "1782381600.000100", text: BODY.deploy, user: "U_ADA" }),
    message({ ts: "1782381900.000200", text: BODY.smallTalk, user: "U_GRACE" }),
  ],
  // 2026-06-25T11:00:00Z and 11:05:00Z
  [EXEC_CHANNEL]: [
    message({ ts: "1782385200.000300", text: BODY.acquisition, user: "U_ALAN" }),
    message({ ts: "1782385500.000400", text: BODY.lunch, user: "U_ALAN" }),
  ],
};

const PUBLIC_CHANNELS = new Set([PUBLIC_CHANNEL]);

/**
 * Slack's roster per channel (#4801). `U_ALAN` is the exec channel's one
 * resolvable human and is what makes `user-exec` the reader who can see the
 * audience-granted fact — resolved through production code, not asserted.
 *
 * MUTABLE, because the revocation test drops a member between two cycles;
 * `resetRosters()` restores it in `afterEach`.
 *
 * The exec channel's other two members are deliberate: `U_BOT` exercises the
 * bot screen, and `U_GRACE` carries an address matching no Atlas user — the
 * "logged, never guessed" arm. Both must be in the EXEC channel to be
 * exercised at all: the sync skips public channels before it ever reads their
 * roster, so a principal parked in `PUBLIC_CHANNEL` is inert.
 */
const DEFAULT_ROSTER: Readonly<Record<string, readonly string[]>> = {
  [PUBLIC_CHANNEL]: ["U_ADA"],
  [EXEC_CHANNEL]: ["U_ALAN", "U_BOT", "U_GRACE"],
};
let CHANNEL_ROSTER: Record<string, readonly string[]> = { ...DEFAULT_ROSTER };
function resetRosters(): void {
  CHANNEL_ROSTER = { ...DEFAULT_ROSTER };
}

/** Slack's directory. `U_GRACE`'s address matches no Atlas user, by design. */
const SLACK_DIRECTORY: readonly SlackDirectoryUser[] = [
  { id: "U_ALAN", email: "exec@wedge.test", deleted: false, isBot: false },
  { id: "U_ADA", email: "plain@wedge.test", deleted: false, isBot: false },
  { id: "U_GRACE", email: "nobody@wedge.test", deleted: false, isBot: false },
  { id: "U_BOT", email: null, deleted: false, isBot: true },
];

/** The deploy-window claim, restated a day later. 2026-06-26T10:00:00Z. */
const CORROBORATING = message({ ts: "1782468000.000000", text: BODY.deployAgain, user: "U_GRACE" });

type Candidate = {
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly cardinality: "single" | "multi";
};

/**
 * What the mock model "extracts" from each body. Small talk yields nothing.
 *
 * `Partial` + a `BODY`-derived key type: editing a body then fails to COMPILE
 * here rather than silently turning every extraction into the empty arm.
 */
const EXTRACTIONS: Partial<Record<(typeof BODY)[keyof typeof BODY], readonly Candidate[]>> = {
  [BODY.deploy]: [
    { subject: "deploy window", predicate: "is", object: "Thursdays", cardinality: "single" },
  ],
  [BODY.acquisition]: [
    { subject: "acquisition target", predicate: "is", object: "Northwind", cardinality: "single" },
  ],
};

type FactRow = {
  readonly id: string;
  readonly subject: string;
  readonly object: string;
  readonly status: string;
  readonly visible_to: string[];
  // The AT-REST shape (`BrainFactProvenance` in `lib/brain/types.ts`), not the
  // wire projection — this row comes straight off the jsonb column. They were
  // never the same type, and since #4836 they are visibly different: the wire
  // view nests the attribution triple behind a discriminated variant, which
  // the stored payload never carries.
  readonly provenance: Record<string, unknown>;
};

type EpisodeRow = {
  readonly id: string;
  readonly visible_to: string[];
  readonly occurred_at: Date;
  readonly extracted_at: Date | null;
};

describeIfPg("brain M1 wedge loop (real Postgres)", () => {
  let pool: Pool;
  let priorDatabaseUrl: string | undefined;
  const schemaName = `brain_4775_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  /** Bodies the model was asked about — the "was the seam even exercised" pin. */
  let modelCalls: string[] = [];
  /** Extra messages a single test appends to a channel (the corroboration case). */
  let extraMessages: Readonly<Record<string, readonly SlackHistoryMessage[]>> = {};

  const mockModel = new MockLanguageModelV3({
    doGenerate: async (options) => {
      // Keyed off the prompt because one drain feeds the model four DIFFERENT
      // episodes and the assertions distinguish their outcomes.
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

  // No `as unknown as` cast: `MockLanguageModelV3 implements LanguageModelV3`,
  // which is an arm of `LanguageModel`. Keeping the assignment CHECKED is the
  // point — this file drives the real `generateObject`, so an `ai` major that
  // reshapes the call/usage contract must fail at compile time here rather than
  // inside a provider parse at runtime.
  const EXTRACTION_MODEL = {
    model: mockModel,
    modelId: "mock-extractor",
  } satisfies ResolvedExtractionModel;

  beforeAll(async () => {
    // `runPeriodicDbCycle` guards on `hasInternalDB()`, which reads
    // `DATABASE_URL` rather than the pool — without this the extraction cycle
    // takes its "no database" path and returns a zeroed SUCCESS, so nothing in
    // the loop runs. Set inside the hook (never at module top level, per the
    // test-discipline rule) and restored in `afterAll`.
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
    // `organization` is Better-Auth's own table — Better Auth's schema push
    // never runs here, and `MANAGED_AUTH_MIGRATIONS` skips the migrations that
    // would otherwise depend on it — while the ingest engine's tier-cap check
    // (`resolveIngestCaps`) reads it on every sync. A MISSING TABLE faults that lookup, which fails CLOSED and
    // aborts the sync; a missing ROW is the "no plan → no tier cap" arm. The
    // stub gives us the second, which is what a self-hosted workspace is.
    // Columns mirror `getWorkspaceDetails`'s SELECT list — a narrower stub would
    // fault the same lookup for a different reason.
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
    // `"user"` + `member` are Better Auth's, skipped for the same reason
    // `organization` is, and stubbed for a new one: #4801's audience sync
    // resolves a Slack roster to Atlas users by joining these two
    // (`RESOLVE_PRINCIPAL_EMAILS_SQL`). Columns mirror that query's SELECT and
    // JOIN — a narrower stub would fault it rather than resolve nobody, which
    // is a different (and louder) test failure than the one that matters.
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
    // `sso_providers` IS core schema and the migrations create it, so it needs
    // no stub — and it stays EMPTY here deliberately. An empty table means no
    // verified domain, which means no narrowing, which is the self-hosted
    // default path. The narrowing arm is covered in `audience-sync-pg.test.ts`.
    await pool.query(
      `INSERT INTO "user" (id, email) VALUES ($1, $2), ($3, $4)
       ON CONFLICT (id) DO NOTHING`,
      ["user-exec", "exec@wedge.test", "user-plain", "plain@wedge.test"],
    );
    await pool.query(
      `INSERT INTO member (id, "organizationId", "userId", role)
       VALUES ($1, $2, $3, $4), ($5, $2, $6, $4)
       ON CONFLICT (id) DO NOTHING`,
      ["m-exec", WORKSPACE, "user-exec", "member", "m-plain", "user-plain"],
    );
    // The ingest and extraction stages write through the module-level pool, so
    // it has to BE this schema-scoped one. (Stages 3 and 4 take an explicit
    // handle — see `publish()` and `search()`.)
    _resetPool(pool);
  }, PG_TEST_TIMEOUT_MS);

  afterAll(async () => {
    _resetPool(null);
    if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDatabaseUrl;
    if (pool) {
      // `DROP SCHEMA … CASCADE` over a fully-migrated schema is slow under a
      // loaded runner, and a lingering lock can make it throw outright. The
      // `finally` covers the THROW: `pool.end()` still runs, so a failed drop
      // leaks only the schema and not the pool's open handles, which would keep
      // the bun process alive. Same discipline the bootstrap pool gets above.
      // A genuine hook TIMEOUT is still uncovered — an await that never settles
      // never reaches the `finally`, and both leak.
      // Narrowed at the catch site, like `poolTransaction`'s `destroyReason`,
      // so the rethrow below has a `.message` without re-narrowing.
      let dropErr: Error | undefined;
      try {
        await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      } catch (err) {
        dropErr = err instanceof Error ? err : new Error(String(err));
      } finally {
        await pool.end();
      }
      if (dropErr !== undefined) {
        // Thrown, not logged. `scripts/test-isolated.ts` prints a file's
        // captured output ONLY on a non-zero exit, so a `console.debug` here
        // would be discarded in precisely the case it exists to report: a green
        // run that leaked a schema. `schemaName` carries a timestamp and a
        // random suffix, so an unreported leak is an unattributable orphan in a
        // shared test database — failing the file is the only channel that
        // survives.
        throw new Error(
          `afterAll(): DROP SCHEMA "${schemaName}" failed — scratch schema leaked, drop it by hand: ${dropErr.message}`,
        );
      }
    }
  }, PG_TEST_TIMEOUT_MS);

  afterEach(async () => {
    // ONE atomic statement rather than six sequential DELETEs: a failure
    // part-way through the latter leaves the next test inheriting rows AND
    // skips `_resetBrainExtractionFailures`, turning one real failure into a
    // cascade of unrelated ones.
    try {
      await pool.query(
        `TRUNCATE brain_edges, brain_facts, brain_episodes, fact_audience_member, knowledge_sync_state, admin_action_log`,
      );
    } finally {
      // In a `finally` for the same reason the TRUNCATE is one statement: if the
      // reset is skipped by a rejecting await, the next test inherits the
      // quarantine ledger and the fixture overrides, and one real failure
      // becomes a cascade of unrelated ones.
      _resetBrainExtractionFailures();
      modelCalls = [];
      extraMessages = {};
      resetRosters();
    }
  });

  // ── stage drivers ───────────────────────────────────────────────────────

  /** Slack's HTTP surface. The real client runs on top of this. */
  const slackApi: SlackHistoryApi = {
    getConversationInfo: (_token, channelId) =>
      Promise.resolve({
        ok: true as const,
        channel: {
          id: channelId,
          name: channelId.toLowerCase(),
          // The bit seam 1 turns on: the client reads THIS and derives the grant.
          isPrivate: !PUBLIC_CHANNELS.has(channelId),
          isMember: true,
          isArchived: false,
        },
      }),
    fetchConversationHistoryPage: (_token, params) => {
      const known = CHANNEL_HISTORY[params.channel];
      if (known === undefined) {
        // As strict as Slack. `?? []` here would make an unknown channel
        // byte-identical to an empty one — the "read nothing, report green"
        // case the real client raises `channel_not_found` for.
        return Promise.resolve({ ok: false as const, error: "channel_not_found" as const, retryAfterSeconds: null });
      }
      const all = [...known, ...(extraMessages[params.channel] ?? [])];
      // `oldest` is honoured so the fixture is a faithful stand-in for Slack.
      // Note what it does NOT buy here: with no `workspace_plugins` install row
      // the cursor is never persisted (see the header), so `oldest` is always
      // the backfill floor and this filter never actually narrows a page.
      const oldest = params.oldest === undefined ? null : Number(params.oldest);
      if (oldest !== null && Number.isNaN(oldest)) {
        // `x > NaN` is false for every x, so a non-numeric bound would filter
        // the page to empty SILENTLY. The real client treats a non-numeric ts
        // as a hard defect; so does this.
        throw new Error(`fixture: non-numeric oldest bound ${params.oldest} — the Slack-ts format changed`);
      }
      const messages = oldest === null ? all : all.filter((m) => Number(m.ts) > oldest);
      return Promise.resolve({ ok: true as const, messages, nextCursor: null, dropped: 0 });
    },
  };

  /**
   * Stage 1 — the real Slack client, behind a test-owned connector shim.
   *
   * The shim exists only because `createSlackHistoryConnector` builds its
   * client without the `api` injection point (see the module header).
   */
  const connector: BrainSourceConnector<typeof SLACK_HISTORY_SOURCE> = {
    catalogId: CATALOG_ID,
    source: SLACK_HISTORY_SOURCE,
    // Channel-scoped grants: `audience/sync.ts` reconciles them off the install,
    // so this source registers no re-verifier.
    audience: { kind: "externally-synced" },
    createClient: () =>
      createSlackHistoryClient({
        token: "xoxb-test",
        channels: [PUBLIC_CHANNEL, EXEC_CHANNEL],
        // Read from the production knob rather than hardcoded, so a default
        // shortened below the fixture's age fails HERE instead of silently
        // breaking real ingestion while this suite stays green.
        backfillWindowMs: getChatBackfillWindowMs(),
        api: slackApi,
        now: CLOCK,
      }),
  };

  /**
   * `syncBrainEpisodeSource` NEVER throws — every failure becomes a
   * `status: "error"` outcome with `episodes: null`. So an unchecked call is a
   * swallowed error, and the assertion belongs HERE rather than being repeated
   * (or forgotten) at every call site below.
   */
  async function syncHistory() {
    const outcome = await syncBrainEpisodeSource({
      connector,
      workspaceId: WORKSPACE,
      installId: INSTALL_ID,
      config: null,
      now: CLOCK,
    });
    // `warnings` included deliberately: `client.ts` pairs every warning with
    // `coverageIncomplete = true` EXCEPT the "read N messages, stored none"
    // one, which is precisely its own silent-drop signal. Without this, a
    // message that starts tripping the bot/subtype/empty-text screens would
    // surface four stages later as an FTS miss.
    expect(outcome).toMatchObject({
      status: "success",
      error: null,
      coverageIncomplete: false,
      warnings: [],
    });

    // The cursor-less premise, checked on EVERY sync rather than once in the
    // last test — the corroboration test's `inserted: 1, duplicate: 4` rests on
    // it just as hard, and is declared first. Both halves are asserted because
    // they fail differently: no install row is the CAUSE (the upsert's `WHERE
    // EXISTS` guard skips), and an empty `knowledge_sync_state` is the SYMPTOM
    // — which `upsertConnectorSyncState` would also produce by logging and
    // swallowing a genuine write error.
    const { rows: premise } = await pool.query<{ installs: string; state: string }>(
      `SELECT (SELECT count(*)::text FROM workspace_plugins WHERE workspace_id = $1 AND install_id = $2) AS installs,
              (SELECT count(*)::text FROM knowledge_sync_state WHERE workspace_id = $1) AS state`,
      [WORKSPACE, INSTALL_ID],
    );
    expect(premise[0]).toEqual({ installs: "0", state: "0" });
    return outcome;
  }

  /**
   * Stage 2 — the extraction fiber, driving the REAL `llmFactExtractor`.
   *
   * Same reasoning as `syncHistory`: the cycle's error channel is `never`. A
   * scan fault resolves as `status: "failure"`; a per-episode rejection or a
   * quarantine skip resolve as `status: "success"` with only a counter moved.
   * Hence both checks — the status one catches the first, the `failed` /
   * `skipped` ones the second. `skipped.quarantined` in particular is silent by
   * design, so nothing else in the file would notice it.
   */
  async function extract() {
    // Scoped to the CYCLE, not the suite: two tests drive `extract()` twice, and
    // a suite-lifetime recorder would let the second call's assertion pass on
    // the first call's entry — silently vacuous for the zero-drain replay at the
    // bottom of this file, and spuriously red for any future test whose FIRST
    // cycle drains nothing.
    const resolveModelCalls: string[] = [];
    const cycle = await Effect.runPromise(
      runBrainExtractionCycle({
        extract: llmFactExtractor,
        // RECORDED here, ASSERTED below — never `expect`-ed inside the
        // callback. The per-episode apply runs under `Effect.tryPromise`
        // (`scheduler/periodic-db-job.ts`), which converts any throw into a
        // counted `failed` outcome — so an `expect` here is diverted into a
        // scrubbed, truncated `log.warn` line and never reaches the test's
        // failure diff. It would surface as a counter mismatch (`failed`, plus
        // `outageRefunded` once every episode fails), naming the assertion
        // nowhere a reader is looking.
        resolveModel: async (workspaceId) => {
          resolveModelCalls.push(workspaceId);
          return EXTRACTION_MODEL;
        },
      }),
    );
    expect(cycle).toMatchObject({
      status: "success",
      failed: 0,
      blockedEpisodes: 0,
      // The per-CANDIDATE analogue of `blockedEpisodes`, and just as silent —
      // a nonzero value still reports `status: "success"`.
      factsBlocked: 0,
      outageRefunded: 0,
    });
    expect(cycle.skipped).toEqual({ model_unavailable: 0, no_body: 0, quarantined: 0 });
    // Two claims in one array. WHICH workspace: the cycle must resolve for the
    // EPISODE's workspace — the BYO-mis-billing class `resolveExtractionModel`
    // exists to prevent. HOW MANY times: exactly one, because `extract.ts`'s
    // `modelFor` memoizes per workspace per cycle ("not once per episode: a
    // decrypt is not free"), so this also pins that cache against a regression
    // to per-episode resolution. Keyed off `inspected` because a cycle that
    // drained nothing must resolve nothing — asserting `[WORKSPACE]` there
    // would blame model resolution for what is really an empty backlog.
    expect(resolveModelCalls).toEqual(cycle.inspected > 0 ? [WORKSPACE] : []);
    return cycle;
  }

  /** Stage 3 — the review gate, in a transaction, as `/admin/publish` runs it. */
  async function publish() {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const report = await Effect.runPromise(promoteBrainFacts(client, WORKSPACE));
      await client.query("COMMIT");
      client.release();
      return report;
    } catch (err) {
      // A failing ROLLBACK must not REPLACE the error that caused it — the
      // `PublishPhaseError` carries the phase and the pg cause, and a
      // connection-level rejection here would erase both.
      await client.query("ROLLBACK").catch((rollbackErr: unknown) => {
        console.debug(
          "publish(): ROLLBACK failed after a promote error",
          rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
        );
      });
      // Destroyed, not recycled: a client returned to the pool with a
      // transaction still open holds the `FOR UPDATE` locks `DRAFT_FACTS_SQL`
      // took, and `afterEach`'s TRUNCATE would then block until it times out —
      // reporting a hook timeout instead of the promote error.
      client.release(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  /** Stage 4 — the fused read. */
  function search(
    ctx: BrainPrincipalContext,
    options: { mode?: AtlasMode; query?: string } = {},
  ) {
    return searchBrainCore(pool, {
      ctx,
      mode: options.mode ?? "published",
      query: options.query,
      include: ["fact", "raw-episode"],
      expand: false,
      limit: 25,
    });
  }

  /**
   * Reader contexts, resolved the way production resolves them.
   *
   * Audience membership is READ FROM `fact_audience_member` here, which is what
   * makes the membership rows in these tests load-bearing rather than
   * decoration — a hand-built context with a literal `audienceIds` would make
   * every ACL assertion a statement about the fixture.
   */
  function readerFor(userId: string, role: "admin" | "member"): Promise<BrainPrincipalContext> {
    return resolvePrincipalContext(pool, {
      workspaceId: WORKSPACE,
      mode: "managed",
      userId,
      resolvedRole: { role, orgId: WORKSPACE },
    });
  }

  const admin = () => readerFor("user-admin", "admin");
  const member = () => readerFor("user-member", "member");
  /** A second member, this one a member of the exec channel's audience. */
  const execMember = () => readerFor("user-exec", "member");

  /**
   * Stage 2b — the real audience-membership sync (#4801).
   *
   * Slack's roster + directory come from the same fixture discipline as the
   * history reads; everything above them is production code, including the
   * email→Atlas-user resolution and the reconcile that writes
   * `fact_audience_member`. The DB seams are injected only to reach this
   * suite's schema-scoped pool — `withMembershipTransaction` and
   * `internalQuery` both resolve `getInternalDB()`, which honours
   * `DATABASE_URL` but not the scratch `search_path`.
   *
   * `runAudienceSyncCycle` never throws, so the status is asserted here rather
   * than at each call site — same reasoning as `syncHistory`.
   */
  async function syncAudiences(): Promise<AudienceSyncCycleResult> {
    const result = await runAudienceSyncCycle({
      api: {
        getConversationInfo: slackApi.getConversationInfo,
        fetchConversationMembersPage: (_token, params) => {
          const roster = CHANNEL_ROSTER[params.channel];
          if (roster === undefined) {
            // As strict as Slack, and for a sharper reason than the history
            // fixture's: an unknown channel returning an empty roster would
            // REVOKE the whole audience and still report success.
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
      // One install row, supplied directly: this suite deliberately persists no
      // `workspace_plugins` row (see the header), and the scan is not what is
      // under test here.
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

  /** `internalQuery`-shaped adapter over the suite's schema-scoped pool. */
  const poolQuery = async <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]> => {
    const { rows } = await pool.query(sql, params);
    return rows as T[];
  };

  /** Single-connection transaction on the suite's pool, for the reconcile. */
  const poolTransaction = async <T>(
    fn: (tx: { query: (sql: string, params?: unknown[]) => Promise<{ rows: readonly unknown[] }> }) => Promise<T>,
  ): Promise<T> => {
    const client = await pool.connect();
    // `undefined` ⇒ safe to recycle; set ⇒ destroy on release. One binding
    // rather than a boolean plus a discarded error, so the reason the client is
    // being destroyed is the ROLLBACK failure that actually poisoned it — not
    // the original error, which is merely why we rolled back.
    let destroyReason: Error | undefined;
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
      // Surfaced, not swallowed, and NARROWED: a failed rollback would
      // otherwise present as the ORIGINAL error over a silently poisoned
      // connection, and a raw `unknown` names neither the operation nor the
      // failure (pg may reject with a plain object on a destroyed socket).
      await client.query("ROLLBACK").catch((rbErr: unknown) => {
        destroyReason = rbErr instanceof Error ? rbErr : new Error(String(rbErr));
        console.debug("poolTransaction(): ROLLBACK failed after a fixture transaction error", destroyReason.message);
      });
      throw err;
    } finally {
      // In a `finally` so EVERY path releases exactly once — including a throw
      // from inside the catch block itself. A client that never returns to the
      // pool makes `afterEach`'s TRUNCATE block until the hook times out,
      // reporting a hook timeout instead of the reconcile error that actually
      // happened: the same hazard `publish()` documents, and the exact
      // diagnostic erasure this helper exists to avoid.
      //
      // Unlike `publish()`, which destroys unconditionally, a rollback that
      // SUCCEEDED here leaves no in-doubt transaction, so the client is safe to
      // recycle and only a failed rollback forces the destroy.
      client.release(destroyReason);
    }
  };

  // ── row helpers ─────────────────────────────────────────────────────────

  async function facts(): Promise<readonly FactRow[]> {
    const { rows } = await pool.query<FactRow>(
      `SELECT id, subject, object, status, visible_to, provenance FROM brain_facts ORDER BY subject`,
    );
    return rows;
  }

  /**
   * Named throws rather than `!`: this file's whole premise is locating WHICH
   * handoff failed, and `Cannot read properties of undefined` names neither the
   * stage nor the row it expected.
   */
  async function episodeBySourceId(sourceId: string): Promise<EpisodeRow> {
    const { rows } = await pool.query<EpisodeRow>(
      `SELECT id, visible_to, occurred_at, extracted_at FROM brain_episodes WHERE source_id = $1`,
      [sourceId],
    );
    const row = rows[0];
    if (!row) throw new Error(`no brain_episodes row for source_id=${sourceId} — the ingest stage did not write it`);
    return row;
  }

  function factBySubject(rows: readonly FactRow[], subject: string): FactRow {
    const row = rows.find((f) => f.subject === subject);
    if (!row) {
      throw new Error(
        `no brain_facts row with subject=${subject}; saw [${rows.map((f) => f.subject).join(", ")}]`,
      );
    }
    return row;
  }

  const publicSourceId = (index: number) =>
    slackEpisodeSourceId(PUBLIC_CHANNEL, CHANNEL_HISTORY[PUBLIC_CHANNEL]![index]!.ts);
  const execSourceId = (index: number) =>
    slackEpisodeSourceId(EXEC_CHANNEL, CHANNEL_HISTORY[EXEC_CHANNEL]![index]!.ts);

  // Parameter typed as the union, not `{ tier: string }`: that is what keeps
  // the compiler checking the literal against the discriminant, so a tier
  // rename in `@useatlas/types` is a TS2367 rather than a filter that silently
  // returns `[]` and satisfies every `not.toContain` in the file.
  const isFact = (r: BrainSearchResult): r is BrainFactResult => r.tier === "fact";
  const isEpisode = (r: BrainSearchResult): r is BrainEpisodeResult => r.tier === "raw-episode";

  // Explicit comparator, not a bare `toSorted()`: `require-array-sort-compare`
  // refuses the argument-less form because it sorts by UTF-16 code unit, which
  // is a different order than a reader of these assertions assumes.
  const byText = (a: string, b: string) => a.localeCompare(b);

  const subjectsOf = (results: readonly BrainSearchResult[]) =>
    results.filter(isFact).map((f) => f.subject).toSorted(byText);
  const bodiesOf = (results: readonly BrainSearchResult[]) =>
    results
      .filter(isEpisode)
      // `body` is nullable — a by-reference episode (locator, no body) carries
      // none. This loop never creates one, so a null here is a real regression
      // and is surfaced as a value rather than sorted into an ambiguous slot.
      .map((e) => e.body ?? "(null body)")
      .toSorted(byText);

  // ── the loop ────────────────────────────────────────────────────────────

  it(
    "walks Slack history → episode → draft fact → review → published → trust-labeled searchBrain",
    async () => {
      // ---- 1. ingest ------------------------------------------------------
      const sync = await syncHistory();
      // Asserted BY VALUE, not `toMatchObject`: `refused` and `batchDuplicate`
      // are the ingest core's entire silent-drop-prevention mechanism, and a
      // subset match discards exactly them.
      expect(sync.episodes).toEqual({
        inserted: 4,
        duplicate: 0,
        batchDuplicate: 0,
        refused: { blank_source_id: 0, blank_body: 0, unusable_grant: 0, invalid_occurred_at: 0 },
      });

      // SEAM 1, first half: the client classified each channel and derived its
      // grant. `['org']` for the public channel, one `audience:` token for the
      // private one — both produced by `deriveChatChannelGrant`'s real call
      // site, not by this test.
      const publicEpisode = await episodeBySourceId(publicSourceId(0));
      const execEpisode = await episodeBySourceId(execSourceId(0));
      expect(publicEpisode.visible_to).toEqual(["org"]);
      expect(execEpisode.visible_to).toEqual([EXEC_GRANT_TOKEN]);
      // The Slack ts survived to a stored instant.
      expect(publicEpisode.occurred_at.toISOString()).toBe("2026-06-25T10:00:00.000Z");
      // Queued, not stamped — `DRAIN_EPISODES_SQL`'s `extracted_at IS NULL` is
      // what makes the backlog visible, and an ingest that stamped would empty
      // it silently.
      expect(publicEpisode.extracted_at).toBeNull();

      // ---- 2. extraction --------------------------------------------------
      const cycle = await extract();
      expect(cycle).toMatchObject({ inspected: 4, extracted: 4, factsCreated: 2 });
      // The real extractor ran once per episode, INCLUDING the small talk —
      // "no candidates" is a model answer, not a pre-filter this stage applies.
      // Asserted by CONTENT, not length: a prompt-build change that stopped
      // embedding the body verbatim would make all four `(no match)` and still
      // be length 4, and the sentinel exists precisely to be observable.
      expect(modelCalls.toSorted(byText)).toEqual(
        [BODY.acquisition, BODY.deploy, "(no match)", "(no match)"].toSorted(byText),
      );

      const drafts = await facts();
      expect(drafts).toHaveLength(2);
      expect(drafts.map((f) => f.status)).toEqual(["draft", "draft"]);

      const acquisition = factBySubject(drafts, "acquisition target");
      const deploy = factBySubject(drafts, "deploy window");

      // SEAM 1, second half: the derived grant is now on the FACT, inherited
      // through the episode by reconcile. Silent over-sharing would show up
      // here as `['org']`.
      expect(acquisition.visible_to).toEqual([EXEC_GRANT_TOKEN]);
      expect(deploy.visible_to).toEqual(["org"]);

      // SEAM 2: the drain read back the episode the INGEST WRITER wrote, and
      // provenance carries the event time Slack reported — not the ingest time,
      // and not a near-miss of it.
      expect(deploy.provenance).toMatchObject({
        source: SLACK_HISTORY_SOURCE,
        episodeId: publicEpisode.id,
        actor: "slack:U_ADA",
        occurredAt: "2026-06-25T10:00:00.000Z",
        producer: "extraction:v1",
      });
      // The extractor's `detail` is SPREAD into provenance rather than nested
      // under a `detail` key. Asserting the flattened shape is what pins that:
      // if the writer ever nested it, only this form catches the regression.
      expect(deploy.provenance).toMatchObject({
        extractor: "extraction:v1",
        model: "mock-extractor",
      });

      // ---- 3. review gate -------------------------------------------------
      // SEAM 3: the classifier reads what RECONCILE committed, not a row the
      // test posed as its output.
      const report = await publish();
      expect(report.promoted).toBe(2);
      // `toEqual([])`, not `?? []`: `refused` being ABSENT means "this adapter
      // cannot refuse at all", which is a different claim from "refused
      // nothing", and only this form fails on the former.
      expect(report.refused).toEqual([]);

      const published = await facts();
      expect(published.map((f) => f.status)).toEqual(["published", "published"]);

      // ---- 4. the trust-labeled read --------------------------------------
      // SEAM 4: an admin in no audience sees the org fact and NOT the exec one.
      const adminView = await search(await admin());
      const adminFacts = adminView.results.filter(isFact);
      expect(adminFacts).toHaveLength(1);
      expect(adminFacts[0]).toMatchObject({
        tier: "fact",
        trustTier: 2,
        subject: "deploy window",
        object: "Thursdays",
        status: "published",
        // One episode behind the claim so far; the corroboration test below
        // drives this to 2 through a second observation.
        corroborationCount: 1,
      });
      // The evidence pointer survives projection — a trust label with no
      // provenance behind it is the failure this tier exists to prevent.
      expect(adminFacts[0]?.provenance).toMatchObject({
        source: SLACK_HISTORY_SOURCE,
        episodeId: publicEpisode.id,
      });

      // Episodes are tier 3, and the org reader sees only the public channel's
      // — the exec channel is gated at tier 3 too, not just at tier 2.
      const adminEpisodes = adminView.results.filter(isEpisode);
      expect(adminEpisodes).toHaveLength(2);
      expect(adminEpisodes.every((e) => e.trustTier === 3)).toBe(true);
      // `complete`, not `pending`: they WERE extracted, the small talk just
      // yielded nothing. (`pending` has its own test below.)
      expect(adminEpisodes.every((e) => e.extraction === "complete")).toBe(true);
      expect(adminEpisodes.map((e) => e.sourceId).toSorted(byText)).toEqual(
        [publicSourceId(0), publicSourceId(1)].toSorted(byText),
      );
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "corroborates a re-observed claim through the loop instead of duplicating it",
    async () => {
      // The third limb of the DoD's "provenance/grant/corroboration", and the
      // one no other loop-level assertion reaches: a SECOND Slack message
      // restating a claim must strengthen the existing fact rather than queue a
      // near-identical draft for a reviewer to arbitrate.
      await syncHistory();
      await extract();
      await publish();

      // A day later, someone says it again in the same channel.
      extraMessages = { [PUBLIC_CHANNEL]: [CORROBORATING] };
      const second = await syncHistory();
      expect(second.episodes).toEqual({
        inserted: 1,
        duplicate: 4,
        batchDuplicate: 0,
        refused: { blank_source_id: 0, blank_body: 0, unusable_grant: 0, invalid_occurred_at: 0 },
      });

      const cycle = await extract();
      expect(cycle).toMatchObject({ inspected: 1, extracted: 1, factsCreated: 0, factsCorroborated: 1 });

      // No new fact, and no new DRAFT in particular — a re-observation that
      // minted one would refill the review queue with work already done.
      const rows = await facts();
      expect(rows).toHaveLength(2);
      expect(factBySubject(rows, "deploy window").status).toBe("published");

      // The evidence pointer is what actually carries corroboration: TWO
      // provenance edges behind the one deploy-window claim. Scoped to that
      // fact — an unscoped count would also be satisfied by the acquisition
      // fact's own edge and so would not say what it appears to.
      const deployFact = factBySubject(rows, "deploy window");
      const { rows: edges } = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM brain_edges WHERE edge_type = 'provenance' AND from_fact_id = $1`,
        [deployFact.id],
      );
      expect(edges[0]?.n).toBe("2");

      // The TEMPORAL half of the same event, and the one arm of M2's
      // supersession axis that only a real corroboration can produce (#4938).
      // Re-observing a claim is evidence, never arbitration: it must add a
      // provenance edge and touch NO validity column. The counter-argument is
      // strong — `reconcile.ts` contains no `UPDATE` at all, `reconcile.test.ts`
      // pins that structurally, and `check-brain-fact-promotion.sh` refuses
      // `UPDATE … valid_to` repo-wide — but all three are statements about the
      // SOURCE. None of them observes the row after a corroboration actually
      // ran, and `temporal-loop-pg` deliberately asserts `factsCorroborated: 0`
      // on every arm that extracts anything, so the flagship e2e never reaches
      // this state at all.
      // A corroborated fact that came back with a PAST-dated `valid_to` would
      // read to every default query as no longer believed — the claim silently
      // disappearing at the moment it was reinforced. The precision matters:
      // liveness is `valid_to IS NULL OR valid_to > now()`, so a FUTURE-dated
      // stamp is still a live fact (#4942). What this asserts is the stronger
      // claim that re-observation NEVER stamps the column at all — so it holds
      // whichever direction a stamp would have gone.
      const { rows: validity } = await pool.query<{
        valid_to: Date | null;
        invalidated_at: Date | null;
      }>(`SELECT valid_to, invalidated_at FROM brain_facts WHERE id = $1`, [deployFact.id]);
      expect(validity[0]).toEqual({ valid_to: null, invalidated_at: null });

      // …and it reaches the reader as a count. Together with the main loop's
      // `corroborationCount: 1`, this is the only place the provenance edge is
      // pinned through the READER: without them `INSERT_PROVENANCE_EDGE_SQL`
      // could silently understate the evidence behind a claim, which on a
      // trust-labeled surface is the harm `search.ts` logs about.
      const view = await search(await admin());
      const deploy = view.results.filter(isFact).find((f) => f.subject === "deploy window");
      expect(deploy?.corroborationCount).toBe(2);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it("serves the promoted fact to a lexical query, not just to a browse", async () => {
    // Every other read here omits `query`, which takes `buildFactQuery`'s
    // recency-browse branch — a real production mode, but not the interesting
    // one. Without this the loop proves listing and not RETRIEVAL: whether a
    // fact born of the real reconcile writer is findable through migration
    // 0181's generated `fts` column is otherwise untested end to end.
    await syncHistory();
    await extract();
    await publish();

    const hit = await search(await admin(), { query: "deploy window" });
    const factHits = hit.results.filter(isFact);
    expect(factHits).toHaveLength(1);
    expect(factHits[0]).toMatchObject({ subject: "deploy window", status: "published" });
    // `ts_headline` ran — a null snippet here means the query took the browse
    // branch after all.
    expect(factHits[0]?.snippet).toBeTruthy();

    // Non-vacuity: the same reader on a term nothing matches gets nothing, so
    // the hit above is the query working rather than the store ignoring it.
    const miss = await search(await admin(), { query: "kubernetes" });
    expect(miss.results.filter(isFact)).toHaveLength(0);
    // The store was queried and narrowed to nothing — distinct from the store
    // having been skipped, which an empty projection alone cannot tell apart.
    expect(miss.stores.fact).toMatchObject({ queried: true, matched: 0 });
  }, PG_TEST_TIMEOUT_MS);

  // ── the negative cases ──────────────────────────────────────────────────

  it("hides a DRAFT fact from a published-mode read, for an admin and a member alike", async () => {
    await syncHistory();
    await extract();
    // Deliberately NOT published — the review gate on the read side.
    expect((await facts()).every((f) => f.status === "draft")).toBe(true);
    expect(await facts()).toHaveLength(2);

    // The AC names a NON-admin, and the published-mode clause is
    // role-independent, so assert both readers rather than implying the
    // guarantee comes from the role. (What actually varies by caller is
    // `mode`, resolved upstream in the tool wrapper — not on this path.)
    expect((await search(await admin())).results.filter(isFact)).toHaveLength(0);
    expect((await search(await member())).results.filter(isFact)).toHaveLength(0);

    // Non-vacuity: the fixture IS reachable, just not in published mode.
    const overlay = await search(await admin(), { mode: "developer" });
    const overlayFacts = overlay.results.filter(isFact);
    expect(overlayFacts).toHaveLength(1);
    // Revealed, and labeled honestly rather than presented as reviewed.
    expect(overlayFacts[0]?.status).toBe("draft");
    // Only the org-granted one: the developer overlay widens STATUS, never the
    // ACL. A mode that also widened the grant would be the worse bug.
    expect(overlayFacts[0]?.subject).toBe("deploy window");
  }, PG_TEST_TIMEOUT_MS);

  it("keeps an audience-granted fact invisible to a member outside the audience", async () => {
    await syncHistory();
    await extract();
    await publish();

    // The member is in no audience, so `resolvePrincipalContext` mints
    // `org` + `role:member` + `user:user-member` — none of which the exec
    // fact's grant names.
    const memberView = await search(await member());
    expect(subjectsOf(memberView.results)).toEqual(["deploy window"]);

    // …and the evidence is gated identically: a reader who cannot see the claim
    // must not read it back off the episode it was drawn from. Asserted as a
    // POSITIVE list — `not.toContain` alone passes when the member sees no
    // episodes at all, which is a different (and also broken) world.
    expect(bodiesOf(memberView.results)).toEqual([BODY.smallTalk, BODY.deploy].toSorted(byText));
  }, PG_TEST_TIMEOUT_MS);

  it("shows the audience-granted fact to a member INSIDE the audience", async () => {
    await syncHistory();
    await extract();
    await publish();

    const synced = await syncAudiences();
    // The unresolved arm is on the loop's happy path, not just in a unit test:
    // `U_GRACE` is in the exec channel with an address matching no Atlas user,
    // and `U_BOT` is screened before resolution ever sees it.
    expect(synced.principalsUnresolved).toBe(1);
    expect(synced.membersAdded).toBe(1);

    const execView = await search(await execMember());
    expect(subjectsOf(execView.results)).toEqual(["acquisition target", "deploy window"]);
    // The exec channel's evidence comes with it — asserted as an exact list
    // for the same reason as the negative case above.
    expect(bodiesOf(execView.results)).toEqual(
      [BODY.smallTalk, BODY.deploy, BODY.acquisition, BODY.lunch].toSorted(byText),
    );
  }, PG_TEST_TIMEOUT_MS);

  it("REVOKES on the next read when the source roster drops someone", async () => {
    // The acceptance criterion #4801 exists for, proven through the WHOLE loop
    // rather than at the reconcile alone: nothing about the fact or the episode
    // is touched, no re-ingest happens, and the reader loses the audience-
    // granted fact on their very next search.
    //
    // This is also the assertion that would catch a sync which only ever ADDS.
    // An insert-only implementation passes every other test in this file.
    await syncHistory();
    await extract();
    await publish();
    await syncAudiences();
    expect(subjectsOf((await search(await execMember())).results)).toContain("acquisition target");

    // Alan leaves the exec channel at the source. Nothing else changes.
    CHANNEL_ROSTER = { ...CHANNEL_ROSTER, [EXEC_CHANNEL]: ["U_BOT", "U_GRACE"] };
    const second = await syncAudiences();
    expect(second.membersRevoked).toBe(1);

    const after = await search(await execMember());
    expect(subjectsOf(after.results)).toEqual(["deploy window"]);
    // The exec channel's EVIDENCE goes with the fact — episodes are ACL-gated
    // by the same audience, so a revocation that hid the claim but left the
    // messages readable would be the leak this indirection exists to prevent.
    expect(bodiesOf(after.results)).toEqual([BODY.smallTalk, BODY.deploy].toSorted(byText));

    // Revocation HID the fact; it did not destroy it. The row is still
    // published, still carries its audience grant, and is still
    // un-invalidated — so re-adding Alan to the channel restores his access on
    // the next cycle with no re-ingest and no rewrite. That asymmetry is the
    // whole reason ADR-0036 routes sensitive facts through an `audience:`
    // instead of baking principals into the grant.
    // The grant survives publish UNCHANGED here only because every episode
    // behind this fact was posted in the exec channel: #4823's publish-time
    // widening unions in the grants of the fact's `provenance` evidence, so
    // restating this claim in a public channel would legitimately make this
    // `[EXEC_GRANT_TOKEN, 'org']`. Stated because the coupling to the corpus's
    // channel choice is invisible otherwise.
    const stored = (await facts()).find((f) => f.subject === "acquisition target");
    expect(stored).toMatchObject({ status: "published", visible_to: [EXEC_GRANT_TOKEN] });

    CHANNEL_ROSTER = { ...CHANNEL_ROSTER, [EXEC_CHANNEL]: ["U_ALAN", "U_BOT", "U_GRACE"] };
    const third = await syncAudiences();
    expect(third.membersAdded).toBe(1);
    const restored = await search(await execMember());
    expect(subjectsOf(restored.results)).toContain("acquisition target");

    // …and because nothing widened this fact, #4836's narrowing is inert on
    // it: the restored member gets FULL attribution through the real
    // `searchBrain` path. The negative at the INTEGRATION level — whole loop,
    // real Postgres, real ACL predicate — where a fix that withheld across the
    // board would surface as an agent that can no longer say who decided
    // anything. (The widened arm is covered in `candidates-pg.test.ts`; here
    // every episode behind this claim was posted in the exec channel, so
    // `pre_widening_visible_to` is NULL by construction — see the note above.)
    const acquisition = restored.results.find(
      (r) => r.tier === "fact" && r.subject === "acquisition target",
    );
    if (acquisition?.tier !== "fact") throw new Error("expected an acquisition fact result");
    expect(acquisition.provenance.attribution.visible).toBe(true);
  }, PG_TEST_TIMEOUT_MS);

  it("surfaces an un-drained episode as `extraction: pending`", async () => {
    // The default-OFF fiber's normal steady state: evidence lands before any
    // claim is drawn from it, and an agent reading in that window must be told
    // the difference rather than shown a silent gap.
    await syncHistory();

    const view = await search(await admin());
    const episodes = view.results.filter(isEpisode);
    expect(episodes).toHaveLength(2);
    expect(episodes.every((e) => e.extraction === "pending")).toBe(true);
    expect(episodes.find((e) => e.body === BODY.deploy)).toMatchObject({
      tier: "raw-episode",
      trustTier: 3,
      extraction: "pending",
      extractedAt: null,
      sourceId: publicSourceId(0),
    });
    // The fact store was queried and is genuinely empty — not merely filtered
    // out of the projection.
    expect(view.stores.fact).toMatchObject({ queried: true, matched: 0 });
  }, PG_TEST_TIMEOUT_MS);

  it("refuses to promote a draft whose grant no reader can ever match, without poisoning the batch", async () => {
    // `['everyone']` satisfies `chk_brain_facts_grant_nonempty` — a legally
    // storable row that grants nobody. Reconcile blocks it upstream, so the row
    // is INSERTed the way the one route reconcile does NOT own delivers it: a
    // region-migration import bundle, whose `grantProblem` mirrors only that
    // same CHECK.
    //
    // The sibling refusal arms (`PROVENANCE_MISSING` / `PROVENANCE_EMPTY`) are
    // unreachable from the database — `source_episode_id uuid NOT NULL` and
    // `chk_brain_facts_provenance_nonempty` make such a row unstorable, and
    // `promotion-pg.test.ts` already pins both constraints. So this is the one
    // gate refusal a LOOP can legitimately reach.
    await syncHistory();
    await extract();
    const episode = await episodeBySourceId(publicSourceId(0));

    await pool.query(
      `INSERT INTO brain_facts (workspace_id, subject, predicate, object,
                                subject_key, predicate_key, object_key,
                                predicate_cardinality, visible_to, provenance, source_episode_id)
       VALUES ($1, 'ungranted claim', 'is', 'unreachable',
               'ungranted claim', 'is', 'unreachable', 'single', ARRAY['everyone'],
               '{"source":"slack","producer":"import"}'::jsonb, $2)`,
      [WORKSPACE, episode.id],
    );

    const report = await publish();

    // The healthy drafts went live; the ungranted one did not. A refusal must
    // not poison the batch — one bad import row blocking every reviewed fact in
    // the workspace is the failure mode that matters here.
    expect(report.promoted).toBe(2);
    expect(report.refused).toHaveLength(1);
    expect(report.refused?.[0]?.reasons).toContain("GRANT_UNUSABLE");

    const rows = await facts();
    // A refusal is not a deletion — the row stays reviewable, it just does not
    // go live.
    expect(factBySubject(rows, "ungranted claim").status).toBe("draft");
    expect(factBySubject(rows, "deploy window").status).toBe("published");

    // The refusal names the row it refused — the assertion that actually
    // distinguishes "refused" from "promoted and then invisible anyway".
    // (An ACL assertion could NOT: `everyone` is not a token `principalTokens`
    // ever mints, so this row is unreadable whether or not the gate refused it.
    // Asserting invisibility here would pass in both worlds.)
    const ungrantedId = factBySubject(rows, "ungranted claim").id;
    expect(report.refused?.[0]?.rowId).toBe(ungrantedId);

    // Still absent from a read, for completeness of the loop's shape.
    expect(subjectsOf((await search(await admin())).results)).toEqual(["deploy window"]);
  }, PG_TEST_TIMEOUT_MS);

  it("re-syncing the same window writes no new episodes and mints no duplicate facts", async () => {
    // The loop's idempotence, end to end rather than per-stage. Each stage
    // proves its own no-op; only the whole run proves a routine re-poll of a
    // live channel does not slowly duplicate the brain.
    await syncHistory();
    await extract();
    await publish();


    const second = await syncHistory();
    // `duplicate: 4` rather than only `inserted: 0` — the second run must have
    // SEEN the same four records and recognised them, not fetched an empty
    // window, which would make this pass for free.
    expect(second.episodes).toEqual({
      inserted: 0,
      duplicate: 4,
      batchDuplicate: 0,
      refused: { blank_source_id: 0, blank_body: 0, unusable_grant: 0, invalid_occurred_at: 0 },
    });
    const replay = await extract();
    // `status` included: a scan fault reports the same three zeros as an idle
    // cycle, under `status: "failure"`.
    expect(replay).toMatchObject({ status: "success", inspected: 0, extracted: 0, factsCreated: 0 });

    const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM brain_episodes`);
    expect(rows[0]?.n).toBe("4");
    expect(await facts()).toHaveLength(2);
  }, PG_TEST_TIMEOUT_MS);
});
