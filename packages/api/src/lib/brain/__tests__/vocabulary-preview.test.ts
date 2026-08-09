/**
 * The blast-radius preview (#5025, ADR-0037 §6) — unit coverage.
 *
 * Every claim worth pinning here is about a SQL SHAPE or a REFUSAL, because
 * those are the two classes a green build hides. Whether the emitted statements
 * return the right rows against a real schema is `vocabulary-preview-pg.test.ts`'s
 * job, and the parity property that matters most — *the preview total equals
 * what the re-key actually changes* — can only be asserted there.
 *
 * The negatives this file exists for, in the order they would hurt:
 *
 *   - **the exclusion arm is spelled `IS NOT TRUE`.** A DEFENSIVE spelling, and
 *     the test below says so rather than claiming a kill it does not make: the
 *     two spellings are extensionally identical today, because every
 *     NULL-capable arm of the exclusion is shared with the JOIN and joining
 *     forces each one TRUE. `vocabulary-preview-pg.test.ts` measures that
 *     against a real `{"source": null}` pair. What this pins is the SPELLING,
 *     so the day an exclusion-only nullable arm appears the guard is already
 *     there.
 *   - **a predicate-position alias re-points the CARDINALITY lookup too.** The
 *     compound case ADR-0037 §6's amendment exists for is exactly the case a
 *     bundle that moved only the slot arm would report as zero.
 *   - **an object-position alias takes its OWN radius arm, and runs no
 *     supersession delta.** "0 pairs" and "this position cannot produce pairs"
 *     are the same number and opposite facts — and since #5088 the honest answer
 *     is neither, but the corroboration/tension change the decision actually
 *     makes. What stays pinned is that no delta statement runs at that position.
 *   - **an unresolvable reader THROWS.** An empty pair list renders as "this
 *     approval arms nothing", the false all-clear the surface exists to prevent.
 *   - **no key reaches the returned value.** ADR-0037 §6's prohibition, and the
 *     request type takes a SURFACE for the same reason.
 */

import { describe, expect, it } from "bun:test";
import {
  BLAST_RADIUS_PAIR_MAX,
  assertPlaceholdersBelowAclBase,
  loadBlastRadius,
  type BlastRadius,
  type BlastRadiusRequest,
  type StructurallyEmptyReason,
} from "@atlas/api/lib/brain/vocabulary-preview";
import { BrainReaderUnresolvedError } from "@atlas/api/lib/brain/reader-context";
import type { BrainCandidateReader } from "@atlas/api/lib/brain/candidates";
import type { BrainPrincipalContext } from "@atlas/api/lib/brain/acl";

const WS = "ws-preview";

/**
 * Narrow a radius to the computed branch.
 *
 * The union exists so a renderer cannot read `floor` on a branch where it is
 * meaningless; these tests pay the same one-line cost the future call site
 * will, which is the point of the shape.
 */
function computed(radius: BlastRadius): Extract<BlastRadius, { kind: "computed" }> {
  expect(radius.kind, `expected a computed radius, got ${JSON.stringify(radius)}`).toBe("computed");
  if (radius.kind !== "computed") throw new Error("unreachable");
  return radius;
}

/** Narrow a radius to the structurally-empty branch and return its reason. */
function emptyReason(radius: BlastRadius): StructurallyEmptyReason {
  expect(radius.kind, `expected a structurally-empty radius, got ${JSON.stringify(radius)}`).toBe(
    "structurally-empty",
  );
  if (radius.kind !== "structurally-empty") throw new Error("unreachable");
  return radius.reason;
}


function ctx(
  partial: Partial<Extract<BrainPrincipalContext, { origin: "authenticated" }>> = {},
): BrainPrincipalContext {
  return {
    origin: "authenticated",
    workspaceId: WS,
    userId: "user-1",
    role: "admin",
    audienceIds: [],
    ...partial,
  };
}

