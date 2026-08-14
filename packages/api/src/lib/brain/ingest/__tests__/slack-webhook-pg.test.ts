/**
 * Real-Postgres coverage for the Slack chat webhook fast-path (#4967,
 * ADR-0036 §T6) — the alternate writer, exercised against the live schema and
 * against the POLL writer it shares an episode store with.
 *
 * `slack-webhook.test.ts` pins the DECISION (which id, which grant, which
 * skips) with no I/O. Everything below is a claim only a live schema — and only
 * running BOTH writers — can settle, and every one of them would pass vacuously
 * against a mock:
 *
 *   1. **Do the two writers collapse to ONE episode?** Acceptance criterion 2.
 *      That is a property of `uq_brain_episodes_source_id` + `ON CONFLICT DO
 *      NOTHING` meeting two independently-derived ids, not of the TypeScript
 *      around either. The test drives the REAL poll client (through a scripted
 *      Slack surface) rather than hand-building the record the poll "would"
 *      produce — a hand-built record is a second implementation of the thing
 *      under test.
 *   2. **Can duplicate delivery inflate corroboration?** Acceptance criterion
 *      3, and the consequence the dedupe test does NOT imply. Corroboration is
 *      counted in `brain_edges` `provenance` rows, one per (fact, episode). Two
 *      episodes for one message means two edges on one fact — a claim reading
 *      as better-evidenced because it heard its own echo. Asserted directly,
 *      and asserted in BOTH directions: the same suite shows that two DISTINCT
 *      messages DO earn two edges, so the assertion is not passing because the
 *      edge writer is inert.
 *   3. **Is the poll genuinely the floor?** Acceptance criterion 5. With the
 *      knob off the writer must store nothing at all — not "store it slightly
 *      differently" — and the poll's subsequent pass must be bit-identical to
 *      what it would have been.
 *   4. **Does the install filter match the sync cycle's?** The webhook writes
 *      for exactly the installs the poll syncs, or it writes episodes no poll
 *      backstops. Disabled and archived installs are the two rows that separate
 *      those filters.
 *
 * Opt in locally with:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5433/brain_4967_scratch
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS, _resetPool } from "@atlas/api/lib/db/internal";
import { saveInstallation } from "@atlas/api/lib/slack/store";
import { SLACK_SOURCE } from "@atlas/api/lib/brain/sources";
import { reconcileFacts, type ReconcileEpisodeRef } from "@atlas/api/lib/brain/reconcile";
import { ingestEpisodes } from "@atlas/api/lib/brain/ingest/episodes";
import { _resetBrainSourceConnectors } from "@atlas/api/lib/brain/ingest/types";
import {
  createSlackHistoryClient,
  type SlackHistoryApi,
} from "@atlas/api/lib/brain/ingest/slack/client";
import { registerSlackHistoryConnector } from "@atlas/api/lib/brain/ingest/slack/connector";
import {
  SLACK_HISTORY_CATALOG_ID,
  slackEpisodeSourceId,
} from "@atlas/api/lib/brain/ingest/slack/config";
import { ingestSlackWebhookMessage } from "@atlas/api/lib/brain/ingest/slack/webhook";
import { identityVocabulary } from "@atlas/api/lib/brain/identity";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

const WORKSPACE = "ws-brain-4967";
const TEAM_ID = "T4967ABC";
const CHANNEL = "C01ABCDEF";
const PRIVATE_CHANNEL = "G01PRIVATE";
const TS = "1750000000.000100";
const BODY = "the deploy window is Thursdays";

/** The Slack message, as `conversations.history` serves it to the POLL. */
const HISTORY_MESSAGE = {
  ts: TS,
  text: BODY,
  user: "U123",
  subtype: null,
  botId: null,
} as const;

