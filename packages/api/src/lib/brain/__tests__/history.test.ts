/**
 * Unit coverage for the `supersedes` lineage walk (#5461, PRD finish condition 5).
 *
 * `lib/brain/history.ts` is the first thing in the tree that READS the
 * `supersedes` edge back to a reader — every other reference is write-side or
 * gate-side — so nothing upstream constrains its behaviour and every decision
 * below is one this file has to pin.
 *
 * ## What is claimed HERE and what is claimed against Postgres
 *
 * The load-bearing guardrail — **a retracted predecessor never appears, not as
 * content and not as a count** — is a PREDICATE, enforced in SQL by the join to
 * `brain_facts ... invalidated_at IS NULL` at every level of the recursion. A
 * unit suite over an injected `db.query` cannot claim it: a fixture that
 * returned no row for a retracted ancestor would be asserting about the
 * fixture. It is pinned in `search-pg.test.ts` against real Postgres — beside
 * that file's own retracted-fact exclusion, because it is the same claim one
 * axis over and the stakes are identical (`retract` is the GDPR-erasure path).
 * The same split `tensions.test.ts` documents.
 *
 * What is claimed here is everything the module decides in TypeScript:
 *
 *   - **Which predecessor is "the previous answer"** when a claim retired
 *     several at once, and that the choice is READER-INDEPENDENT. Ordering on
 *     the predecessor's own `valid_to` would read off the ACL'd statement and
 *     hand two readers of the same claim a different previous answer.
 *   - **The count is disclosed, the content is not.** A reader outside the
 *     predecessor's frozen grant learns THAT the answer changed and not what it
 *     said — `BrainSearchTensionWithheld`'s split, one axis over.
 *   - **The deny-all THROW**, unreachable from `search.test.ts` because that
 *     surface already threw on the same decision. It is the guard against
 *     FABRICATED withholding: skipping the statement would report every
 *     predecessor as withheld, which no reader can tell from the real thing.
 *   - **`changedBy` is discriminated on the PRODUCER, never the actor** — the
 *     one assertion here that prevents an accusation. On the publish-gate path
 *     the replacement's actor is whoever the NEWER claim was extracted from, a
 *     person who never touched the old claim.
 *
 * ## The fixture is an evaluator for the ACL'd statement
 *
 * The walk is ungated, so its rows are served verbatim — there is nothing to
 * evaluate. The predecessor statement is EVALUATED: id membership off the bound
 * id array, workspace containment and grant overlap off the bound workspace and
 * token array. A canned answer there would turn every ACL assertion into a
 * statement about the fixture, and would stay green against a module that bound
 * the LIVE claim's tokens or none at all.
 */

import { describe, expect, it } from "bun:test";
import {
  loadFactLineage,
  toHistoryView,
  NO_HISTORY,
  type BrainLineageReader,
  type FactLineageOptions,
} from "@atlas/api/lib/brain/history";
import {
  principalTokens,
  resolvePrincipalContext,
  type BrainPrincipalContext,
} from "@atlas/api/lib/brain/acl";
import { BrainReaderUnresolvedError } from "@atlas/api/lib/brain/reader-context";
import type { BrainFactProvenanceView } from "@useatlas/types";

const WS = "ws-history-test";
const WALK_SQL = "WITH RECURSIVE lineage";

// Fixed instants — `Date.now()` never appears here. "Recorded later" is a
// property of one stamp relative to another, not of the suite's age.
const EARLIER = new Date("2026-08-20T10:00:00.000Z");
const LATER = new Date("2026-08-26T16:25:09.000Z");

async function reader(
  options: { readonly audiences?: readonly string[]; readonly userId?: string | undefined } = {},
): Promise<BrainPrincipalContext> {
  const userId = "userId" in options ? options.userId : "user-1";
  return resolvePrincipalContext(
    {
      query: async () => ({
        rows: (options.audiences ?? []).map((audience_id) => ({ audience_id, fresh: true })),
      }),
    },
    {
      workspaceId: WS,
      mode: "managed",
      userId,
      resolvedRole: userId === undefined ? undefined : { role: "member", orgId: WS },
    },
  );
}

interface WalkRow {
  readonly root: string | null;
  readonly prior_id: string | null;
  readonly recorded_at: unknown;
  readonly depth: unknown;
}

interface PriorFixture {
  readonly id: string;
  readonly object: string;
  readonly workspace_id?: string;
  readonly visible_to?: readonly string[];
  readonly valid_from?: unknown;
  readonly valid_to?: unknown;
}

