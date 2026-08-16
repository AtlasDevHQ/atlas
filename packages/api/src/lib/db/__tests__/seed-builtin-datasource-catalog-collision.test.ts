/**
 * #5266 — the foreign-id slug collision path of the built-in Datasource
 * catalog seed.
 *
 * A row already holding one of the built-in slugs under a DIFFERENT id makes
 * the insert raise `23505` instead of silently no-op'ing (that is what
 * qualifying the conflict target to `(id)` buys). This file covers what the
 * seeder does with that: warn naming the row, keep going, and report the slug
 * as BLOCKED — rather than counting it as preserved, which is the sharper half
 * of this defect and the thing that made it worse than #5239's sibling.
 *
 * ⚠️ SEPARATE FILE BECAUSE OF THE LOGGER MOCK. `createLogger(...)` is called at
 * module evaluation, so `mock.module("@atlas/api/lib/logger")` only reaches it
 * when the seeder is imported AFTER the mock — which rules out the static
 * imports `seed-builtin-datasource-catalog.test.ts` relies on. Everything here
 * therefore goes through a top-level `await import`.
 *
 * ⚠️ AND THE MOCK PROVES ONLY HALF OF IT. The rejections below are shaped by
 * hand, so this file cannot show that Postgres raises `23505` for this
 * situation at all — a fixture agreeing with the code by construction. That
 * half is `builtin-datasource-catalog-seed-pg.test.ts`, against real Postgres.
 */

import { describe, expect, it, beforeEach, mock } from "bun:test";

interface LoggedCall {
  readonly level: "info" | "warn" | "error" | "debug";
  readonly payload: unknown;
  readonly message: string;
}

/**
 * ⚠️ ONE SINK, AND IT CARRIES THE LEVEL. A per-level array (or a helper that
 * pushes only the message) cannot see `log.warn` demoted back to `log.info`,
 * which is precisely the claim the first two tests make — the seeder must stop
 * reporting a pass that wrote nothing as a plain success.
 */
const logged: LoggedCall[] = [];
const record =
  (level: LoggedCall["level"]) =>
  (payload: unknown, message?: string): void => {
    logged.push({
      level,
      payload,
      message: typeof payload === "string" ? payload : (message ?? ""),
    });
  };

/**
 * ⚠️ MOCK-ALL-EXPORTS, per the repo's testing rule. Only `createLogger` is
 * needed today, but a partial `mock.module` replaces the whole module: the
 * moment anything in this file's import graph resolves `getLogger()` at import
 * time, a partial mock turns into `undefined is not a function` several files
 * away from the cause.
 */
const stubLogger = {
  info: record("info"),
  warn: record("warn"),
  error: record("error"),
  debug: record("debug"),
};

void mock.module("@atlas/api/lib/logger", () => ({
  ACTOR_KINDS: ["human", "agent", "mcp", "scheduler", "api_key"] as const,
  createLogger: () => stubLogger,
  getLogger: () => stubLogger,
  getRequestContext: () => undefined,
  withRequestContext: <T,>(_ctx: unknown, fn: () => T): T => fn(),
  redactPaths: [] as string[],
  scrubErrSerializer: (value: unknown) => value,
  scrubLogFormatter: (obj: unknown) => obj,
  hashShareToken: () => "",
  setLogLevel: () => false,
}));

const { seedBuiltinDatasourceCatalog, BUILTIN_DATASOURCE_CATALOG_ROWS } = await import(
  "@atlas/api/lib/db/seed-builtin-datasource-catalog"
);

type SeedDb = Parameters<typeof seedBuiltinDatasourceCatalog>[0];

/** A `pg` `DatabaseError` as the driver hands one back: untyped extra fields. */
const uniqueViolation = (slug: string): Error =>
  Object.assign(
    new Error(`duplicate key value violates unique constraint "plugin_catalog_slug_key"`),
    {
      code: "23505",
      constraint: "plugin_catalog_slug_key",
      detail: `Key (slug)=(${slug}) already exists.`,
    },
  );

/**
 * A DB whose insert rejects for `blocked`, returns an empty RETURNING set for
 * `existing` (the preserved path), and inserts everything else.
 *
 * The slug is read off the bound parameters rather than the SQL, so a seeder
 * that reordered its `VALUES` would not quietly reject a different row than
 * the test asked for.
 */
const dbBlocking = (
  blocked: ReadonlySet<string>,
  reject: (slug: string) => unknown = uniqueViolation,
  existing: ReadonlySet<string> = new Set(),
): { db: SeedDb; attempted: string[] } => {
  const attempted: string[] = [];
  const db: SeedDb = {
    async query<T = unknown>(_sql: string, params?: unknown[]) {
      const slug = String(params?.[2]);
      attempted.push(slug);
      if (blocked.has(slug)) throw reject(slug);
      return { rows: (existing.has(slug) ? [] : [{ slug }]) as T[] };
    },
  };
  return { db, attempted };
};

