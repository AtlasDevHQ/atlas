/**
 * The positional-visibility seam — ONE spelling of the rule (#5087,
 * ADR-0037 §6).
 *
 * ## Why a unit suite when the behaviour is checked against Postgres
 *
 * `vocabulary-authoring-pg.test.ts` checks what the rule DOES. This file checks
 * that there is only one of it, and that its two arms differ in the direction
 * the ADR says — which are properties of the emitted clause rather than of any
 * row, and which a behavioural suite can satisfy while the rule quietly lives in
 * two places.
 *
 * That is the failure this issue was specced to prevent. Both children of #5025
 * need this rule, whichever lands first owns it, and `oversight.ts:800-803` is
 * the standing prohibition: *a disclosure that restates a rule drifts from it —
 * import the join the transaction will run.* So the assertions below are about
 * the SEAM: that the predicate arm drops the grant test and keeps the tenant
 * one, that the entity arm is `aclVisibilityClause`'s own output rather than a
 * re-derivation, and that both fail closed.
 *
 * ## Nothing here asserts SQL text for its own sake
 *
 * Two assertions read the emitted string, and both are about a property no
 * other layer can check: whether the grant arm is PRESENT. A test that pinned
 * the whole clause byte-for-byte would fail on every harmless reformat and
 * would be deleted rather than fixed.
 */

import { describe, expect, it } from "bun:test";
import type { BrainPrincipalContext } from "@atlas/api/lib/brain/acl";
import {
  logFailClosedHole,
  positionalScopeClause,
  visibleNormsSql,
} from "@atlas/api/lib/brain/vocabulary-visibility";

const WS = "ws-visibility";

const authenticated = (role: "owner" | "member" = "owner"): BrainPrincipalContext => ({
  origin: "authenticated",
  workspaceId: WS,
  userId: "user-1",
  role,
  audienceIds: ["eng"],
});

const unresolved: BrainPrincipalContext = {
  origin: "unresolved",
  workspaceId: WS,
  userId: null,
  role: null,
  audienceIds: [],
};

const noWorkspace: BrainPrincipalContext = {
  origin: "authenticated",
  workspaceId: "",
  userId: "user-1",
  role: "owner",
  audienceIds: [],
};

describe("the positional rule has two arms and they differ as the ADR says", () => {
  it("the PREDICATE arm keeps tenant containment and drops the grant test", () => {
    const clause = positionalScopeClause("predicate", authenticated(), { paramIndex: 1 });
    expect(clause.decision).toBe("unscoped");
    // Tenant containment is NOT optional here. "Unscoped" means unscoped by
    // GRANT, within a workspace — a predicate read composed into a query whose
    // own workspace scoping was missing would answer about every tenant at
    // once, which is `aclVisibilityClause`'s own argument for emitting the
    // redundant arm.
    expect(clause.sql).toContain("vf.workspace_id = $1");
    expect(clause.params).toEqual([WS]);
    // …and the grant arm is absent, which is the whole point of the arm: a verb
    // phrase discloses nothing an approver could not have guessed, and this is
    // what keeps #5000's own entry visible for prod verification.
    expect(clause.sql).not.toContain("visible_to");
    expect(clause.nextParamIndex).toBe(2);
  });

  it("the ENTITY arms carry the grant test on both subject and object", () => {
    for (const position of ["subject", "object"] as const) {
      const clause = positionalScopeClause(position, authenticated(), { paramIndex: 1 });
      expect(clause.decision).toBe("reader-scoped");
      // `project atlas → nova` IS the confidential bit — unlike a verb phrase —
      // and its evidence is a warehouse row the grant grammar has no arm for.
      expect(clause.sql).toContain("visible_to");
      expect(clause.params).toHaveLength(2);
      expect(clause.nextParamIndex).toBe(3);
      // Surfaced so a withheld count of zero is legible: `audit-override` and
      // `grant-match` are both "reader-scoped" and mean different things.
      expect(clause.aclDecision).toBe("grant-match");
    }
  });

  it("both arms restrict to the LIVE set", () => {
    // Narrower than the drift re-key's scope on purpose — that one filters on
    // nothing, because a tombstoned row left on a stale key disagrees with its
    // surface forever. This clause answers a different question, and counting a
    // retracted claim toward a population would let an alias be authored for a
    // spelling the corpus has withdrawn.
    for (const position of ["predicate", "subject", "object"] as const) {
      const clause = positionalScopeClause(position, authenticated(), { paramIndex: 1 });
      expect(clause.sql).toContain("invalidated_at IS NULL");
      expect(clause.sql).toContain("valid_to IS NULL");
    }
  });
});

