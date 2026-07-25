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
 * it, and the reconcile stage's corroboration dedupe collapses the repeat — the
 * existing fact gains at most an already-present provenance edge. So the cost
 * of a crash is a repeated model call.
 *
 * That "no-op" is conditional and the condition is ours to hold: dedupe is
 * BYTE-EXACT on the SPO, so it collapses a re-extraction only if the model
 * reproduces its own output. `llmFactExtractor` therefore pins `temperature: 0`.
 * A paraphrase would mint a second draft for one claim — not corruption (the
 * reviewer collapses it), but not free either, which is why determinism is
 * load-bearing here rather than a preference.
 *
 * Claiming first (stamp, then call the model) was rejected: it converts every
 * crash mid-extraction into an episode marked extracted with zero facts drawn
 * from it — a silent, permanent drop of a claim nobody will ever look for
 * again. Migration 0180 states the opposite posture outright ("NULL forever is
 * a visible backlog, not a silent drop"), and idempotence is cheap here
 * precisely so this ordering is affordable.
 *
 * The residue is honest and bounded: two processes draining concurrently can
 * both call the model for the same episode. The reconcile stage serializes per
 * workspace, so identical output corroborates into one fact; divergent output
 * is two drafts for one claim, on the same terms as the paraphrase above. The
 * cost is duplicate spend in a narrow window, not corruption. An episode-level
 * claim that is ALSO crash-safe needs a stale-claim reaper; that machinery
 * belongs with the review surface's operational story, not here.
 *
 * ## BYO key rides the agent's model seam
 *
 * ADR-0036 §T8 puts BYO-LLM in CORE, on the existing seam: the workspace's own
 * `ModelRouter` config if it has one (EE provides the implementation; the
 * self-hosted no-op returns null), else the platform default. That RESOLUTION
 * ORDER is `runAgent`'s exactly; this fiber adds no second credential path and
 * reads no key of its own.
 *
 * The REFUSAL is deliberately broader than the agent's — see
 * {@link resolveExtractionModel} for why unattended work resolves every
 * ambiguity to "don't spend, wait" where a live turn falls through to the
 * platform default.
 *
 * ## Head-of-line, stated because it is a real bound
 *
 * The drain is `ORDER BY ingested_at LIMIT N`, so a queued episode occupies one
 * of N slots until something takes it off the queue. Exactly two classes are
 * stamped without producing a fact, and both are DECISIONS rather than guesses:
 * a by-reference episode M1 has no fetcher for, and an episode the reconcile
 * gate refuses wholesale. Everything else retries.
 *
 * A deterministically-failing episode therefore keeps its slot indefinitely —
 * stamping it would be a silent drop on a guess, which is the thing this
 * module's whole ordering avoids. What IS bounded is the SPEND: after
 * {@link QUARANTINE_AFTER_FAILURES} consecutive failures the process stops
 * calling a model for it and logs at ERROR. So the honest statement of the
 * bound is: N permanently-failing episodes at the head of the queue WOULD
 * starve it, cheaply and loudly, until an operator acts on the error log or the
 * process restarts.
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
import { isUnknownArray } from "@atlas/api/lib/brain/acl";
import { ModelRouter } from "@atlas/api/lib/effect/services";
import { runEnterprise } from "@atlas/api/lib/effect/enterprise-layer";
// The CORE mirror, never `@atlas/ee` — `check-ee-imports.sh` permits exactly one
// importer in `packages/api/src` and this is not it.
import { isEnterpriseEnabled } from "@atlas/api/lib/effect/enterprise-config";
import { getModel, getModelFromWorkspaceConfig } from "@atlas/api/lib/providers";
import type { RawWorkspaceModelConfig } from "@atlas/api/lib/auth/credentials";
import { PREDICATE_CARDINALITIES } from "@atlas/api/lib/brain/types";
import {
  classifyEpisodeForReconcile,
  reconcileFacts,
  type FactCandidate,
  type ReconcileBlockReason,
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
 * knob: the only cost lever this slice ships is the enablement switch, and a
 * dial whose safe range depends on the batch size below (also a constant) would
 * be two settings with one correct combination.
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
 * Consecutive failures after which this process stops calling a model for an
 * episode. Bounds SPEND on a deterministically-failing episode (a body that
 * always trips a content filter, a model id that 404s) without pretending a
 * few failures prove permanence.
 */
const QUARANTINE_AFTER_FAILURES = 3;

/**
 * Episode id → consecutive failures, for the life of the process.
 *
 * Module-level so it survives across ticks, in-memory so it needs no migration
 * — the same trade the BYOT catalog refresh made for its backoff state. A
 * restart forgives everything, which is the forgiving direction: the cost of
 * forgetting is one retry, the cost of a persisted give-up would be a claim
 * nobody re-examines. Bounded by {@link FAILURE_LEDGER_CAP} so a pathological
 * backlog cannot grow it without limit.
 */
const failureLedger = new Map<string, number>();

/** Ledger entries retained. Far above `BATCH_SIZE`; a bound, not a policy. */
const FAILURE_LEDGER_CAP = 1_000;

/** Test-only: forget every quarantine, as a process restart would. */
export function _resetBrainExtractionFailures(): void {
  failureLedger.clear();
}

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
 * The drain.
 *
 * The PREDICATE is served by `idx_brain_episodes_extraction_queue`, which is
 * partial on `extracted_at IS NULL` — so what is scanned is proportional to work
 * remaining rather than to history. The ORDERING is not: that index leads with
 * `workspace_id` and this query has no workspace predicate, so Postgres sorts
 * the backlog to satisfy `ORDER BY ingested_at LIMIT $1`. Affordable because the
 * backlog is bounded by how fast the connectors write, and cheap to fix later
 * with an `(ingested_at) WHERE extracted_at IS NULL` index if it ever isn't.
 *
 * Oldest first, ACROSS workspaces: an episode's claims are most useful soonest
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
 * true.
 *
 * `now()` is the DATABASE clock, so two drainers' stamps are comparable and
 * skew-free. The CLAIM's timestamp is not the same value: `brain_facts
 * .extracted_at` and `provenance.extractedAt` come from the process clock
 * (`deps.now()`, injectable in tests). The skew between the two is intentional
 * — one dates a queue transition, the other dates a claim.
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
          // Derived from the SSOT tuple, never hand-listed: the value is
          // written straight into `predicate_cardinality`, whose CHECK is the
          // same list, and two spellings would drift the first time M2 adds an
          // arm.
          .enum(PREDICATE_CARDINALITIES)
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
 * and never touch the AI SDK, and a later, better extractor replaces this one
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
  // Truncation is SIGNALLED, not silent, in both directions: the model is told
  // the text was cut (so it does not confidently extract from a clause that
  // ends mid-sentence) and the operator is told which episode lost a tail.
  // The episode is stamped after this pass, so whatever is dropped here is
  // dropped for good — which is precisely why it cannot be quiet.
  const truncated = body.length > MAX_BODY_CHARS;
  if (truncated) {
    log.warn(
      {
        workspaceId: episode.workspaceId,
        episodeId: episode.id,
        bodyChars: body.length,
        cap: MAX_BODY_CHARS,
      },
      "brain extraction: episode body exceeds the per-call cap — extracting from the leading portion only, the remainder is not revisited",
    );
  }
  const excerpt = truncated
    ? `${body.slice(0, MAX_BODY_CHARS)}\n[truncated at ${MAX_BODY_CHARS} characters]`
    : body;

  const { object } = await generateObject({
    model,
    schema: ExtractionSchema,
    system: EXTRACTION_SYSTEM_PROMPT,
    // Pinned. The reconcile stage's corroboration dedupe is BYTE-EXACT on the
    // SPO, so a re-extraction that paraphrases its own earlier output mints a
    // duplicate belief instead of strengthening one — and re-extraction is
    // routine here (it is the whole crash-safety story). Determinism is not a
    // quality preference; it is what makes idempotence real.
    temperature: 0,
    prompt: [
      `Source: ${episode.source}`,
      episode.occurredAt !== null ? `Said at: ${episode.occurredAt.toISOString()}` : null,
      "",
      "Message:",
      excerpt,
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
 * Returns `null` for EVERY state in which this fiber must not call a model on
 * this workspace's behalf — a config that cannot be read, a config that cannot
 * be built into a model, or a deployment where the routing subsystem that owns
 * BYO configs is supposed to be present and is not. The caller leaves those
 * episodes queued and counts the skip; repairing the key (or the deployment) is
 * enough to drain them, with no backfill.
 *
 * ## Why the refusal is BROADER than `runAgent`'s
 *
 * The resolution ORDER is the agent's (`lib/agent.ts` — workspace config first,
 * platform default second, one seam, no second credential path). The refusal is
 * deliberately not: `runAgent` hard-refuses only a decrypt failure and
 * log-and-falls-through on everything else, because there is a user in the loop
 * who sees the degraded turn. Here there is nobody, the work is unattended and
 * repeats every five minutes, and a queued episode is free to hold — so any
 * ambiguity resolves to "don't spend, wait".
 *
 * Two ways that matters concretely, both of which billed the platform for a
 * BYO workspace in an earlier draft of this function:
 *
 *   - **EE absent when it should be present.** The no-op `ModelRouter` returns
 *     `null` for every workspace, which is indistinguishable from "this
 *     workspace has no BYO config" — so an EE module that failed to load would
 *     have silently moved every BYO workspace's whole backlog onto Atlas's own
 *     key. Probed explicitly, exactly as the BYOT catalog refresh does.
 *   - **A config that reads but cannot be built.** `getModelFromWorkspaceConfig`
 *     throws on a malformed bedrock bundle, a missing `baseUrl`, a gateway row
 *     with no key; `getModel()` throws when the platform provider is
 *     unconfigured. Left outside the guard those escaped as a per-episode
 *     throw — counted as a transient failure and retried forever, which is the
 *     wrong verdict for a fault only an admin can fix.
 */
export async function resolveExtractionModel(
  workspaceId: string,
): Promise<ResolvedExtractionModel | null> {
  const program = Effect.gen(function* () {
    const router = yield* ModelRouter;
    // `available: false` on an enterprise deployment means the EE layer did not
    // load — NOT that this workspace has no BYO config. Fail closed on the one
    // that cannot be told apart downstream. On a self-hosted install (no EE by
    // design) the flag is legitimately false and the platform default is the
    // right answer, so the probe is gated on the deploy-mode mirror in core.
    if (isEnterpriseEnabled() && !router.available) return { routingUnavailable: true } as const;
    const config = yield* router.getWorkspaceModelConfigRaw(workspaceId);
    return { routingUnavailable: false, config } as const;
  });

  let resolved: { routingUnavailable: boolean; config?: RawWorkspaceModelConfig | null };
  try {
    resolved = await runEnterprise(program);
  } catch (err) {
    log.warn(
      { workspaceId, err: errorMessage(err) },
      "brain extraction: workspace model config could not be read — leaving this workspace's episodes queued",
    );
    return null;
  }

  if (resolved.routingUnavailable) {
    log.error(
      { workspaceId },
      "brain extraction: model routing is unavailable on an enterprise deployment — refusing to extract on the platform key, episodes stay queued",
    );
    return null;
  }

  const config = resolved.config ?? null;
  try {
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
  } catch (err) {
    log.warn(
      { workspaceId, byo: config !== null, err: errorMessage(err) },
      "brain extraction: the configured model could not be built — leaving this workspace's episodes queued until the configuration is repaired",
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// The cycle
// ---------------------------------------------------------------------------

/** Why an episode was left alone this pass. */
export const EXTRACTION_SKIP_REASONS = [
  /** The workspace's own model config could not be used — retried next cycle. */
  "model_unavailable",
  /** Stored by reference (`locator`), which M1 has no fetcher for. Stamped. */
  "no_body",
  /**
   * Failed on every recent attempt, so this process has stopped calling a model
   * for it — see {@link QUARANTINE_AFTER_FAILURES}. Still queued; still retried
   * after a restart.
   */
  "quarantined",
] as const;

export type ExtractionSkipReason = (typeof EXTRACTION_SKIP_REASONS)[number];

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
  /**
   * Episodes refused WHOLESALE by the episode-level gate (no grant, no
   * attributable actor). Counted apart from `extracted` on purpose: a batch
   * reporting `extracted: 25, factsCreated: 0` reads as a quiet model, whereas
   * `blockedEpisodes: 25` reads as "our grant derivation is broken", which is
   * what it would actually mean.
   */
  blockedEpisodes: number;
  /** By reason — a `Record` so a new reason is a compile error, not a miscount. */
  skipped: Record<ExtractionSkipReason, number>;
  /** Episodes whose pass threw — left queued for the next cycle. */
  failed: number;
  /** Present only on the scan-fault path, mirroring the other DB cycles. */
  error?: string;
}

type EpisodeOutcome =
  | { readonly kind: "extracted"; readonly report: ReconcileReport }
  | { readonly kind: "blocked"; readonly reason: ReconcileBlockReason }
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
    blockedEpisodes: 0,
    // Fresh per call — `runPeriodicDbCycle` mutates the result in place, so a
    // shared object would accumulate across ticks.
    skipped: { model_unavailable: 0, no_body: 0, quarantined: 0 },
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
    applyRow: (row) => extractEpisode(row, { extract, modelFor, reconcile, now, failures: failureLedger }),
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
  /** Consecutive-failure ledger for this process — see the quarantine note. */
  readonly failures: Map<string, number>;
}

/** Extract → reconcile → stamp, for one episode. */
async function extractEpisode(row: EpisodeRow, deps: ApplyDeps): Promise<EpisodeOutcome> {
  // `visible_to` is `text[] NOT NULL` (0180), so a non-array here is QUERY
  // DRIFT — a changed SELECT, a driver surprise — not bad tenant data. Coercing
  // it to `[]` would assert "this episode grants nobody", which the reconcile
  // stage would then refuse as NO_GRANT and this function would STAMP: a code
  // bug permanently consuming every episode in the batch, logged under a
  // message blaming the tenant's grant. Refused as a retryable failure instead,
  // and named for what it is. (`promotion.ts` splits the same two causes into
  // `GRANT_NOT_AN_ARRAY` vs `GRANT_UNUSABLE` for this exact reason.)
  if (!isUnknownArray(row.visible_to)) {
    log.error(
      {
        workspaceId: row.workspace_id,
        episodeId: row.id,
        received: typeof row.visible_to,
      },
      "brain extraction: an episode's grant did not load as an array — this is an Atlas bug, not a problem with the episode; leaving it queued",
    );
    return { kind: "failed", error: "visible_to did not load as an array" };
  }

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

  // Pre-flight the episode-level gate BEFORE spending a model call. The stage
  // enforces it again regardless; running it here is purely so an episode whose
  // grant or actor makes every derived claim unsafe costs nothing rather than
  // one LLM call per pass. Stamped, because blocking is a DECISION and not a
  // failure — retrying it forever would re-log the same refusal every five
  // minutes and hold a queue slot. The evidence itself is never deleted, so a
  // later slice (a repaired grant derivation, #4801's membership sync) can
  // re-queue it deliberately.
  const episodeBlock = classifyEpisodeForReconcile(episode);
  if (episodeBlock !== null) {
    log.warn(
      {
        workspaceId: episode.workspaceId,
        episodeId: episode.id,
        source: episode.source,
        reason: episodeBlock.reason,
      },
      `brain extraction: no fact can safely be drawn from this episode — ${episodeBlock.detail}; marking it extracted without calling a model`,
    );
    await stampExtracted(episode);
    return { kind: "blocked", reason: episodeBlock.reason };
  }

  // An episode that has failed on every recent attempt stops costing model
  // calls. In-memory and per-process, matching the BYOT catalog refresh's
  // backoff precedent ("pod restart resets the backoff state — acceptable
  // trade-off vs the migration that a persistent counter would require"), and
  // deliberately NOT a stamp: "failed three times in this process" is not proof
  // of "unextractable forever", and stamping on a guess is the silent drop this
  // module's ordering exists to avoid. It still holds a queue slot — the bound
  // is on SPEND, not on the head of the queue. The ERROR log is the operator's
  // cue that a slot is stuck.
  const priorFailures = deps.failures.get(episode.id) ?? 0;
  if (priorFailures >= QUARANTINE_AFTER_FAILURES) {
    return { kind: "skipped", reason: "quarantined" };
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
  deps.failures.delete(episode.id);
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
 * mid-transaction. `visible_to`'s ELEMENTS are passed through untouched —
 * `parseGrant` is built to read them straight off the driver, `null` entries and
 * all. Whether the column loaded as an array at all is settled by the caller,
 * which refuses the episode rather than coercing (see `extractEpisode`).
 */
function toEpisodeRef(row: EpisodeRow): ReconcileEpisodeRef {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    source: row.source,
    sourceId: row.source_id,
    sourceActor: row.source_actor,
    occurredAt: toDate(row.occurred_at),
    // Non-array is unreachable here: `extractEpisode` refuses the row first.
    visibleTo: isUnknownArray(row.visible_to) ? row.visible_to : [],
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
    case "blocked": {
      result.blockedEpisodes++;
      return;
    }
    case "skipped": {
      // Indexed, not branched: adding a reason to EXTRACTION_SKIP_REASONS
      // cannot silently land in the wrong counter.
      result.skipped[outcome.reason]++;
      return;
    }
    case "failed": {
      result.failed++;
      const failures = (failureLedger.get(row.id) ?? 0) + 1;
      // Evict oldest-first (insertion order) rather than refusing to record —
      // dropping the NEW entry would make the cap silently disable quarantine
      // for exactly the pathological backlog it exists to survive.
      if (!failureLedger.has(row.id) && failureLedger.size >= FAILURE_LEDGER_CAP) {
        const oldest = failureLedger.keys().next();
        if (!oldest.done) failureLedger.delete(oldest.value);
      }
      failureLedger.set(row.id, failures);
      if (failures === QUARANTINE_AFTER_FAILURES) {
        // ERROR, once, at the threshold: from here the episode holds a queue
        // slot but costs nothing, and only an operator can tell whether that is
        // a bad message or a broken model.
        log.error(
          { workspaceId: row.workspace_id, episodeId: row.id, failures, err: outcome.error },
          "brain extraction: episode has failed every attempt in this process — no further model calls will be made for it until a restart",
        );
        return;
      }
      // Per-episode, at warn: the episode stays queued, so this is a retry
      // notice rather than an outage — but an id-less "3 failed" in the cycle
      // row would leave an operator nothing to look at.
      log.warn(
        { workspaceId: row.workspace_id, episodeId: row.id, failures, err: outcome.error },
        "brain extraction: episode extraction failed — it stays on the queue and will be retried",
      );
      return;
    }
    default: {
      const unexpected: never = outcome;
      throw new Error(`Unhandled episode outcome: ${JSON.stringify(unexpected)}`);
    }
  }
}

/**
 * The cycle-level audit row. Emitted on EVERY terminal path (including the
 * no-database and empty ones), so its ABSENCE over a window is the "the fiber
 * stopped" signal — the same forensic invariant the BYOT refresh cycle carries.
 */
function emitCycleAudit(result: BrainExtractionCycleResult): void {
  // The third guard on a call that is already contracted never to throw
  // (`logAdminAction`) and already wrapped by the cycle skeleton. Kept for
  // parity with `byot-catalog-refresh.ts`, whose own comment calls this
  // belt-and-braces at the seam — not because the call is known to be risky.
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
