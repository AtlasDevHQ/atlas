/**
 * `drift-recovery` — query-time recovery from upstream OpenAPI spec drift
 * (#3315). When the agent calls an `operationId` that is absent from the CACHED
 * operation graph, the spec may have legitimately changed upstream (an endpoint
 * added or renamed). Until now the only paths back to a fresh snapshot were the
 * manual admin "Refresh now" and the optional scheduled loop (default `off`) —
 * a valid call against a moved spec stayed hard-rejected with no self-healing.
 *
 * This module wires the EXISTING re-discovery machinery into the query path:
 *
 *   - {@link coerceSpecDriftMode} — the per-install `spec_drift_mode` knob
 *     (`strict` = today's hard reject, the DEFAULT | `auto-refresh` =
 *     re-probe-and-retry). PATCH-only config, same precedent as
 *     `spec_refresh_interval` (no install-form field, no migration — a plain
 *     non-secret JSONB key).
 *   - {@link attemptDriftRecovery} — one bounded, debounced re-probe of the
 *     install's spec via {@link performRediscovery} (the same egress-guarded
 *     SSRF-checked path manual + scheduled refreshes use), persisted through
 *     {@link persistRediscoverySnapshot} so the snapshot, diff record, and
 *     breaking-change alert lifecycle stay in lockstep with the other two
 *     triggers.
 *
 * Security/safety posture:
 *   - **Fail closed.** Any failure (cooldown, row gone, decrypt, probe, persist)
 *     leaves the old snapshot untouched and the original `unknown-operation`
 *     rejection stands. Recovery can only ever ADD a successfully re-probed
 *     graph; it never widens access on error.
 *   - **No probe storms.** A per-`(workspace, install)` cooldown gates attempts
 *     ({@link DRIFT_REPROBE_COOLDOWN_MS}); the attempt is stamped BEFORE the
 *     probe so a persistently-unknown operationId or an erroring upstream is
 *     re-probed at most once per window, not once per agent call. In-process,
 *     like the validator's token buckets — the goal is throttling a runaway
 *     loop, not distributed coordination.
 *   - **Breaking drift is never silently adopted.** The alert lifecycle runs
 *     with the unattended `drift-recovery` trigger ({@link resolveDriftAlertWrite}):
 *     no admin is looking at an inline diff, so breaking drift RAISES the
 *     persisted admin pill exactly like the Tier-2 scheduler's would — with the
 *     trigger recorded on the record so the two unattended paths stay
 *     distinguishable. The fresh snapshot still persists — the agent's valid
 *     call succeeds — but the operator is told the contract moved.
 *   - **The opt-in is enforced here, not only in the calling tool.** The
 *     attempt re-reads `spec_drift_mode` off the freshly-loaded config and
 *     refuses (`drift_mode_strict`) unless it is `auto-refresh` — so no future
 *     caller can re-probe a strict install, and an admin flipping the mode
 *     mid-conversation is honored.
 *
 * Scope: generic `openapi-generic` installs only. Built-in data candidates
 * (stripe-data, …) pin code-resident spec URLs refreshed via their own shared
 * cache — an unknown operation there is not recoverable by a per-install
 * re-probe, so {@link attemptDriftRecovery} refuses with the distinct
 * `unsupported_catalog` reason (logged for the operator; the caller falls back
 * to the plain rejection).
 */

import { createLogger } from "@atlas/api/lib/logger";
import { resolveDriftAlertWrite } from "./breaking-change";
import { OPENAPI_GENERIC_CATALOG_ID } from "./catalog";
import { resolveBaseUrl } from "./datasource";
import { assertBaseUrlAllowed, EgressBlockedError, hostForLog } from "./egress-guard";
import type { performRediscovery, persistRediscoverySnapshot } from "./rediscover";
import type { OperationGraph } from "./types";

const log = createLogger("openapi.drift-recovery");

// ─────────────────────────────────────────────────────────────────────
//  The `spec_drift_mode` knob
// ─────────────────────────────────────────────────────────────────────