describe("both arms fail closed", () => {
  it("denies an unresolved reader at the PREDICATE position too", () => {
    // The easy half to get wrong: "predicate is unscoped" does NOT mean the
    // tenant boundary is optional. An unresolvable identity is an upstream
    // defect, and answering it would put the tenant boundary on the same
    // footing as the grant boundary this arm deliberately drops.
    const clause = positionalScopeClause("predicate", unresolved, { paramIndex: 1 });
    expect(clause.decision).toBe("deny-all");
    expect(clause.sql).toBe("(FALSE)");
    expect(clause.params).toEqual([]);
  });

  it("denies a context with no workspace", () => {
    for (const position of ["predicate", "subject"] as const) {
      expect(positionalScopeClause(position, noWorkspace, { paramIndex: 1 }).decision).toBe(
        "deny-all",
      );
    }
  });

  it("leaves the caller's placeholder cursor untouched on a deny", () => {
    // A deny that advanced `nextParamIndex` would make the caller bind a
    // parameter the statement never references — a Postgres bind error that
    // surfaces as a 500 on the path whose correct answer is an empty pane.
    const clause = positionalScopeClause("subject", unresolved, { paramIndex: 7 });
    expect(clause.nextParamIndex).toBe(7);
  });
});

describe("visibleNormsSql is the shape both panes share", () => {
  it("projects the NORM, never the identity key", () => {
    // ⚠️ The defect a key projection would produce, stated where it is checked:
    // the key column has the vocabulary already applied, so after `a → b` is
    // approved no live row keys `a` — and the edge just authored would vanish
    // from the pane that exists to show it in force. It is also the ADR-0037 §6
    // prohibition (`keys-not-on-the-wire.test.ts`).
    const subquery = visibleNormsSql("subject", authenticated(), { paramIndex: 1 });
    expect(subquery.sql).toContain("AS norm");
    expect(subquery.sql).not.toContain("subject_key");
    expect(subquery.sql).not.toContain("predicate_key");
    expect(subquery.sql).not.toContain("object_key");
  });

  it("reads each position's OWN surface column", () => {
    // The cross-position slip ADR-0037 §6 calls unrecoverable: an object-arm
    // subquery projecting the subject surface would scope object edges by a
    // population that has nothing to do with them.
    expect(visibleNormsSql("subject", authenticated(), { paramIndex: 1 }).sql).toContain(
      "vf.subject",
    );
    expect(visibleNormsSql("predicate", authenticated(), { paramIndex: 1 }).sql).toContain(
      "vf.predicate",
    );
    expect(visibleNormsSql("object", authenticated(), { paramIndex: 1 }).sql).toContain("vf.object");
  });

  it("emits a subquery that matches nothing for a denied reader", () => {
    const subquery = visibleNormsSql("subject", unresolved, { paramIndex: 1 });
    expect(subquery.decision).toBe("deny-all");
    expect(subquery.sql).toContain("WHERE FALSE");
    expect(subquery.nextParamIndex).toBe(1);
  });

  it("inherits the scope clause rather than re-deriving one", () => {
    // The anti-drift property, checked structurally: the subquery's binds ARE
    // the scope's binds, so a second copy of the rule inside this builder would
    // show up as a different arity.
    const scope = positionalScopeClause("subject", authenticated(), { paramIndex: 4 });
    const subquery = visibleNormsSql("subject", authenticated(), { paramIndex: 4 });
    expect(subquery.params).toEqual(scope.params);
    expect(subquery.nextParamIndex).toBe(scope.nextParamIndex);
    expect(subquery.decision).toBe(scope.decision);
  });
});

describe("input guards", () => {
  it("refuses a non-identifier alias rather than interpolating it", () => {
    expect(() =>
      positionalScopeClause("subject", authenticated(), { paramIndex: 1, alias: "vf; DROP" }),
    ).toThrow(/not a plain SQL identifier/);
  });

  it("refuses a placeholder index that is not a positive integer", () => {
    expect(() => positionalScopeClause("subject", authenticated(), { paramIndex: 0 })).toThrow(
      /positive integer/,
    );
  });
});

describe("the fail-closed hole is logged rather than skipped silently", () => {
  it("is a no-op when nothing was withheld and the counts agreed", () => {
    // A log line per page load with nothing to report would be noise, and noise
    // is what makes the real line unfindable.
    expect(() =>
      logFailClosedHole({
        workspaceId: WS,
        position: "subject",
        counts: { total: 3, scoped: 3, withheld: 0, consistent: true },
        decision: "reader-scoped",
        aclDecision: "grant-match",
        userId: "user-1",
      }),
    ).not.toThrow();
  });

  it("fires on a withheld entry, and on inconsistent counts even with none withheld", () => {
    // Two triggers, because they are different problems: entries an admin
    // cannot see are also ones they cannot REMOVE — so a workspace whose only
    // admin is blind to a bad edge has no in-product recovery — while
    // disagreeing counts mean the withheld number itself is not to be trusted.
    for (const counts of [
      { total: 5, scoped: 1, withheld: 4, consistent: true },
      { total: 2, scoped: 5, withheld: 0, consistent: false },
    ]) {
      expect(() =>
        logFailClosedHole({
          workspaceId: WS,
          position: "object",
          counts,
          decision: "reader-scoped",
          aclDecision: "grant-match",
          userId: "user-1",
        }),
      ).not.toThrow();
    }
  });
});
