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
 * That "no-op" is conditional and the condition is ours to hold: dedupe is on
 * the claim's SLOT KEY (`alias(lexicalNorm(surface))` since #5020), so it
 * collapses a re-extraction only if the model reproduces its own output closely
 * enough to land in the same slot. That is looser than the byte-exactness it
 * replaced — a re-phrasing differing only in case or separators now collapses —
 * and nowhere near loose enough to absorb "is" vs "is on".
 * `llmFactExtractor` therefore still pins `temperature: 0`.
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
 * A deterministically-failing episode therefore keeps its ROW indefinitely —
 * stamping it would be a silent drop on a guess, which is the thing this
 * module's whole ordering avoids. Two separate bounds keep that affordable, and
 * conflating them is how the second one went missing for a while:
 *
 *   - **Spend.** After {@link QUARANTINE_AFTER_FAILURES} consecutive failures
 *     the episode moves to a widening probe backoff and logs at ERROR, so it
 *     costs at most one model call per window instead of one per tick — PER
 *     PROCESS. The ledger is in-memory and this fiber has no leader election, so
 *     a fleet of R replicas each runs its own ramp: read every spend figure here
 *     as ×R on SaaS.
 *   - **Throughput.** Quarantine alone does NOT stop a poisoned episode holding
 *     a slot: the skip used to happen after the row had already been selected,
 *     so past `BATCH_SIZE` poisoned episodes at the head, every tick selected the
 *     same full batch, skipped all of it for free, and drained nothing — for
 *     every workspace in the deployment. The drain now excludes backing-off ids
 *     (`$2`), so the batch bound means "25 episodes we will actually try". See
 *     {@link DRAIN_EPISODES_SQL}.
 *
 * So the honest statement of the bound is: permanently-failing episodes cost one
 * probe per window each and are loudly logged until an operator acts, and they
 * no longer block the episodes queued behind them while that happens.
 */

import { Effect } from "effect";
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
import { getBatchApiKey, getExtractionModel } from "@atlas/api/lib/providers";
import type { RawWorkspaceModelConfig } from "@atlas/api/lib/auth/credentials";
import {
  classifyEpisodeForReconcile,
  reconcileFacts,
  type EntityResolver,
  type FactCandidate,
  type ReconcileBlockReason,
  type ReconcileEpisodeRef,
  type ReconcileReport,
} from "@atlas/api/lib/brain/reconcile";
import type { ClaimVocabulary } from "@atlas/api/lib/brain/identity";
import { entityStoreResolver } from "@atlas/api/lib/brain/entity-store";
import { loadWorkspaceVocabulary } from "@atlas/api/lib/brain/vocabulary";
import { proposeAliasesFromCorpus } from "@atlas/api/lib/brain/alias-proposal";
import {
  collectBatchPhase,
  submitBatchPhase,
  DEFAULT_BATCH_CLIENT,
  DEFAULT_BATCH_LEDGER,
  type BatchClient,
  type BatchLedger,
  type BatchPhaseDeps,
} from "@atlas/api/lib/brain/extract-batch";
import {
  BRAIN_EXTRACTION_PRODUCER,
  EXTRACTION_SYSTEM_PROMPT,
  ExtractionSchema,
  extractionExcerpt,
  extractionPrompt,
  toEpisodeRef,
  toFactCandidates,
  type BrainExtractionBatchTally,
  type EpisodeRow,
  type PrecomputedExtraction,
  type ResolvedExtractionModel,
} from "@atlas/api/lib/brain/extract-contract";

const log = createLogger("brain.extract");

/**
 * Reserved system actor for every audit row this fiber writes. Matches
 * `^system:[a-z0-9][a-z0-9_-]*$` (`assertSystemActor`); a rename surfaces as
 * broken forensic queries.
 */
export const BRAIN_EXTRACTION_ACTOR = "system:brain-extraction" as const;

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
/**
 * Exported for tests, which must not hardcode it.
 *
 * The poisoned-head `-pg` scenario has to fill an entire batch to prove the
 * exclusion works. With the value copied into the test, raising it here makes
 * the poison block stop filling the batch — the healthy row is then selected
 * WITHOUT the exclusion doing anything, so the test passes vacuously and the
 * stall regression is restored silently. One-directional failure, which is the
 * kind worth spending an export on.
 */
export const BATCH_SIZE = 25;

/** Per-episode model call budget. */
const EXTRACTION_TIMEOUT_MS = 60_000;

/**
 * Consecutive failures after which this process stops calling a model for an
 * episode every tick. Bounds SPEND on a deterministically-failing episode (a
 * body that always trips a content filter, a model id that 404s) without
 * pretending a few failures prove permanence.
 */
