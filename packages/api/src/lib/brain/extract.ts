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
 * of N slots until something takes it off the queue. An episode is stamped once
 * its extraction pass COMPLETES — including a pass that found no claim at all,
 * which is the common case and must not head-of-line block on small talk. Two
 * further classes are stamped without ever calling a model, and both are
 * DECISIONS rather than guesses: a by-reference episode M1 has no fetcher for,
 * and an episode the reconcile gate refuses wholesale. Only a pass that THREW
 * retries.
 *
 * A deterministically-failing episode therefore keeps its slot indefinitely —
 * stamping it would be a silent drop on a guess, which is the thing this
 * module's whole ordering avoids. What IS bounded is the SPEND: after
 * {@link QUARANTINE_AFTER_FAILURES} consecutive failures the episode moves to a
 * widening probe backoff and logs at ERROR, so it costs at most one model call
 * per window instead of one per tick — PER PROCESS. The ledger is in-memory and
 * this fiber has no leader election, so a fleet of R replicas each runs its own
 * ramp: read every spend figure here as ×R on SaaS. So the honest statement of the bound is:
 * N permanently-failing episodes at the head of the queue WOULD starve it,
 * cheaply and loudly, until an operator acts on the recurring error.
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
 * episode every tick. Bounds SPEND on a deterministically-failing episode (a
 * body that always trips a content filter, a model id that 404s) without
 * pretending a few failures prove permanence.
 */
const QUARANTINE_AFTER_FAILURES = 3;

/**
 * First probe interval after quarantine, doubling per subsequent failure up to
 * {@link QUARANTINE_PROBE_MAX_SHIFT}.
 *
 * Quarantine is PROBING, not absorbing, and the difference is the whole design.
 * An absorbing quarantine has one exit — a process restart — and the only
 * evidence available to enter it is "failed three times", which a fifteen-minute
 * provider outage produces just as readily as a poisoned body. So an absorbing
 * version would let a transient upstream fault permanently disable extraction
 * fleet-wide, silently, until someone redeployed. Backing off and re-probing
 * costs one model call per episode per window and makes a repaired model
 * self-healing.
 */
const QUARANTINE_PROBE_BASE_MS = 30 * 60 * 1000;

/** Backoff ceiling: 2^5 × 30 min = 16 h between probes. */
const QUARANTINE_PROBE_MAX_SHIFT = 5;

/**
 * Re-emit the quarantine ERROR every Nth failure.
 *
 * Its OWN constant rather than a reuse of {@link QUARANTINE_AFTER_FAILURES}:
 * they answer different questions, and tuning the threshold for spend would
 * otherwise silently retune the log cadence — at the 16 h probe ceiling, a
 * threshold of 10 would mean one ERROR every six days.
 */
const QUARANTINE_ERROR_EVERY = 3;

/**
 * What the ledger remembers about one struggling episode.
 *
 * `readonly` because every write replaces the whole entry: an in-place
 * `entry.failures++` would advance the count while leaving `lastFailureAt`
 * describing an older failure, and the backoff reads both.
 */
interface QuarantineEntry {
  readonly failures: number;
  /** Epoch ms of the most recent failure — the backoff window's origin. */
  readonly lastFailureAt: number;
  /**
   * True once this episode's strike has been forgiven as an outage.
   *
   * THE cap that keeps the outage refund from being self-fulfilling. A failing
   * episode is never stamped, so it stays at the head of the drain — and once
   * the healthy episodes ahead of it have drained, "every episode this tick
   * failed" is simply what a poisoned queue looks like, every tick, forever. An
   * uncapped refund therefore un-charges the same strikes it just charged and
   * quarantine can never be reached: measured over a simulated day, two
   * poisoned episodes went from 25 model calls total to 576 and climbing.
   *
   * Forgiving each episode exactly ONCE keeps both properties: a genuine outage
   * costs every episode zero net strikes on its first bad tick, and a
   * deterministically-failing batch still ratchets into quarantine one tick
   * later than it otherwise would.
   */
  readonly refunded?: true;
}

/**
 * Episode id → consecutive-failure state, for the life of the process.
 *
 * Module-level so it survives across ticks, in-memory so it needs no migration
 * — the same trade the BYOT catalog refresh made for its backoff state. A
 * restart forgives everything, which is the forgiving direction: the cost of
 * forgetting is one retry, the cost of a persisted give-up would be a claim
 * nobody re-examines. Bounded by {@link FAILURE_LEDGER_CAP} so a pathological
 * backlog cannot grow it without limit.
 */
