/**
 * The alias-proposal producer's OPERATOR-FACING lines (#5034, ADR-0037 §4).
 *
 * Two of this module's log statements are the only thing standing between a
 * pair of states that are otherwise byte-identical to every caller, and both
 * were deletable green until this file existed:
 *
 *   - the `log.error` on an all-rows-dropped read — *the reader has drifted from
 *     the statement* versus *the corpus supports nothing*. Under drift the line
 *     ABOVE it logs the false one at `debug`, and `extract.ts` types the
 *     producer's return as `Promise<unknown>` and discards it, so no caller
 *     could tell either way;
 *   - the truncation `warn` — the only thing that makes "25 candidates" read as
 *     "at least 25", and the line `ALIAS_PROPOSAL_CANDIDATE_CAP`'s docstring
 *     sends an operator to when a proposal is missing.
 *
 * A docstring that makes a load-bearing claim about a line nothing checks is a
 * claim, not a guarantee — which is the whole reason this repo generates
 * mutation tables. Both mutations (`if (…)` → `if (false)`) measured ZERO before
 * this file.
 *
 * ## Why a separate file
 *
 * `acl-logging.test.ts`'s pattern, and its constraint: mocking the logger means
 * `mock.module`ing **every** value export of `@atlas/api/lib/logger` and then
 * importing the module under test DYNAMICALLY, so the mock is installed before
 * the import binds. That is process-wide, so it cannot share a file with suites
 * that want real logging — which is why the sibling `*-logging.test.ts` files
 * exist rather than a `describe` block.
 *
 * No database: `loadAliasCandidates` takes an injected executor, so every case
 * here is a scripted result set. The MATCHING lives in `alias-proposal-pg.test.ts`.
 */

import { afterEach, beforeAll, describe, expect, it, mock } from "bun:test";

interface Captured {
  readonly payload: unknown;
  readonly message: string;
}

const errors: Captured[] = [];
const warns: Captured[] = [];
const debugs: Captured[] = [];

/**
 * Every value export of `lib/logger`, replaced.
 *
 * ⚠️ A PARTIAL mock is the trap this repo has recorded: `mock.module` replaces
 * the whole module, so any export left out becomes `undefined` and the module
 * under test throws on first use — which reads as a broken test rather than a
 * missing mock. The factory is SYNCHRONOUS, because an async one deadlocks
 * `bun:test`.
 */
mock.module("@atlas/api/lib/logger", () => {
  const record = (sink: Captured[]) => (payload: unknown, message?: unknown) =>
    sink.push({ payload, message: typeof message === "string" ? message : String(payload) });
  const capture = {
    error: record(errors),
    warn: record(warns),
    info: () => {},
    debug: record(debugs),
    level: "info",
  };
  return {
    createLogger: () => capture,
    // ⚠️ ALL TEN value exports of `lib/logger.ts`, on `acl-logging.test.ts`'s
    // template. The first cut supplied three — and two of those (`logger`,
    // `default`) are not exports of that module at all, while seven real ones
    // were missing. It passed only because `alias-proposal.ts`'s import graph
    // happens to reach `createLogger` alone; `lib/settings.ts` is one import
    // away, already reached by neighbouring brain modules, and uses `getLogger`
    // and `setLogLevel`. The failure when that lands is an `undefined is not a
    // function` in a file with nothing to do with this one, which is exactly
    // why the rule is "mock every export".
    getLogger: () => ({ error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, level: "info" }),
    setLogLevel: () => true,
    getRequestContext: () => undefined,
    withRequestContext: <T,>(_ctx: unknown, fn: () => T): T => fn(),
    ACTOR_KINDS: ["human", "agent", "mcp", "scheduler", "api_key"] as const,
    redactPaths: [] as string[],
    scrubErrSerializer: (value: unknown) => value,
    scrubLogFormatter: (obj: unknown) => obj,
    hashShareToken: (token: string) => token,
  };
});

type LoadAliasCandidates =
  typeof import("@atlas/api/lib/brain/alias-proposal")["loadAliasCandidates"];

let loadAliasCandidates: LoadAliasCandidates;
let candidateCap: number;

beforeAll(async () => {
  // DYNAMIC, after the mock above is installed — a static import binds the real
  // logger at module-evaluation time and every assertion here reads an empty
  // sink while the lines print to stdout.
  const mod = await import("@atlas/api/lib/brain/alias-proposal");
  loadAliasCandidates = mod.loadAliasCandidates;
  candidateCap = mod.ALIAS_PROPOSAL_CANDIDATE_CAP;
});

afterEach(() => {
  errors.length = 0;
  warns.length = 0;
  debugs.length = 0;
});

/** A row shaped as `ALIAS_PROPOSAL_SQL` selects it. */
const row = (over: Record<string, unknown> = {}) => ({
  from_norm: "is priced at",
  to_norm: "priced at",
  subjects: 2,
  from_warehouse: false,
  to_warehouse: false,
  ...over,
});

const executorFor = (rows: readonly unknown[]) => ({
  query: async () => ({ rows }),
});

describe("the alias-proposal producer's operator lines (#5034)", () => {
  it("ERRORS when the query returned rows and none of them read back", async () => {
    // ⭐ The line that distinguishes *the reader drifted* from *the corpus
    // supports nothing*. At `error` deliberately: every caller sees an empty
    // candidate list either way, and the per-row `warn`s below it describe rows
    // rather than the run.
    const found = await loadAliasCandidates(executorFor([null, null, {}]), "ws-1");
    expect(found).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("the reader has drifted");
    expect(errors[0]!.payload).toMatchObject({ workspaceId: "ws-1", rows: 3 });
  });

  it("WARNS when the cap bound the run, naming the cap", async () => {
    // The only line that makes a bounded run legible as bounded.
    await loadAliasCandidates(executorFor([row(), row()]), "ws-1", 2);
    const truncation = warns.filter((w) => w.message.includes("candidate cap"));
    expect(truncation).toHaveLength(1);
    expect(truncation[0]!.payload).toMatchObject({ workspaceId: "ws-1", cap: 2 });
  });

  it("says NOTHING on an ordinary run — neither line is unconditional", async () => {
    // ⭐ The prohibition, and the half every logging suite in this repo carries:
    // without it a reader that shouts on every run passes both tests above. A
    // healthy read under the shipped cap must be silent at `warn` and `error`
    // alike.
    const found = await loadAliasCandidates(executorFor([row()]), "ws-1", candidateCap);
    expect(found).toHaveLength(1);
    expect([...errors, ...warns]).toEqual([]);
  });

  it("keeps the per-row drop WARN when only some rows fail to read", async () => {
    // The partial case, which must NOT reach the `error` arm: some rows read
    // back, so the corpus is being reported honestly and only the unreadable
    // ones are dropped. Getting this wrong in the other direction would put an
    // `error` on every run that meets one odd row.
    const found = await loadAliasCandidates(
      executorFor([row({ subjects: "2" }), row({ from_norm: "unit price" })]),
      "ws-1",
    );
    expect(found.map((c) => c.fromNorm)).toEqual(["unit price"]);
    expect(errors).toEqual([]);
    expect(warns).toHaveLength(1);
  });
});
