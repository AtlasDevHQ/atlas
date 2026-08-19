/**
 * The comparable retirement (#5321, bounded by #5233) — and the column-scoped
 * assertion its promotion-guard carve-out is held in place by.
 *
 * ## Why this file exists at all
 *
 * `scripts/check-brain-fact-promotion.sh` allowlists a FILE, not a column. The
 * entry for `entity-comparable-retire.ts` argues for exactly one write —
 * `object_cmp = NULL` — but the exemption it buys covers `status`,
 * `visible_to`, `valid_to` and the other four identity columns too, none of
 * which the module writes. The guard script records that cost and
 * `docs/development/content-mode.md` repeats it, but a recorded cost is a
 * policy and not a gate. THIS is the gate, and it is the same shape #5024 gave
 * the decide seam in `vocabulary-decide-pg.test.ts`.
 *
 * Deliberately NOT a `-pg` suite. The property is lexical — which columns one
 * constant names — so a database would add cost and prove nothing, and a
 * backstop that only ran where `TEST_DATABASE_URL` is set would be absent from
 * the local `--affected` loop, which is exactly where a new gated write first
 * appears.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ENTITY_COMPARABLE_RETIRE_SQL,
  retireEntityComparables,
} from "@atlas/api/lib/brain/entity-comparable-retire";
import type { ReconcileExecutor } from "@atlas/api/lib/brain/reconcile";

/** Records what it was asked, and answers with the rows it was handed. */
function fakeExecutor(rows: readonly unknown[]): {
  readonly tx: ReconcileExecutor;
  readonly calls: { sql: string; params: unknown[] }[];
} {
  const calls: { sql: string; params: unknown[] }[] = [];
  return {
    calls,
    tx: {
      query: async (sql, params) => {
        calls.push({ sql, params: params ?? [] });
        return { rows };
      },
    },
  };
}

