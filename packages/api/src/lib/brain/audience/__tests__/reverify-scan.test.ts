/**
 * The shared re-verify candidate scan (#4971).
 *
 * One property carries this module and it is not about SQL: **a caller cannot
 * consume a slot without rotating the audience out of the front of the next
 * scan.** That is what makes the fix inheritable rather than something each
 * connector re-implements and each new source re-breaks — so the tests here are
 * about the COUPLING between the scan and the stamp, and the ordering itself is
 * proved where it can actually run, in `audience-sync-pg.test.ts`.
 *
 * Every stub is typed to the real `query` signature rather than to a convenient
 * paraphrase: a stub typed `async (sql: string) => …` is green under `bun test`
 * and red only in the separate type gate, which is a failure mode this suite is
 * not willing to have.
 */

import { describe, expect, it } from "bun:test";
import {
  REVERIFY_CANDIDATES_SQL,
  TOUCH_REVERIFY_ATTEMPT_SQL,
  selectReverifyCandidates,
  type ReverifyCandidateScan,
  type ReverifyScanDeps,
} from "@atlas/api/lib/brain/audience/reverify";

interface Call {
  readonly sql: string;
  readonly params: readonly unknown[];
}

interface ScanRow extends Record<string, unknown> {
  readonly token: string;
  readonly has_members: boolean;
}

/**
 * A `query` double typed to the interface the seam actually declares.
 *
 * Routes by statement rather than by call order, so a test cannot pass because
 * the two statements happened to be issued in the order it assumed.
 */
function recordingQuery(
  calls: Call[],
  rows: readonly ScanRow[],
): NonNullable<ReverifyScanDeps["query"]> {
  return async <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]> => {
    calls.push({ sql, params: params ?? [] });
    if (sql === TOUCH_REVERIFY_ATTEMPT_SQL) return [];
    return rows as unknown as T[];
  };
}

const SCAN = {
  workspaceId: "ws1",
  source: "zoom",
  tokenPrefix: "audience:meeting:",
  limit: 200,
} as const;

function row(token: string, hasMembers = false): ScanRow {
  return { token, has_members: hasMembers };
}

function touchCall(calls: readonly Call[]): Call | undefined {
  return calls.find((call) => call.sql === TOUCH_REVERIFY_ATTEMPT_SQL);
}

describe("selectReverifyCandidates — the scan is inseparable from the stamp", () => {
  it("stamps EVERY candidate it hands back, so a page cannot be worked without rotating", async () => {
    // THE point of #4971. The previous per-source scans ordered on `synced_at`,
    // which only a successful reconcile advances, so an audience that aborted
    // every cycle held a slot at the front forever and starved everything behind
    // it. The stamp has to cover the candidates the caller is ABOUT to fail, not
    // the ones it manages to reconcile.
    //
    // MUTATION THIS CATCHES: dropping the `TOUCH_REVERIFY_ATTEMPT_SQL` call, or
    // narrowing the stamped set to a subset of the returned page.
    const calls: Call[] = [];
    const candidates = await selectReverifyCandidates(SCAN, {
      query: recordingQuery(calls, [
        row("audience:meeting:zoom:aaa", true),
        row("audience:meeting:zoom:bbb"),
      ]),
    });

    const touch = touchCall(calls);
    expect(touch).toBeDefined();
    expect(touch?.params[0]).toBe("ws1");
    expect(touch?.params[1]).toEqual(["meeting:zoom:aaa", "meeting:zoom:bbb"]);
    expect(touch?.params[2]).toBe("zoom");
    // Stamped ids are the audience ids the caller will act on — the same values,
    // not a parallel derivation that could drift from them.
    expect(touch?.params[1]).toEqual(candidates.map((candidate) => candidate.audienceId));
  });

  it("stamps BEFORE returning, so a caller that throws mid-page has still rotated", async () => {
    // Ordering, not just presence. A stamp issued after the caller's loop would
    // be skipped by any early return in it — and the aborts are exactly the
    // paths that return early.
    //
    // MUTATION THIS CATCHES: moving the stamp out of this function and into the
    // connectors' success branches.
    const calls: Call[] = [];
    const query = recordingQuery(calls, [row("audience:meeting:zoom:aaa")]);
    const candidates = await selectReverifyCandidates(SCAN, { query });
    expect(candidates).toHaveLength(1);
    // The statement ORDER is the assertion. A boolean sampled after the await
    // could only ever detect "no stamp at all", which the previous test covers.
    expect(calls.map((call) => call.sql)).toEqual([
      REVERIFY_CANDIDATES_SQL,
      TOUCH_REVERIFY_ATTEMPT_SQL,
    ]);
  });

  it("PROPAGATES a stamp failure instead of returning an unstamped page", async () => {
    // Working a page that could not be stamped is the starvation, restored. It
    // is also the cheaper failure to refuse: both writes go to the internal DB
    // that the reconcile itself needs, so a page that cannot be stamped is a
    // page whose reconciles would all fail anyway — after a full page of vendor
    // calls.
    //
    // MUTATION THIS CATCHES: wrapping the stamp in `try { … } catch { /* log */ }`.
    const failingQuery: NonNullable<ReverifyScanDeps["query"]> = async <
      T extends Record<string, unknown>,
    >(
      sql: string,
    ): Promise<T[]> => {
      if (sql === TOUCH_REVERIFY_ATTEMPT_SQL) throw new Error("attempt stamp write failed");
      return [row("audience:meeting:zoom:aaa")] as unknown as T[];
    };
    await expect(selectReverifyCandidates(SCAN, { query: failingQuery })).rejects.toThrow(
      /attempt stamp write failed/,
    );
  });

  it("issues NO stamp when the scan finds nothing", async () => {
    // An empty page consumed nobody's turn, and an upsert of an empty array is a
    // write this subsystem takes once per source per workspace per cycle.
    const calls: Call[] = [];
    const candidates = await selectReverifyCandidates(SCAN, {
      query: recordingQuery(calls, []),
    });
    expect(candidates).toEqual([]);
    expect(touchCall(calls)).toBeUndefined();
  });
});

