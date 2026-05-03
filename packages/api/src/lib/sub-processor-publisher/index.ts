/**
 * Sub-processor change-feed publisher (#1924, phase 3).
 *
 * Outbound flow — opposite direction from `@useatlas/webhook` (which is
 * inbound, accepting Zapier/Make/n8n requests). The wire format here is
 * intentionally symmetric with the inbound plugin's `verifyHmacWithTimestamp`
 * helper so customer Slack adapters can reuse the same verification snippet:
 *
 *   POST <subscription.url>
 *   Content-Type: application/json
 *   X-Webhook-Timestamp: <unix seconds>
 *   X-Webhook-Signature: sha256=<hex>      // HMAC over `${ts}:${body}`
 *
 * On startup the SchedulerLayer forks `subProcessorPublisherTick` on a
 * configurable interval (default 6h). Each tick:
 *
 *   1. Fetches the live JSON from `ATLAS_SUBPROCESSORS_URL` (default the
 *      production www static asset). Skipped if no subscriptions exist —
 *      self-hosted operators with zero rows pay zero network cost.
 *   2. Hashes the payload and compares against the most recent row in
 *      `sub_processor_snapshots`. No diff → exit.
 *   3. Computes per-entry add / change / remove events keyed by `name`.
 *   4. For every (event, subscription) pair, signs and POSTs. Failures
 *      log with the subscription id but never crash the tick — the
 *      publisher is best-effort, not transactional.
 *   5. Inserts the new snapshot row last so a delivery crash mid-fan-out
 *      replays the same diff on the next tick.
 *
 * The "snapshot row last" ordering matters: a partial fan-out followed
 * by a snapshot insert would drop events for subscribers we hadn't
 * reached yet. Inserting last means the next tick re-derives the same
 * diff and re-delivers — at-least-once semantics, which is the right
 * default for compliance notifications. Subscribers de-dupe by `(name,
 * event, changed_at)`.
 */

import crypto from "crypto";

import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { decryptSecret, encryptSecret } from "@atlas/api/lib/db/secret-encryption";
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

export interface SubProcessor {
  name: string;
  purpose: string;
  region: string;
  since: string;
  changed_at: string;
}

export type ChangeEvent =
  | { event: "added"; entry: SubProcessor }
  | { event: "removed"; entry: SubProcessor }
  | { event: "changed"; entry: SubProcessor; previous: SubProcessor };

export interface SubscriptionRow extends Record<string, unknown> {
  id: string;
  url: string;
  token_encrypted: string;
}

export interface DeliveryAttempt {
  subscriptionId: string;
  status: number | null;
  ok: boolean;
  attempts: number;
  error: string | null;
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

export interface SignedRequest {
  body: string;
  timestamp: number;
  signature: string;
  headers: Record<string, string>;
}

export function signRequest(
  payload: unknown,
  token: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): SignedRequest {
  const body = JSON.stringify(payload);
  const signingInput = `${nowSeconds}:${body}`;
  const signature = `sha256=${crypto
    .createHmac("sha256", token)
    .update(signingInput)
    .digest("hex")}`;
  return {
    body,
    timestamp: nowSeconds,
    signature,
    headers: {
      "Content-Type": "application/json",
      "X-Webhook-Timestamp": String(nowSeconds),
      "X-Webhook-Signature": signature,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Delivery — uses fetch, isolated for test injection
// ──────────────────────────────────────────────────────────────────────

export type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

export async function deliver(
  subscription: SubscriptionRow,
  event: ChangeEvent,
  options: { fetcher?: Fetcher; nowSeconds?: number } = {},
): Promise<DeliveryAttempt> {
  const fetcher = options.fetcher ?? globalFetch;

  let token: string;
  try {
    token = decryptSecret(subscription.token_encrypted);
  } catch (err) {
    log.error(
      { err: errorMessage(err), subscriptionId: subscription.id },
      "Failed to decrypt subscription token — skipping delivery",
    );
    return {
      subscriptionId: subscription.id,
      status: null,
      ok: false,
      attempts: 0,
      error: "decrypt_failed",
    };
  }

  const signed = signRequest(event, token, options.nowSeconds);

  let lastError: string | null = null;
  let lastStatus: number | null = null;

  for (let attempt = 1; attempt <= DELIVERY_MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
    try {
      const res = await fetcher(subscription.url, {
        method: "POST",
        headers: signed.headers,
        body: signed.body,
        signal: controller.signal,
      });
      lastStatus = res.status;
      if (res.ok) {
        return {
          subscriptionId: subscription.id,
          status: res.status,
          ok: true,
          attempts: attempt,
          error: null,
        };
      }
      // 4xx is a permanent failure — no point retrying. 5xx + transport
      // errors get the backoff treatment.
      if (res.status >= 400 && res.status < 500) {
        lastError = `http_${res.status}`;
        break;
      }
      lastError = `http_${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timer);
    }

    if (attempt < DELIVERY_MAX_ATTEMPTS) {
      const wait = DELIVERY_BACKOFF_BASE_MS * 2 ** (attempt - 1);
      await sleep(wait);
    }
  }

  log.warn(
    {
      subscriptionId: subscription.id,
      status: lastStatus,
      err: lastError,
      eventKind: event.event,
      entry: event.entry.name,
    },
    "Sub-processor webhook delivery failed after retries",
  );
  return {
    subscriptionId: subscription.id,
    status: lastStatus,
    ok: false,
    attempts: DELIVERY_MAX_ATTEMPTS,
    error: lastError,
  };
}

function globalFetch(input: string, init: RequestInit): Promise<Response> {
  return fetch(input, init);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  createdByUserId?: string | null;
  createdByEmail?: string | null;
}

export async function createSubscription(
  input: CreateSubscriptionInput,
): Promise<{ id: string }> {
  const tokenEncrypted = encryptSecret(input.token);
  const keyVersion = parseStoredKeyVersion(tokenEncrypted);
  await internalQuery(
    `INSERT INTO sub_processor_subscriptions
       (id, url, token_encrypted, token_key_version, created_by_user_id, created_by_email)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.id,
      input.url,
      tokenEncrypted,
      keyVersion,
      input.createdByUserId ?? null,
      input.createdByEmail ?? null,
    ],
  );
  return { id: input.id };
}

function parseStoredKeyVersion(stored: string): number {
  const match = stored.match(/^enc:v(\d+):/);
  if (!match) return 1;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : 1;
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
  try {
    const res = await fetcher(url, { method: "GET" });
    if (!res.ok) {
      log.warn({ url, status: res.status }, "Sub-processor source returned non-OK");
      return null;
    }
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) {
      log.warn({ url }, "Sub-processor source returned non-array payload");
      return null;
    }
    return body as SubProcessor[];
  } catch (err) {
    log.warn(
      { url, err: errorMessage(err) },
      "Failed to fetch sub-processor source — will retry next tick",
    );
    return null;
  }
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