describe("the comparable retirement's allowlist carve-out is column-scoped (#5321)", () => {
  it("writes `object_cmp` and NO other gated column", () => {
    const source = readFileSync(join(import.meta.dir, "..", "entity-comparable-retire.ts"), "utf8");
    const code = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
      .join("\n");

    // Non-vacuous on both sides: the comment stripper must have left real code
    // behind, AND the retirement must still be in it. Without the second line
    // this test passes loudest at the moment the statement is deleted.
    expect(code).toContain("UPDATE brain_facts");

    // EXACTLY ONE `UPDATE brain_facts`, and it is the retirement. The column
    // assertions below only ever read the one constant they are handed, so a
    // SECOND writer appearing in the file is invisible to them — and invisible
    // to the shell guard too, which cannot fire on an allowlisted file.
    expect(
      [...code.matchAll(/UPDATE\s+brain_facts\b/g)],
      "entity-comparable-retire.ts has more than one `UPDATE brain_facts` statement. The allowlist " +
        "entry in check-brain-fact-promotion.sh argues for ONE — the comparable retirement — so a " +
        "second writer needs its own argument, not an inherited one.",
    ).toHaveLength(1);

    // …and no other write SHAPE. An `INSERT INTO`, a `DELETE FROM`, or an
    // upsert's `DO UPDATE` half would be gated on a non-allowlisted file and is
    // unguarded here by construction.
    expect(
      code,
      "entity-comparable-retire.ts gained an INSERT or DELETE against `brain_facts`. The allowlist " +
        "entry argues for ONE retirement UPDATE; another write shape needs its own argument.",
    ).not.toMatch(/(INSERT\s+INTO|DELETE\s+FROM)\s+brain_facts\b/);

    // The gated set, PARSED out of the guard rather than restated beside it —
    // `expect(guard).toContain(column)` would only ever detect a column being
    // removed from the guard, never one being added, which is the gap that
    // matters here.
    const guard = readFileSync(
      join(import.meta.dir, "..", "..", "..", "..", "..", "..", "scripts", "check-brain-fact-promotion.sh"),
      "utf8",
    );
    const gated = /^UPDATE_GATED_COLUMNS='\((.*)\)'/m.exec(guard)?.[1];
    expect(gated, "check-brain-fact-promotion.sh no longer defines UPDATE_GATED_COLUMNS").toBeDefined();
    // `(pre_widening_)?visible_to` expands to both spellings; every other
    // alternative is a literal column name.
    const gatedColumns = (gated ?? "")
      .split("|")
      .flatMap((alt) =>
        alt === "(pre_widening_)?visible_to" ? ["visible_to", "pre_widening_visible_to"] : [alt],
      );
    // `object_cmp` is what the entry argues for; everything else the guard
    // gates is what it must NOT be read as licensing.
    const forbidden = gatedColumns.filter((c) => c !== "object_cmp");
    // Non-vacuous, and pinned against the sibling that is the easiest mistake
    // to make here: `subject_cmp` is the column this module's header spends a
    // warning block refusing, because the polarity is INVERTED at the subject —
    // nulling it deletes a guard rather than retiring a hazard.
    for (const required of ["status", "visible_to", "valid_to", "subject_cmp", "subject_key"]) {
      expect(forbidden, `the parsed gated set is missing \`${required}\``).toContain(required);
    }
    expect(forbidden.length).toBeGreaterThanOrEqual(8);

    // The SET clause only — everything between `SET` and the statement's own
    // `WHERE`. A whole-statement grep would fail on `WHERE ... object_cmp =
    // ANY(...)`, which is the retirement's own scoping predicate and legitimate.
    const setAt = ENTITY_COMPARABLE_RETIRE_SQL.indexOf("SET ");
    const whereAt = ENTITY_COMPARABLE_RETIRE_SQL.indexOf("WHERE ");
    expect(setAt).toBeGreaterThanOrEqual(0);
    expect(whereAt).toBeGreaterThan(setAt);
    // One `WHERE` in the statement, so the slice above is exactly the SET
    // clause — and a future CTE or subquery that adds a second fails here
    // loudly rather than quietly moving the boundary.
    expect([...ENTITY_COMPARABLE_RETIRE_SQL.matchAll(/WHERE /g)]).toHaveLength(1);
    const written = ENTITY_COMPARABLE_RETIRE_SQL.slice(setAt, whereAt);

    expect(written, "the retirement no longer writes `object_cmp`").toContain("object_cmp = NULL");
    for (const column of forbidden) {
      expect(
        written,
        `the retirement's SET clause writes \`${column}\`, which its allowlist carve-out does not ` +
          "argue for. An allowlist entry exempts a FILE, so the guard cannot catch this — that is " +
          "why this assertion exists.",
      ).not.toContain(`${column} =`);
    }
  });

  it("NULLs rather than re-keys, which is the whole safety argument", () => {
    // The carve-out turns on direction: this writer can only ever SUBTRACT a
    // supersession trigger, never add one. A `SET object_cmp = <anything>` is a
    // re-key and belongs at the alias-approval seam, so pin the literal.
    expect(ENTITY_COMPARABLE_RETIRE_SQL).toMatch(/SET\s+object_cmp\s*=\s*NULL\b/);
  });
});

describe("retireEntityComparables (#5321)", () => {
  it("retires the facts naming the ids it was handed, tagged", async () => {
    const { tx, calls } = fakeExecutor([{ id: "f1" }, { id: "f2" }]);

    const retired = await retireEntityComparables(tx, {
      workspaceId: "ws1",
      entityIds: ["e1", "e2"],
    });

    expect(retired).toBe(2);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toBe(ENTITY_COMPARABLE_RETIRE_SQL);
    // Whole comparable values, not bare ids — an equality against the tagged
    // text is what makes the retirement exact, per the constant's header.
    expect(calls[0]!.params).toEqual(["ws1", ["entity:e1", "entity:e2"]]);
  });

  it("drops blank ids rather than sending the malformed `entity:`", async () => {
    const { tx, calls } = fakeExecutor([{ id: "f1" }]);

    await retireEntityComparables(tx, { workspaceId: "ws1", entityIds: ["e1", "  ", ""] });

    expect(calls[0]!.params[1]).toEqual(["entity:e1"]);
  });

  it("issues NO statement when every id drops out, so a no-op stays a no-op", async () => {
    const { tx, calls } = fakeExecutor([]);

    const retired = await retireEntityComparables(tx, { workspaceId: "ws1", entityIds: ["", "   "] });

    expect(retired).toBe(0);
    // Not merely "returned 0" — the point is that the unindexed workspace-wide
    // scan is never built. The module's header rests on this: a steady-state
    // producer run re-mints the identical id set and short-circuits here.
    expect(calls).toHaveLength(0);
  });

  it("reports zero for an empty id list without touching the executor", async () => {
    const { tx, calls } = fakeExecutor([]);

    expect(await retireEntityComparables(tx, { workspaceId: "ws1", entityIds: [] })).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
