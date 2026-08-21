/**
 * The Batch API half of the extraction fiber (#5352, ADR-0036 §Ingestion &
 * connectors, bounded by #5334) — the vendor client and the in-flight ledger.
 *
 * ## Why batching is the right shape here, and not merely cheaper
 *
 * Anthropic's Message Batches API is **50% of standard pricing** with an
 * asynchronous turnaround. `extract.ts` was already built for exactly that
 * trade: it is a separate fiber precisely so *"episode freshness never blocks on
 * LLM latency / 429s"*, facts are **second-order fresh by design**, and the
 * backlog is visible in `idx_brain_episodes_extraction_queue` rather than
 * inferred. The latency budget was already hours. Paying double bought a
 * synchronous guarantee the architecture explicitly does not want.
 *
 * ## What the split changes, and the one thing it must not
 *
 * The tick goes from `drain → extract → reconcile → stamp` to
 * `drain → submit → (later) collect → reconcile → stamp`. **Work-then-stamp is
 * unchanged**, and that is the invariant everything here is arranged around: an
 * episode is stamped only after its reconcile has COMMITTED, exactly as on the
 * synchronous path. A batch that never returns therefore costs a repeated model
 * call and nothing else — {@link abandonBatch} clears the pointers and the
 * episodes are back on the queue at their original `ingested_at` position.
 *
 * Claiming first — stamping at submit time — was rejected for the same reason
 * `extract.ts`'s header rejects it, only worse: a lost batch would become a
 * permanent silent drop of every claim in it, and the failure that produces one
 * (a 24h expiry, a submission whose response we never saw) is *routine* rather
 * than a crash.
 *
 * ## Raw HTTP rather than an SDK, and rather than the AI SDK
 *
 * No `@ai-sdk/*` package exposes a batch surface — `LanguageModel` is a
 * per-request abstraction — so a batch submission cannot ride the seam the
 * synchronous path uses. It is a direct call to the vendor endpoint, built here
 * with `fetch` rather than by adding `@anthropic-ai/sdk` as a dependency: the
 * whole surface is three endpoints and one JSONL reader, the repo has no other
 * vendor-SDK client (it standardised on the AI SDK's provider packages), and a
 * new runtime dependency would also have to reach
 * `serverExternalPackages` in the `create-atlas` template.
 *
 * The host is FIXED (`api.anthropic.com`) for submit and retrieve, so those need
 * no `createGuardedFetch` — unlike `providers.ts`'s `custom`/`azure-openai`
 * arms, whose base URL is workspace-supplied.
 *
 * ⚠️ There is ONE exception and an earlier draft of this paragraph did not name
 * it: the results read uses a `results_url` taken from the retrieve RESPONSE
 * BODY, and it carries `x-api-key`. `fetch` follows redirects and strips only
 * `Authorization`/`Cookie` across origins, so an unexpected url would hand the
 * workspace's own key to another host. {@link assertAnthropicOrigin} restores
 * the invariant this paragraph claims, and it is an origin assertion rather
 * than an egress guard because the question is not "is this address internal"
 * but "is this Anthropic".
 *
 * ## Anthropic only — a capability, not an assumption
 *
 * `ollama` and `openai-compatible` have no batch endpoint at all, `bedrock` and
 * `gateway` have their own with different shapes, and OpenAI's is a file-upload
 * flow. `getBatchApiKey` (providers.ts) returns `null` for all of them and the
 * cycle stays synchronous, which is what makes the fallback path load-bearing
 * rather than decorative.
 */

import { z } from "zod";
import { createLogger } from "@atlas/api/lib/logger";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { withBrainTransaction } from "@atlas/api/lib/brain/reconcile";
import { isUnknownArray } from "@atlas/api/lib/brain/acl";
import {
  EXTRACTION_JSON_SCHEMA,
  EXTRACTION_SYSTEM_PROMPT,
  ExtractionSchema,
  extractionExcerpt,
  extractionPrompt,
  toDate,
  toEpisodeRef,
  toFactCandidates,
  type BrainExtractionBatchTally,
  type EpisodeRow,
  type PrecomputedExtraction,
  type ResolvedExtractionModel,
} from "@atlas/api/lib/brain/extract-contract";

const log = createLogger("brain.extract.batch");

/** The only provider with a batch path in this slice. See the module header. */
export const BATCH_PROVIDER = "anthropic" as const;

/** Fixed host — see the module header on why no egress guard is involved. */
const ANTHROPIC_API_BASE = "https://api.anthropic.com";

/** The version header every Anthropic REST call carries. */
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Output cap per batched request.
 *
 * Extraction emits ~60 output tokens in the common case and is bounded above by
 * `MAX_CANDIDATES` triples of short strings. Generous rather than tight: on the
 * synchronous path the AI SDK picks this and a truncated response surfaces as a
 * schema parse failure, which here would cost a whole batch's turnaround to
 * discover.
 */
const BATCH_MAX_TOKENS = 2_048;

/**
 * How long a submit / poll / results HTTP call may take.
 *
 * Bounds the CYCLE, not the batch: the work itself takes hours by design, and
 * these are the three short round trips that ask about it. Without a bound the
 * collect phase inherits `fetch`'s default (none, in Bun) and a vendor that
 * accepts a connection and never answers would wedge the drain — the failure
 * `proposeAliasesAfterCommit`'s deadline exists for, one seam over.
 */
const BATCH_HTTP_TIMEOUT_MS = 30_000;

