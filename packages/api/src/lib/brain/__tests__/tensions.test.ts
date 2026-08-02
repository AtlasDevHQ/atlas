/**
 * Unit coverage for the shared `in-tension-with` cluster walk (#4913, #4962,
 * ADR-0036 §Temporal, conflict & provenance).
 *
 * `lib/brain/tensions.ts` is the ONE implementation behind BOTH read surfaces,
 * and until #4962 it had no test of its own — it was exercised only through
 * `candidates.test.ts` and `search.test.ts`, each of which can only ever ask it
 * the question its own surface asks. Three whole claims are invisible from
 * there:
 *
 *   - **The walk is surface-invariant.** Each caller passes a different `cap`
 *     and a different `surface` and projects the result differently. Nothing
 *     downstream can tell you the WALK itself is the same one — only a test
 *     that runs one fixture through both surfaces can.
 *   - **The deny-all THROW.** Both callers already threw on the same decision
 *     against the same table, so this module's throw is unreachable from either
 *     suite. It is the guard against FABRICATED ACL WITHHOLDING: skipping the
 *     counterpart query would leave every rival unresolved and therefore
 *     reported as withheld, which no reviewer and no agent can tell from the
 *     real thing.
 *   - **The settled/contested transition.** Nothing deletes an
 *     `in-tension-with` edge, so a winner carries its loser forever. `valid_to`
 *     and `invalidated_at` are the ONLY things standing between "a human
 *     already arbitrated this" and "a live contradiction" — pinned here as the
 *     negative the issue asks for.
 *
 * ## Why this file is a unit suite and not a `-pg` one
 *
 * Every invariant above is a decision this module makes in TypeScript over an
 * injected `db.query`; none of them is a database constraint. The half that IS
 * the database — that the emitted predicate actually excludes the rows these
 * tests assume — is already pinned twice, by `acl-visibility-pg.test.ts` (the
 * predicate against real `&&`) and by `search-pg.test.ts` /
 * `multi-source-pg.test.ts` (the integrated walk end to end).
 *
 * ## The fixture is an EVALUATOR, not a script
 *
 * `store()` does not hand back a canned answer per statement. It evaluates the
 * emitted counterpart statement against a set of rows: array overlap against
 * the tokens the module ACTUALLY BOUND, workspace containment against the
 * workspace it actually bound, and a projection down to the columns its SELECT
 * actually names. That matters for the same reason the ACL tests below resolve
 * their reader contexts through `resolvePrincipalContext` rather than writing
 * them by hand — a canned fixture turns every ACL assertion into a statement
 * about the fixture, and would stay green against a module that bound the
 * OWNER's tokens, bound none at all, or stopped selecting a column.
 *
 * ## Mutation coverage, and the assertions that have no faithful mutation
 *
 * Every assertion below was mutation-verified: a mutation that REMOVES
 * behaviour from `tensions.ts` (or, where the claim is about the reader,
 * `acl.ts`) was applied, seen to turn this file red, and reverted — with the
 * failing assertion lifted and the run repeated, because in a multi-assertion
 * test the first failure SHADOWS every assertion after it and a single red run
 * proves only that one of them bites.
 *
 * Three things came out of that which are worth stating rather than hiding:
 *
 *   - **`edges.length === 0` has no faithful mutation of its own.** Removing
 *     that early return changes nothing observable — the `pairs.length === 0`
 *     return catches the same case. Removing BOTH does. So the test below
 *     claims the observable property (an empty edge set never reaches the ACL'd
 *     statement), not the particular guard that delivers it.
 *   - **The empty-result SHAPE is unmutatable.** `clusters.size === 0` /
 *     `truncated === false` on a page with nothing to walk is what every route
 *     out of the function returns; there is no degradation path to remove, only
 *     a value to corrupt, and corrupting a value is not a faithful mutation.
 *     They stay because they state the contract, and the LOUD half of each
 *     guard next to them is verified.
 *   - **Two assertions are owned elsewhere.** That the edge statement resolves
 *     no fact row pins an ABSENCE (the mutation would be to reunite the two
 *     statements, which is a rewrite, not a patch). That the counterpart
 *     statement binds this workspace restates `aclVisibilityClause`'s own
 *     tenant containment — `acl.test.ts` pins the decision and
 *     `acl-visibility-pg.test.ts` pins it against real Postgres.
 */

import { describe, expect, it } from "bun:test";
import {
  loadTensionClusters,
  type BrainTensionReader,
  type TensionCluster,
  type TensionClusterOptions,
  type TensionCounterpartRow,
} from "@atlas/api/lib/brain/tensions";
import {
  AUDIENCE_MEMBERSHIP_SQL,
  AUDIENCE_PREFIX,
  resolvePrincipalContext,
  type BrainPrincipalContext,
} from "@atlas/api/lib/brain/acl";
import { BrainReaderUnresolvedError } from "@atlas/api/lib/brain/reader-context";
import type { AuthMode, OrgRole } from "@useatlas/types";

const WS = "ws-tensions-test";

const EDGE_SQL = "edge_type = 'in-tension-with'";
const COUNTERPART_SQL = "f.id = ANY(";

