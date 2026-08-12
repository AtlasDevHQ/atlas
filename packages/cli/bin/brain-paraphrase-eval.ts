/**
 * The paraphrase eval — the STOCHASTIC half of ADR-0037 §9's falsification loop
 * (#5041). It drives the REAL extractor over a human-authored message corpus and
 * records what the model actually emitted; that recording is the fixture the
 * deterministic brain suite consumes.
 *
 *   bun packages/cli/bin/brain-paraphrase-eval.ts           # grade against the artifact
 *   bun packages/cli/bin/brain-paraphrase-eval.ts --write    # regenerate it
 *   bun packages/cli/bin/brain-paraphrase-eval.ts --json      # machine payload on fd 1
 *
 * ## Why the lane is split at all
 *
 * The property *"does the identity layer collide these two phrasings"* is
 * deterministic and belongs in `bun run test`. The property *"does the extractor
 * actually produce two phrasings"* is a fact about a stochastic component and
 * cannot live there — a real model call inside the unit suite would make every
 * PR pay for one and make a green run depend on a provider being up.
 *
 * So the eval PRODUCES and the test CONSUMES, and the direction is what closes
 * the loop: nobody writes `is priced at` into a fixture, the extractor does or it
 * does not. A corpus hand-authored on the predicate side is the
 * agrees-by-construction trap that #5000 shipped through
 * ([[feedback_fixtures_that_agree_by_construction]] in the repo's terms), and it
 * passes green against an identity layer that does nothing.
 *
 * ## Why this is NOT a `canonical-eval` flag
 *
 * `--tool-selection` is the shape precedent and it rides `canonical-eval`
 * because it needs that command's MCP transport. This eval needs none of it —
 * no MCP, no semantic layer, no datasource. `handleCanonicalEval` REQUIRES
 * `ATLAS_DATASOURCE_URL` and stages the semantic layer by copying `semantic/`
 * to a backup directory and restoring it in a `finally`; hanging a mode off it
 * would make a paraphrase eval fail for want of a Postgres it never queries, and
 * would put a destructive directory swap on a path that has no use for one.
 *
 * ## fd 1 is the payload or nothing (#5126)
 *
 * The CI step pipes this through `tee`, so anything else on stdout produces an
 * artifact that does not parse — the defect that hid for the whole life of
 * `eval-mcp-llm`'s bundle. Two consequences, both unconditional here rather than
 * flag-scanned as `eval-log-destination.ts` has to be:
 *
 *   - `ATLAS_LOG_STDERR=1` is stamped at module top, BEFORE the dynamic import
 *     that first reaches `@atlas/api/lib/logger`. Static `import` declarations
 *     hoist above every statement, so the extractor is imported dynamically
 *     inside {@link runBrainParaphraseEval}; a top-level `import` of it would
 *     construct pino's module-scope `rootLogger` — and resolve its destination —
 *     before this file's first line ran.
 *   - The human transcript goes to fd 2 in EVERY mode, not just under `--json`.
 *     A conditional is one edit away from being wrong, and this process has no
 *     use for stdout other than the payload.
 */

// ⚠️ FIRST STATEMENT, AND THE DYNAMIC IMPORT BELOW IS WHAT MAKES IT REACHABLE IN
// TIME. See the header. Unconditional: an operator who wants pino on stdout
// wants a different program.
process.env.ATLAS_LOG_STDERR = "1";

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import type { LanguageModel } from "ai";

// A LEAF module — it imports `fs` and nothing else — which is what makes this
// edge safe above the stamp. Taking the writer from `canonical-eval-run.ts`,
// where it lived until #5041, would pull `./atlas` and `./canonical-eval` in
// behind it and construct the logger before the line above ran.
import { writeFdSync } from "./write-fd-sync";

// Type-only, so these edges carry no runtime graph and cannot reach the logger
// ahead of the stamp above.
import type { FactCandidate } from "@atlas/api/lib/brain/reconcile";
import type { PredicateCardinality } from "@atlas/api/lib/brain/types";

// ── Paths ─────────────────────────────────────────────────────────────

const EVAL_DIR = path.resolve(import.meta.dir, "..", "..", "..", "eval", "brain-paraphrase");
export const DEFAULT_CORPUS_PATH = path.join(EVAL_DIR, "messages.json");
export const DEFAULT_ARTIFACT_PATH = path.join(EVAL_DIR, "extracted.json");

/**
 * The gateway model this eval is recorded against, and the reason a bare default
 * is safe where `canonical-eval` needs one passed in: the artifact records the
 * model that produced it, so a run on a different model DRIFTS rather than
 * silently overwriting. Kept identical to `eval-llm.yml`'s `ATLAS_MODEL` — the
 * gateway spelling (`<provider>/<model>`), never Anthropic's dashed API id.
 */
export const DEFAULT_MODEL_ID = "anthropic/claude-haiku-4.5";

/**
 * The workspace id stamped on every synthetic episode. Nothing reads it — no
 * transaction opens and no row is written — but `ReconcileEpisodeRef` requires
 * one, and a recognisable constant beats a random uuid in a log line.
 */
const EVAL_WORKSPACE_ID = "ws-brain-paraphrase-eval";

// ── Corpus (the human half) ───────────────────────────────────────────

/**
 * What a human says two messages mean relative to each other. A statement about
 * English, which is the one oracle role a human holds in this loop.
 *
 * ⚠️ These are NOT `SlotRelation` (`identity-corpus.ts`) and must not be
 * conflated with it. That union describes two CLAIMS already extracted; this one
 * describes two MESSAGES, before anything has been extracted at all. The mapping
 * between them is a finding of this eval, not an input to it — `same-claim` here
 * asserts only that a reader would call the two sentences one fact, and says
 * nothing about whether the identity layer agrees. When it does not, that gap is
 * the artifact's whole content.
 */
export const PARAPHRASE_RELATIONS = [
  "same-claim",
  "contradiction",
  "inverse",
  "different-claim",
  "no-claim",
] as const;
export type ParaphraseRelation = (typeof PARAPHRASE_RELATIONS)[number];

