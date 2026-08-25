/**
 * The extraction CONTRACT — everything the synchronous path and the batch path
 * must agree on, and nothing either of them owns alone (#5352).
 *
 * ## Why this file exists
 *
 * `extract.ts` owns the CYCLE (drain, quarantine ledger, reconcile, stamp) and
 * `extract-batch.ts` owns the BATCH (vendor wire, in-flight ledger, the collect
 * and submit phases). Both of them need the same handful of primitives — the
 * row shape, the schema, the prompt, the candidate mapping — and putting those
 * in either owner makes the other import from it, which is a cycle.
 *
 * ## What makes this a contract rather than a junk drawer
 *
 * Everything here is load-bearing for AGREEMENT between the two paths, and the
 * failure mode is the same in each case: a claim drawn by batch that differs
 * from the same claim drawn synchronously.
 *
 *   - {@link ExtractionSchema} / {@link EXTRACTION_SYSTEM_PROMPT} /
 *     {@link EXTRACTION_JSON_SCHEMA} — ask the model for one shape. A second
 *     copy drifts on exactly the field a reviewer reads.
 *   - {@link extractionExcerpt} / {@link extractionPrompt} — send the model one
 *     text. Diverge, and a batched re-extraction of a synchronously-extracted
 *     episode paraphrases itself into a second draft, which is a cost
 *     `extract.ts`'s header prices and nobody would see arriving this way.
 *   - {@link toFactCandidates} — one candidate SHAPE, including the cap, the
 *     provenance detail and the cardinality hint's demotion.
 *   - {@link EpisodeRow} / {@link toEpisodeRef} — one row type behind two
 *     SELECTs (`DRAIN_EPISODES_SQL` and `BATCH_EPISODES_SQL`), which is why
 *     both carry a comment saying they mirror each other.
 *
 * Nothing here talks to a database or to a vendor. If something wants to, it
 * belongs in one of the two owners instead.
 */

import { z } from "zod";
import type { LanguageModel } from "ai";
import { createLogger } from "@atlas/api/lib/logger";
import { PREDICATE_CARDINALITIES } from "@atlas/api/lib/brain/types";
import type { FactCandidate, ReconcileEpisodeRef } from "@atlas/api/lib/brain/reconcile";
import { strippedForExtraction } from "@atlas/api/lib/brain/quoted-reply";

const log = createLogger("brain.extract");

/**
 * The counters the batch phases keep, lifted out of
 * `BrainExtractionCycleResult` so the phases can be handed just their own tally
 * rather than the whole cycle result.
 *
 * All zero on the synchronous path, which is also how an operator tells "batch
 * is off" from "batch is on and stuck": `submitted: 0, polled: 4` is a collect
 * phase that is waiting, and all-zero beside a non-zero `extracted` is simply
 * the immediate path.
 */
export interface BrainExtractionBatchTally {
  /** Episodes sent out with a batch this tick. */
  submitted: number;
  /** Batches polled this tick, bounded by `COLLECT_BATCHES_PER_TICK`. */
  polled: number;
  /** Batches whose results landed and were reconciled this tick. */
  collected: number;
  /**
   * Batches given up on — expired, or a poll that failed. Their episodes are
   * re-queued and charged NO strikes; see `abandonBatch` on why a batch failure
   * is evidence about the world rather than about the episodes.
   */
  abandoned: number;
  /** Episodes put back on the queue by an abandon or an unfulfilled result. */
  requeued: number;
}

/** The producer label stamped into every fact this path reconciles. */
export const BRAIN_EXTRACTION_PRODUCER = "extraction:v1" as const;

/** Body characters sent to the model. Beyond this a chat message is a transcript. */
export const MAX_BODY_CHARS = 8_000;

/** Claims accepted from one episode — a bound on a model that will not stop. */
export const MAX_CANDIDATES = 10;

/**
 * The row shape the drain returns.
 *
 * EXPORTED since #5352 because the batch collect phase loads the same shape
 * through `BATCH_EPISODES_SQL` — two SELECTs feeding one row type, which is why
 * that query's column list carries a comment saying it mirrors this one's.
 */
