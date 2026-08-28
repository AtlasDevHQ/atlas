/**
 * Unit coverage for `proposeFact` — the net-new-claim verb (#5482, ADR-0036 §T7).
 *
 * ## Why the reconcile stage runs FOR REAL here
 *
 * Three of #5482's acceptance criteria are claims about what SQL this path can
 * and cannot issue: it enters through `reconcileFacts` with no direct
 * `brain_facts` INSERT, every candidate it creates is `status = 'draft'`, and it
 * writes a `provenance` edge rather than a `derives-from` one. Stubbing the seam
 * would turn all three into assertions about a stub.
 *
 * So the seam is real and only the EXECUTOR is fake: every statement the whole
 * path issues is captured, and the assertions read that transcript. `INSERT_FACT_SQL`
 * naming no `status` column is then a fact this suite observes rather than one it
 * takes on trust — which is what makes "a proposal cannot reach `published`
 * through this path" a test rather than a comment.
 *
 * The statements are dispatched by IDENTITY against the seam's own exported
 * constants, so a paraphrased second spelling of any of them fails loudly here
 * instead of silently falling to the default arm.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  getLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  getRequestContext: () => undefined,
  withRequestContext: <T>(_ctx: unknown, fn: () => T) => fn(),
  redactPaths: [] as string[],
  scrubErrSerializer: (v: unknown) => v,
  scrubLogFormatter: (o: unknown) => o,
  hashShareToken: (t: string) => t,
  setLogLevel: () => true,
  ACTOR_KINDS: ["human", "agent", "mcp", "scheduler", "api_key"] as const,
}));

const {
  PROPOSAL_EPISODE_INSERT_SQL,
  PROPOSAL_REFUSAL_REASONS,
  proposalGrantTokens,
  proposeFact,
} = await import("@atlas/api/lib/brain/proposal");
const {
  CORROBORATION_LOOKUP_SQL,
  INSERT_FACT_SQL,
  INSERT_PROVENANCE_EDGE_SQL,
  INSERT_TENSION_EDGE_SQL,
  RECONCILE_LOCK_SQL,
  TENSION_CANDIDATES_SQL,
} = await import("@atlas/api/lib/brain/reconcile");
const { BrainReaderUnresolvedError } = await import("@atlas/api/lib/brain/reader-context");
const {
  CONVERSATION_OWNERSHIP_SQL,
  SESSION_EPISODE_INSERT_SQL,
  SESSION_EPISODE_SELECT_SQL,
} = await import("@atlas/api/lib/brain/session-episode");
const { DERIVES_FROM_EDGE_SQL } = await import("@atlas/api/lib/brain/correction");

/** An identity vocabulary — every norm maps to itself. */
const VOCABULARY = {
  subject: (n: string) => n,
  predicate: (n: string) => n,
  object: (n: string) => n,
} as unknown as Parameters<typeof proposeFact>[0]["vocabulary"];

const CTX = {
  origin: "authenticated" as const,
  workspaceId: "ws-1",
  userId: "u-1",
  // A plain member: the verb is deliberately not owner/admin-gated.
  role: "member" as const,
  audienceIds: ["org"] as readonly string[],
};

const CLAIM = { subject: "Ana", predicate: "is the DRI for", object: "billing" };
const AT = new Date("2026-08-27T12:00:00.000Z");
const CONVERSATION_ID = "11111111-2222-4333-8444-555555555555";
const SESSION = { conversationId: CONVERSATION_ID };

