/**
 * The async extraction fiber (#4771, ADR-0036 §Ingestion & connectors) — the
 * second of T6's two async halves.
 *
 * ## Why extraction is a SEPARATE fiber from fetch
 *
 * Acceptance criterion 1: "episode freshness never blocks on LLM latency /
 * 429s". The connector engine (#4770) fetches and stores episodes on the
 * knowledge-sync cadence and returns; this fiber drains `extracted_at IS NULL`
 * on its own clock and calls the model. A model outage, a rate-limit storm, or
 * a workspace whose BYO key was rotated-and-broken therefore costs EXTRACTION
 * throughput and nothing else — the raw record of what was said keeps landing,
 * and the backlog is visible in `idx_brain_episodes_extraction_queue` rather
 * than inferred from a stalled connector.
 *
 * Facts are consequently SECOND-ORDER FRESH by design, and there is deliberately
 * no synchronous fast-path from ingest to a fact. A fast-path would reintroduce
 * exactly the coupling this split exists to remove, and the review gate means a
 * fact is not usable the instant it is extracted anyway.
 *
 * ## Work-then-stamp, and why not claim-then-work
 *
 * The order is: extract → reconcile (commits) → stamp `extracted_at`. A crash
 * anywhere before the stamp re-queues the episode, the next cycle re-extracts
 * it, and the reconcile stage's corroboration dedupe makes that a no-op — the
 * existing fact gains at most an already-present provenance edge. So the cost
 * of a crash is a repeated model call, never a duplicated belief.
 *
 * Claiming first (stamp, then call the model) was rejected: it converts every
 * crash mid-extraction into an episode marked extracted with zero facts drawn
 * from it — a silent, permanent drop of a claim nobody will ever look for
 * again. Migration 0180 states the opposite posture outright ("NULL forever is
 * a visible backlog, not a silent drop"), and idempotence is cheap here
 * precisely so this ordering is affordable.
 *
 * The residue is honest and bounded: two processes draining concurrently can
 * both call the model for the same episode. They cannot both write the fact
 * (the reconcile stage serializes per workspace and corroborates), so the cost
 * is duplicate spend in a narrow window, not corruption. An episode-level claim
 * that is ALSO crash-safe needs a stale-claim reaper; that machinery belongs
 * with the review surface's operational story, not here.
 *
 * ## BYO key rides the agent's model seam
 *
 * ADR-0036 §T8 puts BYO-LLM in CORE, on the existing seam: the workspace's own
 * `ModelRouter` config if it has one (EE provides the implementation; the
 * self-hosted no-op returns null), else the platform default — the same
 * resolution order, and the same "never silently bill the platform for a
 * workspace whose key failed to decrypt" refusal, that `runAgent` applies. This
 * fiber adds no second credential path and reads no key of its own.
 *
 * ## Head-of-line, stated because it is a real bound
 *
 * The drain is `ORDER BY ingested_at LIMIT N`. An episode that fails
 * transiently is NOT stamped (so it retries) and therefore occupies one of the
 * N slots next cycle; an episode this fiber will never be able to extract IS
 * stamped (with a warn naming it) so it cannot occupy a slot forever. The
 * failure counters are in the cycle audit for exactly this reason: N
 * permanently-failing episodes at the head of the queue would starve it, and
 * that has to be observable rather than mysterious.
 */

import { Effect } from "effect";
import { z } from "zod";
import { generateObject, type LanguageModel } from "ai";
import { createLogger } from "@atlas/api/lib/logger";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { getSettingAuto } from "@atlas/api/lib/settings";
import { runPeriodicDbCycle } from "@atlas/api/lib/scheduler/periodic-db-job";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { ADMIN_ACTIONS, logAdminAction } from "@atlas/api/lib/audit";
import { ModelRouter } from "@atlas/api/lib/effect/services";
import { runEnterprise } from "@atlas/api/lib/effect/enterprise-layer";
import { getModel, getModelFromWorkspaceConfig } from "@atlas/api/lib/providers";
import type { RawWorkspaceModelConfig } from "@atlas/api/lib/auth/credentials";
import {
  reconcileFacts,
  type FactCandidate,
  type ReconcileEpisodeRef,
  type ReconcileReport,
} from "@atlas/api/lib/brain/reconcile";

