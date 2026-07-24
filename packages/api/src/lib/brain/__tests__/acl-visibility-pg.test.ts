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
 *   - Cross-tenant audience collision. Audience ids are workspace-scoped and
 *     not globally unique; two tenants minting `engineering` is normal.
 *   - That the predicate stays INDEXABLE against the GIN index the migration
 *     created for it. A rewrite to `EXISTS (SELECT … unnest(visible_to))`
 *     would pass every row-level assertion and quietly become a seq scan.
 *
 * Opt in locally with:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5433/atlas_dev
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
const OTHER_WS = "ws-acl-pg-other";

function ctx(partial: Partial<BrainPrincipalContext> = {}): BrainPrincipalContext {
  return {
    workspaceId: WS,
    userId: "user-1",
    role: "member",
    audienceIds: [],
    origin: "authenticated",
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
      `SELECT ${label} AS label FROM ${table} t WHERE ${clause.sql} ORDER BY 1`,
      [...clause.params],
    );
    return rows.map((r) => r.label);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        console.error(
          `acl-visibility-pg: SET search_path failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
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
      // The parity matrix. Every grant here is legal at rest under
      // `chk_brain_facts_grant_nonempty` — including the ones that grant
      // nobody anything, which is the half a stricter parser would have made
      // unrepresentable and therefore untested.
      const grants: ReadonlyArray<{ subject: string; visibleTo: (string | null)[] }> = [
        { subject: "org-wide", visibleTo: ["org"] },
        { subject: "members", visibleTo: ["role:member"] },
        { subject: "admins", visibleTo: ["role:admin"] },
        { subject: "owners", visibleTo: ["role:owner"] },
        { subject: "u1-only", visibleTo: ["user:user-1"] },
        { subject: "u2-only", visibleTo: ["user:user-2"] },
        { subject: "aud-eng", visibleTo: ["audience:eng"] },
        { subject: "aud-exec", visibleTo: ["audience:exec"] },
        { subject: "mixed", visibleTo: ["user:user-2", "audience:eng"] },
        // Malformed-but-legal: `everyone` reads as public and grants nobody.
        { subject: "malformed", visibleTo: ["everyone"] },
        // A valid token beside a malformed one — passes on the valid half only.
        { subject: "half-malformed", visibleTo: ["everyone", "user:user-1"] },
        // NULL / '' elements alongside one usable principal. The CHECK admits
        // this; `ARRAY[''] && ARRAY['']` is TRUE, so an empty reader token
        // would match here. `principalTokens` never emits one.
        { subject: "padded", visibleTo: ["org", null, ""] },
        { subject: "empty-only-plus-user", visibleTo: ["", "user:user-2"] },
        // Case variants must NOT match — enforcement is byte-exact.
        { subject: "shouty", visibleTo: ["ORG"] },
      ];

      const episode = await seedEpisode(WS, "parity", ["org"]);
      for (const g of grants) {
        await seedFact({
          workspaceId: WS,
          episodeId: episode,
          subject: g.subject,
          visibleTo: g.visibleTo,
        });
      }

      const readers: ReadonlyArray<{ name: string; ctx: BrainPrincipalContext }> = [
        { name: "member/no-audience", ctx: ctx({ role: "member" }) },
        { name: "admin", ctx: ctx({ role: "admin" }) },
        { name: "owner", ctx: ctx({ role: "owner" }) },
        { name: "member in eng", ctx: ctx({ role: "member", audienceIds: ["eng"] }) },
        { name: "other user", ctx: ctx({ role: "member", userId: "user-9" }) },
        { name: "auth:none local", ctx: ctx({ role: null, userId: null, origin: "unauthenticated-local" }) },
      ];

      for (const reader of readers) {
        const fromSql = await selectVisible(reader.ctx, "brain_facts");
        const fromMirror = grants
          .filter((g) => isVisibleTo(g.visibleTo, reader.ctx))
          .map((g) => g.subject)
          .toSorted();
        expect({ reader: reader.name, rows: fromSql }).toEqual({
          reader: reader.name,
          rows: fromMirror,
        });
      }

      // Spot-check the absolute claims the matrix is supposed to encode, so a
      // mirror that broke in the SAME way as the SQL still fails here.
      expect(await selectVisible(ctx({ role: "member" }), "brain_facts")).toEqual([
        "half-malformed",
        "members",
        "org-wide",
        "padded",
        "u1-only",
      ]);
      expect(await selectVisible(ctx({ role: "owner" }), "brain_facts")).toContain("admins");
      expect(await selectVisible(ctx({ role: "member" }), "brain_facts")).not.toContain(
        "malformed",
      );
      expect(await selectVisible(ctx({ role: "member" }), "brain_facts")).not.toContain("shouty");
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "gates tier-3 episodes on the same grammar — raw source is often more sensitive than the facts",
    async () => {
      await seedEpisode(OTHER_WS, "ep-org", ["org"]);
      await seedEpisode(OTHER_WS, "ep-exec", ["audience:exec"]);
      await seedEpisode(OTHER_WS, "ep-u2", ["user:user-2"]);

      const reader = ctx({ workspaceId: OTHER_WS, role: "member" });
      expect(await selectVisible(reader, "brain_episodes")).toEqual(["ep-org"]);
      expect(
        await selectVisible(
          ctx({ workspaceId: OTHER_WS, role: "member", audienceIds: ["exec"] }),
          "brain_episodes",
        ),
      ).toEqual(["ep-exec", "ep-org"]);
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
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "keeps grants immutable per fact version — widening the current one does not widen a superseded one",
    async () => {
      // ADR-0036: a read of "what we believed Monday" evaluates MONDAY's grant
      // against as-of-now membership. That is why the grant is a column on the
      // fact and not a join to a policy table — a policy table would
      // retroactively rewrite who could see history.
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
        subject: "v2-wide",
        visibleTo: ["org"],
      });
      await pool.query(
        `INSERT INTO brain_edges (workspace_id, edge_type, from_fact_id, to_fact_id)
         VALUES ($1, 'supersedes', $2, $3)`,
        [wsV, v2, v1],
      );

      // A plain member sees only the widened CURRENT version. The superseded
      // one keeps its own narrower grant — supersession is not deletion, and
      // it is not declassification either.
      const member = ctx({ workspaceId: wsV, role: "member" });
      expect(await selectVisible(member, "brain_facts")).toEqual(["v2-wide"]);

      // And the exec still sees both, as-of-now membership against each
      // version's own frozen grant.
      const exec = ctx({ workspaceId: wsV, role: "member", audienceIds: ["exec"] });
      expect(await selectVisible(exec, "brain_facts")).toEqual(["v1-narrow", "v2-wide"]);
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

      const before = await resolvePrincipalContext(pool, {
        workspaceId: wsR,
        mode: "managed",
        userId: "user-1",
        role: "member",
      });
      expect(before.audienceIds).toEqual(["exec"]);
      expect(await selectVisible(before, "brain_facts")).toEqual(["exec-only"]);

      await pool.query(
        `DELETE FROM fact_audience_member WHERE workspace_id = $1 AND user_id = 'user-1'`,
        [wsR],
      );
      const after = await resolvePrincipalContext(pool, {
        workspaceId: wsR,
        mode: "managed",
        userId: "user-1",
        role: "member",
      });
      // The fact's `visible_to` never changed. Only membership did.
      expect(await selectVisible(after, "brain_facts")).toEqual([]);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "composes as one of four AND-ed gates — failing any one hides the row",
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
      const { rows } = await pool.query<{ subject: string }>(
        `SELECT f.subject
           FROM brain_facts f
          WHERE f.workspace_id = $1
            AND f.status = 'published'
            AND ${clause.sql}
          ORDER BY 1`,
        [wsC, ...clause.params],
      );
      expect(rows.map((r) => r.subject)).toEqual(["all-gates-pass"]);

      // And each gate is load-bearing on its own: drop the ACL clause and the
      // grant-gated row reappears, which is what makes this a real AND rather
      // than three clauses one of which happens to be redundant.
      const withoutAcl = await pool.query<{ subject: string }>(
        `SELECT f.subject FROM brain_facts f
          WHERE f.workspace_id = $1 AND f.status = 'published' ORDER BY 1`,
        [wsC],
      );
      expect(withoutAcl.rows.map((r) => r.subject)).toEqual(["all-gates-pass", "fails-grant"]);
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
    "keeps the grant match a pushed-down array-overlap the planner can serve from an index",
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
      // as a filter — that is correct, and asserting an index NAME here would
      // be asserting a cost estimate over a handful of test rows.
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
        // Set search_path explicitly rather than leaning on the pool's
        // `connect` handler: that handler fires its SET without being awaited,
        // so on a freshly-checked-out client it can still be in flight here —
        // and an EXPLAIN that resolved against `public` would report on tables
        // this test never created.
        await client.query(`SET LOCAL search_path TO "${schemaName}"`);
        await client.query("SET LOCAL enable_seqscan = off");
        const { rows } = await client.query<{ "QUERY PLAN": string }>(
          `EXPLAIN SELECT t.id FROM brain_facts t WHERE ${clause.sql}`,
          [...clause.params],
        );
        const plan = rows.map((r) => r["QUERY PLAN"]).join("\n");
        // The overlap survives into the plan verbatim, as a scan-level
        // condition on the column.
        expect(plan).toMatch(/visible_to && /);
        // …and never as a subquery or a set-returning function, which is what
        // every non-pushed-down rewrite of this predicate looks like.
        expect(plan).not.toContain("SubPlan");
        expect(plan).not.toContain("unnest");
        expect(plan).not.toContain("Seq Scan");

        // The GIN index IS reachable for the grant half on its own — proven by
        // asking for exactly that half, which is the query shape #4773 issues
        // once a workspace has more than a handful of facts.
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