const failureLedger = new Map<string, QuarantineEntry>();

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
 *     key. Probed explicitly, as the BYOT catalog refresh does — with one
 *     difference: it probes unconditionally and caches the verdict per pod,
 *     while this gates the probe on `isEnterpriseEnabled()` so a self-hosted
 *     install (legitimately `available: false`, no EE by design) still gets the
 *     platform default rather than a permanent refusal.
 *   - **A config that reads but cannot be built.** `getModelFromWorkspaceConfig`
 *     throws on a malformed bedrock bundle, a missing `baseUrl`, a gateway row
 *     with no key; `getModel()` throws when the platform provider is
 *     STRUCTURALLY unconfigured (gateway with no key, openai-compatible with no
 *     base URL — a merely missing anthropic/openai key still surfaces at call
 *     time and lands in the failure ledger instead). Left outside the guard
 *     those escaped as a per-episode throw — counted as a transient failure and
 *     retried forever, which is the wrong verdict for a fault only an admin can
 *     fix.
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

  // A UNION, not a widened record. `{ routingUnavailable: boolean; config?: … }`
  // makes `{ routingUnavailable: false }` with no `config` representable — and
  // that value falls straight through to `getModel()` below, which is the
  // "silently bill the platform key for a BYO workspace" failure this whole
  // function exists to prevent. The producer already returns the union; only
  // the annotation was throwing it away.
  type RoutingProbe =
    | { readonly routingUnavailable: true }
    | { readonly routingUnavailable: false; readonly config: RawWorkspaceModelConfig | null };

  let resolved: RoutingProbe;
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

  // No `?? null` — past the gate above the union guarantees the field.
  const config = resolved.config;
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
    // ERROR, matching the routing-unavailable arm: a config that reads but
    // cannot be built is non-transient by definition, and every tick from here
    // stalls this workspace's whole backlog until a human edits configuration.
    // (The READ failure above stays `warn` — a decrypt or an internal-DB blip
    // can clear on its own.)
    log.error(
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
   * Failed on every recent attempt, so this tick did not call a model for it —
   * see {@link QUARANTINE_AFTER_FAILURES}. Still queued, and re-probed once the
   * widening backoff elapses, so a repaired model heals it without a restart.
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
  /**
   * Which refusal, by reason. `blockedEpisodes: 25` says grant derivation might
   * be broken; this says whether it is the grant or the actor — the difference
   * between two very different investigations, and free to record.
   */
  blocked: Record<ReconcileBlockReason, number>;
  /** By reason — a `Record` so a new reason is a compile error, not a miscount. */
  skipped: Record<ExtractionSkipReason, number>;
  /** Episodes whose pass threw — left queued for the next cycle. */
  failed: number;
  /**
   * Strikes forgiven this tick because every attempted episode failed.
   *
   * Nonzero says "we chose not to count this against the episodes", which is
   * exactly the state an operator needs distinguished from "nothing was wrong"
   * when asking why quarantine has not engaged.
   */
  outageRefunded: number;
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
    outageRefunded: 0,
    // Fresh per call — `runPeriodicDbCycle` mutates the result in place, so a
    // shared object would accumulate across ticks.
    blocked: {
      NO_PROVENANCE: 0,
      NO_GRANT: 0,
      SOURCE_PRINCIPAL_UNRESOLVED: 0,
      MALFORMED_CLAIM: 0,
    },
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

  // `Effect.suspend` so the per-tick mutable state below is allocated per RUN
  // rather than per construction. The scheduler builds a fresh Effect every tick
  // today, so this is belt-and-braces — but hoisting that call to a `const` is
  // an obviously-equivalent-looking refactor that would silently turn the model
  // cache into a process-lifetime one and make `charged` cumulative across
  // ticks, un-charging strikes from rows a later tick never touched.
  return Effect.suspend(() => {
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

    // ONE binding, threaded into both halves — `extractEpisode` reads it and
    // `tallyEpisode` writes it, and they have to be the same object.
    const failures = failureLedger;
    const charged: { episodeId: string; workspaceId: string }[] = [];

    /**
     * Forgive one strike each when the whole tick failed, then emit the cycle
     * row.
     *
     * An OUTAGE is not evidence about any episode. When every episode a tick
     * attempted failed, the common cause is upstream — a provider 5xx, a
     * rate-limit storm, an exhausted pool — and charging each one a strike would
     * quarantine a batch of perfectly good episodes after three bad ticks.
     * Cheaper and more honest than classifying individual errors: if none of
     * them worked, blame the world, not the rows. A single failing row among
     * successes is still charged, and the per-episode `refunded` cap keeps a
     * genuinely poisoned batch from being forgiven forever.
     *
     * FUSED with the audit emit deliberately: the skeleton calls
     * `emitCycleAudit` after the last row and before returning, which is the
     * only hook that runs with the tick's full verdict in hand and still ahead
     * of the audit write. Refunding afterwards would leave every audit row
     * claiming `outageRefunded: 0` — a lie in the one place an operator reads
     * it.
     */
    const settleAndAudit = (result: BrainExtractionCycleResult): void => {
      // Only outcomes that ACTUALLY called a model are evidence about the
      // model. A pre-flight block is reached before `modelFor`, so counting it
      // here would let one workspace's un-attributable actors silently disable
      // the outage refund for the whole fleet.
      const attempted = result.failed + result.extracted;
      if (charged.length > 0 && result.failed === attempted) {
        let refunded = 0;
        for (const { episodeId } of charged) {
          const entry = failures.get(episodeId);
          if (entry === undefined || entry.refunded === true) continue;
          refunded++;
          // Decremented to zero, NEVER deleted. Deleting would discard the
          // `refunded` marker with the entry, so the next tick would forgive the
          // same episode again — and again — which is the uncapped behaviour
          // this cap exists to prevent. A zero-failure entry is inert
          // (`isQuarantined` is false) and is cleared for real by any path that
          // stamps the episode.
          failures.set(episodeId, {
            ...entry,
            failures: entry.failures - 1,
            refunded: true,
          });
        }
        if (refunded > 0) {
          result.outageRefunded = refunded;
          log.warn(
            {
              attempted,
              refunded,
              // Genuinely workspaces, not episode ids. The two differ, and the
              // difference is the discriminator that matters: an upstream
              // outage crosses tenants, one bad body class does not.
              workspaces: new Set(charged.map((c) => c.workspaceId)).size,
            },
            "brain extraction: every episode this tick failed — forgiving one strike each rather than counting an upstream outage against the episodes",
          );
        } else {
          // The third state, and the one an operator investigating "why did my
          // whole backlog just quarantine" needs most: a total-failure tick
          // whose strikes we deliberately let stand because every episode had
          // already spent its one refund. Without this it renders as
          // `outageRefunded: 0` — byte-identical to a mixed tick.
          log.warn(
            {
              attempted,
              charged: charged.length,
              workspaces: new Set(charged.map((c) => c.workspaceId)).size,
            },
            "brain extraction: every episode this tick failed, but each had already spent its one outage refund — the strikes stand and quarantine will engage",
          );
        }
      }
      charged.length = 0;
      emitCycleAudit(result);
    };

    return runPeriodicDbCycle<EpisodeRow, EpisodeOutcome, BrainExtractionCycleResult>({
      log,
      label: "Brain extraction",
      emptyResult,
      failureResult: (error) => ({ ...emptyResult(), status: "failure", error }),
      scan: () => internalQuery<EpisodeRow>(DRAIN_EPISODES_SQL, [BATCH_SIZE]),
      applyRow: (row) => extractEpisode(row, { extract, modelFor, reconcile, now, failures }),
      defectOutcome: (error) => ({ kind: "failed", error }),
      tally: (result, row, outcome) => tallyEpisode(result, row, outcome, failures, now, charged),
      emitCycleAudit: settleAndAudit,
    });
  });
}

