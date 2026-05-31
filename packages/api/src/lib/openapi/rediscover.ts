/**
 * `rediscover` — the shared per-install OpenAPI re-discovery core (PRD #2868).
 *
 * Re-discovery is "re-probe the spec endpoint → re-normalize to an
 * {@link OperationGraph} → rebuild the persisted snapshot → diff it against the
 * prior snapshot". Slice #3002 shipped it inline in the admin "Refresh now" route
 * (`api/routes/admin-openapi-datasources.ts`); #2978 adds an AUTOMATED sibling — the
 * Tier-2 periodic scheduler (`scheduler/openapi-install-rediscover.ts`). Both must
 * do the same thing, but `lib/` may not import from `api/routes/` (CLAUDE.md), so
 * the logic lives here and both call it. The route maps the result to HTTP; the
 * scheduler maps it to an audit row + a watermark bump.
 *
 * Why this is the RIGHT seam for honoring the egress controls: the spec fetch goes
 * through {@link probeSpec}, which runs the same fail-closed SSRF guard
 * (`assertSpecUrlAllowed` → `isSafeExternalUrl` — private/loopback/link-local/CGNAT
 * IPs + internal hostnames blocked unless `ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS` opts
 * out) + redirect-revalidating `guardedFetch` + #3034 host-match credential gate as a
 * resolve-time probe. Scheduled probing is therefore the SAME server-side egress as
 * resolve-time, just on a timer — sharing this function is what guarantees that,
 * rather than re-deriving (and risking divergence in) the egress posture in the
 * scheduler.
 *
 * {@link performRediscovery} is pure of side effects (no DB write, no audit) and
 * returns a discriminated {@link RediscoveryResult}. Persistence is split out into
 * {@link persistRediscoverySnapshot} (success: snapshot + diff + optional watermark,
 * then evict the in-process graph cache) and {@link stampSpecLastChecked}
 * (watermark-only: the scheduler's fail-soft / config-skip negative-cache write,
 * which deliberately leaves the live snapshot untouched).
 */

import { createLogger } from "@atlas/api/lib/logger";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { decryptSecretFields, parseConfigSchema } from "@atlas/api/lib/plugins/secrets";
import { internalQuery } from "@atlas/api/lib/db/internal";
import {
  OPENAPI_GENERIC_CATALOG_ID,
  OPENAPI_GENERIC_CONFIG_SCHEMA,
  isValidSnapshot,
  type OpenApiSnapshot,
} from "./catalog";
import {
  resolveAuthFromDecryptedConfig,
  probeSpec,
  buildSnapshot,
  invalidateInstallGraphCache,
  OpenApiProbeError,
  type OpenApiProbeErrorReason,
} from "./probe";
import { buildOperationGraph } from "./spec";
import {
  diffOperationGraphs,
  summarizeSpecDiffRecord,
  baselineSpecDiffRecord,
  unparseablePriorDiffRecord,
  type SpecDiffRecord,
  type SpecDiffSummary,
} from "./diff";
import { SPEC_LAST_CHECKED_AT_FIELD } from "./spec-refresh";
import type { OperationGraph } from "./types";

const log = createLogger("openapi.rediscover");

/**
 * Selective-encryption schema for a generic OpenAPI install's config — the same
 * one the admin route used inline. Built once at module load. Only `auth_value` is
 * marked `secret: true`, so a decrypt round-trips just the credential; the snapshot
 * / diff / interval / watermark fields stay plaintext JSONB.
 */
const SECRET_SCHEMA = parseConfigSchema(OPENAPI_GENERIC_CONFIG_SCHEMA);

/**
 * Compute the spec-diff record (#2976) for a re-discovery: rebuild the PRIOR
 * snapshot's graph and diff it against the freshly re-probed `nextGraph`. Returns a
 * BASELINE (`diff: null`) when there's no valid prior snapshot to compare against,
 * or when the prior snapshot's cached doc no longer parses — in either case the
 * fresh snapshot still persists; we just can't show what moved. Pure apart from the
 * warn log; the caller stamps `currentProbedAt` and persists. (Moved out of the
 * admin route in #2978 so the scheduler computes an identical record.)
 */
export function buildSpecDiffRecord(
  priorConfig: Record<string, unknown>,
  nextGraph: OperationGraph,
  currentProbedAt: string,
  installId: string,
): SpecDiffRecord {
  const rawPrior = priorConfig.openapi_snapshot;
  if (!isValidSnapshot(rawPrior)) {
    return baselineSpecDiffRecord(currentProbedAt);
  }
  let priorGraph: OperationGraph;
  try {
    priorGraph = buildOperationGraph(rawPrior.doc);
  } catch (err) {
    // Older builder / corrupt cached doc — record a baseline rather than failing
    // the rediscover. The fresh snapshot is still written by the caller. Flag it
    // `priorParseFailed` so the UI/audit show "comparison unavailable" instead of
    // mistaking a dropped compare for a clean first-ever baseline (drift may have
    // gone unseen).
    log.warn(
      { installId, err: errorMessage(err) },
      "Prior OpenAPI snapshot no longer parses — recording an unparseable-prior baseline diff",
    );
    return unparseablePriorDiffRecord(rawPrior.probedAt, currentProbedAt);
  }
  return {
    previousProbedAt: rawPrior.probedAt,
    currentProbedAt,
    diff: diffOperationGraphs(priorGraph, nextGraph),
  };
}

