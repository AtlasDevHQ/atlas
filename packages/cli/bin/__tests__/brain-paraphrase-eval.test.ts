/**
 * The paraphrase eval's grader, pinned without spending a model call (#5041).
 *
 * `gradeParaphraseRun` is pure and every verdict it can reach is exercised here
 * — the same split `canonical-eval-tool-selection.test.ts` makes over
 * `gradeToolSelection`, and for the same reason: the expensive part of an eval
 * is the model, and none of the decisions worth pinning need one.
 *
 * ⚠️ The module under test stamps `ATLAS_LOG_STDERR=1` at import time, by
 * design (see its header). That is a module side effect rather than a top-level
 * write in this file, and the isolated runner gives each test file its own
 * process, so it cannot reach another suite.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  corpusDigest,
  DEFAULT_ARTIFACT_PATH,
  DEFAULT_CORPUS_PATH,
  gradeParaphraseRun,
  loadArtifact,
  loadMessageCorpus,
  parseParaphraseArgs,
  main,
  reportParaphraseRun,
  runBrainParaphraseEval,
  serializeArtifact,
  toRecordedTriple,
  triplesEqualBySlot,
  type MessageCorpus,
  type ParaphrasePair,
  type ParaphraseRunReport,
  type RecordedArtifact,
  type RecordedSides,
  type RecordedTriple,
} from "../brain-paraphrase-eval";

// ── Fixtures ──────────────────────────────────────────────────────────

function triple(over: Partial<RecordedTriple> = {}): RecordedTriple {
  return {
    subject: "Business tier",
    predicate: "is priced at",
    object: "$499 a month",
    cardinalityHint: "single",
    ...over,
  };
}

function pairEntry(over: Partial<ParaphrasePair> = {}): ParaphrasePair {
  return {
    id: "price-copula",
    relation: "same-claim",
    why: "two spellings of one price",
    a: { source: "chat", body: "the Business tier is priced at $499 a month" },
    b: { source: "chat", body: "we price the Business tier at $499 a month" },
    ...over,
  };
}

/**
 * The `no-claim` control every corpus must carry.
 *
 * `loadMessageCorpus` refuses a corpus that is all `no-claim` (a dead extractor
 * would grade honest) and one that has none (nothing separates a discriminating
 * extractor from one that extracts from everything). So a corpus fixture that
 * reaches the loader needs both kinds — the grader fixtures below do not, since
 * `gradeParaphraseRun` takes a corpus object rather than a path.
 */
function smallTalkEntry(over: Partial<ParaphrasePair> = {}): ParaphrasePair {
  return {
    id: "small-talk",
    relation: "no-claim",
    why: "greetings carry no durable fact",
    a: { source: "chat", body: "morning all" },
    b: { source: "chat", body: "anyone else seeing that flaky test?" },
    ...over,
  };
}

function corpusOf(...pairs: ParaphrasePair[]): MessageCorpus {
  return { pairs };
}

/** A corpus shaped so `loadMessageCorpus` will accept it. */
function loadableCorpus(...pairs: ParaphrasePair[]): MessageCorpus {
  return corpusOf(...(pairs.length > 0 ? pairs : [pairEntry()]), smallTalkEntry());
}

function artifactOf(
  corpus: MessageCorpus,
  pairs: Record<string, RecordedSides>,
  over: Partial<RecordedArtifact> = {},
): RecordedArtifact {
  return {
    description: "recorded",
    model: "anthropic/claude-haiku-4.5",
    extractor: "extraction:v1",
    recordedAt: "2026-08-12T00:00:00.000Z",
    corpusDigest: corpusDigest(corpus),
    pairs,
    ...over,
  };
}

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-paraphrase-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Grading ───────────────────────────────────────────────────────────