interface Executed {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/**
 * Answers the whole statement sequence; `corroborates` picks which arm
 * reconcile takes. The session statements (#5486) answer too: `sessionOwned`
 * false refuses the ownership gate, `sessionExisting` makes the idempotent
 * INSERT conflict so the path reuses the episode a previous propose minted.
 */
function makeExecutor(
  options: {
    corroborates?: boolean;
    sessionOwned?: boolean;
    sessionExisting?: { id: string; visible_to: unknown };
  } = {},
) {
  const executed: Executed[] = [];
  const tx = {
    query: async (sql: string, params: unknown[] = []) => {
      executed.push({ sql, params });
      if (sql === CONVERSATION_OWNERSHIP_SQL) {
        return { rows: options.sessionOwned === false ? [] : [{ id: CONVERSATION_ID }] };
      }
      if (sql === SESSION_EPISODE_INSERT_SQL) {
        return { rows: options.sessionExisting ? [] : [{ id: "sess-ep-1" }] };
      }
      if (sql === SESSION_EPISODE_SELECT_SQL) {
        return { rows: options.sessionExisting ? [options.sessionExisting] : [] };
      }
      if (sql === DERIVES_FROM_EDGE_SQL) return { rows: [{ id: "lineage-1" }] };
      if (sql === PROPOSAL_EPISODE_INSERT_SQL) return { rows: [{ id: "ep-1" }] };
      if (sql === RECONCILE_LOCK_SQL) return { rows: [] };
      if (sql === CORROBORATION_LOOKUP_SQL) {
        return { rows: options.corroborates ? [{ id: "fact-existing" }] : [] };
      }
      if (sql === INSERT_FACT_SQL) return { rows: [{ id: "fact-new" }] };
      if (sql === INSERT_PROVENANCE_EDGE_SQL) return { rows: [{ id: "edge-1" }] };
      if (sql === TENSION_CANDIDATES_SQL) return { rows: [] };
      if (sql === INSERT_TENSION_EDGE_SQL) return { rows: [{ id: "tension-1" }] };
      throw new Error(`unexpected statement in the proposal path:\n${sql}`);
    },
  };
  return {
    executed,
    deps: {
      withTransaction: <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
      now: () => AT,
      newProposalId: () => "pid-1",
    } as unknown as Parameters<typeof proposeFact>[1],
  };
}

let harness: ReturnType<typeof makeExecutor>;
beforeEach(() => {
  harness = makeExecutor();
});

describe("the episode", () => {
  it("writes one human-sourced episode with a proposal: source id", async () => {
    await proposeFact({ ctx: CTX, claim: CLAIM, vocabulary: VOCABULARY }, harness.deps);

    const episode = harness.executed.find((e) => e.sql === PROPOSAL_EPISODE_INSERT_SQL);
    expect(episode).toBeDefined();
    expect(episode?.params[0]).toBe("ws-1");
    expect(episode?.params[1]).toBe("proposal:pid-1");
    expect(episode?.params[2]).toBe("u-1");
    // The statement itself pins `source = 'human'` — the connector-class
    // vocabulary's own member for an authored record.
    expect(PROPOSAL_EPISODE_INSERT_SQL).toContain("'human'");
  });

  it("records the claim and the reason verbatim in the episode body", async () => {
    await proposeFact(
      { ctx: CTX, claim: { ...CLAIM, reason: "Ana said so in standup" }, vocabulary: VOCABULARY },
      harness.deps,
    );
    const episode = harness.executed.find((e) => e.sql === PROPOSAL_EPISODE_INSERT_SQL);
    const body = JSON.parse(String(episode?.params[3])) as Record<string, unknown>;
    expect(body.kind).toBe("proposal");
    expect(body.claim).toEqual(CLAIM);
    expect(body.reason).toBe("Ana said so in standup");
    expect(body.actor).toBe("u-1");
  });

  it("grants the workspace, not the proposer", async () => {
    // A draft granted only to its author is invisible to every reviewer and
    // refused at every publish forever — the `GRANT_UNUSABLE` dead end. The
    // grant is built from `acl.ts`'s constant rather than a literal.
    await proposeFact({ ctx: CTX, claim: CLAIM, vocabulary: VOCABULARY }, harness.deps);
    const episode = harness.executed.find((e) => e.sql === PROPOSAL_EPISODE_INSERT_SQL);
    expect(JSON.parse(String(episode?.params[5]))).toEqual(["org"]);
    expect(proposalGrantTokens()).toEqual(["org"]);
  });

  it("attributes an unauthenticated-local deployment to the operator class", async () => {
    const local = {
      origin: "unauthenticated-local" as const,
      workspaceId: "ws-1",
      userId: null,
      role: null,
      audienceIds: [] as const,
    };
    await proposeFact({ ctx: local, claim: CLAIM, vocabulary: VOCABULARY }, harness.deps);
    const episode = harness.executed.find((e) => e.sql === PROPOSAL_EPISODE_INSERT_SQL);
    expect(episode?.params[2]).toBe("local-operator");
  });
});

describe("⭐ draft-only, and the seam is what makes it structural", () => {
  it("issues no statement that touches brain_facts other than the seam's own INSERT", async () => {
    await proposeFact({ ctx: CTX, claim: CLAIM, vocabulary: VOCABULARY }, harness.deps);

    const factWrites = harness.executed.filter(
      (e) => /\bbrain_facts\b/i.test(e.sql) && /\b(insert|update)\b/i.test(e.sql),
    );
    expect(factWrites.map((e) => e.sql)).toEqual([INSERT_FACT_SQL]);
  });

  it("no statement on this path names `status` or `published`", async () => {
    // ⭐ #5482's third acceptance criterion: "a test that fails if a proposal can
    // reach `published` through this path". Asserted over the WHOLE transcript
    // rather than over this module's own SQL, because the module delegates — a
    // seam that started naming the column would be exactly as much of a
    // regression as this file growing an UPDATE.
    await proposeFact({ ctx: CTX, claim: CLAIM, vocabulary: VOCABULARY }, harness.deps);

    for (const { sql } of harness.executed) {
      expect(sql, `a statement on the proposal path names \`status\`:\n${sql}`).not.toMatch(
        /\bstatus\b/i,
      );
      expect(sql, `a statement on the proposal path names 'published':\n${sql}`).not.toMatch(
        /'published'/i,
      );
    }
    // Not vacuous — the transcript really did create a fact.
    expect(harness.executed.some((e) => e.sql === INSERT_FACT_SQL)).toBe(true);
  });

  it("reports the created status as the literal draft", async () => {
    const outcome = await proposeFact(
      { ctx: CTX, claim: CLAIM, vocabulary: VOCABULARY },
      harness.deps,
    );
    expect(outcome.kind).toBe("proposed");
    if (outcome.kind !== "proposed") throw new Error("expected a created draft");
    expect(outcome.result.status).toBe("draft");
    expect(outcome.result.factId).toBe("fact-new");
    expect(outcome.result.proposalEpisodeId).toBe("ep-1");
  });
});

describe("⭐ the edge is provenance, not derives-from", () => {
  it("writes the seam's provenance edge for a newly created draft", async () => {
    await proposeFact({ ctx: CTX, claim: CLAIM, vocabulary: VOCABULARY }, harness.deps);

    const edges = harness.executed.filter((e) => e.sql === INSERT_PROVENANCE_EDGE_SQL);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.params).toEqual(["ws-1", "fact-new", "ep-1"]);
    expect(INSERT_PROVENANCE_EDGE_SQL).toContain("'provenance'");
  });

  it("no statement on this path writes a derives-from edge", async () => {
    // The distinction `correction.ts` draws: `derives-from` says the episode
    // REFUTES the claim, `provenance` says it is EVIDENCE FOR it. A proposal is
    // a vouch, and the provenance edge is also the one feeding the
    // distinct-source corroboration count.
    await proposeFact({ ctx: CTX, claim: CLAIM, vocabulary: VOCABULARY }, harness.deps);
    for (const { sql } of harness.executed) {
      expect(sql).not.toContain("derives-from");
    }
  });
});