interface Store {
  readonly db: BrainLineageReader;
  readonly calls: ReadonlyArray<{ sql: string; params: readonly unknown[] }>;
  readonly warnings: ReadonlyArray<{ payload: unknown; message: string }>;
  readonly log: FactLineageOptions["log"];
}

function store(fixture: {
  walk?: readonly WalkRow[];
  priors?: readonly PriorFixture[];
  rawPriors?: readonly Record<string, unknown>[];
}): Store {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const warnings: Array<{ payload: unknown; message: string }> = [];
  const priors = fixture.priors ?? [];
  return {
    calls,
    warnings,
    log: {
      warn: (payload: unknown, message: string) => {
        warnings.push({ payload, message });
      },
    } as FactLineageOptions["log"],
    db: {
      query: async (sql: string, params: readonly unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.includes(WALK_SQL)) return { rows: fixture.walk ?? [] };
        if (fixture.rawPriors) return { rows: fixture.rawPriors };
        const ids = new Set(params.at(-1) as readonly string[]);
        const workspaceId = params[0];
        const gated = sql.includes("f.visible_to && $2::text[]");
        const tokens = new Set(gated ? (params[1] as readonly string[]) : []);
        return {
          rows: priors
            .filter(
              (p) =>
                ids.has(p.id) &&
                (p.workspace_id ?? WS) === workspaceId &&
                (!gated || (p.visible_to ?? ["org"]).some((t) => tokens.has(t))),
            )
            .map((p) => ({
              id: p.id,
              object: p.object,
              valid_from: p.valid_from ?? null,
              valid_to: p.valid_to ?? null,
            })),
        };
      },
    },
  };
}

function options(ctx: BrainPrincipalContext, s: Store, cap = 20): FactLineageOptions {
  return { ctx, cap, log: s.log };
}

