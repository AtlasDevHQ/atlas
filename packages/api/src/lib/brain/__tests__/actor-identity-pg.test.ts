/**
 * A human NAME on every authoritative claim, against a real Postgres (#5440,
 * ADR-0036 §T5's `Amendment (2026-08-25, #5440)`).
 *
 * ## Why these claims need a database
 *
 * **(a) `atlas` resolves LIVE.** The acceptance criterion is *"renaming the user
 * changes what the surface shows, with no re-ingest and no backfill"*. That is a
 * statement about a JOIN, and a double scripted to return the new name after a
 * rename asserts its own script — #5000's trap. Here the test UPDATEs `"user"`
 * and re-reads through the same statement the server runs.
 *
 * **(b) The three states are distinguishable AT REST.** The CHECKs are the
 * enforcement, and a CHECK cannot be tested anywhere but Postgres: the claim is
 * that a half-written row is UNWRITABLE, not that nothing writes one.
 *
 * **(c) Erasure HOLDS against the capture writer.** The whole guarantee is one
 * `WHERE erased_at IS NULL` on an upsert. An in-memory double asserts that its
 * own script skipped the row.
 *
 * **(d) `provenance.actor` is byte-identical before and after.** ADR-0037 §5's
 * retain-the-surface rule, and the issue's own acceptance criterion. Asserted
 * over the stored jsonb, through a full capture pass, on a real fact row.
 *
 * Opt in locally with the same scratch database as its sibling brain suites —
 * every one of them creates and drops its OWN schema, so they share it safely:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5433/brain_4771_scratch
 */