// Fixed instants. `Date.now()` never appears in this file: "already in the
// past" and "still in the future" are properties of the STAMP relative to the
// reader's clock, and a test that computed them from the wall clock would
// change meaning as the suite ages.
const PAST = new Date("2026-06-05T00:00:00.000Z");
const FUTURE = new Date("2099-01-01T00:00:00.000Z");
const INGESTED = new Date("2026-06-01T00:00:00.000Z");

// ---------------------------------------------------------------------------
// Reader contexts — resolved through production code, never hand-built
// ---------------------------------------------------------------------------

interface ResolvedReader {
  readonly ctx: BrainPrincipalContext;
  /** The statement the resolver issued, so freshness can be pinned as a premise. */
  readonly membershipSql: string | undefined;
}

/**
 * Resolve a reader the way a request does.
 *
 * Hand-writing a `BrainPrincipalContext` literal would make every ACL
 * assertion below a statement about the literal: `audienceIds` is the OUTPUT of
 * a resolution that can suppress a membership, and a fixture that just lists
 * the survivors cannot tell a granted audience from a suppressed one — from the
 * reader's side those look identical, which is exactly the trap
 * `ATLAS_BRAIN_AUDIENCE_MAX_STALENESS_HOURS` sets for brain ACL negatives.
 *
 * `audiences` are therefore supplied as MEMBERSHIP ROWS carrying the `fresh`
 * flag `AUDIENCE_MEMBERSHIP_SQL` computes, and the caller pins which statement
 * produced them via `membershipSql`.
 */
async function reader(
  options: {
    readonly workspaceId?: string;
    readonly mode?: AuthMode;
    readonly userId?: string | undefined;
    readonly role?: OrgRole;
    readonly audiences?: ReadonlyArray<{ readonly audience_id: string; readonly fresh: boolean }>;
  } = {},
): Promise<ResolvedReader> {
  const { workspaceId = WS, mode = "managed", role = "member", audiences = [] } = options;
  // Presence, not a default: `{ userId: undefined }` is how a caller asks for
  // the authenticated-request-with-no-user-id case, and a defaulted parameter
  // would quietly hand it a user instead.
  const userId = "userId" in options ? options.userId : "user-1";
  let membershipSql: string | undefined;
  const ctx = await resolvePrincipalContext(
    {
      query: async (sql: string) => {
        membershipSql = sql;
        return { rows: audiences };
      },
    },
    {
      workspaceId,
      mode,
      userId,
      resolvedRole: userId === undefined ? undefined : { role, orgId: workspaceId },
    },
  );
  return { ctx, membershipSql };
}

// ---------------------------------------------------------------------------
// The store — an evaluator for the statements this module emits
// ---------------------------------------------------------------------------

interface Call {
  readonly sql: string;
  readonly params: readonly unknown[];
}

interface EdgeFixture {
  readonly from_id: string | null;
  readonly to_id: string | null;
}

type StoreRow = Record<string, unknown> & {
  readonly id: string;
  readonly workspace_id: string;
  readonly visible_to: readonly string[];
};

/**
 * A counterpart fact at rest. Everything except `id` is held CONSTANT on
 * purpose — the settled/contested arm needs two rivals that differ in nothing
 * but their temporal stamps, and a factory that derived fields from `id` could
 * not produce them.
 */
function rival(id: string, overrides: Record<string, unknown> = {}): StoreRow {
  return {
    id,
    workspace_id: WS,
    subject: "billing pipeline",
    predicate: "owned_by",
    object: "platform",
    status: "published",
    visible_to: ["org"],
    pre_widening_visible_to: null,
    provenance: {
      source: "slack",
      sourceId: "m-1",
      episodeId: "ep-1",
      actor: "U1",
      producer: "extraction:v1",
      occurredAt: "2026-05-30T00:00:00.000Z",
      extractedAt: "2026-05-30T00:05:00.000Z",
      reconciledAt: "2026-05-30T00:06:00.000Z",
    },
    source_episode_id: "ep-1",
    valid_from: null,
    valid_to: null,
    invalidated_at: null,
    ingested_at: INGESTED,
    corroboration_count: 1,
    ...overrides,
  };
}

/**
 * The columns the emitted counterpart SELECT actually names.
 *
 * Without this the store would hand back every column of every row regardless
 * of the SELECT list, and "both temporal stamps are SELECTED" would have no
 * faithful mutation at all: deleting `f.valid_to` from `COUNTERPART_COLUMNS`
 * would leave every assertion in this file green. With it, a dropped column is
 * a dropped field here exactly as it is in Postgres.
 *
 * Both alias and bare forms, because the SELECT uses both (`f.id::text AS id`
 * and `f.subject`). `f.workspace_id` and `f.id` also appear inside the
 * corroboration subquery and are picked up harmlessly — the module reads
 * neither from the projected row.
 */
function projectedColumns(sql: string): ReadonlySet<string> {
  const select = sql.slice(0, sql.indexOf("FROM brain_facts f"));
  const columns = new Set<string>();
  for (const match of select.matchAll(/\bf\.([a-z_]+)/g)) columns.add(match[1]!);
  for (const match of select.matchAll(/\bAS\s+([a-z_]+)/gi)) columns.add(match[1]!);
  return columns;
}

interface Store {
  readonly db: BrainTensionReader;
  readonly calls: readonly Call[];
  readonly warnings: ReadonlyArray<{ payload: unknown; message: string }>;
  readonly log: TensionClusterOptions["log"];
}