/**
 * Batches polled per tick.
 *
 * ⚠️ TWO separate properties live around this constant and an earlier draft's
 * comment ran them together, which made the number look like the reason the
 * loops are serial. It is not; they are independent decisions:
 *
 *   1. **The BOUND — this constant.** How much work one tick may take on. Each
 *      ended batch becomes up to `BATCH_SIZE` reconcile transactions in the
 *      same tick, so an unbounded collect after an outage (twenty batches
 *      landing at once) would put 500 episodes ahead of the drain. Four is one
 *      tick's worth of submissions at the current cadence plus slack.
 *   2. **The SERIALIZATION — the `for await` in the phases below.** Why the
 *      batches are polled one at a time rather than concurrently, which is a
 *      different question and has a different answer: every one of them can
 *      open a TRANSACTION on the internal pool (`abandon`, `settleCollected`)
 *      plus a `loadEpisodes`, and that pool is bounded at **5**.
 *      `withBrainTransaction`'s docstring names the failure — a nested or
 *      concurrent checkout under a held connection is a starvation deadlock —
 *      and `runPeriodicDbCycle` already runs the per-episode loop at
 *      `concurrency: 1` for the same reason. Fanning these out would be four
 *      concurrent transactions against five connections, sharing the pool with
 *      auth, audit and the drain's own queries.
 *
 * Raising (1) is a throughput question and safe. Removing (2) is a pool
 * question and is not — it needs a bounded concurrency that accounts for the
 * pool, not a `Promise.all`.
 */
export const COLLECT_BATCHES_PER_TICK = 4;

// ---------------------------------------------------------------------------
// The vendor wire
// ---------------------------------------------------------------------------

/** What one episode is submitted as. `customId` is the episode id. */
export interface BatchRequestItem {
  readonly customId: string;
  readonly system: string;
  readonly prompt: string;
}

/**
 * A batch's state at the vendor. `ended` is terminal and means results are
 * available — including the case where every request in it errored.
 */
export type BatchProcessingStatus = "in_progress" | "canceling" | "ended";

export interface BatchStatus {
  readonly processingStatus: BatchProcessingStatus;
  /** Present once `processingStatus` is `ended`. */
  readonly resultsUrl: string | null;
  readonly expiresAt: Date | null;
}

/**
 * One line of the results JSONL.
 *
 * THREE arms, not two, and the split decides whether an episode is charged a
 * strike — which is the whole of #5352's *"a failed batch does not quarantine
 * every episode it contained"*:
 *
 *   - `succeeded` — the model's raw text (the response's first text block).
 *   - `failed` — the vendor's `errored`. THIS request was refused on its own
 *     terms, so it is that episode's evidence and charges a strike, which is
 *     what makes a permanently-poisoned body back off instead of costing a
 *     batched request every tick forever.
 *   - `unfulfilled` — the vendor's `expired` and `canceled`. ⚠️ These look like
 *     per-request failures and are not: a 24h expiry is a vendor capacity
 *     incident and a cancel is an operator at the vendor console, and BOTH
 *     arrive as a line per request in an `ended` batch. Collapsing them into
 *     `failed` was the first cut of this function, and it meant three vendor
 *     expiries quarantined a whole backlog with exponential backoff — exactly
 *     the outcome `abandonBatch`'s docstring says the design avoids, reached by
 *     the one path that never goes through `abandonBatch`.
 */
export type BatchResult =
  | { readonly customId: string; readonly kind: "succeeded"; readonly text: string }
  | { readonly customId: string; readonly kind: "failed"; readonly error: string }
  | { readonly customId: string; readonly kind: "unfulfilled"; readonly reason: string };

/**
 * Result TYPES that are evidence about the world — the outer `result.type`.
 *
 * `expired` is the 24h ceiling, `canceled` is an operator at the vendor
 * console. Neither says anything about the message.
 */
const UNFULFILLED_RESULT_TYPES: ReadonlySet<string> = new Set(["expired", "canceled"]);

/**
 * ERROR types that are evidence about the world, read off `result.error.type`
 * when the outer type is `errored`.
 *
 * ⚠️ The outer type is NOT enough, and assuming it was is the defect this set
 * fixes. `errored` is the vendor's envelope for two completely different
 * things: *"this request was bad"* and *"we were unable to serve it"*. An
 * overload, a rate limit or a 5xx is delivered as a per-request `errored` line
 * inside an `ended` batch — so classifying on the envelope alone charged a
 * strike to every episode in a batch the vendor simply could not serve, which
 * is #5352's AC (*"a failed batch does not quarantine every episode it
 * contained"*) broken one layer below where the first fix put the guard.
 *
 * Deployment-level faults are here too, and deliberately: an
 * `authentication_error` is a rotated key and a `billing_error` is an unpaid
 * invoice. Both are facts about the install, both clear without touching the
 * episode, and quarantining a backlog behind either would mean a repaired key
 * drains nothing for up to sixteen hours.
 */
const UNFULFILLED_ERROR_TYPES: ReadonlySet<string> = new Set([
  "overloaded_error",
  "api_error",
  "rate_limit_error",
  "timeout_error",
  "authentication_error",
  "permission_error",
  "billing_error",
]);

/**
 * Is this `errored` line the EPISODE's own evidence, or the world's?
 *
 * ⚠️ An unrecognised error type charges a strike — the deliberately UNSAFE-ish
 * default, chosen because the two failure directions are not symmetric. A
 * wrongly-charged strike is bounded: quarantine is a widening backoff that
 * re-probes, so a mis-sorted transient heals itself at one call per window. A
 * wrongly-forgiven one is not: a permanently-poisoned body would be re-submitted
 * at full price on every cycle, for ever, with nothing to stop it.
 *
 * So the set above is an ALLOWLIST of world-evidence, not a denylist of
 * episode-evidence, and a new vendor error type fails toward the bounded side
 * until someone reads it. `invalid_request_error` and `request_too_large` are
 * the two that are genuinely this message's own, and they are the ones the
 * default already handles correctly.
 */
function isWorldEvidenceError(detail: unknown): boolean {
  if (typeof detail !== "object" || detail === null) return false;
  const errorType = (detail as { type?: unknown }).type;
  return typeof errorType === "string" && UNFULFILLED_ERROR_TYPES.has(errorType);
}

interface AnthropicCredentials {
  readonly apiKey: string;
}