describe("the candidate handed to the seam", () => {
  it("asserts no cardinality, so it mints no advisory tension edge of its own", async () => {
    // A proposer has not asserted that the slot holds one value — unlike a
    // human SUPERSEDING one, which is `correction.ts`'s premise for hard-coding
    // `single`. Omitting the hint takes reconcile's conservative default, and
    // the observable consequence is that the tension scan never runs.
    await proposeFact({ ctx: CTX, claim: CLAIM, vocabulary: VOCABULARY }, harness.deps);
    expect(harness.executed.some((e) => e.sql === TENSION_CANDIDATES_SQL)).toBe(false);
    expect(harness.executed.some((e) => e.sql === INSERT_TENSION_EDGE_SQL)).toBe(false);
  });

  it("defaults valid_from to the proposal's own timestamp", async () => {
    await proposeFact({ ctx: CTX, claim: CLAIM, vocabulary: VOCABULARY }, harness.deps);
    const insert = harness.executed.find((e) => e.sql === INSERT_FACT_SQL);
    // The seam binds timestamps as ISO strings, not `Date`s — `$5::timestamptz`.
    expect(insert?.params[4]).toBe(AT.toISOString());
    // …and `extracted_at` is null: an authored claim is not extracted from
    // anything.
    expect(insert?.params[5]).toBeNull();
  });

  it("carries an explicit valid_from through unchanged", async () => {
    const from = new Date("2026-01-15T00:00:00.000Z");
    await proposeFact(
      { ctx: CTX, claim: { ...CLAIM, validFrom: from }, vocabulary: VOCABULARY },
      harness.deps,
    );
    const insert = harness.executed.find((e) => e.sql === INSERT_FACT_SQL);
    expect(insert?.params[4]).toBe(from.toISOString());
  });

  it("names `proposal` as the producer in the stored provenance", async () => {
    await proposeFact({ ctx: CTX, claim: CLAIM, vocabulary: VOCABULARY }, harness.deps);
    const insert = harness.executed.find((e) => e.sql === INSERT_FACT_SQL);
    const provenance = JSON.parse(String(insert?.params[7])) as Record<string, unknown>;
    expect(provenance.producer).toBe("proposal");
    expect(provenance.source).toBe("human");
    expect(provenance.actor).toBe("user:u-1");
  });

  it("runs the whole path in ONE transaction — the episode and the fact commit together", async () => {
    // Asserted via the executor identity: every statement, the episode insert
    // included, arrives on the same handle. The seam would otherwise open its
    // own, and a nested checkout under a held connection is the bounded-pool
    // starvation deadlock `withBrainTransaction` documents.
    let handles = 0;
    const tx = {
      query: async (sql: string) => {
        if (sql === PROPOSAL_EPISODE_INSERT_SQL) return { rows: [{ id: "ep-1" }] };
        if (sql === CORROBORATION_LOOKUP_SQL) return { rows: [] };
        if (sql === INSERT_FACT_SQL) return { rows: [{ id: "fact-new" }] };
        return { rows: [{ id: "x" }] };
      },
    };
    await proposeFact({ ctx: CTX, claim: CLAIM, vocabulary: VOCABULARY }, {
      withTransaction: <T,>(fn: (t: typeof tx) => Promise<T>) => {
        handles += 1;
        return fn(tx);
      },
      now: () => AT,
      newProposalId: () => "pid-1",
    } as unknown as Parameters<typeof proposeFact>[1]);
    expect(handles).toBe(1);
  });
});

