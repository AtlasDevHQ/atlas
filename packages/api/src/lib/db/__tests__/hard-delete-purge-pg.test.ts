/**
 * GDPR hard-delete purge falsifier, against a real Postgres (#5160).
 *
 * The AC this exists to satisfy, quoted: *"a test that seeds a workspace with
 * rows in every one of these tables, purges, and asserts zero rows remain. A
 * test that only asserts the purge succeeds cannot fail."*
 *
 * `hardDeleteWorkspace` had 56 DELETEs and reached none of `brain_facts`,
 * `brain_edges`, `brain_episodes` or `knowledge_documents`, while the endpoint
 * answered *"All data has been irreversibly removed"*. Every test it had passed
 * throughout, because they asserted the purge SUCCEEDED and checked counts for
 * tables the purge already knew about. Nothing seeded a table the purge missed,
 * so nothing could notice the ones it missed.
 *
 * Two properties make this suite able to fail where those could not:
 *
 *  1. **The seed list is DERIVED from `PURGED_TABLES`, not hand-written.** A
 *     hand-written list is a second copy of the same belief that produced the
 *     bug — it would have omitted the brain tables for exactly the reason the
 *     implementation did. Deriving it means adding a table to the registry
 *     without a working DELETE fails HERE, and the companion
 *     `purge-scope.test.ts` makes leaving it out of the registry fail THERE.
 *  2. **Rows are seeded generically from `information_schema`**, so a table
 *     gaining a NOT NULL column does not quietly drop out of the seed.
 *
 * The seed runs with `session_replication_role = replica` so FK order does not
 * constrain it; the PURGE runs with enforcement back ON, which is what exercises
 * the two RESTRICT orderings in the brain block. Setting it requires superuser,
 * and a failure to set it FAILS the suite rather than skipping — a purge
 * falsifier that quietly downgrades itself is the thing this file is about.
 *
 * Skipped cleanly when TEST_DATABASE_URL is unset (matches migrate-pg /
 * pattern-latency-pg). CI's api-tests workflow provides the Postgres service.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import {
  hardDeleteWorkspace,
  _resetPool,
  type InternalPool,
  type HardDeleteResult,
} from "@atlas/api/lib/db/internal";
import {
  PURGE_TABLE_DECISIONS,
  PURGED_TABLES,
  RETAINED_TABLES,
  WORKSPACE_SCOPE_COLUMNS,
} from "../purge-scope";

/**
 * The `anonymized` and `retained` tables are seeded too. Their assertions are
 * about rows SURVIVING, so an unseeded table would make each of them pass on an
 * empty table — the vacuous-pass shape this whole file exists to avoid.
 */
const SURVIVOR_TABLES: readonly string[] = Object.entries(PURGE_TABLE_DECISIONS)
  .filter(([, v]) => v.decision === "anonymized" || v.decision === "retained")
  .map(([k]) => k)
  // `stripe_purged_subscriptions` is the one survivor that CANNOT be seeded:
  // it has no workspace attribution because the purge transaction is what
  // WRITES it (#3468). Its assertion is therefore that the purge produced a
  // tombstone, not that a pre-existing row was spared — excluded here so the
  // "everything was seeded" guard stays a real check rather than being widened
  // to accommodate the one table that legitimately cannot be.
  .filter((t) => t !== "stripe_purged_subscriptions");

/**
 * Tables the purge scopes by a JSON/expression predicate rather than a column.
 * They have no scope column AND no parent, so the generic seeder cannot attribute
 * them — COLUMN_OVERRIDES supplies the shape the purge's expression targets.
 */
const EXPRESSION_SCOPED: readonly string[] = ["chat_cache"];

/**
 * Tables that must be seeded in THIS order, before everything else.
 *
 * The brain block's two RESTRICT foreign keys are the reason. Measured: with the
 * seed leaving `brain_facts.source_episode_id` NULL and
 * `brain_vocabulary_target.norm` pointing at nothing, swapping the delete order
 * to `brain_episodes` before `brain_facts` passed this suite 9/9 — the RESTRICT
 * cannot fire when no row references anything, so the ordering the
 * implementation calls load-bearing was unproven here and only the static
 * tripwire caught it. Wiring the references makes the wrong order abort the
 * purge transaction, which is the actual production consequence.
 */
const SEED_PRIORITY: readonly string[] = [
  "brain_episodes",
  "brain_facts",
  "brain_edges",
  "brain_vocabulary_edge",
  "brain_vocabulary_target",
];

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

const PG_TIMEOUT_MS = 120_000;
const ORG = "org-purge-falsifier";
/** A second workspace, seeded identically and never purged — the blast radius control. */
const NEIGHBOUR = "org-purge-neighbour";
/** Member of ORG only. Orphaned by the purge, so their user row and everything keyed to it must go. */
const USER_ORPHAN = "user-purge-orphan";
/**
 * Member of BOTH workspaces. The control for the user arm: the purge must NOT
 * touch them, because they still belong to NEIGHBOUR. Without this user, every
 * "the orphan's row is gone" assertion is satisfied by a DELETE with no user
 * predicate at all.
 */
const USER_SHARED = "user-purge-shared";

/**
 * Minimal Better Auth bootstrap — `hardDeleteWorkspace` reads and writes
 * `organization`, `member`, `invitation`, `session`, `account` and `user`,
 * none of which are Atlas-owned tables (global by ADR-0024). Only the columns
 * the purge actually touches.
 */