const log = createLogger("brain.extract");

/**
 * Reserved system actor for every audit row this fiber writes. Matches
 * `^system:[a-z0-9][a-z0-9_-]*$` (`assertSystemActor`); a rename surfaces as
 * broken forensic queries.
 */
export const BRAIN_EXTRACTION_ACTOR = "system:brain-extraction" as const;

/** The producer label stamped into every fact this path reconciles. */
export const BRAIN_EXTRACTION_PRODUCER = "extraction:v1" as const;

/**
 * Tick cadence. Short relative to the connector cadence on purpose — the
 * backlog should drain steadily rather than in daily bursts — but long enough
 * that an idle deployment is not paying for a wake-up loop. A constant, not a
 * knob: the operator lever that matters for cost is the enablement switch and
 * the per-tick batch below, and a third dial would only widen the ways two
 * settings can disagree.
 */
const INTERVAL_MS = 5 * 60 * 1000;

/** Episodes drained per tick — the per-cycle model-spend bound. */
const BATCH_SIZE = 25;

/** Body characters sent to the model. Beyond this a chat message is a transcript. */
const MAX_BODY_CHARS = 8_000;

/** Claims accepted from one episode — a bound on a model that will not stop. */
const MAX_CANDIDATES = 10;

/** Per-episode model call budget. */
const EXTRACTION_TIMEOUT_MS = 60_000;

/**
 * Is the extraction fiber switched on?
 *
 * Default OFF while the brain milestone is in flight: the review surface
 * (#4772) is what makes an extracted fact usable, so until it lands the fiber
 * would spend a workspace's model budget filling a queue nobody can read. The
 * switch is platform-scoped because the fiber is process-wide.
 */