export interface ParaphraseMessage {
  /** The connector class the episode would have arrived on. */
  readonly source: string;
  readonly body: string;
}

export interface ParaphrasePair {
  readonly id: string;
  readonly relation: ParaphraseRelation;
  /** Why a human says so. In English, because the claim is about English. */
  readonly why: string;
  readonly a: ParaphraseMessage;
  readonly b: ParaphraseMessage;
}

export interface MessageCorpus {
  readonly description?: string;
  readonly rubric?: Readonly<Record<string, string>>;
  readonly pairs: readonly ParaphrasePair[];
}

/** The two sides of a pair, spelled once so no loop can iterate one and forget the other. */
export const SIDES = ["a", "b"] as const;
export type Side = (typeof SIDES)[number];

/**
 * Load and validate the message corpus. Every failure names the file and the
 * offending entry: a contributor with a mangled corpus should not have to read a
 * bare `SyntaxError` from `JSON.parse` to find out which pair they broke.
 */
export function loadMessageCorpus(filePath: string): MessageCorpus {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Paraphrase message corpus not found at ${filePath}.`);
  }
  // ⚠️ THE READ AND THE PARSE GET SEPARATE HANDLERS. One `try` around both sent
  // a maintainer to look at JSON syntax for an EACCES or an EISDIR — the same
  // over-broad-catch finding that split the write-mode load, stopping one frame
  // short.
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to READ paraphrase corpus ${filePath}: ${msg}`, { cause: err });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse paraphrase corpus ${filePath}: ${msg}`, { cause: err });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Paraphrase corpus ${filePath} must be a JSON object with a \`pairs\` array.`);
  }
  const pairs = (parsed as Record<string, unknown>).pairs;
  if (!Array.isArray(pairs) || pairs.length === 0) {
    throw new Error(`Paraphrase corpus ${filePath} has no \`pairs\` — at least one is required.`);
  }
  const seen = new Set<string>();
  for (const [i, entry] of pairs.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Paraphrase corpus ${filePath} pair #${i} is not an object.`);
    }
    const p = entry as Record<string, unknown>;
    if (typeof p.id !== "string" || p.id.trim() === "") {
      throw new Error(`Paraphrase corpus ${filePath} pair #${i} is missing string \`id\`.`);
    }
    // Ids name the artifact's keys, so a duplicate would silently make one entry
    // overwrite the other and the corpus one pair smaller than it reads.
    if (seen.has(p.id)) {
      throw new Error(`Paraphrase corpus ${filePath} has two pairs with id "${p.id}".`);
    }
    seen.add(p.id);
    if (!(PARAPHRASE_RELATIONS as readonly string[]).includes(p.relation as string)) {
      throw new Error(
        `Paraphrase corpus ${filePath} pair "${p.id}" has relation ${JSON.stringify(p.relation)} — ` +
          `expected one of ${PARAPHRASE_RELATIONS.join(", ")}.`,
      );
    }
    if (typeof p.why !== "string" || p.why.trim() === "") {
      throw new Error(
        `Paraphrase corpus ${filePath} pair "${p.id}" is missing \`why\`. An entry whose ` +
          `argument is not written down cannot be reviewed, and this corpus is all argument.`,
      );
    }
    for (const side of SIDES) {
      const msg = p[side];
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
        throw new Error(`Paraphrase corpus ${filePath} pair "${p.id}" side ${side} is not an object.`);
      }
      const m = msg as Record<string, unknown>;
      if (typeof m.source !== "string" || m.source.trim() === "") {
        throw new Error(
          `Paraphrase corpus ${filePath} pair "${p.id}" side ${side} is missing string \`source\`.`,
        );
      }
      if (typeof m.body !== "string" || m.body.trim() === "") {
        throw new Error(
          `Paraphrase corpus ${filePath} pair "${p.id}" side ${side} is missing string \`body\`.`,
        );
      }
    }
  }
  // ⚠️ COMPOSITION, not just per-entry validity — the one thing the honesty
  // checks structurally cannot see. Those checks are relative to each pair's
  // human-declared `relation`, so a corpus whose entries are ALL `no-claim` is
  // honest by construction against a completely dead extractor: every side
  // records empty, every check passes, `--write` succeeds, and the deterministic
  // suite's every prohibition then passes against nothing. The reverse (no
  // `no-claim` entry at all) removes the control that distinguishes a
  // discriminating extractor from one that emits a triple for small talk.
  const typed = parsed as MessageCorpus;
  const claimBearing = typed.pairs.filter((p) => p.relation !== "no-claim").length;
  if (claimBearing === 0) {
    throw new Error(
      `Paraphrase corpus ${filePath} has no claim-bearing pair — every entry is \`no-claim\`, so a ` +
        `dead extractor would grade honest and the recording would exercise nothing.`,
    );
  }
  if (claimBearing === typed.pairs.length) {
    throw new Error(
      `Paraphrase corpus ${filePath} has no \`no-claim\` control — without one, an extractor that ` +
        `emits a triple for every message is indistinguishable from a discriminating one.`,
    );
  }
  return typed;
}

/**
 * A digest over what the extractor is actually SHOWN — every pair's id and both
 * message bodies and sources, in corpus order.
 *
 * ⚠️ Deliberately not a hash of the file. `why`, `description` and `rubric` are
 * prose for a reviewer and change often; the model never sees them, so a
 * comment edit that invalidated the artifact would teach everyone to regenerate
 * on autopilot, which is precisely the discipline `mcp-llm-baseline.json` never
 * had. What this DOES catch is the case that matters: a message body edited
 * without a re-run, leaving an artifact whose triples were produced from text
 * that is no longer in the tree. The deterministic suite checks this digest and
 * so needs no model call to know its fixture is stale.
 */