const BETTER_AUTH_BOOTSTRAP_SQL = `
  CREATE TABLE IF NOT EXISTS "user" (
    id TEXT PRIMARY KEY,
    email TEXT,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    name TEXT,
    role TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS "session" (
    id TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    token TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS "account" (
    id TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    "providerId" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS "organization" (
    id TEXT PRIMARY KEY,
    name TEXT,
    slug TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS "member" (
    id TEXT PRIMARY KEY,
    "organizationId" TEXT NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
    "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    role TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS "invitation" (
    id TEXT PRIMARY KEY,
    "organizationId" TEXT NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
    email TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

interface ColumnMeta {
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: "YES" | "NO";
  has_default: boolean;
  is_generated: boolean;
}

/**
 * Child tables that carry no scope column of their own: their DELETE reads the
 * parent's rows, so the seeded child must point at the seeded parent or the
 * subquery matches nothing and the row would survive a CORRECT purge.
 *
 * `purge-scope.test.ts` pins the same pairs for delete ORDER; this map pins the
 * column that links them.
 */
interface ParentLink {
  /** The child's column holding the parent's key. */
  readonly column: string;
  readonly parent: string;
  /** The parent column the child points at. */
  readonly parentKey: string;
  /** The PARENT's scope column — quoted as it appears in SQL. */
  readonly parentScope: string;
}

const PARENT_LINK: Readonly<Record<string, ParentLink>> = {
  messages: { column: "conversation_id", parent: "conversations", parentKey: "id", parentScope: "org_id" },
  slack_threads: { column: "conversation_id", parent: "conversations", parentKey: "id", parentScope: "org_id" },
  dashboard_cards: { column: "dashboard_id", parent: "dashboards", parentKey: "id", parentScope: "org_id" },
  dashboard_user_drafts: { column: "dashboard_id", parent: "dashboards", parentKey: "id", parentScope: "org_id" },
  dashboard_draft_card_cache: { column: "dashboard_id", parent: "dashboards", parentKey: "id", parentScope: "org_id" },
  knowledge_links: { column: "source_document_id", parent: "knowledge_documents", parentKey: "id", parentScope: "workspace_id" },
  suggestion_user_clicks: { column: "suggestion_id", parent: "query_suggestions", parentKey: "id", parentScope: "org_id" },
  scheduled_task_runs: { column: "task_id", parent: "scheduled_tasks", parentKey: "id", parentScope: "org_id" },
  prompt_items: { column: "collection_id", parent: "prompt_collections", parentKey: "id", parentScope: "org_id" },
  stripe_webhook_events: {
    column: "stripe_subscription_id",
    parent: "subscription",
    parentKey: "stripeSubscriptionId",
    parentScope: "referenceId",
  },
};

/**
 * Values a CHECK constraint or a scoping expression demands. Anything absent
 * here gets a synthesized value from its type.
 *
 * `chat_cache` is the interesting one: the purge matches
 * `key LIKE 'slack:installation:%' AND value->>'orgId' = $1`, so a generic row
 * would not be purged AND would not be expected to be — the seed has to
 * reproduce the shape the expression targets, or the assertion is vacuous.
 */
const COLUMN_OVERRIDES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  chat_cache: {
    key: `'slack:installation:' || $1`,
    value: `jsonb_build_object('orgId', $1::text, 'token', 'enc:v1:fake')`,
  },
  // stripeSubscriptionId is nullable, so the generic pass skips it — but the
  // purge finds stripe_webhook_events rows THROUGH it (`WHERE ... IS NOT NULL`),
  // so leaving it NULL makes the webhook-ledger delete match nothing and the
  // assertion about it vacuous.
  subscription: {
    plan: `'pro'`,
    status: `'active'`,
    stripeSubscriptionId: `('sub_purge-seed-' || $1)`,
  },
  // actor_id / actor_email / ip_address are all NULLABLE, so the generic pass
  // skips them — and a seeded row with them already NULL makes "the scrub
  // nulled them" pass whether the scrub ran or not. Seeding real values is what
  // gives that assertion the ability to fail.
  admin_action_log: {
    scope: `'workspace'`,
    status: `'success'`,
    actor_id: `('actor-' || $1)`,
    actor_email: `('actor-' || $1 || '@purge.test')`,
    ip_address: `'203.0.113.7'`,
    anonymized_at: `NULL`,
  },
  audit_log: { auth_mode: `'managed'` },
  // op is CHECKed against the target column being non-null, so the two must
  // agree — a synthesized 'purge-seed' op satisfies neither arm.
  stripe_teardown_pending: {
    op: `'cancel_subscription'`,
    stripe_sub_id: `('sub_teardown-' || $1)`,
  },
  approval_queue: { status: `'pending'` },
  email_outbox: { status: `'pending'` },
  crm_outbox: { status: `'pending'` },
  knowledge_documents: { status: `'published'` },
  workspace_plugins: { status: `'published'`, pillar: `'datasource'` },
  custom_domains: { status: `'pending'` },
  // Enum-shaped CHECK constraints — a synthesized 'purge-seed' fails them all.
  sso_providers: { type: `'oidc'` },
  approval_rules: { rule_type: `'table'` },
  workspace_model_config: { provider: `'gateway'` },
  workspace_model_catalog: { provider: `'anthropic'` },
  abuse_events: { level: `'warning'`, trigger_type: `'manual'` },
  knowledge_sync_state: { status: `'success'` },
  proactive_pauses: { layer: `'workspace-kill'` },
  proactive_meter_events: { event_type: `'classify'` },
  proactive_classification_review: { verdict: `'correct'` },
  brain_predicate_cardinality: {
    source_class: `'human'`,
    cardinality: `'single'`,
    status: `'approved'`,
  },
  // Structural constraints, not enums:
  //  - visible_to must hold at least one non-empty grant (no-grant-no-promotion)
  //  - provenance must be a non-empty object
  brain_facts: {
    visible_to: `ARRAY['org']::text[]`,
    provenance: `jsonb_build_object('source', 'purge-seed')`,
    status: `'published'`,
    // The RESTRICT FK to brain_episodes. Nullable, so the generic pass skips it
    // — and a NULL here is what made the delete-order mutation pass.
    source_episode_id: `(SELECT id FROM brain_episodes WHERE workspace_id = $1 LIMIT 1)`,
  },
  // body XOR locator, whichever is set must be non-empty, and visible_to needs
  // a real grant — the generic ARRAY synthesizer produces '{}', which is
  // exactly the empty grant chk_*_grant_nonempty exists to reject.
  brain_episodes: {
    body: `'purge-seed body'`,
    locator: `NULL`,
    visible_to: `ARRAY['org']::text[]`,
  },
  // 'derives-from' is the one edge_type whose endpoint check is unconditional.
  // from_fact_id must be non-null (nullable in the schema, so the generic pass
  // skips it) and exactly one of to_fact_id / to_episode_id must be set. Both
  // endpoints point at the REAL seeded rows so the composite FKs resolve.
  brain_edges: {
    edge_type: `'derives-from'`,
    from_fact_id: `(SELECT id FROM brain_facts WHERE workspace_id = $1 LIMIT 1)`,
    from_episode_id: `NULL`,
    to_fact_id: `NULL`,
    to_episode_id: `(SELECT id FROM brain_episodes WHERE workspace_id = $1 LIMIT 1)`,
  },
  // `from_norm <> to_norm` / `norm <> effective_target` — the synthesized value
  // is the same string on both sides, which is exactly what these forbid.
  brain_vocabulary_edge: {
    from_norm: `'purge-seed-from'`,
    to_norm: `'purge-seed-to'`,
    slot_position: `'subject'`,
  },
  // `norm` must MATCH the edge's from_norm, or the RESTRICT FK to
  // brain_vocabulary_edge references nothing and the delete-order constraint
  // this pair exists to enforce is never exercised.
  brain_vocabulary_target: {
    norm: `'purge-seed-from'`,
    effective_target: `'purge-seed-target'`,
    slot_position: `'subject'`,
  },
  brain_vocabulary_proposal: {
    from_norm: `'purge-seed-from'`,
    to_norm: `'purge-seed-to'`,
    slot_position: `'subject'`,
    status: `'pending'`,
    source_class: `'human'`,
  },
};

describeIfPg("hardDeleteWorkspace GDPR falsifier (real Postgres, #5160)", () => {
  let pool: Pool;
  const schemaName = `purge_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  /** table → the scope column its rows were seeded under. */
  const seeded = new Map<string, string>();
  const skipped: string[] = [];
  let result: HardDeleteResult;

  const columnsFor = async (table: string): Promise<ColumnMeta[]> => {
    const res = await pool.query<ColumnMeta>(
      `SELECT column_name, data_type, udt_name, is_nullable,
              (column_default IS NOT NULL) AS has_default,
              (is_generated = 'ALWAYS' OR is_identity = 'YES') AS is_generated
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2
        ORDER BY ordinal_position`,
      [schemaName, table],
    );
    return res.rows;
  };

  /** A deterministic non-null value for a column, by type. */
  const synthesize = (col: ColumnMeta): string => {
    switch (col.udt_name) {
      case "uuid":
        return `gen_random_uuid()`;
      case "timestamptz":
      case "timestamp":
        return `now()`;
      case "date":
        return `current_date`;
      case "bool":
        return `false`;
      case "int2":
      case "int4":
      case "int8":
      case "numeric":
      case "float4":
      case "float8":
        return `1`;
      case "jsonb":
        return `'{}'::jsonb`;
      case "json":
        return `'{}'::json`;
      case "bytea":
        return `'\\x00'::bytea`;
      default:
        if (col.data_type === "ARRAY") return `'{}'::${col.udt_name.replace(/^_/, "")}[]`;
        // text / varchar / anything else textual. Interpolating the workspace
        // id keeps the value UNIQUE per workspace, which matters because both
        // workspaces are seeded into the same table and several of these
        // columns are primary keys (oauth_state.state,
        // stripe_webhook_events.event_id) — a constant would collide on the
        // second insert and the seed would report a failure that is really an
        // artifact of the seeder.
        return `('purge-seed-' || $1)`;
    }
  };

  /**
   * Seed exactly one row into `table`, attributed to `workspaceId`.
   * Returns the scope column used, or null when the table has no reachable
   * attribution (recorded and asserted on, never silently dropped).
   */
  const seedRow = async (
    client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
    table: string,
    workspaceId: string,
  ): Promise<string | null> => {
    const cols = await columnsFor(table);
    if (cols.length === 0) return null;

    const names = cols.map((c) => c.column_name);
    const overrides = COLUMN_OVERRIDES[table] ?? {};
    const scopeCol = (WORKSPACE_SCOPE_COLUMNS as readonly string[]).find((c) => names.includes(c));
    const link = PARENT_LINK[table];

    // Track raw names for the dedupe: quoting them into `insertCols` and then
    // testing membership against the unquoted name never matches, which yields
    // "column X specified more than once" from Postgres for every table whose
    // scope column is also NOT NULL — i.e. almost all of them.
    const taken = new Set<string>();
    const insertCols: string[] = [];
    const insertVals: string[] = [];
    const push = (name: string, value: string) => {
      if (taken.has(name)) return;
      taken.add(name);
      insertCols.push(`"${name}"`);
      insertVals.push(value);
    };

    // The attribution first — it is the whole point of the row.
    if (scopeCol) push(scopeCol, `$1`);
    if (link) {
      // Scope by the PARENT's column, not the child's: the child has no scope
      // column (that is why it is in PARENT_LINK at all), and `conversations`
      // scopes by org_id while `knowledge_documents` scopes by workspace_id.
      push(
        link.column,
        `(SELECT "${link.parentKey}" FROM "${link.parent}" WHERE "${link.parentScope}" = $1 LIMIT 1)`,
      );
    }
    for (const [name, value] of Object.entries(overrides)) {
      if (names.includes(name)) push(name, value);
    }
    // Then every column that would otherwise reject the insert.
    for (const col of cols) {
      if (col.is_generated) continue;
      if (col.is_nullable === "YES" || col.has_default) continue;
      push(col.column_name, synthesize(col));
    }

    if (!scopeCol && !link && !EXPRESSION_SCOPED.includes(table)) return null;

    await client.query(
      `INSERT INTO "${table}" (${insertCols.join(", ")}) VALUES (${insertVals.join(", ")})`,
      [workspaceId],
    );
    return scopeCol ?? (link ? `via ${link.parent}` : "via expression");
  };

  const countFor = async (table: string, workspaceId: string): Promise<number> => {
    const cols = (await columnsFor(table)).map((c) => c.column_name);
    const scopeCol = (WORKSPACE_SCOPE_COLUMNS as readonly string[]).find((c) => cols.includes(c));
    const link = PARENT_LINK[table];

    if (table === "chat_cache") {
      const r = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM chat_cache
          WHERE key LIKE 'slack:installation:%' AND value->>'orgId' = $1`,
        [workspaceId],
      );
      return Number(r.rows[0].n);
    }
    if (scopeCol) {
      const r = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "${table}" WHERE "${scopeCol}" = $1`,
        [workspaceId],
      );
      return Number(r.rows[0].n);
    }
    if (link) {
      // The parent is gone after a correct purge, so counting through it would
      // report 0 for a child row that actually survived. Count the whole table
      // instead and let the neighbour's identically-seeded rows be the
      // discriminator: a leaked row makes this exceed the neighbour's count.
      const r = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM "${table}"`);
      return Number(r.rows[0].n);
    }
    return -1;
  };

  beforeAll(async () => {
    // The scratch schema is baked into the CONNECTION STRING rather than set by
    // an `on("connect")` handler (matching `migrate-roundtrip-pg` and
    // `admin-last-admin-pg`). The handler form applies the search_path with a
    // fire-and-forget query whose failure is only a `console.error` — and if it
    // ever failed, this suite would run 196 migrations and a full GDPR purge
    // against `public` on the shared test database. Baking it in makes a failure
    // a connection failure instead of a silent fallback, which is the same
    // standard this file's docstring demands of its own falsifiers.
    const setupPool = new Pool({ connectionString: TEST_DB_URL, max: 1 });
    await setupPool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await setupPool.end();

    pool = new Pool({
      connectionString: TEST_DB_URL,
      max: 4,
      options: `-c search_path="${schemaName}"`,
    });
    await pool.query(BETTER_AUTH_BOOTSTRAP_SQL);
    // Full migration set, nothing skipped — the Better Auth tables above exist,
    // so the MANAGED_AUTH_MIGRATIONS apply too. The brain and KB tables the
    // purge was missing only exist after this runs.
    await runMigrations(pool);

    process.env.DATABASE_URL = TEST_DB_URL;
    _resetPool(pool as unknown as InternalPool);

    for (const workspaceId of [ORG, NEIGHBOUR]) {
      await pool.query(
        `INSERT INTO "organization" (id, name, slug) VALUES ($1, $1, $1)
         ON CONFLICT (id) DO NOTHING`,
        [workspaceId],
      );
    }
    // The purge refuses a workspace that is not already soft-deleted.
    await pool.query(`UPDATE "organization" SET workspace_status = 'deleted' WHERE id = $1`, [ORG]);
    await pool.query(
      `INSERT INTO "user" (id, email) VALUES ($1, 'orphan@purge.test')
       ON CONFLICT (id) DO NOTHING`,
      [USER_ORPHAN],
    );
    await pool.query(
      `INSERT INTO "user" (id, email) VALUES ($1, 'shared@purge.test')
       ON CONFLICT (id) DO NOTHING`,
      [USER_SHARED],
    );
    await pool.query(
      `INSERT INTO "member" (id, "organizationId", "userId", role)
       VALUES ('m-orphan', $1, $2, 'owner') ON CONFLICT (id) DO NOTHING`,
      [ORG, USER_ORPHAN],
    );
    // USER_SHARED belongs to BOTH orgs, so the purge must spare them.
    await pool.query(
      `INSERT INTO "member" (id, "organizationId", "userId", role)
       VALUES ('m-shared-org', $1, $2, 'member') ON CONFLICT (id) DO NOTHING`,
      [ORG, USER_SHARED],
    );
    await pool.query(
      `INSERT INTO "member" (id, "organizationId", "userId", role)
       VALUES ('m-shared-neighbour', $1, $2, 'member') ON CONFLICT (id) DO NOTHING`,
      [NEIGHBOUR, USER_SHARED],
    );

    // ── Better-Auth session/account rows, and the user-keyed Atlas tables ──
    // None of these are in db/schema.ts or PURGED_TABLES, so the registry-driven
    // loop below cannot reach them — and until they were seeded here, deleting
    // `DELETE FROM session`, `DELETE FROM account`, `DELETE FROM user_onboarding`
    // or `DELETE FROM email_preferences` outright passed BOTH suites. A live
    // session token surviving its own deleted user is the sharpest of those.
    for (const userId of [USER_ORPHAN, USER_SHARED]) {
      await pool.query(
        `INSERT INTO "session" (id, "userId", token) VALUES ('s-' || $1, $1, 'tok-' || $1)
         ON CONFLICT (id) DO NOTHING`,
        [userId],
      );
      await pool.query(
        `INSERT INTO "account" (id, "userId", "providerId") VALUES ('a-' || $1, $1, 'credential')
         ON CONFLICT (id) DO NOTHING`,
        [userId],
      );
      await pool.query(
        `INSERT INTO user_onboarding (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
        [userId],
      );
      await pool.query(
        `INSERT INTO email_preferences (user_id, onboarding_emails) VALUES ($1, true)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId],
      );
      await pool.query(
        `INSERT INTO trusted_device (identifier, user_id, user_agent, ip_address)
         VALUES ('td-' || $1, $1, 'purge-seed-ua', '203.0.113.9')
         ON CONFLICT (identifier) DO NOTHING`,
        [userId],
      );
    }

    // The anti-abuse trial grant, keyed on a REAL user (#5160 review). The
    // generic pass would have synthesized a phantom `user_id`, which made the
    // migration-level `"user"(id) ON DELETE CASCADE` unable to fire — so the
    // test asserting the cascade removes it was asserting nothing.
    await pool.query(
      `INSERT INTO user_trial_grants (user_id, org_id) VALUES ($1, $2)
       ON CONFLICT (user_id) DO NOTHING`,
      [USER_ORPHAN, ORG],
    );
    await pool.query(
      `INSERT INTO user_trial_grants (user_id, org_id) VALUES ($1, $2)
       ON CONFLICT (user_id) DO NOTHING`,
      [USER_SHARED, ORG],
    );

    // A pending password-reset email with NO org (a session-less flow). The
    // purge scopes on `org_id = $1`, which excludes NULL — the registry states
    // that exclusion is deliberate, and this row is what makes the statement
    // falsifiable: broadening to `OR org_id IS NULL` destroys a live reset.
    await pool.query(
      `INSERT INTO email_outbox (email_type, payload, org_id, status)
       VALUES ('password-reset', 'enc:v1:orphaned-flow', NULL, 'pending')`,
    );

    // An admin_action_log row that was ALREADY scrubbed by the F-36 per-user
    // endpoint. The purge's `anonymized_at IS NULL` predicate must skip it, or
    // the reported count re-counts an earlier erasure as this purge's work.
    await pool.query(
      `INSERT INTO admin_action_log
         (timestamp, actor_id, actor_email, scope, org_id, action_type, target_type,
          target_id, status, request_id, anonymized_at)
       VALUES (now(), NULL, NULL, 'workspace', $1, 'workspace.suspend', 'workspace',
               'previously-scrubbed', 'success', 'req-old', now() - interval '1 day')`,
      [ORG],
    );

    // ── Seed every purged table, for BOTH workspaces ──
    // FK enforcement off for the seed only: the seed's job is to put a row in
    // every table, not to model a realistic graph. Enforcement is back on for
    // the purge, which is what exercises the RESTRICT orderings.
    // ONE dedicated connection for the whole seed. `session_replication_role`
    // is a SESSION setting, so setting it on a pooled `pool.query` affects only
    // whichever connection served that call — every subsequent INSERT would land
    // on a different connection with FK enforcement still on, and the seed would
    // report a wall of foreign-key violations that look like schema problems.
    const seedClient = await pool.connect();
    const seedErrors: string[] = [];
    try {
      // search_path already comes from the pool's connection options; asserting
      // it here catches a misconfigured pool before the seed writes anywhere.
      const sp = await seedClient.query<{ search_path: string }>(`SHOW search_path`);
      if (!sp.rows[0].search_path.includes(schemaName)) {
        throw new Error(
          `seed client is not on the scratch schema (search_path=${sp.rows[0].search_path}) — ` +
            `refusing to seed into a shared schema`,
        );
      }
      const replica = await seedClient
        .query(`SET session_replication_role = replica`)
        .then(() => true)
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          seedErrors.push(
            `could not disable FK enforcement for the seed (needs superuser): ${message}`,
          );
          return false;
        });

      // SEED_PRIORITY first (in its own order, so the brain block's RESTRICT
      // references resolve), then everything else, then the PARENT_LINK children
      // whose INSERT subqueries read their parent's rows.
      const rank = (t: string): number => {
        const priority = SEED_PRIORITY.indexOf(t);
        if (priority !== -1) return priority;
        return PARENT_LINK[t] ? 1000 : 500;
      };
      const order = [...PURGED_TABLES].toSorted((a, b) => rank(a) - rank(b));
      if (replica) {
        for (const workspaceId of [ORG, NEIGHBOUR]) {
          for (const table of [...order, ...SURVIVOR_TABLES]) {
            try {
              const scope = await seedRow(seedClient, table, workspaceId);
              if (scope === null) {
                // Only PURGED tables are asserted to be seedable — a survivor
                // table with no attribution is reported the same way, so the
                // list below stays honest either way.
                if (workspaceId === ORG) skipped.push(table);
              } else if (workspaceId === ORG) {
                seeded.set(table, scope);
              }
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              seedErrors.push(`${table} (${workspaceId}): ${message}`);
            }
          }
          // Better Auth's invitation table is not in db/schema.ts (global by
          // ADR-0024), so the registry-driven loop above cannot reach it — but
          // the purge deletes it and reports a count, so it needs a row or that
          // count is a silent 0.
          await seedClient.query(
            `INSERT INTO "invitation" (id, "organizationId", email)
             VALUES ('inv-' || $1, $1, 'invitee@purge.test')
             ON CONFLICT (id) DO NOTHING`,
            [workspaceId],
          );
        }
        await seedClient.query(`SET session_replication_role = DEFAULT`);
      }
    } finally {
      seedClient.release();
    }
    // A seed failure would make a "0 rows remain" assertion pass vacuously, so
    // it is a hard failure of the suite, not a warning.
    if (seedErrors.length > 0) {
      throw new Error(`Seed failed for ${seedErrors.length} table(s):\n${seedErrors.join("\n")}`);
    }

    result = await hardDeleteWorkspace(ORG);
  }, PG_TIMEOUT_MS);

  afterAll(async () => {
    _resetPool(null);
    if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
    await pool?.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`).catch(() => {
      // intentionally ignored: teardown of a throwaway schema
    });
    await pool?.end();
  });

  it("seeded a row in every purged table (the assertions below are only as good as this)", () => {
    // The guard that stops every other test in this file from passing
    // vacuously. `skipped` must be empty: a table with no reachable attribution
    // is one this suite cannot speak for, and silence there is what the bug was.
    expect(
      skipped,
      `Table(s) that could not be seeded: ${skipped.join(", ")}. Each needs a ` +
        `WORKSPACE_SCOPE_COLUMNS entry, a PARENT_LINK entry, an EXPRESSION_SCOPED entry, ` +
        `or a COLUMN_OVERRIDES value.`,
    ).toEqual([]);
    // Every purged table AND every survivor table got a row.
    expect(seeded.size).toBe(PURGED_TABLES.size + SURVIVOR_TABLES.length);
    for (const table of PURGED_TABLES) {
      expect([...seeded.keys()], `${table} was never seeded`).toContain(table);
    }
    // Sanity on the pillars #5160 named — if these were absent the headline
    // assertion would be checking nothing.
    for (const table of ["brain_facts", "brain_edges", "brain_episodes", "knowledge_documents"]) {
      expect([...seeded.keys()]).toContain(table);
    }
  });

  it("leaves ZERO rows for the purged workspace in every purged table", async () => {
    // THE falsifier. Removing any single DELETE from hardDeleteWorkspace fails
    // this with that table named.
    const survivors: string[] = [];
    for (const table of seeded.keys()) {
      if (!PURGED_TABLES.has(table)) continue; // survivor tables assert the opposite
      // The parent-scoped children cannot be counted BY WORKSPACE after the
      // purge — their only attribution was the parent row, which is gone, so a
      // scoped count would answer 0 for a row that actually leaked. They get
      // the exact-survivor-count test below instead, which can tell the
      // difference.
      if (PARENT_LINK[table]) continue;
      const remaining = await countFor(table, ORG);
      if (remaining !== 0) survivors.push(`${table} (${remaining} row(s) remain)`);
    }
    expect(
      survivors,
      `Rows survived the GDPR purge in: ${survivors.join(", ")}. The endpoint tells the ` +
        `operator "All data has been irreversibly removed" and /dpa promises deletion of all ` +
        `Personal Data — both are false while any row here survives.`,
    ).toEqual([]);
  }, PG_TIMEOUT_MS);

  it("reports a NON-ZERO count for every table it purged", () => {
    // Distinct claim from "zero rows remain", and the one that catches a DELETE
    // whose WHERE never matched: an unpurged table and a table purged of
    // nothing both leave zero rows behind for a workspace that was never
    // seeded. Since exactly one row per table was seeded, every reported count
    // must be >= 1 — a 0 here means the DELETE ran against the wrong column.
    const zeroCounts = Object.entries(result)
      .filter(([, n]) => n === 0)
      .map(([field]) => field);
    expect(
      zeroCounts,
      `Purge reported 0 rows for: ${zeroCounts.join(", ")}. Every purged table was seeded ` +
        `with exactly one row, so a 0 means that DELETE matched nothing — most likely the ` +
        `wrong scope column (org_id vs workspace_id vs reference_id).`,
    ).toEqual([]);
  });

  it("does not touch the neighbouring workspace (blast radius)", async () => {
    // The other half of correctness, and the half a purge cannot self-check: a
    // `DELETE FROM brain_facts` with the scope predicate dropped would satisfy
    // "zero rows remain" perfectly while destroying every other tenant.
    const damaged: string[] = [];
    for (const table of seeded.keys()) {
      if (PARENT_LINK[table]) continue; // counted table-wide; asserted below
      if (table === "admin_action_log") continue; // its scrub is asserted separately
      const remaining = await countFor(table, NEIGHBOUR);
      if (remaining !== 1) damaged.push(`${table} (${remaining}, expected 1)`);
    }
    expect(
      damaged,
      `The purge altered another workspace's rows in: ${damaged.join(", ")}.`,
    ).toEqual([]);
  }, PG_TIMEOUT_MS);

  it("removes the orphaned user's session, account and user-keyed rows", async () => {
    // C2/C1 from the review: none of these were seeded, so deleting any of their
    // DELETEs passed both suites. A `session` row outliving its own user row is
    // a live token for a deleted account.
    for (const table of ["session", "account"]) {
      const r = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "${table}" WHERE "userId" = $1`,
        [USER_ORPHAN],
      );
      expect(Number(r.rows[0].n), `${table} rows survived for the orphaned user`).toBe(0);
    }
    for (const table of ["user_onboarding", "email_preferences", "trusted_device"]) {
      const r = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "${table}" WHERE user_id = $1`,
        [USER_ORPHAN],
      );
      expect(Number(r.rows[0].n), `${table} rows survived for the orphaned user`).toBe(0);
    }
  });

  it("spares a user who still belongs to another workspace", async () => {
    // The other half, and the half that makes the test above able to fail for
    // the RIGHT reason: an unscoped `DELETE FROM session` would satisfy "the
    // orphan's rows are gone" perfectly while logging out every other tenant.
    const user = await pool.query(`SELECT 1 FROM "user" WHERE id = $1`, [USER_SHARED]);
    expect(user.rows.length, "a user with another membership must NOT be deleted").toBe(1);
    for (const [table, col] of [
      ["session", `"userId"`],
      ["account", `"userId"`],
      ["user_onboarding", "user_id"],
      ["email_preferences", "user_id"],
      ["trusted_device", "user_id"],
    ] as const) {
      const r = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "${table}" WHERE ${col} = $1`,
        [USER_SHARED],
      );
      expect(Number(r.rows[0].n), `${table} row for a still-active user was destroyed`).toBe(1);
    }
    // Their membership of the PURGED org is gone; their membership of the
    // neighbour survives.
    const members = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "member" WHERE "userId" = $1`,
      [USER_SHARED],
    );
    expect(Number(members.rows[0].n)).toBe(1);
  });

  it("keeps a NULL-org pending email (a session-less flow is not workspace data)", async () => {
    // Makes the registry's stated reasoning falsifiable: broadening the purge to
    // `WHERE org_id = $1 OR org_id IS NULL` would destroy a live password-reset
    // token mid-flow, and previously nothing noticed.
    const r = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM email_outbox WHERE org_id IS NULL`,
    );
    expect(Number(r.rows[0].n), "a NULL-org outbox row must survive a workspace purge").toBe(1);
  });

  it("does not re-count an already-scrubbed admin_action_log row", async () => {
    // The `anonymized_at IS NULL` predicate. Without it the count includes rows
    // a previous erasure scrubbed, and `adminActionLogAnonymized` stops meaning
    // "rows this purge scrubbed". Two rows exist for ORG; exactly one was
    // scrubbable, so the count must be 1 rather than 2.
    expect(result.adminActionLogAnonymized).toBe(1);
    const total = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM admin_action_log WHERE org_id = $1`,
      [ORG],
    );
    expect(Number(total.rows[0].n), "both rows must still be present").toBe(2);
  });

  it("reports no skipped tables when the region's schema is complete", () => {
    // `skippedTables` non-empty means a relation was absent and its DELETE never
    // ran. On a fully-migrated schema it must be empty, or the purge is quietly
    // reporting 0 rows for a table nobody looked at.
    expect(result.skippedTables).toEqual([]);
  });

  it("leaves exactly the neighbour's row in each parent-scoped child table", async () => {
    // The child tables have no scope column, so the previous test cannot see
    // them. Both workspaces got one row each; after the purge exactly one (the
    // neighbour's) must remain. This is the assertion that distinguishes
    // "purged the child" from "purged nothing and the parent hid it".
    const wrong: string[] = [];
    for (const table of Object.keys(PARENT_LINK)) {
      if (!seeded.has(table)) continue;
      const link = PARENT_LINK[table];
      const r = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM "${table}"`);
      const n = Number(r.rows[0].n);
      if (n !== 1) {
        wrong.push(`${table} (${n} row(s), expected exactly the neighbour's 1)`);
        continue;
      }
      // A count of 1 does NOT say WHOSE row it is — two rows in, one out is
      // identical whether the purge removed ORG's or the neighbour's. The
      // neighbour's parent survives the purge, so its id is the discriminator
      // that turns a count into an identity check.
      const survivor = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "${table}"
          WHERE "${link.column}" IN (
            SELECT "${link.parentKey}" FROM "${link.parent}" WHERE "${link.parentScope}" = $1
          )`,
        [NEIGHBOUR],
      );
      if (Number(survivor.rows[0].n) !== 1) {
        wrong.push(
          `${table} (1 row survived, but it is NOT the neighbour's — the purge deleted the wrong tenant's row)`,
        );
      }
    }
    expect(wrong, `Parent-scoped child table(s) with the wrong survivor: ${wrong.join(", ")}`).toEqual([]);
  }, PG_TIMEOUT_MS);

  it("ANONYMIZES admin_action_log rather than deleting it", async () => {
    // The row survives — it is the record of the purge — but the identifiers do
    // not. Asserted as four separate facts, because "the row is still there"
    // and "the row no longer identifies anyone" can fail independently.
    const r = await pool.query<{
      n: string;
      with_actor: string;
      with_ip: string;
      unstamped: string;
    }>(
      `SELECT count(*)::text AS n,
              count(actor_id)::text AS with_actor,
              count(ip_address)::text AS with_ip,
              count(*) FILTER (WHERE anonymized_at IS NULL)::text AS unstamped
         FROM admin_action_log WHERE org_id = $1`,
      [ORG],
    );
    const row = r.rows[0];
    expect(Number(row.n), "the admin_action_log row must SURVIVE the purge").toBeGreaterThan(0);
    expect(Number(row.with_actor), "actor_id/actor_email must be scrubbed").toBe(0);
    expect(Number(row.with_ip), "ip_address must be scrubbed").toBe(0);
    expect(Number(row.unstamped), "every scrubbed row must carry anonymized_at").toBe(0);
    expect(result.adminActionLogAnonymized).toBeGreaterThan(0);
    // And the neighbour's trail is untouched — the scrub is org-scoped.
    const n = await pool.query<{ with_actor: string }>(
      `SELECT count(actor_id)::text AS with_actor FROM admin_action_log WHERE org_id = $1`,
      [NEIGHBOUR],
    );
    expect(Number(n.rows[0].with_actor)).toBe(1);
  });

  it("RETAINS the tables whose deletion would cause a named harm", async () => {
    // stripe_teardown_pending rows ARE the retry that still has to cancel a
    // live subscription (#3679); stripe_purged_subscriptions is the tombstone
    // this very transaction writes (#3468). Both must survive.
    for (const table of RETAINED_TABLES) {
      if (table === "user_trial_grants") continue; // covered below, has its own semantics
      const r = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM "${table}"`);
      expect(Number(r.rows[0].n), `${table} is 'retained' but the purge emptied it`).toBeGreaterThan(0);
    }
    // stripe_teardown_pending was seeded for BOTH workspaces, so a purge that
    // deleted only the purged workspace's row would still leave the neighbour's
    // and satisfy the loop above. Pin the count: both must survive.
    const teardown = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM stripe_teardown_pending`,
    );
    expect(
      Number(teardown.rows[0].n),
      "both workspaces' pending teardown ops must survive — these ARE the retry " +
        "that still has to cancel a live subscription (#3679)",
    ).toBe(2);
    // And the tombstone the purge itself writes (#3468): its presence is what
    // stops post-commit cancellation webhooks regrowing stripe_webhook_events.
    const tombstone = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM stripe_purged_subscriptions
        WHERE stripe_subscription_id = 'sub_purge-seed-' || $1`,
      [ORG],
    );
    expect(
      Number(tombstone.rows[0].n),
      "the purge must tombstone the subscription ids it removed (#3468)",
    ).toBe(1);
  });

  it("keeps the anti-abuse trial grant of a user who survives the purge", async () => {
    // The claim: `user_trial_grants` is `retained`, so the purge must not delete
    // it by ORG — otherwise a purged workspace's owner claims a fresh trial on
    // demand and the purge becomes an abuse primitive.
    //
    // Both seeded grants carry `org_id = ORG` (the purged workspace), which is
    // what makes this able to fail: adding `DELETE FROM user_trial_grants WHERE
    // org_id = $1` takes BOTH rows. The previous version asserted only on a
    // NEIGHBOUR-scoped grant that no plausible mutation could reach, so it
    // passed against exactly the mutation it was written to catch.
    const shared = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM user_trial_grants WHERE user_id = $1`,
      [USER_SHARED],
    );
    expect(
      Number(shared.rows[0].n),
      "a surviving user's trial grant must outlive the purge of the org it was granted in",
    ).toBe(1);
  });

  it("removes the trial grant of a user the purge deleted (the FK cascade fires)", async () => {
    // The other half, and the reason the grant is `user_scoped`-shaped rather
    // than simply immortal: when the USER is genuinely erased, the
    // migration-level `"user"(id) ON DELETE CASCADE` takes the grant with them.
    //
    // This is only a real assertion because the seed now points `user_id` at a
    // REAL user. The generic pass synthesized a phantom id, so the cascade could
    // never fire and the row survived for the wrong reason — the row was there,
    // the test was green, and neither fact was connected to the other.
    const orphan = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM user_trial_grants WHERE user_id = $1`,
      [USER_ORPHAN],
    );
    expect(
      Number(orphan.rows[0].n),
      "the deleted user's trial grant must cascade away with their user row",
    ).toBe(0);
  });

  it("removes the organization row and the orphaned user", async () => {
    const org = await pool.query(`SELECT 1 FROM "organization" WHERE id = $1`, [ORG]);
    expect(org.rows.length).toBe(0);
    const user = await pool.query(`SELECT 1 FROM "user" WHERE id = $1`, [USER_ORPHAN]);
    expect(user.rows.length).toBe(0);
    expect(result.organization).toBe(1);
    expect(result.orphanedUsers).toBe(1);
  });
});