describe("gradeParaphraseRun", () => {
  test("a run that reproduces the artifact passes", () => {
    const corpus = corpusOf(pairEntry());
    const sides: RecordedSides = { a: [triple()], b: [triple({ predicate: "costs" })] };
    const result = gradeParaphraseRun(corpus, { "price-copula": sides }, artifactOf(corpus, { "price-copula": sides }));
    expect(result.passed).toBe(true);
    expect(result.outcomes.map((o) => o.status)).toEqual(["match"]);
  });

  test("a changed predicate is DRIFT, and the detail names both spellings", () => {
    // The acceptance criterion in the issue's own words: when the model stops
    // emitting `is priced at`, this fails rather than silently drifting.
    const corpus = corpusOf(pairEntry());
    const recorded: RecordedSides = { a: [triple()], b: [triple({ predicate: "costs" })] };
    const fresh: RecordedSides = { a: [triple({ predicate: "has price" })], b: [triple({ predicate: "costs" })] };
    const result = gradeParaphraseRun(corpus, { "price-copula": fresh }, artifactOf(corpus, { "price-copula": recorded }));
    expect(result.passed).toBe(false);
    expect(result.outcomes[0].status).toBe("drift");
    expect(result.outcomes[0].detail).toContain("is priced at");
    expect(result.outcomes[0].detail).toContain("has price");
  });

  test("a changed SUBJECT is drift too", () => {
    // ⚠️ The subject is a keyed slot and the deterministic suite asserts on it
    // twice — the article in `schedule-phrasing`, and `different-subject` where
    // the subject is the ONLY thing holding two prices apart. Deleting
    // `t.subject === o.subject` from `triplesEqualBySlot` killed nothing until this
    // test existed: every drift case varied the predicate or the object. Without
    // it, a model that started emitting one subject on both sides of a pair
    // would grade `match` here and turn the api suite red with no indication of
    // where the change came from — the exact inversion this lane prevents.
    const corpus = corpusOf(pairEntry());
    const recorded: RecordedSides = { a: [triple()], b: [triple({ predicate: "costs" })] };
    const fresh: RecordedSides = {
      a: [triple({ subject: "Starter tier" })],
      b: [triple({ predicate: "costs" })],
    };
    const result = gradeParaphraseRun(corpus, { "price-copula": fresh }, artifactOf(corpus, { "price-copula": recorded }));
    expect(result.outcomes[0].status).toBe("drift");
  });

  test("a changed OBJECT is drift too, not only the predicate", () => {
    // The deterministic suite keys all three slots, so a moved object changes
    // what it proves exactly as much as a moved predicate does.
    const corpus = corpusOf(pairEntry());
    const recorded: RecordedSides = { a: [triple()], b: [triple({ predicate: "costs" })] };
    const fresh: RecordedSides = { a: [triple({ object: "$499/mo" })], b: [triple({ predicate: "costs" })] };
    const result = gradeParaphraseRun(corpus, { "price-copula": fresh }, artifactOf(corpus, { "price-copula": recorded }));
    expect(result.outcomes[0].status).toBe("drift");
  });

  test("the cardinality hint is recorded but NOT compared", () => {
    // #5027 made it advisory and nothing may read it into a supersession
    // decision. Grading on it would make an advisory field able to fail a
    // release gate, which is the authority it was stripped of.
    const corpus = corpusOf(pairEntry());
    const recorded: RecordedSides = { a: [triple({ cardinalityHint: "single" })], b: [triple({ predicate: "costs" })] };
    const fresh: RecordedSides = { a: [triple({ cardinalityHint: "multi" })], b: [triple({ predicate: "costs" })] };
    const result = gradeParaphraseRun(corpus, { "price-copula": fresh }, artifactOf(corpus, { "price-copula": recorded }));
    expect(result.outcomes[0].status).toBe("match");
  });

  test("a pair the artifact does not carry is `unrecorded`, not drift", () => {
    // Different diagnosis, different fix: drift asks a maintainer to read what
    // moved, an unrecorded pair just needs a regeneration.
    const corpus = corpusOf(pairEntry());
    const sides: RecordedSides = { a: [triple()], b: [triple({ predicate: "costs" })] };
    const result = gradeParaphraseRun(corpus, { "price-copula": sides }, artifactOf(corpus, {}));
    expect(result.outcomes[0].status).toBe("unrecorded");
    expect(result.passed).toBe(false);
  });

  test("a pair the CORPUS dropped is reported as a stale artifact entry", () => {
    const corpus = corpusOf(pairEntry());
    const sides: RecordedSides = { a: [triple()], b: [triple({ predicate: "costs" })] };
    const artifact = artifactOf(corpus, { "price-copula": sides, "long-gone": sides });
    const result = gradeParaphraseRun(corpus, { "price-copula": sides }, artifact);
    expect(result.staleArtifactPairs).toEqual(["long-gone"]);
    expect(result.passed).toBe(false);
  });

  test("an edited message body fails the digest even when every triple still matches", () => {
    // The check that needs no model call: the recording was produced from text
    // that is no longer in the tree, so nothing below it can be trusted, and the
    // deterministic suite asserts the same digest for the same reason.
    const corpus = corpusOf(pairEntry());
    const sides: RecordedSides = { a: [triple()], b: [triple({ predicate: "costs" })] };
    const edited = corpusOf(pairEntry({ a: { source: "chat", body: "a different sentence entirely" } }));
    const result = gradeParaphraseRun(edited, { "price-copula": sides }, artifactOf(corpus, { "price-copula": sides }));
    expect(result.outcomes.map((o) => o.status)).toEqual(["match"]);
    expect(result.digestMismatch).not.toBeNull();
    expect(result.passed).toBe(false);
  });

  test("a harness fault — a corpus pair never extracted — THROWS rather than grading", () => {
    // It must not be reported as drift: that sends a maintainer to regenerate an
    // artifact which is fine, over a run that never happened.
    const corpus = corpusOf(pairEntry());
    expect(() => gradeParaphraseRun(corpus, {}, artifactOf(corpus, {}))).toThrow(/harness fault/);
  });
});

