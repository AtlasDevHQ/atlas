/**
 * The object-position radius's REFUSALS and DRIFT accounting (#5088).
 *
 * ## Why this exists beside a `-pg` suite
 *
 * `vocabulary-pending.test.ts`'s reason, and the panel measured it here: three
 * branches in `vocabulary-object-radius.ts` are structurally unreachable from
 * Postgres — `COUNT(*)` cannot be NULL, `jsonb` and `int` always narrow, and no
 * legal `BlastRadiusRequest` can build a plan whose `$n` literals collide with
 * the reader's range. Deleting all three left the whole runnable suite green.
 *
 * They are not incidental branches. Each one is the difference between an
 * approver reading *"this alias changes nothing about what agrees"* as a fact
 * and reading it as a number nothing established — which is the sentence this
 * module was written to replace.
 *
 * The sibling guard in `vocabulary-preview.ts` (*"refuses a total that did not
 * read back as a number"*) has had a test since #5086. This module is the same
 * shape and did not get one.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { BrainPrincipalContext } from "@atlas/api/lib/brain/acl";
import type { BrainCandidateReader } from "@atlas/api/lib/brain/candidates";

const errorCalls: { payload: Record<string, unknown>; msg: string }[] = [];
const warnCalls: { payload: Record<string, unknown>; msg: string }[] = [];
void mock.module("@atlas/api/lib/logger", () => {
  const capture =
    (into: typeof errorCalls) =>
    (payload: unknown, msg?: unknown): void => {
      if (typeof payload === "object" && payload !== null) {
        into.push({
          payload: payload as Record<string, unknown>,
          msg: typeof msg === "string" ? msg : "",
        });
      }
    };
  const logger = {
    info: () => {},
    debug: () => {},
    error: capture(errorCalls),
    warn: capture(warnCalls),
    child: () => logger,
  };
  return {
    createLogger: () => logger,
    getLogger: () => logger,
    getRequestContext: () => ({ requestId: "test-req" }),
    withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
    redactPaths: [] as string[],
    scrubErrSerializer: (err: unknown) => err,
    scrubLogFormatter: (obj: unknown) => obj,
    hashShareToken: (token: string) => token,
    setLogLevel: () => {},
    ACTOR_KINDS: ["user", "system"] as const,
  };
});

const { loadObjectPositionRadius, OBJECT_RADIUS_PAIR_MAX } = await import(
  "@atlas/api/lib/brain/vocabulary-object-radius"
);

const WS = "ws-object-radius-unit";

const owner: BrainPrincipalContext = {
  origin: "authenticated",
  workspaceId: WS,
  userId: "user-1",
  role: "owner",
  audienceIds: ["eng"],
};

/** The approval plan every legal request builds — `$2` from-key, `$3` to-key. */
const APPROVAL_PLAN = {
  keyExpr: (alias: string) =>
    `(CASE WHEN ${alias}.object_key = $2 THEN $3 ELSE ${alias}.object_key END)`,
  params: ["bob", "bobby"] as const,
  ctes: [] as readonly string[],
  // ⚠️ REQUIRED on the plan, so "no walk" and "forgot the probe" are different
  // keystrokes rather than the same omission.
  probeDrifted: false,
};

const pairRow = (over: Record<string, unknown> = {}) => ({
  left_id: "fact-1",
  left_label: "widget reports to Bob",
  right_id: "fact-2",
  right_label: "widget reports to Bobby",
  scoped_total: 1,
  ...over,
});

function reader(
  responder: (sql: string) => readonly unknown[] | undefined,
): BrainCandidateReader {
  return {
    query: async (sql: string) => {
      const custom = responder(sql);
      if (custom !== undefined) return { rows: custom };
      if (sql.includes("delta_total")) return { rows: [{ delta_total: 0 }] };
      return { rows: [] };
    },
  };
}

/** Answer every total with `n` and every pair page with `rows`. */
function simple(n: unknown, rows: readonly unknown[] = []): BrainCandidateReader {
  return reader((sql) => (sql.includes("delta_total") ? [{ delta_total: n }] : rows));
}

