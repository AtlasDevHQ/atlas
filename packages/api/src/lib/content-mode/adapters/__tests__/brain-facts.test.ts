/**
 * Unit tests for the `brain_facts` content-mode adapter (#4769).
 *
 * Drives the adapter through a literal transaction double rather than
 * `mock.module()` — `ModeTxClient` is a one-method interface precisely so a
 * test can satisfy it structurally, with no module registry to mutate.
 *
 * The live-database behaviour (the CHECKs, the real UPDATE, the registry
 * readFilter over real rows) is `lib/brain/__tests__/promotion-pg.test.ts`.
 * What is pinned HERE is the adapter's own contract: which ids it promotes,
 * what it reports, and that it never issues the UPDATE for a refused row.
 */

import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import {
  BRAIN_FACTS_TABLE,
  brainFactStatusClause,
  promoteBrainFacts,
} from "@atlas/api/lib/content-mode/adapters/brain-facts";
import { CONTENT_MODE_TABLES, makeService } from "@atlas/api/lib/content-mode";
import { PublishPhaseError, type ModeTxClient } from "@atlas/api/lib/content-mode/port";

interface Call {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** A transaction double that answers the draft SELECT and records every call. */
function txWithDrafts(
  drafts: readonly unknown[],
  opts: { readonly failOnUpdate?: boolean } = {},
): { tx: ModeTxClient; calls: Call[] } {
  const calls: Call[] = [];
  const tx: ModeTxClient = {
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (/^\s*UPDATE/i.test(sql)) {
        if (opts.failOnUpdate) throw new Error("update exploded");
        // Emulate `pg`: a non-RETURNING UPDATE reports through `rowCount`.
        const ids = (params[1] ?? []) as readonly string[];
        return { rows: [], rowCount: ids.length };
      }
      return { rows: [...drafts] };
    },
  };
  return { tx, calls };
}

const EPISODE = "22222222-2222-4222-8222-222222222222";

function draft(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    source_episode_id: EPISODE,
    provenance: { actor: "slack:U1" },
    visible_to: ["org"],
    ...over,
  };
}

const run = <A>(e: Effect.Effect<A, PublishPhaseError, never>) => Effect.runPromise(e);

describe("promoteBrainFacts", () => {
  it("promotes every promotable draft and reports the count", async () => {
    const { tx, calls } = txWithDrafts([draft("fact-a"), draft("fact-b")]);
    const report = await run(promoteBrainFacts(tx, "ws-1"));

    expect(report).toEqual({ table: "brain_facts", promoted: 2, refused: [] });
    expect(calls).toHaveLength(2);
    expect(calls[0].params).toEqual(["ws-1"]);
    expect(calls[1].params).toEqual(["ws-1", ["fact-a", "fact-b"]]);
  });

  it("promotes the good drafts and refuses only the bad one", async () => {
    // The behaviour the whole design turns on: one malformed fact must not
    // hold back its siblings, and must not fail the workspace's publish.
    const { tx, calls } = txWithDrafts([
      draft("good"),
      draft("ungranted", { visible_to: ["everyone"] }),
    ]);
    const report = await run(promoteBrainFacts(tx, "ws-1"));

    expect(report.promoted).toBe(1);
    expect(report.refused?.map((r) => r.rowId)).toEqual(["ungranted"]);
    // The refused id is absent from the UPDATE's id list — the refusal is
    // enforced by what we ask Postgres to touch, not by a later filter.
    expect(calls[1].params[1]).toEqual(["good"]);
  });

  it("skips the UPDATE entirely when every draft is refused", async () => {
    const { tx, calls } = txWithDrafts([draft("bad", { visible_to: ["everyone"] })]);
    const report = await run(promoteBrainFacts(tx, "ws-1"));

    expect(report.promoted).toBe(0);
    expect(report.refused).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/SELECT/i);
  });

  it("skips the UPDATE when there are no drafts at all (the common case)", async () => {
    const { tx, calls } = txWithDrafts([]);
    const report = await run(promoteBrainFacts(tx, "ws-1"));

    expect(report).toEqual({ table: "brain_facts", promoted: 0, refused: [] });
    expect(calls).toHaveLength(1);
  });

  it("reports `refused: []` rather than omitting it when nothing was refused", async () => {
    // `undefined` means "this table cannot refuse"; `[]` means "it can, and
    // refused nothing this run". `admin-publish.ts` distinguishes them.
    const { tx } = txWithDrafts([draft("ok")]);
    const report = await run(promoteBrainFacts(tx, "ws-1"));
    expect(report.refused).toEqual([]);
  });

  it("takes the draft-selection lock — read-then-write needs FOR UPDATE", async () => {
    // Without it, a concurrent publish could promote a row between our
    // classification and our UPDATE, dropping it from BOTH runs' counts.
    const { tx, calls } = txWithDrafts([draft("a")]);
    await run(promoteBrainFacts(tx, "ws-1"));
    expect(calls[0].sql).toMatch(/FOR UPDATE/i);
  });

  it("scopes both statements to the workspace", async () => {
    const { tx, calls } = txWithDrafts([draft("a")]);
    await run(promoteBrainFacts(tx, "ws-1"));
    for (const call of calls) {
      expect(call.sql).toContain("workspace_id = $1");
      expect(call.params[0]).toBe("ws-1");
    }
  });

  it("only ever promotes rows that are still drafts", async () => {
    const { tx, calls } = txWithDrafts([draft("a")]);
    await run(promoteBrainFacts(tx, "ws-1"));
    expect(calls[1].sql).toContain("status = 'draft'");
  });
});

