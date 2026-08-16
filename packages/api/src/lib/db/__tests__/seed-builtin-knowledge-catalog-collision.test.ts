/**
 * #5239 — the foreign-id slug collision path of the built-in Knowledge Base
 * catalog seed.
 *
 * A row already holding one of the built-in slugs under a DIFFERENT id makes
 * the insert raise `23505` instead of silently no-op'ing (that is what
 * qualifying the conflict target to `(id)` buys). This file covers what the
 * seeder does with that: warn naming the row, keep going, and report the slug
 * — rather than logging plain success for a row it never wrote.
 *
 * ⚠️ SEPARATE FILE BECAUSE OF THE LOGGER MOCK. `createLogger(...)` is called at
 * module evaluation, so `mock.module("@atlas/api/lib/logger")` only reaches it
 * when the seeder is imported AFTER the mock — which rules out the static
 * imports `seed-builtin-knowledge-catalog.test.ts` (and the fixtures module it
 * pulls in) rely on. Everything here therefore goes through a top-level
 * `await import`.
 *
 * ⚠️ AND THE MOCK PROVES ONLY HALF OF IT. The rejections below are shaped by
 * hand, so this file cannot show that Postgres raises `23505` for this
 * situation at all — a fixture agreeing with the code by construction. That
 * half is `builtin-knowledge-catalog-seed-pg.test.ts`, against real Postgres.
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
 * which is precisely the claim AC-1 makes — "a warning naming the row, not a
 * success log".
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

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    debug: record("debug"),
  }),
  getRequestContext: () => undefined,
}));

const {
  seedBuiltinKnowledgeCatalog,
  BUILTIN_KNOWLEDGE_CATALOG_ROWS,
  BUILTIN_ZOOM_TRANSCRIPTS_CATALOG_ROW,
  BUILTIN_GITBOOK_CATALOG_ROW,
} = await import("@atlas/api/lib/db/seed-builtin-knowledge-catalog");

type SeedDb = Parameters<typeof seedBuiltinKnowledgeCatalog>[0];

/** A `pg` `DatabaseError` as the driver hands one back: untyped extra fields. */
const uniqueViolation = (slug: string): Error =>
  Object.assign(new Error(`duplicate key value violates unique constraint "plugin_catalog_slug_key"`), {
    code: "23505",
    constraint: "plugin_catalog_slug_key",
    detail: `Key (slug)=(${slug}) already exists.`,
  });

/**
 * A DB whose insert rejects for the named slugs and succeeds for the rest.
 *
 * The slug is read off the bound parameters rather than the SQL, so a seeder
 * that reordered its `VALUES` would not quietly reject a different row than the
 * test asked for.
 */
const dbBlocking = (
  blocked: ReadonlySet<string>,
  reject: (slug: string) => unknown = uniqueViolation,
): { db: SeedDb; attempted: string[] } => {
  const attempted: string[] = [];
  const db: SeedDb = {
    async query<T = unknown>(_sql: string, params?: unknown[]) {
      const slug = String(params?.[2]);
      attempted.push(slug);
      if (blocked.has(slug)) throw reject(slug);
      return { rows: [{ slug }] as T[] };
    },
  };
  return { db, attempted };
};

const ZOOM_SLUG = BUILTIN_ZOOM_TRANSCRIPTS_CATALOG_ROW.slug;
const GITBOOK_SLUG = BUILTIN_GITBOOK_CATALOG_ROW.slug;
const ALL_SLUGS = BUILTIN_KNOWLEDGE_CATALOG_ROWS.map((r) => r.slug);