describe("the corpus-honesty checks", () => {
  test("a `no-claim` pair that produced a claim fails", () => {
    const corpus = corpusOf(pairEntry({ id: "small-talk", relation: "no-claim" }));
    const fresh: RecordedSides = { a: [triple()], b: [] };
    const result = gradeParaphraseRun(corpus, { "small-talk": fresh }, artifactOf(corpus, { "small-talk": fresh }));
    expect(result.outcomes[0].status).toBe("honesty");
    expect(result.passed).toBe(false);
  });

  test("positive control: a `no-claim` pair that produced nothing passes", () => {
    // Without this, "a no-claim pair with claims fails" is satisfied by a
    // grader that fails every no-claim pair, which would make the relation
    // unusable and the small-talk control impossible to express.
    const corpus = corpusOf(pairEntry({ id: "small-talk", relation: "no-claim" }));
    const fresh: RecordedSides = { a: [], b: [] };
    const result = gradeParaphraseRun(corpus, { "small-talk": fresh }, artifactOf(corpus, { "small-talk": fresh }));
    expect(result.outcomes[0].status).toBe("match");
    expect(result.passed).toBe(true);
  });

  test("⚠️ an empty side fails EVEN WHEN the artifact recorded it empty too", () => {
    // The load-bearing ordering, and the one a reasonable implementation gets
    // wrong: honesty is checked BEFORE the artifact comparison. An extractor
    // that had silently stopped working produces nothing, a regeneration
    // records that nothing, and from then on every run matches — a green eval
    // over a corpus that exercises nothing, feeding a deterministic suite whose
    // every prohibition now passes against an identity layer that does nothing.
    // That is the exact failure this whole lane exists to make impossible, and
    // it would arrive through the lane itself.
    const corpus = corpusOf(pairEntry());
    const empty: RecordedSides = { a: [], b: [] };
    const result = gradeParaphraseRun(corpus, { "price-copula": empty }, artifactOf(corpus, { "price-copula": empty }));
    expect(result.outcomes[0].status).toBe("honesty");
    expect(result.outcomes[0].detail).toContain("a, b");
    expect(result.passed).toBe(false);
  });

  test("⚠️ a claim with a BLANK slot fails — arity is not content", () => {
    // `ExtractionSchema` uses bare `z.string()` with no `.min(1)`, so
    // `{subject:"", predicate:"   ", object:""}` is valid model output and
    // counts as one claim. `identityKey` answers `null` for every one of those,
    // so every prohibition downstream passes vacuously — the state this lane
    // exists to refuse, reached while the count-only check said "honest".
    const corpus = corpusOf(pairEntry());
    const fresh: RecordedSides = {
      a: [triple({ predicate: "   " })],
      b: [triple({ predicate: "costs" })],
    };
    const result = gradeParaphraseRun(corpus, { "price-copula": fresh }, artifactOf(corpus, { "price-copula": fresh }));
    expect(result.outcomes[0].status).toBe("honesty");
    expect(result.outcomes[0].detail).toContain("empty slot");
  });

  test("a slot of separators is blank too, because `lexicalNorm` trims them away", () => {
    // `-` and `_` are separators that collapse and then trim, so `"-"` keys to
    // null exactly like `""`. A whitespace-only check would pass this.
    const corpus = corpusOf(pairEntry());
    const fresh: RecordedSides = {
      a: [triple({ object: "-" })],
      b: [triple({ predicate: "costs" })],
    };
    const result = gradeParaphraseRun(corpus, { "price-copula": fresh }, artifactOf(corpus, { "price-copula": fresh }));
    expect(result.outcomes[0].status).toBe("honesty");
  });

  test("a blank SUBJECT is caught too, not only the predicate and object", () => {
    // Dropping `triple.subject` from `hasBlankSlot`'s list killed nothing while
    // both blank tests used a predicate and an object — and the subject is the
    // slot the consuming suite leans on hardest.
    const corpus = corpusOf(pairEntry());
    const fresh: RecordedSides = {
      a: [triple({ subject: "  " })],
      b: [triple({ predicate: "costs" })],
    };
    const result = gradeParaphraseRun(corpus, { "price-copula": fresh }, artifactOf(corpus, { "price-copula": fresh }));
    expect(result.outcomes[0].status).toBe("honesty");
  });

  test("positive control: an ordinary claim is not read as blank", () => {
    // Without this, "a blank slot fails" is satisfied by a check that fails
    // every claim — which would make the whole corpus unrecordable.
    const corpus = corpusOf(pairEntry());
    const fresh: RecordedSides = { a: [triple()], b: [triple({ predicate: "costs" })] };
    const result = gradeParaphraseRun(corpus, { "price-copula": fresh }, artifactOf(corpus, { "price-copula": fresh }));
    expect(result.outcomes[0].status).toBe("match");
  });

  test("⚠️ more than ONE claim a side fails — the two ends may not hold different contracts", () => {
    // The consuming suite's `soleClaim` throws on anything but exactly one,
    // deliberately. A producer accepting `>= 1` meant a regeneration could
    // report PASS, write the artifact, and break the api suite in another
    // package — the diagnosis arriving one CI lane after the command that
    // caused it.
    const corpus = corpusOf(pairEntry());
    const fresh: RecordedSides = {
      a: [triple(), triple({ predicate: "renews at" })],
      b: [triple({ predicate: "costs" })],
    };
    const result = gradeParaphraseRun(corpus, { "price-copula": fresh }, artifactOf(corpus, { "price-copula": fresh }));
    expect(result.outcomes[0].status).toBe("honesty");
    expect(result.outcomes[0].detail).toContain("more than one");
  });

  test("positive control: exactly one claim a side is what an honest pair looks like", () => {
    const corpus = corpusOf(pairEntry());
    const fresh: RecordedSides = { a: [triple()], b: [triple({ predicate: "costs" })] };
    const result = gradeParaphraseRun(corpus, { "price-copula": fresh }, artifactOf(corpus, { "price-copula": fresh }));
    expect(result.outcomes[0].status).toBe("match");
  });

  test("an honest `no-claim` pair is still compared against the artifact", () => {
    // Its recording is two empty arrays, which can still go stale or drift — and
    // the `no-claim` arm `continue`s past the fall-through, so folding the
    // comparison into that fall-through would have left the pair ungraded.
    const corpus = corpusOf(smallTalkEntry());
    const empty: RecordedSides = { a: [], b: [] };
    const result = gradeParaphraseRun(corpus, { "small-talk": empty }, artifactOf(corpus, {}));
    expect(result.outcomes[0].status).toBe("unrecorded");
  });

  test("one empty side is enough — a pair needs both to relate anything", () => {
    const corpus = corpusOf(pairEntry());
    const half: RecordedSides = { a: [triple()], b: [] };
    const result = gradeParaphraseRun(corpus, { "price-copula": half }, artifactOf(corpus, { "price-copula": half }));
    expect(result.outcomes[0].status).toBe("honesty");
    expect(result.outcomes[0].detail).toContain("side(s) b");
  });
});

// ── Corpus loading ────────────────────────────────────────────────────