describe("promoteBrainFacts — failure surfaces as PublishPhaseError", () => {
  it("wraps a failing UPDATE so the caller can attribute the rollback", async () => {
    const { tx } = txWithDrafts([draft("a")], { failOnUpdate: true });
    const exit = await Effect.runPromise(Effect.either(promoteBrainFacts(tx, "ws-1")));
    expect(exit._tag).toBe("Left");
    if (exit._tag === "Left") {
      expect(exit.left).toBeInstanceOf(PublishPhaseError);
      expect(exit.left.table).toBe("brain_facts");
      expect(exit.left.phase).toBe("promote");
    }
  });

  it("fails the phase — never silently skips — when a draft row has no usable id", async () => {
    // Query drift. Skipping the row would leave a draft unpromoted with no
    // refusal recorded, which is indistinguishable from success.
    const { tx } = txWithDrafts([{ source_episode_id: EPISODE, provenance: { a: 1 }, visible_to: ["org"] }]);
    const exit = await Effect.runPromise(Effect.either(promoteBrainFacts(tx, "ws-1")));
    expect(exit._tag).toBe("Left");
    if (exit._tag === "Left") {
      expect(String(exit.left.cause)).toContain("no usable `id`");
    }
  });

  it("wraps a failing draft SELECT too", async () => {
    const tx: ModeTxClient = {
      query: async () => {
        throw new Error("select exploded");
      },
    };
    const exit = await Effect.runPromise(Effect.either(promoteBrainFacts(tx, "ws-1")));
    expect(exit._tag).toBe("Left");
    if (exit._tag === "Left") expect(exit.left.phase).toBe("promote");
  });
});

describe("brainFactStatusClause / readFilter", () => {
  it("gates non-admin reads to published", () => {
    expect(brainFactStatusClause("published", "f")).toBe("f.status = 'published'");
    expect(brainFactStatusClause(undefined, "f")).toBe("f.status = 'published'");
  });

  it("overlays draft+published in developer mode", () => {
    expect(brainFactStatusClause("developer", "f")).toBe(
      "f.status IN ('published', 'draft')",
    );
  });

  it("is the same definition the REGISTERED entry exposes", async () => {
    // One statement of the read gate. The tuple's `readFilter` delegates to the
    // helper rather than restating the clause — a parallel copy would let the
    // agent's published-mode read and this helper drift apart silently.
    const registry = makeService(CONTENT_MODE_TABLES);
    for (const mode of ["published", "developer"] as const) {
      expect(await Effect.runPromise(registry.readFilter("brain_facts", mode, "f"))).toBe(
        brainFactStatusClause(mode, "f"),
      );
    }
  });
});

describe("registration", () => {
  it("registers under exactly the table name the adapter reports", () => {
    // `tables.ts` spells the key as a LITERAL (the ESM-cycle TDZ forbids
    // importing the const), and `promotedCountsFromReports` matches an exotic
    // entry's `key` against the report's `table`. A drift between the two
    // spellings would silently report 0 promoted facts forever, so it is
    // pinned here rather than left to the duplication being obviously fine.
    const entry = CONTENT_MODE_TABLES.find((e) => e.key === BRAIN_FACTS_TABLE);
    expect(entry).toBeDefined();
    expect(entry?.kind).toBe("exotic");
  });

  it("does NOT register brain_episodes — evidence is not review-gated", async () => {
    // 0180 gives `brain_episodes` no `status` column at all: episodes are
    // append-only evidence, and only the CLAIMS drawn from them ride the gate.
    // Registering it would emit SQL against a column that does not exist.
    const registry = makeService(CONTENT_MODE_TABLES);
    const exit = await Effect.runPromise(
      Effect.either(registry.readFilter("brain_episodes", "published", "e")),
    );
    expect(exit._tag).toBe("Left");
  });
});