export interface EpisodeRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly source: string;
  readonly source_id: string;
  readonly source_actor: string | null;
  readonly body: string | null;
  readonly locator: string | null;
  readonly occurred_at: Date | string | null;
  readonly visible_to: unknown;
  [key: string]: unknown;
}

/**
 * What the model is asked for. Kept deliberately close to `brain_facts`'s own
 * columns: a schema with its own vocabulary would need a translation step, and
 * a translation step is where a claim quietly changes meaning.
 *
 * ## The SEGMENTATION rule on `subject`, and what it is and is not worth (#5438)
 *
 * The subject description and the system prompt both now say that the entity
 * goes in the subject and the whole relationship goes in the predicate. That is
 * a repair at the SOURCE of the defect #5438 measured in prod: the extractor
 * absorbed *"fundraise"* into one message's subject, so two sentences expressing
 * one relation were segmented differently and their identity keys diverged at
 * both slot arms before any matching rule could run.
 *
 * ⚠️ **It is a rate reduction, not a gate, and nothing may be built on top of
 * it.** This is an instruction to a model, so it holds statistically and on the
 * provider's current behaviour — `paraphrase-identity.test.ts` records the same
 * extractor emitting two different predicates for one claim at 12:25 UTC and one
 * predicate at 13:40, same model id, `temperature: 0`, no local change. A rule
 * that has to be TRUE belongs in the identity layer or in SQL, where it can be
 * falsified.
 *
 * What actually recognizes the drifted pair is `segmentation.ts`'s anchor arm on
 * the tension scan, which is deterministic and holds however the extractor
 * segments. This instruction reduces how often that arm is the only thing
 * standing between two contradicting colleagues and silence; it does not make
 * the arm redundant, and removing the arm on the strength of this paragraph
 * would restore the bug.
 */
export const ExtractionSchema = z.object({
  facts: z
    .array(
      z.object({
        subject: z
          .string()
          .describe(
            "The entity the claim is about, as named in the text — the entity ALONE. " +
              "Do not absorb any part of the relationship into it: for 'the Series B " +
              "fundraise goal is $30M' the subject is 'Series B', not 'Series B fundraise'.",
          ),
        predicate: z
          .string()
          .describe("The relationship, as a short lowercase verb phrase, e.g. 'reports to'."),
        object: z.string().describe("The value or entity the subject relates to."),
        cardinality: z
          // Derived from the SSOT tuple, never hand-listed — two spellings would
          // drift the first time an arm is added.
          //
          // ⚠️ This answer is a NON-LOAD-BEARING HINT since #5027 (ADR-0037 §3).
          // It used to be written straight into
          // `brain_facts.predicate_cardinality`, which the publish gate then
          // required to read `single` on BOTH sides of a collision — two
          // independent model calls, on two different messages, against the
          // "when unsure answer 'multi'" instruction below. Supersession
          // therefore fired at roughly P(model says `single`)²: a stochastic
          // gate on an operation with no inverse.
          //
          // It is still asked for, because it is worth recording what the
          // extractor thought and it feeds the advisory tension edges. It must
          // never again decide whether a belief is retired — cardinality belongs
          // to the canonical predicate, and only a human or a warehouse
          // structural declaration may set it.
          .enum(PREDICATE_CARDINALITIES)
          .describe(
            "'single' when the subject can only have ONE such object at a time (a manager, an owner); 'multi' when several can coexist (a language, a skill). When unsure answer 'multi'.",
          ),
      }),
    )
    .describe("Durable claims. Empty when the text contains none."),
});

export const EXTRACTION_SYSTEM_PROMPT = [
  "You extract durable, checkable facts about a company from a single message.",
  "",
  "Return a subject-predicate-object triple for each claim that would still be worth knowing next month.",
  "Extract nothing for small talk, questions, opinions, jokes, greetings, or one-off status noise —",
  "an empty list is the correct and common answer.",
  "",
  "Rules:",
  "- Use the names exactly as the message writes them. Do not invent identifiers or expand abbreviations.",
  "- Do not infer anything the message does not state.",
  "- Keep each field short; the predicate is a verb phrase, not a sentence.",
  "- Put the entity in the subject and the WHOLE relationship in the predicate. Never move a",
  "  relationship word into the subject: 'the Series B fundraise goal is $30M' is",
  "  subject 'Series B', predicate 'has goal of' — not subject 'Series B fundraise'.",
  "- Answer 'single' for cardinality only when the subject can have just one such object at a time.",
].join("\n");