describe("loadFactLineage", () => {
  it("carries the previous answer and counts one ancestor", async () => {
    const ctx = await reader();
    const s = store({
      walk: [{ root: "live", prior_id: "old", recorded_at: LATER, depth: 1 }],
      priors: [{ id: "old", object: "8M", valid_from: null, valid_to: LATER }],
    });

    const { lineage, truncated } = await loadFactLineage(s.db, ["live"], options(ctx, s));

    expect(truncated).toBe(false);
    const entry = lineage.get("live");
    expect(entry?.priorCount).toBe(1);
    expect(entry?.recordedAt).toBe(LATER.toISOString());
    expect(entry?.prior).toEqual({
      visible: true,
      factId: "old",
      object: "8M",
      validFrom: null,
      validTo: LATER.toISOString(),
    });
  });

  it("never reaches the ACL'd statement for a page with no lineage", async () => {
    const ctx = await reader();
    const s = store({ walk: [] });

    const { lineage } = await loadFactLineage(s.db, ["live"], options(ctx, s));

    expect(lineage.size).toBe(0);
    expect(s.calls.filter((c) => !c.sql.includes(WALK_SQL))).toHaveLength(0);
  });

  it("picks the most recently RECORDED predecessor when a claim retired several", async () => {
    const ctx = await reader();
    const s = store({
      walk: [
        { root: "live", prior_id: "a", recorded_at: EARLIER, depth: 1 },
        { root: "live", prior_id: "b", recorded_at: LATER, depth: 1 },
      ],
      // `a` is what an ordering on the PREDECESSOR's own stamps would pick — it
      // carries the later `valid_to`. That ordering would also be
      // reader-dependent, since `valid_to` arrives only through the ACL'd read.
      priors: [
        { id: "a", object: "6M", valid_to: LATER },
        { id: "b", object: "8M", valid_to: EARLIER },
      ],
    });

    const { lineage } = await loadFactLineage(s.db, ["live"], options(ctx, s));

    expect(lineage.get("live")?.prior).toMatchObject({ visible: true, factId: "b", object: "8M" });
    expect(lineage.get("live")?.priorCount).toBe(2);
  });

  it("counts an ancestor reached at two depths once", async () => {
    const ctx = await reader();
    const s = store({
      walk: [
        { root: "live", prior_id: "mid", recorded_at: LATER, depth: 1 },
        { root: "live", prior_id: "old", recorded_at: EARLIER, depth: 2 },
        { root: "live", prior_id: "old", recorded_at: EARLIER, depth: 3 },
      ],
      priors: [{ id: "mid", object: "8M" }],
    });

    const { lineage } = await loadFactLineage(s.db, ["live"], options(ctx, s));

    expect(lineage.get("live")?.priorCount).toBe(2);
  });

  it("discloses that the answer changed while withholding what it said", async () => {
    const ctx = await reader({ audiences: [] });
    const s = store({
      walk: [{ root: "live", prior_id: "old", recorded_at: LATER, depth: 1 }],
      priors: [{ id: "old", object: "8M", visible_to: ["audience:chat-channel:slack:C9"] }],
    });

    const { lineage } = await loadFactLineage(s.db, ["live"], options(ctx, s));

    expect(lineage.get("live")?.prior).toEqual({ visible: false });
    // Existence and count survive; content does not. An omitted entry would
    // read as "this never changed".
    expect(lineage.get("live")?.priorCount).toBe(1);
    expect(lineage.get("live")?.recordedAt).toBe(LATER.toISOString());
  });

  it("gates the predecessor on ITS OWN grant, not the live claim's", async () => {
    const ctx = await reader({ audiences: ["a-private"] });
    const s = store({
      walk: [{ root: "live", prior_id: "old", recorded_at: LATER, depth: 1 }],
      priors: [{ id: "old", object: "8M", visible_to: ["audience:a-private"] }],
    });

    const { lineage } = await loadFactLineage(s.db, ["live"], options(ctx, s));

    const priorCall = s.calls.find((c) => !c.sql.includes(WALK_SQL));
    expect(priorCall?.params[1]).toEqual(principalTokens(ctx) as unknown as string[]);
    expect(lineage.get("live")?.prior).toMatchObject({ visible: true, object: "8M" });
  });

  it("re-applies the tombstone predicate on the predecessor read", async () => {
    const ctx = await reader();
    const s = store({
      walk: [{ root: "live", prior_id: "old", recorded_at: LATER, depth: 1 }],
      priors: [{ id: "old", object: "8M" }],
    });

    await loadFactLineage(s.db, ["live"], options(ctx, s));

    // A retraction can land BETWEEN the two reads. The walk's own exclusion is
    // Postgres's to enforce (`history-pg.test.ts`); that the SECOND statement
    // carries the term too is this module's, and it is the difference between
    // one guard and none on a disclosure boundary.
    expect(s.calls.find((c) => !c.sql.includes(WALK_SQL))?.sql).toContain(
      "f.invalidated_at IS NULL",
    );
  });

  it("never selects the predecessor's subject or predicate", async () => {
    const ctx = await reader();
    const s = store({
      walk: [{ root: "live", prior_id: "old", recorded_at: LATER, depth: 1 }],
      priors: [{ id: "old", object: "8M" }],
    });

    await loadFactLineage(s.db, ["live"], options(ctx, s));

    // The slot is inherited verbatim, so they cannot differ from the live
    // claim's — selecting them would let a surface render them side by side and
    // imply they could.
    const priorCall = s.calls.find((c) => !c.sql.includes(WALK_SQL));
    expect(priorCall?.sql).not.toContain("f.subject");
    expect(priorCall?.sql).not.toContain("f.predicate");
  });

  it("throws rather than reporting every predecessor as withheld", async () => {
    const ctx = await reader({ userId: undefined });
    const s = store({
      walk: [{ root: "live", prior_id: "old", recorded_at: LATER, depth: 1 }],
      priors: [{ id: "old", object: "8M" }],
    });

    await expect(loadFactLineage(s.db, ["live"], options(ctx, s))).rejects.toBeInstanceOf(
      BrainReaderUnresolvedError,
    );
  });

  it("marks the page truncated when the fan-out cap bites", async () => {
    const ctx = await reader();
    const s = store({
      walk: [
        { root: "a", prior_id: "a-old", recorded_at: LATER, depth: 1 },
        { root: "b", prior_id: "b-old", recorded_at: LATER, depth: 1 },
      ],
      priors: [{ id: "a-old", object: "8M" }],
    });

    const { truncated } = await loadFactLineage(s.db, ["a", "b"], options(ctx, s, 1));

    expect(truncated).toBe(true);
    expect(s.warnings.map((w) => w.message).join(" ")).toContain("per-page cap");
  });

  it("marks the page truncated when the walk hits its depth bound", async () => {
    const ctx = await reader();
    const s = store({
      walk: [
        { root: "live", prior_id: "p1", recorded_at: LATER, depth: 1 },
        { root: "live", prior_id: "p10", recorded_at: EARLIER, depth: 10 },
      ],
      priors: [{ id: "p1", object: "8M" }],
    });

    const { truncated } = await loadFactLineage(s.db, ["live"], options(ctx, s));

    // A floor, not a total — an undercount reads as a shorter history than the
    // record holds.
    expect(truncated).toBe(true);
  });

  it("reports a dropped endpoint as truncation, not as an unchanged answer", async () => {
    const ctx = await reader();
    const s = store({
      walk: [
        { root: "live", prior_id: null, recorded_at: LATER, depth: 1 },
        { root: "other", prior_id: "old", recorded_at: LATER, depth: 1 },
      ],
      priors: [{ id: "old", object: "8M" }],
    });

    const { lineage, truncated } = await loadFactLineage(s.db, ["live", "other"], options(ctx, s));

    expect(truncated).toBe(true);
    expect(lineage.has("live")).toBe(false);
    expect(s.warnings.map((w) => w.message).join(" ")).toContain("missing an endpoint");
  });

  it("warns rather than misreporting a drifted predecessor row as withheld", async () => {
    const ctx = await reader();
    const s = store({
      walk: [{ root: "live", prior_id: "old", recorded_at: LATER, depth: 1 }],
      rawPriors: [{ id: 42, object: "8M" }],
    });

    const { lineage } = await loadFactLineage(s.db, ["live"], options(ctx, s));

    expect(lineage.get("live")?.prior).toEqual({ visible: false });
    expect(s.warnings.map((w) => w.message).join(" ")).toContain("no usable id");
  });
});

