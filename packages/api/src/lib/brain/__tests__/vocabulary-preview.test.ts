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
 *   - **an object-position alias is `structurallyEmpty`, not zero.** "0 pairs"
 *     and "this position cannot produce pairs" are the same number and opposite
 *     facts.
 *   - **an unresolvable reader THROWS.** An empty pair list renders as "this
 *     approval arms nothing", the false all-clear the surface exists to prevent.
 *   - **no key reaches the returned value.** ADR-0037 §6's prohibition, and the
 *     request type takes a SURFACE for the same reason.
 */

import { describe, expect, it } from "bun:test";
import {
  BLAST_RADIUS_PAIR_MAX,
  loadBlastRadius,
  type BlastRadiusRequest,
} from "@atlas/api/lib/brain/vocabulary-preview";
import { BrainReaderUnresolvedError } from "@atlas/api/lib/brain/reader-context";
import type { BrainCandidateReader } from "@atlas/api/lib/brain/candidates";
import type { BrainPrincipalContext } from "@atlas/api/lib/brain/acl";

const WS = "ws-preview";

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
      expect(sql).toContain(") IS NOT TRUE");
      // `NOT EXISTS` inside the cardinality gate is a different and legitimate
      // construct, so the assertion targets the wrapper shape specifically.
      expect(sql).not.toContain("AND NOT (p.workspace_id");
      expect(sql).not.toContain("AND NOT (d.workspace_id");
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

describe("the object position is structurally empty, not zero", () => {
  it("reports a reason and runs no delta statement at all", async () => {
    const captures: Capture[] = [];
    const radius = await loadBlastRadius(reader(captures), ctx(), {
      kind: "alias-approval",
      position: "object",
      fromNorm: "nova",
      toNorm: "project atlas",
    });

    expect(radius.structurallyEmpty).toBe("object-position");
    expect(radius.arming.total).toBe(0);
    expect(radius.disarming.total).toBe(0);
    // Not merely "the answer was 0" — the question was never asked, because
    // `object_key` is not in the collision.
    expect(deltaStatements(captures)).toHaveLength(0);
  });

  it("the same holds for an object-position REMOVAL", async () => {
    const captures: Capture[] = [];
    const radius = await loadBlastRadius(reader(captures), ctx(), {
      kind: "alias-removal",
      position: "object",
      fromNorm: "nova",
    });
    expect(radius.structurallyEmpty).toBe("object-position");
    expect(deltaStatements(captures)).toHaveLength(0);
  });
});

describe("removal re-derives from the SURFACE, because the key column cannot tell the populations apart", () => {
  it("substitutes on a subtree membership test over the normalized surface", async () => {
    const captures: Capture[] = [];
    await loadBlastRadius(reader(captures), ctx(), {
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
    await loadBlastRadius(reader(captures), ctx(), {
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
      reader(captures, (sql) =>
        sql.includes("brain_predicate_cardinality\n        WHERE") ? [{ hit: 1 }] : undefined,
      ),
      ctx(),
      { kind: "cardinality-removal", predicateSurface: "reports to" },
    );

    // A removal's hypothetical SUBTRACTS the key from the gate, so the arming
    // side joins on a strictly narrower rule than it excludes — provably empty.
    expect(radius.arming.total).toBe(0);
    const deltas = deltaStatements(captures);
    expect(deltas.some((s) => s.includes("IS DISTINCT FROM $2"))).toBe(true);
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
    expect(radius.structurallyEmpty).toBe("already-single");
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
    expect(radius.structurallyEmpty).toBe("not-curated");
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
    expect(radius.arming.pairs[0]?.draftLabel).toBe("acme priced at 12");
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
    expect(radius.arming.total).toBe(5);
    expect(radius.arming.withheld).toBe(4);
    expect(radius.arming.truncated).toBe(false);
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
    expect(radius.arming.truncated).toBe(true);
    expect(radius.arming.pairs).toHaveLength(BLAST_RADIUS_PAIR_MAX);
    // Truncation dressed as an ACL boundary is what the wire type forbids.
    expect(radius.arming.withheld).toBe(0);
  });

  it("always reports the count as a FLOOR", async () => {
    // A flip is not a batch: it applies to every future claim in the slot. The
    // surface renders "at least N today, and every future claim in this slot",
    // and this flag is what makes that assertable rather than conventional.
    const radius = await loadBlastRadius(reader([]), ctx(), APPROVE_PREDICATE);
    expect(radius.floor).toBe(true);
  });
});