export const QUARANTINE_AFTER_FAILURES = 3;

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
export const QUARANTINE_PROBE_BASE_MS = 30 * 60 * 1000;

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
export interface QuarantineEntry {
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

/**
 * Should this tick SUBMIT through the batch endpoint? (#5352)
 *
 * Read per TICK rather than once at registration, unlike
 * {@link isBrainExtractionEnabled} — the fiber runs either way, and this only
 * chooses how one tick spends. That is what lets an operator turn it off the
 * moment something looks wrong without a restart.
 *
 * ⚠️ **The COLLECT phase deliberately does not consult this.** Batches already
 * submitted keep being collected whatever this says: their cost is sunk, their
 * results are the workspace's facts, and abandoning paid-for work because a
 * config flag flipped is the expensive direction of a mistake that is otherwise
 * free to make.
 */
export function isBrainExtractionBatchEnabled(): boolean {
  return getSettingAuto("ATLAS_BRAIN_EXTRACTION_BATCH_ENABLED") === "true";
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
 *
 * ## `$2` — why the backing-off episodes are excluded HERE and not skipped later
 *
 * Quarantine (see {@link QUARANTINE_AFTER_FAILURES}) bounds what a poisoned
 * episode COSTS. On its own it does not bound what a poisoned episode BLOCKS,
 * and those are different properties: a failing episode is never stamped, so it
 * stays at the head of this queue forever, and `extractEpisode` used to skip it
 * only AFTER it had already consumed one of the `LIMIT $1` slots. Past
 * `BATCH_SIZE` poisoned episodes at the head — one workspace's content filter,
 * one 404ing model — every tick selected the same full batch, skipped all of it
 * for free, and drained NOTHING. Cheap, silent, and total: the healthy episodes
 * behind them belong to every other workspace and source in the deployment.
 *
 * Excluding them at the query is what makes the batch bound mean "25 episodes
 * we will actually try". The list is the ledger's currently-backing-off ids, so
 * an episode whose probe window has elapsed is deliberately NOT in it — it gets
 * selected, probed, and heals itself, which is the whole point of quarantine
 * being a backoff rather than a terminal state. The array is bounded by
 * {@link FAILURE_LEDGER_CAP}, and `id <> ALL('{}')` is true for every row, so
 * the empty case needs no special handling.
 *
 * That bound caps the array at 1000 uuids, which is a filter evaluated per
 * candidate row — and it is worth being straight about what it sits on top of.
 * `idx_brain_episodes_extraction_queue` is `(workspace_id, ingested_at) WHERE
 * extracted_at IS NULL`, so it does NOT serve this query's ordering: the drain
 * is deployment-wide with no `workspace_id` predicate and sorts on
 * `ingested_at` alone. That mismatch predates the exclusion and is not what the
 * exclusion introduced — but it does mean the added filter rides a scan-and-sort
 * rather than an index walk, and the honest reading of "bounded" here is
 * "bounded, on a plan that was already doing more work than the LIMIT suggests".
 * Fixing that is an index migration, deliberately not folded into a defect fix.
 *
 * `::uuid[]`, not `::text[]` — `brain_episodes.id` is a `uuid`, and Postgres
 * refuses the cross-type comparison outright (`operator does not exist: uuid <>
 * text`) rather than coercing it. That is the good direction: the whole drain
 * fails loudly on the wrong cast instead of silently matching nothing and
 * quietly re-admitting every quarantined episode.
 *
 * ## The in-flight exclusion, and why it is a JOIN rather than a NULL test (#5352)
 *
 * An episode out with a batch is `extracted_at IS NULL` and MUST stay that way:
 * work-then-stamp is what makes a lost batch cost a repeated model call instead
 * of a silently-dropped claim, and 0180 states the posture outright ("NULL
 * forever is a visible backlog, not a silent drop"). So the queue marker cannot
 * also mean "already out", and this second predicate is what stops the next tick
 * re-drafting — and re-paying for — everything the last tick submitted.
 *
 * ⚠️ The predicate is *"no batch that is still in flight"*, NOT
 * `extraction_batch_id IS NULL`, and the difference is a stranding bug rather
 * than a style choice. A collect pass settles the batch BEFORE its episodes are
 * reconciled and stamped — it has to, because the stamp happens per-episode
 * later in the same tick — so between those two points an episode is unstamped
 * AND pointed at a settled batch. On the NULL test, a crash in that window
 * (or a results set that simply omitted the episode) leaves the row excluded
 * from the drain **forever**, with nothing left to unwind it: the silent
 * permanent drop this whole module is arranged to prevent, reintroduced by the
 * cheaper predicate.
 *
 * Reading the batch's STATUS instead makes that unrepresentable: the moment a
 * batch stops being in flight, every episode of it that was not stamped is back
 * on the queue, in its original `ingested_at` position, with no sweep and no
 * repair verb. `abandonBatch` still clears the pointers — that keeps the partial
 * index small and the re-queue legible in the table — but correctness does not
 * depend on it having run.
 *
 * The cost is a `NOT EXISTS` evaluated per candidate row, which is a primary-key
 * lookup and only for rows carrying a pointer at all. On the synchronous path
 * the column is NULL for every row, so the subquery is never entered and the
 * partial index behind it holds nothing.
 */
export const DRAIN_EPISODES_SQL = `SELECT e.id, e.workspace_id, e.source, e.source_id, e.source_actor,
              e.body, e.locator, e.occurred_at, e.visible_to
         FROM brain_episodes e
        WHERE e.extracted_at IS NULL
          AND (e.extraction_batch_id IS NULL
               OR NOT EXISTS (SELECT 1
                                FROM brain_extraction_batch b
                               WHERE b.id = e.extraction_batch_id
                                 AND b.status = 'in_flight'))
          AND e.id <> ALL($2::uuid[])
        ORDER BY e.ingested_at
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
  const excerpt = extractionExcerpt(episode, body);

  const { object } = await generateObject({
    model,
    schema: ExtractionSchema,
    system: EXTRACTION_SYSTEM_PROMPT,
    // Pinned. The reconcile stage's corroboration dedupe is on the SLOT KEY
    // (#5020) — case and separators are folded, nothing semantic is — so a
    // re-extraction that PARAPHRASES its own earlier output still mints a
    // duplicate belief instead of strengthening one, and re-extraction is
    // routine here (it is the whole crash-safety story). Determinism is not a
    // quality preference; it is what makes idempotence real.
    //
    // The batch path pins the same value on the wire (`extract-batch.ts`), for
    // the same reason and with more force: a batch re-submission after an
    // abandoned batch is routine rather than exceptional.
    temperature: 0,
    prompt: extractionPrompt(episode, excerpt),
    abortSignal: AbortSignal.timeout(EXTRACTION_TIMEOUT_MS),
  });

  return toFactCandidates(object.facts, episode, modelId);
};

// ---------------------------------------------------------------------------
// Model resolution — the agent's seam for provider and credentials, this
// path's own seam for the TIER (#5353)
// ---------------------------------------------------------------------------

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
 * ## The provider is the agent's; the TIER is not (#5353)
 *
 * Provider, credentials and base URL resolve through the seam described below
 * and are unchanged. The MODEL ID does not: it comes from
 * `ATLAS_BRAIN_EXTRACTION_MODEL`, or from `providers.ts`'s ingest-tier default
 * for whichever provider that seam resolved.
 *
 * The rule, stated where it is applied rather than left as folklore: **model
 * tier follows the latency budget and the blast radius, not the subsystem.**
 * This call has a latency budget of hours (that is the whole reason this is a
 * separate fiber), runs at roughly ten times chat's volume, and its output
 * reaches a review queue as a draft rather than a person as an answer. Chat has
 * none of those properties and keeps the frontier model — deliberately, and
 * `agent.ts` is untouched by this ticket.
 *
 * It is a SETTING rather than a constant because extraction quality still bounds
 * what reaches the reviewer, and a model too weak to follow `ExtractionSchema`
 * costs human attention, which is the scarcest resource in this arc. The default
 * is cheap; the escape hatch is one key.
 *
 * ⚠️ Prompt caching does NOT apply here and is not worth attempting: the fixed
 * prefix is `EXTRACTION_SYSTEM_PROMPT` (~150 tokens) plus the serialized
 * `ExtractionSchema` (~200), well under the ~1024-token minimum cacheable
 * prefix. It would silently never cache.
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
    // The workspace's own ingest-tier override, or "" when it has none. Read
    // HERE rather than inside `providers.ts` so the settings registry stays out
    // of the provider layer, which the agent path shares — #5353's rule is that
    // the ingest tier is this fiber's business and nobody else's.
    const override = getSettingAuto("ATLAS_BRAIN_EXTRACTION_MODEL", workspaceId) ?? null;
    const workspaceConfig = config
      ? {
          model: config.model,
          baseUrl: config.baseUrl,
          bedrockRegion: config.bedrockRegion,
          credentials: config.credentials,
        }
      : null;
    // ⚠️ `getExtractionModel` changes the MODEL ID and nothing else: provider,
    // credentials and base URL are the turn's, resolved through exactly the
    // seam above. A BYO workspace's extraction therefore runs on that
    // workspace's own key at that workspace's own cheap tier, which is what
    // makes the tier a workspace-scoped setting rather than an operator's.
    const { model, modelId } = getExtractionModel({ override, workspaceConfig });
    return { model, modelId, batchApiKey: getBatchApiKey(workspaceConfig) };
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
  /**
   * The Batch API phases (#5352). All zero on the synchronous path, which is
   * also how an operator tells "batch is off" from "batch is on and stuck":
   * `batchSubmitted: 0, batchInFlight: 4` is a collect phase that is waiting,
   * and `batchSubmitted: 0, batchInFlight: 0` with a non-zero `extracted` is
   * simply the immediate path.
   */
  batch: BrainExtractionBatchTally;
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
  /** Defaults to {@link loadWorkspaceVocabulary}. */
  readonly loadVocabulary?: (workspaceId: string) => Promise<ClaimVocabulary>;
  /**
   * Defaults to `entityStoreResolver()` — the entity store (#5043, ADR-0037 §5).
   *
   * ⚠️ **THIS is where the store stops being dormant.** The warehouse producer
   * resolves its own subjects from the snapshot it just read, so it never needed
   * a store; extraction is the path where a person says "Acme Corp" about a row
   * the warehouse calls `42`, and until this seam was passed the extraction path
   * used `passthroughEntityResolver` and every extracted claim landed
   * `subject_cmp`/`object_cmp` NULL. A store nothing consults does not answer.
   *
   * Injectable for `reconcile`'s reason exactly: it reads the internal pool, and
   * a unit test of the drain must be able to run without one.
   */
  readonly resolveEntity?: EntityResolver;
  /**
   * Defaults to `proposeAliasesFromCorpus` (#5034) — the alias-proposal
   * producer, run after an episode commits and only when it created a row
   * carrying a comparable object. See {@link proposeAliasesAfterCommit}.
   *
   * Injectable for the reason `reconcile` is: it opens its own transaction on
   * the internal pool, and a unit test of the drain must be able to observe
   * whether the trigger fired without one.
   */
  readonly proposeAliases?: (workspaceId: string) => Promise<unknown>;
  /**
   * Test seam for {@link ALIAS_PROPOSAL_DEADLINE_MS}, on `correction.ts`'s
   * `auditWriteTimeoutMs` precedent. Exists so the timeout arm is reachable in
   * under a second instead of never — the arm's whole point is a producer that
   * does not settle, and a suite cannot wait 15s for one.
   *
   * RANGE-GUARDED at the read, not here: a `setTimeout` delay past 2^31-1
   * fires IMMEDIATELY, so an out-of-range override would silently make every
   * run time out rather than none.
   */
  readonly aliasProposalDeadlineMs?: number;
  /** Defaults to {@link isBrainExtractionBatchEnabled} (#5352). */
  readonly batchEnabled?: () => boolean;
  /** Defaults to the real Anthropic client in `extract-batch.ts` (#5352). */
  readonly batchClient?: BatchClient;
  /** Defaults to the internal-DB ledger in `extract-batch.ts` (#5352). */
  readonly batchLedger?: BatchLedger;
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
    // Fresh per call for `blocked`'s reason exactly — a shared nested object
    // would make every counter here cumulative across ticks.
    batch: { submitted: 0, polled: 0, collected: 0, abandoned: 0, requeued: 0 },
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
  const loadVocabulary = deps.loadVocabulary ?? loadWorkspaceVocabulary;
  // ONE resolver for the whole cycle, not one per episode: it holds no state
  // and its lookup is per-call, so a fresh one per episode would allocate for
  // nothing. Intra-episode consistency is the seam's own property — one
  // statement per call over the deduplicated surface set — and is unaffected.
  const resolveEntity = deps.resolveEntity ?? entityStoreResolver();
  const batchEnabled = deps.batchEnabled ?? isBrainExtractionBatchEnabled;
  const batchClient = deps.batchClient ?? DEFAULT_BATCH_CLIENT;
  const batchLedger = deps.batchLedger ?? DEFAULT_BATCH_LEDGER;
  const proposeAliases =
    deps.proposeAliases ?? ((workspaceId: string) => proposeAliasesFromCorpus(workspaceId));
  // `Number.isInteger` AND the upper bound, both load-bearing: a delay past
  // 2^31-1 fires immediately, which would turn an override meant to shorten a
  // test into one that times out every run in production.
  const overriddenDeadline = deps.aliasProposalDeadlineMs;
  if (
    overriddenDeadline !== undefined &&
    !(
      Number.isInteger(overriddenDeadline) &&
      overriddenDeadline > 0 &&
      overriddenDeadline <= 2_147_483_647
    )
  ) {
    // THROWN, not clamped — `loadAliasCandidates`'s cap precedent, and the same
    // reasoning. Silently substituting the 15s default would make a test that
    // MEANS to exercise the timeout arm exercise the fast path instead, and pass
    // green while asserting nothing: the "passed for the wrong reason" class
    // round 3 just fixed one file over. Costs production nothing — this is a
    // test seam and the guard fires only on an override.
    throw new Error(
      `runBrainExtractionCycle: aliasProposalDeadlineMs must be an integer in [1, 2147483647]; got ${overriddenDeadline}. A delay past 2^31-1 fires IMMEDIATELY, so an out-of-range value does not degrade to "no timeout" — it times out every run.`,
    );
  }
  const aliasProposalDeadlineMs = overriddenDeadline ?? ALIAS_PROPOSAL_DEADLINE_MS;
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
    // The alias-proposal circuit breaker, allocated PER RUN so it resets every
    // tick. See `proposeAliasesAfterCommit`: a producer stall leaks the pooled
    // connection it was holding, and without this the drain — which the
    // deadline exists to keep advancing — would leak one per episode.
    const proposalStall = { stalled: false };
    const charged: { episodeId: string; workspaceId: string }[] = [];
    /**
     * How many episodes the scan EXCLUDED as backing-off, this tick.
     *
     * Set in `scan` and read in the settle hook, which is why it lives out here
     * beside `charged` rather than inside either. Reset by `scan` on every tick,
     * so a fiber that runs for weeks cannot carry a stale count.
     */
    let excludedThisTick = 0;
    /**
     * The batch phases' counters and their results, for this tick.
     *
     * Out here beside `excludedThisTick` and for the same reason: they are
     * produced in `scan` and read by `applyRow` and the settle hook, which the
     * skeleton calls at three different moments. Reset by `scan` on every tick,
     * so a fiber that runs for weeks cannot carry a stale count or, worse, a
     * stale result — serving one tick's batch text as another tick's episode is
     * the mis-attribution the `custom_id` keying exists to prevent, and a
     * hoisted map would reintroduce it from inside.
     */
    let batchTally: BrainExtractionBatchTally = emptyResult().batch;
    let precomputed = new Map<string, PrecomputedExtraction>();

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
      // Fold in the episodes the DRAIN never selected because they are inside
      // their backoff window. They are the same population `skipped.quarantined`
      // has always meant — "not extracted this tick, because quarantined" — and
      // without this the counter would read 0 the moment the exclusion started
      // working, which is the opposite of what happened.
      //
      // Sourced from the ledger rather than from the batch, which makes it
      // strictly better than before: it now reports EVERY quarantined episode,
      // not just the ones that happened to fall inside one tick's 25.
      result.skipped.quarantined += excludedThisTick;
      // The batch phases run inside `scan`, so their counters exist before the
      // skeleton seeds `result` — folded in here for `excludedThisTick`'s
      // reason, and in the same hook, so the audit row and the completion log
      // agree.
      result.batch = batchTally;
      charged.length = 0;
      emitCycleAudit(result);
    };

    return runPeriodicDbCycle<EpisodeRow, EpisodeOutcome, BrainExtractionCycleResult>({
      log,
      label: "Brain extraction",
      emptyResult,
      failureResult: (error) => ({ ...emptyResult(), status: "failure", error }),
      // Computed per tick, not once: the set shrinks as probe windows elapse,
      // and an episode that has become due must be selected on THIS tick rather
      // than whenever the fiber happens to restart.
      //
      // ## Three phases, one scan (#5352)
      //
      // `scan` returns everything this tick will apply, and that is what lets
      // the two-phase batch flow reuse the skeleton wholesale: collected
      // episodes and freshly-drained ones are the SAME rows going through the
      // SAME per-episode path — reconcile, stamp, quarantine ledger, tally —
      // differing only in whether the model call already happened.
      //
      // Order is load-bearing. COLLECT first, so results in hand are reconciled
      // this tick rather than next. DRAIN second, and it now also re-selects the
      // episodes of any batch the collect phase just settled or abandoned (the
      // status predicate). SUBMIT last, on what the drain found, so the
      // just-re-queued episodes of a failed batch are eligible immediately
      // rather than after a full tick of doing nothing.
      //
      // Both batch phases are non-throwing, so `scan` still rejects only on the
      // drain itself — the skeleton's failure semantics are unchanged.
      scan: async () => {
        batchTally = emptyResult().batch;
        precomputed = new Map<string, PrecomputedExtraction>();
        const phaseDeps: BatchPhaseDeps = {
          client: batchClient,
          ledger: batchLedger,
          modelFor,
          now,
        };
        // NOT gated on `batchEnabled()` — see `isBrainExtractionBatchEnabled`:
        // a batch already submitted is already paid for, so turning the setting
        // off stops new submissions and never discards outstanding work. When
        // batching has never run this is one indexed query over an empty
        // partial index.
        const collected = await collectBatchPhase(phaseDeps, batchTally, precomputed);

        const backingOff = backingOffIds(failures, now());
        excludedThisTick = backingOff.length;

        // ⚠️ The collected ids are excluded IN THE QUERY, not filtered out of
        // its result, and the difference is a throughput bug rather than a
        // style choice.
        //
        // They have to be excluded at all: the collect phase settles a batch
        // before its episodes are reconciled (it has to — the stamps happen
        // per-episode later in this tick), so between the two they are
        // unstamped AND their batch is no longer `in_flight`, which is exactly
        // the state `DRAIN_EPISODES_SQL` re-admits by design. They are also the
        // OLDEST rows on the queue, so they come back FIRST. Leaving them in
        // costs either a whole re-submitted batch (batch on — the second batch
        // then collects nothing, because `recordBatchSubmission` refuses to
        // re-point an episode) or a double reconcile (batch off — the id lands
        // in both halves of what `scan` returns).
        //
        // Filtering AFTER the query would fix that and introduce a quieter
        // problem: `LIMIT $1` would already have been spent on those same rows,
        // so a tick that collected 25 episodes would drain 25 and keep none,
        // and submit nothing at all. One idle submission tick per collect,
        // invisible in every counter. Excluding them in the predicate puts the
        // LIMIT back on rows we can actually use.
        const excluded = [...backingOff, ...collected.map((row) => row.id)];
        const fresh = await internalQuery<EpisodeRow>(DRAIN_EPISODES_SQL, [BATCH_SIZE, excluded]);

        const submitted = batchEnabled()
          ? await submitBatchPhase(fresh, phaseDeps, batchTally)
          : new Set<string>();
        // Whatever did NOT go out is extracted immediately, exactly as before.
        // That is the fallback path in its entirety: a provider with no batch
        // endpoint, a workspace whose submission failed, a body-less episode.
        return [...collected, ...fresh.filter((row) => !submitted.has(row.id))];
      },
      applyRow: (row) =>
        extractEpisode(row, {
          extract,
          precomputed,
          modelFor,
          reconcile,
          loadVocabulary,
          resolveEntity,
          proposeAliases,
          proposalStall,
          aliasProposalDeadlineMs,
          now,
          failures,
        }),
      defectOutcome: (error) => ({ kind: "failed", error }),
      tally: (result, row, outcome) => tallyEpisode(result, row, outcome, failures, now, charged),
      emitCycleAudit: settleAndAudit,
    });
  });
}

interface ApplyDeps {
  readonly extract: FactExtractor;
  readonly modelFor: (workspaceId: string) => Promise<ResolvedExtractionModel | null>;
  /**
   * Results collected from a batch this tick, keyed by episode id (#5352).
   *
   * When an entry exists, {@link extractEpisode} uses it INSTEAD OF resolving a
   * model and calling one — which is the point, and also load-bearing for a
   * failure mode that is otherwise invisible: a workspace whose key broke
   * between submit and collect would otherwise have its already-paid-for results
   * discarded by the `model_unavailable` skip, and re-earn them by re-submitting
   * on the same broken key, forever.
   *
   * Everything BEFORE the model call still runs — the quarantine check, the
   * `visible_to` guard, the episode-level gate — because they are cheap, they
   * are idempotent, and re-running them is how a grant that changed while the
   * batch was in flight is honoured rather than ignored.
   */
  readonly precomputed?: ReadonlyMap<string, PrecomputedExtraction>;
  readonly reconcile: typeof reconcileFacts;
  readonly loadVocabulary: (workspaceId: string) => Promise<ClaimVocabulary>;
  readonly resolveEntity: EntityResolver;
  readonly proposeAliases: (workspaceId: string) => Promise<unknown>;
  /**
   * The per-tick circuit breaker for the alias-proposal trigger — see
   * {@link proposeAliasesAfterCommit}'s "one stall per tick, not one per
   * episode".
   *
   * Cycle-scoped, like `failures` above and for a sharper reason: it must reset
   * between ticks, or one bad minute would retire the producer for the lifetime
   * of the process. THE SAME object is bound into both halves in
   * `runBrainExtractionCycle`.
   */
  readonly proposalStall: { stalled: boolean };
  readonly aliasProposalDeadlineMs: number;
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
 * The episode ids the drain must not select this tick.
 *
 * The same predicate `extractEpisode` applies, moved in front of the `LIMIT` so
 * a backing-off episode does not consume a slot it will only be skipped in. Both
 * call sites stay because they answer different questions: this one keeps the
 * batch productive, and the guard in `extractEpisode` keeps a row that slipped
 * through — a hand-passed fixture, a future caller that bypasses `scan` — from
 * costing a model call. Removing either one alone is safe; removing both is the
 * poisoned-queue stall.
 */
export function backingOffIds(ledger: ReadonlyMap<string, QuarantineEntry>, now: Date): string[] {
  const ids: string[] = [];
  for (const [id, entry] of ledger) {
    if (isQuarantined(entry, now)) ids.push(id);
  }
  return ids;
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

  // The batch path's results, when this episode came back from one (#5352). The
  // model call is already made and paid for, so NEITHER `modelFor` NOR `extract`
  // runs — see {@link ApplyDeps.precomputed} on why routing a collected episode
  // through the `model_unavailable` skip would be an expensive loop rather than
  // a safe one.
  const precomputed = deps.precomputed?.get(row.id);
  let candidates: readonly FactCandidate[];
  if (precomputed !== undefined) {
    if (precomputed.kind === "failed") {
      // A per-REQUEST failure — the vendor's own verdict on THIS episode
      // (`errored`, `canceled`, `expired`), so it is the episode's evidence and
      // charges a strike through the ordinary failure path. A whole-BATCH
      // failure never reaches here: `abandonBatch` re-queues those episodes
      // without ever constructing an outcome for them.
      return { kind: "failed", error: precomputed.error };
    }
    candidates = precomputed.candidates;
  } else {
    const resolved = await deps.modelFor(episode.workspaceId);
    if (resolved === null) {
      // NOT stamped: an admin re-entering the workspace's key must be enough to
      // make these episodes extract, with no backfill to run.
      return { kind: "skipped", reason: "model_unavailable" };
    }
    candidates = await deps.extract({
      episode,
      body: row.body,
      model: resolved.model,
      modelId: resolved.modelId,
    });
  }

  // AFTER the candidates are in hand, on both paths. On the batch path the
  // model call happened hours ago and this is when the claim is being FILED —
  // which is what `extracted_at` dates. (`brain_episodes.extracted_at` is the
  // database clock and dates a queue transition; the two are deliberately
  // different values, as the STAMP_EXTRACTED_SQL note says.)
  const extractedAt = deps.now();

  // The extraction pipeline is THE ingest path, so this is the workspace's real
  // vocabulary — one snapshot, materialized before any candidate is keyed, so
  // the whole episode keys against one function rather than against reads that
  // could straddle an approval.
  //
  // Loaded HERE rather than before the model call, and the gap is the reason: a
  // vocabulary read minutes before `reconcile` would be a staler snapshot than
  // one read immediately before it, and reconcile's corroboration lookup joins
  // against keys other writers materialized in the meantime.
  //
  // The cost of that ordering is one wasted model call per failing episode, and
  // the failure ledger does NOT cap it the way it caps a poison episode: a
  // `VocabularyClosureError` is workspace-scoped and deterministic, so it fails
  // every episode of that workspace, and the drain's backing-off exclusion —
  // whose whole purpose is to let the head advance — hands the next tick a fresh
  // batch. The spend therefore scales with the workspace's unextracted backlog,
  // not with `QUARANTINE_AFTER_FAILURES`. Accepted as the honest cost of the
  // fresher snapshot, and stated because "the ledger caps it" is the thing a
  // reader would otherwise assume.
  //
  // NOT caught. `vocabulary.ts` refuses to answer against a partial closure, and
  // degrading to `identityVocabulary` here would key the whole episode into the
  // slot the vocabulary exists to move it OUT of — an under-match today, an
  // over-match the moment an entry merges two spellings, and neither visible at
  // rest. The throw lands on the drain's defect path, which charges a strike and
  // leaves the episode queued for the next cycle.
  const vocabulary = await deps.loadVocabulary(episode.workspaceId);

  const report = await deps.reconcile({
    episode,
    candidates,
    producer: BRAIN_EXTRACTION_PRODUCER,
    extractedAt,
    vocabulary,
    resolveEntity: deps.resolveEntity,
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
  await proposeAliasesAfterCommit(episode, report, deps);
  return { kind: "extracted", report };
}

/**
 * How long the alias-proposal producer may take before the extraction drain
 * stops waiting for it.
 *
 * A DRAIN bound, not a work bound — see {@link proposeAliasesAfterCommit} on why
 * the two are different and why both exist. Generous, because timing out costs a
 * workspace its proposals for that episode and there is no sweep to re-run them:
 * the number only has to be shorter than "forever". Every statement AFTER the
 * `SET LOCAL` pair lands carries a tighter server-side bound; `BEGIN` and the
 * pair itself do NOT, and they are exactly the round trips this constant exists
 * for — so "the server side already covers it" is the reading to avoid.
 */
export const ALIAS_PROPOSAL_DEADLINE_MS = 15_000;

/**
 * Re-derive this workspace's alias proposals, after the episode has committed
 * and been stamped (#5034, ADR-0037 §4).
 *
 * ## Gated on `report.comparable`, and that gate is exact rather than a heuristic
 *
 * `ALIAS_PROPOSAL_SQL` joins two rows on `object_cmp` non-null and equal, so its
 * candidate set is a pure function of the rows that HAVE one. An episode that
 * created none cannot have changed that set — a corroborating candidate writes
 * no row at all, and a created row with a NULL comparable joins nothing on
 * either side. So this is not sampling: skipping is provably lossless, and the
 * corpus-wide self-join is spent only when the corpus grew evidence it could
 * read. Today that is very nearly never, which is the honest shape of ADR-0037
 * §4's *on day one it returns zero rows for want of populated `object_cmp`*.
 *
 * ## AFTER the stamp, and never inside the reconcile transaction
 *
 * `cardinality.ts`'s `proposeFromCorrectionEvents` exactly: a proposal is
 * advisory and the extraction is real work, so a store failure here must not
 * roll back facts already committed — and a `try`/`catch` inside that
 * transaction could not deliver that however it were written, since a failed
 * statement puts Postgres in `25P02` and takes the enclosing COMMIT with it.
 *
 * ## Caught here, not propagated
 *
 * Throwing would return `failed` from {@link extractEpisode} for an episode
 * whose facts are committed and whose row is stamped — the drain would charge a
 * strike, and the strike would be against evidence that has already been fully
 * processed. Logged at `warn`, never swallowed.
 *
 * ## A HANG is bounded TWICE, and neither bound is sufficient alone
 *
 * A `try`/`catch` fires on a rejection and never on a call that does not settle,
 * and this `await` sits inside `applyRow` under `Effect.forEach(concurrency: 1)`
 * with no per-tick timeout — so an internal database that is REACHABLE AND NOT
 * ANSWERING would stop the whole brain-extraction drain forever, with no error,
 * no dead fiber, and not one line in the log.
 *
 *   - **In the database:** `alias-proposal.ts`'s `boundedTransaction` issues
 *     `SET LOCAL statement_timeout` and `SET LOCAL lock_timeout`, so Postgres
 *     CANCELS a slow or lock-blocked statement rather than abandoning it. This
 *     is the bound that reclaims a pooled connection.
 *   - **Here:** {@link ALIAS_PROPOSAL_DEADLINE_MS}, whose only job is that the
 *     DRAIN advances.
 *
 * ⚠️ The second is not belt-and-braces, and an earlier version of this
 * paragraph claimed the first was enough. It is not: `withBrainTransaction`
 * issues `BEGIN` **before** the callback runs, so `BEGIN` and the first
 * `SET LOCAL` are themselves unbounded — and a database that is not answering
 * does not answer `BEGIN` either. The pool's `connectionTimeoutMillis` covers
 * the checkout and nothing covers the two round trips after it. The `SET LOCAL`
 * pair cannot bound its own arrival, so the JS deadline is the only thing
 * standing between that failure and a wedged fiber.
 *
 * The converse is also true, which is why both are kept: `Promise.race` does
 * not CANCEL anything, so a timed-out run whose statements DID arrive is
 * reclaimed by `statement_timeout` and not by anything here.
 *
 * ## One stall per TICK, not one per episode — and why that is required
 *
 * ⚠️ **In the headline case the connection is NOT reclaimed, and the deadline is
 * what makes that matter.** If the stall precedes the first `SET LOCAL` — which
 * is precisely the reachable-but-not-answering case — then `withBrainTransaction`
 * is parked on `BEGIN`, its callback never runs, and `client.release()` never
 * runs either. `idleTimeoutMillis` does not apply to a checked-out client, so the
 * connection is gone from a pool bounded at **5** until the socket dies.
 *
 * Before the deadline that cost exactly one connection, because the fiber wedged
 * behind it. With the deadline the drain ADVANCES — which is the whole point —
 * so the next comparable-creating episode would check out another, and
 * `BATCH_SIZE` of them would exhaust the pool and take down every unrelated
 * internal query in the process: auth, audit, settings, and this drain's own
 * `DRAIN_EPISODES_SQL` and `stampExtracted`.
 *
 * So the first timeout in a tick trips {@link ApplyDeps.proposalStall} and every
 * later episode in that tick skips the trigger. The leak is bounded at one
 * connection per cycle, the drain still advances, and the breaker resets next
 * tick because it is allocated per run — a process-lifetime flag would retire
 * the producer permanently on one bad minute.
 *
 * The skipped episodes lose nothing a completed run would have kept: the
 * producer re-derives its whole candidate set from the corpus and holds no
 * cursor. What they lose is the same thing a failed run loses, on the same
 * terms as the paragraph below.
 *
 * ## ⚠️ What "re-derived next run" is and is NOT worth
 *
 * The producer holds no cursor, so a lost run costs no state — but it is only
 * re-run by ANOTHER episode in this workspace that creates a comparable row,
 * because this trigger is `proposeAliasesFromCorpus`'s only caller. There is no
 * scheduler fiber and no admin re-run verb. Under the day-one reality this
 * function's gate describes — comparable rows are very nearly never — that next
 * episode may not arrive, so a failed run's candidates can stay unproposed
 * indefinitely.
 *
 * That is stated plainly rather than softened because an earlier version of this
 * docstring and its log line both claimed *"nothing is permanently lost"*, which
 * is a promise the wiring does not keep. The durable fix is a low-frequency
 * `registerPeriodicFiber` sweep so a lost run has a floor; it is deliberately
 * NOT in this slice — it is a second trigger with its own enablement, cadence
 * and audit questions, and #5034's scope is the query.
 *
 * ## The other gap, same shape
 *
 * `correction.ts` is the other caller of `reconcileFacts` and is NOT wired here.
 * A correction inherits the slot and derives the object fresh, so it can
 * introduce a comparable row this trigger never sees — and, per the paragraph
 * above, "the next extraction finds it" is a hope rather than a guarantee.
 * Deliberate: hanging a workspace-wide self-join off the human-facing verb buys
 * a proposal sooner at the cost of latency on the one path a person waits on.
 */
async function proposeAliasesAfterCommit(
  episode: ReconcileEpisodeRef,
  report: ReconcileReport,
  deps: ApplyDeps,
): Promise<void> {
  if (report.comparable === 0) return;
  if (deps.proposalStall.stalled) {
    // ⚠️ LOGGED, because the breaker is TICK-wide and the drain is FLEET-wide.
    // `DRAIN_EPISODES_SQL` has no workspace scope, so the episode that tripped
    // the breaker and the episodes this skips routinely belong to DIFFERENT
    // tenants — and the one timeout line above names only the first. Without
    // this an operator asking "why has workspace B no alias proposals" finds a
    // single line naming workspace A, and a tick that skipped one is
    // byte-identical to a tick that skipped twenty-four.
    //
    // The same argument this file already makes twice, at `outageRefunded`'s
    // third-state warn and at the span comment in `effect/layers.ts`.
    log.warn(
      {
        workspaceId: episode.workspaceId,
        episodeId: episode.id,
        comparable: report.comparable,
      },
      "brain extraction: skipping the alias-proposal trigger — an earlier episode in this tick timed out and tripped the per-tick breaker, so THIS workspace's candidates are not proposed even though the stall may have been another tenant's. They are re-derived only by the next comparable-creating episode in this workspace; the breaker resets on the next tick",
    );
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    // Invoked INSIDE the try, which is why the seam is a THUNK: `proposeAliases`
    // is a plain function type nothing forces to be `async`, so an injected
    // implementation that threw SYNCHRONOUSLY would land outside the guard on an
    // already-committed episode. `correction.ts`'s `proposeUnderDeadline` was
    // built wrong that way first and records it.
    const pending = deps.proposeAliases(episode.workspaceId);
    // The race marks the LOSER's rejection as handled, so a real store error
    // arriving after the deadline would otherwise be dropped with no line and
    // not even an unhandled rejection. GUARDED on `timedOut`, or this fires on
    // the ordinary fast-failure path too, where the `catch` below already
    // reports it — one event, two warns, the second one wrong.
    void pending
      .then(
        () => {
          if (!timedOut) return;
          log.warn(
            { workspaceId: episode.workspaceId, episodeId: episode.id },
            "brain extraction: the alias-proposal producer COMPLETED after its deadline — the earlier timeout line for this episode reports the same event, and any proposals it queued are present",
          );
        },
        (cause: unknown) => {
          if (!timedOut) return;
          log.warn(
            { workspaceId: episode.workspaceId, episodeId: episode.id, err: errorMessage(cause) },
            "brain extraction: the alias-proposal producer FAILED after its deadline had already been reported — this is the underlying cause behind the earlier timeout line. ⚠️ It does NOT mean nothing was written: `proposeAliasEdge` commits per candidate, so a failure part way through a batch leaves every earlier proposal in place, and the producer's own counters line says how many",
          );
        },
      )
      // DETACHED — it settles after this function has returned, so no `try` on
      // the extraction path can reach it, and an unhandled rejection is
      // process-fatal by default. A committed episode's bookkeeping must not be
      // able to take the worker down.
      .catch(() => {
        // intentionally ignored: best-effort observability on a detached
        // promise. The only ways here are the logger itself throwing and a
        // hostile rejection value reaching `errorMessage` — neither of which an
        // advisory proposal may kill the extraction fiber for.
      });
    await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(
            new Error(
              `the alias-proposal producer did not answer within ${deps.aliasProposalDeadlineMs}ms — most likely an internal database that is reachable but not responding, or a batch spending its budget waiting on the workspace vocabulary lock, which ALIAS_PROPOSAL_LOCK_TIMEOUT_SQL treats as an expected outcome`,
            ),
          );
        }, deps.aliasProposalDeadlineMs);
      }),
    ]);
  } catch (err) {
    // TRIP THE BREAKER, and only on the timeout arm. An ordinary failure
    // released its connection on the way out; a timeout did not, and the next
    // episode would leak another.
    if (timedOut) deps.proposalStall.stalled = true;
    log.warn(
      {
        workspaceId: episode.workspaceId,
        episodeId: episode.id,
        comparable: report.comparable,
        // SCRUBBED, on `reconcile.ts`'s precedent and this file's own three
        // existing uses. `error-scrub.ts` exists because pg error text sometimes
        // echoes the connection string verbatim, and the error caught here comes
        // from a pool checkout plus a query on the internal DB — the highest-
        // probability source of a credentialed URL in this file.
        err: errorMessage(err),
        timedOut,
      },
      timedOut
        ? "brain extraction: the alias-proposal producer did not answer within its deadline — the facts and the stamp are COMMITTED and unaffected, and the extraction drain is free to advance, which is what this deadline exists for. The producer's own fate is UNKNOWN: the race does not cancel it, though `SET LOCAL statement_timeout` bounds each statement it had already reached. If it settles, a follow-up line for this episode says which — but the failure this deadline exists for may never produce one, so treat a MISSING follow-up as the run still being in flight rather than as recovered"
        : "brain extraction: the alias-proposal producer failed after this episode committed — the facts and the stamp are safe, and no vocabulary EDGE changed — though proposals queued before the failure are present, since `proposeAliasEdge` commits per candidate. The remaining candidates are re-derived from the corpus by the NEXT episode in this workspace that creates a comparable object; this trigger is the producer's only caller, so if no such episode arrives they stay unproposed until one does",
    );
  } finally {
    // Around the RACE, so it runs whoever wins. A `finally` on the TIMER
    // PROMISE settles only when the timer fires, so `clearTimeout` would always
    // be a no-op and the fast path would leave a timer armed per episode —
    // `correction.ts` shipped exactly that bug once and its docstring measures
    // it (race settled at 52ms, the `finally` ran at 3080ms).
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function stampExtracted(episode: ReconcileEpisodeRef): Promise<void> {
  await internalQuery(STAMP_EXTRACTED_SQL, [episode.id, episode.workspaceId]);
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
        // ⚠️ REACHABLE. This branch used to be dead: while the drain was a bare
        // `LIMIT BATCH_SIZE` over a queue whose head never advanced past a
        // failure, the ledger could not exceed BATCH_SIZE. It said so, and
        // predicted that "a future drain change wakes this branch up, and it
        // must not wake up silently".
        //
        // The backing-off exclusion (`$2`, see {@link DRAIN_EPISODES_SQL}) IS
        // that change. Making the head advance is the whole point of it — so
        // under a BROAD failure (one 404ing model, one workspace-wide content
        // filter) each tick now reaches 25 fresh episodes instead of re-reading
        // the same poisoned 25, and the ledger grows to FAILURE_LEDGER_CAP
        // rather than stalling at BATCH_SIZE.
        //
        // That is the trade the exclusion buys, and it is the right one — a
        // stalled queue drains NOTHING for every workspace, while this walks the
        // backlog at one probe per episode per window and says so at WARN. But
        // it means the header's "one probe per window each" bound holds only
        // below the cap: past it, eviction disarms the oldest quarantine and
        // that episode returns to full price until it re-earns its strikes.
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
      metadata: {
        ...result,
        blocked: { ...result.blocked },
        skipped: { ...result.skipped },
        batch: { ...result.batch },
      },
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

// ---------------------------------------------------------------------------
// Re-exports — the contract's surface, kept reachable from this module
//
// `extract.ts` was the single import site for the whole extraction path before
// #5352 split it three ways, and several callers (the scheduler registration,
// every `-pg` suite, `extract.test.ts`) name it. Re-exporting rather than
// rewriting those call sites keeps the split a refactor of OWNERSHIP rather
// than a breaking change to a module boundary nobody asked to move.
// ---------------------------------------------------------------------------

export {
  BRAIN_EXTRACTION_PRODUCER,
  EXTRACTION_SYSTEM_PROMPT,
  ExtractionSchema,
  extractionExcerpt,
  extractionPrompt,
  toFactCandidates,
} from "@atlas/api/lib/brain/extract-contract";
export type {
  BrainExtractionBatchTally,
  EpisodeRow,
  PrecomputedExtraction,
  ResolvedExtractionModel,
} from "@atlas/api/lib/brain/extract-contract";
export type { BatchClient, BatchLedger } from "@atlas/api/lib/brain/extract-batch";