import { afterEach, afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import { MANAGED_AUTH_MIGRATIONS } from "@atlas/api/lib/db/internal";
import {
  captureActorIdentity,
  eraseActorIdentity,
  loadActorIdentities,
  type ActorIdentityReader,
} from "@atlas/api/lib/brain/actor-identity";
import { captureAuthoringIdentities } from "@atlas/api/lib/brain/audience/identity-capture";
import type { SlackDirectoryUser } from "@atlas/api/lib/slack/api";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;
const PG_TEST_TIMEOUT_MS = 60_000;

const WORKSPACE = "ws-5440";

function user(partial: Partial<SlackDirectoryUser> & { id: string }): SlackDirectoryUser {
  return { email: null, displayName: null, realName: null, deleted: false, isBot: false, ...partial };
}

describeIfPg("actor identity — the human name on a claim (#5440)", () => {
  let pool: Pool;
  const schemaName = `brain_5440_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  /** The read surfaces' handle, over the raw pool. */
  let db: ActorIdentityReader;

  beforeAll(async () => {
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
    // Better Auth's `"user"`, stubbed to exactly the shape the live join reads.
    // Global by ADR-0024, which is why the join carries no workspace scope.
    await pool.query(
      `CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, name TEXT, email TEXT NOT NULL)`,
    );
    await pool.query(
      `INSERT INTO "user" (id, name, email) VALUES ('user-ada', 'Ada Lovelace', 'ada@corp.test')
       ON CONFLICT (id) DO NOTHING`,
    );
    db = {
      query: async (sql, params) => {
        const res = await pool.query(sql, params as unknown[]);
        return { rows: res.rows as readonly unknown[], rowCount: res.rowCount };
      },
    };
  }, PG_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await pool.end();
    }
  }, PG_TEST_TIMEOUT_MS);

  afterEach(async () => {
    // UNSCOPED, so a failing assertion in a cross-workspace test cannot cascade
    // into the next one.
    await pool.query(`DELETE FROM brain_actor_identity`);
    await pool.query(`DELETE FROM brain_facts`);
    await pool.query(`DELETE FROM brain_episodes`);
    await pool.query(`UPDATE "user" SET name = 'Ada Lovelace' WHERE id = 'user-ada'`);
  });

  // -------------------------------------------------------------------------
  // (a) The live join — the acceptance criterion itself
  // -------------------------------------------------------------------------

  it("resolves an `atlas` name LIVE: renaming the account changes the surface with no re-ingest", async () => {
    await captureActorIdentity(db, WORKSPACE, {
      actor: "slack:U-ADA",
      source: "slack",
      vendorUserId: "U-ADA",
      state: "atlas",
      userId: "user-ada",
    });

    const before = await loadActorIdentities(db, WORKSPACE, ["slack:U-ADA"]);
    expect(before.get("slack:U-ADA")).toEqual({
      state: "atlas",
      userId: "user-ada",
      name: "Ada Lovelace",
      email: "ada@corp.test",
    });

    // The rename. Nothing re-ingests, nothing re-captures, no backfill runs.
    await pool.query(`UPDATE "user" SET name = 'Ada Byron' WHERE id = 'user-ada'`);

    const after = await loadActorIdentities(db, WORKSPACE, ["slack:U-ADA"]);
    expect(after.get("slack:U-ADA")).toMatchObject({ state: "atlas", name: "Ada Byron" });

    // And the row itself never held a name — that is what makes the join the
    // only source, so there is nothing that CAN go stale.
    const { rows } = await pool.query(
      `SELECT display_name, real_name, email, snapshot_at FROM brain_actor_identity
        WHERE workspace_id = $1 AND actor = $2`,
      [WORKSPACE, "slack:U-ADA"],
    );
    expect(rows[0]).toEqual({
      display_name: null,
      real_name: null,
      email: null,
      snapshot_at: null,
    });
  });

  it("degrades to opaque when the Atlas account is deleted out from under the pointer", async () => {
    await captureActorIdentity(db, WORKSPACE, {
      actor: "slack:U-GHOST",
      source: "slack",
      vendorUserId: "U-GHOST",
      state: "atlas",
      userId: "user-never-existed",
    });
    const out = await loadActorIdentities(db, WORKSPACE, ["slack:U-GHOST"]);
    // NOT a blank, and not the stored user id rendered as if it were a person:
    // a deleted account is not a licence to assert a name Atlas cannot stand
    // behind.
    expect(out.get("slack:U-GHOST")).toEqual({ state: "opaque", erased: false });
  });

  // -------------------------------------------------------------------------
  // (b) The three states, enforced at rest
  // -------------------------------------------------------------------------

  it("refuses an `atlas` row carrying a snapshot", async () => {
    // The absence half of the CHECK. Without it, a row could hold both and a
    // reader would render whichever field it reached for first — which is
    // exactly what the discriminated union exists to make impossible.
    await expect(
      pool.query(
        `INSERT INTO brain_actor_identity
           (workspace_id, actor, source, vendor_user_id, state, user_id, display_name)
         VALUES ($1, 'slack:U-X', 'slack', 'U-X', 'atlas', 'user-ada', 'stale name')`,
        [WORKSPACE],
      ),
    ).rejects.toThrow(/ck_brain_actor_identity_atlas_shape/);
  });

  it("refuses an UNDATED directory snapshot", async () => {
    // The date is what makes a stale name legible AS STALE rather than asserted
    // as current.
    await expect(
      pool.query(
        `INSERT INTO brain_actor_identity
           (workspace_id, actor, source, vendor_user_id, state, display_name)
         VALUES ($1, 'slack:U-Y', 'slack', 'U-Y', 'directory', 'dana')`,
        [WORKSPACE],
      ),
    ).rejects.toThrow(/ck_brain_actor_identity_directory_shape/);
  });

  it("refuses a NAMELESS directory snapshot — the NULL-passes-a-CHECK trap", async () => {
    // ⚠️ This is the one a bare `display_name <> ''` would let through: a CHECK
    // PASSES when its expression is NULL, so three NULL columns evaluate to
    // NULL and admit a `directory` row that names nobody. It would render as a
    // blank, which is precisely what finish condition 2 refuses.
    await expect(
      pool.query(
        `INSERT INTO brain_actor_identity
           (workspace_id, actor, source, vendor_user_id, state, snapshot_at)
         VALUES ($1, 'slack:U-Z', 'slack', 'U-Z', 'directory', now())`,
        [WORKSPACE],
      ),
    ).rejects.toThrow(/ck_brain_actor_identity_directory_shape/);
  });

  it("refuses an erasure that is not a tombstone", async () => {
    await expect(
      pool.query(
        `INSERT INTO brain_actor_identity
           (workspace_id, actor, source, vendor_user_id, state, display_name, snapshot_at, erased_at, erased_by)
         VALUES ($1, 'slack:U-W', 'slack', 'U-W', 'directory', 'dana', now(), now(), 'admin-1')`,
        [WORKSPACE],
      ),
    ).rejects.toThrow(/ck_brain_actor_identity_(erasure|directory)_shape/);
  });

  // -------------------------------------------------------------------------
  // (c) Erasure, and the fact that it HOLDS
  // -------------------------------------------------------------------------

  it("returns an erased claim to opaque, and the next capture pass does NOT undo it", async () => {
    const directory = new Map<string, SlackDirectoryUser>([
      ["U-DANA", user({ id: "U-DANA", displayName: "dana", realName: "Dana Okafor", email: "d@x.test" })],
    ]);
    await seedEpisode("U-DANA");

    await captureAuthoringIdentities({
      workspaceId: WORKSPACE,
      source: "slack",
      directory,
      resolved: new Map(),
      db,
    });
    expect((await loadActorIdentities(db, WORKSPACE, ["slack:U-DANA"])).get("slack:U-DANA")).toMatchObject({
      state: "directory",
      displayName: "dana",
    });

    const erased = await eraseActorIdentity(db, WORKSPACE, "slack:U-DANA", "admin-1");
    expect(erased).toEqual({ ok: true });
    expect((await loadActorIdentities(db, WORKSPACE, ["slack:U-DANA"])).get("slack:U-DANA")).toEqual({
      state: "opaque",
      erased: true,
    });

    // ⚠️ THE property. The audience cycle runs every 30 minutes with the same
    // directory in hand. An erasure a background cycle can undo is not an
    // erasure — it lasts half an hour and comes back silently.
    const second = await captureAuthoringIdentities({
      workspaceId: WORKSPACE,
      source: "slack",
      directory,
      resolved: new Map(),
      db,
    });
    expect(second.refused).toBe(1);
    expect((await loadActorIdentities(db, WORKSPACE, ["slack:U-DANA"])).get("slack:U-DANA")).toEqual({
      state: "opaque",
      erased: true,
    });
  });

  it("keeps a snapshot when the author DROPS OUT of the vendor directory", async () => {
    // ⚠️ The defect this guard closes, end to end. An author in `users.list`
    // today gets a dated snapshot; a Slack Connect guest whose connection ends
    // — or a Grid member moved to another workspace — is simply GONE from the
    // next `users.list`, so the capture decides `opaque`. An unguarded upsert
    // would overwrite the snapshot with a nameless row on the very next
    // 30-minute cycle.
    //
    // That is precisely the person the `directory` state exists for: someone
    // who has left both the vendor and the company, whose captured name is the
    // only record that will ever name them. The vendor going quiet about
    // someone is not evidence Atlas should forget them, and the loss would be
    // irreversible.
    await seedEpisode("U-DANA");
    const present = new Map<string, SlackDirectoryUser>([
      ["U-DANA", user({ id: "U-DANA", displayName: "dana", realName: "Dana Okafor" })],
    ]);
    await captureAuthoringIdentities({
      workspaceId: WORKSPACE,
      source: "slack",
      directory: present,
      resolved: new Map(),
      db,
    });
    const dated = await snapshotAt("slack:U-DANA");
    expect(dated).not.toBeNull();

    // The next cycle: the same author, and an EMPTY directory.
    const second = await captureAuthoringIdentities({
      workspaceId: WORKSPACE,
      source: "slack",
      directory: new Map(),
      resolved: new Map(),
      db,
    });
    expect(second.refused).toBe(1);
    expect(second.opaque).toBe(0);

    // The name — and its original date — survive untouched.
    expect((await loadActorIdentities(db, WORKSPACE, ["slack:U-DANA"])).get("slack:U-DANA")).toMatchObject({
      state: "directory",
      displayName: "dana",
      realName: "Dana Okafor",
    });
    expect(await snapshotAt("slack:U-DANA")).toEqual(dated);
  });

  it("still UPGRADES a snapshot to a live Atlas join", async () => {
    // The negative that keeps the guard above from being "never change a
    // directory row". `directory → atlas` is a strict improvement — the person
    // signed up, and a live join beats a snapshot — so it must still happen.
    await seedEpisode("U-ADA");
    await captureAuthoringIdentities({
      workspaceId: WORKSPACE,
      source: "slack",
      directory: new Map([["U-ADA", user({ id: "U-ADA", displayName: "ada" })]]),
      resolved: new Map(),
      db,
    });
    expect((await loadActorIdentities(db, WORKSPACE, ["slack:U-ADA"])).get("slack:U-ADA")).toMatchObject({
      state: "directory",
    });

    await captureAuthoringIdentities({
      workspaceId: WORKSPACE,
      source: "slack",
      directory: new Map([["U-ADA", user({ id: "U-ADA", displayName: "ada" })]]),
      resolved: new Map([["U-ADA", "user-ada"]]),
      db,
    });
    expect((await loadActorIdentities(db, WORKSPACE, ["slack:U-ADA"])).get("slack:U-ADA")).toEqual({
      state: "atlas",
      userId: "user-ada",
      name: "Ada Lovelace",
      email: "ada@corp.test",
    });
    // …and the snapshot columns are cleared, so nothing stale can be read back.
    expect(await snapshotAt("slack:U-ADA")).toBeNull();
  });

  it("matches a claim whose stored actor had surrounding whitespace", async () => {
    // `resolvedPrincipal` trims before composing the claim's handle, so an
    // episode stored with `source_actor = ' U-PAD '` produces `slack:U-PAD`.
    // Without `btrim` in the capture query this would key `slack: U-PAD ` and
    // the two would never join: the claim renders `opaque` forever while a junk
    // identity row sits beside it naming nobody.
    await seedEpisode(" U-PAD ");
    await captureAuthoringIdentities({
      workspaceId: WORKSPACE,
      source: "slack",
      directory: new Map([["U-PAD", user({ id: "U-PAD", displayName: "pad" })]]),
      resolved: new Map(),
      db,
    });
    expect((await loadActorIdentities(db, WORKSPACE, ["slack:U-PAD"])).get("slack:U-PAD")).toMatchObject({
      state: "directory",
      displayName: "pad",
    });
  });

  it("refuses to erase an `atlas` identity, and says which case it is", async () => {
    // Not a silent no-op. Clearing one would remove nothing — the name is a
    // live join — and would leave a current colleague unnameable on every claim
    // they made. The operator is told which of the two refusals they hit.
    await captureActorIdentity(db, WORKSPACE, {
      actor: "slack:U-ADA",
      source: "slack",
      vendorUserId: "U-ADA",
      state: "atlas",
      userId: "user-ada",
    });
    expect(await eraseActorIdentity(db, WORKSPACE, "slack:U-ADA", "admin-1")).toEqual({
      ok: false,
      reason: "not-a-snapshot",
    });
    expect(await eraseActorIdentity(db, WORKSPACE, "slack:U-NOBODY", "admin-1")).toEqual({
      ok: false,
      reason: "not-found",
    });
  });

  it("keeps `snapshot_at` still when the name has not changed", async () => {
    // A date that moves on every 30-minute cycle reports itself as fresh
    // forever, which is exactly the "stale name asserted as current" the date
    // exists to prevent.
    const capture = {
      actor: "slack:U-DANA",
      source: "slack",
      vendorUserId: "U-DANA",
      state: "directory" as const,
      displayName: "dana",
      realName: null,
      email: null,
    };
    await captureActorIdentity(db, WORKSPACE, capture);
    const first = await snapshotAt("slack:U-DANA");
    await captureActorIdentity(db, WORKSPACE, capture);
    expect(await snapshotAt("slack:U-DANA")).toEqual(first);

    // But a CHANGED name re-dates it — the snapshot is new, so its date is.
    await captureActorIdentity(db, WORKSPACE, { ...capture, displayName: "dana-o" });
    expect(await snapshotAt("slack:U-DANA")).not.toEqual(first);
  });

  it("re-dates a snapshot when a name arrives where there was none", async () => {
    // The `IS DISTINCT FROM` arm. With a bare `<>`, `NULL <> 'Dana Okafor'` is
    // NULL, the comparison reads as "unchanged", and the row keeps a date from
    // before the name existed.
    const base = {
      actor: "slack:U-DANA",
      source: "slack",
      vendorUserId: "U-DANA",
      state: "directory" as const,
      displayName: "dana",
      realName: null,
      email: null,
    };
    await captureActorIdentity(db, WORKSPACE, base);
    const first = await snapshotAt("slack:U-DANA");
    await captureActorIdentity(db, WORKSPACE, { ...base, realName: "Dana Okafor" });
    expect(await snapshotAt("slack:U-DANA")).not.toEqual(first);
  });

  // -------------------------------------------------------------------------
  // (d) The claim's own surface is never rewritten
  // -------------------------------------------------------------------------

  it("leaves `provenance.actor` byte-identical through a full capture pass", async () => {
    // ADR-0037 §5's retain-the-surface rule, and #5440's own acceptance
    // criterion. The resolved identity is added BESIDE the handle; re-deriving
    // identity from a rewritten value is irreversible, and a snapshot is exactly
    // the kind of data later found to be wrong.
    const episodeId = await seedEpisode("U-DANA");
    const provenance = {
      source: "slack",
      sourceId: "C1:1799999999.001",
      episodeId,
      actor: "slack:U-DANA",
      producer: "extraction:v1",
      occurredAt: "2026-05-30T00:00:00.000Z",
      extractedAt: "2026-05-30T00:05:00.000Z",
      reconciledAt: "2026-05-30T00:06:00.000Z",
    };
    await pool.query(
      `INSERT INTO brain_facts
         (workspace_id, subject, predicate, object, subject_key, predicate_key, object_key,
          source_episode_id, provenance, status, visible_to)
       VALUES ($1, 'Dana', 'owns', 'billing', 'dana', 'owns', 'billing',
               $2, $3::jsonb, 'draft', ARRAY['org']::text[])`,
      [WORKSPACE, episodeId, JSON.stringify(provenance)],
    );
    const before = await storedProvenance();

    await captureAuthoringIdentities({
      workspaceId: WORKSPACE,
      source: "slack",
      directory: new Map([["U-DANA", user({ id: "U-DANA", displayName: "dana", email: "d@x.test" })]]),
      resolved: new Map(),
      db,
    });

    // Byte-identical, compared as the stored TEXT rather than as a parsed
    // object: an object compare would pass on a payload whose key order or
    // numeric formatting changed, and "verbatim" is the actual promise.
    expect(await storedProvenance()).toBe(before);
    expect(JSON.parse(before).actor).toBe("slack:U-DANA");
  });

  it("scopes identities to their workspace", async () => {
    // The same vendor handle in two workspaces is two rows: the directory that
    // names it is the workspace's, not the vendor's.
    await captureActorIdentity(db, WORKSPACE, {
      actor: "slack:U-SHARED",
      source: "slack",
      vendorUserId: "U-SHARED",
      state: "directory",
      displayName: "ours",
    });
    await captureActorIdentity(db, "ws-other", {
      actor: "slack:U-SHARED",
      source: "slack",
      vendorUserId: "U-SHARED",
      state: "directory",
      displayName: "theirs",
    });
    expect(
      (await loadActorIdentities(db, WORKSPACE, ["slack:U-SHARED"])).get("slack:U-SHARED"),
    ).toMatchObject({ displayName: "ours" });
    expect(
      (await loadActorIdentities(db, "ws-other", ["slack:U-SHARED"])).get("slack:U-SHARED"),
    ).toMatchObject({ displayName: "theirs" });
  });

  it("captures only principals who AUTHORED an episode, against the real query", async () => {
    // ⚠️ The bound that IS the reversal. Two people in the directory; one has
    // spoken. Persisting the other would be a copy of the customer's roster,
    // which the ADR refuses by name — and the unit test's double cannot prove
    // the SQL's predicate, only that its own fixture list was short.
    await seedEpisode("U-DANA");
    const out = await captureAuthoringIdentities({
      workspaceId: WORKSPACE,
      source: "slack",
      directory: new Map([
        ["U-DANA", user({ id: "U-DANA", displayName: "dana" })],
        ["U-QUIET", user({ id: "U-QUIET", displayName: "never spoke" })],
      ]),
      resolved: new Map(),
      db,
    });
    expect(out.authors).toBe(1);
    const { rows } = await pool.query(
      `SELECT actor FROM brain_actor_identity WHERE workspace_id = $1 ORDER BY actor`,
      [WORKSPACE],
    );
    expect(rows.map((r) => r.actor)).toEqual(["slack:U-DANA"]);
  });

  // --- fixtures ------------------------------------------------------------

  let episodeSeq = 0;

  async function seedEpisode(sourceActor: string): Promise<string> {
    episodeSeq++;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO brain_episodes (workspace_id, source, source_id, source_actor, body, occurred_at, visible_to)
       VALUES ($1, 'slack', $2, $3, 'seed', now(), ARRAY['org']::text[])
       RETURNING id`,
      [WORKSPACE, `ep-5440-${episodeSeq}`, sourceActor],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error("fixture failed to seed an episode");
    return id;
  }

  async function snapshotAt(actor: string): Promise<string | null> {
    const { rows } = await pool.query<{ snapshot_at: Date | null }>(
      `SELECT snapshot_at FROM brain_actor_identity WHERE workspace_id = $1 AND actor = $2`,
      [WORKSPACE, actor],
    );
    const value = rows[0]?.snapshot_at ?? null;
    return value === null ? null : value.toISOString();
  }

  async function storedProvenance(): Promise<string> {
    const { rows } = await pool.query<{ p: string }>(
      `SELECT provenance::text AS p FROM brain_facts WHERE workspace_id = $1`,
      [WORKSPACE],
    );
    const value = rows[0]?.p;
    if (value === undefined) throw new Error("fixture did not seed a fact");
    return value;
  }
});