/**
 * The outcome of re-discovering one install. Discriminated so callers branch on a
 * stable tag rather than message-matching:
 *   - `ok` — re-probe succeeded; carries the fresh snapshot, the computed diff
 *     record, and its projected summary (or `null` if projection somehow fails).
 *   - `decrypt_failed` — the stored credential couldn't be decrypted (a rotated-away
 *     key). Route → 400; scheduler → fail-soft skip (admin must reconnect).
 *   - `no_url` — no spec URL to probe (a drifted row).
 *   - `unsupported_auth` — a deferred (`oauth2`) or drifted auth kind; carries the
 *     raw kind so the route can tailor its 400 message.
 *   - `probe_failed` — the upstream spec fetch / parse failed; carries the
 *     {@link OpenApiProbeErrorReason} + message. Route → 400; scheduler → fail-soft.
 *
 * An UNEXPECTED fault (a non-{@link OpenApiProbeError} thrown by the probe/build
 * path) is deliberately NOT a variant — it propagates so the route maps it to a 500
 * and the scheduler's per-install catch records it as a failure. We never invent a
 * "success" out of an unexpected crash.
 */
export type RediscoveryResult =
  | {
      readonly kind: "ok";
      readonly snapshot: OpenApiSnapshot;
      readonly diffRecord: SpecDiffRecord;
      // The projected summary of `diffRecord`, carried so both consumers (route
      // response + scheduler audit) avoid re-projecting. `null` is defensive only:
      // a record just built by `buildSpecDiffRecord` always has a `currentProbedAt`,
      // so `summarizeSpecDiffRecord` can't actually return null on this path.
      readonly drift: SpecDiffSummary | null;
    }
  | { readonly kind: "decrypt_failed" }
  | { readonly kind: "no_url" }
  | { readonly kind: "unsupported_auth"; readonly rawAuthKind: string }
  | { readonly kind: "probe_failed"; readonly reason: OpenApiProbeErrorReason; readonly message: string };

/** Test/override seams for {@link performRediscovery}. Production omits them. */
export interface PerformRediscoveryDeps {
  /** Probe override (tests). Defaults to the real {@link probeSpec} (real egress guards). */
  readonly probe?: typeof probeSpec;
  /** ISO-timestamp source for the fresh snapshot's `probedAt`. Defaults to wall clock. */
  readonly now?: () => string;
}

/**
 * Re-discover one install from its RAW (encrypted) `workspace_plugins.config`:
 * decrypt the credential → resolve auth → re-probe the spec (egress-guarded) →
 * build the fresh snapshot → diff it against the prior snapshot. Side-effect-free
 * (no DB write, no cache eviction, no audit) — the caller persists.
 *
 * The prior snapshot for the diff is read from the RAW config (`openapi_snapshot`
 * is a non-secret field, so no decrypt is needed to compare against it) — matching
 * the admin route's behavior exactly.
 */