describe("corroboration — the arm with no review gate behind it", () => {
  it("records evidence against the existing fact instead of a second row", async () => {
    const corroborating = makeExecutor({ corroborates: true });
    const outcome = await proposeFact(
      { ctx: CTX, claim: CLAIM, vocabulary: VOCABULARY },
      corroborating.deps,
    );

    expect(outcome.kind).toBe("corroborated");
    if (outcome.kind !== "corroborated") throw new Error("expected corroboration");
    expect(outcome.result.factId).toBe("fact-existing");
    expect(outcome.result.evidenceAdded).toBe(true);
    // No new fact row — that is what "strengthens, never duplicates" means.
    expect(corroborating.executed.some((e) => e.sql === INSERT_FACT_SQL)).toBe(false);
  });

  it("attaches the provenance edge to the EXISTING fact", async () => {
    // This edge is the whole reason the verb needs an entry gate: it lands
    // immediately and unreviewed, feeding the distinct-source corroboration
    // count and resetting the staleness anchor, with no draft for a human to
    // catch. `proposeFact` has exactly one production caller — the confirm
    // endpoint — and this test says what that caller is protecting.
    const corroborating = makeExecutor({ corroborates: true });
    await proposeFact({ ctx: CTX, claim: CLAIM, vocabulary: VOCABULARY }, corroborating.deps);

    const edges = corroborating.executed.filter((e) => e.sql === INSERT_PROVENANCE_EDGE_SQL);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.params).toEqual(["ws-1", "fact-existing", "ep-1"]);
  });
});