/**
 * A database that answers the two statements this module emits.
 *
 * The edge statement is served from `edges` verbatim — it is ungated, so there
 * is nothing to evaluate. The counterpart statement is EVALUATED against
 * `facts`: id membership from the bound id array, workspace containment and
 * grant overlap from the bound workspace and token array, projection from the
 * SELECT list. Postgres's `&&` is array overlap, which is the one line below;
 * that the emitted predicate really means that is `acl-visibility-pg.test.ts`'s
 * claim, not this file's.
 *
 * `rawCounterparts` bypasses the evaluator, for the drift fixtures only — a
 * statement whose SHAPE changed cannot by definition come out of an evaluator
 * that models the shape it has today.
 */
function store(fixture: {
  edges?: readonly EdgeFixture[];
  facts?: readonly StoreRow[];
  rawCounterparts?: readonly Record<string, unknown>[];
}): Store {
  const calls: Call[] = [];
  const warnings: Array<{ payload: unknown; message: string }> = [];
  const facts = fixture.facts ?? [];
  return {
    calls,
    warnings,
    log: {
      warn: (payload: unknown, message: string) => {
        warnings.push({ payload, message });
      },
    } as TensionClusterOptions["log"],
    db: {
      query: async (sql: string, params: readonly unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.includes(EDGE_SQL)) return { rows: fixture.edges ?? [] };
        if (sql.includes(COUNTERPART_SQL)) {
          if (fixture.rawCounterparts) return { rows: fixture.rawCounterparts };
          const ids = new Set(params.at(-1) as readonly string[]);
          const workspaceId = params[0];
          // The predicate degrades to workspace containment alone under an
          // audit override, which binds no token array.
          const gated = sql.includes("f.visible_to && $2::text[]");
          const tokens = new Set(gated ? (params[1] as readonly string[]) : []);
          const columns = projectedColumns(sql);
          const rows = facts
            .filter(
              (row) =>
                ids.has(row.id) &&
                row.workspace_id === workspaceId &&
                (!gated || row.visible_to.some((token) => tokens.has(token))),
            )
            .map((row) =>
              Object.fromEntries(Object.entries(row).filter(([key]) => columns.has(key))),
            );
          return { rows };
        }
        throw new Error(`unexpected statement: ${sql}`);
      },
    },
  };
}

/** Run the walk. `cap` and `surface` are explicit — they are what varies. */
function load(
  fixture: Store,
  factIds: readonly string[],
  options: {
    ctx: BrainPrincipalContext;
    cap?: number;
    surface?: TensionClusterOptions["surface"];
    requestId?: string;
  },
): Promise<{ clusters: Map<string, TensionCluster>; truncated: boolean }> {
  return loadTensionClusters(fixture.db, factIds, {
    ctx: options.ctx,
    cap: options.cap ?? 10,
    surface: options.surface ?? "review",
    log: fixture.log,
    requestId: options.requestId,
  });
}

const ids = (cluster: TensionCluster | undefined) => ({
  counterparts: (cluster?.counterparts ?? []).map((c) => `${c.row.id}:${c.direction}`),
  withheld: (cluster?.withheld ?? []).map((w) => `${w.factId}:${w.direction}`),
});

// ═══════════════════════════════════════════════════════════════════════════
// Tension detection — which edges become a cluster, and which never should
// ═══════════════════════════════════════════════════════════════════════════