export async function performRediscovery(
  rawConfig: Record<string, unknown> | null,
  installId: string,
  deps: PerformRediscoveryDeps = {},
): Promise<RediscoveryResult> {
  const config = rawConfig ?? {};

  // Decrypt ONLY to read the credential + URL for the upstream probe; the snapshot
  // written back is non-secret. A decrypt failure (rotated-away key version) is a
  // recoverable, actionable state — surface it as a tag, never a thrown 500.
  let decrypted: Record<string, unknown>;
  try {
    decrypted = decryptSecretFields(config, SECRET_SCHEMA);
  } catch (err) {
    log.warn({ installId, err: errorMessage(err) }, "OpenAPI rediscover credential decrypt failed");
    return { kind: "decrypt_failed" };
  }

  const openapiUrl = typeof decrypted.openapi_url === "string" ? decrypted.openapi_url : "";
  if (!openapiUrl) return { kind: "no_url" };

  // Narrow + build the credential via the glue shared with the workspace resolver.
  // A drifted row could carry the deferred `oauth2` kind (or garbage) — surfaced as
  // `unsupported_auth` (with the raw kind) rather than letting buildResolvedAuth's
  // exhaustiveness guard throw.
  const authResult = resolveAuthFromDecryptedConfig(decrypted);
  if (!authResult.ok) {
    return { kind: "unsupported_auth", rawAuthKind: authResult.rawAuthKind };
  }

  // Host-match credential gate (#3034): the re-probe attaches the stored credential
  // ONLY when the spec host matches the datasource's API host. For a generic install
  // the API host is the admin-supplied `base_url_override` (absent ⇒ withheld) — the
  // same fail-safe the install path applies, so install / manual / scheduled probes
  // stay symmetric.
  const baseUrlOverride =
    typeof decrypted.base_url_override === "string" ? decrypted.base_url_override : undefined;

  const probe = deps.probe ?? probeSpec;
  const now = deps.now ?? (() => new Date().toISOString());

  let doc: unknown;
  let graph: OperationGraph;
  try {
    ({ doc, graph } = await probe(openapiUrl, authResult.auth, {
      ...(baseUrlOverride ? { apiBaseUrl: baseUrlOverride } : {}),
    }));
  } catch (err) {
    if (err instanceof OpenApiProbeError) {
      return { kind: "probe_failed", reason: err.reason, message: err.message };
    }
    // Unexpected fault — let it propagate (route → 500, scheduler → per-install
    // failure). Never fabricate a successful snapshot out of a crash.
    throw err;
  }

  const snapshot = buildSnapshot(doc, graph, now());
  // Diff against the PRIOR snapshot still in `config` (pre-update). A first-ever
  // discovery / unparseable prior records a baseline (`diff: null`).
  const diffRecord = buildSpecDiffRecord(config, graph, snapshot.probedAt, installId);
  return { kind: "ok", snapshot, diffRecord, drift: summarizeSpecDiffRecord(diffRecord) };
}

/**
 * Persist a successful re-discovery against an install in one JSONB merge: the fresh
 * `openapi_snapshot`, the computed `openapi_last_diff`, and — when `lastCheckedAtIso`
 * is supplied (the scheduler) — the {@link SPEC_LAST_CHECKED_AT_FIELD} watermark.
 * The manual route omits the watermark, so its merge is byte-for-byte the pre-#2978
 * statement. All written fields are non-secret, so the encrypted `auth_value` is
 * never round-tripped through this write.
 *
 * Then evicts the install's in-process graph cache: the re-probe bumped `probedAt`,
 * so the next resolve rebuilds under the fresh key and the now-orphaned prior-
 * `probedAt` entry is reclaimed instead of leaking (#3009). Scoped to
 * `(workspaceId, installId)` — the same tenant isolation the load/delete paths use.
 *
 * The interpolated field names are code-resident constants (never user input), so
 * splicing them into `jsonb_build_object` is safe; every value is bound.
 */
export async function persistRediscoverySnapshot(
  workspaceId: string,
  installId: string,
  snapshot: OpenApiSnapshot,
  diffRecord: SpecDiffRecord,
  lastCheckedAtIso?: string,
): Promise<void> {
  const params: unknown[] = [
    workspaceId,
    installId,
    OPENAPI_GENERIC_CATALOG_ID,
    JSON.stringify(snapshot),
    JSON.stringify(diffRecord),
  ];
  let pairs = `'openapi_snapshot', $4::jsonb, 'openapi_last_diff', $5::jsonb`;
  if (lastCheckedAtIso !== undefined) {
    pairs += `, '${SPEC_LAST_CHECKED_AT_FIELD}', $6::text`;
    params.push(lastCheckedAtIso);
  }
  await internalQuery(
    `UPDATE workspace_plugins
        SET config = config || jsonb_build_object(${pairs}),
            updated_at = NOW()
      WHERE workspace_id = $1 AND install_id = $2 AND catalog_id = $3 AND pillar = 'datasource'`,
    params,
  );

  invalidateInstallGraphCache(workspaceId, installId);
}

/**
 * Watermark-only write: stamp {@link SPEC_LAST_CHECKED_AT_FIELD} = `lastCheckedAtIso`
 * WITHOUT touching the snapshot. This is the scheduler's fail-soft / config-skip
 * path — a failed scheduled probe must "never overwrite/degrade the live snapshot"
 * (AC), and bumping the watermark is the persisted negative-cache that keeps a down
 * upstream from being re-probed until its interval elapses again. No graph-cache
 * eviction: the snapshot (and its `probedAt`) is unchanged, so the cached graph is
 * still valid.
 */
export async function stampSpecLastChecked(
  workspaceId: string,
  installId: string,
  lastCheckedAtIso: string,
): Promise<void> {
  await internalQuery(
    `UPDATE workspace_plugins
        SET config = config || jsonb_build_object('${SPEC_LAST_CHECKED_AT_FIELD}', $4::text),
            updated_at = NOW()
      WHERE workspace_id = $1 AND install_id = $2 AND catalog_id = $3 AND pillar = 'datasource'`,
    [workspaceId, installId, OPENAPI_GENERIC_CATALOG_ID, lastCheckedAtIso],
  );
}
