/**
 * The consuming side's loaders and guards (#5041).
 *
 * ⚠️ THIS FILE EXISTS BECAUSE THE FIX FOR AN ASYMMETRY CREATED ANOTHER ONE.
 * Review round 1 found that the api-side twin validated nothing while the CLI's
 * `loadArtifact` validated carefully — and this is the side that runs on every
 * PR. Round 2 found the fix had made the CODE symmetric and left the TESTS
 * asymmetric: `loadArtifact` gained a four-test describe in the same commit, and
 * its twin gained none, so every guard added here killed zero mutations.
 *
 * The root cause was testability. `loadRecordedArtifact()` and `loadMessages()`
 * took no path and could only ever read the committed, valid file; they now take
 * an optional one, defaulting to the constant.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  corpusDigest,
  loadMessages,
  loadRecordedArtifact,
  soleClaim,
  type MessageCorpus,
  type RecordedArtifact,
  type RecordedSides,
  type RecordedTriple,
} from "./paraphrase-corpus";

function tmp(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paraphrase-corpus-"));
  const file = path.join(dir, "f.json");
  fs.writeFileSync(file, contents);
  return file;
}

function triple(over: Partial<RecordedTriple> = {}): RecordedTriple {
  return {
    subject: "Business tier",
    predicate: "is priced at",
    object: "$499 a month",
    cardinalityHint: "single",
    ...over,
  };
}

function artifact(pairs: Record<string, RecordedSides>): string {
  return JSON.stringify({
    description: "recorded",
    model: "anthropic/claude-haiku-4.5",
    extractor: "extraction:v1",
    recordedAt: "2026-08-12T00:00:00.000Z",
    corpusDigest: "abc123",
    pairs,
  } satisfies RecordedArtifact);
}

describe("loadRecordedArtifact", () => {
  test("accepts a well-formed recording", () => {
    const loaded = loadRecordedArtifact(tmp(artifact({ p: { a: [triple()], b: [triple()] } })));
    expect(Object.keys(loaded.pairs)).toEqual(["p"]);
  });

  test("names the file and the regeneration command when it is missing", () => {
    expect(() => loadRecordedArtifact(path.join(os.tmpdir(), "definitely-not-here.json"))).toThrow(
      /--write/,
    );
  });

  test("rejects a recording that does not parse", () => {
    expect(() => loadRecordedArtifact(tmp("{ not json"))).toThrow(/does not parse/);
  });

  test("rejects a recording with no `corpusDigest`", () => {
    // Without it the staleness check compares against `undefined` and reports a
    // mismatch whose message points nowhere.
    expect(() => loadRecordedArtifact(tmp(JSON.stringify({ pairs: {} })))).toThrow(/corpusDigest/);
  });

  test("rejects a truncated recording with no `pairs`", () => {
    // This is the case that used to surface as `TypeError: Cannot convert
    // undefined to object` at module scope — before any test NAME was printed.
    expect(() => loadRecordedArtifact(tmp(JSON.stringify({ corpusDigest: "x" })))).toThrow(/pairs/);
  });

  describe("the blank-slot guard", () => {
    // ⚠️ The guard that closes the gap between the two ends: the eval refuses to
    // RECORD a claim whose slot normalizes away, and until round 2 nothing
    // refused to CONSUME one. A hand-edited artifact carrying such a row left
    // every prohibition in `paraphrase-identity.test.ts` green — `sameSlot`
    // answers `false` for a null key, which is exactly what they assert.
    for (const [slot, surface] of [
      ["subject", "  "],
      ["predicate", "-"],
      ["object", "___"],
    ] as const) {
      test(`rejects a claim whose ${slot} keys to nothing`, () => {
        const file = tmp(artifact({ p: { a: [triple({ [slot]: surface })], b: [triple()] } }));
        expect(() => loadRecordedArtifact(file)).toThrow(
          new RegExp(`${slot} keys to NOTHING`),
        );
      });
    }

    test("positive control: ordinary surfaces load", () => {
      // Without this, "a blank slot is rejected" is satisfied by a guard that
      // rejects everything — which would make the committed artifact unloadable
      // and every suite below it red for the wrong reason.
      expect(() =>
        loadRecordedArtifact(tmp(artifact({ p: { a: [triple()], b: [triple()] } }))),
      ).not.toThrow();
    });

    test("the committed artifact satisfies it", () => {
      // The one assertion that ties the guard to the file it guards. If a future
      // `--write` ever records a surface this rejects, the failure lands here
      // rather than as a confusing vacuous pass three describes away.
      expect(() => loadRecordedArtifact()).not.toThrow();
    });
  });
});

describe("loadMessages", () => {
  const pair = {
    id: "p",
    relation: "same-claim",
    why: "because",
    a: { source: "chat", body: "one" },
    b: { source: "chat", body: "two" },
  };

  test("accepts a well-formed corpus", () => {
    expect(loadMessages(tmp(JSON.stringify({ pairs: [pair] }))).pairs).toHaveLength(1);
  });

  test("rejects a corpus with no `pairs` array", () => {
    expect(() => loadMessages(tmp(JSON.stringify({})))).toThrow(/pairs/);
  });

  test("⚠️ rejects a relation this module's copy of the tuple does not know", () => {
    // What makes the COPIED tuple load-bearing. Copying `PARAPHRASE_RELATIONS`
    // as a union bought a compile error for a typo in this file, but the union
    // was asserted by a bare cast over unchecked JSON — so a relation added to
    // the driver's tuple and to `messages.json` would have left this side's type
    // claiming a value the file contradicts, silently. Drift between the two
    // copies now fails on the next PR with a named message.
    const drifted = { ...pair, relation: "entailment" };
    expect(() => loadMessages(tmp(JSON.stringify({ pairs: [drifted] })))).toThrow(/have drifted/);
  });

  test("the committed corpus agrees with the committed recording's digest", () => {
    // The two halves, tied together at the one place both are in scope.
    expect(loadRecordedArtifact().corpusDigest).toBe(corpusDigest(loadMessages()));
  });
});

describe("soleClaim", () => {
  const loaded = (pairs: Record<string, RecordedSides>): RecordedArtifact =>
    loadRecordedArtifact(tmp(artifact(pairs)));

  test("returns the one claim a side recorded", () => {
    expect(soleClaim(loaded({ p: { a: [triple()], b: [triple()] } }), "p", "a").predicate).toBe(
      "is priced at",
    );
  });

  test("⚠️ throws on a side with no claim rather than returning undefined", () => {
    // The accidental-equality class it exists to close: `sides.a[0]?.predicate`
    // against an empty recording compares `undefined` to `undefined` and PASSES.
    const art = JSON.parse(artifact({ p: { a: [], b: [triple()] } })) as RecordedArtifact;
    expect(() => soleClaim(art, "p", "a")).toThrow(/recorded 0 claims, expected exactly 1/);
  });

  test("throws on a side with more than one claim", () => {
    // The contract the eval's arity check was aligned TO. Relaxing this end
    // silently reopens the gap between the two.
    const art = JSON.parse(artifact({ p: { a: [triple(), triple()], b: [triple()] } })) as RecordedArtifact;
    expect(() => soleClaim(art, "p", "a")).toThrow(/recorded 2 claims, expected exactly 1/);
  });

  test("names the pair when the artifact has no such id", () => {
    expect(() => soleClaim(loaded({ p: { a: [triple()], b: [triple()] } }), "nope", "a")).toThrow(
      /no pair "nope"/,
    );
  });

  test("a malformed side is reported as malformed, not as a raw TypeError", () => {
    // Reaching `.length` on `undefined` raised `Cannot read properties of
    // undefined` with no mention of the artifact — in the one helper whose whole
    // job is to fail informatively.
    const art = { pairs: { p: { a: [triple()] } } } as unknown as RecordedArtifact;
    expect(() => soleClaim(art, "p", "b")).toThrow(/no side b in the artifact/);
  });
});

describe("corpusDigest", () => {
  const corpus = (body: string): MessageCorpus => ({
    pairs: [
      {
        id: "p",
        relation: "same-claim",
        why: "prose the model never sees",
        a: { source: "chat", body },
        b: { source: "chat", body: "two" },
      },
    ],
  });

  test("changes when a message body changes", () => {
    expect(corpusDigest(corpus("one"))).not.toBe(corpusDigest(corpus("one but edited")));
  });

  test("ignores the prose a reviewer reads", () => {
    const a = corpus("one");
    const b: MessageCorpus = { pairs: [{ ...a.pairs[0], why: "a completely different reason" }] };
    expect(corpusDigest(a)).toBe(corpusDigest(b));
  });
});