/** The same message, as the Events API delivers it to the WEBHOOK. */
function webhookEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "message",
    channel: CHANNEL,
    channel_type: "channel",
    user: "U123",
    text: BODY,
    ts: TS,
    // Slack puts BOTH on a `message` event, and they are not the same thing:
    // `ts` is the message's identity, `event_ts` is when the event was
    // dispatched. Carried in the fixture precisely because reading the wrong
    // one is the mistake the whole slice guards against — with it present, a
    // writer that reads `event_ts` produces an id the poll never mints, and the
    // dual-delivery tests below stop collapsing.
    event_ts: "1750000000.000999",
    team_id: TEAM_ID,
    ...overrides,
  };
}

/**
 * A Slack surface serving exactly one page containing `messages`. Deliberately
 * minimal — the walk's own behaviour is `slack-client.test.ts`'s subject; here
 * the client is present only so the POLL writer is the real one.
 */
function fakeSlackApi(
  messages: readonly (typeof HISTORY_MESSAGE)[],
  isPrivate = false,
): SlackHistoryApi {
  return {
    async getConversationInfo(_token, channelId) {
      return {
        ok: true,
        channel: { id: channelId, name: "general", isPrivate, isMember: true, isArchived: false },
      };
    },
    async fetchConversationHistoryPage() {
      return { ok: true, messages: [...messages], nextCursor: null, dropped: 0 };
    },
  };
}

