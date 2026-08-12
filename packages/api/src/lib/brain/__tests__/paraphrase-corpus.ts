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

/**
 * The two sides of a pair. Spelled once here for the reason `SIDES` is spelled
 * once in the driver: three separate `{ a, b }` literals in this file had
 * nothing linking them, so a third side would have had to be remembered in
 * three places rather than being a compile error in three places.
 */
export const SIDES = ["a", "b"] as const;
export type Side = (typeof SIDES)[number];

export type RecordedSides = Readonly<Record<Side, readonly RecordedTriple[]>>;

export interface RecordedArtifact {
  readonly description: string;
  readonly model: string;
  readonly extractor: string;
  readonly recordedAt: string;
  readonly corpusDigest: string;
  readonly pairs: Readonly<Record<string, RecordedSides>>;
}

/**
 * ⚠️ COPIED FROM THE DRIVER'S `PARAPHRASE_RELATIONS` AS A UNION, not flattened
 * to `string`.
 *
 * The first cut of this twin declared `relation: string`, which is the one part
 * of the corpus contract this side actually branches on
 * (`paraphrase-identity.test.ts` filters `=== "same-claim"`). A typo there
 * compiles under `string` and is caught only by a runtime set assertion — so the
 * copy was lossy in exactly the direction that costs safety, which is the
 * failure mode that makes a duplication indefensible rather than merely
 * unfortunate. Copying the five-member tuple as well is strictly cheaper.
 */
export const PARAPHRASE_RELATIONS = [
  "same-claim",
  "contradiction",
  "inverse",
  "different-claim",
  "no-claim",
] as const;
export type ParaphraseRelation = (typeof PARAPHRASE_RELATIONS)[number];

export interface ParaphrasePair {
  readonly id: string;
  readonly relation: ParaphraseRelation;
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
        `needs AI_GATEWAY_API_KEY and spends real money. ⚠️ After a --write, run this suite ` +
        `EXPLICITLY (\`bun test src/lib/brain/__tests__/paraphrase-identity.test.ts\`) — a ` +
        `regeneration touches only JSON, and \`scripts/test-isolated.ts --affected\` walks .ts ` +
        `files alone, so it selects nothing for the one change most likely to break this file.`,
    );
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`The paraphrase ${what} at ${filePath} does not parse: ${msg}`, { cause: err });
  }
}

/**
 * Load the recording, with the same envelope checks the driver's `loadArtifact`
 * makes.
 *
 * ⚠️ It used to be a bare cast, and the asymmetry was the defect: this is the
 * side that runs on EVERY PR, and it had the weaker validation of the two. A
 * truncated `extracted.json` reached `Object.keys(artifact.pairs)` at module
 * scope in the consuming test and surfaced as `TypeError: Cannot convert
 * undefined to object` — before any test NAME was printed, so the failure did
 * not say which file was broken or what to do about it, in a module whose error
 * messages are otherwise its best feature.
 */
export function loadRecordedArtifact(): RecordedArtifact {
  const parsed = readJson(PARAPHRASE_ARTIFACT_PATH, "artifact");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`The paraphrase artifact at ${PARAPHRASE_ARTIFACT_PATH} is not a JSON object.`);
  }
  const root = parsed as Record<string, unknown>;
  if (typeof root.corpusDigest !== "string" || root.corpusDigest === "") {
    throw new Error(
      `The paraphrase artifact at ${PARAPHRASE_ARTIFACT_PATH} has no \`corpusDigest\`, so it cannot ` +
        `be checked against the corpus it claims to describe. Re-record it with ` +
        `\`bun packages/cli/bin/brain-paraphrase-eval.ts --write\`.`,
    );
  }
  if (!root.pairs || typeof root.pairs !== "object" || Array.isArray(root.pairs)) {
    throw new Error(
      `The paraphrase artifact at ${PARAPHRASE_ARTIFACT_PATH} has no \`pairs\` object — it is ` +
        `truncated or was written by something other than the eval.`,
    );
  }
  return parsed as RecordedArtifact;
}

export function loadMessages(): MessageCorpus {
  const parsed = readJson(PARAPHRASE_MESSAGES_PATH, "message corpus");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`The paraphrase message corpus at ${PARAPHRASE_MESSAGES_PATH} is not a JSON object.`);
  }
  if (!Array.isArray((parsed as Record<string, unknown>).pairs)) {
    throw new Error(`The paraphrase message corpus at ${PARAPHRASE_MESSAGES_PATH} has no \`pairs\` array.`);
  }
  return parsed as MessageCorpus;
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
export function soleClaim(artifact: RecordedArtifact, pairId: string, side: Side): RecordedTriple {
  const sides = artifact.pairs[pairId];
  if (!sides) {
    throw new Error(
      `the paraphrase artifact has no pair "${pairId}". If the corpus was edited, re-record it.`,
    );
  }
  const claims = sides[side];
  // A missing side would otherwise reach `.length` and raise a bare
  // `Cannot read properties of undefined`, with no mention of the artifact — in
  // the one helper whose whole job is to fail informatively.
  if (!Array.isArray(claims)) {
    throw new Error(
      `paraphrase pair "${pairId}" has no side ${side} in the artifact — it is malformed, not merely stale.`,
    );
  }
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
    ...SIDES.map((side) => [p[side].source, p[side].body]),
  ]);
  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}
