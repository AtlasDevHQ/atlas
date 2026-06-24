/**
 * Unit coverage for `bulkUpsertEntities`'s all-or-nothing behavior under a
 * transaction-bound executor (#3683).
 *
 * The pooled default path tolerates partial imports (a bad row is logged,
 * skipped, and counted as a failure) — wizard `/save` and the admin import rely
 * on one bad row not sinking the good ones. But when a caller threads its own
 * executor (the /use-demo seed, via `withDemoSeedLock`), the batch is part of
 * that caller's transaction: a row failure has already aborted the transaction
 * in Postgres, so it MUST propagate (rolling the whole seed back) instead of
 * being silently counted as a partial. That is the mechanism that stops the
 * "7-of-13 seed returns a clean 201" bug.
 *
 * No DB is touched: `hasInternalDB()` only reads `DATABASE_URL`, and a supplied
 * executor means the upsert helpers never reach the pool.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { bulkUpsertEntities } from "@atlas/api/lib/semantic/entities";

const rows = [
  { entityType: "entity" as const, name: "users", yamlContent: "table: users\n", connectionId: "__demo__" },
  { entityType: "entity" as const, name: "orders", yamlContent: "table: orders\n", connectionId: "__demo__" },
  { entityType: "entity" as const, name: "events", yamlContent: "table: events\n", connectionId: "__demo__" },
];

describe("bulkUpsertEntities — transactional atomicity (#3683)", () => {
  let savedDbUrl: string | undefined;

  beforeEach(() => {
    savedDbUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://fake:fake@localhost:5432/fake";
  });

  afterEach(() => {
    if (savedDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDbUrl;
  });

  it("re-throws on the first row failure under a transactional executor (no partial count)", async () => {
    let calls = 0;
    const exec = async <T extends Record<string, unknown>>(): Promise<T[]> => {
      calls += 1;
      if (calls === 2) throw new Error("upsert rejected — schema drift");
      return [] as T[];
    };

    await expect(bulkUpsertEntities("org-1", rows, exec)).rejects.toThrow("upsert rejected");
    // Stopped at the failing row — the third was never attempted, and no
    // partial count leaked out for the caller to mistake for success.
    expect(calls).toBe(2);
  });

  it("returns the full count when every row succeeds under a transactional executor", async () => {
    let calls = 0;
    const exec = async <T extends Record<string, unknown>>(): Promise<T[]> => {
      calls += 1;
      return [] as T[];
    };

    const n = await bulkUpsertEntities("org-1", rows, exec);
    expect(n).toBe(3);
    expect(calls).toBe(3);
  });
});

/**
 * Status dispatch (#3932). `bulkUpsertEntities` writes `draft` rows by default
 * (the admin import / wizard / profiler "review-then-publish" workflow), but the
 * /use-demo seed threads `status: 'published'` so the curated, read-only demo
 * layer lands queryable in published mode (the default mode for a fresh signup).
 * Without this, the curated demo entities are stranded as drafts — invisible to
 * both the chat data-setup gate AND the agent's published-mode whitelist,
 * dead-ending the user at the activation moment.
 *
 * The injected `exec` records the INSERT so we can assert the inlined status
 * literal without a real DB.
 */
describe("bulkUpsertEntities — status dispatch (#3932)", () => {
  let savedDbUrl: string | undefined;

  beforeEach(() => {
    savedDbUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://fake:fake@localhost:5432/fake";
  });

  afterEach(() => {
    if (savedDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDbUrl;
  });

  function recordingExec(): { exec: <T extends Record<string, unknown>>(sql: string) => Promise<T[]>; sqls: string[] } {
    const sqls: string[] = [];
    const exec = async <T extends Record<string, unknown>>(sql: string): Promise<T[]> => {
      sqls.push(sql);
      return [] as T[];
    };
    return { exec, sqls };
  }

  it("defaults to draft rows when status is omitted", async () => {
    const { exec, sqls } = recordingExec();
    const n = await bulkUpsertEntities("org-1", rows, exec);

    expect(n).toBe(3);
    expect(sqls).toHaveLength(3);
    for (const sql of sqls) {
      expect(sql).toContain("'draft'");
      expect(sql).not.toContain("'published'");
    }
  });

  it("writes published rows when status='published' (demo seed)", async () => {
    const { exec, sqls } = recordingExec();
    const n = await bulkUpsertEntities("org-1", rows, exec, "published");

    expect(n).toBe(3);
    expect(sqls).toHaveLength(3);
    for (const sql of sqls) {
      expect(sql).toContain("'published'");
      expect(sql).not.toContain("'draft'");
    }
  });

  it("dispatches a group-scoped row to the PUBLISHED group helper (direct connection_group_id)", async () => {
    const { exec, sqls } = recordingExec();
    // A row carrying `connectionGroupId` directly (canonical groups/<group>/ or
    // legacy <source>/ layout) must route to `upsertEntityForGroup`, not the
    // flat `upsertEntity` install-resolution path.
    const n = await bulkUpsertEntities(
      "org-1",
      [{ entityType: "entity", name: "orders", yamlContent: "table: orders\n", connectionGroupId: "eu_prod" }],
      exec,
      "published",
    );

    expect(n).toBe(1);
    expect(sqls).toHaveLength(1);
    expect(sqls[0]).toContain("'published'");
    // Group-direct INSERT writes `connection_group_id` from $5 verbatim — it must
    // NOT route through the install-resolving subquery the flat connectionId path
    // uses, which is how we know the published *group* branch was selected.
    expect(sqls[0]).not.toContain("COALESCE(config->>'group_id'");
  });
});
