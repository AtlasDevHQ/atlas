/**
 * The observation half of the fused read (#4773).
 *
 * Split from `search.test.ts` because it needs
 * `mock.module("@atlas/api/lib/logger")` installed before the module under test
 * is imported, and that file deliberately runs with no module mocking at all —
 * same split, and the same reasoning, as `acl-logging.test.ts`.
 *
 * Why it is worth a file: every one of these log calls could be deleted and
 * `search.test.ts` would stay green, because the RESULTS are unaffected. They
 * are the ONLY artifact of three degradations —
 *
 *   - a grant that passed the predicate on one valid token while carrying junk
 *     the author believed was doing something (`acl.ts` calls read-time the
 *     only seam a push-down predicate leaves open for this);
 *   - a `visible_to` that did not decode as an array at all, i.e. drift on the
 *     ACL's own column, which skips the seam above entirely;
 *   - a truncated conflict list, which renders as "nothing contradicts this".
 *
 * — and the only ATTRIBUTION for two more, where the caller can see the effect
 * but not the cause: a counter that failed to decode (visible as
 * `corroborationCount: 0`, indistinguishable from a genuinely uncorroborated
 * claim) and a row dropped for a missing id (visible only as an absence).
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

type LogCall = { level: "error" | "warn" | "info" | "debug"; payload: unknown; message: string };
const logCalls: LogCall[] = [];

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    error: (payload: unknown, message: string) => logCalls.push({ level: "error", payload, message }),
    warn: (payload: unknown, message: string) => logCalls.push({ level: "warn", payload, message }),
    info: (payload: unknown, message: string) => logCalls.push({ level: "info", payload, message }),
    debug: (payload: unknown, message: string) => logCalls.push({ level: "debug", payload, message }),
  }),
  getLogger: () => ({ error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, level: "info" }),
  setLogLevel: () => true,
  getRequestContext: () => undefined,
  ACTOR_KINDS: ["human", "agent", "mcp", "scheduler", "api_key"] as const,
  withRequestContext: <T,>(_ctx: unknown, fn: () => T): T => fn(),
  redactPaths: [] as string[],
  scrubErrSerializer: (value: unknown) => value,
  scrubLogFormatter: (obj: unknown) => obj,
  hashShareToken: (token: string) => token,
}));

const { searchBrainCore, TENSION_FANOUT_CAP } = await import("@atlas/api/lib/brain/search");
type BrainSearchReader = Parameters<typeof searchBrainCore>[0];
type BrainPrincipalContext = Parameters<typeof searchBrainCore>[1]["ctx"];

const WS = "ws-search-logging";
const SQL = {
  // `last_observed_at` — the decay anchor (#4914), and the one column only the
  // fact-page statement selects. Corroboration is not unique to it (#4913 gave
  // the counterpart statement that subquery), and neither is `f.valid_to`, which
  // this key used to name: #4935 put that column in `COUNTERPART_COLUMNS` too, so
  // the key had been ambiguous since then.
  //
  // ⚠️ The collision was LIVE, not merely possible — "logs AND flags when the
  // conflict fan-out is truncated" below registers a counterpart response, and
  // under first-match-wins `find()` the counterpart statement was answered with
  // the FACT PAGE's row.
  //
  // It was nonetheless INERT, and the reason is worth stating exactly, because
  // the obvious explanation ("the test just doesn't assert the counterpart
  // list") is wrong and would mislead the next author into thinking a wider
  // assertion catches this. It does not. `loadTensionClusters` keys its
  // `visible` map by counterpart row id and reads it back only via
  // `visible.get(pair.other)`; that test's edges are `fact-1 → rival-i`, so
  // every `other` is a `rival-i` and the substituted row — `id: "fact-1"` —
  // is never looked up. The cluster comes out byte-identical to the intended
  // empty list, no warn fires, and `res` is unchanged. Verified by reverting
  // the key and disabling the throw: the test still passes, clean.
  //
  // So the lesson is not "assert more". It is that a wrong answer discarded by
  // keying before it reaches any output is invisible to ASSERTIONS ALTOGETHER —
  // only a structural check at the dispatch point can see it, which is what the
  // throw below is. #5028
  // removed `predicate_cardinality` from `FACT_COLUMNS`, which makes it and
  // `COUNTERPART_COLUMNS` byte-identical — so no key drawn from the shared column
  // list can separate the two statements again, and the discriminator must come
  // from what `buildFactQuery` APPENDS.
  factPage: "AS last_observed_at",
  episodePage: "FROM brain_episodes e",
  tensionEdges: "edge_type = 'in-tension-with'",
  tensionCounterparts: "AND f.id = ANY(",
} as const;

function ctx(): BrainPrincipalContext {
  return {
    origin: "authenticated",
    workspaceId: WS,
    userId: "user-1",
    role: "member",
    audienceIds: [],
  };
}

function reader(
  responses: Array<{ match: string; rows: Record<string, unknown>[] }> = [],
): BrainSearchReader {
  return {
    query: async (sql: string) => {
      // ENFORCED rather than trusted, on `search.test.ts`'s precedent. `find()`
      // is first-match-wins, so an ambiguous key does not fail — it answers one
      // statement with another's rows and the assertion passes VACUOUSLY. That
      // is how `f.valid_to` survived #4935 here; the throw makes the next
      // collision self-reporting instead of silent.
      const hits = responses.filter((r) => sql.includes(r.match));
      if (hits.length > 1) {
        throw new Error(
          `ambiguous SQL fixture key: ${hits.map((h) => JSON.stringify(h.match)).join(", ")} all match one statement — one of them must move to a column exactly one statement selects`,
        );
      }
      return { rows: hits[0]?.rows ?? [] };
    },
  };
}

function factRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "fact-1",
    subject: "s",
    predicate: "p",
    object: "o",
    status: "published",
    visible_to: ["org"],
    // ⚠️ BOTH of these are selected by the fact statement, and omitting them is
    // not neutral: each drives a degradation warn of its own
    // (`attributionDecision`'s missing-column arm, and `toFactResult`'s
    // `last_observed_at === undefined` arm). Without them every fact test in
    // this file ran at a noise floor of two FABRICATED degradations — in the one
    // file whose whole premise is that those warn lines are the only artifact of
    // a degradation. Present and null, mirroring `search.test.ts`'s fixture.
    pre_widening_visible_to: null,
    last_observed_at: null,
    provenance: {},
    source_episode_id: "ep-1",
    valid_from: null,
    valid_to: null,
    invalidated_at: null,
    ingested_at: null,
    corroboration_count: 1,
    snippet: null,
    ...overrides,
  };
}

function warnings(fragment: string): LogCall[] {
  return logCalls.filter((c) => c.level === "warn" && c.message.includes(fragment));
}

function run(db: BrainSearchReader, include: ("fact" | "raw-episode" | "document")[] = ["fact"]) {
  return searchBrainCore(db, { ctx: ctx(), mode: "published", include, limit: 10, expand: false });
}

beforeEach(() => {
  logCalls.length = 0;
});

describe("searchBrain observation", () => {
  it("reports a grant carrying junk alongside a valid token", async () => {
    // `['user:abc', 'everyone']` PASSES the predicate on its valid token, so the
    // row is served — while the author plainly believed the second token did
    // something. This read is one of the few places holding such a row.
    await run(reader([{ match: SQL.factPage, rows: [factRow({ visible_to: ["org", "everyone"] })] }]));
    const anomalies = warnings("outside the grammar");
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].payload).toMatchObject({
      table: "brain_facts",
      rowId: "fact-1",
      malformed: ["everyone"],
    });
  });

  it("says nothing for a wholly well-formed grant", async () => {
    const res = await run(reader([{ match: SQL.factPage, rows: [factRow()] }]));
    // ⚠️ The fixture must have been ANSWERED. This is the one bare-negative
    // assertion in the file, so it is also the one test that stays green when
    // `SQL.factPage` matches NOTHING — a dead key returns zero rows, and zero
    // rows carry no grant to warn about. The length check is what makes the
    // fixture load-bearing rather than decorative.
    expect(res.results).toHaveLength(1);
    expect(warnings("outside the grammar")).toHaveLength(0);
  });

  it("reports drift, not a fabricated age, when the SELECT drops the decay anchor", async () => {
    // The twin of `candidates.test.ts`'s "reports drift, not a fabricated
    // label" — and it did not exist until #5028 phase 1b, which is the PR that
    // makes it matter: `search.ts`'s `last_observed_at === undefined` arm is the
    // detector for "a column left the fact SELECT", and removing a column from
    // that SELECT is precisely what phase 1b does. `pg` never yields `undefined`
    // for a selected column, so a row without the key means the statement
    // stopped selecting it.
    const { last_observed_at: _dropped, ...row } = factRow();
    await run(reader([{ match: SQL.factPage, rows: [row] }]));
    expect(warnings("no longer selects the decay anchor")).toHaveLength(1);
  });

  it("reports a `visible_to` that did not decode as an array at all", async () => {
    // Drift on the ACL's own column. Without this arm the row silently skips
    // the anomaly seam — the one case where "no warning" means "not inspected"
    // rather than "clean".
    await run(reader([{ match: SQL.factPage, rows: [factRow({ visible_to: "org" })] }]));
    expect(warnings("did not decode as an array")).toHaveLength(1);
  });

  it("reports an episode grant too — the episode is gated in its own right", async () => {
    await run(
      reader([
        {
          match: SQL.episodePage,
          rows: [
            {
              id: "ep-1",
              source: "slack",
              source_id: "m-1",
              source_actor: null,
              body: "b",
              locator: null,
              occurred_at: null,
              ingested_at: null,
              extracted_at: null,
              visible_to: ["org", "team:eng"],
              snippet: null,
            },
          ],
        },
      ]),
      ["raw-episode"],
    );
    const anomalies = warnings("outside the grammar");
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].payload).toMatchObject({ table: "brain_episodes", malformed: ["team:eng"] });
  });

  it("logs AND flags when the conflict fan-out is truncated", async () => {
    // Both halves are required: the flag tells the caller, the log tells the
    // operator. A truncated conflict list reads as "nothing contradicts this".
    const edges = Array.from({ length: TENSION_FANOUT_CAP + 1 }, (_, i) => ({
      from_id: "fact-1",
      to_id: `rival-${i}`,
    }));
    const res = await run(
      reader([
        { match: SQL.factPage, rows: [factRow()] },
        { match: SQL.tensionEdges, rows: edges },
        { match: SQL.tensionCounterparts, rows: [] },
      ]),
    );
    expect(res.tensionsTruncated).toBe(true);
    expect(warnings("exceeded the per-page cap")).toHaveLength(1);
  });

  it("reports a counter column that did not decode — understating evidence is not silent", async () => {
    await run(reader([{ match: SQL.factPage, rows: [factRow({ corroboration_count: "many" })] }]));
    expect(warnings("understates it")).toHaveLength(1);
  });

  it("reports a dropped fact row with no usable id", async () => {
    await run(reader([{ match: SQL.factPage, rows: [factRow({ id: null })] }]));
    expect(warnings("the fact query shape changed")).toHaveLength(1);
  });
});