/**
 * The two drift behaviours an install can opt into. `strict` preserves the
 * pre-#3315 contract exactly (unknown operation = hard reject until a manual /
 * scheduled rediscover); `auto-refresh` allows the query path one debounced
 * re-probe-and-retry. Keep in lockstep with the admin PATCH enum + the web UI.
 */
export const SPEC_DRIFT_MODES = ["strict", "auto-refresh"] as const;
export type SpecDriftMode = (typeof SPEC_DRIFT_MODES)[number];

/**
 * Default is `strict`: a re-probe is real upstream egress (and a snapshot
 * rewrite) triggered by agent input, so an install must opt in explicitly —
 * the safe-by-default posture, mirroring `spec_refresh_interval`'s `off`.
 */
export const DEFAULT_SPEC_DRIFT_MODE: SpecDriftMode = "strict";

/**
 * Fail-soft coercion of a `workspace_plugins.config.spec_drift_mode` JSONB
 * read-back. A drifted / hand-edited / absent value resolves to the `strict`
 * default — a malformed knob must never opt an install INTO agent-triggered
 * egress it didn't ask for.
 */
export function coerceSpecDriftMode(raw: unknown): SpecDriftMode {
  return typeof raw === "string" && (SPEC_DRIFT_MODES as readonly string[]).includes(raw)
    ? (raw as SpecDriftMode)
    : DEFAULT_SPEC_DRIFT_MODE;
}

// ─────────────────────────────────────────────────────────────────────
//  Re-probe cooldown (per workspace × install)
// ─────────────────────────────────────────────────────────────────────

/**
 * Minimum gap between drift-recovery re-probes for one install. One minute:
 * long enough that an agent loop hammering a genuinely-unknown operationId
 * costs the upstream at most one spec fetch per window, short enough that a
 * really-just-deployed endpoint is picked up on the next user question.
 */
export const DRIFT_REPROBE_COOLDOWN_MS = 60_000;

/**
 * Last re-probe stamp per `(workspaceId, installId)`. The stamp is written
 * when a RE-PROBE starts (immediately before the upstream call) — not on
 * success, so failed probes and still-unknown outcomes debounce too — and
 * NOT on a refusal (strict mode, wrong catalog, missing row, load failure):
 * those never touch the upstream, and burning the window on them would make
 * an admin's strict→auto-refresh flip wait out a cooldown it never spent.
 * `\x00` cannot appear in either id, so the joined key never collides across
 * the two dimensions (same convention as the validator's bucket keys).
 */
const lastAttemptMs = new Map<string, number>();

function cooldownKey(workspaceId: string, installId: string): string {
  return `${workspaceId}\x00${installId}`;
}

/**
 * Drop every stamp older than the cooldown window. Run on each attempt so the
 * map's size is bounded by the installs active within the LAST window, instead
 * of growing one entry per (workspace, install) for the process lifetime. The
 * sweep is O(map size), which the sweep itself keeps small.
 */
function sweepExpiredStamps(nowMs: number): void {
  for (const [key, stampedMs] of lastAttemptMs) {
    if (nowMs - stampedMs >= DRIFT_REPROBE_COOLDOWN_MS) lastAttemptMs.delete(key);
  }
}

/** Clear all cooldown stamps. For tests. */
export function _resetDriftRecoveryState(): void {
  lastAttemptMs.clear();
}

/** Current cooldown-stamp count. For tests (asserting the sweep evicts). */
export function _driftRecoveryCooldownSize(): number {
  return lastAttemptMs.size;
}

// ─────────────────────────────────────────────────────────────────────
//  Recovery attempt
// ─────────────────────────────────────────────────────────────────────