export function corpusDigest(corpus: MessageCorpus): string {
  const material = corpus.pairs.map((p) => [
    p.id,
    ...SIDES.map((side) => [p[side].source, p[side].body]),
  ]);
  return crypto.createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

// ── Artifact (the machine half) ───────────────────────────────────────

/**
 * One claim as the extractor emitted it. A structural subset of `FactCandidate`
 * — `detail.model` and `validFrom` are deliberately dropped: the model id is
 * recorded once for the whole run, and a per-claim copy of it would put the same
 * fact in N places and diff on every regeneration.
 */
export interface RecordedTriple {
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  /**
   * What the extractor GUESSED about cardinality — recorded because #5027 made
   * it advisory and worth observing, and read by nothing. It is not part of the
   * identity comparison and never gates a `valid_to` stamp.
   *
   * The producer's union, not `string`: this side MINTS the value from a
   * `FactCandidate` and knows it is one of two members. The consuming twin in
   * `paraphrase-corpus.ts` widens it to `string | null` deliberately — that end
   * reads untrusted JSON off disk and has no business asserting a union the file
   * could contradict.
   */
  readonly cardinalityHint: PredicateCardinality | null;
}

export type RecordedSides = Readonly<Record<Side, readonly RecordedTriple[]>>;

export interface RecordedArtifact {
  readonly description: string;
  /** The gateway model id that produced every triple below. */
  readonly model: string;
  /** `BRAIN_EXTRACTION_PRODUCER` — which extractor version spoke. */
  readonly extractor: string;
  readonly recordedAt: string;
  /** {@link corpusDigest} of the corpus this was recorded from. */
  readonly corpusDigest: string;
  readonly pairs: Readonly<Record<string, RecordedSides>>;
}

const ARTIFACT_DESCRIPTION =
  "RECORDED OUTPUT — every triple below was emitted by the real extractor over " +
  "eval/brain-paraphrase/messages.json, never typed by a human. Regenerate with " +
  "`bun packages/cli/bin/brain-paraphrase-eval.ts --write` and commit the result as a " +
  "REVIEWED change: a regenerated fixture can make a passing test pass for a new reason, " +
  "and review is the only thing in between (ADR-0037 §9). Consumed by " +
  "packages/api/src/lib/brain/__tests__/paraphrase-identity.test.ts.";

export function loadArtifact(filePath: string): RecordedArtifact {
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Paraphrase artifact not found at ${filePath}. Record one with ` +
        `\`bun packages/cli/bin/brain-paraphrase-eval.ts --write\` (needs AI_GATEWAY_API_KEY).`,
    );
  }
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to READ paraphrase artifact ${filePath}: ${msg}`, { cause: err });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse paraphrase artifact ${filePath}: ${msg}`, { cause: err });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Paraphrase artifact ${filePath} must be a JSON object.`);
  }
  const root = parsed as Record<string, unknown>;
  if (typeof root.corpusDigest !== "string" || root.corpusDigest === "") {
    throw new Error(
      `Paraphrase artifact ${filePath} has no \`corpusDigest\` — it cannot be checked against ` +
        `the corpus it claims to describe. Regenerate it.`,
    );
  }
  if (!root.pairs || typeof root.pairs !== "object" || Array.isArray(root.pairs)) {
    throw new Error(`Paraphrase artifact ${filePath} has no \`pairs\` object.`);
  }
  return parsed as RecordedArtifact;
}

/**
 * Serialize an artifact deterministically: pairs in CORPUS order, two-space
 * indent, trailing newline. Key order in `JSON.stringify` follows insertion
 * order, so building the object in corpus order is what keeps a regeneration
 * that changed one triple from re-ordering the whole file and burying it.
 */