// ⚠️ RESET between tests. Every log assertion here is a `.some(...)`, so without
// this a later test can be satisfied by an earlier one's entry — the sibling
// suite has had this `beforeEach` from the start and this file did not.
beforeEach(() => {
  errorCalls.length = 0;
  warnCalls.length = 0;
});

describe("⚠️ a total that did not read back as a number REFUSES, never degrades to 0", () => {
  it("throws, and logs first with the requestId", async () => {
    // A degraded 0 renders as "this alias changes nothing about what agrees" —
    // the confident false all-clear this whole module was added to replace,
    // fabricated from query drift on an admin console. Unreachable from
    // Postgres (`COUNT(*)` cannot be NULL), which is exactly why nothing else
    // can test it. Its sibling in `vocabulary-preview.ts` has had this test
    // since #5086.
    await expect(
      loadObjectPositionRadius(simple("not-a-number"), owner, APPROVAL_PLAN, {
        requestId: "req-7",
      }),
    ).rejects.toThrow(/did not read back as a number/);
    expect(errorCalls.some((c) => c.payload.requestId === "req-7")).toBe(true);
  });

  it("POSITIVE CONTROL — a readable total is returned rather than thrown", async () => {
    // Without this, an unconditional throw satisfies the assertion above.
    const radius = await loadObjectPositionRadius(simple(3), owner, APPROVAL_PLAN);
    expect(radius.corroborating.total).toBe(3);
    expect(radius.staleEdgesPersist).toBe(true);
  });
});

describe("⚠️ a plan reaching into the reader's placeholder range is REFUSED at the seam", () => {
  it("throws naming the placeholder and the ACL base", async () => {
    // The plan carries HAND-WRITTEN `$n` literals while `aclBase` is derived
    // from `params.length`, so a drift between them makes the reader's
    // visibility predicate bind against an object key — joining nothing and
    // reporting that the decision changes nothing. Silent, and in the
    // under-disclosing direction.
    //
    // ⚠️ The shipped margin is ONE placeholder (`highest` 3 against `aclBase`
    // 4), so this fires on the very next param anyone adds — and until now
    // nothing measured that it fires at all.
    await expect(
      loadObjectPositionRadius(
        simple(0),
        owner,
        { ...APPROVAL_PLAN, keyExpr: (alias) => `(${alias}.object_key = $9)` },
        { requestId: "req-8" },
      ),
    ).rejects.toThrow(/references \$9, at or above the ACL base \$4/);
    expect(errorCalls.some((c) => c.payload.highest === 9)).toBe(true);
  });

  it("scans the CTEs too, not only the key expression", async () => {
    // `removalKeyExpr`'s subtree walk binds the workspace, the seed key and the
    // position, so a plan that grew the walk without growing `params` has to
    // trip here rather than in production.
    await expect(
      loadObjectPositionRadius(
        simple(0),
        owner,
        { ...APPROVAL_PLAN, ctes: ["subtree AS (SELECT $8::text AS node)"] },
        {},
      ),
    ).rejects.toThrow(/references \$8/);
  });

  it("POSITIVE CONTROL — the shipped approval plan passes the guard", async () => {
    await expect(
      loadObjectPositionRadius(simple(0), owner, APPROVAL_PLAN),
    ).resolves.toBeDefined();
  });
});

describe("⚠️ a dropped row is never reported as an ACL-withheld one", () => {
  it("clears countsConsistent when a pair row will not narrow", async () => {
    // `withheld` means "the grant kept this back". A row that simply would not
    // PARSE re-emerges inside that number unless `drifted` says otherwise —
    // i.e. "you lack permission to see this" for a query-shape change. Both
    // cases log, but only this flag reaches the approver.
    const radius = await loadObjectPositionRadius(
      simple(5, [pairRow(), pairRow({ left_label: 42 })]),
      owner,
      APPROVAL_PLAN,
    );
    expect(radius.corroborating.countsConsistent).toBe(false);
    expect(warnCalls.some((c) => c.msg.includes("unreadable column"))).toBe(true);
  });

  it("clears it when the scoped window will not narrow", async () => {
    const radius = await loadObjectPositionRadius(
      simple(5, [pairRow({ scoped_total: "" })]),
      owner,
      APPROVAL_PLAN,
    );
    // `""` specifically — `Number("")` is a finite 0, the shape that reads as
    // "no rows" when it means "the column drifted".
    expect(radius.corroborating.countsConsistent).toBe(false);
  });

  it("POSITIVE CONTROL — clean rows are reported as facts", async () => {
    const radius = await loadObjectPositionRadius(
      simple(2, [pairRow({ scoped_total: 2 }), pairRow({ left_id: "f3", scoped_total: 2 })]),
      owner,
      APPROVAL_PLAN,
    );
    expect(radius.corroborating.countsConsistent).toBe(true);
    expect(radius.corroborating.withheld).toBe(0);
    expect(radius.corroborating.pairs).toHaveLength(2);
  });
});

