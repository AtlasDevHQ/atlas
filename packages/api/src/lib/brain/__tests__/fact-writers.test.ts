/**
 * The writer set for `brain_facts` INSERTs (#5038).
 *
 * WHY THIS FILE EXISTS
 *   ADR-0037 T3 §7 deferred a UNIQUE index on the live claim tuple
 *   `(workspace_id, subject_key, predicate_key, object_key)`. #5038 decided
 *   **not to add it** — see the ADR amendment and the note at the top of
 *   `reconcile.ts` for the argument. Part of that argument is a fact about
 *   the tree rather than about the schema:
 *
 *     There are exactly TWO writers of `brain_facts`, and the one that
 *     races with itself takes a per-workspace advisory lock first.
 *
 *   A structural constraint is the backstop you want when you cannot
 *   enumerate your writers. We can enumerate them — so this file is the
 *   enumeration, asserted rather than believed. A third writer appearing is
 *   not a bug in itself; it is the event that makes #5038's decision worth
 *   RE-OPENING, and the whole point is that nobody would otherwise notice
 *   the premise had changed.
 *
 *   This is a source-text test and it says so: it proves what the tree
 *   CONTAINS, never what runs. `identity-pg.test.ts` owns the other half —
 *   that the index set on the live table is what this decision expects, and
 *   that the slot index is not UNIQUE for its own separate reason.
 */

import { describe, expect, test } from "bun:test";

// `src/`, from `src/lib/brain/__tests__/`. Resolved off `import.meta.url` and
// not `process.cwd()`: the isolated runner and a bare `bun test` disagree
// about the working directory, and a cwd-relative root would silently scan
// nothing under one of them.
const SRC_ROOT = new URL("../../../", import.meta.url).pathname;

/**
 * The two known writers, relative to `src/`, each with the lock it takes.
 *
 * `lock: null` is a claim, not an omission — see the import entry.
 */
const KNOWN_WRITERS: ReadonlyArray<{
  readonly file: string;
  readonly lock: string | null;
}> = [
  // The ingest path. Takes `RECONCILE_LOCK_SQL` as the FIRST statement inside
  // the transaction (`reconcile.ts`, the `withTransaction` callback), which is
  // what makes its read-then-insert corroboration lookup sound against another
  // reconcile of the same workspace.
  { file: "lib/brain/reconcile.ts", lock: "RECONCILE_LOCK_SQL" },
  // The region importer (ADR-0024). ⚠️ It takes the VOCABULARY lock, not the
  // reconcile one, and only on the legacy-keying arm — so it is NOT serialized
  // against live ingest. That gap is stated in #5038's decision as knowingly
  // open; it is recorded here rather than hidden behind a uniform-looking
  // table, because a reader checking "are all writers locked?" would otherwise
  // read a `VOCABULARY_LOCK_SQL` entry as a yes.
  { file: "api/routes/admin-migrate.ts", lock: null },
];

/** `INSERT INTO [schema.][\"]brain_facts[\"]`, plus the Drizzle builder half. */
const INSERTS_FACTS =
  /(insert\s+into\s+(?:[a-z_][\w$]*\s*\.\s*)?"?brain_facts"?)|(\.insert\(\s*(?:schema\s*\.\s*)?brainFacts\s*\))/i;

describe("brain_facts writer set (#5038)", () => {
  test("exactly the two known writers INSERT into brain_facts", async () => {
    const { Glob } = await import("bun");
    const found: string[] = [];
    let scanned = 0;

    for await (const file of new Glob("**/*.ts").scan({ cwd: SRC_ROOT, absolute: true })) {
      // Tests seed fixtures freely; migrations are DDL, not a runtime writer.
      if (file.includes("__tests__") || file.includes("/migrations/")) continue;
      scanned++;
      const source = await Bun.file(file).text();
      if (INSERTS_FACTS.test(source)) found.push(file.slice(SRC_ROOT.length));
    }

    // A moved or renamed directory would otherwise make every assertion below
    // pass having read nothing at all.
    expect(scanned, `no sources scanned under ${SRC_ROOT} — has the tree moved?`).toBeGreaterThan(
      100,
    );

    expect(
      found.sort(),
      "the set of brain_facts INSERT sites changed. #5038 declined the UNIQUE index on the live claim tuple partly BECAUSE the writers are enumerable and reconcile takes an advisory lock; a new writer means re-opening that decision, not extending this list",
    ).toEqual(KNOWN_WRITERS.map((w) => w.file).sort());
  });

  test("the ingest writer takes the reconcile advisory lock", async () => {
    // The positive half. Without it the test above passes just as well against
    // a `reconcile.ts` that dropped the lock entirely — which is the change
    // that would actually make the missing index bite, since corroboration is
    // a read-then-insert and the lock is the only thing serializing it.
    const source = await Bun.file(`${SRC_ROOT}lib/brain/reconcile.ts`).text();
    expect(source).toContain("RECONCILE_LOCK_SQL = `SELECT pg_advisory_xact_lock(");
    // Taken INSIDE the transaction callback. A `pg_advisory_xact_lock` issued
    // outside a transaction is released immediately on the autocommit
    // statement, so its presence in the file proves nothing on its own.
    expect(source).toMatch(
      /withTransaction\(async \(tx\) => \{\s*await tx\.query\(RECONCILE_LOCK_SQL,/,
    );
  });

  test("the import writer is recorded as NOT taking the reconcile lock", async () => {
    // Pinning the honest gap. If someone later serializes the importer against
    // ingest, this test fails and the `lock: null` note above — and #5038's
    // "knowingly still open" paragraph — stop being true and must be updated.
    // The failure direction is deliberate: an improvement should have to come
    // and correct the record, rather than leaving a stale caveat in the ADR.
    const entry = KNOWN_WRITERS.find((w) => w.file === "api/routes/admin-migrate.ts");
    expect(entry?.lock).toBeNull();
    const source = await Bun.file(`${SRC_ROOT}api/routes/admin-migrate.ts`).text();
    expect(
      source.includes("RECONCILE_LOCK_SQL"),
      "the region importer now takes the reconcile lock — good, but #5038's decision note says it does not. Update the note, the ADR amendment, and this test together",
    ).toBe(false);
  });
});
