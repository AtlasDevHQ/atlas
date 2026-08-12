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
  gradeParaphraseRun,
  loadMessageCorpus,
  runBrainParaphraseEval,
  serializeArtifact,
  toRecordedTriple,
  type MessageCorpus,
  type ParaphrasePair,
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

function corpusOf(...pairs: ParaphrasePair[]): MessageCorpus {
  return { pairs };
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

  test("claim ORDER is part of the recording", () => {
    // What the model chose to say first is signal, and two triples swapped is a
    // different recording even though the set is equal. A set comparison here
    // would hide a reordering that the deterministic suite's `soleClaim` would
    // then read differently.
    const corpus = corpusOf(pairEntry());
    const one = triple();
    const two = triple({ predicate: "renews at", object: "$449 a month" });
    const recorded: RecordedSides = { a: [one, two], b: [triple({ predicate: "costs" })] };
    const fresh: RecordedSides = { a: [two, one], b: [triple({ predicate: "costs" })] };
    const result = gradeParaphraseRun(corpus, { "price-copula": fresh }, artifactOf(corpus, { "price-copula": recorded }));
    expect(result.outcomes[0].status).toBe("drift");
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
    expect(loadMessageCorpus(write(corpusOf(pairEntry()))).pairs).toHaveLength(1);
  });

  test("rejects two pairs sharing an id", () => {
    // Ids name the artifact's keys, so a duplicate silently makes one recording
    // overwrite the other and the corpus one pair smaller than it reads.
    const file = write(corpusOf(pairEntry(), pairEntry()));
    expect(() => loadMessageCorpus(file)).toThrow(/two pairs with id "price-copula"/);
  });

  test("rejects a relation outside the vocabulary", () => {
    const file = write(corpusOf(pairEntry({ relation: "sort-of-the-same" as ParaphrasePair["relation"] })));
    expect(() => loadMessageCorpus(file)).toThrow(/expected one of/);
  });

  test("rejects a pair with no `why`", () => {
    // This corpus is all argument: an entry whose reason is not written down
    // cannot be reviewed, and a reviewer is the only oracle it has.
    const file = write(corpusOf(pairEntry({ why: "" })));
    expect(() => loadMessageCorpus(file)).toThrow(/is missing `why`/);
  });

  test("names the file and the pair when a message body is missing", () => {
    const file = write(corpusOf(pairEntry({ b: { source: "chat", body: "" } })));
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

  test("records what the injected extractor emitted", async () => {
    const { corpusPath, artifactPath } = stage(corpusOf(pairEntry()));
    const report = await runBrainParaphraseEval({
      corpusPath,
      artifactPath,
      write: true,
      json: false,
      extract: async ({ side }) => [triple({ predicate: side === "a" ? "is priced at" : "costs" })],
    });
    expect(report.wrote).toBe(true);
    const written = JSON.parse(fs.readFileSync(artifactPath, "utf-8")) as RecordedArtifact;
    expect(written.pairs["price-copula"].a[0].predicate).toBe("is priced at");
    expect(written.pairs["price-copula"].b[0].predicate).toBe("costs");
    expect(written.corpusDigest).toBe(corpusDigest(corpusOf(pairEntry())));
  });

  test("⚠️ REFUSES to write a recording that fails the honesty checks", () => {
    // Regenerating is the fix for drift and must stay cheap. It is NOT the fix
    // for a corpus that has stopped exercising anything — writing that down
    // would bless an empty fixture, and every prohibition downstream would then
    // pass forever against machinery that does nothing.
    const { corpusPath, artifactPath } = stage(corpusOf(pairEntry()));
    return runBrainParaphraseEval({
      corpusPath,
      artifactPath,
      write: true,
      json: false,
      extract: async () => [],
    }).then((report) => {
      expect(report.wrote).toBe(false);
      expect(report.passed).toBe(false);
      expect(fs.existsSync(artifactPath)).toBe(false);
    });
  });

  test("a fresh recording round-trips through the serializer", async () => {
    // The artifact is committed, so its bytes are reviewed: stable key order and
    // a trailing newline keep a one-triple change to a one-triple diff.
    const { corpusPath, artifactPath } = stage(corpusOf(pairEntry()));
    await runBrainParaphraseEval({
      corpusPath,
      artifactPath,
      write: true,
      json: false,
      extract: async () => [triple()],
    });
    const raw = fs.readFileSync(artifactPath, "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(serializeArtifact(JSON.parse(raw) as RecordedArtifact)).toBe(raw);
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
