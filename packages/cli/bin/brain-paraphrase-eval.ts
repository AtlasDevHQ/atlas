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

// Type-only, so this edge carries no runtime graph and cannot reach the logger
// ahead of the stamp above.
import type { FactCandidate } from "@atlas/api/lib/brain/reconcile";

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
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
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
  return parsed as MessageCorpus;
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
   */
  readonly cardinalityHint: string | null;
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
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

/** Deep equality over the compared fields, in emission order. Order is signal: it is what the model chose to say first. */
function triplesEqual(a: readonly RecordedTriple[], b: readonly RecordedTriple[]): boolean {
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
    // A `no-claim` pair that produced a triple, or any other pair that produced
    // none, means the corpus has stopped exercising what it claims to — and that
    // is true whether or not the artifact happens to agree. Checking it first is
    // what stops a recorded-empty artifact from making a dead corpus read green
    // forever.
    const emptySides = SIDES.filter((s) => freshSides[s].length === 0);
    if (pair.relation === "no-claim") {
      if (emptySides.length !== SIDES.length) {
        const spoke = SIDES.filter((s) => freshSides[s].length > 0);
        outcomes.push({
          id: pair.id,
          relation: pair.relation,
          status: "honesty",
          detail:
            `a \`no-claim\` pair produced claims on side(s) ${spoke.join(", ")}: ` +
            spoke.map((s) => `${s}=${formatTriples(freshSides[s])}`).join(" / ") +
            ". Either the message stopped being small talk, or the extractor has stopped discriminating.",
          fresh: freshSides,
          recorded: artifact?.pairs[pair.id] ?? null,
        });
        continue;
      }
    } else if (emptySides.length > 0) {
      outcomes.push({
        id: pair.id,
        relation: pair.relation,
        status: "honesty",
        detail:
          `the extractor produced NO claim on side(s) ${emptySides.join(", ")}, so this pair ` +
          `exercises nothing — a prohibition with an empty side passes against an identity ` +
          `layer that does nothing.`,
        fresh: freshSides,
        recorded: artifact?.pairs[pair.id] ?? null,
      });
      continue;
    }

    const recorded = artifact?.pairs[pair.id] ?? null;
    if (!recorded) {
      outcomes.push({
        id: pair.id,
        relation: pair.relation,
        status: "unrecorded",
        detail: "the artifact carries no recording for this pair — regenerate with --write.",
        fresh: freshSides,
        recorded: null,
      });
      continue;
    }

    const drifted = SIDES.filter((s) => !triplesEqual(freshSides[s], recorded[s] ?? []));
    if (drifted.length > 0) {
      outcomes.push({
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
      });
      continue;
    }

    outcomes.push({
      id: pair.id,
      relation: pair.relation,
      status: "match",
      detail: "",
      fresh: freshSides,
      recorded,
    });
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

/** Everything a run needs to say about itself, once graded. */
export interface ParaphraseRunReport extends ParaphraseResult {
  readonly model: string;
  readonly extractor: string;
  readonly corpusPath: string;
  readonly artifactPath: string;
  readonly wrote: boolean;
}

/** fd 2, always — see the header. Unbuffered so an abort cannot lose the tail. */
function human(text: string): void {
  fs.writeSync(2, text);
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
async function realExtractor(modelIdOverride: string | null): Promise<{
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

  const requested = modelIdOverride ?? process.env.ATLAS_MODEL ?? DEFAULT_MODEL_ID;
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
 * `detail` is typed as an open record on the candidate, so the hint is read
 * defensively: a non-string value records `null` rather than being coerced into
 * a string that reads like an answer the extractor gave.
 */
export function toRecordedTriple(candidate: FactCandidate): RecordedTriple {
  const hint = candidate.predicateCardinality;
  return {
    subject: candidate.subject,
    predicate: candidate.predicate,
    object: candidate.object,
    cardinalityHint: typeof hint === "string" ? hint : null,
  };
}

/**
 * Run the corpus through the extractor and grade it.
 *
 * Sequential rather than `Promise.all`: this is nine pairs against a rate-limited
 * gateway, the wall clock is irrelevant to a weekly cron, and a serial run gives
 * a progress line per message that names the pair a failure came from.
 */
export async function runBrainParaphraseEval(
  opts: ParaphraseRunOptions,
): Promise<ParaphraseRunReport> {
  const corpus = loadMessageCorpus(opts.corpusPath);

  const seam = opts.extract
    ? { extract: opts.extract, modelId: "(injected)", extractor: "(injected)" }
    : await realExtractor(null);

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

  // In `--write` mode a missing or unparseable artifact is the expected state,
  // not a failure — that is the mode that creates one. Every other mode wants
  // the load error to propagate with its own message.
  let artifact: RecordedArtifact | null = null;
  if (opts.write) {
    try {
      artifact = loadArtifact(opts.artifactPath);
    } catch (err) {
      // Reported, never swallowed: regenerating over a file that failed to parse
      // is the right move, and a maintainer is still entitled to know it did.
      human(
        `  (no usable existing artifact: ${err instanceof Error ? err.message : String(err)})\n`,
      );
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
    wrote,
  };
}

// ── CLI ───────────────────────────────────────────────────────────────

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
  return {
    corpusPath: flagValue("--corpus") ?? DEFAULT_CORPUS_PATH,
    artifactPath: flagValue("--artifact") ?? DEFAULT_ARTIFACT_PATH,
    write: args.includes("--write"),
    json: args.includes("--json"),
  };
}

/** The human summary, on fd 2. Returns the process exit code. */
export function reportParaphraseRun(report: ParaphraseRunReport): number {
  const counts = new Map<PairStatus, number>();
  for (const o of report.outcomes) counts.set(o.status, (counts.get(o.status) ?? 0) + 1);

  human(`\nbrain paraphrase eval — model=${report.model} extractor=${report.extractor}\n`);
  for (const o of report.outcomes) {
    human(`  ${o.status === "match" ? "ok  " : "FAIL"} ${o.id} (${o.relation})`);
    human(o.detail === "" ? "\n" : `\n       ${o.detail}\n`);
  }
  if (report.digestMismatch) {
    human(
      `  FAIL corpus digest — the artifact was recorded from different message bodies ` +
        `(artifact ${report.digestMismatch.artifact.slice(0, 12)}, corpus ${report.digestMismatch.corpus.slice(0, 12)}). ` +
        `Re-run with --write.\n`,
    );
  }
  for (const id of report.staleArtifactPairs) {
    human(`  FAIL stale artifact entry "${id}" — no such pair in the corpus. Re-run with --write.\n`);
  }
  if (report.wrote) human(`\nwrote ${report.artifactPath}\n`);

  const matched = counts.get("match") ?? 0;
  human(
    `\n${report.passed ? "PASS" : "FAIL"}: ${matched}/${report.outcomes.length} pairs match the recorded artifact.\n`,
  );
  if (!report.passed && !report.wrote) {
    human(
      "\nThis eval fails on DRIFT by design: the deterministic brain suite consumes this\n" +
        "artifact, so a change here is a change to what that suite proves. Read what moved,\n" +
        "then regenerate with --write and commit it as a reviewed change (ADR-0037 §9).\n",
    );
  }
  return report.passed ? 0 : 1;
}

async function main(): Promise<number> {
  const opts = parseParaphraseArgs(process.argv.slice(2));
  const report = await runBrainParaphraseEval(opts);
  const code = reportParaphraseRun(report);
  if (opts.json) {
    // The ONLY write to fd 1 in this process. Blocking, because
    // `process.stdout` is buffered and a `process.exit` on the next line would
    // discard whatever is still in the buffer — the payload, in full.
    fs.writeSync(1, `${JSON.stringify(report, null, 2)}\n`);
  }
  return code;
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      human(`\nError: ${err instanceof Error ? err.message : String(err)}\n`);
      if (err instanceof Error && err.stack) human(`${err.stack}\n`);
      process.exit(1);
    });
}