/**
 * The episode's body as the model sees it.
 *
 * Truncation is SIGNALLED, not silent, in both directions: the model is told the
 * text was cut (so it does not confidently extract from a clause that ends
 * mid-sentence) and the operator is told which episode lost a tail. The episode
 * is stamped after the pass, so whatever is dropped here is dropped for good —
 * which is precisely why it cannot be quiet.
 *
 * Shared with the batch path since #5352 rather than duplicated: the two paths
 * must send the model the SAME text, or a batched re-extraction of a
 * synchronously-extracted episode paraphrases itself into a second draft — the
 * cost the module header prices, arriving from a divergence nobody would see.
 *
 * ## Strip, then truncate (#5354)
 *
 * Mail bodies lose their quoted reply chains and signatures here, BEFORE the
 * cap is applied — see `quoted-reply.ts`. The order is the point: with the cap
 * first, a deep thread spends its whole 8k budget on history the model has
 * already been shown, and the newest message — the only part that says
 * anything new — is what falls off the end. Reversing them means the cap is
 * reached by real content, and a truncation warning becomes evidence about a
 * genuinely long message rather than about thread depth.
 *
 * This is a VIEW. The stored episode keeps its full body; nothing here edits
 * evidence at rest.
 */
export function extractionExcerpt(episode: ReconcileEpisodeRef, body: string): string {
  const text = strippedForExtraction(episode.source, body, {
    workspaceId: episode.workspaceId,
    episodeId: episode.id,
  });
  if (text.length <= MAX_BODY_CHARS) return text;
  log.warn(
    {
      workspaceId: episode.workspaceId,
      episodeId: episode.id,
      // BOTH, since #5354: `bodyChars` alone can no longer be reconciled
      // against the stored episode, and the gap between them is the only
      // signal that says whether a truncation was caused by real content or by
      // quoted history the strip failed to remove.
      bodyChars: body.length,
      extractedChars: text.length,
      cap: MAX_BODY_CHARS,
    },
    "brain extraction: episode body exceeds the per-call cap — extracting from the leading portion only, the remainder is not revisited",
  );
  return `${text.slice(0, MAX_BODY_CHARS)}\n[truncated at ${MAX_BODY_CHARS} characters]`;
}