describe("seedBuiltinKnowledgeCatalog — a slug held under a foreign id (#5239)", () => {
  beforeEach(() => {
    logged.length = 0;
  });

  it("warns naming the blocked row, and the warning is not a success log", async () => {
    const { db } = dbBlocking(new Set([ZOOM_SLUG]));
    await seedBuiltinKnowledgeCatalog(db);

    const perRow = logged.filter(
      (c) =>
        c.level === "warn" &&
        typeof c.payload === "object" &&
        c.payload !== null &&
        (c.payload as { slug?: unknown }).slug === ZOOM_SLUG,
    );
    expect(perRow).toHaveLength(1);
    // The row is named by BOTH of its identifiers: the slug is what collided,
    // the canonical id is what an operator has to go look at.
    expect(perRow[0]!.payload).toMatchObject({
      id: BUILTIN_ZOOM_TRANSCRIPTS_CATALOG_ROW.id,
      slug: ZOOM_SLUG,
      constraint: "plugin_catalog_slug_key",
      detail: `Key (slug)=(${ZOOM_SLUG}) already exists.`,
    });
    // No `info` may claim the pass simply completed.
    expect(logged.filter((c) => c.level === "info")).toHaveLength(0);
    const summary = logged.filter((c) => c.level === "warn" && c.message.includes("BLOCKED"));
    expect(summary).toHaveLength(1);
  });

  it("logs the plain success `info` — and no warning — when nothing is blocked", async () => {
    // The other half of the level claim. Without this, a seeder that warned
    // unconditionally would pass the case above.
    const { db } = dbBlocking(new Set());
    await seedBuiltinKnowledgeCatalog(db);
    expect(logged.filter((c) => c.level === "warn")).toHaveLength(0);
    expect(logged.filter((c) => c.level === "info")).toHaveLength(1);
  });

  it("seeds every remaining row — one collision does not abort the loop", async () => {
    // ⚠️ TWO blocked rows, not one, and neither of them last: a loop that
    // stopped at the first collision, and one that dropped only the tail, both
    // survive a single-collision fixture. Zoom is 13th of 14 and GitBook 6th,
    // so `blockedSlugs` (2) and `insertedSlugs` (12) are different sizes and
    // cannot be swapped without the counts disagreeing.
    const { db, attempted } = dbBlocking(new Set([GITBOOK_SLUG, ZOOM_SLUG]));
    const result = await seedBuiltinKnowledgeCatalog(db);

    expect(attempted).toEqual(ALL_SLUGS);
    expect(result.blockedSlugs).toEqual([GITBOOK_SLUG, ZOOM_SLUG]);
    expect(result.insertedSlugs).toEqual(ALL_SLUGS.filter((s) => s !== GITBOOK_SLUG && s !== ZOOM_SLUG));
    expect(result.insertedSlugs).toHaveLength(ALL_SLUGS.length - 2);
    // `inserted` still means "the pass wrote something", which it did.
    expect(result.inserted).toBe(true);
  });

  it("reports blocked and inserted as DIFFERENT lists, not one 'not inserted' set", async () => {
    // #5239's actual subject: before the fix a blocked row and a
    // present-and-correct row were both just "absent from insertedSlugs".
    const { db } = dbBlocking(new Set([ZOOM_SLUG]));
    const result = await seedBuiltinKnowledgeCatalog(db);
    expect(result.blockedSlugs).not.toEqual(result.insertedSlugs);
    expect(result.insertedSlugs).not.toContain(ZOOM_SLUG);
    expect(result.blockedSlugs).toContain(ZOOM_SLUG);
  });

  it("still propagates a non-unique-violation failure instead of warning past it", async () => {
    // The guard on the guard. A catch that treated every rejection as a benign
    // collision would demote a real outage — a dropped table, a dead pool — to
    // a warning and report a seeded catalog.
    const { db } = dbBlocking(new Set([ZOOM_SLUG]), () =>
      Object.assign(new Error("relation \"plugin_catalog\" does not exist"), { code: "42P01" }),
    );
    await expect(seedBuiltinKnowledgeCatalog(db)).rejects.toThrow(/does not exist/);
    expect(logged.filter((c) => c.level === "warn")).toHaveLength(0);
  });

  it("propagates a rejection that is not an object at all", async () => {
    // `err.code` on a thrown string is `undefined`, and reading it unguarded is
    // the CLAUDE.md type-narrowing rule this catch has to honour.
    const { db } = dbBlocking(new Set([ZOOM_SLUG]), (slug) => `pool exploded seeding ${slug}`);
    await expect(seedBuiltinKnowledgeCatalog(db)).rejects.toThrow();
  });

  it("classifies on the SQLSTATE code, not on the message", async () => {
    // A message-keyed catch would classify this as a collision and warn past a
    // failure that is nothing of the sort.
    const { db } = dbBlocking(new Set([ZOOM_SLUG]), () =>
      Object.assign(new Error("duplicate key value violates unique constraint"), { code: "XX000" }),
    );
    await expect(seedBuiltinKnowledgeCatalog(db)).rejects.toThrow(/duplicate key/);
    expect(logged.filter((c) => c.level === "warn")).toHaveLength(0);
  });

  it("tolerates a 23505 carrying no constraint or detail fields", async () => {
    // Not every driver populates them, and an unguarded read would throw
    // inside the catch — turning a reported collision into an aborted pass.
    const { db } = dbBlocking(new Set([ZOOM_SLUG]), () =>
      Object.assign(new Error("duplicate key"), { code: "23505" }),
    );
    const result = await seedBuiltinKnowledgeCatalog(db);
    expect(result.blockedSlugs).toEqual([ZOOM_SLUG]);
    const perRow = logged.find(
      (c) => c.level === "warn" && (c.payload as { slug?: unknown }).slug === ZOOM_SLUG,
    );
    expect(perRow?.payload).toMatchObject({ constraint: undefined, detail: undefined });
  });
});
