/**
 * Real-Postgres coverage for the brain ACL's push-down visibility predicate
 * (#4768, ADR-0036 §Access control).
 *
 * `acl.test.ts` pins the DECISIONS — which branch fires, what SQL text comes
 * out. This file pins what that SQL actually SELECTS, which is a different
 * claim and the one that matters: a predicate can be textually perfect and
 * still return the wrong rows because `&&` does not mean what the author
 * assumed about NULL elements, or because a grant token collides across
 * tenants, or because `visible_to` was compared with `@>` instead.
 *
 * What only real Postgres can catch here:
 *   - `isVisibleTo` / `&&` PARITY. The in-memory mirror is what the review
 *     surface and every other test reasons with; if it and the SQL disagree
 *     about one token shape, every downstream assertion is testing a fiction.
 *   - NULL and `''` elements inside a stored grant. Migration 0180's CHECK
 *     tolerates them (it requires one USABLE principal, not that all are), so
 *     they reach the predicate — and `ARRAY[''] && ARRAY['']` is TRUE.
 *   - Cross-tenant audience collision, in both directions: a colliding grant
 *     (the predicate's job) and a colliding MEMBERSHIP row (the audience
 *     lookup's job — the one leak workspace containment cannot catch, because
 *     the stolen token gets applied inside the reader's own tenant).
 *   - That the grant match stays a pushed-down array overlap rather than a
 *     per-row subplan.
 *
 * Opt in locally with:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS } from "@atlas/api/lib/db/internal";
import {
  aclVisibilityClause,
  isVisibleTo,
  resolvePrincipalContext,
  type AclGatedTable,
  type BrainPrincipalContext,
} from "@atlas/api/lib/brain/acl";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

const WS = "ws-acl-pg";
const EPISODE_WS = "ws-acl-pg-episodes";

type AuthedContext = Extract<BrainPrincipalContext, { origin: "authenticated" }>;

function ctx(partial: Partial<AuthedContext> = {}): BrainPrincipalContext {
  return {
    origin: "authenticated",
    workspaceId: WS,
    userId: "user-1",
    role: "member",
    audienceIds: [],
    ...partial,
  };
}

describeIfPg("brain ACL visibility predicate (real Postgres)", () => {
  let pool: Pool;
  const schemaName = `brain_acl_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  /** Insert an episode and return its id. Facts FK onto `(workspace_id, id)`. */
  async function seedEpisode(
    workspaceId: string,
    sourceId: string,
    visibleTo: readonly (string | null)[],
  ): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_episodes (workspace_id, source, source_id, body, visible_to)
       VALUES ($1, 'test', $2, 'evidence', $3::text[])
       RETURNING id`,
      [workspaceId, sourceId, visibleTo],
    );
    return rows[0]!.id;
  }

  /** Insert a fact hanging off `episodeId`. Returns its id. */
  async function seedFact(opts: {
    workspaceId: string;
    episodeId: string;
    subject: string;
    visibleTo: readonly (string | null)[];
    status?: "draft" | "published" | "archived";
  }): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_facts
         (workspace_id, subject, predicate, object, source_episode_id, provenance, status, visible_to)
       VALUES ($1, $2, 'is', 'thing', $3, '{"actor":"test"}'::jsonb, $4, $5::text[])
       RETURNING id`,
      [opts.workspaceId, opts.subject, opts.episodeId, opts.status ?? "published", opts.visibleTo],
    );
    return rows[0]!.id;
  }

  /**
   * Run the predicate standalone over one table and return the matching
   * subjects (facts) or source ids (episodes), sorted.
   */
  async function selectVisible(
    reader: BrainPrincipalContext,
    table: AclGatedTable,
    override?: { reason: string },
  ): Promise<string[]> {
    const clause = aclVisibilityClause(reader, { table, alias: "t", paramIndex: 1, override });
    const label = table === "brain_facts" ? "subject" : "source_id";
    const { rows } = await pool.query<{ label: string }>(
      // `COLLATE "C"` so the DB's sort matches the JS `toSorted()` / hardcoded
      // arrays these results are compared against. The labels are hyphenated,
      // which is exactly where glibc's punctuation-ignoring collation diverges
      // from byte order. It names the column rather than the `1` ordinal —
      // `COLLATE` on an ordinal is a 42804.
      `SELECT ${label} AS label FROM ${table} t WHERE ${clause.sql} ORDER BY t.${label} COLLATE "C"`,
      [...clause.params],
    );
    return rows.map((r) => r.label);
  }

  /**
   * The parity matrix, shared by both gated tables. Every grant is legal at
   * rest under `chk_brain_*_grant_nonempty` — including the ones that grant
   * nobody anything, which is the half a stricter parser would have made
   * unrepresentable and therefore untested.
   */
  const GRANTS: ReadonlyArray<{ label: string; visibleTo: (string | null)[] }> = [
    { label: "org-wide", visibleTo: ["org"] },
    { label: "members", visibleTo: ["role:member"] },
    { label: "admins", visibleTo: ["role:admin"] },
    { label: "owners", visibleTo: ["role:owner"] },
    { label: "u1-only", visibleTo: ["user:user-1"] },
    { label: "u2-only", visibleTo: ["user:user-2"] },
    { label: "aud-eng", visibleTo: ["audience:eng"] },
    { label: "aud-exec", visibleTo: ["audience:exec"] },
    { label: "mixed", visibleTo: ["user:user-2", "audience:eng"] },
    // Malformed-but-legal: `everyone` reads as public and grants nobody.
    { label: "malformed", visibleTo: ["everyone"] },
    // A valid token beside a malformed one — passes on the valid half only.
    { label: "half-malformed", visibleTo: ["everyone", "user:user-1"] },
    // NULL / '' elements alongside one usable principal. The CHECK admits
    // this; `ARRAY[''] && ARRAY['']` is TRUE, so an empty reader token would
    // match here. `principalTokens` never emits one.
    { label: "padded", visibleTo: ["org", null, ""] },
    { label: "empty-only-plus-user", visibleTo: ["", "user:user-2"] },
    // A bare prefix is itself malformed and legal at rest — an unguarded
    // reader arm emitting `user:` would raw-match this.
    { label: "bare-prefix", visibleTo: ["user:", "audience:"] },
    // Case variants must NOT match — enforcement is byte-exact.
    { label: "shouty", visibleTo: ["ORG"] },
  ];

  function readersFor(workspaceId: string): ReadonlyArray<{
    name: string;
    ctx: BrainPrincipalContext;
    /** Absolute expectation — what this reader must see, independent of the mirror. */
    expected: string[];
  }> {
    const base = { workspaceId, userId: "user-1" } as const;
    return [
      {
        name: "member/no-audience",
        ctx: { ...base, origin: "authenticated", role: "member", audienceIds: [] },
        expected: ["half-malformed", "members", "org-wide", "padded", "u1-only"],
      },
      {
        name: "admin",
        ctx: { ...base, origin: "authenticated", role: "admin", audienceIds: [] },
        expected: ["admins", "half-malformed", "members", "org-wide", "padded", "u1-only"],
      },
      {
        name: "owner",
        ctx: { ...base, origin: "authenticated", role: "owner", audienceIds: [] },
        expected: [
          "admins",
          "half-malformed",
          "members",
          "org-wide",
          "owners",
          "padded",
          "u1-only",
        ],
      },
      {
        name: "member in eng",
        ctx: { ...base, origin: "authenticated", role: "member", audienceIds: ["eng"] },
        expected: [
          "aud-eng",
          "half-malformed",
          "members",
          "mixed",
          "org-wide",
          "padded",
          "u1-only",
        ],
      },
      {
        name: "other user",
        ctx: { ...base, origin: "authenticated", userId: "user-9", role: "member", audienceIds: [] },
        expected: ["members", "org-wide", "padded"],
      },
      {
        name: "auth:none local",
        ctx: {
          origin: "unauthenticated-local",
          workspaceId,
          userId: null,
          role: null,
          audienceIds: [],
        },
        expected: ["org-wide", "padded"],
      },
      {
        name: "unresolved",
        // The deny arm, composed into a REAL query rather than only asserted
        // in memory — the clause's own doc warns that arity mismatches "fail
        // at execution, which is late".
        ctx: { origin: "unresolved", workspaceId, userId: null, role: null, audienceIds: [] },
        expected: [],
      },
    ];
  }

  beforeAll(async () => {
    // `search_path` is baked into the connection string rather than SET from an
    // unawaited `pool.on("connect")` handler: server-side at startup, so there
    // is no window in which a checked-out client is still pointed at `public`,
    // and no failure path that logs and then silently runs the whole migration
    // set against the developer's real database. Same pattern as
    // `api/__tests__/admin-last-admin-pg.test.ts`.
    pool = new Pool({
      connectionString: TEST_DB_URL,
      options: `-c search_path="${schemaName}",public`,
    });
    // The schema must exist before any pooled client sets search_path to it,
    // so this one connection opts out via an explicit fresh pool.
    const bootstrap = new Pool({ connectionString: TEST_DB_URL });
    try {
      await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    } finally {
      await bootstrap.end();
    }
    await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });
  }, PG_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await pool.end();
  });

  it(
    "selects exactly the rows `isVisibleTo` predicts, for every grant × reader pair",
    async () => {
      const episode = await seedEpisode(WS, "parity", ["org"]);
      for (const g of GRANTS) {
        await seedFact({
          workspaceId: WS,
          episodeId: episode,
          subject: g.label,
          visibleTo: g.visibleTo,
        });
      }

      for (const reader of readersFor(WS)) {
        const fromSql = await selectVisible(reader.ctx, "brain_facts");
        const fromMirror = GRANTS.filter((g) =>
          isVisibleTo({ table: "brain_facts", workspaceId: WS, visibleTo: g.visibleTo }, reader.ctx),
        )
          .map((g) => g.label)
          .toSorted();

        // Parity — but parity alone is circular (both sides derive tokens from
        // `principalTokens`), so every reader also carries an ABSOLUTE
        // expectation. A token-derivation bug moves both sides together and is
        // caught only by the second assertion.
        expect({ reader: reader.name, rows: fromSql }).toEqual({
          reader: reader.name,
          rows: fromMirror,
        });
        expect({ reader: reader.name, rows: fromSql }).toEqual({
          reader: reader.name,
          rows: reader.expected,
        });
      }
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "gates tier-3 episodes on the same grammar — raw source is often more sensitive than the facts",
    async () => {
      // The migration itself notes episodes are "frequently MORE sensitive
      // than the facts extracted from it", so the full matrix runs over both
      // tables rather than giving tier-3 a three-row happy path.
      for (const g of GRANTS) {
        await seedEpisode(EPISODE_WS, g.label, g.visibleTo);
      }
      for (const reader of readersFor(EPISODE_WS)) {
        expect({ reader: reader.name, rows: await selectVisible(reader.ctx, "brain_episodes") }).toEqual(
          { reader: reader.name, rows: reader.expected },
        );
      }
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "never matches another tenant's grant, even on an identically-named audience",
    async () => {
      // Audience ids are workspace-scoped identities with no global
      // uniqueness. Two tenants both minting `engineering` is normal, and it
      // is precisely why the predicate carries its own workspace containment
      // rather than trusting the caller's.
      const wsA = `${WS}-tenant-a`;
      const wsB = `${WS}-tenant-b`;
      const epA = await seedEpisode(wsA, "collide-a", ["org"]);
      const epB = await seedEpisode(wsB, "collide-b", ["org"]);
      await seedFact({
        workspaceId: wsA,
        episodeId: epA,
        subject: "a-secret",
        visibleTo: ["audience:engineering"],
      });
      await seedFact({
        workspaceId: wsB,
        episodeId: epB,
        subject: "b-secret",
        visibleTo: ["audience:engineering"],
      });

      const readerInA = ctx({ workspaceId: wsA, audienceIds: ["engineering"] });
      expect(await selectVisible(readerInA, "brain_facts")).toEqual(["a-secret"]);
      // The in-memory mirror must agree — an earlier cut took a bare grant and
      // answered TRUE here.
      expect(
        isVisibleTo(
          { table: "brain_facts", workspaceId: wsB, visibleTo: ["audience:engineering"] },
          readerInA,
        ),
      ).toBe(false);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "scopes the audience-membership lookup to the workspace — the one leak containment cannot catch",
    async () => {
      // If this query ever returned another workspace's memberships, the
      // reader would acquire `audience:finance` and immediately read their OWN
      // tenant's `audience:finance` facts. The predicate's workspace
      // containment is powerless there: the stolen token is applied inside the
      // right tenant. This is the module's only cross-tenant-sensitive read.
      const home = `${WS}-membership-home`;
      const foreign = `${WS}-membership-foreign`;
      await pool.query(
        `INSERT INTO fact_audience_member (workspace_id, audience_id, user_id, source)
         VALUES ($1, 'exec', 'user-1', 'test'),
                ($2, 'finance', 'user-1', 'test')`,
        [home, foreign],
      );

      const resolved = await resolvePrincipalContext(pool, {
        workspaceId: home,
        mode: "managed",
        userId: "user-1",
        resolvedRole: { role: "member", orgId: home },
      });
      expect(resolved.audienceIds).toEqual(["exec"]);

      const episode = await seedEpisode(home, "membership-scope", ["org"]);
      await seedFact({
        workspaceId: home,
        episodeId: episode,
        subject: "home-finance",
        visibleTo: ["audience:finance"],
      });
      // The foreign membership must not unlock the home tenant's like-named
      // audience.
      expect(await selectVisible(resolved, "brain_facts")).toEqual([]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "keeps grants immutable per fact version — widening the current one does not widen a superseded one",
    async () => {
      // ADR-0036 §Access control: a read of "what we believed Monday"
      // evaluates MONDAY's grant against as-of-now membership. Migration
      // 0180's own rationale supplies the schema half — the grant is a COLUMN
      // on the fact rather than a join to a policy table, because a policy
      // table would retroactively rewrite who could see history.
      const wsV = `${WS}-versions`;
      const episode = await seedEpisode(wsV, "versioned", ["org"]);
      const v1 = await seedFact({
        workspaceId: wsV,
        episodeId: episode,
        subject: "v1-narrow",
        visibleTo: ["audience:exec"],
      });
      const v2 = await seedFact({
        workspaceId: wsV,
        episodeId: episode,
        subject: "v2-superseding",
        visibleTo: ["audience:exec"],
      });
      await pool.query(
        `INSERT INTO brain_edges (workspace_id, edge_type, from_fact_id, to_fact_id)
         VALUES ($1, 'supersedes', $2, $3)`,
        [wsV, v2, v1],
      );

      const member = ctx({ workspaceId: wsV, role: "member" });
      const exec = ctx({ workspaceId: wsV, role: "member", audienceIds: ["exec"] });
      // Both versions start narrow.
      expect(await selectVisible(member, "brain_facts")).toEqual([]);
      expect(await selectVisible(exec, "brain_facts")).toEqual(["v1-narrow", "v2-superseding"]);

      // Now WIDEN the current version — the actual mutation the criterion is
      // about. Without it the test is just "two rows filter independently",
      // which is trivially true of any per-row column and would pass against
      // an implementation that DID have the retroactive-rewrite property.
      await pool.query(
        `UPDATE brain_facts SET visible_to = ARRAY['org']::text[] WHERE id = $1`,
        [v2],
      );

      // The superseded version keeps its own frozen grant. Supersession is not
      // deletion, and widening the successor is not declassification.
      expect(await selectVisible(member, "brain_facts")).toEqual(["v2-superseding"]);
      expect(await selectVisible(exec, "brain_facts")).toEqual(["v1-narrow", "v2-superseding"]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "revokes live through audience membership without touching the stored grant",
    async () => {
      // The accepted cost of derive-at-ingest grants is that source membership
      // changes don't propagate to already-ingested facts. `fact_audience_member`
      // is the escape hatch — and it must be a LOCAL set-membership read, with
      // no connector call at read time.
      const wsR = `${WS}-revoke`;
      const episode = await seedEpisode(wsR, "revoke", ["org"]);
      await seedFact({
        workspaceId: wsR,
        episodeId: episode,
        subject: "exec-only",
        visibleTo: ["audience:exec"],
      });
      await pool.query(
        `INSERT INTO fact_audience_member (workspace_id, audience_id, user_id, source)
         VALUES ($1, 'exec', 'user-1', 'test')`,
        [wsR],
      );

      const input = {
        workspaceId: wsR,
        mode: "managed",
        userId: "user-1",
        resolvedRole: { role: "member", orgId: wsR },
      } as const;
      const before = await resolvePrincipalContext(pool, input);
      expect(before.audienceIds).toEqual(["exec"]);
      expect(await selectVisible(before, "brain_facts")).toEqual(["exec-only"]);

      await pool.query(
        `DELETE FROM fact_audience_member WHERE workspace_id = $1 AND user_id = 'user-1'`,
        [wsR],
      );
      const after = await resolvePrincipalContext(pool, input);
      // The fact's `visible_to` never changed. Only membership did.
      expect(await selectVisible(after, "brain_facts")).toEqual([]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "composes as one of four AND-ed gates — each is independently load-bearing",
    async () => {
      // ADR-0036: residency-invariant (by construction — the process IS the
      // region) AND org/group reach AND content mode AND the grant. The status
      // clause is written literally here because `brain_facts` joins the
      // content-mode registry in #4769; when it does, this becomes
      // `resolveStatusClause("brain_facts", mode, "f")` and must keep meaning
      // exactly this.
      const wsC = `${WS}-compose`;
      const otherC = `${WS}-compose-other`;
      const epC = await seedEpisode(wsC, "compose", ["org"]);
      const epOther = await seedEpisode(otherC, "compose-other", ["org"]);

      await seedFact({ workspaceId: wsC, episodeId: epC, subject: "all-gates-pass", visibleTo: ["org"] });
      await seedFact({ workspaceId: wsC, episodeId: epC, subject: "fails-mode", visibleTo: ["org"], status: "draft" });
      await seedFact({ workspaceId: wsC, episodeId: epC, subject: "fails-grant", visibleTo: ["audience:exec"] });
      await seedFact({ workspaceId: otherC, episodeId: epOther, subject: "fails-reach", visibleTo: ["org"] });

      const reader = ctx({ workspaceId: wsC, role: "member" });
      // The caller's own reach param is $1; the ACL clause starts after it.
      const clause = aclVisibilityClause(reader, {
        table: "brain_facts",
        alias: "f",
        paramIndex: 2,
      });
      const composed = await pool.query<{ subject: string }>(
        `SELECT f.subject
           FROM brain_facts f
          WHERE f.workspace_id = $1
            AND f.status = 'published'
            AND ${clause.sql}
          ORDER BY f.subject COLLATE "C"`,
        [wsC, ...clause.params],
      );
      expect(composed.rows.map((r) => r.subject)).toEqual(["all-gates-pass"]);

      // Drop-one controls. The ACL and content-mode gates are each
      // independently load-bearing: remove either and a row the composed query
      // excluded comes back. The third clause — the caller's own
      // `workspace_id = $1` reach stand-in — is REDUNDANT with the ACL
      // clause's own containment, so dropping it changes nothing; the control
      // below asserts that redundancy rather than a filter, which is the whole
      // point of the predicate being safe standalone.
      //
      // ADR-0022 reach is connection-group scoped, not workspace scoped, so
      // the real fourth gate lands with #4773's `resolveReachableGroups`;
      // residency is invariant by construction and has no clause at all.
      const withoutAcl = await pool.query<{ subject: string }>(
        `SELECT f.subject FROM brain_facts f
          WHERE f.workspace_id = $1 AND f.status = 'published' ORDER BY f.subject COLLATE "C"`,
        [wsC],
      );
      expect(withoutAcl.rows.map((r) => r.subject)).toEqual(["all-gates-pass", "fails-grant"]);

      const withoutMode = await pool.query<{ subject: string }>(
        `SELECT f.subject FROM brain_facts f WHERE f.workspace_id = $1 AND ${clause.sql} ORDER BY f.subject COLLATE "C"`,
        [wsC, ...clause.params],
      );
      expect(withoutMode.rows.map((r) => r.subject)).toEqual(["all-gates-pass", "fails-mode"]);

      const soloClause = aclVisibilityClause(reader, {
        table: "brain_facts",
        alias: "f",
        paramIndex: 1,
      });
      const withoutReach = await pool.query<{ subject: string }>(
        `SELECT f.subject FROM brain_facts f WHERE f.status = 'published' AND ${soloClause.sql} ORDER BY f.subject COLLATE "C"`,
        [...soloClause.params],
      );
      expect(withoutReach.rows.map((r) => r.subject)).toEqual(["all-gates-pass"]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "audit override returns the whole workspace and nothing outside it",
    async () => {
      const wsO = `${WS}-override`;
      const outside = `${WS}-override-outside`;
      const epO = await seedEpisode(wsO, "ovr", ["org"]);
      const epOut = await seedEpisode(outside, "ovr-out", ["org"]);
      await seedFact({ workspaceId: wsO, episodeId: epO, subject: "o-public", visibleTo: ["org"] });
      await seedFact({ workspaceId: wsO, episodeId: epO, subject: "o-secret", visibleTo: ["audience:exec"] });
      await seedFact({ workspaceId: outside, episodeId: epOut, subject: "not-mine", visibleTo: ["org"] });

      const admin = ctx({ workspaceId: wsO, role: "admin" });
      expect(await selectVisible(admin, "brain_facts")).toEqual(["o-public"]);
      expect(await selectVisible(admin, "brain_facts", { reason: "audit" })).toEqual([
        "o-public",
        "o-secret",
      ]);

      // Region scoping is by construction (the process IS the region, ADR-0024)
      // — but workspace scoping is not, and the override must still respect it.
      const member = ctx({ workspaceId: wsO, role: "member" });
      expect(await selectVisible(member, "brain_facts", { reason: "nope" })).toEqual(["o-public"]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "keeps the grant match a pushed-down array overlap the planner can serve from an index",
    async () => {
      // The whole point of push-down is that the grant match happens IN the
      // scan. A rewrite to `EXISTS (SELECT 1 FROM unnest(t.visible_to) …)`
      // would pass every row-level assertion above and silently turn the ACL
      // into a per-row subplan on a table that grows without bound.
      //
      // What is asserted is the SHAPE, not which index the planner picks.
      // `idx_brain_facts_visible_to` (GIN) only wins when the grant is the
      // selective half; on a query that also pins `workspace_id` the planner
      // will usually lead with a btree on workspace_id and apply the overlap
      // as a filter — that is correct, and asserting an index NAME on the real
      // shape would be asserting a cost estimate over a handful of test rows.
      const clause = aclVisibilityClause(ctx(), {
        table: "brain_facts",
        alias: "t",
        paramIndex: 1,
      });
      const client = await pool.connect();
      try {
        // `SET LOCAL` outside a transaction is a no-op that only warns, so the
        // BEGIN is load-bearing, not tidiness.
        await client.query("BEGIN");
        await client.query("SET LOCAL enable_seqscan = off");
        const { rows } = await client.query<{ "QUERY PLAN": string }>(
          `EXPLAIN SELECT t.id FROM brain_facts t WHERE ${clause.sql}`,
          [...clause.params],
        );
        const plan = rows.map((r) => r["QUERY PLAN"]).join("\n");
        // The overlap survives into the plan verbatim, as a scan-level
        // condition on the column…
        expect(plan).toMatch(/visible_to && /);
        // …and never as a subquery or a set-returning function, which is what
        // every non-pushed-down rewrite of this predicate looks like.
        expect(plan).not.toContain("SubPlan");
        expect(plan).not.toContain("unnest");
        expect(plan).not.toContain("Seq Scan");

        // Separately: the migration's GIN index really is usable for `&&`.
        // This bare-overlap query is a TEST-ONLY probe — `aclVisibilityClause`
        // always carries workspace containment, so #4773 never issues this
        // shape. Under `enable_seqscan = off` it proves only that the index
        // and this predicate's operator agree, which is the durable claim.
        const ginPlan = await client.query<{ "QUERY PLAN": string }>(
          `EXPLAIN SELECT t.id FROM brain_facts t WHERE t.visible_to && $1::text[]`,
          [clause.params[1]],
        );
        expect(ginPlan.rows.map((r) => r["QUERY PLAN"]).join("\n")).toContain(
          "idx_brain_facts_visible_to",
        );
      } finally {
        await client.query("ROLLBACK").catch((err) => {
          console.error(
            `acl-visibility-pg: ROLLBACK failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
        client.release();
      }
    },
    PG_TEST_TIMEOUT_MS,
  );
});
