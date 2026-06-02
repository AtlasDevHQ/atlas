/**
 * Sub-processor change-feed publisher (#1924, phase 3).
 *
 * Outbound flow — opposite direction from `@useatlas/webhook` (which is
 * inbound, accepting Zapier/Make/n8n requests).
 *
 *   POST <subscription.url>
 *   Content-Type: application/json
 *   X-Webhook-Timestamp: <unix seconds>
 *   X-Webhook-Signature: sha256=<hex>      // HMAC over `${ts}:${body}`
 *
 * The signing input (`${ts}:${body}`) and the headers are the same shape
 * the inbound `@useatlas/webhook` plugin already verifies. The one
 * difference: outbound deliveries prefix the digest with `sha256=`
 * (Stripe/GitHub-style), whereas the inbound plugin currently expects
 * bare hex. The verify helper in
 * apps/docs/content/docs/integrations/sub-processor-feed.mdx accounts
 * for the prefix, so customer Slack adapters that copy from those docs
 * are correct out of the box. A literal copy of the inbound plugin's
 * `verifyHmacWithTimestamp` would need a one-line `s.replace(/^sha256=/, "")`
 * before comparison.
 *
 * On startup the SchedulerLayer forks `subProcessorPublisherTick` on a
 * configurable interval (default 6h). `Effect.repeat(Schedule.spaced(...))`
 * runs the tick once eagerly on boot and then waits the interval — so
 * the first sweep happens within seconds of API boot, not after the
 * first 6h window.
 *
 * Each tick:
 *
 *   1. Fetches the live JSON from `ATLAS_SUBPROCESSORS_URL` (default the
 *      production www static asset). Skipped if no subscriptions exist —
 *      self-hosted operators with zero rows pay zero network cost.
 *   2. Hashes the payload and compares against the most recent row in
 *      `sub_processor_snapshots`. No diff → exit.
 *   3. Computes per-entry add / change / remove events keyed by `name`.
 *   4. For every (event, subscription) pair, signs and POSTs. Per-row
 *      4xx/5xx responses log but never crash the tick — the publisher
 *      is best-effort across subscribers, not transactional.
 *   5. Inserts the new snapshot row last so a delivery crash mid-fan-out
 *      replays the same diff on the next tick.
 *
 * Two early-exit cases insert a snapshot **without** any fan-out:
 *
 *   (a) Hash drift with zero semantic diff (e.g. whitespace re-format,
 *       sort order change). Stamping the new snapshot stops the diff
 *       from re-firing every 6h.
 *   (b) The very first snapshot for this internal DB. Establishes a
 *       baseline so existing subscribers don't get flooded with N
 *       "added" events on day one.
 *
 * The "snapshot row last" ordering matters: a partial fan-out followed
 * by a snapshot insert would drop events for subscribers we hadn't
 * reached yet. Inserting last means the next tick re-derives the same
 * diff and re-delivers — at-least-once semantics, which is the right
 * default for compliance notifications. Subscribers should treat
 * repeated `(name, event)` pairs as idempotent updates; we recommend
 * `(name, event, changed_at)` as the de-dupe key.
 *
 * Decrypt failure is **not** treated as a per-delivery hiccup — it
 * means the encryption keyset has been misconfigured (key rotated out,
 * env var dropped) or the row is corrupted. The error propagates so
 * the outer scheduler `catchAll` records it as a tick-level failure
 * rather than silently retrying every 6h while subscribers go dark.
 */

import crypto from "crypto";

import {
  cappedExponentialDelays,
  deliverWebhook,
  timestamped,
} from "@useatlas/webhook-publisher";
import { z } from "zod";

import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { activeKeyVersion } from "@atlas/api/lib/db/encryption-keys";
import { decryptSecret, encryptSecret, type OpaqueSecret } from "@atlas/api/lib/db/secret-encryption";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("sub-processor-publisher");

