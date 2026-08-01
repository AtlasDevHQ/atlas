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
import { z } from "zod";
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
  // `satisfies` the real vocabulary (#4939) — a type-only import, erased
  // before `mock.module` runs, so it borrows the shape without un-stubbing
  // anything. A reason added to the machinery is a compile error here rather
  // than a stub that silently disagrees with the module it stands in for.
  CORRECTION_REFUSAL_REASONS: {
    notAuthorized: "NOT_AUTHORIZED",
    warehouseTarget: "WAREHOUSE_TARGET",
    unrecognizedSourceKind: "UNRECOGNIZED_SOURCE_KIND",
    targetNotPublished: "TARGET_NOT_PUBLISHED",
    validityAlreadyClosed: "VALIDITY_ALREADY_CLOSED",
    targetNotCurrent: "TARGET_NOT_CURRENT",
    replacementMissing: "REPLACEMENT_MISSING",
    replacementIdentical: "REPLACEMENT_IDENTICAL",
    replacementUnpublishable: "REPLACEMENT_UNPUBLISHABLE",
  } satisfies typeof import("@atlas/api/lib/brain/correction").CORRECTION_REFUSAL_REASONS,
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
    // …and obeys the rule `MERGE_PROVENANCE_MARKER_SQL`'s header states for
    // every string about these markers: say what is RECORDED, never imply a
    // place to go look. Reverting to the pre-#4939 "were flagged for human
    // re-review" — the wording that header calls out as implying a queue —
    // passes every other assertion here.
    expect(
      String(out.summary),
      "the retract summary must say the count IS the report — no queue lists the flagged facts, so an unqualified 'flagged for re-review' sends the user looking for one",
    ).toMatch(/no queue|whole report/i);
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
    if (!countKey) {
      // `throw`, not `expect(...).toBeTruthy()` + `!`: TypeScript cannot
      // narrow through an assertion, and the non-null assertion it would
      // otherwise need is exactly the thing CLAUDE.md asks to minimize.
      throw new Error(
        "correct-fact.ts no longer derives a count field from `flaggedForReReview.length` — either the agent path went back to shipping ids (which #4939 forbids) or this parse needs re-pointing",
      );
    }

    for (const field of ["flaggedForReReview", countKey]) {
      // Word-bounded, and that is load-bearing rather than tidiness: the count
      // field's name CONTAINS the id field's, so a plain `includes` reports
      // the ids as documented off a guide that only ever mentions the count.
      expect(
        new RegExp(`\\b${field}\\b`).test(guide),
        `brain-corrections.mdx never names \`${field}\` (as a whole word). The admin routes return ids and the agent tool returns a count; a guide that documents only one of them tells half its readers the wrong thing about the surface they use.`,
      ).toBe(true);
    }

    // Presence is not enough: a guide that SWAPS the two ("the tool returns
    // `flaggedForReReview`, the admin routes return the count") names both and
    // misinforms every reader — the same half-the-audience failure the issue
    // describes, inverted. So each field has to sit in a clause with its own
    // surface.
    //
    // Split on `;` as well as `.`, and that is load-bearing rather than
    // thorough: the guide states the split in ONE sentence with a semicolon
    // between its halves, so a sentence-level check finds both surfaces in the
    // same chunk and passes on the swapped text too. Verified by mutation —
    // the `.`-only version of this assertion did not fail against the swap.
    const sentences = guide.split(/(?<=[.;])\s+/);
    const attributed = (field: string, surface: RegExp): boolean =>
      sentences.some((s) => new RegExp(`\\b${field}\\b`).test(s) && surface.test(s));

    expect(
      attributed("flaggedForReReview", /\/retract|\/correct|admin route/i),
      "brain-corrections.mdx names `flaggedForReReview` but never in the same sentence as the admin surface that returns it — a reader cannot tell which surface gives ids and which gives a count",
    ).toBe(true);
    expect(
      attributed(countKey, /correct_fact|tool\b/i),
      `brain-corrections.mdx names \`${countKey}\` but never in the same sentence as the agent tool that returns it — see above`,
    ).toBe(true);
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

  // #4939. The vouch verbs now hard-refuse a claim whose validity window has
  // closed, and the model reaches that state by the documented route — an
  // `asOf` read hands it superseded ids, and `factId` is documented as coming
  // "exactly as returned by searchBrain". An unstated precondition is a
  // refusal a well-behaved model cannot avoid; this PR asserts exactly that
  // rule for `searchBrain`'s `asOf` argument, so `correct_fact` gets it too.
  //
  // Both strings, because they are read at different moments: the system
  // prompt shapes whether the agent offers the verb at all, the tool
  // description shapes the call it then makes.
  it("states the vouch precondition in every string the model reads", () => {
    const { description } = correctFactTool as unknown as { description: string };
    // The `verb` enum's own `.describe()` is the THIRD copy, and it is read out
    // of the served JSON Schema for `search-brain-tool.test.ts`'s reason: that
    // is the string the model actually receives, and reading `.shape` instead
    // would go red on a harmless `.describe()`/`.optional()` reorder.
    const verbDescription = ((): string => {
      const properties = z.toJSONSchema(correctFactTool.inputSchema as z.ZodType).properties;
      const verb = properties?.verb;
      if (typeof verb !== "object" || verb === null || !("description" in verb)) {
        throw new Error(
          `correct_fact's input schema no longer exposes a \`verb\` object property (saw: ${Object.keys(properties ?? {}).join(", ") || "none"}) — re-point this read, or the pin below passes vacuously`,
        );
      }
      return typeof verb.description === "string" ? verb.description : "";
    })();

    for (const [label, text] of [
      ["CORRECT_FACT_DESCRIPTION", CORRECT_FACT_DESCRIPTION],
      ["correctFactTool.description", description],
      ["the `verb` argument description", verbDescription],
    ] as const) {
      expect(
        /refused[^.]*validity window|validity window[^.]*(closed|refused)|still current/i.test(text),
        `${label} promises re-authority/pin reset the staleness clock without saying they only apply while the claim is still current — the model cannot avoid a refusal it was never told about`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The guide documents the new refusal (#4939)
// ---------------------------------------------------------------------------

describe("the public guide", () => {
  // The Callout added for the vouch refusal is its only public documentation.
  // The mechanism is already here — this file reads the guide for the
  // disclosure split — so leaving the refusal's own doc unpinned would be a
  // choice rather than a cost.
  it("documents the vouch refusal, and does not advise a verb that refuses too", () => {
    const guide = readFileSync(
      join(
        import.meta.dir,
        "..",
        "..",
        "..",
        "..",
        "..",
        "..",
        "apps",
        "docs",
        "content",
        "shared",
        "guides",
        "brain-corrections.mdx",
      ),
      "utf8",
    );
    expect(
      /validity window has \*\*already closed\*\*|validity window[^.]*already closed/i.test(guide),
      "brain-corrections.mdx does not document that re-authority/pin are refused on a closed validity window — that refusal has no other public description",
    ).toBe(true);

    // The trap this Callout fell into once: `supersede` refuses ANY non-null
    // `valid_to`, so advising it as the fallback for an elapsed window sends
    // the reader into a second refusal. The sentence must say the opposite.
    const elapsed = guide
      .split(/(?<=[.;])\s+/)
      .filter((s) => /elapsed|nothing replaced it/i.test(s));
    expect(elapsed.length, "the guide no longer discusses an elapsed window").toBeGreaterThan(0);
    for (const sentence of elapsed) {
      expect(
        /no correction|refuses|ingest/i.test(sentence),
        `brain-corrections.mdx says "${sentence.trim()}" — an elapsed window with no successor has NO correction verb available (\`supersede\` refuses a closed window too), so this must not read as a remedy`,
      ).toBe(true);
    }
  });
});
