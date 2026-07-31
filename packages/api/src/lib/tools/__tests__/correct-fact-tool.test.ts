/**
 * Execute-wrapper coverage for the `correct_fact` tool (#4915) — the guards
 * and context wiring that live OUTSIDE the verb machinery (unit-tested against
 * a fake store in `lib/brain/__tests__/correction.test.ts`):
 *
 *   - the degraded paths, each carrying a machine-readable `reason`: no
 *     internal DB / no workspace / unresolvable actor / thrown failure ⇒
 *     `{ error, reason }` — never a bare throw reaching the agent loop;
 *   - outcome mapping: `corrected` ships the correction payload plus a
 *     relayable summary, `refused` carries the machinery's own refusal code
 *     beside the prose, `not-found` tells the agent to re-search;
 *   - the error catch is secret-free (CLAUDE.md: no stack/connection string).
 *
 * Kept in its own file — mock.module is file-global under the isolated runner.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";
import type { AuthMode } from "@useatlas/types";

let mockRequestContext:
  | {
      requestId?: string;
      user?: { id?: string; role?: string; activeOrganizationId?: string };
    }
  | undefined;
let mockHasInternalDB = true;
let mockAuthMode: AuthMode = "none";

const fakePool = { query: async () => ({ rows: [] as unknown[] }) };

void mock.module("@atlas/api/lib/db/internal", () => ({
  ...buildInternalDbMockDefaults({
    internalQuery: async () => [],
    hasInternalDB: () => mockHasInternalDB,
  }),
  hasInternalDB: () => mockHasInternalDB,
  getInternalDB: () => fakePool,
}));

void mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => mockAuthMode,
  getAuthModeSource: () => "explicit" as const,
  resetAuthModeCache: () => {},
}));

let loggedError: unknown;
const noopLogger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: (obj: unknown) => {
    loggedError = obj;
  },
};
void mock.module("@atlas/api/lib/logger", () => ({
  ACTOR_KINDS: ["human", "agent", "mcp", "scheduler", "api_key"] as const,
  createLogger: () => noopLogger,
  getLogger: () => noopLogger,
  getRequestContext: () => mockRequestContext,
  withRequestContext: <T>(_ctx: unknown, fn: () => T) => fn(),
  redactPaths: [] as string[],
  scrubErrSerializer: (v: unknown) => v,
  scrubLogFormatter: (o: unknown) => o,
  hashShareToken: (t: string) => t,
  setLogLevel: () => true,
}));

// The verb machinery, stubbed: this file tests the WRAPPER. Mock-all-exports —
// the factory lists every value export `correction.ts` has.
let correctCalls: Array<Record<string, unknown>> = [];
let correctionResult: () => unknown = () => ({ kind: "not-found" });
void mock.module("@atlas/api/lib/brain/correction", () => ({
  CORRECTION_VERBS: ["retract", "supersede", "re-authority", "pin"],
  CORRECTION_REFUSAL_REASONS: {
    notAuthorized: "NOT_AUTHORIZED",
    warehouseTarget: "WAREHOUSE_TARGET",
    targetNotPublished: "TARGET_NOT_PUBLISHED",
    validityAlreadyClosed: "VALIDITY_ALREADY_CLOSED",
    replacementMissing: "REPLACEMENT_MISSING",
    replacementIdentical: "REPLACEMENT_IDENTICAL",
    replacementUnpublishable: "REPLACEMENT_UNPUBLISHABLE",
  },
  CorrectionRefusedError: class CorrectionRefusedError extends Error {},
  CORRECTION_EPISODE_INSERT_SQL: "INSERT",
  RETRACT_FACT_SQL: "UPDATE",
  DERIVES_FROM_EDGE_SQL: "INSERT",
  DEPENDENT_FACTS_SQL: "SELECT",
  MERGE_PROVENANCE_MARKER_SQL: "UPDATE",
  PROMOTE_CORRECTION_FACT_SQL: "UPDATE",
  REPLACEMENT_ROW_SQL: "SELECT",
  correctionTargetSql: () => "SELECT",
  isWarehouseDerived: () => false,
  correctFact: async (request: Record<string, unknown>) => {
    correctCalls.push(request);
    return correctionResult();
  },
}));

const { correctFactTool, CORRECT_FACT_DESCRIPTION, CORRECT_FACT_TOOL_REASONS } = await import(
  "@atlas/api/lib/tools/correct-fact"
);
const { BrainReaderUnresolvedError } = await import("@atlas/api/lib/brain/reader-context");

function run(input: Record<string, unknown>) {
  return correctFactTool.execute!(
    { factId: "6f2c0000-0000-4000-8000-000000000000", verb: "retract", ...input } as never,
    { toolCallId: "t1", messages: [] } as never,
  ) as unknown as Promise<Record<string, unknown>>;
}

const CORRECTED = {
  kind: "corrected",
  result: {
    verb: "retract",
    factId: "6f2c0000-0000-4000-8000-000000000000",
    correctionEpisodeId: "ep-1",
    invalidatedAt: "2026-07-30T12:00:00.000Z",
    flaggedForReReview: ["dep-1", "dep-2"],
    supersededBy: null,
    validTo: null,
  },
};

beforeEach(() => {
  mockRequestContext = {
    requestId: "req-1",
    user: { id: "u1", role: "admin", activeOrganizationId: "org-1" },
  };
  mockHasInternalDB = true;
  mockAuthMode = "none";
  correctCalls = [];
  correctionResult = () => CORRECTED;
  loggedError = undefined;
});

describe("degraded paths", () => {
  it("reports a missing internal DB with its reason, not a throw", async () => {
    mockHasInternalDB = false;
    const out = await run({});
    expect(out.reason).toBe(CORRECT_FACT_TOOL_REASONS.noInternalDb);
    expect(String(out.error)).toContain("internal database");
    expect(correctCalls).toHaveLength(0);
  });

  it("reports a missing workspace with its reason", async () => {
    mockRequestContext = { requestId: "req-1", user: { id: "u1" } };
    const out = await run({});
    expect(out.reason).toBe(CORRECT_FACT_TOOL_REASONS.noWorkspace);
    expect(correctCalls).toHaveLength(0);
  });

  it("maps an identity failure to reader_unresolved — a refusal, never applied", async () => {
    correctionResult = () => {
      throw new BrainReaderUnresolvedError("org-1", "unresolved", "correction");
    };
    const out = await run({});
    expect(out.reason).toBe(CORRECT_FACT_TOOL_REASONS.readerUnresolved);
    expect(String(out.error)).toContain("was not changed");
  });

  it("maps any other throw to a secret-free correction_failed with the requestId", async () => {
    correctionResult = () => {
      throw new Error("connection to postgresql://user:hunter2@db failed");
    };
    const out = await run({});
    expect(out.reason).toBe(CORRECT_FACT_TOOL_REASONS.correctionFailed);
    expect(String(out.error)).not.toContain("hunter2");
    expect(String(out.error)).toContain("req-1");
    // …but the operator's log line keeps the real cause.
    expect(loggedError).toBeDefined();
  });
});

describe("outcome mapping", () => {
  it("ships the correction payload plus a relayable summary on success", async () => {
    const out = await run({ reason: "wrong" });
    expect(out.corrected).toBe(true);
    expect(out.factId).toBe("6f2c0000-0000-4000-8000-000000000000");
    expect(out.correctionEpisodeId).toBe("ep-1");
    expect(String(out.summary)).toContain("2 derived fact(s)");
    // The wrapper passed the caller's inputs through unchanged.
    expect(correctCalls[0]).toMatchObject({
      factId: "6f2c0000-0000-4000-8000-000000000000",
      verb: "retract",
      reason: "wrong",
    });
  });

  // #4939. `DEPENDENT_FACTS_SQL` is deliberately un-ACL-gated — it flags every
  // dependent, including ones this actor cannot read — so its ids are handles
  // to rows the LLM has no entitlement to. `searchBrain` collapses withheld
  // tension rivals to a bare count for exactly this reason, on exactly this
  // surface; the spread that used to build this result did the opposite.
  it("reports flagged dependents as a COUNT and leaks no dependent id", async () => {
    const out = await run({});
    expect(out.flaggedForReReviewCount).toBe(2);
    expect(out).not.toHaveProperty("flaggedForReReview");

    // The rule, not the field name: NO id from the un-ACL-gated set may appear
    // anywhere in what the model receives, under any key. A rename that
    // re-introduced the ids as `dependents` would pass the two assertions
    // above and fail this one.
    const serialized = JSON.stringify(out);
    for (const id of CORRECTED.result.flaggedForReReview) {
      expect(
        serialized,
        `the agent-facing result contains dependent id "${id}" — those come from a query with no ACL, so a subset names facts this actor cannot read`,
      ).not.toContain(id);
    }
    // And the summary — the one string the agent is told to relay verbatim —
    // states the number rather than enumerating.
    expect(String(out.summary)).toContain("2 derived fact(s)");
    expect(String(out.summary)).not.toContain("dep-1");
  });

  // The count is only a disclosure fix if everything ELSE still arrives: a
  // projection is where fields get silently dropped, and the correction
  // episode id is the caller's audit handle.
  it("still projects every non-id field a correction carries", async () => {
    correctionResult = () => ({
      kind: "corrected",
      result: {
        ...CORRECTED.result,
        verb: "supersede",
        invalidatedAt: null,
        supersededBy: "new-1",
        validTo: "2026-07-30T12:00:00.000Z",
      },
    });
    const out = await run({ verb: "supersede", replacement: { object: "Bo" } });
    expect(out).toMatchObject({
      corrected: true,
      verb: "supersede",
      factId: "6f2c0000-0000-4000-8000-000000000000",
      correctionEpisodeId: "ep-1",
      invalidatedAt: null,
      supersededBy: "new-1",
      validTo: "2026-07-30T12:00:00.000Z",
      flaggedForReReviewCount: 2,
    });
  });

  it("carries the machinery's refusal code beside the prose", async () => {
    correctionResult = () => ({
      kind: "refused",
      reason: "WAREHOUSE_TARGET",
      message: "Tier-1 has no correction path — fix the data or the semantic layer.",
    });
    const out = await run({});
    expect(out.reason).toBe(CORRECT_FACT_TOOL_REASONS.refused);
    expect(out.refusal).toBe("WAREHOUSE_TARGET");
    expect(String(out.error)).toContain("semantic layer");
  });

  it("tells the agent to re-search on not-found", async () => {
    correctionResult = () => ({ kind: "not-found" });
    const out = await run({});
    expect(out.reason).toBe(CORRECT_FACT_TOOL_REASONS.notFound);
    expect(String(out.error)).toContain("searchBrain");
  });

  it("threads a supersede replacement through, parsing validFrom", async () => {
    correctionResult = () => ({
      kind: "corrected",
      result: { ...CORRECTED.result, verb: "supersede", supersededBy: "new-1", validTo: "x" },
    });
    await run({
      verb: "supersede",
      replacement: { object: "Bo", validFrom: "2026-01-01T00:00:00.000Z" },
    });
    const replacement = correctCalls[0]?.replacement as { object: string; validFrom: Date };
    expect(replacement.object).toBe("Bo");
    expect(replacement.validFrom.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// The documented disclosure split (#4939)
// ---------------------------------------------------------------------------

describe("the documented disclosure split", () => {
  // `brain-corrections.mdx` shipped saying flags "come back in
  // `flaggedForReReview`" — true of `/correct` and the tool, false of
  // `/retract`, which is the route the admin console actually calls. The
  // response shapes are now unified and the split (ids on admin, a count on
  // the agent path) is deliberate, so the doc has to name BOTH wire fields.
  //
  // The field names are READ OUT OF THE SOURCE, not restated: a rename that
  // updated the tool and left the guide behind is the exact drift this issue
  // was filed for, and a hardcoded literal here would go green through it.
  it("names both wire fields, in whatever spelling the tool actually emits", () => {
    const repo = join(import.meta.dir, "..", "..", "..", "..", "..", "..");
    const toolSource = readFileSync(
      join(repo, "packages", "api", "src", "lib", "tools", "correct-fact.ts"),
      "utf8",
    );
    const guide = readFileSync(
      join(repo, "apps", "docs", "content", "shared", "guides", "brain-corrections.mdx"),
      "utf8",
    );

    const countKey = /(\w+):\s*outcome\.result\.flaggedForReReview\.length/.exec(toolSource)?.[1];
    expect(
      countKey,
      "correct-fact.ts no longer derives a count field from `flaggedForReReview.length` — either the agent path went back to shipping ids (which #4939 forbids) or this parse needs re-pointing",
    ).toBeTruthy();

    for (const field of ["flaggedForReReview", countKey!]) {
      // Word-bounded, and that is load-bearing rather than tidiness: the count
      // field's name CONTAINS the id field's, so a plain `includes` reports
      // the ids as documented off a guide that only ever mentions the count.
      expect(
        new RegExp(`\\b${field}\\b`).test(guide),
        `brain-corrections.mdx never names \`${field}\` (as a whole word). The admin routes return ids and the agent tool returns a count; a guide that documents only one of them tells half its readers the wrong thing about the surface they use.`,
      ).toBe(true);
    }
  });
});

describe("the trust-tier-aware description", () => {
  it("routes the agent around tier-1 and states the authority bar", () => {
    // The acceptance criterion: the DESCRIPTION is where tool routing happens,
    // so the tier boundary and the admin gate must be in the prose the LLM
    // reads, not only in the refusal it would hit afterwards.
    expect(CORRECT_FACT_DESCRIPTION).toContain("tier-1");
    expect(CORRECT_FACT_DESCRIPTION).toContain("warehouse");
    expect(CORRECT_FACT_DESCRIPTION).toContain("owner/admin");
    for (const verb of ["retract", "supersede", "re-authority", "pin"]) {
      expect(CORRECT_FACT_DESCRIPTION).toContain(verb);
    }
  });
});
