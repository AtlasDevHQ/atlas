/**
 * Bedrock BYOT discovery + per-workspace cache.
 *
 * Discovery hits `ListFoundationModels` via the AWS SDK (`@aws-sdk/client-bedrock`).
 * The cache key is `${orgId}:${region}` because Bedrock surfaces a
 * different model set per region — `ap-northeast-1` is not the same
 * catalog as `us-east-1`. The TTL knob is shared with anthropic / openai
 * (`ATLAS_BYOT_CATALOG_TTL_MS`).
 *
 * Failure shape mirrors the other direct-provider modules:
 *   - `BedrockCatalogUnauthorized` — IAM creds are bad or missing the
 *     `bedrock:ListFoundationModels` action.
 *   - `BedrockCatalogRateLimited` — AWS throttling.
 *   - `BedrockCatalogUnavailable` — region unreachable, malformed
 *     response, network failure.
 *
 * The `BedrockClient` import is a server-side dep
 * (`@aws-sdk/client-bedrock`); the package is listed in
 * `serverExternalPackages` so the Next.js bundler doesn't try to thread
 * it into the browser.
 */

import {
  BedrockClient,
  ListFoundationModelsCommand,
} from "@aws-sdk/client-bedrock";
import type {
  BedrockCredentialBundle,
  BedrockRegion,
  GatewayCatalogModel,
} from "@useatlas/types";
import {
  deleteFromDB,
  isFresh,
  loadFromDB,
  storeToDB,
} from "./byot-catalog-store";
import { createLogger } from "./logger";
import { getSettingAuto } from "@atlas/api/lib/settings";

const log = createLogger("bedrock-catalog");

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1_000; // 6 hours
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Recommended subset surfaced in the picker. Anchored on Anthropic's
 * flagship-on-Bedrock variants — Bedrock model IDs are versioned with
 * region prefixes (e.g. `us.anthropic.claude-sonnet-4-5-20250929-v1:0`).
 * The set is intentionally narrow; the picker still shows everything.
 */
// Bedrock model IDs for Claude 4.x drop the `-v1:0` suffix that earlier
// Claude families carried. Source: AWS Bedrock model cards index
// (https://docs.aws.amazon.com/bedrock/latest/userguide/model-cards.md).
const RECOMMENDED_MODEL_IDS: ReadonlySet<string> = new Set([
  "anthropic.claude-opus-4-8",
  "anthropic.claude-sonnet-4-6",
  "anthropic.claude-haiku-4-5",
]);

/**
 * @deprecated Use `BedrockCredentialBundle` from `@useatlas/types`. Alias
 * kept to avoid touching every internal cred-typed signature in one PR.
 */
export type BedrockDiscoveryCredentials = BedrockCredentialBundle;

export class BedrockCatalogUnauthorized extends Error {
  readonly _tag = "BedrockCatalogUnauthorized";
  constructor(message: string) {
    super(message);
    this.name = "BedrockCatalogUnauthorized";
  }
}