/** The user turn, shared with the batch path for {@link extractionExcerpt}'s reason. */
export function extractionPrompt(episode: ReconcileEpisodeRef, excerpt: string): string {
  return [
    `Source: ${episode.source}`,
    episode.occurredAt !== null ? `Said at: ${episode.occurredAt.toISOString()}` : null,
    "",
    "Message:",
    excerpt,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/**
 * The model's answer → candidates, shared with the batch path.
 *
 * Everything about the SHAPE of a candidate lives here — the cap, the
 * provenance detail, the cardinality hint's demotion — so that a claim drawn by
 * batch is byte-identical to the same claim drawn synchronously. A second copy
 * would drift on exactly the field a reviewer reads.
 */
export function toFactCandidates(
  facts: z.infer<typeof ExtractionSchema>["facts"],
  episode: ReconcileEpisodeRef,
  modelId: string,
): readonly FactCandidate[] {
  if (facts.length > MAX_CANDIDATES) {
    log.warn(
      {
        workspaceId: episode.workspaceId,
        episodeId: episode.id,
        returned: facts.length,
        cap: MAX_CANDIDATES,
      },
      "brain extraction: model returned more claims than one message can support — keeping the first few",
    );
  }

  return facts.slice(0, MAX_CANDIDATES).map((fact) => ({
    subject: fact.subject,
    predicate: fact.predicate,
    object: fact.object,
    // A HINT since #5027, and one that now reaches only the advisory
    // `in-tension-with` edges (`reconcile.ts`). It no longer reaches
    // `brain_facts.predicate_cardinality`, and therefore no longer reaches a
    // `valid_to` stamp: cardinality is a property of the CANONICAL PREDICATE,
    // curated in `brain_predicate_cardinality` and read live at the publish gate
    // (ADR-0037 §3). What this line used to do was let two independent model
    // calls on two different messages decide, between them, whether a belief was
    // destroyed.
    predicateCardinality: fact.cardinality,
    // The model id belongs in provenance: a later pass with a better model has
    // to be tellable from this one, and the reviewer is entitled to know what
    // asserted the claim on the source's behalf.
    //
    // `cardinalityHint` rides here for the same reason and with no more
    // authority than the model id: it records WHAT THE EXTRACTOR THOUGHT, which
    // is worth keeping (a curator adjudicating `reports to` can see that the
    // extractor called it `single` on forty messages) and is worth nothing more.
    // Nothing reads it, and nothing may read it into a supersession decision —
    // that is the defect #5027 removed.
    detail: {
      extractor: BRAIN_EXTRACTION_PRODUCER,
      model: modelId,
      cardinalityHint: fact.cardinality,
    },
  }));
}

export interface ResolvedExtractionModel {
  readonly model: LanguageModel;
  readonly modelId: string;
  /**
   * The API key a batch submission for this workspace would use, or `null` when
   * the resolved provider has no batch endpoint (#5352).
   *
   * Carried on the RESOLUTION rather than fetched separately so batch
   * capability is derived from the same probe that already decided provider and
   * credentials — a second resolution could disagree with this one, and the
   * shape of that disagreement is "submit a batch on the platform key for a
   * workspace whose BYO config we just refused to build".
   */
  readonly batchApiKey: string | null;
}

/**
 * The extraction schema as JSON Schema, for the batch path's
 * `output_config.format`.
 *
 * Derived from {@link ExtractionSchema} rather than hand-written, so the two
 * paths cannot ask the model for different shapes — the drift that would produce
 * is a batched claim whose `cardinality` field is absent, which reconcile
 * accepts and the reviewer never sees. Computed ONCE at module load: it is a
 * pure function of a constant, and rebuilding it per submission would be pure
 * waste on the hot path of a 25-request body.
 *
 * `$schema` is stripped — the Messages API rejects unknown top-level keys in a
 * `json_schema` format block.
 */
export const EXTRACTION_JSON_SCHEMA: Record<string, unknown> = (() => {
  const schema = z.toJSONSchema(ExtractionSchema) as Record<string, unknown>;
  const { $schema: _ignored, ...rest } = schema;
  return rest;
})();

/**
 * A batch result already in hand for one episode (#5352) — the model call has
 * been made and paid for, so the per-episode path must not make another.
 */
export type PrecomputedExtraction =
  | { readonly kind: "candidates"; readonly candidates: readonly FactCandidate[] }
  | { readonly kind: "failed"; readonly error: string };

/**
 * Map a drained row onto the reconcile stage's episode reference.
 *
 * `occurred_at` arrives as a `Date` from `pg` but as a string through a JSON
 * round-trip (a region import, a test fixture), and an unparseable value must
 * degrade to "no event time" rather than reach `toISOString()` and throw
 * mid-transaction. `visible_to`'s ELEMENTS are passed through untouched —
 * `parseGrant` is built to read them straight off the driver, `null` entries and
 * all. Whether the column loaded as an ARRAY is settled before this call and
 * arrives as an argument, deliberately: read off `row` it needed a `?? []`
 * fallback here, and that fallback silently asserts "grants nobody", which
 * reconcile blocks as NO_GRANT and the caller then STAMPS. As a parameter, the
 * guard in `extractEpisode` is the only way to obtain one.
 */
export function toEpisodeRef(row: EpisodeRow, visibleTo: readonly unknown[]): ReconcileEpisodeRef {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    source: row.source,
    sourceId: row.source_id,
    sourceActor: row.source_actor,
    occurredAt: toDate(row.occurred_at),
    visibleTo,
  };
}

export function toDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