export const SUBPROCESSOR_PUBLISH_INTERVAL_MS = Number.parseInt(
  process.env.ATLAS_SUBPROCESSOR_PUBLISH_INTERVAL_MS ?? "21600000", // 6h
  10,
);

const DEFAULT_SOURCE_URL = "https://www.useatlas.dev/sub-processors/data.json";

// Bounded retry: 3 attempts with capped exponential backoff. Compliance
// notifications can tolerate a slow delivery; what they cannot tolerate
// is a failed delivery silently dropped.
const DELIVERY_MAX_ATTEMPTS = 3;
const DELIVERY_BACKOFF_BASE_MS = 1000;
const DELIVERY_TIMEOUT_MS = 10_000;

// ──────────────────────────────────────────────────────────────────────
// Types + runtime schema
// ──────────────────────────────────────────────────────────────────────

/**
 * `since` carries either the legacy display shorthand `YYYY-MM` (kept
 * stable for the rendered table) or a full ISO date. `changed_at` must
 * be a full ISO `YYYY-MM-DD` — it drives Atom <updated> and is part of
 * the recommended subscriber de-dupe key.
 */
export const SubProcessorSchema = z.object({
  name: z.string().min(1),
  purpose: z.string().min(1),
  region: z.string().min(1),
  since: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/, "since must be YYYY-MM or YYYY-MM-DD"),
  changed_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "changed_at must be YYYY-MM-DD"),
});

export type SubProcessor = z.infer<typeof SubProcessorSchema>;

export type ChangeEvent =
  | { event: "added"; entry: SubProcessor }
  | { event: "removed"; entry: SubProcessor }
  | { event: "changed"; entry: SubProcessor; previous: SubProcessor };

export interface SubscriptionRow extends Record<string, unknown> {
  id: string;
  url: string;
  token_encrypted: string;
}

/**
 * Tagged union — illegal field combinations (e.g. `ok: true, error: …`)
 * cannot be constructed. Mirrors the discriminated-union pattern used
 * for `SubmitState` in apps/www/src/components/sub-processor-webhook-button.tsx
 * and `ChangeEvent` above. `decrypt_failed` does not actually escape
 * `deliver()` — it re-throws — but the variant is reserved for tests
 * and for any future caller that decides to swallow it.
 */
export type DeliveryAttempt =
  | { kind: "ok"; subscriptionId: string; status: number; attempts: number }
  | { kind: "http_error"; subscriptionId: string; status: number; attempts: number; error: string }
  | { kind: "transport_error"; subscriptionId: string; attempts: number; error: string };

export interface SignedRequest {
  readonly body: string;
  readonly timestamp: number;
  readonly signature: string;
  readonly headers: Readonly<Record<string, string>>;
}

// ──────────────────────────────────────────────────────────────────────
// Pure helpers (exported for unit tests — no DB, no fetch)
// ──────────────────────────────────────────────────────────────────────