describe("selectReverifyCandidates — what it hands the caller", () => {
  it("strips the grant prefix, keeping the token and the membership flag", async () => {
    // `fact_audience_member` is keyed on the id WITHOUT `audience:` — the prefix
    // is grant grammar. A candidate carrying the prefixed form would have every
    // caller write membership under a key `acl.ts` never matches: facts stored,
    // gated, and invisible, with the cycle reporting `reconciled`.
    //
    // MUTATION THIS CATCHES: returning `row.token` as `audienceId`.
    const calls: Call[] = [];
    const candidates = await selectReverifyCandidates(SCAN, {
      query: recordingQuery(calls, [row("audience:meeting:zoom:aaa", true)]),
    });
    expect(candidates).toEqual([{ audienceId: "meeting:zoom:aaa", hasMembers: true }]);
    // The PREFIXED form is deliberately not carried alongside it — two strings
    // differing by nine characters is the pair a caller mixes up, and passing
    // the prefixed one to `reconcileAudienceMembership` writes membership under
    // a key `acl.ts` never matches.
    expect(Object.keys(candidates[0] ?? {}).toSorted()).toEqual(["audienceId", "hasMembers"]);
  });

  it("passes the caller's own source, prefix and cap into the scan", async () => {
    // The three things that stayed source-specific when the ordering stopped
    // being so. Getting `source` wrong scans another connector's episodes;
    // getting the prefix wrong hands this re-verifier audiences it must not
    // reconcile.
    const calls: Call[] = [];
    await selectReverifyCandidates(
      { workspaceId: "ws9", source: "outlook", tokenPrefix: "audience:email-message:", limit: 40 },
      { query: recordingQuery(calls, []) },
    );
    const scan = calls.find((call) => call.sql === REVERIFY_CANDIDATES_SQL);
    expect(scan?.params.slice(0, 5)).toEqual([
      "ws9",
      "outlook",
      "audience:email-message:",
      "audience:",
      40,
    ]);
  });
});

describe("the member-less reserve", () => {
  async function reserveFor(limit: number): Promise<number> {
    const calls: Call[] = [];
    await selectReverifyCandidates({ ...SCAN, limit }, { query: recordingQuery(calls, []) });
    const scan = calls.find((call) => call.sql === REVERIFY_CANDIDATES_SQL);
    return scan?.params[5] as number;
  }

  it("reserves a tenth of the cap for audiences that grant NOBODY", async () => {
    // #4971's second residual: with `has_members DESC` as an ABSOLUTE priority,
    // a workspace whose member-bearing audiences fill the cap defers the
    // member-less ones forever — and those are exactly the audiences the
    // "someone joined Atlas later" repair exists for. They can only start
    // granting if something re-runs their resolution.
    //
    // MUTATION THIS CATCHES: passing 0, which restores absolute priority.
    // A LITERAL, not `200 * MEMBERLESS_RESERVE_FRACTION` — re-deriving the
    // constant makes the assertion true for any retune of it, including one to
    // 0.5 that would invert the priority this reserve is a minority share of.
    expect(await reserveFor(200)).toBe(20);
  });

  it("REFUSES a prefix without the grant prefix — at COMPILE time", () => {
    // A backstopped guard test: the protection is `AudienceTokenPrefix`, and
    // nothing else notices if it is weakened to `string`. Both the type gate and
    // the suites stay green under that mutation, so the "unreachable" claim in
    // its docstring would quietly stop being true.
    //
    // `@ts-expect-error` inverts that: it FAILS the type gate if the assignment
    // ever starts compiling. Behaviourally a no-op, which is the point.
    //
    // MUTATION THIS CATCHES: `AudienceTokenPrefix = string`.
    const badPrefix = {
      workspaceId: "ws1",
      source: "zoom",
      // @ts-expect-error a prefix without `audience:` must not be assignable —
      // it would make every derived audienceId garbage (see AudienceTokenPrefix)
      tokenPrefix: "meeting:",
      limit: 200,
    } satisfies ReverifyCandidateScan;
    expect(badPrefix.tokenPrefix).toBe("meeting:");
  });

  it("REFUSES a non-positive or fractional cap rather than scanning nothing", async () => {
    // `LIMIT 0` returns an empty page, which this seam cannot tell from a
    // healthy idle workspace — so a bad cap would switch a source's
    // re-verification off in total silence, which is #4971's outcome reached
    // from a typo. The type stops a bad prefix; only this stops a bad cap.
    //
    // MUTATION THIS CATCHES: dropping the guard, or weakening `< 1` to `< 0`.
    for (const limit of [0, -1, 2.5, Number.NaN]) {
      await expect(
        selectReverifyCandidates({ ...SCAN, limit }, { query: recordingQuery([], []) }),
      ).rejects.toThrow(/must be a positive integer/);
    }
  });

  it("never lets the reserve reach the whole cap, at any cap a connector might pick", async () => {
    // Inverted, this starves the member-BEARING audiences instead — the failure
    // with somebody's live access behind it. The clamp is here rather than at
    // the call sites because `limit` is a per-source constant whose owner never
    // reads this function.
    //
    // MUTATION THIS CATCHES: dropping either clamp arm.
    expect(await reserveFor(1)).toBe(0);
    expect(await reserveFor(2)).toBe(1);
    // Small caps still reserve at least one slot rather than rounding the repair
    // away entirely.
    expect(await reserveFor(5)).toBe(1);
  });
});
