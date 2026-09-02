/**
 * `brain_facts.published_at` — the approval that dates itself (#5591).
 *
 * A rejection has always been datable (`invalidated_at`) and an approval never
 * was, which is why `gate-export.ts` reports `medianHoursToRetraction` rather
 * than `medianHoursToDecision`. Migration 0214 adds the positive verb's stamp.
 *
 * These are SOURCE-level pins rather than behavioural ones, and deliberately so:
 * the whole design is a claim about WHICH statements name the column, and the
 * dangerous edits are all additions of a writer or completions of a column list
 * that no runtime assertion would notice. The behavioural half lives in
 * `gate-export-pg.test.ts` and the promotion suites.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PROMOTE_CORRECTION_FACT_SQL } from "../correction";
import { PROMOTE_FACTS_SQL } from "../../content-mode/adapters/brain-facts";

const SRC = join(import.meta.dir, "..", "..", "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

describe("published_at — the two writers, and only those two", () => {
  it("the review gate's promote stamps it", () => {
    expect(PROMOTE_FACTS_SQL).toContain("published_at = now()");
    // Alongside `status`, in one statement: a promote that set the status and
    // left the stamp to a follow-up write would open a window in which a
    // published fact has no approval time, and the follow-up could fail.
    expect(PROMOTE_FACTS_SQL).toContain("status = 'published'");
  });

  it("the correction path's promote stamps it too", () => {
    // A correction-authored replacement is promoted in the transaction that
    // carries the human's correction. That is a gate decision made on a human's
    // authority, so leaving it unstamped would put a systematic hole in the
    // corpus exactly where the most deliberate decisions land.
    expect(PROMOTE_CORRECTION_FACT_SQL).toContain("published_at = now()");
    expect(PROMOTE_CORRECTION_FACT_SQL).toContain("status = 'published'");
  });

  it("both promotes keep the status = 'draft' predicate that makes the stamp un-movable", () => {
    // The stamp records WHEN a reviewer decided. A statement that could re-run
    // over an already-published row would rewrite that. The draft predicate
    // makes it unreachable rather than merely unlikely — which matters more for
    // this column than it did for `status`, where a re-run was idempotent.
    expect(PROMOTE_FACTS_SQL).toContain("status = 'draft'");
    expect(PROMOTE_CORRECTION_FACT_SQL).toContain("status = 'draft'");
  });
});

describe("published_at — the region boundary does not fabricate one", () => {
  it("the region import's brain_facts INSERT does not name it", () => {
    const src = read(join("api", "routes", "admin-migrate.ts"));
    const insert = /INSERT INTO brain_facts \(([^)]*)\)/.exec(src);
    expect(
      insert,
      "admin-migrate.ts no longer carries an `INSERT INTO brain_facts (…)` — re-point this pin",
    ).not.toBeNull();
    // ⚠️ The import restores a PRIOR gate decision rather than making a new one
    // — that is the allowlist's own justification for it writing `status` at
    // all. `now()` here would assert that every migrated fact was approved at
    // cutover, corrupting precisely the analytics this column exists to feed.
    // NULL is the honest value: the decision happened in another region and the
    // bundle does not carry it.
    expect(insert![1]).not.toContain("published_at");
  });

  it("the residency export does not project it, so no bundle can carry a stamp the importer would have to interpret", () => {
    const src = read(join("lib", "residency", "export.ts"));
    // Same precedent as `extraction_batch_id` and the triage marks: `export.ts`
    // enumerates `brain_facts` columns explicitly, so a new column rides the
    // bundle only by a deliberate edit. Carrying this one is a real design
    // question (what does an importer do with a foreign region's clock?) and
    // therefore a separate slice, not a side effect of adding the column.
    expect(src).not.toContain("f.published_at");
  });
});

describe("published_at — it reaches the evaluation corpus", () => {
  it("gate-export projects it on the fact grain", async () => {
    const { loadGateDecisions } = await import("../gate-export");
    const sql: string[] = [];
    const reader = {
      query: async (q: string) => {
        sql.push(q);
        return { rows: [] as readonly unknown[], rowCount: 0 };
      },
    };
    await loadGateDecisions(reader, "ws-1");
    // The point of the column, from #5338's side: a corpus that can date an
    // approval can draw a window on decision time. Forward-only — every row
    // predating 0214 reads NULL and is never backfilled.
    expect(sql.join("\n")).toContain("f.published_at");
  });

  it("pads the negative arm, so the UNION arms stay the same width", async () => {
    // ⚠️ The regression this exists for, caught by CI rather than locally: the
    // projection is `decided UNION ALL silent`, and a column added to the
    // fact-bearing arm alone makes Postgres refuse the whole statement with
    // "each UNION query must have the same number of columns". The negative arm
    // has no fact, so it carries a typed NULL placeholder for every fact
    // column — `published_at` included.
    const { loadGateDecisions } = await import("../gate-export");
    const sql: string[] = [];
    const reader = {
      query: async (q: string) => {
        sql.push(q);
        return { rows: [] as readonly unknown[], rowCount: 0 };
      },
    };
    await loadGateDecisions(reader, "ws-1");
    const joined = sql.join("\n");
    expect(joined).toContain("NULL::timestamptz AS published_at");

    // And the general form, so the next column added to either arm is caught
    // here rather than by a real Postgres: both SELECT lists, compared by the
    // count of comma-separated projections.
    const decided = /WITH decided AS \(\s*SELECT([\s\S]*?)\n\s*FROM brain_facts/.exec(joined);
    const silent = /silent AS \(\s*SELECT([\s\S]*?)\n\s*FROM brain_episodes/.exec(joined);
    expect(decided, "the `decided` CTE no longer parses — re-point this pin").not.toBeNull();
    expect(silent, "the `silent` CTE no longer parses — re-point this pin").not.toBeNull();
    const width = (body: string) => body.split(",").length;
    expect(
      width(silent![1]!),
      "the two UNION arms project a different number of columns — Postgres refuses the whole statement",
    ).toBe(width(decided![1]!));
  });
});