/** The discriminated outcome of one recovery attempt. */
export type DriftRecoveryOutcome =
  /**
   * The re-probe succeeded and the fresh snapshot + diff + alert write were
   * persisted. `operationFound` says whether the operation the agent asked for
   * exists in the FRESH graph (the caller retries only when it does).
   * `baseUrl` is the fresh spec's re-derived operations base URL, present ONLY
   * when it re-passed the egress guard — so a retry can follow a legitimately
   * moved `servers[0].url` without ever widening egress; omitted (keep the old
   * base) when derivation fails or the guard blocks it.
   */
  | {
      readonly kind: "refreshed";
      readonly graph: OperationGraph;
      readonly operationFound: boolean;
      readonly baseUrl?: string;
    }
  /** An attempt ran for this install within {@link DRIFT_REPROBE_COOLDOWN_MS} — skipped. */
  | { readonly kind: "cooldown" }
  /** No OpenAPI datasource install row for this (workspace, install) — nothing to re-probe. */
  | { readonly kind: "install_not_found" }
  /**
   * The re-probe was refused or could not produce a fresh snapshot: the
   * install isn't a re-probeable generic row (`unsupported_catalog` — built-in
   * data candidates pin code-resident specs), its CURRENT config doesn't opt
   * into auto-refresh (`drift_mode_strict` — enforced here, not just in the
   * tool, so no caller can re-probe a strict install), or the probe/persist
   * path failed (decrypt failure, missing URL, unsupported auth, probe
   * failure, persist failure, unexpected fault). The old snapshot is untouched
   * — fail closed. `reason` is a stable tag for logs/tests, never surfaced
   * verbatim to the user.
   */
  | { readonly kind: "not_refreshed"; readonly reason: string };

/** The tenant-scoped install row the loader returns. */
export interface RawInstallRow {
  /** Raw (encrypted) `workspace_plugins.config` JSONB; `{}` for a NULL column. */
  readonly config: Record<string, unknown>;
  /** The row's `catalog_id`, so the attempt can refuse non-generic installs. */
  readonly catalogId: string | null;
}

/** Raw-config loader seam. Production reads the tenant-scoped install row. */
export type LoadRawInstallConfig = (
  workspaceId: string,
  installId: string,
) => Promise<RawInstallRow | null>;

/** Test/override seams for {@link attemptDriftRecovery}. Production omits them. */
export interface AttemptDriftRecoveryDeps {
  /** Raw-config loader override (tests). Defaults to a tenant-scoped `workspace_plugins` read. */
  readonly loadRawConfig?: LoadRawInstallConfig;
  /** Re-discovery override (tests). Defaults to the real {@link performRediscovery}. */
  readonly rediscover?: typeof performRediscovery;
  /** Persistence override (tests). Defaults to the real {@link persistRediscoverySnapshot}. */
  readonly persist?: typeof persistRediscoverySnapshot;
  /** Injectable clock for the cooldown + alert timestamps. Default `Date.now`. */
  readonly now?: () => number;
}

/**
 * Tenant-scoped raw-config read for the default loader. Mirrors the admin
 * route's `loadInstall` WHERE clause (every conjunct is load-bearing tenant
 * isolation) but lives here because `lib/` may not import from `api/routes/`.
 * Deliberately NOT filtered by catalog — the row's `catalog_id` is returned so
 * {@link attemptDriftRecovery} can tell "no such install" (`install_not_found`)
 * apart from "a built-in data candidate that recovery can't re-probe"
 * (`unsupported_catalog`) instead of conflating both into a silent miss.
 * `db/internal` is imported lazily so this module's static graph stays free of
 * the DB module (the same posture as `workspace-datasource.ts::defaultQuery` —
 * tool tests partial-mock heavily and must not drag the pool in at import time).
 */