describe("⭐ the session path (#5486, lock 3)", () => {
  it("materializes the session episode lazily, inside the SAME transaction, before the proposal episode", async () => {
    await proposeFact(
      { ctx: CTX, claim: CLAIM, session: SESSION, vocabulary: VOCABULARY },
      harness.deps,
    );
    const order = harness.executed.map((e) => e.sql);
    expect(order.indexOf(CONVERSATION_OWNERSHIP_SQL)).toBe(0);
    expect(order.indexOf(SESSION_EPISODE_INSERT_SQL)).toBeLessThan(
      order.indexOf(PROPOSAL_EPISODE_INSERT_SQL),
    );
  });

  it("⭐ seeds the grant from the session — the actor plus what the episode carried — and `org` appears NOWHERE", async () => {
    // The acceptance criterion: a proposal cannot land at `[org]` without an
    // explicit widening. Asserted over the WHOLE transcript rather than the
    // one grant parameter, because any statement smuggling the workspace token
    // in — the episode, the fact, an edge — would be the same defect.
    await proposeFact(
      { ctx: CTX, claim: CLAIM, session: SESSION, vocabulary: VOCABULARY },
      harness.deps,
    );
    const proposalEpisode = harness.executed.find((e) => e.sql === PROPOSAL_EPISODE_INSERT_SQL);
    expect(JSON.parse(String(proposalEpisode?.params[5]))).toEqual(["user:u-1"]);
    for (const { sql, params } of harness.executed) {
      for (const param of params) {
        expect(
          [sql, param, typeof param === "string" && /"org"|^org$/.test(param)],
        ).toEqual([sql, param, false]);
      }
    }
    // Not vacuous: the narrow grant really did reach the fact row.
    expect(harness.executed.some((e) => e.sql === INSERT_FACT_SQL)).toBe(true);
  });

  it("passes `org` through only when the session episode already carried it — the explicit widening", async () => {
    const widened = makeExecutor({
      sessionExisting: { id: "sess-ep-0", visible_to: ["user:u-1", "org"] },
    });
    await proposeFact(
      { ctx: CTX, claim: CLAIM, session: SESSION, vocabulary: VOCABULARY },
      widened.deps,
    );
    const proposalEpisode = widened.executed.find((e) => e.sql === PROPOSAL_EPISODE_INSERT_SQL);
    expect(JSON.parse(String(proposalEpisode?.params[5]))).toEqual(["user:u-1", "org"]);
  });

  it("writes the derives-from lineage edge from the created draft to the session episode", async () => {
    // Lock 3's edge — and deliberately NOT `provenance`: the proposal episode
    // already carries the vouch through the seam, and a session episode
    // feeding the corroboration count too would make one act of testimony
    // count as two distinct sources.
    await proposeFact(
      { ctx: CTX, claim: CLAIM, session: SESSION, vocabulary: VOCABULARY },
      harness.deps,
    );
    const lineage = harness.executed.filter((e) => e.sql === DERIVES_FROM_EDGE_SQL);
    expect(lineage).toHaveLength(1);
    expect(lineage[0]?.params).toEqual(["ws-1", "fact-new", "sess-ep-1"]);
    // The vouch is still the proposal episode's, untouched.
    const vouch = harness.executed.filter((e) => e.sql === INSERT_PROVENANCE_EDGE_SQL);
    expect(vouch).toHaveLength(1);
    expect(vouch[0]?.params).toEqual(["ws-1", "fact-new", "ep-1"]);
  });

  it("writes NO lineage edge on the corroborated arm — the fact predates the session", async () => {
    const corroborating = makeExecutor({ corroborates: true });
    const outcome = await proposeFact(
      { ctx: CTX, claim: CLAIM, session: SESSION, vocabulary: VOCABULARY },
      corroborating.deps,
    );
    expect(outcome.kind).toBe("corroborated");
    expect(corroborating.executed.some((e) => e.sql === DERIVES_FROM_EDGE_SQL)).toBe(false);
    // The session episode still materialized — the act happened in it — so a
    // later propose from this conversation reuses it.
    expect(corroborating.executed.some((e) => e.sql === SESSION_EPISODE_INSERT_SQL)).toBe(true);
  });

  it("refuses a session the actor cannot claim, as an ordinary outcome, with nothing written", async () => {
    const unowned = makeExecutor({ sessionOwned: false });
    const outcome = await proposeFact(
      { ctx: CTX, claim: CLAIM, session: SESSION, vocabulary: VOCABULARY },
      unowned.deps,
    );
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") throw new Error("expected a refusal");
    expect(outcome.reason).toBe(PROPOSAL_REFUSAL_REASONS.sessionNotFound);
    expect(outcome.message).toContain("nothing was recorded");
    // The ownership SELECT is the only statement that ran.
    expect(unowned.executed.map((e) => e.sql)).toEqual([CONVERSATION_OWNERSHIP_SQL]);
  });

  it("a session-LESS proposal still takes the disclosed workspace grant, unchanged", async () => {
    // The fallback #5482 argued for survives the session path landing: with no
    // session to inherit from, narrowing to the actor alone would be the dead
    // draft `proposalGrantTokens`'s header rules out.
    await proposeFact({ ctx: CTX, claim: CLAIM, vocabulary: VOCABULARY }, harness.deps);
    const episode = harness.executed.find((e) => e.sql === PROPOSAL_EPISODE_INSERT_SQL);
    expect(JSON.parse(String(episode?.params[5]))).toEqual(["org"]);
    expect(harness.executed.some((e) => e.sql === CONVERSATION_OWNERSHIP_SQL)).toBe(false);
    expect(harness.executed.some((e) => e.sql === SESSION_EPISODE_INSERT_SQL)).toBe(false);
  });
});