describeIfPg("Slack brain webhook fast-path (real Postgres)", () => {
  let pool: Pool;
  let priorDatabaseUrl: string | undefined;
  let priorWebhookFlag: string | undefined;
  const schemaName = `brain_4967_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    // The writer guards on `hasInternalDB()`, which reads `DATABASE_URL` rather
    // than the pool — without this it takes the "no database" arm and every
    // assertion below would pass vacuously. Set inside the hook (never at
    // module top level, per the test-discipline rule) and restored after.
    priorDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = TEST_DB_URL;
    // The knob resolves through `getSettingAuto`'s env tier. Default is OFF, so
    // without this every test would assert against the disabled arm — which is
    // exactly what the acceptance-criterion-5 test turns it back to.
    priorWebhookFlag = process.env.ATLAS_BRAIN_CHAT_WEBHOOK_ENABLED;
    process.env.ATLAS_BRAIN_CHAT_WEBHOOK_ENABLED = "true";

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
    // Both writers and the store go through the module-level pool, so it has to
    // BE this schema-scoped one for the test to exercise the real SQL.
    _resetPool(pool);

    // The catalog row `workspace_plugins.catalog_id` references.
    await pool.query(
      `INSERT INTO plugin_catalog (id, name, slug, type, pillar, install_model)
       VALUES ($1, 'Slack (chat history)', 'slack-history', 'context', 'knowledge', 'form')
       ON CONFLICT (id) DO NOTHING`,
      [SLACK_HISTORY_CATALOG_ID],
    );
    // team_id → workspace. Written through the real store (tokens persist as
    // plaintext with `SLACK_ENCRYPTION_KEY` unset), so the writer's lookup is
    // the production one rather than a stub.
    await saveInstallation(TEAM_ID, "xoxb-test-token", { orgId: WORKSPACE });
  }, PG_TEST_TIMEOUT_MS * 2);

  afterAll(async () => {
    _resetPool(null);
    _resetBrainSourceConnectors();
    if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDatabaseUrl;
    if (priorWebhookFlag === undefined) delete process.env.ATLAS_BRAIN_CHAT_WEBHOOK_ENABLED;
    else process.env.ATLAS_BRAIN_CHAT_WEBHOOK_ENABLED = priorWebhookFlag;
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await pool.end();
    }
  });

  afterEach(async () => {
    await pool.query("DELETE FROM brain_edges");
    await pool.query("DELETE FROM brain_facts");
    await pool.query("DELETE FROM brain_episodes");
    await pool.query("DELETE FROM workspace_plugins");
    process.env.ATLAS_BRAIN_CHAT_WEBHOOK_ENABLED = "true";
  });

  // ── fixtures ──────────────────────────────────────────────────────────────

  /** The registry the writer resolves catalog ids from. */
  function registerConnector(): void {
    _resetBrainSourceConnectors();
    registerSlackHistoryConnector();
  }

  /**
   * Put the workspace's ingest scope in a known state (#5203).
   *
   * Replaces `installSource`, which wrote a `catalog:slack-history`
   * `workspace_plugins` row — a row that can no longer exist, because migration
   * 0198 deletes that catalog row and `workspace_plugins.catalog_id` is a
   * cascading FK onto it.
   *
   * `channels` are observed memberships; `excluded` are admin exclusions.
   */
  async function setScope(
    opts: { channels?: readonly string[]; excluded?: readonly string[] } = {},
  ): Promise<void> {
    for (const channelId of opts.channels ?? [CHANNEL]) {
      await pool.query(
        `INSERT INTO brain_slack_channel (workspace_id, channel_id, name, is_private, is_member)
         VALUES ($1, $2, 'general', false, true)
         ON CONFLICT (workspace_id, channel_id) DO UPDATE SET is_member = true`,
        [WORKSPACE, channelId],
      );
    }
    for (const channelId of opts.excluded ?? []) {
      await pool.query(
        `INSERT INTO brain_slack_channel
           (workspace_id, channel_id, is_member, excluded_at, exclusion_reason, excluded_by)
         VALUES ($1, $2, true, now(), 'test exclusion', 'user-test')
         ON CONFLICT (workspace_id, channel_id) DO UPDATE
           SET excluded_at = now(), exclusion_reason = 'test exclusion', excluded_by = 'user-test'`,
        [WORKSPACE, channelId],
      );
    }
  }

  /** Run the REAL poll writer over `messages` — client walk plus ingest. */
  async function runPoll(
    messages: readonly (typeof HISTORY_MESSAGE)[] = [HISTORY_MESSAGE],
    opts: { channel?: string; isPrivate?: boolean } = {},
  ) {
    const client = createSlackHistoryClient({
      token: "xoxb-test-token",
      channels: [opts.channel ?? CHANNEL],
      backfillWindowMs: 30 * 86_400_000,
      api: fakeSlackApi(messages, opts.isPrivate ?? false),
      // Fixed clock just after the message, so the backfill floor cannot drift
      // past it and make the walk return nothing.
      now: () => new Date(Number.parseFloat(TS) * 1000 + 60_000),
    });
    const changes = await client.fetchEpisodes({
      mode: "incremental",
      since: null,
      cursor: null,
      maxEpisodes: 100,
    });
    return ingestEpisodes({
      workspaceId: WORKSPACE,
      source: SLACK_SOURCE,
      episodes: changes.episodes,
    });
  }

  async function episodes(): Promise<
    { id: string; source_id: string; body: string; visible_to: string[]; source_actor: string | null }[]
  > {
    const { rows } = await pool.query<{
      id: string;
      source_id: string;
      body: string;
      visible_to: string[];
      source_actor: string | null;
    }>(
      `SELECT id, source_id, body, visible_to, source_actor
         FROM brain_episodes WHERE workspace_id = $1 ORDER BY source_id`,
      [WORKSPACE],
    );
    return rows;
  }

  async function provenanceEdgeCount(): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM brain_edges
        WHERE workspace_id = $1 AND edge_type = 'provenance'`,
      [WORKSPACE],
    );
    return Number.parseInt(rows[0]?.n ?? "0", 10);
  }

  /**
   * Reconcile ONE claim off every stored episode — the shape extraction takes
   * when both copies of a duplicated message reach the extractor. Byte-identical
   * candidates on purpose: `reconcile.ts` identifies a claim by the SLOT KEY of
   * the trimmed, resolved SPO (`alias(lexicalNorm(surface))` since #5020), and
   * identical input is the case that is guaranteed to land in one slot — so the
   * SECOND pass is a corroboration of the first rather than a second fact. That
   * is precisely the path a duplicate episode would travel. Byte-identical is
   * now sufficient rather than necessary for ANY surface that has a key — a
   * surface that norms away (`-`) keys NULL on both passes and corroborates
   * with nothing, byte-identical or not — which only makes this fixture a
   * stricter test of the dedupe than it needs to be.
   */
  async function extractSameClaimFromEveryEpisode(): Promise<void> {
    for (const row of await episodes()) {
      const ref: ReconcileEpisodeRef = {
        id: row.id,
        workspaceId: WORKSPACE,
        source: SLACK_SOURCE,
        sourceId: row.source_id,
        sourceActor: row.source_actor,
        occurredAt: new Date(Number.parseFloat(TS) * 1000),
        visibleTo: row.visible_to,
      };
      await reconcileFacts({
        vocabulary: identityVocabulary,
        episode: ref,
        candidates: [{ subject: "deploy window", predicate: "is", object: "Thursdays" }],
        producer: "extraction:v1",
        extractedAt: new Date(),
      });
    }
  }

  // ── 1. Both writers, one episode (acceptance criterion 2) ─────────────────

  it("webhook then poll: the same message yields exactly ONE episode", async () => {
    registerConnector();
    await setScope();

    const webhook = await ingestSlackWebhookMessage({ raw: webhookEvent() });
    expect(webhook).toEqual({ status: "inserted", sourceId: slackEpisodeSourceId(CHANNEL, TS) });

    // The REAL poll writer now covers the same window.
    const poll = await runPoll();
    // Not merely "one row survived": the poll REPORTED the record as already
    // stored, which is the dedupe being observed rather than inferred.
    expect(poll.inserted).toBe(0);
    expect(poll.duplicate).toBe(1);

    const stored = await episodes();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.source_id).toBe(slackEpisodeSourceId(CHANNEL, TS));
  }, PG_TEST_TIMEOUT_MS);

  it("poll then webhook: the same message still yields exactly ONE episode", async () => {
    registerConnector();
    await setScope();

    const poll = await runPoll();
    expect(poll.inserted).toBe(1);

    const webhook = await ingestSlackWebhookMessage({ raw: webhookEvent() });
    expect(webhook).toEqual({ status: "duplicate", sourceId: slackEpisodeSourceId(CHANNEL, TS) });
    expect(await episodes()).toHaveLength(1);
  }, PG_TEST_TIMEOUT_MS);

  it("stores the SAME body and grant whichever writer got there first", async () => {
    // The episode is append-only, so whichever writer wins freezes the row. If
    // the two disagreed about the body or the grant, the store's contents would
    // depend on a race — and the loser's version would never be applied.
    registerConnector();
    await setScope();
    await ingestSlackWebhookMessage({ raw: webhookEvent() });
    const viaWebhook = (await episodes())[0];

    await pool.query("DELETE FROM brain_episodes");
    await runPoll();
    const viaPoll = (await episodes())[0];

    expect(viaWebhook?.body).toBe(viaPoll?.body ?? "<poll stored nothing>");
    expect(viaWebhook?.visible_to).toEqual(viaPoll?.visible_to ?? []);
    expect(viaWebhook?.source_actor).toBe(viaPoll?.source_actor ?? null);
  }, PG_TEST_TIMEOUT_MS);

  // ── 2. Corroboration is not inflated (acceptance criterion 3) ─────────────

  it("dual delivery cannot inflate a fact's corroboration", async () => {
    registerConnector();
    await setScope();

    await ingestSlackWebhookMessage({ raw: webhookEvent() });
    await runPoll();
    await extractSameClaimFromEveryEpisode();

    const { rows: facts } = await pool.query<{ id: string }>(
      "SELECT id FROM brain_facts WHERE workspace_id = $1",
      [WORKSPACE],
    );
    expect(facts).toHaveLength(1);
    // THE assertion this issue exists for. One message said once, delivered
    // twice, must back the claim ONCE. A second edge here is a fact reading as
    // corroborated by its own echo.
    expect(await provenanceEdgeCount()).toBe(1);
  }, PG_TEST_TIMEOUT_MS);

  it("two DISTINCT messages DO earn two provenance edges", async () => {
    // The other direction, so the assertion above cannot pass because the edge
    // writer is inert. Genuine corroboration must still register.
    registerConnector();
    await setScope();

    const secondTs = "1750000600.000200";
    await ingestSlackWebhookMessage({ raw: webhookEvent() });
    await ingestSlackWebhookMessage({ raw: webhookEvent({ ts: secondTs }) });
    expect(await episodes()).toHaveLength(2);

    await extractSameClaimFromEveryEpisode();
    const { rows: facts } = await pool.query<{ id: string }>(
      "SELECT id FROM brain_facts WHERE workspace_id = $1",
      [WORKSPACE],
    );
    expect(facts).toHaveLength(1);
    expect(await provenanceEdgeCount()).toBe(2);
  }, PG_TEST_TIMEOUT_MS);

  // ── 3. The poll is the floor (acceptance criterion 5) ─────────────────────

  it("with the fast path disabled, ingest is exactly what the poll alone produces", async () => {
    registerConnector();
    await setScope();
    process.env.ATLAS_BRAIN_CHAT_WEBHOOK_ENABLED = "false";

    const webhook = await ingestSlackWebhookMessage({ raw: webhookEvent() });
    expect(webhook).toEqual({ status: "skipped", reason: "disabled", pollBackstopped: true });
    // Not "stored something different" — stored NOTHING. The disabled state is
    // a supported steady state, not a degraded one.
    expect(await episodes()).toHaveLength(0);

    const poll = await runPoll();
    expect(poll.inserted).toBe(1);
    const stored = await episodes();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.source_id).toBe(slackEpisodeSourceId(CHANNEL, TS));
    expect(stored[0]?.body).toBe(BODY);
  }, PG_TEST_TIMEOUT_MS);

  it("a failing fast path leaves the poll's outcome untouched", async () => {
    // The failure mode operators actually see: the writer errors on every
    // message (here, because nothing is registered to write for) and the
    // scheduled sync silently keeps the store correct.
    _resetBrainSourceConnectors();
    await setScope();

    expect(await ingestSlackWebhookMessage({ raw: webhookEvent() })).toEqual({
      status: "skipped",
      reason: "no_connector",
      pollBackstopped: true,
    });
    expect(await episodes()).toHaveLength(0);

    registerConnector();
    expect((await runPoll()).inserted).toBe(1);
    expect(await episodes()).toHaveLength(1);
  }, PG_TEST_TIMEOUT_MS);

  // ── 4. The webhook's scope predicate matches the poll's ───────────────────
  //
  // #5203 replaced this group's subject. It used to pin that the webhook wrote
  // for exactly the installs the cycle synced — disabled and archived installs
  // being the two rows that separated those filters. There are no installs, so
  // what has to agree now is the SCOPE: an admin exclusion must stop the fast
  // path exactly as it stops the poll, or the two writers' contents diverge.

  it("refuses to write for a channel the admin excluded", async () => {
    registerConnector();
    await setScope({ excluded: [CHANNEL] });

    expect(await ingestSlackWebhookMessage({ raw: webhookEvent() })).toEqual({
      status: "skipped",
      reason: "channel_not_configured",
      pollBackstopped: true,
    });
    expect(await episodes()).toHaveLength(0);
  }, PG_TEST_TIMEOUT_MS);

  it("⭐ DOES write for a channel with no row at all — delivery is the membership proof", async () => {
    // The asymmetry `scope.ts` documents, exercised against the live schema.
    // Slack only delivers `message.channels` events for conversations the bot is
    // in, so an event arriving for a channel the last refresh has not observed
    // yet is in scope — the alternative would drop every newly-invited channel's
    // messages until the next sync cycle, for no gain.
    //
    // MUTATION THIS CATCHES: adding `is_member = true` to the event-path
    // predicate, which reads like a tightening and is a silent narrowing.
    registerConnector();
    await setScope({ channels: [] });

    expect(await ingestSlackWebhookMessage({ raw: webhookEvent() })).toMatchObject({
      status: "inserted",
    });
    expect(await episodes()).toHaveLength(1);
  }, PG_TEST_TIMEOUT_MS);

  it("refuses a channel outside a workspace's unreconciled legacy scope", async () => {
    registerConnector();
    // A pre-#5203 workspace whose first sync has not run: the captured
    // allowlist governs, so a channel outside it is refused even though the bot
    // is plainly in it (Slack delivered the event). This is the arm that stops
    // the retirement broadening a workspace through the FAST PATH while the
    // poll is still narrow.
    await pool.query(
      `INSERT INTO brain_slack_ingest_scope (workspace_id, legacy_channels) VALUES ($1, $2::text[])`,
      [WORKSPACE, ["C09SOMETHINGELSE"]],
    );
    await setScope({ channels: [CHANNEL] });

    // Slack delivers events for every channel the bot is in — a strictly wider
    // set than the admin configured.
    expect(await ingestSlackWebhookMessage({ raw: webhookEvent() })).toEqual({
      status: "skipped",
      reason: "channel_not_configured",
      pollBackstopped: true,
    });
    expect(await episodes()).toHaveLength(0);
  }, PG_TEST_TIMEOUT_MS);

  it("refuses an event from a Slack team no workspace has installed", async () => {
    registerConnector();
    await setScope();

    expect(await ingestSlackWebhookMessage({ raw: webhookEvent({ team_id: "TUNKNOWN" }) })).toEqual({
      status: "skipped",
      reason: "unknown_workspace",
      pollBackstopped: true,
    });
    expect(await episodes()).toHaveLength(0);
  }, PG_TEST_TIMEOUT_MS);

  it("stores a message whose channel visibility it can establish, and refuses one it cannot", async () => {
    registerConnector();
    await setScope();

    expect(
      await ingestSlackWebhookMessage({ raw: webhookEvent({ channel_type: undefined }) }),
    ).toEqual({ status: "skipped", reason: "unresolvable_visibility", pollBackstopped: true });
    expect(await episodes()).toHaveLength(0);

    expect((await ingestSlackWebhookMessage({ raw: webhookEvent() })).status).toBe("inserted");
    expect((await episodes())[0]?.visible_to).toEqual(["org"]);
  }, PG_TEST_TIMEOUT_MS);

  // ── 5. The grant the two writers freeze onto the row ──────────────────────

  it("derives the SAME private-channel audience grant as the poll, from a different input", async () => {
    // The one derivation the two writers do NOT share. Everything else routes
    // through `toEpisode`; `isPrivate` comes from `conversations.info` on the
    // poll and from `channel_type` on the webhook. So this is the only place
    // they can disagree — and disagreement is unrecoverable, because the grant
    // is frozen at insert and `ON CONFLICT DO NOTHING` means the loser's
    // version is never applied.
    //
    // Asserted on the private arm specifically: the public arm is `["org"]` on
    // both sides and would agree even if the audience-id construction had
    // drifted, which is the failure that matters — #4801's membership sync
    // populates the id `deriveChatChannelGrant` mints, so a webhook that minted
    // a different one writes facts visible to nobody.
    registerConnector();
    await setScope({ channels: [PRIVATE_CHANNEL] });

    const webhook = await ingestSlackWebhookMessage({
      raw: webhookEvent({ channel: PRIVATE_CHANNEL, channel_type: "group" }),
    });
    expect(webhook.status).toBe("inserted");
    const viaWebhook = (await episodes())[0];
    expect(viaWebhook?.visible_to).toEqual([
      `audience:chat-channel:${SLACK_SOURCE}:${PRIVATE_CHANNEL}`,
    ]);

    await pool.query("DELETE FROM brain_episodes");
    const poll = await runPoll([HISTORY_MESSAGE], { channel: PRIVATE_CHANNEL, isPrivate: true });
    expect(poll.inserted).toBe(1);
    const viaPoll = (await episodes())[0];

    expect(viaWebhook?.visible_to).toEqual(viaPoll?.visible_to ?? []);
    expect(viaWebhook?.source_id).toBe(viaPoll?.source_id ?? "<poll stored nothing>");
  }, PG_TEST_TIMEOUT_MS);

  it("collapses to ONE episode in a private channel too, with the audience grant intact", async () => {
    registerConnector();
    await setScope({ channels: [PRIVATE_CHANNEL] });

    await ingestSlackWebhookMessage({
      raw: webhookEvent({ channel: PRIVATE_CHANNEL, channel_type: "group" }),
    });
    const poll = await runPoll([HISTORY_MESSAGE], { channel: PRIVATE_CHANNEL, isPrivate: true });
    expect(poll.duplicate).toBe(1);

    const stored = await episodes();
    expect(stored).toHaveLength(1);
    // Never widened to `org` by the second writer — the row the first writer
    // froze is the row that survives.
    expect(stored[0]?.visible_to).toEqual([
      `audience:chat-channel:${SLACK_SOURCE}:${PRIVATE_CHANNEL}`,
    ]);
  }, PG_TEST_TIMEOUT_MS);

  // ── 6. The never-throw property, against a real fault ─────────────────────

  it("reports a THROWN failure as its own fault reason and never rejects", async () => {
    // The load-bearing property of `ingestSlackWebhookMessage`: it runs inside
    // the SDK's handler dispatch, where a rejection aborts the remaining
    // handlers for that message. The other "failing fast path" test exercises a
    // clean skip, which never enters the catch at all — this one makes the
    // internal DB genuinely unusable so the throw is real.
    registerConnector();
    await setScope();
    // A pool pointed at a closed connection: `internalQuery` rejects rather
    // than returning an empty result, which is exactly the shape a live outage
    // takes.
    const broken = new Pool({ connectionString: TEST_DB_URL });
    await broken.end();
    _resetPool(broken);
    try {
      const outcome = await ingestSlackWebhookMessage({ raw: webhookEvent() });
      // `ingest_failed`, NOT `unparseable_event` — an earlier cut folded every
      // throw into the parse bucket, which also carries steady-state
      // `app_mention` refusals, so a total outage and ordinary traffic produced
      // the same counter.
      expect(outcome).toEqual({
        status: "skipped",
        reason: "ingest_failed",
        pollBackstopped: false,
      });
    } finally {
      _resetPool(pool);
    }
  }, PG_TEST_TIMEOUT_MS);

  it("reports a thread REPLY as having no poll backstop", async () => {
    // `conversations.history` never returns replies, so a reply this path
    // declines is lost rather than deferred. The flag is what lets the observer
    // log that at warn instead of reciting "the scheduled sync covers it".
    registerConnector();
    // Out of scope by EXCLUSION (#5203). "Scoped to some other channel" no
    // longer puts this one out of scope — with no exclusion row, delivery is the
    // membership proof and the event would be stored.
    await setScope({ excluded: [CHANNEL] });

    const outcome = await ingestSlackWebhookMessage({
      raw: webhookEvent({ ts: "1750000500.000200", thread_ts: TS }),
    });
    expect(outcome).toEqual({
      status: "skipped",
      reason: "channel_not_configured",
      pollBackstopped: false,
    });

    // A TOP-LEVEL message declined for the identical reason IS backstopped —
    // the contrast is what makes the flag mean something.
    expect(await ingestSlackWebhookMessage({ raw: webhookEvent() })).toEqual({
      status: "skipped",
      reason: "channel_not_configured",
      pollBackstopped: true,
    });
  }, PG_TEST_TIMEOUT_MS);

});