export function hashPayload(entries: ReadonlyArray<SubProcessor>): string {
  const canonical = JSON.stringify(
    [...entries].sort((a, b) => a.name.localeCompare(b.name)),
  );
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

export function computeDiff(
  prev: ReadonlyArray<SubProcessor>,
  next: ReadonlyArray<SubProcessor>,
): ChangeEvent[] {
  const prevByName = new Map(prev.map((entry) => [entry.name, entry]));
  const nextByName = new Map(next.map((entry) => [entry.name, entry]));
  const events: ChangeEvent[] = [];

  for (const [name, entry] of nextByName) {
    const previous = prevByName.get(name);
    if (!previous) {
      events.push({ event: "added", entry });
    } else if (
      previous.purpose !== entry.purpose ||
      previous.region !== entry.region ||
      previous.changed_at !== entry.changed_at
    ) {
      events.push({ event: "changed", entry, previous });
    }
  }
  for (const [name, entry] of prevByName) {
    if (!nextByName.has(name)) {
      events.push({ event: "removed", entry });
    }
  }
  return events;
}

export function signRequest(
  payload: unknown,
  token: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): SignedRequest {
  // Delegates to the shared `timestamped` strategy so the wire format stays
  // identical to (and locked against) every other Atlas outbound sender.
  // `nowSeconds` is already resolved by the default param, so the returned
  // `.timestamp` matches the `X-Webhook-Timestamp` header the strategy emits.
  const body = JSON.stringify(payload);
  const { signature, headers } = timestamped({
    secret: token,
    timestampSeconds: nowSeconds,
  })(body);
  return { body, timestamp: nowSeconds, signature, headers };
}

// ──────────────────────────────────────────────────────────────────────
// Delivery — uses fetch, isolated for test injection
// ──────────────────────────────────────────────────────────────────────

export type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Deliver one event to one subscription. Returns a tagged outcome for
 * caller introspection (tests assert against it; the tick currently
 * only logs). Throws on decrypt failure — see file header for why.
 */
export async function deliver(
  subscription: SubscriptionRow,
  event: ChangeEvent,
  options: {
    fetcher?: Fetcher;
    nowSeconds?: number;
    /** Injectable sleep — test seam. Defaults to a real timer in the package. */
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<DeliveryAttempt> {
  let token: string;
  try {
    token = decryptSecret(subscription.token_encrypted);
  } catch (err) {
    log.error(
      {
        err: errorMessage(err),
        subscriptionId: subscription.id,
        url: subscription.url,
        errorId: "subprocessor_token_unsignable",
      },
      "Sub-processor subscription token cannot be decrypted — check ATLAS_ENCRYPTION_KEYS keyset / rotation history. The next tick will fail identically until this is resolved.",
    );
    // Re-throw BEFORE any network call so the outer scheduler catchAll records
    // a tick failure. A decrypt failure is a configuration emergency, not a
    // delivery hiccup — silently retrying every 6h would just hide the
    // misconfig. (deliverWebhook is therefore never reached, so its fetcher
    // is never invoked.)
    throw err instanceof Error ? err : new Error(String(err));
  }

  // Transport + retry + per-attempt timeout now live in the shared
  // `@useatlas/webhook-publisher` primitive. The `timestamped` strategy
  // reproduces the exact `sha256=<hmac(${ts}:${body})>` wire format, the retry
  // budget stays 3 attempts with [1000, 2000]ms capped-exponential backoff,
  // and 4xx is still permanent (1 attempt) while 5xx/transport retries to 3.
  const outcome = await deliverWebhook({
    url: subscription.url,
    payload: event,
    sign: timestamped({ secret: token, timestampSeconds: options.nowSeconds }),
    retry: {
      maxAttempts: DELIVERY_MAX_ATTEMPTS,
      delaysMs: cappedExponentialDelays({
        baseMs: DELIVERY_BACKOFF_BASE_MS,
        count: DELIVERY_MAX_ATTEMPTS - 1,
      }),
    },
    timeoutMs: DELIVERY_TIMEOUT_MS,
    fetcher: options.fetcher,
    sleep: options.sleep,
  });

  // deliverWebhook does no logging of its own (and neither did the old loop
  // per-attempt) — so reproduce the two original log points from the FINAL
  // outcome. A 4xx is a contract bug worth `error` visibility; an exhausted
  // 5xx / transport failure is a transient `warn`.
  if (
    outcome.kind === "http_error" &&
    outcome.status >= 400 &&
    outcome.status < 500
  ) {
    log.error(
      {
        subscriptionId: subscription.id,
        status: outcome.status,
        url: subscription.url,
        eventKind: event.event,
        entry: event.entry.name,
        errorId: "subprocessor_delivery_4xx",
      },
      "Sub-processor webhook delivery rejected with 4xx — the subscriber's endpoint will not see this event again unless reconstructed from sub_processor_snapshots",
    );
  } else if (outcome.kind !== "ok") {
    log.warn(
      {
        subscriptionId: subscription.id,
        status: outcome.kind === "http_error" ? outcome.status : null,
        err: outcome.error,
        eventKind: event.event,
        entry: event.entry.name,
        errorId: "subprocessor_delivery_exhausted",
      },
      "Sub-processor webhook delivery failed after retries",
    );
  }

  // Map the package's DeliveryOutcome → the existing tagged DeliveryAttempt
  // union: add `subscriptionId`, drop `signature`/`responseText`, keep
  // `error = http_<status>` (the package already normalizes it that way).
  switch (outcome.kind) {
    case "ok":
      return {
        kind: "ok",
        subscriptionId: subscription.id,
        status: outcome.status,
        attempts: outcome.attempts,
      };
    case "http_error":
      return {
        kind: "http_error",
        subscriptionId: subscription.id,
        status: outcome.status,
        attempts: outcome.attempts,
        error: outcome.error,
      };
    case "transport_error":
      return {
        kind: "transport_error",
        subscriptionId: subscription.id,
        attempts: outcome.attempts,
        error: outcome.error,
      };
    default: {
      // `@useatlas/webhook-publisher` is independently versioned — if a future
      // release adds a fourth `DeliveryOutcome` kind, fail the build here
      // rather than silently returning `undefined` (noImplicitReturns is off).
      const _exhaustive: never = outcome;
      throw new Error(
        `Unhandled delivery outcome: ${JSON.stringify(_exhaustive)}`,
      );
    }
  }
}

function globalFetch(input: string, init: RequestInit): Promise<Response> {
  return fetch(input, init);
}

// ──────────────────────────────────────────────────────────────────────
// DB operations
// ──────────────────────────────────────────────────────────────────────

interface SnapshotRow {
  payload: SubProcessor[];
  payload_hash: string;
}

async function readLatestSnapshot(): Promise<SnapshotRow | null> {
  const rows = await internalQuery<{ payload: SubProcessor[]; payload_hash: string }>(
    `SELECT payload, payload_hash
     FROM sub_processor_snapshots
     ORDER BY published_at DESC
     LIMIT 1`,
  );
  return rows[0] ?? null;
}

async function insertSnapshot(
  payload: ReadonlyArray<SubProcessor>,
  payloadHash: string,
): Promise<void> {
  await internalQuery(
    `INSERT INTO sub_processor_snapshots (payload, payload_hash)
     VALUES ($1, $2)`,
    [JSON.stringify(payload), payloadHash],
  );
}

async function listSubscriptions(): Promise<SubscriptionRow[]> {
  return internalQuery<SubscriptionRow>(
    `SELECT id, url, token_encrypted
     FROM sub_processor_subscriptions
     ORDER BY created_at ASC`,
  );
}

export interface CreateSubscriptionInput {
  id: string;
  url: string;
  token: string;
  /** Authenticated user id at registration time (audit only). */
  createdByUserId: string | null;
  /**
   * AtlasUser.label at registration time (audit only). Note: this is
   * the user's display label, not a guaranteed email — managed-mode
   * sessions carry an email, AAD/Slack-bound sessions carry a UPN or
   * handle. Stored verbatim, never rendered back to other users.
   */
  createdByLabel: string | null;
}

export async function createSubscription(
  input: CreateSubscriptionInput,
): Promise<{ id: string }> {
  const tokenEncrypted: OpaqueSecret = encryptSecret(input.token);
  await internalQuery(
    `INSERT INTO sub_processor_subscriptions
       (id, url, token_encrypted, token_key_version, created_by_user_id, created_by_label)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.id,
      input.url,
      tokenEncrypted,
      activeKeyVersion(),
      input.createdByUserId,
      // Trim and collapse empty strings to null so the audit column
      // doesn't accumulate "" rows from edge-case label sources.
      input.createdByLabel?.trim() || null,
    ],
  );
  return { id: input.id };
}

// ──────────────────────────────────────────────────────────────────────
// Source-of-truth fetch
// ──────────────────────────────────────────────────────────────────────

export function getSourceUrl(): string {
  return process.env.ATLAS_SUBPROCESSORS_URL ?? DEFAULT_SOURCE_URL;
}

async function fetchCurrent(
  fetcher: Fetcher,
  url: string,
): Promise<SubProcessor[] | null> {
  let res: Response;
  try {
    res = await fetcher(url, { method: "GET" });
  } catch (err) {
    // Transport/DNS errors are usually transient — log warn so retries
    // on the next tick clear the blip without paging anyone.
    log.warn(
      { url, err: errorMessage(err), errorId: "subprocessor_source_unreachable" },
      "Failed to fetch sub-processor source — will retry next tick",
    );
    return null;
  }
  if (!res.ok) {
    // 4xx/5xx from a *static asset* on www is a misconfig (URL typo,
    // www route removed, broken deploy), not a transient blip — log
    // error so it surfaces in alerts.
    log.error(
      { url, status: res.status, errorId: "subprocessor_source_unreachable" },
      "Sub-processor source returned non-OK — check ATLAS_SUBPROCESSORS_URL",
    );
    return null;
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    log.error(
      { url, err: errorMessage(err), errorId: "subprocessor_source_malformed" },
      "Sub-processor source did not return valid JSON",
    );
    return null;
  }
  if (!Array.isArray(body)) {
    log.error(
      { url, errorId: "subprocessor_source_malformed" },
      "Sub-processor source returned non-array payload",
    );
    return null;
  }
  // Per-row validation. A single bad row poisons the whole tick — we
  // refuse to fan out HMAC-signed payloads with fields TS says are
  // strings but JSON proved otherwise.
  const parsed: SubProcessor[] = [];
  for (const [index, raw] of body.entries()) {
    const result = SubProcessorSchema.safeParse(raw);
    if (!result.success) {
      log.error(
        {
          url,
          index,
          err: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
          errorId: "subprocessor_source_malformed",
        },
        "Sub-processor source contains an entry that fails schema validation — skipping tick",
      );
      return null;
    }
    parsed.push(result.data);
  }
  return parsed;
}

// ──────────────────────────────────────────────────────────────────────
// Tick — entry point wired into SchedulerLayer
// ──────────────────────────────────────────────────────────────────────

export interface TickOptions {
  fetcher?: Fetcher;
  sourceUrl?: string;
}

export async function subProcessorPublisherTick(
  options: TickOptions = {},
): Promise<void> {
  if (!hasInternalDB()) return;

  const subscriptions = await listSubscriptions();
  if (subscriptions.length === 0) return;

  const fetcher = options.fetcher ?? globalFetch;
  const url = options.sourceUrl ?? getSourceUrl();
  const next = await fetchCurrent(fetcher, url);
  if (!next) return;

  const nextHash = hashPayload(next);
  const previousSnapshot = await readLatestSnapshot();

  if (previousSnapshot && previousSnapshot.payload_hash === nextHash) return;

  const events = computeDiff(previousSnapshot?.payload ?? [], next);
  if (previousSnapshot && events.length === 0) {
    // Hash differs but no semantic change (e.g. whitespace/sort drift).
    // Stamp a new snapshot to stop re-diffing on every tick.
    await insertSnapshot(next, nextHash);
    return;
  }

  if (!previousSnapshot) {
    // First-ever snapshot. Don't fan out a flood of "added" events to
    // existing subscribers — record the baseline and start diffing on
    // the next change.
    await insertSnapshot(next, nextHash);
    log.info(
      { count: next.length },
      "Recorded initial sub-processor snapshot — events will fire on the next change",
    );
    return;
  }

  log.info(
    { events: events.length, subscribers: subscriptions.length },
    "Publishing sub-processor change events",
  );

  for (const event of events) {
    for (const subscription of subscriptions) {
      // Each delivery is independent; a failure for one subscription
      // does not block delivery to the next.
      await deliver(subscription, event, { fetcher });
    }
  }

  await insertSnapshot(next, nextHash);
}