describe("refusals", () => {
  it("refuses a claim that asserts nothing, naming the positions", async () => {
    const outcome = await proposeFact(
      { ctx: CTX, claim: { subject: "Ana", predicate: "is the DRI for", object: "   " }, vocabulary: VOCABULARY },
      harness.deps,
    );
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") throw new Error("expected a refusal");
    expect(outcome.reason).toBe(PROPOSAL_REFUSAL_REASONS.malformedClaim);
    // The BLANK half of `MALFORMED_CLAIM` carries no `unkeyed` detail at the
    // seam, so a message that only relayed it would name nothing to fix. This is
    // the assertion that keeps the local recomputation honest.
    expect(outcome.message).toContain("object");
    expect(outcome.message).toContain("Nothing was recorded");
    // Nothing reached the fact graph.
    expect(harness.executed.some((e) => e.sql === INSERT_FACT_SQL)).toBe(false);
  });

  it("refuses a surface that normalizes away to nothing", async () => {
    // `___` is a real surface with no identity — the `degenerate-surface` cause.
    // Unlike `correction.ts`'s narrower arm this fires at any position, because
    // all three are the human's own text here.
    const outcome = await proposeFact(
      { ctx: CTX, claim: { subject: "___", predicate: "is the DRI for", object: "billing" }, vocabulary: VOCABULARY },
      harness.deps,
    );
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") throw new Error("expected a refusal");
    expect(outcome.message).toContain("subject");
  });

  it("throws rather than proposing when the actor is unresolved", async () => {
    // Attributing a claim to nobody is the one thing the seam already refuses;
    // refusing here produces the same rollback with a diagnosis that names the
    // cause. No episode is written either.
    const unresolved = {
      origin: "unresolved" as const,
      workspaceId: "ws-1",
      userId: null,
      role: null,
      audienceIds: [] as const,
    };
    await expect(
      proposeFact({ ctx: unresolved, claim: CLAIM, vocabulary: VOCABULARY }, harness.deps),
    ).rejects.toBeInstanceOf(BrainReaderUnresolvedError);
    expect(harness.executed).toHaveLength(0);
  });
});