export class BedrockCatalogRateLimited extends Error {
  readonly _tag = "BedrockCatalogRateLimited";
  readonly retryAfterSeconds: number | null;
  constructor(message: string, retryAfterSeconds: number | null) {
    super(message);
    this.name = "BedrockCatalogRateLimited";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class BedrockCatalogUnavailable extends Error {
  readonly _tag = "BedrockCatalogUnavailable";
  constructor(message: string) {
    super(message);
    this.name = "BedrockCatalogUnavailable";
  }
}

export interface BedrockCatalogResponse {
  models: GatewayCatalogModel[];
  fetchedAt: string;
  source: "cache" | "fresh";
  /** AWS region the catalog was fetched against. */
  region: BedrockRegion;
}

interface CacheEntry {
  models: GatewayCatalogModel[];
  fetchedAt: string;
  expiresAt: number;
  region: BedrockRegion;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<CacheEntry>>();

function ttlMs(): number {
  // Platform-scoped settings registry (#3705): DB override > env > default.
  const raw = getSettingAuto("ATLAS_BYOT_CATALOG_TTL_MS");
  if (!raw) return DEFAULT_TTL_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_MS;
}

function cacheKey(orgId: string, region: BedrockRegion): string {
  return `${orgId}:${region}`;
}

/**
 * Build a fresh `BedrockClient`. We never reuse a client across requests
 * because the credentials are per-workspace and cycling on
 * setWorkspaceModelConfig — the lifetime is request-scoped at most.
 */
function buildClient(
  region: BedrockRegion,
  creds: BedrockDiscoveryCredentials,
): BedrockClient {
  return new BedrockClient({
    region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
    },
  });
}

function isTextGenModel(model: {
  outputModalities?: string[];
  inferenceTypesSupported?: string[];
  modelLifecycle?: { status?: string };
}): boolean {
  // Only surface text-out models — image / video generation in Bedrock
  // returns a different invocation shape and wouldn't drive the agent
  // loop. Skip LEGACY (deprecated) lifecycle entries — they'll fail when
  // the user actually tries to call them.
  if (model.modelLifecycle?.status === "LEGACY") return false;
  const out = model.outputModalities ?? [];
  return out.includes("TEXT");
}

function normalizeModel(model: {
  modelId?: string;
  modelName?: string;
  providerName?: string;
  outputModalities?: string[];
  inferenceTypesSupported?: string[];
  modelLifecycle?: { status?: string };
}): GatewayCatalogModel | null {
  if (!model.modelId) return null;
  if (!isTextGenModel(model)) return null;
  return {
    id: model.modelId,
    name: model.modelName ?? model.modelId,
    provider: (model.providerName ?? "bedrock").toLowerCase(),
    type: "language",
    contextWindow: null,
    maxOutputTokens: null,
    inputPrice: null,
    outputPrice: null,
    recommended: RECOMMENDED_MODEL_IDS.has(model.modelId),
  };
}

async function fetchBedrockModels(
  region: BedrockRegion,
  creds: BedrockDiscoveryCredentials,
): Promise<GatewayCatalogModel[]> {
  const client = buildClient(region, creds);
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await client.send(new ListFoundationModelsCommand({}), {
      abortSignal: abort.signal,
    });
    const summaries = res.modelSummaries ?? [];
    const normalized: GatewayCatalogModel[] = [];
    let filtered = 0;
    for (const summary of summaries) {
      const model = normalizeModel(summary);
      if (model) normalized.push(model);
      else filtered += 1;
    }
    if (filtered > 0) {
      log.debug(
        { filtered, kept: normalized.length, region },
        "bedrock-catalog: filtered non-text-gen / legacy entries",
      );
    }
    return normalized;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const name = err instanceof Error ? err.name : "";
    // AWS SDK v3 puts the HTTP status on `$metadata.httpStatusCode` and the
    // failure name in `err.name`. We classify on either signal so a future
    // upstream rename of `AccessDeniedException` → `AccessDeniedFault`
    // doesn't silently drop into the "unavailable" bucket.
    const statusCode = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
      ?.httpStatusCode;
    if (
      statusCode === 401 ||
      statusCode === 403 ||
      name === "UnrecognizedClientException" ||
      name === "AccessDeniedException" ||
      name === "InvalidSignatureException"
    ) {
      throw new BedrockCatalogUnauthorized(
        `AWS rejected the workspace IAM creds (${name || statusCode || "auth"}). ` +
          "Verify the access key + secret on the AI Provider page and that the IAM principal has bedrock:ListFoundationModels.",
      );
    }
    if (statusCode === 429 || name === "ThrottlingException") {
      throw new BedrockCatalogRateLimited(
        "AWS throttled the catalog refresh. Try again shortly.",
        null,
      );
    }
    throw new BedrockCatalogUnavailable(
      `AWS Bedrock ListFoundationModels failed in ${region}: ${message}`,
    );
  } finally {
    clearTimeout(timeout);
    client.destroy();
  }
}

export async function getBedrockCatalog(
  orgId: string,
  region: BedrockRegion,
  creds: BedrockDiscoveryCredentials,
  opts: { refresh?: boolean; persist?: boolean } = {},
): Promise<BedrockCatalogResponse> {
  // `persist: false` is used by `testModelConfig` so cred-validation
  // probes don't seed `workspace_model_catalog` with rows keyed under
  // synthetic `__test:<accessKeyId>` orgIds — those rows would leak the
  // public half of an AWS cred into the table and never be GC'd.
  const persist = opts.persist !== false;
  const key = cacheKey(orgId, region);
  if (!opts.refresh) {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > Date.now()) {
      return {
        models: hit.models,
        fetchedAt: hit.fetchedAt,
        source: "cache",
        region: hit.region,
      };
    }
    if (persist) {
      const fromDb = await loadFromDB(orgId, "bedrock", region);
      if (fromDb && isFresh(fromDb, ttlMs())) {
        const expiresAt = Date.parse(fromDb.fetchedAt) + ttlMs();
        cache.set(key, {
          models: fromDb.models,
          fetchedAt: fromDb.fetchedAt,
          expiresAt,
          region,
        });
        return {
          models: fromDb.models,
          fetchedAt: fromDb.fetchedAt,
          source: "cache",
          region,
        };
      }
    }
  }

  let pending = inflight.get(key);
  if (!pending) {
    pending = (async (): Promise<CacheEntry> => {
      const models = await fetchBedrockModels(region, creds);
      const now = Date.now();
      const entry: CacheEntry = {
        models,
        fetchedAt: new Date(now).toISOString(),
        expiresAt: now + ttlMs(),
        region,
      };
      cache.set(key, entry);
      if (persist) {
        await storeToDB(orgId, "bedrock", region, {
          models: entry.models,
          fetchedAt: entry.fetchedAt,
        });
      }
      return entry;
    })().finally(() => {
      inflight.delete(key);
    });
    inflight.set(key, pending);
  }
  const entry = await pending;
  return {
    models: entry.models,
    fetchedAt: entry.fetchedAt,
    source: "fresh",
    region: entry.region,
  };
}

/**
 * Drop every cached bedrock catalog entry for an org (across regions). A
 * region change rotates the cache key entirely, but a key rotation that
 * keeps the region the same still needs the cache wiped — invalidate by
 * orgId prefix.
 */
export function invalidateBedrockCatalog(orgId: string): void {
  // L1 + inflight are both keyed `${orgId}:${region}`; sweep by prefix
  // so a multi-region workspace clears every region in one shot.
  // Dropping inflight is what prevents a post-rotation cache restore —
  // see anthropic-catalog for the race scenario.
  for (const key of cache.keys()) {
    if (key.startsWith(`${orgId}:`)) cache.delete(key);
  }
  for (const key of inflight.keys()) {
    if (key.startsWith(`${orgId}:`)) inflight.delete(key);
  }
  // L2: deleting by (orgId, provider) flushes every region in one shot.
  void deleteFromDB(orgId, "bedrock");
}

/** Test-only: clear the entire cache. */
export function __resetBedrockCatalogCacheForTests(): void {
  cache.clear();
  inflight.clear();
}

/** Test-only: inspect the curated recommended list. */
export function __getRecommendedBedrockIdsForTests(): ReadonlySet<string> {
  return RECOMMENDED_MODEL_IDS;
}