export function isBrainExtractionEnabled(): boolean {
  return getSettingAuto("ATLAS_BRAIN_EXTRACTION_ENABLED") === "true";
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/**
 * The drain. Served by `idx_brain_episodes_extraction_queue`, the PARTIAL index
 * over exactly this predicate — so the scan is proportional to work remaining
 * rather than to history.
 *
 * Oldest first, across workspaces: an episode's claims are most useful soonest
 * after it was said, and per-workspace fairness is not something a single
 * ordered queue can express without starving whoever is not first. The batch
 * bound is what keeps one noisy workspace from monopolizing a tick.
 */
export const DRAIN_EPISODES_SQL = `SELECT id, workspace_id, source, source_id, source_actor,
              body, locator, occurred_at, visible_to
         FROM brain_episodes
        WHERE extracted_at IS NULL
        ORDER BY ingested_at
        LIMIT $1`;

/**
 * Take one episode off the queue. `AND extracted_at IS NULL` makes a re-stamp a
 * no-op rather than a rewrite: a concurrent drainer that got there first keeps
 * its timestamp, so "when did the pass that produced these claims run" stays
 * true. `now()` is the database clock — the queue marker's only reader is this
 * query's own predicate, so it must not depend on a pod's wall clock.
 */
export const STAMP_EXTRACTED_SQL = `UPDATE brain_episodes
          SET extracted_at = now()
        WHERE id = $1
          AND workspace_id = $2
          AND extracted_at IS NULL`;

// ---------------------------------------------------------------------------
// The extractor
// ---------------------------------------------------------------------------

/** The row shape the drain returns. */
interface EpisodeRow {
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
 */
const ExtractionSchema = z.object({
  facts: z
    .array(
      z.object({
        subject: z.string().describe("The entity the claim is about, as named in the text."),
        predicate: z
          .string()
          .describe("The relationship, as a short lowercase verb phrase, e.g. 'reports to'."),
        object: z.string().describe("The value or entity the subject relates to."),
        cardinality: z
          .enum(["single", "multi"])
          .describe(
            "'single' when the subject can only have ONE such object at a time (a manager, an owner); 'multi' when several can coexist (a language, a skill). When unsure answer 'multi'.",
          ),
      }),
    )
    .describe("Durable claims. Empty when the text contains none."),
});

const EXTRACTION_SYSTEM_PROMPT = [
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
  "- Answer 'single' for cardinality only when the subject can have just one such object at a time.",
].join("\n");

/**
 * Produce candidates for one episode. The injectable seam: tests supply a fake
 * and never touch the AI SDK, and M2's better extractor replaces this one
 * function without the cycle knowing.
 */
export type FactExtractor = (input: {
  readonly episode: ReconcileEpisodeRef;
  readonly body: string;
  readonly model: LanguageModel;
  readonly modelId: string;
}) => Promise<readonly FactCandidate[]>;

/** The default extractor — one bounded, structured model call per episode. */
export const llmFactExtractor: FactExtractor = async ({ episode, body, model, modelId }) => {
  const { object } = await generateObject({
    model,
    schema: ExtractionSchema,
    system: EXTRACTION_SYSTEM_PROMPT,
    prompt: [
      `Source: ${episode.source}`,
      episode.occurredAt !== null ? `Said at: ${episode.occurredAt.toISOString()}` : null,
      "",
      "Message:",
      body.slice(0, MAX_BODY_CHARS),
    ]
      .filter((line): line is string => line !== null)
      .join("\n"),
    abortSignal: AbortSignal.timeout(EXTRACTION_TIMEOUT_MS),
  });

  if (object.facts.length > MAX_CANDIDATES) {
    log.warn(
      {
        workspaceId: episode.workspaceId,
        episodeId: episode.id,
        returned: object.facts.length,
        cap: MAX_CANDIDATES,
      },
      "brain extraction: model returned more claims than one message can support — keeping the first few",
    );
  }

  return object.facts.slice(0, MAX_CANDIDATES).map((fact) => ({
    subject: fact.subject,
    predicate: fact.predicate,
    object: fact.object,
    predicateCardinality: fact.cardinality,
    // The model id belongs in provenance: a later pass with a better model has
    // to be tellable from this one, and the reviewer is entitled to know what
    // asserted the claim on the source's behalf.
    detail: { extractor: BRAIN_EXTRACTION_PRODUCER, model: modelId },
  }));
};

// ---------------------------------------------------------------------------
// Model resolution — the agent's seam, nothing new
// ---------------------------------------------------------------------------

export interface ResolvedExtractionModel {
  readonly model: LanguageModel;
  readonly modelId: string;
}

/**
 * Resolve the model for one workspace: its own BYO configuration if it has one,
 * else the platform default.
 *
 * Returns `null` when the workspace HAS a configuration that could not be used
 * — a key that no longer decrypts. Falling back to the platform default there
 * would bill Atlas for a workspace that explicitly chose to bring its own
 * provider, which is the same refusal `runAgent` makes (it raises a re-enter-
 * your-key error); here there is no user to tell, so the episodes stay queued
 * and the skip is counted until an admin repairs the key.
 */
export async function resolveExtractionModel(
  workspaceId: string,
): Promise<ResolvedExtractionModel | null> {
  const program = Effect.gen(function* () {
    const router = yield* ModelRouter;
    return yield* router.getWorkspaceModelConfigRaw(workspaceId);
  });

  let config: RawWorkspaceModelConfig | null = null;
  try {
    config = await runEnterprise(program);
  } catch (err) {
    log.warn(
      { workspaceId, err: err instanceof Error ? err.message : String(err) },
      "brain extraction: workspace model config could not be read — leaving this workspace's episodes queued",
    );
    return null;
  }

  if (config) {
    return {
      model: getModelFromWorkspaceConfig({
        model: config.model,
        baseUrl: config.baseUrl,
        bedrockRegion: config.bedrockRegion,
        credentials: config.credentials,
      }),
      modelId: config.model,
    };
  }

  const model = getModel();
  return { model, modelId: typeof model === "string" ? model : model.modelId };
}

// ---------------------------------------------------------------------------
// The cycle
// ---------------------------------------------------------------------------

/** Why an episode was left alone this pass. */
export type ExtractionSkipReason =
  /** The workspace's own model config could not be used — retried next cycle. */
  | "model_unavailable"
  /** Stored by reference (`locator`), which M1 has no fetcher for. Stamped. */
  | "no_body";

export interface BrainExtractionCycleResult {
  status: "success" | "failure";
  /** Episodes drained this tick. */
  inspected: number;
  /** Episodes whose extraction pass completed and were taken off the queue. */
  extracted: number;
  factsCreated: number;
  factsCorroborated: number;
  factsProvisional: number;
  /** Candidates the reconcile stage refused on safety grounds. */
  factsBlocked: number;
  skippedModelUnavailable: number;
  skippedNoBody: number;
  /** Episodes whose pass threw — left queued for the next cycle. */
  failed: number;
  /** Present only on the scan-fault path, mirroring the other DB cycles. */
  error?: string;
}

type EpisodeOutcome =
  | { readonly kind: "extracted"; readonly report: ReconcileReport }
  | { readonly kind: "skipped"; readonly reason: ExtractionSkipReason }
  | { readonly kind: "failed"; readonly error: string };

export interface BrainExtractionDeps {
  /** Defaults to {@link llmFactExtractor}. */
  readonly extract?: FactExtractor;
  /** Defaults to {@link resolveExtractionModel}. */
  readonly resolveModel?: (workspaceId: string) => Promise<ResolvedExtractionModel | null>;
  /** Defaults to `reconcileFacts`. */
  readonly reconcile?: typeof reconcileFacts;
  /** Test clock. */
  readonly now?: () => Date;
}

function emptyResult(): BrainExtractionCycleResult {
  return {
    status: "success",
    inspected: 0,
    extracted: 0,
    factsCreated: 0,
    factsCorroborated: 0,
    factsProvisional: 0,
    factsBlocked: 0,
    skippedModelUnavailable: 0,
    skippedNoBody: 0,
    failed: 0,
  };
}

/**
 * One extraction tick. Never throws — the `runPeriodicDbCycle` skeleton folds a
 * scan fault into an audited failure result and isolates every per-episode
 * fault, so a bad row can neither abort the batch nor kill the fiber.
 */
export function runBrainExtractionCycle(
  deps: BrainExtractionDeps = {},
): Effect.Effect<BrainExtractionCycleResult> {
  const extract = deps.extract ?? llmFactExtractor;
  const resolveModel = deps.resolveModel ?? resolveExtractionModel;
  const reconcile = deps.reconcile ?? reconcileFacts;
  const now = deps.now ?? (() => new Date());

  // Resolved once per WORKSPACE per cycle, not once per episode: a decrypt is
  // not free and a workspace usually contributes a run of adjacent episodes.
  // Cycle-scoped so a key repaired between ticks takes effect on the next one.
  const models = new Map<string, ResolvedExtractionModel | null>();
  const modelFor = async (workspaceId: string): Promise<ResolvedExtractionModel | null> => {
    const cached = models.get(workspaceId);
    if (cached !== undefined) return cached;
    const resolved = await resolveModel(workspaceId);
    models.set(workspaceId, resolved);
    return resolved;
  };

  return runPeriodicDbCycle<EpisodeRow, EpisodeOutcome, BrainExtractionCycleResult>({
    log,
    label: "Brain extraction",
    emptyResult,
    failureResult: (error) => ({ ...emptyResult(), status: "failure", error }),
    scan: () => internalQuery<EpisodeRow>(DRAIN_EPISODES_SQL, [BATCH_SIZE]),
    applyRow: (row) => extractEpisode(row, { extract, modelFor, reconcile, now }),
    defectOutcome: (error) => ({ kind: "failed", error }),
    tally: (result, row, outcome) => tallyEpisode(result, row, outcome),
    emitCycleAudit,
  });
}

interface ApplyDeps {
  readonly extract: FactExtractor;
  readonly modelFor: (workspaceId: string) => Promise<ResolvedExtractionModel | null>;
  readonly reconcile: typeof reconcileFacts;
  readonly now: () => Date;
}

/** Extract → reconcile → stamp, for one episode. */
async function extractEpisode(row: EpisodeRow, deps: ApplyDeps): Promise<EpisodeOutcome> {
  const episode = toEpisodeRef(row);

  if (row.body === null || row.body.trim() === "") {
    // By-reference evidence (a warehouse/KB locator). Nothing in M1 can fetch
    // it, and leaving it queued would burn a slot at the head of the drain
    // every cycle forever — so it is stamped, and warned about by id so the
    // "silent drop" this stamps past is at least an audible one.
    log.warn(
      { workspaceId: episode.workspaceId, episodeId: episode.id, source: episode.source },
      "brain extraction: episode is stored by reference and has no body to extract from — marking it extracted so it cannot block the queue",
    );
    await stampExtracted(episode);
    return { kind: "skipped", reason: "no_body" };
  }

  const resolved = await deps.modelFor(episode.workspaceId);
  if (resolved === null) {
    // NOT stamped: an admin re-entering the workspace's key must be enough to
    // make these episodes extract, with no backfill to run.
    return { kind: "skipped", reason: "model_unavailable" };
  }

  const extractedAt = deps.now();
  const candidates = await deps.extract({
    episode,
    body: row.body,
    model: resolved.model,
    modelId: resolved.modelId,
  });

  const report = await deps.reconcile({
    episode,
    candidates,
    producer: BRAIN_EXTRACTION_PRODUCER,
    extractedAt,
  });

  // Only after the reconcile transaction has COMMITTED. See the module header
  // on why the reverse order is not merely slower but unsafe.
  await stampExtracted(episode);
  return { kind: "extracted", report };
}

async function stampExtracted(episode: ReconcileEpisodeRef): Promise<void> {
  await internalQuery(STAMP_EXTRACTED_SQL, [episode.id, episode.workspaceId]);
}

/**
 * Map a drained row onto the reconcile stage's episode reference.
 *
 * `occurred_at` arrives as a `Date` from `pg` but as a string through a JSON
 * round-trip (a region import, a test fixture), and an unparseable value must
 * degrade to "no event time" rather than reach `toISOString()` and throw
 * mid-transaction. `visible_to` is passed through untouched — `parseGrant` is
 * built to read it straight off the driver, `null` elements and all.
 */
function toEpisodeRef(row: EpisodeRow): ReconcileEpisodeRef {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    source: row.source,
    sourceId: row.source_id,
    sourceActor: row.source_actor,
    occurredAt: toDate(row.occurred_at),
    visibleTo: Array.isArray(row.visible_to) ? (row.visible_to as readonly unknown[]) : [],
  };
}

function toDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function tallyEpisode(
  result: BrainExtractionCycleResult,
  row: EpisodeRow,
  outcome: EpisodeOutcome,
): void {
  switch (outcome.kind) {
    case "extracted": {
      result.extracted++;
      result.factsCreated += outcome.report.created;
      result.factsCorroborated += outcome.report.corroborated;
      result.factsProvisional += outcome.report.provisional;
      result.factsBlocked += Object.values(outcome.report.blocked).reduce((a, b) => a + b, 0);
      return;
    }
    case "skipped": {
      if (outcome.reason === "model_unavailable") result.skippedModelUnavailable++;
      else result.skippedNoBody++;
      return;
    }
    case "failed": {
      result.failed++;
      // Per-episode, at warn: the episode stays queued, so this is a retry
      // notice rather than an outage — but an id-less "3 failed" in the cycle
      // row would leave an operator nothing to look at.
      log.warn(
        { workspaceId: row.workspace_id, episodeId: row.id, err: outcome.error },
        "brain extraction: episode extraction failed — it stays on the queue and will be retried",
      );
      return;
    }
  }
}

/**
 * The cycle-level audit row. Emitted on EVERY terminal path (including the
 * no-database and empty ones), so its ABSENCE over a window is the "the fiber
 * stopped" signal — the same forensic invariant the BYOT refresh cycle carries.
 */
function emitCycleAudit(result: BrainExtractionCycleResult): void {
  try {
    logAdminAction({
      actionType: ADMIN_ACTIONS.brain.extractionCycle,
      targetType: "brain",
      targetId: "scheduler",
      scope: "platform",
      systemActor: BRAIN_EXTRACTION_ACTOR,
      status: result.status,
      metadata: { ...result },
    });
  } catch (err) {
    log.error(
      { err: errorMessage(err) },
      "Brain extraction: cycle audit emission threw",
    );
  }
}

/** The fiber's tick cadence. Exported for the registration in `layers.ts`. */
export function getBrainExtractionIntervalMs(): number {
  return INTERVAL_MS;
}