async function defaultLoadRawConfig(
  workspaceId: string,
  installId: string,
): Promise<RawInstallRow | null> {
  const { internalQuery } = await import("@atlas/api/lib/db/internal");
  const rows = await internalQuery<{ config: Record<string, unknown> | null; catalog_id: string | null }>(
    `SELECT config, catalog_id
       FROM workspace_plugins
      WHERE workspace_id = $1 AND install_id = $2
        AND pillar = 'datasource'
        AND status != 'archived'
      LIMIT 1`,
    [workspaceId, installId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return { config: row.config ?? {}, catalogId: row.catalog_id ?? null };
}

/**
 * Attempt ONE bounded, debounced spec re-probe for an install whose cached
 * graph lacks an operation the agent asked for. See the module header for the
 * full posture. Never throws — every failure maps to a fail-closed
 * {@link DriftRecoveryOutcome} so the calling tool's original rejection stands.
 */
export async function attemptDriftRecovery(
  workspaceId: string,
  installId: string,
  operationId: string,
  deps: AttemptDriftRecoveryDeps = {},
): Promise<DriftRecoveryOutcome> {
  const now = deps.now ?? Date.now;
  const nowMs = now();

  // ── Storm-guard pre-check (the stamp itself is written further down, only
  // on the path that actually re-probes). The sweep first: expired stamps are
  // dropped so the map's size tracks the installs active within the last
  // window, not the process lifetime.
  sweepExpiredStamps(nowMs);
  const key = cooldownKey(workspaceId, installId);
  const last = lastAttemptMs.get(key);
  if (last !== undefined && nowMs - last < DRIFT_REPROBE_COOLDOWN_MS) {
    return { kind: "cooldown" };
  }

  // ── Fresh raw config (the prior snapshot the diff compares against).
  let row: RawInstallRow | null;
  try {
    row = await (deps.loadRawConfig ?? defaultLoadRawConfig)(workspaceId, installId);
  } catch (err) {
    log.warn(
      { workspaceId, installId, err: err instanceof Error ? err.message : String(err) },
      "Drift recovery could not load the install row — keeping the old snapshot",
    );
    return { kind: "not_refreshed", reason: "config_load_failed" };
  }
  if (row === null) return { kind: "install_not_found" };

  // ── Catalog gate: only generic installs are re-probeable (performRediscovery
  // decrypts with the generic schema; data candidates pin code-resident specs).
  // Named distinctly from install_not_found so operators can see "auto-refresh
  // can't help this datasource type" rather than a silent miss.
  if (row.catalogId !== OPENAPI_GENERIC_CATALOG_ID) {
    log.info(
      { workspaceId, installId, operationId, catalogId: row.catalogId },
      "Drift recovery skipped: install is not a generic OpenAPI datasource (built-in specs are not re-probeable per install)",
    );
    return { kind: "not_refreshed", reason: "unsupported_catalog" };
  }

  // ── Mode gate, enforced HERE on the freshly-loaded config — not only in the
  // calling tool. This makes the opt-in un-bypassable by future direct callers
  // AND honors an admin flipping the install back to strict between the tool's
  // resolve and this attempt (the tool's own check is just the fast path).
  const rawConfig = row.config;
  if (coerceSpecDriftMode(rawConfig.spec_drift_mode) !== "auto-refresh") {
    log.info(
      { workspaceId, installId, operationId },
      "Drift recovery skipped: install's current spec_drift_mode is strict",
    );
    return { kind: "not_refreshed", reason: "drift_mode_strict" };
  }

  // ── Stamp the cooldown NOW — before the upstream probe, so a failed or
  // still-unknown probe debounces too, but after every refusal gate, so a
  // strict-mode / wrong-catalog / missing-row refusal never burns the window
  // (an admin's strict→auto-refresh flip takes effect immediately). The
  // config load above awaited, so a concurrent attempt may have stamped in
  // the meantime — re-check before claiming the window.
  const stampedMeanwhile = lastAttemptMs.get(key);
  if (stampedMeanwhile !== undefined && nowMs - stampedMeanwhile < DRIFT_REPROBE_COOLDOWN_MS) {
    return { kind: "cooldown" };
  }
  lastAttemptMs.set(key, nowMs);

  // ── Re-probe via the shared core: the SAME egress-guarded, SSRF-checked,
  // credential-gated path the manual route and the scheduler use.
  let result: Awaited<ReturnType<typeof performRediscovery>>;
  try {
    const rediscover =
      deps.rediscover ?? (await import("./rediscover")).performRediscovery;
    result = await rediscover(rawConfig, installId);
  } catch (err) {
    // performRediscovery only throws on an UNEXPECTED fault (its tagged probe
    // failures are returned, not thrown). The tool path must not crash a chat
    // turn over it — log + fail closed.
    log.warn(
      { workspaceId, installId, err: err instanceof Error ? err.message : String(err) },
      "Drift recovery re-probe failed unexpectedly — keeping the old snapshot",
    );
    return { kind: "not_refreshed", reason: "unexpected" };
  }
  if (result.kind !== "ok") {
    log.info(
      { workspaceId, installId, operationId, reason: result.kind },
      "Drift recovery re-probe did not produce a fresh snapshot — keeping the old one",
    );
    return { kind: "not_refreshed", reason: result.kind };
  }

  // ── Alert lifecycle: drift-recovery is an UNATTENDED trigger (no admin is
  // looking at an inline diff), so breaking drift RAISES the persisted pill —
  // the "never silently adopt a breaking change" contract — with the trigger
  // recorded on the raised record so audit/UI can tell it apart from the
  // Tier-2 scheduler's refreshes. A clean refresh clears a standing alert; a
  // baseline leaves it.
  const { write, assessment } = resolveDriftAlertWrite(
    result.diffRecord,
    "drift-recovery",
    new Date(nowMs).toISOString(),
  );

  // ── Persist snapshot + diff + alert in one merge (also evicts the in-process
  // graph cache). No watermark: the snapshot's bumped `probedAt` already resets
  // the Tier-2 scheduler's due-clock (`evaluateSpecRefreshDue` takes the max).
  try {
    const persist =
      deps.persist ?? (await import("./rediscover")).persistRediscoverySnapshot;
    await persist(workspaceId, installId, result.snapshot, result.diffRecord, undefined, write);
  } catch (err) {
    log.warn(
      { workspaceId, installId, err: err instanceof Error ? err.message : String(err) },
      "Drift recovery could not persist the fresh snapshot — keeping the old one",
    );
    return { kind: "not_refreshed", reason: "persist_failed" };
  }

  // ── Re-derive the operations base URL from the FRESH spec, exactly as the
  // resolver does, and re-run the egress guard on it. Surfaced only when it
  // passes, so a retry can follow a legitimately moved `servers[0].url` while
  // a hostile fresh spec (private/internal target) is dropped — the caller
  // then keeps its already-validated old base. `openapi_url` and
  // `base_url_override` are plain (non-secret) JSONB fields.
  let freshBaseUrl: string | undefined;
  const openapiUrl = typeof rawConfig.openapi_url === "string" ? rawConfig.openapi_url : "";
  if (openapiUrl.length > 0) {
    const candidate = resolveBaseUrl(
      openapiUrl,
      result.graph,
      typeof rawConfig.base_url_override === "string" ? rawConfig.base_url_override : undefined,
    );
    try {
      assertBaseUrlAllowed(candidate);
      freshBaseUrl = candidate;
    } catch (err) {
      if (err instanceof EgressBlockedError) {
        log.warn(
          { workspaceId, installId, host: hostForLog(candidate) },
          "Drift recovery: fresh spec's base URL is blocked (private/internal) — retry keeps the old base",
        );
      } else {
        // Never-throws contract: an unexpected guard fault degrades to
        // keep-old-base rather than crashing the chat turn.
        log.warn(
          { workspaceId, installId, err: err instanceof Error ? err.message : String(err) },
          "Drift recovery: base-URL guard failed unexpectedly — retry keeps the old base",
        );
      }
    }
  }

  const operationFound = result.graph.operations.has(operationId);
  log.info(
    {
      workspaceId,
      installId,
      operationId,
      operationFound,
      breaking: assessment.breaking,
      operationCount: result.snapshot.operationCount,
    },
    "Drift recovery refreshed the spec snapshot from the query path",
  );
  return {
    kind: "refreshed",
    graph: result.graph,
    operationFound,
    ...(freshBaseUrl !== undefined ? { baseUrl: freshBaseUrl } : {}),
  };
}