export function serializeArtifact(artifact: RecordedArtifact): string {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

// ── Grading (pure) ────────────────────────────────────────────────────

export type PairStatus = "match" | "drift" | "unrecorded" | "honesty";

export interface PairOutcome {
  readonly id: string;
  readonly relation: ParaphraseRelation;
  readonly status: PairStatus;
  /** Human-readable diagnosis; empty for `match`. */
  readonly detail: string;
  readonly fresh: RecordedSides;
  /** What the artifact held, or `null` when it held nothing for this pair. */
  readonly recorded: RecordedSides | null;
}

export interface ParaphraseResult {
  readonly outcomes: readonly PairOutcome[];
  /** Pair ids the artifact carries that the corpus no longer has. */
  readonly staleArtifactPairs: readonly string[];
  /** `null` when the digests agree; the two values when they do not. */
  readonly digestMismatch: { readonly corpus: string; readonly artifact: string } | null;
  readonly passed: boolean;
}

/**
 * Equality over the three SLOTS — subject, predicate, object — in emission
 * order. It deliberately ignores `cardinalityHint`, which is advisory since
 * #5027 and must never be able to fail a release gate.
 *
 * ⚠️ Named `…BySlot` rather than `triplesEqual` because it is EXPORTED: a second
 * caller reading the bare name would reasonably assume full structural equality
 * of `RecordedTriple`s and be silently wrong about the hint. The name is the
 * only thing standing between that reader and a wrong assumption.
 *
 * Exported for the unit surface, and the reason is narrower than an earlier
 * draft claimed. The honesty checks bound the FRESH sides to at most one claim,
 * so the ORDER arm is genuinely unreachable through `gradeParaphraseRun` and can
 * only be falsified by calling this directly.
 *
 * ⚠️ The LENGTH arm is NOT unreachable, and saying it was would have invited
 * deleting a live guard: the checks constrain the fresh sides only, and the
 * RECORDED side is whatever the artifact holds. A stale or hand-edited
 * recording carrying two claims against an honest one-claim run reaches the
 * length arm and grades `drift` through it — measured, not reasoned. Delete the
 * length check and that pair grades `match`.
 */
export function triplesEqualBySlot(a: readonly RecordedTriple[], b: readonly RecordedTriple[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((t, i) => {
    const o = b[i];
    return (
      o !== undefined &&
      t.subject === o.subject &&
      t.predicate === o.predicate &&
      t.object === o.object
    );
  });
}

function formatTriples(triples: readonly RecordedTriple[]): string {
  if (triples.length === 0) return "(none)";
  return triples.map((t) => `${t.subject} | ${t.predicate} | ${t.object}`).join(" ;; ");
}

/**
 * Does this claim carry a slot the identity layer cannot key?
 *
 * ⚠️ THE SEPARATOR-CLASS STRIP, NOT `.trim()`. `lexicalNorm` treats `-` and `_`
 * as separators and trims the edges, so `"   "`, `"-"` and `"__"` all normalize
 * to the empty string and `identityKey` answers `null` for each — a claim that
 * asserts nothing. A whitespace-only check (`.trim() === ""`) catches the first
 * and passes the other two, which is a guard that stops discriminating exactly
 * where a degenerate model output is most likely to land. An earlier draft of
 * this headline named `.trim()` as the implementation, which is the one the rest
 * of this paragraph argues against.
 *
 * ⚠️ `\s` is WIDER than `lexicalNorm`'s deliberately spelled-out
 * `[ \t\n\v\f\r_-]` — it also covers U+00A0 and the U+2000 block, which
 * `identityKey` keys happily. So this refuses slightly MORE than the identity
 * layer would. That is the safe direction, and it is a real disagreement rather
 * than an intended equivalence; `paraphrase-corpus.ts` holds the property itself
 * (`identityKey(surface) !== null`) on the consuming side.
 */
function hasBlankSlot(triple: RecordedTriple): boolean {
  return [triple.subject, triple.predicate, triple.object].some(
    (surface) => surface.replace(/[\s_-]+/g, "") === "",
  );
}

/**
 * Compare one honest pair against the artifact. Split out of the loop so the
 * `no-claim` arm reaches it too: an honest `no-claim` pair still has a recording
 * (two empty arrays) that can go stale or drift, and folding it into the
 * fall-through left it graded by a path its `continue` had already skipped.
 */
function comparedOutcome(
  pair: ParaphrasePair,
  freshSides: RecordedSides,
  artifact: RecordedArtifact | null,
): PairOutcome {
  const recorded = artifact?.pairs[pair.id] ?? null;
  if (!recorded) {
    return {
      id: pair.id,
      relation: pair.relation,
      status: "unrecorded",
      detail: "the artifact carries no recording for this pair — regenerate with --write.",
      fresh: freshSides,
      recorded: null,
    };
  }
  const drifted = SIDES.filter((s) => !triplesEqualBySlot(freshSides[s], recorded[s] ?? []));
  if (drifted.length > 0) {
    return {
      id: pair.id,
      relation: pair.relation,
      status: "drift",
      detail: drifted
        .map(
          (s) =>
            `side ${s}: recorded ${formatTriples(recorded[s] ?? [])} — now ${formatTriples(freshSides[s])}`,
        )
        .join(" | "),
      fresh: freshSides,
      recorded,
    };
  }
  return { id: pair.id, relation: pair.relation, status: "match", detail: "", fresh: freshSides, recorded };
}

/**
 * Grade a fresh run against the committed artifact. PURE — exposed so the unit
 * surface can pin every verdict without spending a model call, which is the same
 * split `gradeToolSelection` makes and for the same reason.
 *
 * Three independent ways to fail, and they are kept apart because they have
 * different fixes:
 *
 *   - **drift** — the model no longer says what the artifact recorded. Fix:
 *     regenerate as a reviewed commit, having read what moved.
 *   - **unrecorded** — the corpus grew a pair the artifact does not carry, or
 *     the artifact carries one the corpus dropped. Fix: regenerate.
 *   - **honesty** — the run is internally consistent and the CORPUS has stopped
 *     doing its job. Regenerating does not fix this one, and that is why it is
 *     checked in `--write` mode too: an extractor returning nothing satisfies
 *     every prohibition in the deterministic suite while proving nothing, and
 *     writing that recording down would bless it.
 */
export function gradeParaphraseRun(
  corpus: MessageCorpus,
  fresh: Readonly<Record<string, RecordedSides>>,
  artifact: RecordedArtifact | null,
): ParaphraseResult {
  const outcomes: PairOutcome[] = [];

  for (const pair of corpus.pairs) {
    const freshSides = fresh[pair.id];
    // Every corpus pair is run before grading, so an absent entry is a harness
    // fault rather than a verdict — it must not be reported as drift, which
    // would send a maintainer to regenerate an artifact that is fine.
    if (!freshSides) {
      throw new Error(
        `harness fault: pair "${pair.id}" is in the corpus but was not extracted this run.`,
      );
    }

    // ── Honesty, BEFORE the artifact comparison ──
    // Checking it first is what stops a recorded-dead corpus from reading green
    // forever: if the artifact agreed with a useless recording, a comparison-led
    // order would report `match` and nobody would look again.
    //
    // ⚠️ THREE CHECKS, NOT ONE, AND THE ARITY AND CONTENT ARMS WERE MISSING
    // UNTIL REVIEW. The first cut asked only *how many* claims a side carried,
    // never *what* they were or whether the consumer could read them — so two
    // recordings that exercise nothing graded honest and were written:
    //
    //   - BLANK SURFACES. `ExtractionSchema` uses bare `z.string()` with no
    //     `.min(1)`, so `{subject:"", predicate:"   ", object:""}` is valid model
    //     output and counts as a claim. `identityKey` returns `null` for every
    //     one of them, so every prohibition downstream passes vacuously — the
    //     exact state this lane exists to refuse, arriving through the lane.
    //   - MORE THAN ONE CLAIM A SIDE. `soleClaim` in the consuming suite throws
    //     on anything but exactly one, deliberately. The producer accepting `>= 1`
    //     meant a regeneration could report PASS, write, and break the api suite
    //     in another package — the diagnosis landing one CI lane later than the
    //     command that caused it. The two ends may not hold different contracts.
    //
    // Every arm only ever REFUSES more than the old code did, so this edit
    // cannot regress in the permitting direction by construction.
    const emptySides = SIDES.filter((s) => freshSides[s].length === 0);
    const dishonest = (detail: string): void => {
      outcomes.push({
        id: pair.id,
        relation: pair.relation,
        status: "honesty",
        detail,
        fresh: freshSides,
        recorded: artifact?.pairs[pair.id] ?? null,
      });
    };

    if (pair.relation === "no-claim") {
      if (emptySides.length !== SIDES.length) {
        const spoke = SIDES.filter((s) => freshSides[s].length > 0);
        dishonest(
          `a \`no-claim\` pair produced claims on side(s) ${spoke.join(", ")}: ` +
            spoke.map((s) => `${s}=${formatTriples(freshSides[s])}`).join(" / ") +
            ". Either the message stopped being small talk, or the extractor has stopped discriminating.",
        );
        continue;
      }
      outcomes.push(comparedOutcome(pair, freshSides, artifact));
      continue;
    }

    if (emptySides.length > 0) {
      dishonest(
        `the extractor produced NO claim on side(s) ${emptySides.join(", ")}, so this pair ` +
          `exercises nothing — a prohibition with an empty side passes against an identity ` +
          `layer that does nothing.`,
      );
      continue;
    }

    const plural = SIDES.filter((s) => freshSides[s].length > 1);
    if (plural.length > 0) {
      dishonest(
        `side(s) ${plural.map((s) => `${s}=${freshSides[s].length}`).join(", ")} carry more than one ` +
          `claim. The deterministic suite reads exactly one per side (\`soleClaim\`) and throws ` +
          `otherwise, so recording this would report PASS here and fail there.`,
      );
      continue;
    }

    const blank = SIDES.filter((s) => freshSides[s].some(hasBlankSlot));
    if (blank.length > 0) {
      dishonest(
        `side(s) ${blank.join(", ")} carry a claim with an empty slot: ` +
          blank.map((s) => `${s}=${formatTriples(freshSides[s])}`).join(" / ") +
          `. A blank surface keys to null, so every prohibition downstream would pass without ` +
          `the identity layer doing anything.`,
      );
      continue;
    }

    outcomes.push(comparedOutcome(pair, freshSides, artifact));
  }

  const corpusIds = new Set(corpus.pairs.map((p) => p.id));
  const staleArtifactPairs = artifact
    ? Object.keys(artifact.pairs).filter((id) => !corpusIds.has(id))
    : [];

  const freshDigest = corpusDigest(corpus);
  const digestMismatch =
    artifact && artifact.corpusDigest !== freshDigest
      ? { corpus: freshDigest, artifact: artifact.corpusDigest }
      : null;

  const passed =
    outcomes.every((o) => o.status === "match") &&
    staleArtifactPairs.length === 0 &&
    digestMismatch === null;

  return { outcomes, staleArtifactPairs, digestMismatch, passed };
}

// ── Driver ────────────────────────────────────────────────────────────

export interface ParaphraseRunOptions {
  readonly corpusPath: string;
  readonly artifactPath: string;
  /** Injected by the test surface; production resolves it from the environment. */
  readonly extract?: ExtractOneMessage;
  readonly write: boolean;
  readonly json: boolean;
}

/** The one seam the test surface replaces — a single message in, the triples the extractor emitted out. */
export type ExtractOneMessage = (input: {
  readonly pairId: string;
  readonly side: Side;
  readonly message: ParaphraseMessage;
}) => Promise<readonly RecordedTriple[]>;

/**
 * Everything a run needs to say about itself, once graded.
 *
 * ⚠️ **`passed` here is NOT `ParaphraseResult.passed`, and the override is the
 * one thing to read carefully.** The base computes it from the artifact
 * comparison; in `--write` mode that comparison is against the artifact being
 * REPLACED, so a first-ever recording legitimately grades every pair
 * `unrecorded` and the run still succeeded. The write-mode verdict is therefore
 * the honesty checks alone. Both values travel — {@link write} says which
 * predicate produced this one, and the inherited `outcomes` /
 * `staleArtifactPairs` / `digestMismatch` still describe the comparison — so a
 * future gate reading `passed` can tell the two modes apart instead of
 * inheriting a number whose meaning it cannot see. Both verdicts travel:
 * `passed` is the mode's, and {@link comparisonPassed} is the artifact
 * comparison's. (They did not always — an earlier draft claimed this while the
 * override simply replaced the inherited field, leaving the comparison verdict
 * reconstructible only by re-deriving it from `outcomes`.)
 */
export interface ParaphraseRunReport extends ParaphraseResult {
  readonly model: string;
  readonly extractor: string;
  readonly corpusPath: string;
  readonly artifactPath: string;
  /** Which mode produced {@link passed} — see the warning above. */
  readonly write: boolean;
  /**
   * The ARTIFACT-COMPARISON verdict, in both modes — what `ParaphraseResult`
   * computes before {@link passed} overrides it. In grade mode the two agree; in
   * write mode this is the answer about the artifact being replaced, which is
   * the number a reviewer of a regeneration wants and the only one `passed`
   * cannot express.
   */
  readonly comparisonPassed: boolean;
  readonly wrote: boolean;
  /** How many pairs failed the corpus-honesty checks. The write-mode verdict. */
  readonly dishonestCount: number;
  /**
   * Set when `--write` found an EXISTING artifact it could not read and replaced
   * it anyway.
   *
   * On the report rather than only in the transcript because the whole design
   * rests on a regeneration being a REVIEWED change: the reviewer of that diff
   * is entitled to know the prior recording was DISCARDED rather than
   * superseded, and an fd-2 line does not survive an automated run.
   */
  readonly priorArtifactError: string | null;
}

/**
 * fd 2, always — see the header.
 *
 * Through {@link writeFdSync} rather than a bare `fs.writeSync`, for the three
 * reasons that helper's own docstring measured: a single `writeSync` to a pipe
 * can return SHORT (silently truncating), `EPIPE` from a hung-up reader must not
 * become exit 1, and `EAGAIN` on a non-blocking fd needs a retry rather than a
 * lost line. fd 2 has the same 65_536-byte cliff as fd 1, and the transcript
 * here is unbounded in principle — it interpolates every recorded surface.
 */
function human(text: string): void {
  writeFdSync(2, text);
}

/**
 * Build the real extractor seam: the production `llmFactExtractor` over a
 * gateway-resolved model.
 *
 * ⚠️ It goes through `getModelForConfig`, the same builder the agent loop uses,
 * rather than calling `gateway(modelId)` directly. The eval's whole claim is
 * that the REAL extraction path produces these surfaces; a second, private
 * client would exercise a credential path production does not use and could
 * drift from it silently.
 */
async function realExtractor(): Promise<{
  extract: ExtractOneMessage;
  modelId: string;
  extractor: string;
}> {
  // Dynamic, so the `ATLAS_LOG_STDERR` stamp at the top of this file lands
  // before pino's module-scope logger is constructed. See the header.
  const { llmFactExtractor, BRAIN_EXTRACTION_PRODUCER } = await import(
    "@atlas/api/lib/brain/extract"
  );
  const { getModelForConfig } = await import("@atlas/api/lib/providers");

  // No override parameter: the sole call site passed `null` and there is no
  // `--model` flag, so the branch was dead and therefore untested. The model is
  // the environment's to choose — `eval-brain-paraphrase.yml` (the workflow that
  // runs THIS program; `eval-llm.yml` runs the MCP eval) sets it beside its own
  // preflight's, so the credential check validates the model the eval runs.
  const requested = process.env.ATLAS_MODEL ?? DEFAULT_MODEL_ID;
  let model: LanguageModel;
  let modelId: string;
  try {
    const resolved = getModelForConfig(process.env.ATLAS_PROVIDER ?? "gateway", requested);
    model = resolved.model;
    modelId = resolved.modelId;
  } catch (err) {
    // Re-thrown with the eval's own context. `buildModel` already names the
    // missing variable; what it cannot know is which command needed it, and a
    // bare "AI_GATEWAY_API_KEY is not set" in a CI log is one grep away from
    // being blamed on the sibling eval that shares the secret.
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`brain-paraphrase-eval could not resolve a model: ${msg}`, { cause: err });
  }

  const extract: ExtractOneMessage = async ({ pairId, side, message }) => {
    const candidates = await llmFactExtractor({
      episode: {
        id: `${pairId}:${side}`,
        workspaceId: EVAL_WORKSPACE_ID,
        source: message.source,
        sourceId: `${pairId}:${side}`,
        sourceActor: null,
        // ⚠️ NULL ON PURPOSE, and it is a determinism property rather than a
        // convenience. `llmFactExtractor` puts `Said at: <ISO timestamp>` in
        // the prompt when this is set, so a wall-clock value would change the
        // prompt on every run — and this eval's entire verdict is whether the
        // output moved. A drift caused by the harness would be indistinguishable
        // from a drift in the model.
        occurredAt: null,
        visibleTo: ["org"],
      },
      body: message.body,
      model,
      modelId,
    });
    return candidates.map(toRecordedTriple);
  };

  return { extract, modelId, extractor: BRAIN_EXTRACTION_PRODUCER };
}

/**
 * Narrow a `FactCandidate` to the recorded shape.
 *
 * `predicateCardinality` is OPTIONAL on the candidate (`PredicateCardinality |
 * undefined`), so the `??` is an absent-value guard and nothing more. Spelled
 * that way rather than `typeof hint === "string"`, which an earlier draft used
 * and whose comment justified it as defending against an open `detail` record —
 * a field this function does not read. The guard was harmless and its stated
 * reason was false, which is the comment class this repo has been bitten by
 * repeatedly; `?? null` says what is actually true.
 */
export function toRecordedTriple(candidate: FactCandidate): RecordedTriple {
  return {
    subject: candidate.subject,
    predicate: candidate.predicate,
    object: candidate.object,
    cardinalityHint: candidate.predicateCardinality ?? null,
  };
}

/**
 * Run the corpus through the extractor and grade it.
 *
 * Sequential rather than `Promise.all`: one call per SIDE of every corpus pair
 * against a rate-limited gateway, the wall clock is irrelevant to a weekly cron,
 * and a serial run gives a progress line per message that names the pair a
 * failure came from. (Derived rather than counted — an earlier draft said "nine
 * pairs" and the corpus had ten.)
 */
export async function runBrainParaphraseEval(
  opts: ParaphraseRunOptions,
): Promise<ParaphraseRunReport> {
  const corpus = loadMessageCorpus(opts.corpusPath);

  const seam = opts.extract
    ? { extract: opts.extract, modelId: "(injected)", extractor: "(injected)" }
    : await realExtractor();

  const fresh: Record<string, RecordedSides> = {};
  for (const pair of corpus.pairs) {
    const sides: Partial<Record<Side, readonly RecordedTriple[]>> = {};
    for (const side of SIDES) {
      human(`  ${pair.id}.${side} ... `);
      sides[side] = await seam.extract({ pairId: pair.id, side, message: pair[side] });
      human(`${sides[side]?.length ?? 0} claim(s)\n`);
    }
    fresh[pair.id] = { a: sides.a ?? [], b: sides.b ?? [] };
  }

  // In `--write` mode a MISSING artifact is the expected state — that is the
  // mode that creates one. An artifact that EXISTS and cannot be read is a
  // different fact, and the first cut conflated them: one `catch` covered
  // not-found, a truncated file, `EACCES`, `EISDIR`, and a missing
  // `corpusDigest` alike, and all five printed "no usable existing artifact"
  // before silently discarding the committed bytes. Split, so the transcript
  // says which happened and the report carries the destructive case.
  let artifact: RecordedArtifact | null = null;
  let priorArtifactError: string | null = null;
  if (opts.write) {
    if (fs.existsSync(opts.artifactPath)) {
      try {
        artifact = loadArtifact(opts.artifactPath);
      } catch (err) {
        // Reported and carried, never swallowed: replacing an unreadable
        // artifact is the right move, and both the maintainer watching and the
        // reviewer of the resulting diff are entitled to know it happened.
        priorArtifactError = err instanceof Error ? err.message : String(err);
        human(`  ⚠️ the existing artifact is unusable and will be REPLACED: ${priorArtifactError}\n`);
      }
    } else {
      human(`  (no artifact at ${opts.artifactPath} yet — recording a first one)\n`);
    }
  } else {
    artifact = loadArtifact(opts.artifactPath);
  }

  const graded = gradeParaphraseRun(corpus, fresh, artifact);

  // ⚠️ HONESTY VIOLATIONS BLOCK THE WRITE. Drift does not — resolving drift is
  // exactly what `--write` is for. But a corpus that has stopped exercising
  // anything must not be recorded: the artifact would then bless an empty
  // fixture, and every prohibition downstream would pass against an identity
  // layer that does nothing. That is the failure this whole lane exists to make
  // impossible, and it would arrive through the tool built to prevent it.
  const dishonest = graded.outcomes.filter((o) => o.status === "honesty");
  let wrote = false;
  if (opts.write && dishonest.length === 0) {
    const pairs: Record<string, RecordedSides> = {};
    for (const pair of corpus.pairs) pairs[pair.id] = fresh[pair.id] ?? { a: [], b: [] };
    fs.writeFileSync(
      opts.artifactPath,
      serializeArtifact({
        description: ARTIFACT_DESCRIPTION,
        model: seam.modelId,
        extractor: seam.extractor,
        recordedAt: new Date().toISOString(),
        corpusDigest: corpusDigest(corpus),
        pairs,
      }),
    );
    wrote = true;
  }

  return {
    ...graded,
    // A write makes the artifact match by construction, so the graded verdict
    // (computed against the PREVIOUS artifact) is not the run's verdict in that
    // mode — the honesty checks are. Reported separately rather than folded in,
    // so `--json` carries what actually drifted even on a successful write.
    passed: opts.write ? dishonest.length === 0 : graded.passed,
    model: seam.modelId,
    extractor: seam.extractor,
    corpusPath: opts.corpusPath,
    artifactPath: opts.artifactPath,
    write: opts.write,
    comparisonPassed: graded.passed,
    wrote,
    dishonestCount: dishonest.length,
    priorArtifactError,
  };
}

// ── CLI ───────────────────────────────────────────────────────────────

/** Flags that take a following value, so the unknown-flag scan can skip it. */
const VALUE_FLAGS = ["--corpus", "--artifact"] as const;
const BARE_FLAGS = ["--write", "--json"] as const;

export function parseParaphraseArgs(args: readonly string[]): ParaphraseRunOptions {
  const flagValue = (name: string): string | null => {
    const i = args.indexOf(name);
    if (i === -1) return null;
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${name} requires a path argument.`);
    }
    return value;
  };

  // ⚠️ AN UNRECOGNIZED FLAG IS AN ERROR, because every way of ignoring one here
  // is silently the OPPOSITE of what was asked. `--writ` grades instead of
  // writing and then advises the operator to run the command they just ran;
  // `--jsn` produces no payload at all, which in CI is caught only by the
  // artifact step's "exited 0 but wrote no payload" arm — one lane late, and
  // never at all locally.
  // ⚠️ EVERY UNCONSUMED TOKEN, not only `--`-prefixed ones. The first cut
  // scanned `--xxx` alone, which left `-w`, `-write` and a bare `write` as
  // silent no-ops that GRADE — and `-w` is the likelier typo of the two. That is
  // this guard's own argument, unclosed on the tokens it skipped: the class is
  // "an argument we ignore produces the opposite of what was asked", and a
  // leading-dash test does not describe it.
  const known = new Set<string>([...VALUE_FLAGS, ...BARE_FLAGS]);
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!known.has(arg)) {
      throw new Error(
        `Unrecognized argument "${arg}". Known flags: ${[...VALUE_FLAGS, ...BARE_FLAGS].join(", ")}.`,
      );
    }
    // A repeat would be resolved by `indexOf` taking the FIRST occurrence, so
    // `--corpus a --corpus b` silently grades `a` while the operator reads `b`
    // off their own command line — the same "graded something other than what
    // was asked for" failure the scan above exists to prevent.
    if (seen.has(arg)) throw new Error(`${arg} was given more than once.`);
    seen.add(arg);
    // Skip a value flag's argument so a path is not itself scanned as a token.
    if ((VALUE_FLAGS as readonly string[]).includes(arg)) i += 1;
  }

  return {
    corpusPath: flagValue("--corpus") ?? DEFAULT_CORPUS_PATH,
    artifactPath: flagValue("--artifact") ?? DEFAULT_ARTIFACT_PATH,
    write: args.includes("--write"),
    json: args.includes("--json"),
  };
}

/**
 * The human summary, on fd 2. Returns the process exit code.
 *
 * `write` is injectable so the TRANSCRIPT is testable and not merely the return
 * value. Round 2 measured six mutations here — the refusal message never
 * printed, the PASS/FAIL word pinned to one value, the per-outcome detail
 * dropped — and every one survived, because the only tests built a report with
 * `outcomes: []` and never executed the loop. Under `--json` this transcript is
 * the operator's ONLY human record.
 */
export function reportParaphraseRun(
  report: ParaphraseRunReport,
  write: (text: string) => void = human,
): number {
  const counts = new Map<PairStatus, number>();
  for (const o of report.outcomes) counts.set(o.status, (counts.get(o.status) ?? 0) + 1);

  write(`\nbrain paraphrase eval — model=${report.model} extractor=${report.extractor}\n`);
  for (const o of report.outcomes) {
    // ⚠️ IN WRITE MODE, ONLY AN HONESTY FAILURE IS A FAILURE. `drift` and
    // `unrecorded` are what `--write` exists to resolve, so printing them as
    // FAIL made a first-ever recording report ten FAIL lines and then PASS —
    // a transcript that contradicts itself teaches people to stop reading it.
    const failed = report.write ? o.status === "honesty" : o.status !== "match";
    const label = failed ? "FAIL" : report.write && o.status !== "match" ? "rec " : "ok  ";
    write(`  ${label} ${o.id} (${o.relation})`);
    // The detail is printed in BOTH modes. Suppressing it in write mode silenced
    // the drift diagnosis in the one mode whose whole job is to resolve drift —
    // while the module header, the artifact description and the workflow all
    // tell the operator to read what moved BEFORE regenerating.
    write(o.detail === "" ? "\n" : `\n       ${o.detail}\n`);
  }
  // ⚠️ BOTH LOOPS ARE MODE-GATED, and the first cut of the write-mode fix gated
  // only the per-outcome loop above. These two are computed against the artifact
  // being REPLACED, so in write mode they are known-stale by construction — and
  // printing `Re-run with --write` inside a `--write` run is the same looping
  // remedy the refusal message below was fixed for, on the two lines beneath it.
  if (report.digestMismatch) {
    write(
      report.write
        ? `  rec  corpus digest refreshed — the previous recording was made from different message bodies.\n`
        : `  FAIL corpus digest — the artifact was recorded from different message bodies ` +
            `(artifact ${report.digestMismatch.artifact.slice(0, 12)}, corpus ${report.digestMismatch.corpus.slice(0, 12)}). ` +
            `Re-run with --write.\n`,
    );
  }
  for (const id of report.staleArtifactPairs) {
    write(
      report.write
        ? `  rec  dropped stale artifact entry "${id}" — no such pair in the corpus.\n`
        : `  FAIL stale artifact entry "${id}" — no such pair in the corpus. Re-run with --write.\n`,
    );
  }
  if (report.wrote) write(`\nwrote ${report.artifactPath}\n`);

  if (report.write) {
    // ⚠️ THE REFUSAL HAS TO BE NAMED. The first cut printed nothing for it: the
    // only sign the file had not been written was the ABSENCE of the line above,
    // and the tail below then advised the operator to re-run `--write` — the
    // command they had just run, which cannot succeed until the corpus is fixed.
    // A remedy that loops is worse than none, because the next move after
    // exhausting it is to hand-edit `extracted.json`, which is precisely what
    // this refusal exists to prevent.
    if (report.wrote) {
      if (report.priorArtifactError !== null) {
        // The destructive fact, in the summary rather than only in a line the
        // operator scrolled past — the reviewer of the resulting diff is the
        // audience, and this is what tells them the prior recording was
        // DISCARDED rather than superseded.
        write(
          `\n⚠️ the prior recording was DISCARDED, not superseded: ${report.priorArtifactError}\n`,
        );
      }
      write(`\nPASS: recorded ${report.outcomes.length} pairs.\n`);
    } else if (report.dishonestCount === 0) {
      // ⚠️ Wrote nothing and gave no reason. Unreachable through
      // `runBrainParaphraseEval` today, but the exit code below used to key on
      // `passed` alone — which is derived from `dishonestCount` — so this state
      // printed "REFUSED … 0 pair(s) failed" and exited 0: a diagnosis
      // contradicted by its own number, and the exact mutation class this
      // lane's commit message headlines, reproduced in the sibling function.
      write(
        `\nFAIL: wrote nothing and no pair failed the honesty checks — this is a harness fault, not a corpus one.\n`,
      );
    } else {
      write(
        `\nFAIL: REFUSED to write ${report.artifactPath} — ${report.dishonestCount} pair(s) failed the\n` +
          "corpus-honesty checks above. Regenerating does NOT fix this, which is why it was\n" +
          "refused: recording a corpus that exercises nothing would bless an empty fixture, and\n" +
          "every prohibition in the deterministic suite would then pass forever against an\n" +
          "identity layer doing nothing. Fix the extractor or the corpus first (ADR-0037 §9).\n",
      );
    }
    // Keys on `wrote` as well as `passed`: a write mode that exited 0 having
    // written nothing is the failure this branch exists to make impossible.
    return report.wrote && report.passed ? 0 : 1;
  }

  const matched = counts.get("match") ?? 0;
  write(
    `\n${report.passed ? "PASS" : "FAIL"}: ${matched}/${report.outcomes.length} pairs match the recorded artifact.\n`,
  );
  if (!report.passed) {
    write(
      "\nThis eval fails on DRIFT by design: the deterministic brain suite consumes this\n" +
        "artifact, so a change here is a change to what that suite proves. Read what moved,\n" +
        "then regenerate with --write and commit it as a reviewed change (ADR-0037 §9).\n",
    );
  }
  return report.passed ? 0 : 1;
}

/**
 * Parse, run, report, emit. Exported and parameterised so the composition is
 * testable — which round 2 found it was not.
 *
 * ⚠️ `reportParaphraseRun` returning the right number and `main` handing that
 * number to `process.exit` are TWO facts, and only the first had a test. A
 * `return 0` here made a fully drifted, tag-blocking run exit 0 with the suite
 * green — the same sentence this lane's commit message opens with, one frame up
 * the stack. Closing the reported instances and leaving the composition unheld
 * is how a class survives a fix.
 */
export async function main(
  argv: readonly string[],
  seam?: ExtractOneMessage,
  write: (text: string) => void = human,
): Promise<number> {
  const opts = parseParaphraseArgs(argv);
  const report = await runBrainParaphraseEval(seam ? { ...opts, extract: seam } : opts);
  const code = reportParaphraseRun(report, write);
  if (opts.json) {
    // The ONLY write to fd 1 in this process, and it goes through the package's
    // one sanctioned writer. `process.stdout` is buffered and the `process.exit`
    // below would discard whatever is still in it; a bare `fs.writeSync` fixes
    // that and reintroduces three others — a SHORT write silently truncating the
    // payload (which the workflow's `jq empty` step would then misdiagnose as
    // stdout pollution), `EPIPE` from `… | head` becoming exit 1, and `EAGAIN`
    // on a non-blocking fd losing the tail. `writeFdSync` is the loop that
    // handles all three, and `eval-json-stdout.test.ts` greps this file for the
    // spellings that bypass it.
    writeFdSync(1, `${JSON.stringify(report, null, 2)}\n`);
  }
  return code;
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      human(`\nError: ${err instanceof Error ? err.message : String(err)}\n`);
      if (err instanceof Error && err.stack) human(`${err.stack}\n`);
      process.exit(1);
    });
}
