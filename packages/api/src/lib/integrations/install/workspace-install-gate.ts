/**
 * `WorkspaceInstallGate` — Atlas issue #2655 (1.5.2 slice 7).
 *
 * Per-event "is this workspace's install of <catalog entry> active?"
 * predicate. Wired into the proactive listener as the outermost check
 * for every channel-message event so absent-or-disabled installs
 * silent-skip BEFORE classify (no LLM call, no meter row, no
 * rate-limit hit, no DB write further down the pipeline).
 *
 * Returns `true` ONLY when all four facts hold:
 *
 *   1. A `workspace_plugins` row exists for `(workspaceId, catalogId)`,
 *   2. that row's `enabled = true`,
 *   3. the joined `plugin_catalog` row's `enabled = true`,
 *   4. EITHER the workspace's `organization.is_operator_workspace`
 *      flag is true (operator bypass — Atlas's own dogfood / per-region
 *      operator orgs that never hold a paid plan), OR the workspace's
 *      `organization.plan_tier` ranks ≥ the catalog row's `min_plan`.
 *
 * Any other state (missing install row, install disabled, catalog
 * disabled, plan mismatch, DB hiccup) returns `false`. Fails closed so
 * a registry outage silences the proactive flow rather than letting
 * an unverified workspace continue.
 *
 * ## Plan-tier ranking
 *
 * Both vocabularies share one ranking table — see {@link planRank}
 * in `./plan-rank.ts`. Catalog `min_plan` and workspace `plan_tier`
 * use the same `PLAN_TIERS` union from `@useatlas/types`
 * (`free | trial | starter | pro | business`). Unknown `plan_tier`
 * values rank 0 (most restrictive — when we can't classify the
 * workspace, default to "below all gates"). Unknown `min_plan`
 * values fail closed by *not* admitting the row — a typo in a
 * catalog seed shouldn't accidentally widen access.
 *
 * ## Per-event caching
 *
 * `createInstallGateCache()` returns a wrapper that memoises results
 * by `(workspaceId, catalogId)` for the lifetime of one event handler
 * invocation. Mirrors the per-event-fetch pattern in
 * `plugins/chat/src/proactive/listener.ts`; the listener constructs a
 * fresh cache at the top of each event so a 'gate said no' result
 * doesn't leak across events (the install could be re-enabled between
 * one Slack event and the next).
 *
 * The cache is intentionally NOT shared across events: a per-process
 * cache with a TTL would mean an admin's "uninstall" UI click took
 * up-to-TTL seconds to take effect, which loses the contract the gate
 * was meant to provide.
 *
 * ## Deep-module note
 *
 * This module is the deep module (architecture-tagged). The interface
 * — `isWorkspaceInstallActive(workspaceId, catalogId): Promise<boolean>`
 * — is one boolean; the implementation absorbs JOIN, encryption-free
 * read of plan tier, enum ranking, and fail-closed error handling.
 * Banked in `.claude/research/architecture-wins.md`.
 *
 * @module
 */

import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import { planRank } from "./plan-rank";

const log = createLogger("integrations:workspace-install-gate");

/**
 * Raw shape returned by the gate's JOIN query. The index signature
 * satisfies `internalQuery`'s `T extends Record<string, unknown>`
 * constraint without widening the declared columns.
 */
interface GateRow {
  install_enabled: boolean;
  catalog_enabled: boolean;
  min_plan: string;
  plan_tier: string | null;
  is_operator_workspace: boolean | null;
  [key: string]: unknown;
}

/**
 * Read `workspace_plugins ⋈ plugin_catalog ⋈ organization` and return
 * a structured verdict for the four-fact gate.
 *
 * The query left-joins `organization` so the gate is well-defined even
 * when the workspace pre-dates the `plan_tier` column or sits in a
 * shape where `organization` rows aren't kept in sync (self-host
 * single-tenant deploys). A NULL `plan_tier` is treated as rank 0
 * (most restrictive — fail closed).
 */