// ---------------------------------------------------------------------------
// toHistoryView — the producer discrimination
// ---------------------------------------------------------------------------

function provenance(overrides: Partial<BrainFactProvenanceView> = {}): BrainFactProvenanceView {
  return {
    source: "human",
    episodeId: null,
    producer: "correction",
    attribution: {
      visible: true,
      sourceId: null,
      actor: "user:3AaGbea",
      occurredAt: LATER.toISOString(),
      actorIdentity: { state: "atlas", userId: "3AaGbea", name: "Matt Sywulak", email: null },
    },
    extractedAt: null,
    reconciledAt: null,
    provisional: false,
    unresolved: [],
    payloadComplete: true,
    ...overrides,
  } as BrainFactProvenanceView;
}

const LINEAGE = {
  prior: { visible: true, factId: "old", object: "8M", validFrom: null, validTo: null },
  priorCount: 1,
  recordedAt: LATER.toISOString(),
} as const;

describe("toHistoryView", () => {
  it("is empty and silent for a claim that replaced nothing", () => {
    expect(toHistoryView(undefined, provenance(), false)).toEqual(NO_HISTORY);
  });

  it("names the correcting human when a human corrected it", () => {
    expect(toHistoryView(LINEAGE, provenance(), false).changedBy).toEqual({
      kind: "correction",
      actor: "user:3AaGbea",
      actorIdentity: { state: "atlas", userId: "3AaGbea", name: "Matt Sywulak", email: null },
      at: LATER.toISOString(),
    });
  });

  it("names NOBODY when the publish gate retired the predecessor", () => {
    // The actor here is a real principal with a real name — the person whose
    // message the NEWER claim was extracted from. They never touched the old
    // claim. A surface reading `actor` uniformly would render "changed by
    // @them", an accusation the record does not support.
    const view = toHistoryView(
      LINEAGE,
      provenance({
        producer: "extraction:v1",
        source: "slack",
        attribution: {
          visible: true,
          sourceId: "C9:1",
          actor: "slack:U0AQW6KF2EM",
          occurredAt: LATER.toISOString(),
          actorIdentity: { state: "atlas", userId: "someone", name: "Someone Else", email: null },
        },
      }),
      false,
    );

    expect(view.changedBy).toEqual({ kind: "promotion", at: LATER.toISOString() });
    expect(JSON.stringify(view)).not.toContain("U0AQW6KF2EM");
  });

  it("still reports the change when #4836 withholds the corrector", () => {
    const view = toHistoryView(LINEAGE, provenance({ attribution: { visible: false } }), false);

    expect(view.changedBy).toEqual({
      kind: "correction",
      actor: null,
      actorIdentity: null,
      at: LATER.toISOString(),
    });
    expect(view.priorCount).toBe(1);
  });

  it("carries the page's truncation onto a row with no lineage of its own", () => {
    // "We may not have looked far enough" is not "nothing changed".
    expect(toHistoryView(undefined, provenance(), true).truncated).toBe(true);
  });
});