function batchHeaders(cred: AnthropicCredentials): Record<string, string> {
  return {
    "x-api-key": cred.apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
    "content-type": "application/json",
  };
}

/**
 * The vendor's error body, read for its message and nothing else.
 *
 * ⚠️ The message is passed through `errorMessage` at every call site before it
 * reaches a log or `brain_extraction_batch.abandon_reason`. Vendor error text is
 * attacker-adjacent (it can echo request content) and this is the one field on
 * that table an operator reads verbatim.
 */
async function readErrorBody(res: Response): Promise<string> {
  // intentionally ignored: best-effort read of an already-failed response's
  // body. The status line below is the signal, and a body that will not read
  // must not mask it — this catch emits nothing at all, which is the one shape
  // the marker means.
  const body = await res.text().catch(() => "");
  const trimmed = body.slice(0, 500);
  return `HTTP ${res.status}${trimmed ? `: ${trimmed}` : ""}`;
}

/**
 * Refuse a vendor-supplied URL that is not Anthropic's.
 *
 * THROWS rather than returning a boolean: the caller is inside `collectOneBatch`,
 * whose every throw is already handled as "this batch did not collect this
 * tick" — so failing closed here costs one poll and leaks nothing, while a
 * boolean would need a new arm at the call site to be worth anything.
 */
export function assertAnthropicOrigin(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not swallowed — re-thrown as the refusal below, with the URL deliberately
    // NOT echoed: it is attacker-influenced text heading for a log line.
    throw new Error("batch results url is not a valid URL — refusing to send the API key to it");
  }
  if (parsed.origin !== ANTHROPIC_API_BASE) {
    throw new Error(
      `batch results url points at ${parsed.origin} rather than ${ANTHROPIC_API_BASE} — refusing to send the API key to it`,
    );
  }
}