export async function isWorkspaceInstallActive(
  workspaceId: string,
  catalogId: string,
): Promise<boolean> {
  if (!hasInternalDB()) return false;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) return false;
  if (typeof catalogId !== "string" || catalogId.length === 0) return false;

  let rows: GateRow[];
  try {
    rows = await internalQuery<GateRow>(
      `SELECT
         wp.enabled                     AS install_enabled,
         pc.enabled                     AS catalog_enabled,
         pc.min_plan                    AS min_plan,
         org.plan_tier                  AS plan_tier,
         org.is_operator_workspace      AS is_operator_workspace
       FROM workspace_plugins wp
       JOIN plugin_catalog pc ON pc.id = wp.catalog_id
       LEFT JOIN organization org ON org.id = wp.workspace_id
       WHERE wp.workspace_id = $1
         AND (pc.id = $2 OR pc.slug = $2)
       LIMIT 1`,
      [workspaceId, catalogId],
    );
  } catch (err) {
    // Fail closed on DB error. A SELECT outage must not silently widen
    // the gate to "allow everything" — the dogfood proactive flow is
    // intentionally silent during an outage instead of risking sending
    // 🤖 reactions to a workspace whose install state we can't verify.
    log.warn(
      {
        workspaceId,
        catalogId,
        // Pass the full Error so pino's serializer captures the stack —
        // aligns with the listener's `installGateCacheForEvent` wrapper
        // posture (`listener.ts:installGateCacheForEvent`).
        err: err instanceof Error ? err : new Error(String(err)),
      },
      "WorkspaceInstallGate: gate query failed — denying (fail-closed)",
    );
    return false;
  }

  if (rows.length === 0) {
    // No install row at all. Silent miss — the per-event caller logs
    // at debug; this layer stays quiet so a steady-state "workspace has
    // no Slack integration" doesn't fill the structured log.
    return false;
  }

  const row = rows[0]!;
  if (row.install_enabled !== true) return false;
  if (row.catalog_enabled !== true) return false;

  const minRank = planRank(row.min_plan);
  if (minRank === null) {
    // Unknown min_plan value (typo in seed, schema drift). Fail closed
    // and log at warn — the catalog row needs operator attention.
    log.warn(
      {
        workspaceId,
        catalogId,
        minPlan: row.min_plan,
      },
      "WorkspaceInstallGate: unknown min_plan value on catalog row — denying (fail-closed)",
    );
    return false;
  }

  // Operator bypass (#2702). Atlas-own / per-region operator orgs
  // skip the plan check entirely — they never hold a paid plan. The
  // install + catalog `enabled` flags above still gate (an operator
  // workspace can't admit a disabled integration, and uninstalls
  // still take effect). Log at info so operators investigating
  // "why does the gate admit this workspace?" see the answer in the
  // structured log instead of debugging the rank table.
  if (row.is_operator_workspace === true) {
    log.info(
      { workspaceId, catalogId, operatorBypass: true },
      "WorkspaceInstallGate: operator workspace bypass — admitting regardless of plan_tier",
    );
    return true;
  }

  // LEFT JOIN miss / unknown value → rank 0 (see PLAN_RANK header note).
  const workspaceRank = planRank(row.plan_tier) ?? 0;
  return workspaceRank >= minRank;
}

/**
 * Public type of the gate predicate. Matches the listener-side callback
 * shape exported from the chat plugin (`InstallGateFn`) — the two are
 * kept structurally identical so the host can pass `isWorkspaceInstallActive`
 * (or a memoised wrapper) directly into `chatPlugin({ proactive: { ... } })`.
 */
export type WorkspaceInstallGateFn = (
  workspaceId: string,
  catalogId: string,
) => Promise<boolean>;

/**
 * Structured verdict returned by {@link describeInstallGateState}. Used
 * by the proactive listener's deny-path log (#2703) so operators
 * investigating "why doesn't proactive work for workspace X?" see the
 * answer in the structured log instead of running the rank table by
 * hand. Not used inside the per-event gate hot path — the boolean
 * verdict is enough there.
 */
export interface InstallGateVerdict {
  readonly active: boolean;
  readonly installFound: boolean;
  readonly installEnabled: boolean;
  readonly catalogEnabled: boolean;
  readonly planTier: string | null;
  readonly minPlan: string | null;
  readonly operatorBypass: boolean;
  readonly reason:
    | "active"
    | "no_install_row"
    | "install_disabled"
    | "catalog_disabled"
    | "unknown_min_plan"
    | "plan_below_min"
    | "db_error";
}

/**
 * Diagnostic variant of {@link isWorkspaceInstallActive} that returns
 * the full set of facts the gate evaluated, plus a `reason` code naming
 * which one failed. Used by the proactive listener on the deny path
 * (after a throttle window opens) so the gate-deny log carries the
 * information needed to debug "why is this workspace denied?" without
 * a second round of DB diving.
 *
 * Fails closed on DB error: returns `{ active: false, reason: "db_error" }`
 * with every fact field null. The caller's log is the operator surface.
 */