describe("⚠️ an unreadable depth probe clears countsConsistent, on every side", () => {
  it("is threaded from the caller's plan rather than dropped", async () => {
    // `SubtreeProbe` carries two facts with different destinations: a genuine
    // bound hit is a radius-wide SCOPE statement, and an unreadable probe is
    // STATEMENT DRIFT. The object arm read only the first, so a probe that did
    // not answer produced a fully trustworthy-looking radius over a walk nobody
    // could confirm — on the one verb where the walk decides which rows move.
    const radius = await loadObjectPositionRadius(
      simple(1, [pairRow()]),
      owner,
      { ...APPROVAL_PLAN, probeDrifted: true },
    );
    for (const side of [radius.corroborating, radius.separating, radius.tension]) {
      expect(side.countsConsistent).toBe(false);
    }
  });

  it("POSITIVE CONTROL — a probe that answered leaves the counts trustworthy", async () => {
    const radius = await loadObjectPositionRadius(
      simple(1, [pairRow()]),
      owner,
      { ...APPROVAL_PLAN, probeDrifted: false },
    );
    expect(radius.corroborating.countsConsistent).toBe(true);
  });
});

describe("the page cap is reported as truncation, never as withholding", () => {
  it("clips at the bound and says so", async () => {
    const rows = Array.from({ length: OBJECT_RADIUS_PAIR_MAX + 5 }, (_, i) =>
      pairRow({ left_id: `f${i}`, scoped_total: OBJECT_RADIUS_PAIR_MAX + 5 }),
    );
    const radius = await loadObjectPositionRadius(
      simple(OBJECT_RADIUS_PAIR_MAX + 5, rows),
      owner,
      APPROVAL_PLAN,
    );
    expect(radius.corroborating.pairs).toHaveLength(OBJECT_RADIUS_PAIR_MAX);
    expect(radius.corroborating.truncated).toBe(true);
    // ⚠️ `withheld` stays 0 — truncation dressed as an ACL boundary is what the
    // wire type forbids by name.
    expect(radius.corroborating.withheld).toBe(0);
  });
});

describe("⚠️ a reader whose clause DENIES every row is reported inconsistent, not empty", () => {
  it("lists nothing, withholds the whole total, and says the counts are untrustworthy", async () => {
    // The `-pg` suite's "stranger" is a `member` with no audiences, which takes
    // the `reader-scoped` arm — so `deny-all` never ran in a test, and replacing
    // both `decision !== "deny-all"` conjuncts with `true` left every suite
    // green. This is the branch the module deliberately does NOT throw on: the
    // workspace-wide total stays sayable so "N you cannot see" is expressible,
    // and the counts are reported inconsistent because the two statements were
    // not asked the same question.
    const unresolved: BrainPrincipalContext = {
      origin: "unresolved",
      workspaceId: WS,
      userId: null,
      role: null,
      audienceIds: [],
    };
    const radius = await loadObjectPositionRadius(simple(4), unresolved, APPROVAL_PLAN);
    expect(radius.corroborating.total).toBe(4);
    expect(radius.corroborating.pairs).toHaveLength(0);
    expect(radius.corroborating.withheld).toBe(4);
    expect(radius.corroborating.countsConsistent).toBe(false);
    expect(
      warnCalls.some((c) => c.msg.includes("denied every row while the reader itself resolved")),
    ).toBe(true);
  });
});