interface Capture {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/**
 * A recording reader that answers every statement with an empty result unless a
 * responder says otherwise.
 *
 * `COUNT(*)` statements must answer SOMETHING or the module throws — which is
 * itself a pinned behaviour below — so the default responder returns a zero
 * count for anything selecting one, and `[]` for everything else.
 */
function reader(
  captures: Capture[],
  responder?: (sql: string) => readonly unknown[] | undefined,
): BrainCandidateReader {
  return {
    query: async (sql: string, params?: unknown[]) => {
      captures.push({ sql, params: params ?? [] });
      const custom = responder?.(sql);
      if (custom !== undefined) return { rows: custom };
      if (sql.includes("delta_total")) return { rows: [{ delta_total: 0 }] };
      if (sql.includes("held_back")) return { rows: [{ held_back: 0 }] };
      return { rows: [] };
    },
  };
}

/** Only the statements that compute a delta — not the closure/probe reads. */
function deltaStatements(captures: readonly Capture[]): readonly string[] {
  return captures
    .map((c) => c.sql)
    .filter((sql) => sql.includes("FROM brain_facts d") && sql.includes("JOIN brain_facts p"));
}

/**
 * Split a delta statement into its JOIN half and its EXCLUSION half.
 *
 * ⚠️ Without this every `toContain` in the file is blind to WHICH SIDE of the
 * delta a substitution landed on — `deltaSql` puts both vocabularies into one
 * string. Measured: swapping `joinExprs`/`excludeExprs` (arming and disarming
 * exchanged) passed all 31 unit tests, and replacing the entire exclusion arm
 * with `AND TRUE` passed all 19 in this file. That is #5035's lesson in its
 * purest form — a pin derived from source text cannot falsify a change in what
 * that text means — and the fix is to assert POSITIONALLY.
 */
function halves(sql: string): { join: string; exclude: string } {
  const marker = "\n   WHERE";
  const at = sql.indexOf(marker);
  expect(at, "a delta statement must have a WHERE clause to split on").toBeGreaterThan(0);
  return { join: sql.slice(0, at), exclude: sql.slice(at) };
}

/**
 * Answer the "does this edge exist" probe affirmatively.
 *
 * ⚠️ Matched on the probe's full projection, not on `brain_vocabulary_edge`
 * alone — the removal delta's own recursive CTE walks that same table, so the
 * looser predicate also captured the delta statements and fed them `{hit: 1}`
 * where a count was expected.
 */
const EDGE_EXISTS = "SELECT 1 AS hit FROM brain_vocabulary_edge";
const edgeExists = (sql: string) => (sql.includes(EDGE_EXISTS) ? [{ hit: 1 }] : undefined);

const APPROVE_PREDICATE: BlastRadiusRequest = {
  kind: "alias-approval",
  position: "predicate",
  fromNorm: "is priced at",
  toNorm: "priced at",
};

describe("the exclusion arm's spelling", () => {
  // ⚠️ Scope note, because this test is easy to over-read and an earlier draft
  // of its name did: it pins a SPELLING, not a behavioural kill. `NOT (…)`
  // would return the same set today — every NULL-capable arm of the exclusion
  // (tier, `object_cmp`, a NULL slot key) is shared with the JOIN, and a row
  // only reaches the exclusion by joining, which forces each shared arm TRUE.
  // `vocabulary-preview-pg.test.ts` measures that against a real
  // `{"source": null}` pair. The spelling is kept because the equivalence holds
  // only while the exclusion has no nullable arm of its own.
  it("negates the other vocabulary with IS NOT TRUE rather than a bare NOT", async () => {
    const captures: Capture[] = [];
    await loadBlastRadius(reader(captures), ctx(), APPROVE_PREDICATE);

    const deltas = deltaStatements(captures);
    expect(deltas.length).toBeGreaterThan(0);
    for (const sql of deltas) {
      // ⚠️ Asserted on the EXCLUSION half only. A bare `toContain(") IS NOT
      // TRUE")` over the whole statement is vacuous — `subjectNotDifferentSql`
      // already emits `)) IS NOT TRUE` inside every collision predicate, so the
      // assertion passed on a statement with NO exclusion arm at all. Measured.
      const { exclude } = halves(sql);
      expect(exclude).toContain(") IS NOT TRUE");
      expect(exclude).not.toContain("AND NOT (p.workspace_id");
      expect(exclude).not.toContain("AND NOT (d.workspace_id");
    }
  });

  it("the exclusion arm actually EXISTS — the delta is a difference, not a listing", async () => {
    // The mutation the assertion above could not see: replacing the whole
    // exclusion with `AND TRUE` makes `arming` report every colliding pair
    // rather than the NEW ones. That is an over-disclosure that reads as a
    // catastrophic blast radius, and it passed every test in this file.
    const captures: Capture[] = [];
    await loadBlastRadius(reader(captures), ctx(), APPROVE_PREDICATE);

    for (const sql of deltaStatements(captures)) {
      const { exclude } = halves(sql);
      // The exclusion must name the FULL collision predicate of the other
      // vocabulary, not merely be present.
      expect(exclude).toContain("p.workspace_id = d.workspace_id");
      expect(exclude).toContain("brain_predicate_cardinality");
      expect(exclude).not.toContain("AND TRUE");
    }
  });

  it("ARMING is the side that joins on the hypothetical — asserted through the RESULT", async () => {
    // ⚠️ A counting assertion is NOT enough, and this is the second draft.
    // "Exactly two statements JOIN on the hypothetical" stays true when
    // `joinExprs`/`excludeExprs` are exchanged — the same statements exist,
    // attributed to the opposite direction — so the swap survived it. Measured.
    //
    // Answering the two vocabularies with DIFFERENT counts is what ties a
    // statement to the side that reported it. Under the swap, `arming` reports
    // the stored side's number and this fails.
    const SUB = "CASE WHEN d.predicate_key = $2";
    const radius = await loadBlastRadius(
      reader([], (sql) => {
        if (!sql.includes("delta_total")) return undefined;
        return halves(sql).join.includes(SUB) ? [{ delta_total: 7 }] : [{ delta_total: 3 }];
      }),
      ctx(),
      APPROVE_PREDICATE,
    );

    expect(computed(radius).arming.total).toBe(7);
    expect(computed(radius).disarming.total).toBe(3);
  });

  it("no statement joins on AND excludes the same vocabulary — that is a self-difference", async () => {
    const captures: Capture[] = [];
    await loadBlastRadius(reader(captures), ctx(), APPROVE_PREDICATE);
    const SUB = "CASE WHEN d.predicate_key = $2";
    for (const sql of deltaStatements(captures)) {
      const { join, exclude } = halves(sql);
      expect(join.includes(SUB) && exclude.includes(SUB)).toBe(false);
    }
  });
});

describe("a predicate-position alias moves the cardinality lookup with the slot", () => {
  it("re-points brain_predicate_cardinality at the hypothetical key", async () => {
    const captures: Capture[] = [];
    await loadBlastRadius(reader(captures), ctx(), APPROVE_PREDICATE);

    const arming = deltaStatements(captures)[0];
    expect(arming).toBeDefined();
    // The slot arm is substituted...
    expect(arming).toContain("CASE WHEN d.predicate_key = $2 THEN $3");
    // ...AND the cardinality lookup joins on the same substituted expression,
    // not on the stored column. A bundle that moved only the slot would emit
    // `c.predicate_key = d.predicate_key` here and report the compound case as
    // zero.
    expect(arming).toContain(
      "c.predicate_key = (CASE WHEN d.predicate_key = $2 THEN $3 ELSE d.predicate_key END)",
    );
  });

  it("a SUBJECT-position alias leaves the cardinality lookup on the stored column", async () => {
    // The complement, and it is what makes the assertion above meaningful
    // rather than a tautology about string interpolation: a subject alias does
    // not move `predicate_key`, so re-pointing the gate there would be wrong in
    // the over-disclosing direction.
    const captures: Capture[] = [];
    await loadBlastRadius(reader(captures), ctx(), {
      kind: "alias-approval",
      position: "subject",
      fromNorm: "acme",
      toNorm: "acme corp",
    });

    const arming = deltaStatements(captures)[0];
    expect(arming).toContain("CASE WHEN d.subject_key = $2 THEN $3");
    expect(arming).toContain("c.predicate_key = d.predicate_key");
    expect(arming).not.toContain("CASE WHEN d.predicate_key");
  });
});

describe("the object position gets its OWN radius, never a supersession delta", () => {
  // ⚠️ These two assertions INVERTED with #5088, and the inversion is the AC
  // landing rather than a rewording. They used to require
  // `structurally-empty: "object-position"` — the right refusal when the
  // corroboration/tension disclosure did not exist, and a second confident
  // silence once it did: the pane said *"Atlas cannot yet show you that"* about
  // the change the alias DOES make.
  //
  // What SURVIVES unchanged, and is the half that actually mattered, is the
  // second assertion in each: **no supersession delta statement runs.** The
  // collision never reads `object_key`, so a delta here would be a number about
  // a question this position cannot ask — and a renderer holding one would say
  // "at least 0 published claims become supersedable", the sentence the union
  // was split to make unrepresentable.

  it("computes the corroboration/tension radius and runs no supersession delta", async () => {
    const captures: Capture[] = [];
    const radius = await loadBlastRadius(reader(captures), ctx(), {
      kind: "alias-approval",
      position: "object",
      fromNorm: "nova",
      toNorm: "project atlas",
    });

    expect(radius.kind).toBe("object-position");
    if (radius.kind !== "object-position") throw new Error("unreachable");
    // `arming` / `disarming` are UNREADABLE on this branch — that is the union's
    // whole point, and it is what stops a renderer reading a supersession
    // sentence off a response that means something else entirely.
    expect(radius.staleEdgesPersist).toBe(true);
    expect(radius.floor).toBe(true);
    expect(deltaStatements(captures)).toHaveLength(0);
  });

  it("the same holds for an object-position REMOVAL", async () => {
    // ⚠️ `edgeExists` — the object arm asks the `no-such-edge` probe FIRST, and
    // a stub that answers "no edge" correctly gets a REASON rather than a
    // radius. Without the responder this test asserted the object arm on a
    // request that never reaches it.
    const captures: Capture[] = [];
    const radius = await loadBlastRadius(reader(captures, edgeExists), ctx(), {
      kind: "alias-removal",
      position: "object",
      fromNorm: "nova",
    });
    expect(radius.kind).toBe("object-position");
    expect(deltaStatements(captures)).toHaveLength(0);
  });

  it("⚠️ a removal with NO approved edge is a reason, not a zeroed radius", async () => {
    // The short-circuit runs before `structurallyEmptyReason`, which made
    // `no-such-edge` unreachable at this position — so a removal naming a norm
    // with no approved parent produced three honest zeros, which the pane
    // renders as a floor promise about a decision that does not exist.
    const captures: Capture[] = [];
    const radius = await loadBlastRadius(reader(captures), ctx(), {
      kind: "alias-removal",
      position: "object",
      fromNorm: "nova",
    });
    expect(emptyReason(radius)).toBe("no-such-edge");
    expect(deltaStatements(captures)).toHaveLength(0);
  });

  it("⚠️ an unreadable depth probe reaches the object radius's countsConsistent", async () => {
    // The unit suite proves `loadObjectPositionRadius` HONOURS the flag when it
    // is handed one. Nothing proved the object-removal arm hands it over — which
    // is exactly the half that was broken: mutating `probeDrifted:
    // subtree.probeDrifted` to `false` left both suites green.
    //
    // `subtreeHitBound` returns `probeDrifted: true` for any non-boolean `hit`.
    const captures: Capture[] = [];
    const radius = await loadBlastRadius(
      reader(captures, (sql) =>
        sql.includes(EDGE_EXISTS)
          ? [{ hit: 1 }]
          : sql.includes("bool_or(depth")
            ? [{ hit: "maybe" }]
            : undefined,
      ),
      ctx(),
      { kind: "alias-removal", position: "object", fromNorm: "nova" },
    );
    expect(radius.kind).toBe("object-position");
    if (radius.kind !== "object-position") throw new Error("unreachable");
    // ⚠️ A drifted probe is STATEMENT DRIFT, not a bound hit — the two are
    // different facts with different sentences, and only the first belongs here.
    expect(radius.subtreeTruncated).toBe(false);
    for (const s of [radius.corroborating, radius.separating, radius.tension]) {
      expect(s.countsConsistent).toBe(false);
    }
  });

  it("⚠️ a surface that norms away is STILL a reason, not a zeroed radius", async () => {
    // The one object-position path that must not reach the new arm: a decision
    // naming a surface made only of separators occupies no slot and can join
    // nothing, so "0 pairs would agree" would be the same confident false
    // all-clear one branch over. `unkeyable-surface` is the reason it already
    // has for exactly this shape.
    const captures: Capture[] = [];
    const radius = await loadBlastRadius(reader(captures), ctx(), {
      kind: "alias-approval",
      position: "object",
      fromNorm: "---",
      toNorm: "project atlas",
    });
    expect(emptyReason(radius)).toBe("unkeyable-surface");
    expect(deltaStatements(captures)).toHaveLength(0);
  });
});

describe("removal re-derives from the SURFACE, because the key column cannot tell the populations apart", () => {
  it("substitutes on a subtree membership test over the normalized surface", async () => {
    const captures: Capture[] = [];
    await loadBlastRadius(reader(captures, edgeExists), ctx(), {
      kind: "alias-removal",
      position: "predicate",
      fromNorm: "is priced at",
    });

    const sql = deltaStatements(captures)[0];
    expect(sql).toBeDefined();
    // The recursive walk down the approved-edge graph...
    expect(sql).toContain("WITH RECURSIVE subtree AS");
    expect(sql).toContain("e.to_norm = s.node");
    // ...and the membership test built from `identityKeySql`, the same
    // expression the re-key runs. A `lower()` here would be a third
    // implementation of `lexicalNorm` and the one that disagrees.
    expect(sql).toContain("IN (SELECT node FROM subtree)");
    expect(sql).toContain("translate(d.predicate");
    // ⚠️ NOT a key-to-key rewrite. `REKEY_DRIFTED_FACTS_SQL`'s header: of the
    // rows keyed `R`, only those whose norm chains through `a` move — and
    // sharing a key is precisely what the key column records.
    expect(sql).not.toContain("CASE WHEN d.predicate_key = $2 THEN");
  });

  it("bounds the walk so a corrupt cyclic store cannot spin an admin request", async () => {
    const captures: Capture[] = [];
    await loadBlastRadius(reader(captures, edgeExists), ctx(), {
      kind: "alias-removal",
      position: "subject",
      fromNorm: "acme",
    });
    expect(deltaStatements(captures)[0]).toContain("s.depth < 64");
  });
});

describe("the cardinality flip imports the held-back count rather than re-deriving it", () => {
  it("the arming total IS CARDINALITY_HELD_BACK_COUNT_SQL at a predicate scope", async () => {
    const captures: Capture[] = [];
    await loadBlastRadius(reader(captures), ctx(), {
      kind: "cardinality-flip",
      predicateSurface: "reports to",
    });

    const totals = captures.filter((c) => c.sql.includes("held_back"));
    expect(totals).toHaveLength(1);
    const sql = totals[0]!.sql;
    // #5027's statement, scoped to one predicate instead of one batch.
    expect(sql).toContain("AS held_back");
    expect(sql).toContain("d.predicate_key = $2");
    expect(sql).not.toContain("d.id = ANY(");
    // And it carries the arms the flip must not lose.
    expect(sql).toContain("jsonb_exists(p.provenance, 'source')");
    expect(sql).toContain("NOT EXISTS (");
  });

  it("un-curating asks the opposite question and can arm nothing", async () => {
    const captures: Capture[] = [];
    const radius = await loadBlastRadius(
      reader(captures, (sql) => {
        if (sql.includes("AS hit")) return [{ hit: 1 }];
        if (sql.includes("delta_total")) return [{ delta_total: 11 }];
        return undefined;
      }),
      ctx(),
      { kind: "cardinality-removal", predicateSurface: "reports to" },
    );

    // ⚠️ The value assertion that used to live here (`arming.total === 0`) is
    // NOT expressible at this level, and finding that out is why the responder
    // now answers non-zero. A mock does not evaluate SQL — it returned whatever
    // it was told — so `0 === 0` held under every implementation, including one
    // whose arming side joins on the broadest possible rule. Feeding it 11 made
    // the test fail, which is the correct outcome: the emptiness is a property
    // of the STATEMENT and only a real database can decide it.
    //
    // So the value lives in `vocabulary-preview-pg.test.ts` ("a CARDINALITY
    // removal disarms exactly the pairs the preview promised", which asserts
    // `arming.total === 0` against real rows), and what is asserted HERE is the
    // shape that makes it empty: the arming side joins on a rule strictly
    // NARROWER than the one it excludes, so the difference cannot contain a row.
    expect(computed(radius).disarming.total).toBe(11);
    const deltas = deltaStatements(captures);
    const unflip = "IS DISTINCT FROM $2";
    const arming = deltas.filter((sql) => halves(sql).join.includes(unflip));
    expect(arming.length).toBeGreaterThan(0);
    for (const sql of arming) {
      const { join, exclude } = halves(sql);
      // JOIN carries the subtracted gate; the exclusion carries the stored one.
      expect(join).toContain(unflip);
      expect(exclude).not.toContain(unflip);
    }
    // No imported held-back statement: that count answers "what would curating
    // arm", which is not this decision's question.
    expect(captures.some((c) => c.sql.includes("AS held_back"))).toBe(false);
  });

  it("an already-curated predicate has nothing to flip", async () => {
    const captures: Capture[] = [];
    const radius = await loadBlastRadius(
      reader(captures, (sql) => (sql.includes("AS hit") ? [{ hit: 1 }] : undefined)),
      ctx(),
      { kind: "cardinality-flip", predicateSurface: "reports to" },
    );
    expect(emptyReason(radius)).toBe("already-single");
    expect(deltaStatements(captures)).toHaveLength(0);
  });

  it("an uncurated predicate has nothing to un-curate, and says so DIFFERENTLY", async () => {
    // The two reasons render as opposite sentences. Collapsing them would tell
    // an approver their un-curation is a no-op *because the predicate is
    // already single*.
    const captures: Capture[] = [];
    const radius = await loadBlastRadius(reader(captures), ctx(), {
      kind: "cardinality-removal",
      predicateSurface: "reports to",
    });
    expect(emptyReason(radius)).toBe("not-curated");
  });
});

describe("the reader boundary", () => {
  it("throws rather than answering an unresolvable reader with an empty radius", async () => {
    const unresolved: BrainPrincipalContext = {
      origin: "unresolved",
      workspaceId: WS,
      userId: null,
      role: null,
      audienceIds: [],
    };
    await expect(
      loadBlastRadius(reader([]), unresolved, APPROVE_PREDICATE),
    ).rejects.toBeInstanceOf(BrainReaderUnresolvedError);
  });

  it("gates BOTH sides of every pair on the reader's own predicate", async () => {
    const captures: Capture[] = [];
    await loadBlastRadius(reader(captures), ctx(), APPROVE_PREDICATE);

    const pairs = captures.filter((c) => c.sql.includes("draft_label"));
    expect(pairs.length).toBeGreaterThan(0);
    for (const c of pairs) {
      // "something you cannot see will replace X" and "Y will replace something
      // you cannot see" each disclose half a claim's history.
      expect(c.sql).toContain("d.visible_to &&");
      expect(c.sql).toContain("p.visible_to &&");
    }
  });

  it("the UNSCOPED total carries no reader predicate", async () => {
    // `withheld` is only honest if the total is workspace-wide. A total that
    // silently agreed with the scoped pairs would report 0 withheld always.
    const captures: Capture[] = [];
    await loadBlastRadius(reader(captures), ctx(), APPROVE_PREDICATE);
    const totals = captures.filter((c) => c.sql.includes("delta_total"));
    expect(totals.length).toBeGreaterThan(0);
    for (const c of totals) expect(c.sql).not.toContain("visible_to &&");
  });

  it("refuses a total that did not read back as a number", async () => {
    // A degraded 0 would render as "this approval arms nothing" — a confident
    // false all-clear fabricated from query drift.
    await expect(
      loadBlastRadius(
        reader([], (sql) => (sql.includes("delta_total") ? [{ delta_total: "not-a-number" }] : undefined)),
        ctx(),
        APPROVE_PREDICATE,
      ),
    ).rejects.toThrow(/refusing to disclose a blast radius/);
  });
});

describe("the payload", () => {
  it("carries labels and never a key", async () => {
    const row = {
      draft_id: "d1",
      draft_label: "acme priced at 12",
      superseded_id: "p1",
      superseded_label: "acme priced at 10",
      scoped_total: 1,
    };
    const radius = await loadBlastRadius(
      reader([], (sql) =>
        sql.includes("draft_label") ? [row] : sql.includes("delta_total") ? [{ delta_total: 3 }] : undefined,
      ),
      ctx(),
      APPROVE_PREDICATE,
    );

    const serialized = JSON.stringify(radius);
    // ADR-0037 §6's prohibition — `keys-not-on-the-wire.test.ts` is the repo-wide
    // guard; this is the local one, on the surface that holds the keys in scope.
    expect(serialized).not.toContain("predicate_key");
    expect(serialized).not.toContain("subject_key");
    expect(serialized).not.toContain("predicateKey");
    expect(computed(radius).arming.pairs[0]?.draftLabel).toBe("acme priced at 12");
  });

  it("reports the workspace-wide remainder as `withheld`", async () => {
    const radius = await loadBlastRadius(
      reader([], (sql) =>
        sql.includes("draft_label")
          ? [
              {
                draft_id: "d1",
                draft_label: "a b c",
                superseded_id: "p1",
                superseded_label: "a b d",
                scoped_total: 1,
              },
            ]
          : sql.includes("delta_total")
            ? [{ delta_total: 5 }]
            : undefined,
      ),
      ctx(),
      APPROVE_PREDICATE,
    );
    expect(computed(radius).arming.total).toBe(5);
    expect(computed(radius).arming.withheld).toBe(4);
    expect(computed(radius).arming.truncated).toBe(false);
  });

  it("reports a clipped page as truncated and never folds it into withheld", async () => {
    const rows = Array.from({ length: BLAST_RADIUS_PAIR_MAX + 1 }, (_, i) => ({
      draft_id: `d${i}`,
      draft_label: "a b c",
      superseded_id: `p${i}`,
      superseded_label: "a b d",
      scoped_total: BLAST_RADIUS_PAIR_MAX + 1,
    }));
    const radius = await loadBlastRadius(
      reader([], (sql) =>
        sql.includes("draft_label")
          ? rows
          : sql.includes("delta_total")
            ? [{ delta_total: BLAST_RADIUS_PAIR_MAX + 1 }]
            : undefined,
      ),
      ctx(),
      APPROVE_PREDICATE,
    );
    expect(computed(radius).arming.truncated).toBe(true);
    expect(computed(radius).arming.pairs).toHaveLength(BLAST_RADIUS_PAIR_MAX);
    // Truncation dressed as an ACL boundary is what the wire type forbids.
    expect(computed(radius).arming.withheld).toBe(0);
  });

  it("always reports the count as a FLOOR", async () => {
    // A flip is not a batch: it applies to every future claim in the slot. The
    // surface renders "at least N today, and every future claim in this slot",
    // and this flag is what makes that assertable rather than conventional.
    const radius = await loadBlastRadius(reader([]), ctx(), APPROVE_PREDICATE);
    expect(computed(radius).floor).toBe(true);
  });
});

describe("an unkeyable surface is a disclosed REASON, never a zero", () => {
  // ⚠️ The path that used to return `structurallyEmpty: null` with two zeroed
  // sides — and `null` is documented as "the question was asked and answered",
  // so a request that was never computable rendered as "at least 0 today, and
  // every future claim in this slot". The module's signature failure, produced
  // by the module, on the one path nothing logged.
  //
  // `-`, `___` and `  ` all norm away, and `reconcile.ts`'s MALFORMED_CLAIM
  // guard tests `trim() === ""` — so it admits `-` and `___`, which is why
  // these rows exist in real corpora rather than being a hypothetical.
  for (const surface of ["-", "___", "  "]) {
    it(`refuses to compute for ${JSON.stringify(surface)} and says why`, async () => {
      const captures: Capture[] = [];
      const radius = await loadBlastRadius(reader(captures), ctx(), {
        kind: "alias-approval",
        position: "predicate",
        fromNorm: surface,
        toNorm: "priced at",
      });

      expect(emptyReason(radius)).toBe("unkeyable-surface");
      // Not merely zero — the question was never asked, and the branch carries
      // no number a renderer could mistake for one.
      expect(deltaStatements(captures)).toHaveLength(0);
    });
  }

  it("the same for a cardinality flip on a degenerate predicate", async () => {
    const radius = await loadBlastRadius(reader([]), ctx(), {
      kind: "cardinality-flip",
      predicateSurface: "-",
    });
    expect(emptyReason(radius)).toBe("unkeyable-surface");
  });

  it("an unresolvable reader is refused BEFORE the unkeyable check", async () => {
    // The ordering that used to be wrong: the fail-closed gate lived inside
    // `loadBlastRadiusSide`, i.e. after both early returns, so an unresolvable
    // reader asking about a degenerate norm got a clean zero instead of a
    // refusal. The gate is reachable only on the paths that did not need it.
    const unresolved: BrainPrincipalContext = {
      origin: "unresolved",
      workspaceId: WS,
      userId: null,
      role: null,
      audienceIds: [],
    };
    await expect(
      loadBlastRadius(reader([]), unresolved, {
        kind: "alias-approval",
        position: "predicate",
        fromNorm: "-",
        toNorm: "priced at",
      }),
    ).rejects.toBeInstanceOf(BrainReaderUnresolvedError);
  });
});

describe("countsConsistent — the half the clamp alone does not carry", () => {
  // `loadFactOversight` ships this flag precisely because "silently clamping
  // the delta to zero renders as 'nothing is hidden from you', which is the
  // pre-#4825 defect reproduced by its own fix." This module clamped, logged,
  // and shipped nothing — so a client rendered `withheld: 0` off two statements
  // that had just disagreed.
  const pairRow = (i: number, scopedTotal: unknown) => ({
    draft_id: `d${i}`,
    draft_label: "a b c",
    superseded_id: `p${i}`,
    superseded_label: "a b d",
    scoped_total: scopedTotal,
  });

  it("is true on a clean read", async () => {
    const radius = await loadBlastRadius(
      reader([], (sql) =>
        sql.includes("draft_label")
          ? [pairRow(1, 1)]
          : sql.includes("delta_total")
            ? [{ delta_total: 3 }]
            : undefined,
      ),
      ctx(),
      APPROVE_PREDICATE,
    );
    expect(computed(radius).arming.countsConsistent).toBe(true);
    expect(computed(radius).arming.withheld).toBe(2);
  });

  it("is CLEARED when the scoped count exceeds the workspace count", async () => {
    // The inversion. `withheld` clamps to 0, which reads as "nothing is hidden
    // from you" — true only if the two statements agreed, and they did not.
    const radius = await loadBlastRadius(
      reader([], (sql) =>
        sql.includes("draft_label")
          ? [pairRow(1, 9)]
          : sql.includes("delta_total")
            ? [{ delta_total: 1 }]
            : undefined,
      ),
      ctx(),
      APPROVE_PREDICATE,
    );
    expect(computed(radius).arming.withheld).toBe(0);
    expect(computed(radius).arming.countsConsistent).toBe(false);
  });

  it("is CLEARED when a row will not narrow — a dropped row is not an ACL-withheld one", async () => {
    // On the unclipped path the first floor does not apply, so a row that
    // failed to PARSE falls through and re-emerges inside `withheld`: "you lack
    // permission to see this" for a row that simply would not read.
    const radius = await loadBlastRadius(
      reader([], (sql) =>
        sql.includes("draft_label")
          ? [pairRow(1, 2), { draft_id: 42, draft_label: null }]
          : sql.includes("delta_total")
            ? [{ delta_total: 2 }]
            : undefined,
      ),
      ctx(),
      APPROVE_PREDICATE,
    );
    expect(computed(radius).arming.pairs).toHaveLength(1);
    expect(computed(radius).arming.countsConsistent).toBe(false);
    // ⚠️ `truncated` too — it is the wire flag that must never be folded into
    // `withheld`, and three floor/derivation mutations survived for want of one
    // assertion on it: dropping `|| scopedTotal > pairs.length`, and deleting
    // either floor.
    expect(computed(radius).arming.truncated).toBe(true);
  });

  it("is CLEARED when the scoped window will not parse", async () => {
    const radius = await loadBlastRadius(
      reader([], (sql) =>
        sql.includes("draft_label")
          ? [pairRow(1, "not-a-number")]
          : sql.includes("delta_total")
            ? [{ delta_total: 5 }]
            : undefined,
      ),
      ctx(),
      APPROVE_PREDICATE,
    );
    expect(computed(radius).arming.countsConsistent).toBe(false);
  });

  it("a NULL window is treated as drift, not as a finite zero", async () => {
    // `Number(null)` is a finite 0, which would skip both the max() and the
    // drift counter — the one shape of window drift that would otherwise go
    // entirely unlogged and unflagged.
    const radius = await loadBlastRadius(
      reader([], (sql) =>
        sql.includes("draft_label")
          ? [pairRow(1, null)]
          : sql.includes("delta_total")
            ? [{ delta_total: 4 }]
            : undefined,
      ),
      ctx(),
      APPROVE_PREDICATE,
    );
    expect(computed(radius).arming.countsConsistent).toBe(false);
  });

});

describe("subtreeTruncated — a scope blind spot, not a count disagreement", () => {
  // ⚠️ It used to clear `countsConsistent` on both sides. A truncated walk is
  // ONE statement asking about a smaller population than requested, not two
  // statements disagreeing — different sentences, different actions, so a
  // different field. The same argument that split `not-curated` from
  // `already-single`.
  const removal = {
    kind: "alias-removal",
    position: "predicate",
    fromNorm: "is priced at",
  } as const;

  it("is set when the walk hit the bound, and leaves countsConsistent alone", async () => {
    const radius = computed(
      await loadBlastRadius(
        reader([], (sql) =>
          sql.includes(EDGE_EXISTS) ? [{ hit: 1 }] : sql.includes("AS hit") ? [{ hit: true }] : undefined,
        ),
        ctx(),
        removal,
      ),
    );
    expect(radius.subtreeTruncated).toBe(true);
    // The two statements did NOT disagree — nothing about the counts is wrong,
    // they simply describe less than was asked about.
    expect(radius.disarming.countsConsistent).toBe(true);
  });

  it("is false on a complete walk", async () => {
    const radius = computed(
      await loadBlastRadius(
        reader([], (sql) =>
          sql.includes(EDGE_EXISTS) ? [{ hit: 1 }] : sql.includes("AS hit") ? [{ hit: false }] : undefined,
        ),
        ctx(),
        removal,
      ),
    );
    expect(radius.subtreeTruncated).toBe(false);
  });

  for (const [label, hit] of [
    ["an unreadable probe", "maybe"],
    ["a NULL probe — bool_or over an empty CTE, or a probe that lost its seed", null],
  ] as const) {
    it(`routes ${label} to countsConsistent, NOT to subtreeTruncated`, async () => {
      // ⚠️ The distinction, and it is the one round 2 collapsed. An unreadable
      // probe and a genuine bound hit are two different facts:
      // `subtreeTruncated`'s docstring asserts the SECOND specifically ("the
      // walk hit MAX_CHAIN_DEPTH"), so reporting a driver or query-shape drift
      // through it told an approver their approved-edge graph was cyclic or
      // deeper than 64 — sending them to inspect a vocabulary that may be
      // perfectly healthy.
      //
      // A drifted probe IS statement drift, which is what `countsConsistent`
      // already means. `false` remains the only value that answers "the walk
      // was complete"; `null` used to take that arm unlogged.
      const radius = computed(
        await loadBlastRadius(
          reader([], (sql) =>
            sql.includes(EDGE_EXISTS) ? [{ hit: 1 }] : sql.includes("AS hit") ? [{ hit }] : undefined,
          ),
          ctx(),
          removal,
        ),
      );
      expect(radius.subtreeTruncated, "nothing established that the graph is deep").toBe(false);
      expect(radius.arming.countsConsistent, "but the numbers are not trustworthy").toBe(false);
      expect(radius.disarming.countsConsistent).toBe(false);
    });
  }

  it("a genuine bound hit sets subtreeTruncated and leaves countsConsistent alone", async () => {
    const radius = computed(
      await loadBlastRadius(
        reader([], (sql) =>
          sql.includes(EDGE_EXISTS) ? [{ hit: 1 }] : sql.includes("AS hit") ? [{ hit: true }] : undefined,
        ),
        ctx(),
        removal,
      ),
    );
    expect(radius.subtreeTruncated).toBe(true);
    expect(radius.disarming.countsConsistent).toBe(true);
  });
});

describe("the closure refusals — both were untested, and a no-op survived each", () => {
  // `resolveEffectiveTarget`'s two throws had zero coverage: replacing either
  // guard with a no-op survived all 59 tests. The second is documented as
  // REACHABLE — 0189's CHECKs do not constrain `effective_target` to being a
  // norm, and the region importer rebuilds that table.
  const closureRow = (value: unknown) => (sql: string) =>
    sql.includes("brain_vocabulary_target") ? [{ effective_target: value }] : undefined;

  it("refuses when the closure column did not read back as a string (query-shape drift)", async () => {
    await expect(
      loadBlastRadius(reader([], closureRow(42)), ctx(), APPROVE_PREDICATE),
    ).rejects.toThrow(/did not read back as a string/);
  });

  it("refuses when the stored target NORMS AWAY — corruption, not drift", async () => {
    // ⚠️ The arm that used to be unreachable. Its sibling tested
    // `stored.trim() === ""` and claimed that was "unreachable from Postgres",
    // but 0189's CHECK is `effective_target <> ''` — and `'   ' <> ''` is TRUE,
    // so a whitespace-only target is storable and was being reported as a
    // QUERY-SHAPE problem. An operator was sent to look at the SELECT, the
    // driver and the migration state for a bad row.
    for (const degenerate of ["   ", "-", "___"]) {
      await expect(
        loadBlastRadius(reader([], closureRow(degenerate)), ctx(), APPROVE_PREDICATE),
        `"${degenerate}" must be reported as a corrupt closure, not as query drift`,
      ).rejects.toThrow(/norms away/);
    }
  });

  it("an empty string is the one shape the CHECK does reject, and still refuses", async () => {
    await expect(
      loadBlastRadius(reader([], closureRow("")), ctx(), APPROVE_PREDICATE),
    ).rejects.toThrow(/norms away|did not read back/);
  });
});

describe("the refusals name THIS surface", () => {
  it("an unresolvable reader is refused as `vocabulary-preview`, not as `oversight`", async () => {
    // ⚠️ The sole justification for adding a `BrainReadSurface` member was that
    // both previews produced byte-identical refusals. Reverting the constant to
    // "oversight" survived all 59 tests — the string appeared in no test in the
    // repo, so the distinction the change bought was the one thing unchecked.
    const unresolved: BrainPrincipalContext = {
      origin: "unresolved",
      workspaceId: WS,
      userId: null,
      role: null,
      audienceIds: [],
    };
    await expect(
      loadBlastRadius(reader([]), unresolved, APPROVE_PREDICATE),
    ).rejects.toThrow(/brain vocabulary-preview:/);
  });
});

describe("the curated probe reads only APPROVED entries", () => {
  it("a PENDING cardinality row does not make a flip structurally empty", async () => {
    // Dropping `AND status = 'approved'` from the probe survived all 59 tests:
    // the unit suite mocked the whole response and the pg suite only ever
    // seeded approved rows. With that mutation a PENDING proposal — which
    // `cardinalitySingleSql` deliberately ignores, because a repeat-gated
    // heuristic must never stamp `valid_to` with no human in the loop — makes
    // the flip report `already-single`: a fabricated structural empty on the
    // surface whose entire job is telling those apart.
    const captures: Capture[] = [];
    await loadBlastRadius(reader(captures), ctx(), {
      kind: "cardinality-flip",
      predicateSurface: "reports to",
    });
    const probe = captures.find((c) => c.sql.includes("AS hit"));
    expect(probe, "the curated probe must run").toBeDefined();
    expect(probe!.sql).toContain("status = 'approved'");
  });
});

describe("a removal with nothing to remove is a REASON, not computed zeros", () => {
  it("reports no-such-edge rather than `floor: true` over two empty sides", async () => {
    // ⚠️ The alias kinds had no analogue of `not-curated`, and the result was
    // worse than the case that member exists for: with no approved edge the
    // subtree is the seed alone and `removalKeyExpr` maps those rows onto the
    // key they already carry, so `hypothetical ≡ stored`, both deltas are
    // empty, and the caller got a COMPUTED radius of zeros. A renderer then
    // says "at least 0 today, and every future claim in this slot" for a
    // decision that does nothing at all.
    const captures: Capture[] = [];
    const radius = await loadBlastRadius(reader(captures), ctx(), {
      kind: "alias-removal",
      position: "predicate",
      fromNorm: "never aliased",
    });

    expect(emptyReason(radius)).toBe("no-such-edge");
    // And the question was never asked — no delta, and no depth probe either.
    expect(deltaStatements(captures)).toHaveLength(0);
  });

  it("an existing edge still computes", async () => {
    // The positive control. Without it the probe could refuse everything and
    // the assertion above would still pass.
    const radius = await loadBlastRadius(
      reader([], edgeExists),
      ctx(),
      { kind: "alias-removal", position: "predicate", fromNorm: "is priced at" },
    );
    expect(radius.kind).toBe("computed");
  });
});

describe("the placeholder guard", () => {
  // ⚠️ Deleting this guard's body survived the entire suite: no legal request
  // can construct a plan that trips it, because it exists to catch a FUTURE
  // edit in which an expression's hand-written `$n` literal and the plan's
  // `params` array drift apart. So it is exercised directly.
  //
  // The failure it converts into a refusal is silent and under-disclosing: an
  // expression referencing a placeholder at or above the ACL base binds the
  // reader's principal-token array as a slot key, joins nothing, and reports
  // "this decision changes nothing" on an admin console.
  it("refuses an expression that reaches into the reader's range", () => {
    expect(() => assertPlaceholdersBelowAclBase("x = $4", 4, "ws", "arming", "req-1")).toThrow(
      /references \$4, at or above the ACL base \$4/,
    );
  });

  it("names the request, so the 500 can be correlated", () => {
    // The sibling refusal (`readCount`) carries the requestId; this one was
    // added in the same round and did not, which is the rule it was fixed to.
    expect(() => assertPlaceholdersBelowAclBase("x = $9", 3, "ws", "arming", "req-7")).toThrow(
      /request req-7/,
    );
    expect(() => assertPlaceholdersBelowAclBase("x = $9", 3, "ws", "arming")).toThrow(
      /request unknown/,
    );
  });

  it("admits a plan whose highest placeholder is below the base", () => {
    expect(() => assertPlaceholdersBelowAclBase("a = $2 AND b = $3", 4, "ws", "arming")).not.toThrow();
  });

  it("admits a plan with no placeholders at all", () => {
    expect(() => assertPlaceholdersBelowAclBase("a = b", 2, "ws", "disarming")).not.toThrow();
  });
});

describe("the injectable depth bound can only NARROW", () => {
  // ⚠️ `maxChainDepth` sits on an exported options bag beside `requestId` and
  // is interpolated RAW into SQL at two sites, so a future route spreading a
  // parsed query into this call would hand a client control of statement text.
  // The clamp makes the seam incapable of widening past the shipped bound, of
  // going non-positive, and of being non-integral.
  async function emittedBound(maxChainDepth: number): Promise<string> {
    const captures: Capture[] = [];
    await loadBlastRadius(
      reader(captures, edgeExists),
      ctx(),
      { kind: "alias-removal", position: "predicate", fromNorm: "is priced at" },
      { maxChainDepth },
    );
    const sql = deltaStatements(captures)[0];
    expect(sql).toBeDefined();
    return sql as string;
  }

  it("cannot widen past the shipped bound", async () => {
    expect(await emittedBound(9999)).toContain("s.depth < 64");
  });

  it("clamps a non-positive value to 1 rather than emitting it", async () => {
    const sql = await emittedBound(-5);
    expect(sql).toContain("s.depth < 1");
    expect(sql).not.toContain("s.depth < -5");
  });

  it("truncates a fractional value", async () => {
    expect(await emittedBound(3.9)).toContain("s.depth < 3");
  });

  it("honours a legitimate narrowing", async () => {
    expect(await emittedBound(2)).toContain("s.depth < 2");
  });
});