export async function describeInstallGateState(
  workspaceId: string,
  catalogId: string,
): Promise<InstallGateVerdict> {
  const NEUTRAL: Omit<InstallGateVerdict, "active" | "reason"> = {
    installFound: false,
    installEnabled: false,
    catalogEnabled: false,
    planTier: null,
    minPlan: null,
    operatorBypass: false,
  };
  if (!hasInternalDB()) {
    return { ...NEUTRAL, active: false, reason: "db_error" };
  }
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    return { ...NEUTRAL, active: false, reason: "no_install_row" };
  }
  if (typeof catalogId !== "string" || catalogId.length === 0) {
    return { ...NEUTRAL, active: false, reason: "no_install_row" };
  }

  let rows: GateRow[];
  try {
    rows = await internalQuery<GateRow>(
      `SELECT
         wp.enabled                     AS install_enabled,
         pc.enabled                     AS catalog_enabled,
         pc.min_plan                    AS min_plan,
         org.plan_tier                  AS plan_tier,
         org.is_operator_workspace      AS is_operator_workspace
       FROM workspace_plugins wp
       JOIN plugin_catalog pc ON pc.id = wp.catalog_id
       LEFT JOIN organization org ON org.id = wp.workspace_id
       WHERE wp.workspace_id = $1
         AND (pc.id = $2 OR pc.slug = $2)
       LIMIT 1`,
      [workspaceId, catalogId],
    );
  } catch {
    return { ...NEUTRAL, active: false, reason: "db_error" };
  }

  if (rows.length === 0) {
    return { ...NEUTRAL, active: false, reason: "no_install_row" };
  }
  const row = rows[0]!;
  const facts = {
    installFound: true,
    installEnabled: row.install_enabled === true,
    catalogEnabled: row.catalog_enabled === true,
    planTier: row.plan_tier ?? null,
    minPlan: row.min_plan ?? null,
    operatorBypass: row.is_operator_workspace === true,
  } as const;

  if (!facts.installEnabled) return { ...facts, active: false, reason: "install_disabled" };
  if (!facts.catalogEnabled) return { ...facts, active: false, reason: "catalog_disabled" };

  const minRank = planRank(row.min_plan);
  if (minRank === null) {
    return { ...facts, active: false, reason: "unknown_min_plan" };
  }
  if (facts.operatorBypass) {
    return { ...facts, active: true, reason: "active" };
  }
  const wsRank = planRank(row.plan_tier) ?? 0;
  if (wsRank < minRank) {
    return { ...facts, active: false, reason: "plan_below_min" };
  }
  return { ...facts, active: true, reason: "active" };
}

/**
 * Build a per-event cache wrapper around the gate.
 *
 * Returned function memoises results by `${workspaceId}\0${catalogId}`
 * for the lifetime of one event handler invocation. Construct a fresh
 * cache at the top of each event so admin "uninstall" / "disable" UI
 * clicks take effect on the very next event (no cross-event leak).
 *
 * The `\0` separator (NUL byte) prevents the rare collision where
 * `workspaceId + catalogId` happens to match a different pair after
 * concatenation — IDs are unlikely to contain NUL.
 *
 * Mirrors the per-event-fetch pattern used by
 * `safeGetWorkspaceConfig` in `plugins/chat/src/proactive/listener.ts`:
 * stateless underneath, fresh wrapper per event.
 *
 * In-flight de-duplication via caching the *Promise* (not the resolved
 * value) means two concurrent calls within one event share a single
 * DB roundtrip even if they fire before the first resolves.
 */
export function createInstallGateCache(
  gate: WorkspaceInstallGateFn = isWorkspaceInstallActive,
): WorkspaceInstallGateFn {
  const cache = new Map<string, Promise<boolean>>();
  return (workspaceId, catalogId) => {
    const key = `${workspaceId}\x00${catalogId}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const pending = gate(workspaceId, catalogId);
    cache.set(key, pending);
    return pending;
  };
}

/**
 * Bound public surface. The deep-module shape lets call sites import
 * `WorkspaceInstallGate.isWorkspaceInstallActive` rather than the
 * free function, signalling at the call site that this is the gate
 * predicate (not some unrelated boolean returning a workspace fact).
 *
 * `createCache` is exposed via the namespace so the listener wiring
 * has one import surface for both pieces.
 */
export const WorkspaceInstallGate = {
  isWorkspaceInstallActive,
  createCache: createInstallGateCache,
  describeState: describeInstallGateState,
} as const;
