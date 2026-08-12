/**
 * The MACHINE-produced half of the claim-identity corpus (#5041, ADR-0037 §9).
 *
 * `identity-corpus.ts` holds claims a human wrote. This module holds claims the
 * real extractor emitted, read off `eval/brain-paraphrase/extracted.json` — the
 * artifact `packages/cli/bin/brain-paraphrase-eval.ts` records by driving
 * `llmFactExtractor` over `eval/brain-paraphrase/messages.json`.
 *
 * ## Why the two corpora both exist
 *
 * They answer different questions and neither can answer the other's.
 *
 * `identity-corpus.ts` is EXHAUSTIVE over the identity layer's arms: it varies
 * the tier, the subject entity id, the declared object type — dimensions no
 * message can produce, because no extractor emits them. Its cost is that a human
 * chose every surface, so it proves the layer handles the variation someone
 * thought to write.
 *
 * This corpus is the opposite trade. It covers a fraction of the arms and it
 * cannot be argued with: nobody typed `is priced at`, the model did. What it
 * demonstrates is that the phrasing variance #5000 is about is REAL — a property
 * of a stochastic component that no fixture can assert and no unit test may
 * spend a model call to discover.
 *
 * ⚠️ **This module reads a committed file and makes no model call**, which is
 * the whole point of the split. The recording moves only when someone runs the
 * eval with `--write` and commits the result as a reviewed change; the eval
 * fails on drift precisely so that regeneration is a decision rather than an
 * accident.
 *
 * Not a `.test.ts`, so the isolated runner does not execute it — same reason as
 * `identity-corpus.ts` and `identity-fixtures.ts`.
 */

import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

/**
 * The repo root, from this file's own location rather than from `process.cwd()`.
 *
 * The isolated runner executes with cwd set to `packages/api`, `bun test` from
 * the repo root sets it there, and an editor's test runner may set neither — so
 * a cwd-relative path is a test that passes or fails on how it was launched.
 */
const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");

export const PARAPHRASE_ARTIFACT_PATH = path.join(
  REPO_ROOT,
  "eval",
  "brain-paraphrase",
  "extracted.json",
);
export const PARAPHRASE_MESSAGES_PATH = path.join(
  REPO_ROOT,
  "eval",
  "brain-paraphrase",
  "messages.json",
);

/** One claim, exactly as the extractor emitted it. */
export interface RecordedTriple {
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  /** Advisory since #5027, read by nothing here — recorded because it is worth observing. */
  readonly cardinalityHint: string | null;
}

export type RecordedSides = Readonly<Record<"a" | "b", readonly RecordedTriple[]>>;

export interface RecordedArtifact {
  readonly description: string;
  readonly model: string;
  readonly extractor: string;
  readonly recordedAt: string;
  readonly corpusDigest: string;
  readonly pairs: Readonly<Record<string, RecordedSides>>;
}

export interface ParaphrasePair {
  readonly id: string;
  readonly relation: string;
  readonly why: string;
  readonly a: { readonly source: string; readonly body: string };
  readonly b: { readonly source: string; readonly body: string };
}

export interface MessageCorpus {
  readonly pairs: readonly ParaphrasePair[];
}

function readJson(filePath: string, what: string): unknown {
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `The paraphrase ${what} is missing at ${filePath}. It is committed to the repo; a fresh ` +
        `one is recorded with \`bun packages/cli/bin/brain-paraphrase-eval.ts --write\`, which ` +
        `needs AI_GATEWAY_API_KEY and spends real money.`,
    );
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`The paraphrase ${what} at ${filePath} does not parse: ${msg}`, { cause: err });
  }
}

export function loadRecordedArtifact(): RecordedArtifact {
  return readJson(PARAPHRASE_ARTIFACT_PATH, "artifact") as RecordedArtifact;
}

export function loadMessages(): MessageCorpus {
  return readJson(PARAPHRASE_MESSAGES_PATH, "message corpus") as MessageCorpus;
}

/**
 * The single claim a pair's side recorded.
 *
 * ⚠️ THROWS rather than returning `undefined`, and every caller depends on that.
 * A test that read `sides.a[0]?.predicate` against an empty recording would
 * compare `undefined` to `undefined` and PASS — the accidental-equality class
 * ADR-0037 §9 names, arriving through an optional chain. Every pair the eval
 * grades as honest has exactly one claim per side except `small-talk`, which has
 * none by design and is asserted directly rather than through this helper.
 */
export function soleClaim(artifact: RecordedArtifact, pairId: string, side: "a" | "b"): RecordedTriple {
  const sides = artifact.pairs[pairId];
  if (!sides) {
    throw new Error(
      `the paraphrase artifact has no pair "${pairId}". If the corpus was edited, re-record it.`,
    );
  }
  const claims = sides[side];
  if (claims.length !== 1) {
    throw new Error(
      `paraphrase pair "${pairId}" side ${side} recorded ${claims.length} claims, expected exactly 1. ` +
        `A pair that stopped producing one claim per side no longer exercises what its test says it does.`,
    );
  }
  // `length === 1` above, so this index is populated. No `!`: nothing in the repo
  // sets `noUncheckedIndexedAccess`, so the access is already typed `T`.
  return claims[0];
}

/**
 * The digest the eval stamps into the artifact — over what the extractor was
 * SHOWN, in corpus order: each pair's id, and both sides' `source` and `body`.
 *
 * ⚠️ **This is a SECOND SPELLING of `corpusDigest` in
 * `packages/cli/bin/brain-paraphrase-eval.ts`, and the duplication is
 * deliberate.** The dependency runs cli → api, so there is no module both can
 * import without putting eval tooling inside `lib/` or having a `bin/` script
 * import a `__tests__/` directory. What a drift between the two spellings costs
 * is bounded and LOUD: the digests stop matching and `the artifact was recorded
 * from the message corpus in the tree` fails on every run until someone looks.
 * It cannot fail silently in the direction that matters — an edited message with
 * a stale recording — because that is the same mismatch.
 *
 * Deliberately NOT a hash of the file: `why`, `description` and `rubric` are
 * prose for a reviewer, the model never sees them, and invalidating the artifact
 * on a comment edit would teach everyone to regenerate on autopilot — the
 * discipline `mcp-llm-baseline.json` never had.
 */
export function corpusDigest(corpus: MessageCorpus): string {
  const material = corpus.pairs.map((p) => [
    p.id,
    ...(["a", "b"] as const).map((side) => [p[side].source, p[side].body]),
  ]);
  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}