interface ApplyDeps {
  readonly extract: FactExtractor;
  readonly modelFor: (workspaceId: string) => Promise<ResolvedExtractionModel | null>;
  readonly reconcile: typeof reconcileFacts;
  readonly now: () => Date;
  /**
   * Consecutive-failure ledger — see the quarantine note. THE SAME map the
   * tally writes to: `runBrainExtractionCycle` binds one object into both
   * halves, because a ledger read through one map and written through another
   * would leave quarantine permanently disarmed with nothing to notice it.
   */
  readonly failures: Map<string, QuarantineEntry>;
}

/**
 * Is this episode inside its quarantine backoff window? Reading and writing the
 * ledger stay in this file's two halves — see {@link ApplyDeps.failures}.
 */
function isQuarantined(entry: QuarantineEntry | undefined, now: Date): boolean {
  if (entry === undefined || entry.failures < QUARANTINE_AFTER_FAILURES) return false;
  const shift = Math.min(entry.failures - QUARANTINE_AFTER_FAILURES, QUARANTINE_PROBE_MAX_SHIFT);
  return now.getTime() - entry.lastFailureAt < QUARANTINE_PROBE_BASE_MS * 2 ** shift;
}

/** Extract → reconcile → stamp, for one episode. */
async function extractEpisode(row: EpisodeRow, deps: ApplyDeps): Promise<EpisodeOutcome> {
  // FIRST, before any other work: a quarantined episode should cost nothing at
  // all this tick, not merely no model call. (It was below the grant guard
  // once, which meant a permanently-drifted row re-logged an ERROR every five
  // minutes forever.) Falling THROUGH once the backoff elapses is what keeps
  // quarantine a backoff rather than a terminal state — a repaired model heals
  // itself without a redeploy.
  if (isQuarantined(deps.failures.get(row.id), deps.now())) {
    return { kind: "skipped", reason: "quarantined" };
  }
  // `visible_to` is `text[] NOT NULL` (0180), so a non-array here is QUERY
  // DRIFT — a changed SELECT, a driver surprise — not bad tenant data. Coercing
  // it to `[]` would assert "this episode grants nobody", which the reconcile
  // stage would then refuse as NO_GRANT and this function would STAMP: a code
  // bug permanently consuming every episode in the batch, logged under a
  // message blaming the tenant's grant. Refused as a retryable failure instead,
  // and named for what it is. (`promotion.ts` splits the same two causes into
  // `GRANT_NOT_AN_ARRAY` vs `GRANT_UNUSABLE` for this exact reason.)
  const visibleTo = row.visible_to;
  if (!isUnknownArray(visibleTo)) {
    log.error(
      {
        workspaceId: row.workspace_id,
        episodeId: row.id,
        received: typeof visibleTo,
      },
      "brain extraction: an episode's grant did not load as an array — this is an Atlas bug, not a problem with the episode; leaving it queued",
    );
    return { kind: "failed", error: "visible_to did not load as an array" };
  }

  const episode = toEpisodeRef(row, visibleTo);

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
    deps.failures.delete(episode.id);
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
    deps.failures.delete(episode.id);
    return { kind: "blocked", reason: episodeBlock.reason };
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

  // The stage refused the whole episode despite our pre-flight passing. It
  // cannot happen while this path passes no `sourcePrincipal` (the two gates
  // then see identical inputs) — but `ReconcileRequest` exists to let a caller
  // supply one, and the moment anything here does, an unread `episodeBlocked`
  // would be recorded as a successful extraction and STAMPED: a safety refusal
  // permanently consuming the evidence, counted as success. Read it instead.
  if (report.episodeBlocked !== undefined) {
    log.error(
      {
        workspaceId: episode.workspaceId,
        episodeId: episode.id,
        reason: report.episodeBlocked,
      },
      "brain extraction: the reconcile stage refused this episode after the pre-flight passed — the two gates disagreed, which is an Atlas bug; leaving it queued",
    );
    // `failed`, NOT `blocked`. Everywhere else in this file `blocked` means "a
    // stamped decision"; this path is unstamped and re-attempted, so labelling
    // it `blocked` would route it around the failure ledger and spend one model
    // call per tick forever with no bound — the exact class the ledger exists to
    // cap. Charging it a strike also makes the gate disagreement escalate.
    return {
      kind: "failed",
      error: `reconcile refused the episode post-flight: ${report.episodeBlocked}`,
    };
  }

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
 * all. Whether the column loaded as an ARRAY is settled before this call and
 * arrives as an argument, deliberately: read off `row` it needed a `?? []`
 * fallback here, and that fallback silently asserts "grants nobody", which
 * reconcile blocks as NO_GRANT and the caller then STAMPS. As a parameter, the
 * guard in `extractEpisode` is the only way to obtain one.
 */
function toEpisodeRef(row: EpisodeRow, visibleTo: readonly unknown[]): ReconcileEpisodeRef {
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

function toDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function tallyEpisode(
  result: BrainExtractionCycleResult,
  row: EpisodeRow,
  outcome: EpisodeOutcome,
  ledger: Map<string, QuarantineEntry>,
  now: () => Date,
  /** Episodes charged a strike this tick — the outage rollback's working set. */
  charged: { episodeId: string; workspaceId: string }[],
): void {
  switch (outcome.kind) {
    case "extracted": {
      result.extracted++;
      result.factsCreated += outcome.report.created;
      result.factsCorroborated += outcome.report.corroborated;
      result.factsProvisional += outcome.report.provisional;
      // Fold the per-reason breakdown rather than only its sum: `factsBlocked:
      // 12` says candidates were refused, `blocked.MALFORMED_CLAIM: 12` says the
      // extractor is emitting empty triples, and those send an investigation to
      // different files.
      for (const [reason, count] of Object.entries(outcome.report.blocked)) {
        result.blocked[reason as ReconcileBlockReason] += count;
        result.factsBlocked += count;
      }
      return;
    }
    case "blocked": {
      result.blockedEpisodes++;
      result.blocked[outcome.reason]++;
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
      const entry = ledger.get(row.id);
      const failures = (entry?.failures ?? 0) + 1;
      // `delete` before `set` so insertion order tracks RECENCY: `Map.set` on an
      // existing key leaves it in place, which would make the cap evict the
      // longest-failing entry — the one whose count is doing the most work.
      ledger.delete(row.id);
      if (ledger.size >= FAILURE_LEDGER_CAP) {
        // Unreachable while the drain is `LIMIT BATCH_SIZE` over a queue whose
        // head never advances past a failure — the ledger cannot exceed
        // BATCH_SIZE. Stated because a future drain change (a bigger batch, a
        // workspace-fair walk) wakes this branch up, and it must not wake up
        // silently.
        //
        // Evict by OLDEST FAILURE, not by insertion order: a quarantined entry
        // is skipped rather than re-`set`, so its insertion position freezes at
        // the front and insertion-order eviction would drop the DEEPEST backoff
        // first — silently disarming the quarantine that was doing the most
        // work, and restoring its refund eligibility along with it.
        let victim: string | undefined;
        let oldest = Infinity;
        for (const [id, candidate] of ledger) {
          if (candidate.lastFailureAt < oldest) {
            oldest = candidate.lastFailureAt;
            victim = id;
          }
        }
        if (victim !== undefined) {
          const dropped = ledger.get(victim);
          ledger.delete(victim);
          log.warn(
            { episodeId: victim, failures: dropped?.failures, cap: FAILURE_LEDGER_CAP },
            "brain extraction: failure ledger at capacity — dropping an episode's strike history, so its quarantine is disarmed and it will be attempted every tick again",
          );
        }
      }
      ledger.set(row.id, { ...entry, failures, lastFailureAt: now().getTime() });
      charged.push({ episodeId: row.id, workspaceId: row.workspace_id });
      // Re-armed, not one-shot: the condition is ongoing, so `>=` with a modulo
      // keeps a recurring ERROR in the log instead of one archaeological line
      // that scrolled away days before anyone looked.
      if (failures >= QUARANTINE_AFTER_FAILURES && failures % QUARANTINE_ERROR_EVERY === 0) {
        // The deadline, not just the policy. Repairing the cause does NOT
        // shorten the current window, so an operator who fixes a broken model
        // and watches nothing happen needs to know whether the fiber is dead or
        // merely waiting — and until when.
        const shift = Math.min(
          failures - QUARANTINE_AFTER_FAILURES,
          QUARANTINE_PROBE_MAX_SHIFT,
        );
        const nextProbeAt = new Date(
          now().getTime() + QUARANTINE_PROBE_BASE_MS * 2 ** shift,
        ).toISOString();
        log.error(
          { workspaceId: row.workspace_id, episodeId: row.id, failures, nextProbeAt, err: outcome.error },
          "brain extraction: episode keeps failing — it holds a queue slot and is next retried at nextProbeAt; fixing the cause does not shorten that window, restart the process to retry sooner",
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
      // Deep-ish copy of the two counter records: `{ ...result }` alone would
      // ALIAS them, so a future skeleton that emitted mid-cycle would log a
      // snapshot that keeps changing after it was taken.
      metadata: { ...result, blocked: { ...result.blocked }, skipped: { ...result.skipped } },
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