describe("loadTensionClusters — tension detection", () => {
  it("walks BOTH edge directions, because a contradicted incumbent only ever sits on the `to` side", async () => {
    // `reconcile.ts` writes each edge from the newer claim to the incumbent. A
    // `from`-only walk would hide from the reader exactly the older claim whose
    // trust is now in question — and would pass a happy-path test, because the
    // newer claim's own cluster would still be right.
    const { ctx } = await reader();
    const fixture = store({
      edges: [
        { from_id: "fact-1", to_id: "rival-newer" },
        { from_id: "rival-older", to_id: "fact-1" },
      ],
      facts: [rival("rival-newer"), rival("rival-older")],
    });

    const { clusters } = await load(fixture, ["fact-1"], { ctx });

    expect(ids(clusters.get("fact-1"))).toEqual({
      counterparts: ["rival-newer:to", "rival-older:from"],
      withheld: [],
    });
  });

  it("gives each end of an on-page edge the other as a peer — neither end is the authority", async () => {
    const { ctx } = await reader();
    const fixture = store({
      edges: [{ from_id: "fact-1", to_id: "fact-2" }],
      facts: [rival("fact-1"), rival("fact-2")],
    });

    const { clusters } = await load(fixture, ["fact-1", "fact-2"], { ctx });

    expect(ids(clusters.get("fact-1")).counterparts).toEqual(["fact-2:to"]);
    expect(ids(clusters.get("fact-2")).counterparts).toEqual(["fact-1:from"]);
  });

  it("lists a raced reciprocal pair once per direction — the graph, not a double-count", async () => {
    // `reconcile.ts` dedupes one direction only (`WHERE NOT EXISTS`), so A→B
    // and B→A is representable. Each entry carries its own `direction`, so one
    // entry per edge is a faithful report; collapsing them here would discard
    // which end of which edge the reader is looking at.
    const { ctx } = await reader();
    const fixture = store({
      edges: [
        { from_id: "fact-1", to_id: "rival-a" },
        { from_id: "rival-a", to_id: "fact-1" },
      ],
      facts: [rival("rival-a")],
    });

    const { clusters } = await load(fixture, ["fact-1"], { ctx });

    expect(ids(clusters.get("fact-1")).counterparts).toEqual(["rival-a:to", "rival-a:from"]);
  });

  it("fetches a rival named by two edges ONCE", async () => {
    // The `new Set` over `pairs`. Dropping it re-asks Postgres for the same row
    // per edge — invisible in the RESULT (the visible map is keyed by id), and
    // visible only in what was bound.
    const { ctx } = await reader();
    const fixture = store({
      edges: [
        { from_id: "fact-1", to_id: "rival-a" },
        { from_id: "fact-2", to_id: "rival-a" },
      ],
      facts: [rival("rival-a")],
    });

    await load(fixture, ["fact-1", "fact-2"], { ctx });

    const counterpart = fixture.calls.find((c) => c.sql.includes(COUNTERPART_SQL))!;
    expect(counterpart.params.at(-1)).toEqual(["rival-a"]);
  });

  it("asks nothing at all for an empty page", async () => {
    const { ctx } = await reader();
    const fixture = store({});

    const { clusters, truncated } = await load(fixture, [], { ctx });

    expect(fixture.calls).toHaveLength(0);
    expect(clusters.size).toBe(0);
    expect(truncated).toBe(false);
  });

  it("stops at the edge statement when the page has no conflicts", async () => {
    // The counterpart statement is the expensive one and the ACL'd one. An
    // empty edge set must not reach it.
    //
    // Claimed as the observable property rather than as the `edges.length === 0`
    // return, deliberately: that return is shadowed by the `pairs.length === 0`
    // one, so removing either alone changes nothing. Removing both turns this
    // red, which is the honest statement of what it defends.
    const { ctx } = await reader();
    const fixture = store({ edges: [] });

    const { clusters } = await load(fixture, ["fact-1"], { ctx });

    expect(clusters.size).toBe(0);
    expect(fixture.calls.map((c) => c.sql.includes(EDGE_SQL))).toEqual([true]);
  });

  it("is LOUD about a workspace-less context rather than quietly reporting no conflicts", async () => {
    // Unreachable — a workspace-less context denies at the caller. It is a
    // guard whose failure mode is a page that reports no conflicts at all,
    // which is this module's one cardinal sin, so it must not be a bare return.
    const { ctx } = await reader({ workspaceId: "", mode: "none", userId: undefined });
    const fixture = store({ edges: [{ from_id: "fact-1", to_id: "rival-a" }] });

    const { clusters, truncated } = await load(fixture, ["fact-1"], { ctx });

    expect(clusters.size).toBe(0);
    expect(truncated).toBe(false);
    expect(fixture.calls).toHaveLength(0);
    expect(fixture.warnings).toHaveLength(1);
    expect(fixture.warnings[0]!.message).toContain("this is an Atlas bug");
  });

  it("logs an endpoint-less edge with its surviving end, and keeps walking the rest", async () => {
    // `chk_brain_edges_endpoint_kinds` forces both FACT endpoints non-null for
    // every row this query can return, so a hit is query drift. Skipping it
    // bare would make one conflict silently read as "nothing contradicts this";
    // aborting the walk would do the same for the whole page.
    const { ctx } = await reader();
    const fixture = store({
      edges: [
        { from_id: "fact-1", to_id: null },
        { from_id: "fact-1", to_id: "rival-a" },
      ],
      facts: [rival("rival-a")],
    });

    const { clusters } = await load(fixture, ["fact-1"], { ctx });

    expect(ids(clusters.get("fact-1")).counterparts).toEqual(["rival-a:to"]);
    const warning = fixture.warnings.find((w) => w.message.includes("missing an endpoint"));
    expect(warning).toBeDefined();
    // The surviving endpoint is what lets an operator find the row.
    expect(warning!.payload).toMatchObject({ edge: { from: "fact-1", to: null } });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// One walk, two surfaces
// ═══════════════════════════════════════════════════════════════════════════

describe("loadTensionClusters — one walk behind both surfaces", () => {
  // Three edges against a cap of two, so ALL THREE of the walk's outputs are
  // live for the comparison below: a visible counterpart, a withheld handle,
  // and `truncated`. With a slack cap the truncation half would be `false` on
  // both sides and would agree for the wrong reason.
  const CAP = 2;
  const fixture = () =>
    store({
      edges: [
        { from_id: "fact-1", to_id: "rival-visible" },
        { from_id: "fact-1", to_id: "rival-hidden" },
        { from_id: "fact-1", to_id: "rival-capped" },
      ],
      facts: [
        rival("rival-visible"),
        rival("rival-hidden", { visible_to: ["role:owner"] }),
        rival("rival-capped"),
      ],
    });

  it("produces an IDENTICAL cluster and identical SQL for the review queue and the fused search", async () => {
    // The whole reason the module exists (#4913): the two surfaces used to
    // carry their own copy of this walk, and the two copies agreeing about what
    // a "conflict" is was a matter of diligence. Each caller suite only ever
    // asks with its own surface, so nothing downstream can see a walk that
    // started branching on it. Everything surface-specific must live in the
    // caller's PROJECTION.
    const { ctx } = await reader();
    const review = fixture();
    const search = fixture();

    const fromReview = await load(review, ["fact-1"], { ctx, cap: CAP, surface: "review" });
    const fromSearch = await load(search, ["fact-1"], { ctx, cap: CAP, surface: "search" });

    expect(fromSearch.clusters).toEqual(fromReview.clusters);
    expect(fromSearch.truncated).toBe(fromReview.truncated);
    expect(search.calls.map((c) => c.sql)).toEqual(review.calls.map((c) => c.sql));
    expect(search.calls.map((c) => c.params)).toEqual(review.calls.map((c) => c.params));
    // ...and every output really is exercised, so the equalities above are not
    // two empty results agreeing with each other.
    expect(fromReview.truncated).toBe(true);
    expect(ids(fromReview.clusters.get("fact-1"))).toEqual({
      counterparts: ["rival-visible:to"],
      withheld: ["rival-hidden:to"],
    });
  });

  it("budgets the cap the CALLER passed, not one of its own", async () => {
    // The review queue budgets for a 200-row admin table and the fused search
    // for an LLM context window. Neither caller suite can see this — each has
    // exactly one cap constant — so a module-level default silently overriding
    // one of them would go unnoticed there.
    const { ctx } = await reader();
    for (const cap of [3, 7]) {
      const fixture = store({ edges: [{ from_id: "fact-1", to_id: "rival-a" }] });
      await load(fixture, ["fact-1"], { ctx, cap });
      // `cap + 1` — the overflow row is how truncation is detected, and the
      // store ignores LIMIT, so only the bound parameter can pin it.
      expect(fixture.calls[0]!.params[2]).toBe(cap + 1);
    }
  });

  it("stamps the asking surface into the log line, so the two stay tellable apart in an incident", async () => {
    const { ctx } = await reader();
    for (const [surface, label] of [
      ["review", "brain review:"],
      ["search", "brain search:"],
    ] as const) {
      const fixture = store({
        edges: [
          { from_id: "fact-1", to_id: "rival-a" },
          { from_id: "fact-1", to_id: "rival-b" },
        ],
      });
      await load(fixture, ["fact-1"], { ctx, cap: 1, surface });
      const truncation = fixture.warnings.find((w) => w.message.includes("exceeded the per-page cap"));
      expect(truncation!.message.startsWith(label)).toBe(true);
      expect(truncation!.payload).toMatchObject({ surface });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The ACL'd counterpart SELECT — visible, withheld, and never fabricated
// ═══════════════════════════════════════════════════════════════════════════

describe("loadTensionClusters — the ACL'd counterpart split", () => {
  it("gates counterparts on a FRESH predicate over their own row, never on the owner's entitlement", async () => {
    // The likeliest leak in the slice. A join gated by the OWNER's predicate
    // would hand a reader a rival claim — and, since #4913, its provenance —
    // because they were entitled to the claim it conflicts with. Two
    // statements, never a join.
    const { ctx } = await reader({ role: "admin" });
    const fixture = store({
      edges: [{ from_id: "fact-1", to_id: "rival-a" }],
      facts: [rival("rival-a")],
    });

    await load(fixture, ["fact-1"], { ctx });

    const [edgeCall, counterpartCall] = fixture.calls;
    // The edge statement resolves no fact row, so it cannot be the thing that
    // gated the counterpart. (Pins an absence — the faithful mutation is to
    // reunite the two statements, which the assertions below then catch.)
    expect(edgeCall!.sql).not.toContain("brain_facts");
    expect(counterpartCall!.sql).not.toContain("JOIN");
    // The real pin is the BOUND array: `not.toContain("JOIN")` alone would pass
    // a correlated EXISTS against the owner row.
    expect(counterpartCall!.sql).toContain("f.visible_to && $2::text[]");
    expect(counterpartCall!.params[0]).toBe(WS);
    expect(counterpartCall!.params[1]).toEqual(["org", "role:admin", "role:member", "user:user-1"]);
  });

  it("REPORTS a counterpart the reader may not see instead of dropping it", async () => {
    // "There is a rival you cannot see" is precisely what should stop a
    // reviewer approving or an agent asserting. An omitted row reads as
    // "nothing contradicts this".
    const { ctx } = await reader();
    const fixture = store({
      edges: [
        { from_id: "fact-1", to_id: "rival-open" },
        { from_id: "fact-1", to_id: "rival-secret" },
      ],
      facts: [rival("rival-open"), rival("rival-secret", { visible_to: ["user:someone-else"] })],
    });

    const { clusters } = await load(fixture, ["fact-1"], { ctx });

    expect(ids(clusters.get("fact-1"))).toEqual({
      counterparts: ["rival-open:to"],
      withheld: ["rival-secret:to"],
    });
    // A withheld rival is an opaque HANDLE — the payload the reader was denied
    // must not travel alongside the id that says they were denied it.
    expect(clusters.get("fact-1")!.withheld[0]).toEqual({
      factId: "rival-secret",
      direction: "to",
    });
  });

  it("THROWS on a deny-all reader rather than fabricating a page of withheld rivals", async () => {
    // Unreachable in practice — every caller has already thrown on the same
    // decision against the same table. It matters anyway, and only here: if
    // this module skipped the counterpart query on `deny-all`, every rival
    // would be unresolved and therefore reported as WITHHELD. Fabricated ACL
    // withholding is indistinguishable from the real thing from the reader's
    // side, and it is the failure this whole module is arranged to refuse.
    const { ctx } = await reader({ userId: undefined });
    expect(ctx.origin).toBe("unresolved");
    const fixture = store({
      edges: [{ from_id: "fact-1", to_id: "rival-a" }],
      facts: [rival("rival-a")],
    });

    const failure = load(fixture, ["fact-1"], { ctx, surface: "review" });

    await expect(failure).rejects.toBeInstanceOf(BrainReaderUnresolvedError);
    await expect(failure).rejects.toMatchObject({ workspaceId: WS, surface: "review" });
    // And it threw INSTEAD of asking — a query issued under a deny-all clause
    // would be the same defect wearing a `(FALSE)` predicate.
    expect(fixture.calls.some((c) => c.sql.includes(COUNTERPART_SQL))).toBe(false);
  });

  it("resolves an audience-granted rival when the membership behind it is FRESH", async () => {
    // The premise half of the pair below. Freshness is pinned explicitly
    // because a suppressed grant and a correctly-denied one are identical from
    // the reader's side: `ctx.audienceIds` lists only SURVIVORS, so it can
    // never show you which of the two happened.
    const { ctx, membershipSql } = await reader({
      audiences: [{ audience_id: "eng", fresh: true }],
    });
    // The flag came out of the production statement, not out of the fixture's
    // own idea of freshness.
    expect(membershipSql).toBe(AUDIENCE_MEMBERSHIP_SQL);
    expect(ctx.audienceIds).toEqual(["eng"]);

    const fixture = store({
      edges: [{ from_id: "fact-1", to_id: "rival-eng" }],
      facts: [rival("rival-eng", { visible_to: [`${AUDIENCE_PREFIX}eng`] })],
    });
    const { clusters } = await load(fixture, ["fact-1"], { ctx });

    expect(ids(clusters.get("fact-1"))).toEqual({
      counterparts: ["rival-eng:to"],
      withheld: [],
    });
  });

  it("withholds the SAME rival once its membership ages past the staleness bound", async () => {
    // The negative, and the reason the arm above states its premise. Identical
    // reader, identical grant, identical rival — the ONLY difference is that
    // the membership row is no longer verified within
    // `ATLAS_BRAIN_AUDIENCE_MAX_STALENESS_HOURS`, which drops the token from
    // the reader's set, which drops the rival out of the bound overlap.
    //
    // What this pins is that the suppression reaches THIS surface honestly:
    // the rival is reported as withheld, not dropped. A reviewer told "there is
    // a rival you cannot see" can escalate; one told nothing cannot.
    const { ctx, membershipSql } = await reader({
      audiences: [{ audience_id: "eng", fresh: false }],
    });
    expect(membershipSql).toBe(AUDIENCE_MEMBERSHIP_SQL);
    expect(ctx.audienceIds).toEqual([]);

    const fixture = store({
      edges: [{ from_id: "fact-1", to_id: "rival-eng" }],
      facts: [rival("rival-eng", { visible_to: [`${AUDIENCE_PREFIX}eng`] })],
    });
    const { clusters } = await load(fixture, ["fact-1"], { ctx });

    expect(fixture.calls[1]!.params[1]).not.toContain(`${AUDIENCE_PREFIX}eng`);
    expect(ids(clusters.get("fact-1"))).toEqual({
      counterparts: [],
      withheld: ["rival-eng:to"],
    });
  });

  it("misreports a counterpart with no usable id as withheld, LOUDLY", async () => {
    // This row came back THROUGH the ACL predicate, so dropping it reclassifies
    // an entitled rival as withheld — the same fabricated withholding the
    // deny-all throw refuses, arriving by a different route. Unreachable from
    // the database (`f.id::text` of a NOT NULL uuid), so a hit is query drift
    // and the log line is the only artifact: the RESULT is a plausible withheld
    // rival either way.
    const { ctx } = await reader();
    const fixture = store({
      edges: [{ from_id: "fact-1", to_id: "rival-a" }],
      rawCounterparts: [{ ...rival("rival-a"), id: 42 }],
    });

    const { clusters } = await load(fixture, ["fact-1"], { ctx });

    expect(ids(clusters.get("fact-1"))).toEqual({ counterparts: [], withheld: ["rival-a:to"] });
    const warning = fixture.warnings.find((w) => w.message.includes("no usable id"));
    expect(warning).toBeDefined();
    // `idType` and the batch size are what tell an operator whether one row
    // drifted or the whole statement did.
    expect(warning!.payload).toMatchObject({ idType: "number", batch: 1, workspaceId: WS });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The settled / contested transition
// ═══════════════════════════════════════════════════════════════════════════

describe("loadTensionClusters — the settled/contested transition", () => {
  /** One owner, four rivals: live, superseded, retracted, scheduled-to-close. */
  const settledFixture = () =>
    store({
      edges: [
        { from_id: "fact-1", to_id: "rival-live" },
        { from_id: "fact-1", to_id: "rival-superseded" },
        { from_id: "fact-1", to_id: "rival-retracted" },
        { from_id: "fact-1", to_id: "rival-scheduled" },
      ],
      facts: [
        rival("rival-live"),
        rival("rival-superseded", { valid_to: PAST }),
        rival("rival-retracted", { invalidated_at: PAST }),
        rival("rival-scheduled", { valid_to: FUTURE }),
      ],
    });

  async function rows() {
    const { ctx } = await reader();
    const fixture = settledFixture();
    const { clusters } = await load(fixture, ["fact-1"], { ctx });
    const byId = new Map(
      (clusters.get("fact-1")?.counterparts ?? []).map((c) => [c.row.id, c.row]),
    );
    // Throws rather than resolving `undefined`: a missing rival is a broken
    // fixture, and the comparisons below would otherwise silently succeed by
    // finding two empty objects equal.
    const row = (id: string): TensionCounterpartRow => {
      const found = byId.get(id);
      if (!found) throw new Error(`fixture: no counterpart ${id} in the cluster`);
      return found;
    };
    return { byId, row, fixture };
  }

  it("still reports a rival that has since been settled — nothing deletes the edge", async () => {
    // Neither temporal axis is FILTERED, and that is the load-bearing half of
    // the design: hiding a retired rival would make a conflict vanish the
    // moment somebody resolved one side, which reads to the next reader as
    // "nothing ever contradicted this".
    const { byId, fixture } = await rows();

    expect([...byId.keys()].toSorted()).toEqual([
      "rival-live",
      "rival-retracted",
      "rival-scheduled",
      "rival-superseded",
    ]);
    // Matched as a SHAPE rather than as today's two spellings — `IS NOT NULL`,
    // `>=`, and `COALESCE(valid_to, …)` would all slip past a literal check.
    const counterpartSql = fixture.calls.find((c) => c.sql.includes(COUNTERPART_SQL))!.sql;
    expect(counterpartSql).not.toMatch(
      /(valid_to|invalidated_at)\s*(IS\b|[<>=]|BETWEEN)|COALESCE\s*\(\s*f?\.?(valid_to|invalidated_at)/i,
    );
  });

  it("carries BOTH stamps raw, so the reader decides whether a window has actually closed", async () => {
    // Raw rather than as a boolean, and both axes rather than one: retraction
    // ("withdrawn as something that should never have been served") and
    // supersession ("it held until that time, then was replaced") are different
    // things to tell a reviewer, and a `validTo` still in the FUTURE is a LIVE
    // rival whose window is merely scheduled to close. Only the reader has the
    // clock to make that last call.
    const { byId } = await rows();

    expect(byId.get("rival-superseded")).toMatchObject({ valid_to: PAST, invalidated_at: null });
    expect(byId.get("rival-retracted")).toMatchObject({ valid_to: null, invalidated_at: PAST });
    expect(byId.get("rival-scheduled")).toMatchObject({ valid_to: FUTURE, invalidated_at: null });
    expect(byId.get("rival-live")).toMatchObject({ valid_to: null, invalidated_at: null });
  });

  it("THE NEGATIVE: a settled rival must not read as in-tension — and only the stamps say otherwise", async () => {
    // The acceptance criterion, stated at the layer this module owns. Nothing
    // deletes an `in-tension-with` edge, so a winner carries its loser forever:
    // `reconcile.ts` writes the edge at ingest, the publish gate later stamps
    // `valid_to` on the claim it retires, and neither verb writes `status`.
    //
    // So a settled rival arrives looking EXACTLY like a live one — same
    // `published` status, same corroboration, same recency — and the two
    // stamps are the entire difference between "a human already arbitrated
    // this" and "a live contradiction served to the agent as unresolved".
    // Stripping them is what a reader would be left with if this module ever
    // stopped selecting or stopped carrying them:
    const { row } = await rows();
    const withoutId = ({ id: _id, ...rest }: TensionCounterpartRow) => rest;
    const withoutStamps = (counterpart: TensionCounterpartRow) => {
      const { valid_to: _validTo, invalidated_at: _invalidatedAt, ...rest } =
        withoutId(counterpart);
      return rest;
    };

    expect(withoutStamps(row("rival-superseded"))).toEqual(withoutStamps(row("rival-live")));
    expect(withoutStamps(row("rival-retracted"))).toEqual(withoutStamps(row("rival-live")));
    // Every other signal genuinely does read live — without this the assertion
    // above would also hold for two rivals that were both blank.
    expect(row("rival-superseded")).toMatchObject({
      status: "published",
      corroboration_count: 1,
      ingested_at: INGESTED,
    });
    // ...and with the stamps, they ARE distinguishable. Compared with the id
    // stripped, deliberately: `superseded !== live` holds on the id alone, so
    // the id-bearing form of this assertion would pin nothing — and would stay
    // green against a module that had stopped selecting `valid_to` entirely,
    // which is the exact regression it exists to catch.
    expect(withoutId(row("rival-superseded"))).not.toEqual(withoutId(row("rival-live")));
    expect(withoutId(row("rival-retracted"))).not.toEqual(withoutId(row("rival-live")));
  });

  it("SELECTS both stamps and the per-counterpart attribution input", async () => {
    // Belt to the braces above: the store projects down to the columns the
    // SELECT names, so a dropped column already fails the assertions above.
    // This says which column, at the statement, so the failure names the edit.
    //
    // `pre_widening_visible_to` is here because it is the input to the
    // attribution decision each surface re-makes PER COUNTERPART (#4836) — a
    // counterpart is a fact in its own right, so inheriting the owner's
    // decision would be a guess about a different row's grant. Drop the column
    // and both surfaces silently fall back to the owner's answer.
    const { ctx } = await reader();
    const fixture = settledFixture();
    await load(fixture, ["fact-1"], { ctx });

    const counterpartSql = fixture.calls.find((c) => c.sql.includes(COUNTERPART_SQL))!.sql;
    for (const column of ["f.valid_to", "f.invalidated_at", "f.pre_widening_visible_to"]) {
      expect(counterpartSql).toContain(column);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Counterpart selection — order, and the cap
// ═══════════════════════════════════════════════════════════════════════════

describe("loadTensionClusters — counterpart selection", () => {
  it("orders by factId ALONE — refusing to arbitrate is the point", async () => {
    // Every surfacing hint is stacked in favour of the later-sorting rival: 900
    // corroborations against 0, `published` against `draft`, 2026 against 2020.
    // If any code path ranked by authority, recency, or status,
    // `rival-z-strong` would lead. Sorting by anything else would be a verdict
    // Atlas is not entitled to reach — supersession is the human gate's verb.
    const { ctx } = await reader();
    const fixture = store({
      edges: [
        { from_id: "fact-1", to_id: "rival-z-strong" },
        { from_id: "fact-1", to_id: "rival-a-weak" },
      ],
      facts: [
        rival("rival-z-strong", {
          status: "published",
          corroboration_count: 900,
          ingested_at: new Date("2026-07-01T00:00:00.000Z"),
        }),
        rival("rival-a-weak", {
          status: "draft",
          corroboration_count: 0,
          ingested_at: new Date("2020-01-01T00:00:00.000Z"),
        }),
      ],
    });

    const { clusters } = await load(fixture, ["fact-1"], { ctx });
    const cluster = clusters.get("fact-1")!;

    expect(cluster.counterparts.map((c) => c.row.id)).toEqual(["rival-a-weak", "rival-z-strong"]);
    // The adverse signals really are present and really are adverse — without
    // this the assertion above would also pass against a walk that dropped
    // them, and then it would be pinning nothing.
    expect(cluster.counterparts[1]!.row).toMatchObject({
      status: "published",
      corroboration_count: 900,
    });
  });

  it("orders withheld handles by factId too, so the list never says which rivals you were allowed to see", async () => {
    const { ctx } = await reader();
    const fixture = store({
      edges: [
        { from_id: "fact-1", to_id: "rival-z" },
        { from_id: "fact-1", to_id: "rival-a" },
        { from_id: "fact-1", to_id: "rival-m" },
      ],
      facts: [],
    });

    const { clusters } = await load(fixture, ["fact-1"], { ctx });

    expect(clusters.get("fact-1")!.withheld.map((w) => w.factId)).toEqual([
      "rival-a",
      "rival-m",
      "rival-z",
    ]);
  });

  it("reports the cap's bite instead of silently shortening the conflict list", async () => {
    // The cap is applied in edge-id order across the whole page, so specific
    // facts lose ALL of their hints. `truncated` reaches the caller's wire AND
    // the log, because a truncated conflict list reads as "nothing contradicts
    // this" — the one thing neither surface may imply.
    const { ctx } = await reader();
    const edges = Array.from({ length: 4 }, (_, i) => ({
      from_id: "fact-1",
      to_id: `rival-${i}`,
    }));
    const fixture = store({ edges, facts: edges.map((e) => rival(e.to_id!)) });

    const { clusters, truncated } = await load(fixture, ["fact-1"], { ctx, cap: 3 });

    expect(truncated).toBe(true);
    expect(clusters.get("fact-1")!.counterparts).toHaveLength(3);
    const warning = fixture.warnings.find((w) => w.message.includes("exceeded the per-page cap"));
    expect(warning!.payload).toMatchObject({ cap: 3, facts: 1, workspaceId: WS });
  });

  it("does not report truncation on a page that exactly fills the cap", async () => {
    // The overflow row is the signal, so the boundary is where an off-by-one
    // would live — and an over-eager `truncated` teaches reviewers to ignore it.
    const { ctx } = await reader();
    const edges = Array.from({ length: 3 }, (_, i) => ({ from_id: "fact-1", to_id: `rival-${i}` }));
    const fixture = store({ edges, facts: edges.map((e) => rival(e.to_id!)) });

    const { clusters, truncated } = await load(fixture, ["fact-1"], { ctx, cap: 3 });

    expect(truncated).toBe(false);
    expect(clusters.get("fact-1")!.counterparts).toHaveLength(3);
    expect(fixture.warnings).toHaveLength(0);
  });

  it("still reports truncation when no edge resolved to a fact on the page", async () => {
    // The early return under edge-query drift (a predicate change that returns
    // edges for other facts). Reporting `truncated: false` there would tell the
    // caller the conflict list is complete at the exact moment the module knows
    // least about it.
    const { ctx } = await reader();
    const fixture = store({
      edges: [
        { from_id: "other-1", to_id: "other-2" },
        { from_id: "other-3", to_id: "other-4" },
      ],
    });

    const { clusters, truncated } = await load(fixture, ["fact-1"], { ctx, cap: 1 });

    expect(clusters.size).toBe(0);
    expect(truncated).toBe(true);
    expect(fixture.calls.some((c) => c.sql.includes(COUNTERPART_SQL))).toBe(false);
  });
});