describe("loadMessageCorpus", () => {
  function write(corpus: unknown): string {
    const dir = tempDir();
    const file = path.join(dir, "messages.json");
    fs.writeFileSync(file, JSON.stringify(corpus));
    return file;
  }

  test("accepts a well-formed corpus", () => {
    expect(loadMessageCorpus(write(loadableCorpus())).pairs).toHaveLength(2);
  });

  test("⚠️ rejects a corpus that is ALL `no-claim`", () => {
    // The one thing the per-pair honesty checks structurally cannot see: they
    // are relative to each pair's declared relation, so a corpus of nothing but
    // `no-claim` is honest by construction against a completely DEAD extractor.
    // Every side records empty, every check passes, `--write` succeeds, and the
    // deterministic suite's every prohibition then passes against nothing.
    expect(() => loadMessageCorpus(write(corpusOf(smallTalkEntry())))).toThrow(
      /no claim-bearing pair/,
    );
  });

  test("rejects a corpus with NO `no-claim` control", () => {
    // The other direction: without one, an extractor that emits a triple for
    // every message — small talk included — is indistinguishable from a
    // discriminating one.
    expect(() => loadMessageCorpus(write(corpusOf(pairEntry())))).toThrow(/no `no-claim` control/);
  });

  test("rejects two pairs sharing an id", () => {
    // Ids name the artifact's keys, so a duplicate silently makes one recording
    // overwrite the other and the corpus one pair smaller than it reads.
    const file = write(corpusOf(pairEntry(), pairEntry(), smallTalkEntry()));
    expect(() => loadMessageCorpus(file)).toThrow(/two pairs with id "price-copula"/);
  });

  test("rejects a relation outside the vocabulary", () => {
    const file = write(
      corpusOf(pairEntry({ relation: "sort-of-the-same" as ParaphrasePair["relation"] }), smallTalkEntry()),
    );
    expect(() => loadMessageCorpus(file)).toThrow(/expected one of/);
  });

  test("rejects a pair with no `why`", () => {
    // This corpus is all argument: an entry whose reason is not written down
    // cannot be reviewed, and a reviewer is the only oracle it has.
    const file = write(corpusOf(pairEntry({ why: "" }), smallTalkEntry()));
    expect(() => loadMessageCorpus(file)).toThrow(/is missing `why`/);
  });

  test("names the file and the pair when a message body is missing", () => {
    const file = write(corpusOf(pairEntry({ b: { source: "chat", body: "" } }), smallTalkEntry()));
    expect(() => loadMessageCorpus(file)).toThrow(/pair "price-copula" side b is missing string `body`/);
  });
});

describe("corpusDigest", () => {
  test("ignores prose the model never sees", () => {
    // `why` is for a reviewer. Invalidating the artifact on a comment edit would
    // teach everyone to regenerate on autopilot — the discipline
    // `mcp-llm-baseline.json` never had, which is why it is 3 bytes.
    expect(corpusDigest(corpusOf(pairEntry({ why: "one reason" })))).toBe(
      corpusDigest(corpusOf(pairEntry({ why: "a completely different reason" }))),
    );
  });

  test("changes when a message body changes", () => {
    expect(corpusDigest(corpusOf(pairEntry()))).not.toBe(
      corpusDigest(corpusOf(pairEntry({ a: { source: "chat", body: "different text" } }))),
    );
  });

  test("changes when the SOURCE changes, because the prompt carries it", () => {
    // `llmFactExtractor` puts `Source: <source>` in the prompt, so a source edit
    // is a prompt edit and the recording below it is stale.
    expect(corpusDigest(corpusOf(pairEntry()))).not.toBe(
      corpusDigest(corpusOf(pairEntry({ a: { source: "email", body: pairEntry().a.body } }))),
    );
  });
});

// ── The write path ────────────────────────────────────────────────────