const ALL_SLUGS = BUILTIN_DATASOURCE_CATALOG_ROWS.map((r) => r.slug);
const rowFor = (slug: string) => BUILTIN_DATASOURCE_CATALOG_ROWS.find((r) => r.slug === slug)!;

// 4th and 7th of nine — neither first nor last, so a loop that stopped at the
// first collision and one that dropped only the tail both fail here.
const CLICKHOUSE = "clickhouse";
const SALESFORCE = "salesforce";

describe("seedBuiltinDatasourceCatalog — a slug held under a foreign id (#5266)", () => {
  beforeEach(() => {
    logged.length = 0;
  });

  it("⭐ reports the blocked row as BLOCKED and never as preserved", async () => {
    // #5266's actual subject. Before the fix `preservedSlugs` was derived by
    // subtraction — every expected slug minus the inserted ones — so a row the
    // seeder could not write was positively asserted to be present and fine.
    const { db } = dbBlocking(new Set([CLICKHOUSE]));
    const result = await seedBuiltinDatasourceCatalog(db);

    expect(result.blockedSlugs).toEqual([CLICKHOUSE]);
    expect(result.preservedSlugs).not.toContain(CLICKHOUSE);
    expect(result.insertedSlugs).not.toContain(CLICKHOUSE);
    // ⚠️ The three lists have DIFFERENT sizes here — 8 inserted, 0 preserved,
    // 1 blocked — so no two of them can be swapped without a count
    // disagreeing. With `{1, 1}` the assertion would hold under the swap.
    expect(result.insertedSlugs).toHaveLength(ALL_SLUGS.length - 1);
    expect(result.preservedSlugs).toHaveLength(0);
  });

  it("⭐ keeps blocked and preserved apart when BOTH outcomes occur in one pass", async () => {
    // The discriminating case, and the one the old subtraction could not
    // express at all: `postgres` genuinely already exists (empty RETURNING,
    // no error) while `clickhouse` is squatted (23505). Under the old
    // derivation both landed in `preservedSlugs` and were indistinguishable.
    const { db } = dbBlocking(new Set([CLICKHOUSE]), uniqueViolation, new Set(["postgres"]));
    const result = await seedBuiltinDatasourceCatalog(db);

    expect(result.preservedSlugs).toEqual(["postgres"]);
    expect(result.blockedSlugs).toEqual([CLICKHOUSE]);
    expect(result.insertedSlugs).toHaveLength(ALL_SLUGS.length - 2);
    // The partition holds: every expected slug lands in exactly one list.
    const all = [...result.insertedSlugs, ...result.preservedSlugs, ...result.blockedSlugs];
    expect([...all].sort()).toEqual([...ALL_SLUGS].sort());
    expect(new Set(all).size).toBe(all.length);
  });

  it("warns naming the blocked row, and the warning is not a success log", async () => {
    const { db } = dbBlocking(new Set([CLICKHOUSE]));
    await seedBuiltinDatasourceCatalog(db);

    const perRow = logged.filter(
      (c) =>
        c.level === "warn" &&
        typeof c.payload === "object" &&
        c.payload !== null &&
        (c.payload as { slug?: unknown }).slug === CLICKHOUSE,
    );
    expect(perRow).toHaveLength(1);
    // The row is named by BOTH of its identifiers: the slug is what collided,
    // the canonical id is what an operator has to go look at.
    expect(perRow[0]?.payload).toMatchObject({
      id: rowFor(CLICKHOUSE).id,
      slug: CLICKHOUSE,
      constraint: "plugin_catalog_slug_key",
      detail: `Key (slug)=(${CLICKHOUSE}) already exists.`,
      err: 'duplicate key value violates unique constraint "plugin_catalog_slug_key"',
    });
    // ⚠️ THE MESSAGE, not only the payload — the operator's entire remedy lives
    // there and nothing else asserts on it. It must name the constraint and
    // condition the lookup on it rather than prescribing a slug query outright.
    expect(perRow[0]?.message).toContain("constraint");
    expect(perRow[0]?.message).toContain("plugin_catalog WHERE slug");
    // No `info` may claim the pass simply completed.
    expect(logged.filter((c) => c.level === "info")).toHaveLength(0);
    const summary = logged.filter((c) => c.level === "warn" && c.message.includes("BLOCKED"));
    expect(summary).toHaveLength(1);
  });

  it("logs the plain success `info` — and no warning — when nothing is blocked", async () => {
    // The other half of the level claim. Without this, a seeder that warned
    // unconditionally would pass the case above.
    const { db } = dbBlocking(new Set());
    await seedBuiltinDatasourceCatalog(db);
    expect(logged.filter((c) => c.level === "warn")).toHaveLength(0);
    expect(logged.filter((c) => c.level === "info")).toHaveLength(1);
  });

  it("seeds every remaining row — one collision does not abort the loop", async () => {
    const { db, attempted } = dbBlocking(new Set([CLICKHOUSE, SALESFORCE]));
    const result = await seedBuiltinDatasourceCatalog(db);

    expect(attempted).toEqual(ALL_SLUGS);
    expect(result.blockedSlugs).toEqual([CLICKHOUSE, SALESFORCE]);
    expect(result.insertedSlugs).toEqual(
      ALL_SLUGS.filter((s) => s !== CLICKHOUSE && s !== SALESFORCE),
    );
    expect(result.insertedSlugs).toHaveLength(ALL_SLUGS.length - 2);
  });

  it("still propagates a non-unique-violation failure instead of warning past it", async () => {
    // The guard on the guard. A catch that treated every rejection as a benign
    // collision would demote a real outage — a dropped table, a dead pool — to
    // a warning and report a seeded catalog.
    const { db } = dbBlocking(new Set([CLICKHOUSE]), () =>
      Object.assign(new Error('relation "plugin_catalog" does not exist'), { code: "42P01" }),
    );
    await expect(seedBuiltinDatasourceCatalog(db)).rejects.toThrow(/does not exist/);
    expect(logged.filter((c) => c.level === "warn")).toHaveLength(0);
  });

  it("propagates a rejection that is not an object at all", async () => {
    // `err.code` on a thrown string is `undefined`, and reading it unguarded is
    // the CLAUDE.md type-narrowing rule this catch has to honour.
    const { db } = dbBlocking(new Set([CLICKHOUSE]), (slug) => `pool exploded seeding ${slug}`);
    await expect(seedBuiltinDatasourceCatalog(db)).rejects.toThrow();
  });

  it("classifies on the SQLSTATE code, not on the message", async () => {
    // A message-keyed catch would classify this as a collision and warn past a
    // failure that is nothing of the sort.
    const { db } = dbBlocking(new Set([CLICKHOUSE]), () =>
      Object.assign(new Error("duplicate key value violates unique constraint"), {
        code: "XX000",
      }),
    );
    await expect(seedBuiltinDatasourceCatalog(db)).rejects.toThrow(/duplicate key/);
    expect(logged.filter((c) => c.level === "warn")).toHaveLength(0);
  });

  it("⭐ rethrows a 23505 that NAMES a different unique index", async () => {
    // The hedge made structural. The warning admits it cannot know WHICH unique
    // value collided — but `blockedSlugs` is a list of SLUGS, so filing a
    // future `UNIQUE (name)` violation there would send an operator to rename
    // the row holding a slug that is not the problem.
    const { db } = dbBlocking(new Set([CLICKHOUSE]), () =>
      Object.assign(new Error("duplicate key value violates unique constraint"), {
        code: "23505",
        constraint: "plugin_catalog_name_key",
      }),
    );
    await expect(seedBuiltinDatasourceCatalog(db)).rejects.toThrow(/duplicate key/);
    expect(
      logged.filter(
        (c) => c.level === "warn" && (c.payload as { slug?: unknown }).slug === CLICKHOUSE,
      ),
    ).toHaveLength(0);
  });

  it("⭐ logs the PARTIAL blocked list before aborting on an unrelated failure", async () => {
    // `blockedSlugs` does not survive a throw: the boot wrapper turns it into
    // `{ kind: "error" }` and the Layer reports `blockedSlugs: []`. So a pass
    // that blocked clickhouse (4th) and then hit a dead table on salesforce
    // (7th) would report NOTHING blocked — the same overloading #5266 exists
    // to remove, one arm over. The abort has to say what it already knew.
    const { db } = dbBlocking(new Set([CLICKHOUSE, SALESFORCE]), (slug) =>
      slug === CLICKHOUSE
        ? uniqueViolation(slug)
        : Object.assign(new Error('relation "plugin_catalog" does not exist'), { code: "42P01" }),
    );
    await expect(seedBuiltinDatasourceCatalog(db)).rejects.toThrow(/does not exist/);

    const abort = logged.find((c) => c.level === "warn" && c.message.includes("ABORTING"));
    expect(abort).toBeDefined();
    expect(abort?.payload).toMatchObject({
      blockedSlugs: [CLICKHOUSE],
      abortingAt: rowFor(SALESFORCE).id,
    });
    // And it says the list is partial — an operator reading it must not take
    // one blocked slug for the whole story.
    expect(abort?.message).toContain("PARTIAL");
  });

  it("tolerates a 23505 carrying no constraint or detail fields", async () => {
    // Not every driver populates them, and an unguarded read would throw
    // inside the catch — turning a reported collision into an aborted pass.
    const { db } = dbBlocking(new Set([CLICKHOUSE]), () =>
      Object.assign(new Error("duplicate key"), { code: "23505" }),
    );
    const result = await seedBuiltinDatasourceCatalog(db);
    expect(result.blockedSlugs).toEqual([CLICKHOUSE]);
    const perRow = logged.find(
      (c) => c.level === "warn" && (c.payload as { slug?: unknown }).slug === CLICKHOUSE,
    );
    // Both diagnostics absent — and the raw message is the ONLY thing left
    // saying what happened, which is why it is on the payload.
    expect(perRow?.payload).toMatchObject({
      constraint: undefined,
      detail: undefined,
      err: "duplicate key",
    });
  });
});