async function batchFetch(
  url: string,
  cred: AnthropicCredentials,
  init?: { method: string; body: string },
): Promise<Response> {
  const res = await fetch(url, {
    method: init?.method ?? "GET",
    headers: batchHeaders(cred),
    ...(init?.body !== undefined ? { body: init.body } : {}),
    signal: AbortSignal.timeout(BATCH_HTTP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(await readErrorBody(res));
  return res;
}

/**
 * The submission response, parsed defensively.
 *
 * Zod rather than a cast: this is the one place a vendor response becomes a row
 * in `brain_extraction_batch`, and a missing `id` written as `undefined` would
 * be a batch nothing can ever poll while its episodes stay pointed at it —
 * un-drainable until an operator noticed. A parse failure instead throws, the
 * submit is treated as failed, and the episodes were never pointed anywhere.
 */
const BatchCreateResponse = z.object({
  id: z.string().min(1),
  expires_at: z.string().min(1).nullish(),
});

const BatchRetrieveResponse = z.object({
  processing_status: z.enum(["in_progress", "canceling", "ended"]),
  results_url: z.string().min(1).nullish(),
  expires_at: z.string().min(1).nullish(),
});

/**
 * Submit one batch. Returns the vendor handle and its expiry.
 *
 * `temperature: 0` and the `output_config.format` JSON schema mirror the
 * synchronous `generateObject` call exactly — see `extract.ts`'s note on why
 * determinism is load-bearing rather than a quality preference (re-extraction is
 * routine, and the slot-key dedupe collapses a repeat only if the model
 * reproduces its own output).
 */
export async function submitExtractionBatch(opts: {
  readonly apiKey: string;
  readonly modelId: string;
  readonly schema: Record<string, unknown>;
  readonly items: readonly BatchRequestItem[];
}): Promise<{ providerBatchId: string; expiresAt: Date }> {
  const cred: AnthropicCredentials = { apiKey: opts.apiKey };
  const body = JSON.stringify({
    requests: opts.items.map((item) => ({
      custom_id: item.customId,
      params: {
        model: opts.modelId,
        max_tokens: BATCH_MAX_TOKENS,
        temperature: 0,
        system: item.system,
        messages: [{ role: "user", content: item.prompt }],
        output_config: { format: { type: "json_schema", schema: opts.schema } },
      },
    })),
  });
  const res = await batchFetch(`${ANTHROPIC_API_BASE}/v1/messages/batches`, cred, {
    method: "POST",
    body,
  });
  const parsed = BatchCreateResponse.parse(await res.json());
  return {
    providerBatchId: parsed.id,
    // The vendor's own expiry when it gave one; otherwise the documented 24h
    // ceiling. A LOCAL fallback rather than "no expiry": a row with no
    // `expires_at` is a batch nothing would ever abandon, and its episodes would
    // sit un-drainable forever — the exact silent-drop this module exists to
    // avoid, arriving through a missing field instead of a lost batch.
    expiresAt: toDateOr(parsed.expires_at, () => new Date(Date.now() + 24 * 60 * 60 * 1000)),
  };
}

/** Poll one batch. */
export async function retrieveExtractionBatch(opts: {
  readonly apiKey: string;
  readonly providerBatchId: string;
}): Promise<BatchStatus> {
  const cred: AnthropicCredentials = { apiKey: opts.apiKey };
  const res = await batchFetch(
    `${ANTHROPIC_API_BASE}/v1/messages/batches/${encodeURIComponent(opts.providerBatchId)}`,
    cred,
  );
  const parsed = BatchRetrieveResponse.parse(await res.json());
  return {
    processingStatus: parsed.processing_status,
    resultsUrl: parsed.results_url ?? null,
    expiresAt: parsed.expires_at ? toDateOr(parsed.expires_at, () => null) : null,
  };
}

/**
 * Read a batch's results.
 *
 * ⚠️ **Keyed by `custom_id`, never by position.** The vendor states results
 * arrive in any order, and the ordering that would make positional matching
 * *appear* to work is the common case — so a positional reader passes every
 * test written against a fixture and mis-attributes claims in production,
 * writing one episode's facts under another episode's provenance and grant.
 * `extract-batch.test.ts` shuffles the result order for exactly this reason.
 */
export async function readExtractionBatchResults(opts: {
  readonly apiKey: string;
  readonly resultsUrl: string;
}): Promise<readonly BatchResult[]> {
  // ⚠️ The ONE url here that does not come from us — it is read off the retrieve
  // response body — and it is fetched carrying `x-api-key`. The module header's
  // "the host is FIXED, so there is no SSRF surface" is true of submit and
  // retrieve and was NOT true of this call: `fetch` follows redirects and strips
  // only `Authorization`/`Cookie` across origins, so a redirect (or simply an
  // unexpected `results_url`) would hand the workspace's own API key to another
  // host. Asserted rather than guarded with `createGuardedFetch`, because the
  // answer here is not "is this address internal" but "is this Anthropic".
  assertAnthropicOrigin(opts.resultsUrl);
  const cred: AnthropicCredentials = { apiKey: opts.apiKey };
  const res = await batchFetch(opts.resultsUrl, cred);
  const text = await res.text();
  const out: BatchResult[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const parsed = parseBatchResultLine(trimmed);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

/**
 * One JSONL line → one {@link BatchResult}, or `null` for a line this reader
 * cannot key.
 *
 * A line with no usable `custom_id` is DROPPED rather than guessed at: there is
 * no episode to attribute it to, and inventing one is the mis-attribution the
 * function above refuses. The drop is loud, and the caller's
 * "expected N, matched M" line makes the count visible even if a single warn is
 * missed.
 */
export function parseBatchResultLine(line: string): BatchResult | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (err) {
    log.warn(
      { err: errorMessage(err) },
      "brain extraction batch: a results line did not parse as JSON — dropped, since it names no episode to attribute it to",
    );
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const customId = typeof record.custom_id === "string" ? record.custom_id : null;
  if (customId === null || customId === "") {
    log.warn(
      {},
      "brain extraction batch: a results line carried no custom_id — dropped rather than matched by position",
    );
    return null;
  }
  const result = record.result;
  if (typeof result !== "object" || result === null) {
    return { customId, kind: "failed", error: "results line carried no result object" };
  }
  const resultRecord = result as Record<string, unknown>;
  const type = resultRecord.type;
  if (type !== "succeeded") {
    const label = typeof type === "string" ? type : "unknown";
    // ⚠️ TWO levels, because the vendor's envelope does not carry the
    // distinction on its own — see {@link UNFULFILLED_ERROR_TYPES}.
    //
    // Outer: `expired`/`canceled` are facts about the vendor.
    if (UNFULFILLED_RESULT_TYPES.has(label)) {
      return { customId, kind: "unfulfilled", reason: `the batch request ${label} at the vendor` };
    }
    const detail = resultRecord.error;
    // Inner: an `errored` line can still be the world's — an overload, a rate
    // limit, a 5xx, a rotated key. Those re-queue and charge nothing; only a
    // refusal about THIS request (`invalid_request_error`, `request_too_large`)
    // charges a strike.
    if (isWorldEvidenceError(detail)) {
      const errorType = (detail as { type: string }).type;
      return {
        customId,
        kind: "unfulfilled",
        reason: `the batch request failed with ${errorType}, which is a fact about the vendor rather than about this message`,
      };
    }
    return {
      customId,
      kind: "failed",
      error: `batch request ${label}${
        detail === undefined ? "" : `: ${JSON.stringify(detail).slice(0, 300)}`
      }`,
    };
  }
  const text = firstTextBlock(resultRecord.message);
  if (text === null) {
    return { customId, kind: "failed", error: "batch response carried no text block" };
  }
  return { customId, kind: "succeeded", text };
}

/**
 * The response's first text block. `output_config.format` guarantees it holds
 * the JSON — but the guarantee is the vendor's, so a shape that does not match
 * degrades to a per-episode failure (retried, one strike) rather than a throw
 * that would take the whole collect pass with it.
 */
function firstTextBlock(message: unknown): string | null {
  if (typeof message !== "object" || message === null) return null;
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const record = block as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") return record.text;
  }
  return null;
}

function toDateOr<T extends Date | null>(value: string | null | undefined, fallback: () => T): Date | T {
  if (typeof value !== "string") return fallback();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback() : parsed;
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

export interface BatchLedgerRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly provider: string;
  readonly provider_batch_id: string;
  readonly model_id: string;
  readonly request_count: number;
  readonly expires_at: Date | string;
  [key: string]: unknown;
}

/**
 * The collect scan. Oldest first, so an expiry is noticed at the front of the
 * queue rather than behind a run of fresh submissions — the same ordering
 * argument `DRAIN_EPISODES_SQL` makes for `ingested_at`.
 *
 * Deployment-wide with no workspace predicate, exactly like the drain: a batch's
 * results are most useful soonest, and per-workspace fairness is not something
 * one ordered queue can express without starving whoever is not first.
 * {@link COLLECT_BATCHES_PER_TICK} is what keeps one workspace from monopolising
 * a tick.
 */
export const IN_FLIGHT_BATCHES_SQL = `SELECT id, workspace_id, provider, provider_batch_id,
              model_id, request_count, expires_at
         FROM brain_extraction_batch
        WHERE status = 'in_flight'
        ORDER BY submitted_at
        LIMIT $1`;

/**
 * The episodes out with one batch. The column list MIRRORS
 * `DRAIN_EPISODES_SQL`'s, because both feed the same `EpisodeRow` — a divergence
 * would surface as a column reading `undefined` deep inside reconcile rather
 * than as a query error.
 *
 * `AND extracted_at IS NULL` makes COLLECT idempotent, which the pointer alone
 * does not: an episode stamped while its batch was in flight — the N-1 window
 * migration 0207's header names, or any future path that stamps early — would
 * otherwise be reconciled a second time from the batch text and re-stamped. One
 * clause, and it is the same predicate the drain leads with.
 */
export const BATCH_EPISODES_SQL = `SELECT id, workspace_id, source, source_id, source_actor,
              body, locator, occurred_at, visible_to
         FROM brain_episodes
        WHERE extraction_batch_id = $1
          AND extracted_at IS NULL
        ORDER BY ingested_at`;

/**
 * Record a submission and point its episodes at it, in ONE transaction.
 *
 * Atomic in the direction that matters: a ledger row with no episodes pointing
 * at it is a batch we pay for and collect nothing from, while episodes pointing
 * at a row that does not exist are un-drainable. The FK makes the second
 * unrepresentable and the transaction makes the first impossible, so a crash
 * between the two lands on the safe side — nothing submitted, nothing pointed,
 * the episodes still queued.
 *
 * ⚠️ The vendor call happens BEFORE this, so the batch can exist at Anthropic
 * with no local row if the process dies in the gap. That costs one batch's spend
 * and nothing else: the episodes were never pointed, so they re-drain and are
 * re-submitted, and the orphaned batch's results are simply never read. Recorded
 * because the reverse ordering — row first, then submit — trades that for
 * episodes pinned to a batch that never existed, which needs the expiry to
 * unwind and blocks them until it fires.
 */
export async function recordBatchSubmission(opts: {
  readonly workspaceId: string;
  readonly providerBatchId: string;
  readonly modelId: string;
  readonly expiresAt: Date;
  readonly episodeIds: readonly string[];
}): Promise<string> {
  return withBrainTransaction(async (tx) => {
    const inserted = await tx.query(
      `INSERT INTO brain_extraction_batch
         (workspace_id, provider, provider_batch_id, model_id, request_count, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'in_flight', $6)
       RETURNING id`,
      [
        opts.workspaceId,
        BATCH_PROVIDER,
        opts.providerBatchId,
        opts.modelId,
        opts.episodeIds.length,
        opts.expiresAt.toISOString(),
      ],
    );
    const row = inserted.rows[0];
    const batchId =
      typeof row === "object" && row !== null && typeof (row as { id?: unknown }).id === "string"
        ? (row as { id: string }).id
        : null;
    if (batchId === null) {
      throw new Error("brain extraction batch: INSERT … RETURNING id produced no id");
    }
    // `AND extraction_batch_id IS NULL` so a concurrent drainer that already
    // pointed one of these episodes at ITS batch keeps it. Without the guard the
    // later writer would silently re-point the episode, orphaning the first
    // batch's result for it — the episode would then be collected once, stamped,
    // and the other batch's line for it dropped as unmatched.
    await tx.query(
      `UPDATE brain_episodes
          SET extraction_batch_id = $1
        WHERE workspace_id = $2
          AND id = ANY($3::uuid[])
          AND extracted_at IS NULL
          AND extraction_batch_id IS NULL`,
      [batchId, opts.workspaceId, opts.episodeIds],
    );
    return batchId;
  });
}

/**
 * Mark a batch collected.
 *
 * The episodes' pointers are deliberately LEFT SET. The ones that reconcile in
 * this tick are stamped `extracted_at`, so the drain excludes them on that
 * alone, and the pointer becomes the record of which batch produced them. The
 * ones that do NOT — a line the results omitted, a crash before the stamp — are
 * back on the queue the instant this row stops saying `in_flight`, because
 * `DRAIN_EPISODES_SQL` excludes on the batch's STATUS rather than on the pointer
 * being null. That is deliberate and is what makes this ordering safe: settling
 * before the stamps means there is a window where an episode is unstamped and
 * pointed at a settled batch, and under a pointer-null predicate a crash in that
 * window would strand it permanently.
 *
 * So there is no "release the uncollected episodes" verb, on purpose: it would
 * be a repair pass for a state the drain's own predicate does not admit.
 */
export async function settleBatchCollected(batchId: string): Promise<void> {
  await internalQuery(
    `UPDATE brain_extraction_batch
        SET status = 'collected', settled_at = now()
      WHERE id = $1
        AND status = 'in_flight'`,
    [batchId],
  );
}

/**
 * Abandon a batch and re-queue every episode still out with it.
 *
 * ⚠️ **No strikes.** This is the AC #5352 states outright — *"a failed batch
 * does not quarantine every episode it contained"* — and it is the same
 * reasoning as `extract.ts`'s outage refund one level down: a batch that
 * expired, or a poll that keeps failing, is evidence about the WORLD, not about
 * any of the 25 episodes in it. Charging each of them would quarantine a batch
 * of perfectly good episodes after three bad batches, and the episodes are
 * exactly the ones a repaired deployment should drain first.
 *
 * A per-REQUEST error is the opposite case and IS charged — see
 * {@link parseBatchResultLine}. That split is the whole of the AC: the vendor
 * already tells us which failures are the episode's own.
 *
 * The pointer clear runs in the SAME transaction as the status change, so the
 * pair cannot half-apply into a batch marked abandoned whose episodes are still
 * excluded from the drain — un-drainable with nothing left to unwind them.
 */
export async function abandonBatch(opts: {
  readonly batchId: string;
  readonly reason: string;
}): Promise<number> {
  return withBrainTransaction(async (tx) => {
    const released = await tx.query(
      `UPDATE brain_episodes
          SET extraction_batch_id = NULL
        WHERE extraction_batch_id = $1
          AND extracted_at IS NULL
        RETURNING id`,
      [opts.batchId],
    );
    await tx.query(
      `UPDATE brain_extraction_batch
          SET status = 'abandoned', settled_at = now(), abandon_reason = $2
        WHERE id = $1
          AND status = 'in_flight'`,
      // Scrubbed at the boundary rather than at the log line: this value is
      // PERSISTED, and `error-scrub.ts` exists because vendor/pg error text
      // sometimes echoes a credentialed URL verbatim.
      [opts.batchId, errorMessage(opts.reason).slice(0, 1_000)],
    );
    return released.rows.length;
  });
}

/** In-flight batches, oldest first, bounded by {@link COLLECT_BATCHES_PER_TICK}. */
export async function loadInFlightBatches(limit: number): Promise<readonly BatchLedgerRow[]> {
  return internalQuery<BatchLedgerRow>(IN_FLIGHT_BATCHES_SQL, [limit]);
}

/**
 * The vendor half of the batch path, injectable so the two-phase cycle is
 * testable without a network — the seam `FactExtractor` already is for the
 * synchronous path, at the layer batching actually differs.
 */
export interface BatchClient {
  submit(opts: {
    readonly apiKey: string;
    readonly modelId: string;
    readonly schema: Record<string, unknown>;
    readonly items: readonly BatchRequestItem[];
  }): Promise<{ providerBatchId: string; expiresAt: Date }>;
  retrieve(opts: { readonly apiKey: string; readonly providerBatchId: string }): Promise<BatchStatus>;
  results(opts: {
    readonly apiKey: string;
    readonly resultsUrl: string;
  }): Promise<readonly BatchResult[]>;
}

/** The durable half — the in-flight ledger. Injectable for `reconcile`'s reason. */
export interface BatchLedger {
  loadInFlight(limit: number): Promise<readonly BatchLedgerRow[]>;
  loadEpisodes(batchId: string): Promise<readonly EpisodeRow[]>;
  record(opts: {
    readonly workspaceId: string;
    readonly providerBatchId: string;
    readonly modelId: string;
    readonly expiresAt: Date;
    readonly episodeIds: readonly string[];
  }): Promise<string>;
  settleCollected(batchId: string): Promise<void>;
  abandon(opts: { readonly batchId: string; readonly reason: string }): Promise<number>;
}

export const DEFAULT_BATCH_CLIENT: BatchClient = {
  submit: submitExtractionBatch,
  retrieve: retrieveExtractionBatch,
  results: readExtractionBatchResults,
};

export const DEFAULT_BATCH_LEDGER: BatchLedger = {
  loadInFlight: loadInFlightBatches,
  loadEpisodes: (batchId) => internalQuery<EpisodeRow>(BATCH_EPISODES_SQL, [batchId]),
  record: recordBatchSubmission,
  settleCollected: settleBatchCollected,
  abandon: abandonBatch,
};

// ---------------------------------------------------------------------------
// The batch phases (#5352)
//
// Both are NON-THROWING by contract, and that is what keeps them additive: the
// synchronous drain behind them must run whatever the vendor is doing, so every
// failure here degrades to "no batch work happened this tick", logged, with the
// episodes exactly where they were.
// ---------------------------------------------------------------------------

export interface BatchPhaseDeps {
  readonly client: BatchClient;
  readonly ledger: BatchLedger;
  readonly modelFor: (workspaceId: string) => Promise<ResolvedExtractionModel | null>;
  readonly now: () => Date;
}

/**
 * Poll the in-flight batches, reconcile-ready.
 *
 * Returns the episode rows whose results are in hand, and populates
 * `precomputed` with what the model said about each — the drain's rows are
 * appended to these, and both go through the same per-episode path.
 */
export async function collectBatchPhase(
  deps: BatchPhaseDeps,
  tally: BrainExtractionBatchTally,
  precomputed: Map<string, PrecomputedExtraction>,
): Promise<EpisodeRow[]> {
  let batches: readonly BatchLedgerRow[];
  try {
    batches = await deps.ledger.loadInFlight(COLLECT_BATCHES_PER_TICK);
  } catch (err) {
    log.error(
      { err: errorMessage(err) },
      "brain extraction: the in-flight batch ledger could not be read — no batch results are collected this tick; the drain still runs and the batches stay in flight",
    );
    return [];
  }

  const rows: EpisodeRow[] = [];
  for (const batch of batches) {
    try {
      rows.push(...(await collectOneBatch(batch, deps, tally, precomputed)));
    } catch (err) {
      // A poll or a results read that FAILED is not by itself a reason to give
      // up: a 429 or a 502 clears, and the batch's work is already paid for. So
      // the batch stays in flight and is retried next tick — UNLESS it is past
      // its expiry, at which point there is nothing left to wait for.
      const reason = errorMessage(err);
      // ⚠️ GUARDED, because this runs INSIDE the catch: `ledger.abandon` writes
      // to the internal DB, and a DB blip concurrent with a vendor fault is not
      // exotic. An unguarded rejection here escapes the loop, escapes
      // `collectBatchPhase` — whose contract is that it never throws — and
      // escapes `scan`, so the DRAIN never runs and the whole tick is audited
      // as a scan fault. The batch simply stays in flight, which is where it
      // already was.
      const abandoned = await abandonIfExpired(batch, deps, tally, reason).catch((abandonErr) => {
        log.error(
          { workspaceId: batch.workspace_id, batchId: batch.id, err: errorMessage(abandonErr) },
          "brain extraction: could not abandon an expired batch — it stays in flight and is retried next tick; the drain is unaffected",
        );
        return false;
      });
      log.warn(
        {
          workspaceId: batch.workspace_id,
          batchId: batch.id,
          providerBatchId: batch.provider_batch_id,
          abandoned,
          err: reason,
        },
        abandoned
          ? "brain extraction: a batch failed to collect AND is past its expiry — abandoned, and its episodes are re-queued with no strike against them"
          : "brain extraction: a batch failed to collect — it stays in flight and is retried next tick, since the work is already paid for and a transient vendor fault clears",
      );
    }
  }
  return rows;
}

/**
 * Abandon a batch and record it — THE only writer of `abandoned`/`requeued`.
 *
 * A one-line wrapper on purpose. The two counters describe one event, and an
 * earlier cut incremented them at two call sites, one of which reached
 * `ledger.abandon` directly. That is the shape where a third abandon path
 * updates one counter and not the other, and the result — `abandoned: 3,
 * requeued: 0` — reads as "three batches gave up and stranded everything",
 * which is the alarm an operator would act on.
 *
 * ⚠️ **No strikes, ever.** #5352's AC states it outright — *"a failed batch does
 * not quarantine every episode it contained"* — and the reasoning is the outage
 * refund's, one level up: an abandoned batch is evidence about the world, not
 * about any of the 25 episodes in it. See {@link abandonBatch}.
 */
async function abandonAndTally(
  batch: BatchLedgerRow,
  deps: BatchPhaseDeps,
  tally: BrainExtractionBatchTally,
  reason: string,
): Promise<number> {
  const requeued = await deps.ledger.abandon({ batchId: batch.id, reason });
  tally.abandoned++;
  tally.requeued += requeued;
  return requeued;
}

/**
 * Give up on a batch whose expiry has passed. Returns whether it did.
 *
 * The expiry TEST is the whole of this function; the abandon itself belongs to
 * {@link abandonAndTally}, which owns the counters.
 */
async function abandonIfExpired(
  batch: BatchLedgerRow,
  deps: BatchPhaseDeps,
  tally: BrainExtractionBatchTally,
  reason: string,
): Promise<boolean> {
  const expiresAt = toDate(batch.expires_at);
  // An UNPARSEABLE expiry is treated as expired rather than as "wait forever".
  // The column is `NOT NULL` so this is query drift if it ever fires, and the
  // safe direction for drift is the one that re-queues the episodes: a batch we
  // cannot date is a batch nothing would ever abandon.
  if (expiresAt !== null && expiresAt.getTime() > deps.now().getTime()) return false;
  await abandonAndTally(batch, deps, tally, reason);
  return true;
}

/** Collect one batch. Throws on a vendor fault; the caller decides what that means. */
async function collectOneBatch(
  batch: BatchLedgerRow,
  deps: BatchPhaseDeps,
  tally: BrainExtractionBatchTally,
  precomputed: Map<string, PrecomputedExtraction>,
): Promise<EpisodeRow[]> {
  // The SAME resolution the submit used — so a workspace that moved off
  // Anthropic, or whose key stopped decrypting, cannot be polled with somebody
  // else's credentials.
  const resolved = await deps.modelFor(batch.workspace_id);
  const apiKey = resolved?.batchApiKey ?? null;
  if (apiKey === null) {
    const abandoned = await abandonIfExpired(
      batch,
      deps,
      tally,
      "the workspace no longer resolves a batch-capable provider, and the batch expired before it did again",
    );
    log.warn(
      { workspaceId: batch.workspace_id, batchId: batch.id, abandoned },
      abandoned
        ? "brain extraction: a batch's workspace no longer resolves a batch-capable provider and the batch has expired — abandoned, episodes re-queued for the synchronous path"
        : "brain extraction: a batch's workspace does not currently resolve a batch-capable provider — leaving the batch in flight until the configuration is repaired or it expires",
    );
    return [];
  }

  tally.polled++;
  const status = await deps.client.retrieve({
    apiKey,
    providerBatchId: batch.provider_batch_id,
  });
  if (status.processingStatus !== "ended") {
    // Still working. `canceling` lands here too and resolves to `ended` on a
    // later tick, which is the vendor's own transition and not ours to shortcut.
    await abandonIfExpired(
      batch,
      deps,
      tally,
      `the batch was still ${status.processingStatus} at its expiry`,
    );
    return [];
  }
  if (status.resultsUrl === null) {
    // Ended with nowhere to read from. Terminal by definition — waiting cannot
    // produce a url a finished batch does not have — so this abandons
    // regardless of expiry, and the episodes go back on the queue.
    const requeued = await abandonAndTally(
      batch,
      deps,
      tally,
      "the batch ended with no results url",
    );
    log.error(
      { workspaceId: batch.workspace_id, batchId: batch.id, requeued },
      "brain extraction: a batch ended with no results url — abandoned and its episodes re-queued; nothing is lost, but the spend on that batch is",
    );
    return [];
  }

  const results = await deps.client.results({ apiKey, resultsUrl: status.resultsUrl });
  const episodes = await deps.ledger.loadEpisodes(batch.id);

  // ⚠️ KEYED BY `custom_id`, NEVER BY POSITION — the vendor states results
  // arrive in any order, and the ordering that would make positional matching
  // appear to work is the common case. `extract-batch.test.ts` shuffles the
  // result order to pin this.
  const byCustomId = new Map(results.map((result) => [result.customId, result]));

  const rows: EpisodeRow[] = [];
  let unfulfilled = 0;
  for (const episode of episodes) {
    const result = byCustomId.get(episode.id);
    // Not covered by the results, or covered by a line that is evidence about
    // the VENDOR rather than about this episode (`expired`, `canceled`).
    // Neither is a failure and neither charges a strike — the drain re-selects
    // the episode the moment this batch stops being `in_flight`, because it
    // excludes on the batch's STATUS rather than on the pointer. See
    // `DRAIN_EPISODES_SQL` and `BatchResult`.
    if (result === undefined) continue;
    if (result.kind === "unfulfilled") {
      unfulfilled++;
      continue;
    }
    precomputed.set(
      episode.id,
      result.kind === "succeeded"
        ? parseBatchCandidates(result.text, episode, batch.model_id)
        : { kind: "failed", error: result.error },
    );
    rows.push(episode);
  }

  if (unfulfilled > 0) {
    // `requeued` WITHOUT `abandoned`, and that is correct rather than the
    // half-update {@link abandonAndTally} exists to prevent: the batch itself
    // collected fine, and some requests inside it did not. Nothing was
    // abandoned, so nothing increments that counter.
    tally.requeued += unfulfilled;
    log.warn(
      {
        workspaceId: batch.workspace_id,
        batchId: batch.id,
        unfulfilled,
        carried: batch.request_count,
      },
      "brain extraction: the vendor expired or cancelled requests inside a batch that otherwise ended — those episodes are re-queued with NO strike against them, because an expiry is a fact about the vendor and not about the message. `unfulfilled` equal to the whole batch is a vendor capacity incident, not a corpus problem",
    );
  }

  const accounted = rows.length + unfulfilled;
  if (accounted !== batch.request_count) {
    log.warn(
      {
        workspaceId: batch.workspace_id,
        batchId: batch.id,
        expected: batch.request_count,
        matched: rows.length,
        unfulfilled,
        resultLines: results.length,
      },
      "brain extraction: a batch accounted for fewer episodes than it carried — the unmatched ones are re-queued automatically (the drain excludes on batch STATUS, not on the pointer), so nothing is lost; a persistent gap means custom_id drift and is worth investigating",
    );
  }

  // BEFORE the episodes are reconciled and stamped, which is safe only because
  // the drain reads the batch's status — see `settleBatchCollected`. Settling
  // after would need the stamps to have happened, and they happen per-episode
  // later in this tick, inside the cycle skeleton.
  await deps.ledger.settleCollected(batch.id);
  tally.collected++;
  return rows;
}

/**
 * One batch result's text → candidates, or a per-episode failure.
 *
 * The model's answer is parsed through {@link ExtractionSchema} — the SAME
 * schema `generateObject` validates against on the synchronous path — so a
 * batched claim cannot reach reconcile in a shape the immediate path would have
 * rejected. A parse failure is the episode's own (it is that episode's response)
 * and therefore charges a strike, which is what makes a model that has stopped
 * following the schema back off instead of costing a batch per tick forever.
 */
function parseBatchCandidates(
  text: string,
  row: EpisodeRow,
  modelId: string,
): PrecomputedExtraction {
  const episode = toEpisodeRef(row, isUnknownArray(row.visible_to) ? row.visible_to : []);
  try {
    const parsed = ExtractionSchema.parse(JSON.parse(text));
    return { kind: "candidates", candidates: toFactCandidates(parsed.facts, episode, modelId) };
  } catch (err) {
    return {
      kind: "failed",
      error: `batch result did not match the extraction schema: ${errorMessage(err)}`,
    };
  }
}

/**
 * Send this tick's drained episodes out as batches, one per workspace.
 *
 * Returns the ids that went out — the caller drops them from the synchronous
 * set. Anything NOT returned falls through to the immediate path this tick,
 * which is what makes a partial capability (one BYO workspace on Anthropic, one
 * on Azure) degrade per workspace rather than per deployment.
 *
 * Never throws.
 */
export async function submitBatchPhase(
  rows: readonly EpisodeRow[],
  deps: BatchPhaseDeps,
  tally: BrainExtractionBatchTally,
): Promise<ReadonlySet<string>> {
  const submitted = new Set<string>();
  // Grouped by workspace because a batch carries ONE model id and ONE key, and
  // both are workspace-resolved. Order within a group is the drain's, so the
  // oldest episodes still go out first.
  const byWorkspace = new Map<string, EpisodeRow[]>();
  for (const row of rows) {
    // A body-less episode is stamped without a model call by the per-episode
    // path (`no_body`); batching it would pay for a request whose answer is
    // discarded. Same for one that is already excluded by the pre-flight gate —
    // but that check needs a `ReconcileEpisodeRef`, so it stays where it is and
    // this filter takes only the free half.
    if (row.body === null || row.body.trim() === "") continue;
    const group = byWorkspace.get(row.workspace_id);
    if (group === undefined) byWorkspace.set(row.workspace_id, [row]);
    else group.push(row);
  }

  for (const [workspaceId, group] of byWorkspace) {
    try {
      const resolved = await deps.modelFor(workspaceId);
      // `null` from either arm means the synchronous path handles this
      // workspace: an unresolvable model is already the `model_unavailable`
      // skip, and a provider with no batch endpoint is the documented fallback.
      if (resolved === null || resolved.batchApiKey === null) continue;

      const { providerBatchId, expiresAt } = await deps.client.submit({
        apiKey: resolved.batchApiKey,
        modelId: resolved.modelId,
        schema: EXTRACTION_JSON_SCHEMA,
        items: group.map((row) => {
          const episode = toEpisodeRef(row, isUnknownArray(row.visible_to) ? row.visible_to : []);
          const excerpt = extractionExcerpt(episode, row.body ?? "");
          return {
            customId: row.id,
            system: EXTRACTION_SYSTEM_PROMPT,
            prompt: extractionPrompt(episode, excerpt),
          };
        }),
      });

      // ⚠️ The vendor call happens BEFORE the ledger write, so a crash in
      // between costs one batch's spend and strands nothing — the episodes were
      // never pointed, so they re-drain. `recordBatchSubmission`'s docstring
      // carries why the reverse ordering is worse.
      const batchId = await deps.ledger.record({
        workspaceId,
        providerBatchId,
        modelId: resolved.modelId,
        expiresAt,
        episodeIds: group.map((row) => row.id),
      });

      for (const row of group) submitted.add(row.id);
      tally.submitted += group.length;
      log.info(
        {
          workspaceId,
          batchId,
          providerBatchId,
          modelId: resolved.modelId,
          episodes: group.length,
          expiresAt: expiresAt.toISOString(),
        },
        "brain extraction: submitted a batch — these episodes stay queued and unstamped until its results are reconciled",
      );
    } catch (err) {
      // Per WORKSPACE, so one tenant's broken key cannot stop another's batch,
      // and the whole group simply takes the synchronous path this tick. `warn`
      // rather than `error`: nothing is lost and the fallback is the behaviour
      // this deployment had before batching was switched on.
      log.warn(
        { workspaceId, episodes: group.length, err: errorMessage(err) },
        "brain extraction: batch submission failed for this workspace — its episodes fall through to the immediate path this tick",
      );
    }
  }
  return submitted;
}