describe("runBrainParaphraseEval --write", () => {
  function stage(corpus: MessageCorpus): { corpusPath: string; artifactPath: string } {
    const dir = tempDir();
    const corpusPath = path.join(dir, "messages.json");
    fs.writeFileSync(corpusPath, JSON.stringify(corpus));
    return { corpusPath, artifactPath: path.join(dir, "extracted.json") };
  }

  /** An extractor that speaks for claim-bearing pairs and stays silent for `no-claim` ones. */
  const honestSeam = async ({ pairId, side }: { pairId: string; side: "a" | "b" }) =>
    pairId === "small-talk" ? [] : [triple({ predicate: side === "a" ? "is priced at" : "costs" })];

  test("records what the injected extractor emitted, with its provenance", async () => {
    const corpus = loadableCorpus();
    const { corpusPath, artifactPath } = stage(corpus);
    const report = await runBrainParaphraseEval({
      corpusPath,
      artifactPath,
      write: true,
      json: false,
      extract: honestSeam,
    });
    expect(report.wrote).toBe(true);
    const written = JSON.parse(fs.readFileSync(artifactPath, "utf-8")) as RecordedArtifact;
    expect(written.pairs["price-copula"].a[0].predicate).toBe("is priced at");
    expect(written.pairs["price-copula"].b[0].predicate).toBe("costs");
    expect(written.corpusDigest).toBe(corpusDigest(corpus));
    // The provenance fields are what make a regenerated fixture reviewable, and
    // nothing held them until this line: `model: seam.modelId` could be replaced
    // with a constant and no test noticed, on either side of the loop.
    expect(written.model).toBe("(injected)");
    expect(written.extractor).toBe("(injected)");
  });

  test("⚠️ REFUSES to write a recording that fails the honesty checks", async () => {
    // Regenerating is the fix for drift and must stay cheap. It is NOT the fix
    // for a corpus that has stopped exercising anything — writing that down
    // would bless an empty fixture, and every prohibition downstream would then
    // pass forever against machinery that does nothing.
    const { corpusPath, artifactPath } = stage(loadableCorpus());
    const report = await runBrainParaphraseEval({
      corpusPath,
      artifactPath,
      write: true,
      json: false,
      extract: async () => [],
    });
    expect(report.wrote).toBe(false);
    expect(report.passed).toBe(false);
    expect(report.dishonestCount).toBeGreaterThan(0);
    expect(fs.existsSync(artifactPath)).toBe(false);
  });

  test("a write over a DRIFTED artifact succeeds — that is what the mode is for", async () => {
    // The write-mode verdict is the honesty checks alone, not the comparison
    // against the artifact being replaced. Without this the two modes' verdicts
    // are indistinguishable and `--write` could never resolve a drift.
    const corpus = loadableCorpus();
    const { corpusPath, artifactPath } = stage(corpus);
    fs.writeFileSync(
      artifactPath,
      serializeArtifact(
        artifactOf(corpus, {
          "price-copula": { a: [triple({ predicate: "was priced at" })], b: [triple({ predicate: "costs" })] },
          "small-talk": { a: [], b: [] },
        }),
      ),
    );
    const report = await runBrainParaphraseEval({
      corpusPath,
      artifactPath,
      write: true,
      json: false,
      extract: honestSeam,
    });
    expect(report.wrote).toBe(true);
    expect(report.passed).toBe(true);
    // …and the drift it resolved still travels in the payload, so `--json`
    // records what moved even on a successful write.
    expect(report.outcomes.some((o) => o.status === "drift")).toBe(true);
    // ⚠️ `comparisonPassed` is the ONLY field that can express "the artifact
    // being replaced did not match" — `passed` is the write-mode verdict and is
    // `true` here. Pinning it constant killed nothing until this line.
    expect(report.comparisonPassed).toBe(false);
  });

  test("an existing artifact that cannot be READ is replaced, and the report says so", async () => {
    // Distinct from "there is no artifact yet": the committed bytes were
    // DISCARDED, and the reviewer of that diff is entitled to know it happened.
    const corpus = loadableCorpus();
    const { corpusPath, artifactPath } = stage(corpus);
    fs.writeFileSync(artifactPath, "{ not json");
    const report = await runBrainParaphraseEval({
      corpusPath,
      artifactPath,
      write: true,
      json: false,
      extract: honestSeam,
    });
    expect(report.wrote).toBe(true);
    expect(report.priorArtifactError).toContain("Failed to parse");
  });

  test("a first-ever recording reports no prior-artifact error", async () => {
    // The control: `priorArtifactError` must distinguish "replaced something
    // unreadable" from "there was nothing there", or it is just a second way of
    // spelling `wrote`.
    const { corpusPath, artifactPath } = stage(loadableCorpus());
    const report = await runBrainParaphraseEval({
      corpusPath,
      artifactPath,
      write: true,
      json: false,
      extract: honestSeam,
    });
    expect(report.wrote).toBe(true);
    expect(report.write).toBe(true);
    expect(report.priorArtifactError).toBeNull();
  });

  test("a fresh recording round-trips through the serializer, pairs in CORPUS order", async () => {
    // The artifact is committed, so its bytes are reviewed: stable key order and
    // a trailing newline keep a one-triple change to a one-triple diff. TWO
    // claim-bearing pairs, because with one the "corpus order" claim in
    // `serializeArtifact`'s docstring is unfalsifiable — any order is that order.
    const corpus = corpusOf(pairEntry({ id: "zzz-last" }), pairEntry({ id: "aaa-first" }), smallTalkEntry());
    const { corpusPath, artifactPath } = stage(corpus);
    await runBrainParaphraseEval({
      corpusPath,
      artifactPath,
      write: true,
      json: false,
      extract: honestSeam,
    });
    const raw = fs.readFileSync(artifactPath, "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
    // ⚠️ The INDENT, not a round-trip. `serializeArtifact(JSON.parse(raw))`
    // reproduces `raw` for any deterministic serializer — `JSON.parse` preserves
    // key order and `stringify` re-emits it — so dropping the 2-space indent
    // killed nothing while the test claimed to pin "stable key order and a
    // trailing newline". The newline and the order are held by their own lines.
    expect(raw).toContain('\n  "model":');
    // Corpus order, NOT sorted and NOT insertion order of some map.
    expect(Object.keys((JSON.parse(raw) as RecordedArtifact).pairs)).toEqual([
      "zzz-last",
      "aaa-first",
      "small-talk",
    ]);
  });
});

// ── The comparison itself ─────────────────────────────────────────────

describe("triplesEqualBySlot", () => {
  // ⚠️ Called DIRECTLY, because the honesty checks now refuse any pair carrying
  // more than one claim a side — so the order and length arms are unreachable
  // through `gradeParaphraseRun`, and an arm no test can reach is an arm that is
  // not really there.
  const one = triple();
  const two = triple({ predicate: "renews at", object: "$449 a month" });

  test("order is part of the recording", () => {
    // What the model chose to say first is signal. A set comparison would hide a
    // reordering that the consuming suite would then read differently.
    expect(triplesEqualBySlot([one, two], [two, one])).toBe(false);
  });

  test("positive control: the same order compares equal", () => {
    expect(triplesEqualBySlot([one, two], [one, two])).toBe(true);
  });

  test("⚠️ a LOST claim is caught — the length check fails in the dangerous direction", () => {
    // `a.every(...)` over a SHORTER array short-circuits to `true`, so without
    // the explicit length check a side that LOST a claim grades equal. (A side
    // that GAINED one is caught anyway, because the index goes `undefined`.)
    // That asymmetry is the whole reason the check is there.
    expect(triplesEqualBySlot([one], [one, two])).toBe(false);
    expect(triplesEqualBySlot([one, two], [one])).toBe(false);
  });

  test("each of the three slots is compared", () => {
    expect(triplesEqualBySlot([one], [triple({ subject: "Starter tier" })])).toBe(false);
    expect(triplesEqualBySlot([one], [triple({ predicate: "costs" })])).toBe(false);
    expect(triplesEqualBySlot([one], [triple({ object: "$599 a month" })])).toBe(false);
  });
});

// ── The verdict path CI actually runs ─────────────────────────────────

describe("runBrainParaphraseEval in GRADE mode", () => {
  // ⚠️ THE PATH CI RUNS, AND IT HAD NO TEST. Every earlier test drove
  // `write: true`. Two independent one-line mutations — dropping the
  // `opts.write ?` arm from the verdict, and `return 0` in
  // `reportParaphraseRun` — each made a fully drifted run exit 0 while killing
  // nothing, which would turn the release gate into a check that structurally
  // cannot go red. That is `eval-mcp-llm`'s own failure mode, reproduced inside
  // the job whose header cites it.
  function stage(corpus: MessageCorpus, artifact?: RecordedArtifact): {
    corpusPath: string;
    artifactPath: string;
  } {
    const dir = tempDir();
    const corpusPath = path.join(dir, "messages.json");
    const artifactPath = path.join(dir, "extracted.json");
    fs.writeFileSync(corpusPath, JSON.stringify(corpus));
    if (artifact) fs.writeFileSync(artifactPath, serializeArtifact(artifact));
    return { corpusPath, artifactPath };
  }

  const recorded: RecordedSides = { a: [triple()], b: [triple({ predicate: "costs" })] };
  const empty: RecordedSides = { a: [], b: [] };

  function artifactFor(corpus: MessageCorpus): RecordedArtifact {
    return artifactOf(corpus, { "price-copula": recorded, "small-talk": empty });
  }

  test("a run that reproduces the artifact passes and writes nothing", async () => {
    const corpus = loadableCorpus();
    const { corpusPath, artifactPath } = stage(corpus, artifactFor(corpus));
    const report = await runBrainParaphraseEval({
      corpusPath,
      artifactPath,
      write: false,
      json: false,
      extract: async ({ pairId, side }) =>
        pairId === "small-talk" ? [] : [triple({ predicate: side === "a" ? "is priced at" : "costs" })],
    });
    expect(report.passed).toBe(true);
    expect(report.wrote).toBe(false);
    expect(report.write).toBe(false);
  });

  test("⚠️ a drifted run FAILS and does not touch the artifact", async () => {
    const corpus = loadableCorpus();
    const { corpusPath, artifactPath } = stage(corpus, artifactFor(corpus));
    const before = fs.readFileSync(artifactPath, "utf-8");
    const report = await runBrainParaphraseEval({
      corpusPath,
      artifactPath,
      write: false,
      json: false,
      extract: async ({ pairId, side }) =>
        pairId === "small-talk" ? [] : [triple({ predicate: side === "a" ? "has price" : "costs" })],
    });
    expect(report.passed).toBe(false);
    expect(report.wrote).toBe(false);
    // Grade mode is READ-ONLY. A grader that quietly repaired the artifact would
    // make every subsequent run green over a drift nobody saw.
    expect(fs.readFileSync(artifactPath, "utf-8")).toBe(before);
  });

  test("a missing artifact THROWS in grade mode rather than grading against nothing", async () => {
    const corpus = loadableCorpus();
    const { corpusPath, artifactPath } = stage(corpus);
    await expect(
      runBrainParaphraseEval({
        corpusPath,
        artifactPath,
        write: false,
        json: false,
        extract: async () => [triple()],
      }),
    ).rejects.toThrow(/artifact not found/);
  });
});

describe("reportParaphraseRun", () => {
  // It is not a formatter — it computes the process exit code, which is the
  // whole verdict the workflow's gate step reads.
  function reportOf(over: Partial<ParaphraseRunReport>): ParaphraseRunReport {
    return {
      outcomes: [],
      staleArtifactPairs: [],
      digestMismatch: null,
      passed: true,
      model: "anthropic/claude-haiku-4.5",
      extractor: "extraction:v1",
      corpusPath: "/tmp/messages.json",
      artifactPath: "/tmp/extracted.json",
      write: false,
      comparisonPassed: true,
      wrote: false,
      dishonestCount: 0,
      priorArtifactError: null,
      ...over,
    };
  }

  /** Collect the transcript instead of writing it to fd 2. */
  function transcriptOf(over: Partial<ParaphraseRunReport>): { text: string; code: number } {
    const lines: string[] = [];
    const code = reportParaphraseRun(reportOf(over), (t) => lines.push(t));
    return { text: lines.join(""), code };
  }

  const driftOutcome = {
    id: "price-copula",
    relation: "same-claim" as const,
    status: "drift" as const,
    detail: "side a: recorded is priced at — now has price",
    fresh: { a: [triple()], b: [triple()] },
    recorded: { a: [triple()], b: [triple()] },
  };

  test("⚠️ the REFUSAL is named, and does not advise re-running the command that was refused", () => {
    // The fix for round 1's finding shipped untested: mutating the refusal
    // message away killed nothing, because every test here built a report with
    // `outcomes: []` and never executed the loop.
    const { text } = transcriptOf({ write: true, wrote: false, passed: false, dishonestCount: 2 });
    expect(text).toContain("REFUSED to write");
    expect(text).toContain("2 pair(s)");
    // The remedy must not loop: this IS the `--write` run.
    expect(text).not.toContain("regenerate with --write");
  });

  test("a failing GRADE run says FAIL and tells the operator to read what moved", () => {
    const { text } = transcriptOf({ passed: false, outcomes: [driftOutcome] });
    // ⚠️ THE SUMMARY LINE, not a bare "FAIL". `toContain("FAIL")` matched the
    // per-outcome line above it, so pinning the summary word to a constant
    // killed nothing — a grade run could print `PASS: 0/1 pairs match` and exit
    // 1, which is the self-contradicting transcript this lane fixed in the
    // write branch and could not detect in this one.
    expect(text).toContain("FAIL: 0/1 pairs match the recorded artifact.");
    expect(text).toContain("fails on DRIFT by design");
    expect(text).toContain("is priced at");
  });

  test("a passing GRADE run says PASS and offers no remedy", () => {
    // The control for the line above — and for the summary WORD, which was
    // pinned to nothing: a mutation forcing "PASS" survived while a grade run
    // could print `PASS: 3/9 pairs match` and then exit 1.
    const { text } = transcriptOf({
      passed: true,
      outcomes: [{ ...driftOutcome, status: "match", detail: "" }],
    });
    expect(text).toContain("PASS: 1/1 pairs match the recorded artifact.");
    expect(text).not.toContain("FAIL");
    expect(text).not.toContain("fails on DRIFT by design");
  });

  test("write mode still prints WHAT MOVED — it is the mode that resolves drift", () => {
    // Suppressing the detail here silenced the drift diagnosis in the one mode
    // whose job is to resolve drift, while every other surface tells the
    // operator to read it before regenerating.
    const { text } = transcriptOf({ write: true, wrote: true, passed: true, outcomes: [driftOutcome] });
    expect(text).toContain("is priced at");
  });

  test("write mode does not print a stale remedy for the digest it just refreshed", () => {
    const { text } = transcriptOf({
      write: true,
      wrote: true,
      passed: true,
      digestMismatch: { corpus: "aaaaaaaaaaaa", artifact: "bbbbbbbbbbbb" },
      staleArtifactPairs: ["long-gone"],
    });
    expect(text).not.toContain("Re-run with --write");
    expect(text).toContain("long-gone");
  });

  test("⚠️ a write that wrote NOTHING and refused nothing is a harness fault, and exits 1", () => {
    // `passed` derives from `dishonestCount`, so this state used to print
    // "REFUSED … 0 pair(s) failed" — a diagnosis contradicted by its own number
    // — and exit 0. The same mutation class this lane's commit message opens
    // with, in the sibling function.
    const { text, code } = transcriptOf({ write: true, wrote: false, passed: true, dishonestCount: 0 });
    expect(text).toContain("harness fault");
    expect(code).toBe(1);
  });

  test("a discarded prior recording is named in the SUMMARY, not only mid-transcript", () => {
    const { text } = transcriptOf({
      write: true,
      wrote: true,
      passed: true,
      priorArtifactError: "Failed to parse paraphrase artifact /tmp/x.json: unexpected token",
    });
    expect(text).toContain("DISCARDED, not superseded");
  });

  test("a passing report exits 0", () => {
    expect(reportParaphraseRun(reportOf({ passed: true }))).toBe(0);
  });

  test("⚠️ a failing report exits 1 — this is the release gate", () => {
    expect(reportParaphraseRun(reportOf({ passed: false }))).toBe(1);
  });

  test("a refused write exits 1", () => {
    expect(
      reportParaphraseRun(reportOf({ write: true, wrote: false, passed: false, dishonestCount: 2 })),
    ).toBe(1);
  });

  test("a successful write exits 0", () => {
    expect(reportParaphraseRun(reportOf({ write: true, wrote: true, passed: true }))).toBe(0);
  });
});

describe("main", () => {
  // ⚠️ THE COMPOSITION, which round 2 found unheld. `reportParaphraseRun`
  // returning the right number and `main` handing that number to `process.exit`
  // are two facts; only the first had a test, and `return 0` here made a fully
  // drifted, tag-blocking run exit 0 with the suite green.
  function stage(): { corpusPath: string; artifactPath: string; corpus: MessageCorpus } {
    const dir = tempDir();
    const corpus = loadableCorpus();
    const corpusPath = path.join(dir, "messages.json");
    const artifactPath = path.join(dir, "extracted.json");
    fs.writeFileSync(corpusPath, JSON.stringify(corpus));
    fs.writeFileSync(
      artifactPath,
      serializeArtifact(
        artifactOf(corpus, {
          "price-copula": { a: [triple()], b: [triple({ predicate: "costs" })] },
          "small-talk": { a: [], b: [] },
        }),
      ),
    );
    return { corpusPath, artifactPath, corpus };
  }

  const matching = async ({ pairId, side }: { pairId: string; side: "a" | "b" }) =>
    pairId === "small-talk" ? [] : [triple({ predicate: side === "a" ? "is priced at" : "costs" })];
  const drifted = async ({ pairId, side }: { pairId: string; side: "a" | "b" }) =>
    pairId === "small-talk" ? [] : [triple({ predicate: side === "a" ? "has price" : "costs" })];

  test("returns 0 when the run reproduces the artifact", async () => {
    const { corpusPath, artifactPath } = stage();
    const code = await main(["--corpus", corpusPath, "--artifact", artifactPath], matching, () => {});
    expect(code).toBe(0);
  });

  test("⚠️ returns 1 when the run has drifted — this is the tag-blocking gate", async () => {
    const { corpusPath, artifactPath } = stage();
    const code = await main(["--corpus", corpusPath, "--artifact", artifactPath], drifted, () => {});
    expect(code).toBe(1);
  });

  test("--json does not change the verdict", async () => {
    // ⚠️ The fd-1 CONTENT is deliberately not asserted here. `import * as fs`
    // is not patchable under ESM, so a spy would be testing the spy — and the
    // property that matters (nothing but the payload reaches fd 1) is held by
    // the GREP in `eval-json-stdout.test.ts`, which now covers this driver and
    // the writer it delegates to, plus the workflow's `jq empty` step. What is
    // worth pinning here is that the flag is presentational: a mode that
    // changed the verdict would make the CI run and a local run disagree.
    const { corpusPath, artifactPath } = stage();
    const plain = await main(["--corpus", corpusPath, "--artifact", artifactPath], drifted, () => {});
    const json = await main(
      ["--corpus", corpusPath, "--artifact", artifactPath, "--json"],
      drifted,
      () => {},
    );
    expect(plain).toBe(1);
    expect(json).toBe(plain);
  });
});

// ── Argument parsing ──────────────────────────────────────────────────

describe("parseParaphraseArgs", () => {
  test("defaults to the committed corpus and artifact", () => {
    const opts = parseParaphraseArgs([]);
    expect(opts.corpusPath).toBe(DEFAULT_CORPUS_PATH);
    expect(opts.artifactPath).toBe(DEFAULT_ARTIFACT_PATH);
    expect(opts.write).toBe(false);
    expect(opts.json).toBe(false);
  });

  test("honours explicit paths", () => {
    // Ignoring these would silently grade the COMMITTED corpus while an operator
    // believed they were grading a staged one — and report the opposite verdict
    // with total confidence.
    const opts = parseParaphraseArgs(["--corpus", "/tmp/c.json", "--artifact", "/tmp/a.json"]);
    expect(opts.corpusPath).toBe("/tmp/c.json");
    expect(opts.artifactPath).toBe("/tmp/a.json");
  });

  test("reads the bare flags", () => {
    const opts = parseParaphraseArgs(["--write", "--json"]);
    expect(opts.write).toBe(true);
    expect(opts.json).toBe(true);
  });

  test("a value flag with no value throws rather than falling back to the default", () => {
    expect(() => parseParaphraseArgs(["--corpus", "--json"])).toThrow(/requires a path argument/);
  });

  test("⚠️ an unrecognized flag is an error, not a silent no-op", () => {
    // `--writ` would otherwise GRADE instead of writing, then advise the
    // operator to run `--write` — the command they thought they had run.
    expect(() => parseParaphraseArgs(["--writ"])).toThrow(/Unrecognized argument "--writ"/);
    expect(() => parseParaphraseArgs(["--jsn"])).toThrow(/Unrecognized argument "--jsn"/);
    // ⚠️ AND THE SPELLINGS THAT ARE NOT `--`-PREFIXED, which the first cut of
    // this guard skipped — `-w` is the likelier typo than `--writ`, and a bare
    // word is the likelier paste.
    expect(() => parseParaphraseArgs(["-w"])).toThrow(/Unrecognized argument "-w"/);
    expect(() => parseParaphraseArgs(["write"])).toThrow(/Unrecognized argument "write"/);
    expect(() => parseParaphraseArgs(["/some/path.json"])).toThrow(/Unrecognized argument/);
  });

  test("a repeated flag throws rather than silently taking the first", () => {
    // `indexOf` resolves the FIRST occurrence, so `--corpus a --corpus b` grades
    // `a` while the operator reads `b` off their own command line.
    expect(() => parseParaphraseArgs(["--corpus", "/a", "--corpus", "/b"])).toThrow(
      /--corpus was given more than once/,
    );
  });

  test("a path that starts with `--` is not itself scanned as a flag", () => {
    // Belt-and-braces: `flagValue` refuses that shape first, so this pins that
    // the unknown-flag scan does not reach it and produce a different error.
    expect(() => parseParaphraseArgs(["--corpus", "--nonsense"])).toThrow(/requires a path argument/);
  });
});

// ── Artifact loading ──────────────────────────────────────────────────

describe("loadArtifact", () => {
  function write(contents: string): string {
    const dir = tempDir();
    const file = path.join(dir, "extracted.json");
    fs.writeFileSync(file, contents);
    return file;
  }

  test("names the regeneration command when the file is absent", () => {
    expect(() => loadArtifact(path.join(tempDir(), "nope.json"))).toThrow(/--write/);
  });

  test("names the file when it does not parse", () => {
    expect(() => loadArtifact(write("{ not json"))).toThrow(/does not parse|Failed to parse/);
  });

  test("rejects an artifact with no `corpusDigest`", () => {
    // Without it the staleness check silently compares against `undefined` and
    // reports a mismatch whose message points nowhere.
    expect(() => loadArtifact(write(JSON.stringify({ pairs: {} })))).toThrow(/corpusDigest/);
  });

  test("rejects an artifact with no `pairs`", () => {
    expect(() => loadArtifact(write(JSON.stringify({ corpusDigest: "abc" })))).toThrow(/pairs/);
  });
});

describe("toRecordedTriple", () => {
  test("carries the three slots and the advisory hint", () => {
    expect(
      toRecordedTriple({
        subject: "Ada",
        predicate: "reports to",
        object: "Grace",
        predicateCardinality: "single",
      }),
    ).toEqual({ subject: "Ada", predicate: "reports to", object: "Grace", cardinalityHint: "single" });
  });

  test("records a missing hint as null rather than coercing it", () => {
    // `predicateCardinality` is optional on `FactCandidate`. `String(undefined)`
    // would put the literal `"undefined"` in a committed artifact, reading like
    // an answer the extractor gave.
    expect(
      toRecordedTriple({ subject: "Ada", predicate: "reports to", object: "Grace" }).cardinalityHint,
    ).toBeNull();
  });
});
