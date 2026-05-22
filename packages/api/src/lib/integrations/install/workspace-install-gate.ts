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
 *   4. the workspace's `organization.plan_tier` ranks ≥ the catalog
 *      row's `min_plan`.
 *
 * Any other state (missing install row, install disabled, catalog
 * disabled, plan mismatch, DB hiccup) returns `false`. Fails closed so
 * a registry outage silences the proactive flow rather than letting
 * an unverified workspace continue.
 *
 * ## Plan-tier ranking
 *
 * The two enums historically drifted (catalog's `min_plan` enum vs
 * organization's `plan_tier`):
 *
 *   - `plugin_catalog.min_plan ∈ { starter, team, business, enterprise }`
 *   - `organization.plan_tier  ∈ { free, trial, starter, pro, business }`
 *
 * `PLAN_RANK` below assigns each known value a numeric rank so the
 * comparison is well-defined across both enums. Unknown plan_tier
 * values rank 0 (most restrictive — when we can't classify the
 * workspace, default to "below all gates"). Unknown min_plan values
 * fail closed by *not* admitting the row — a typo in a catalog seed
 * shouldn't accidentally widen access.
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

const log = createLogger("integrations:workspace-install-gate");

/**
 * Numeric rank of every known plan value. Higher = more privileged.
 *
 * Pulls the catalog's `min_plan` enum (`starter | team | business |
 * enterprise`) and the organization's `plan_tier` enum (`free | trial
 * | starter | pro | business`) into one ordering so the gate's
 * "min_plan ≤ workspace.plan" comparison is well-defined regardless
 * of which enum each value was minted from.
 *
 * The ordering matches the customer-visible price ladder; if pricing
 * tiers ever reshuffle, this table is the single place to update.
 */
const PLAN_RANK: Readonly<Record<string, number>> = {
  free: 0,
  trial: 1,
  starter: 2,
  team: 3,
  pro: 4,
  business: 5,
  enterprise: 6,
};

/**
 * Returns the numeric rank for a plan name. `null` means "value not
 * recognised". Callers decide the fail-closed default per call site —
 * for `plan_tier` we treat unknown as rank 0 (most restrictive); for
 * `min_plan` we refuse the row outright (a typo shouldn't widen access).
 */
function planRank(name: string | null | undefined): number | null {
  if (typeof name !== "string") return null;
  const rank = PLAN_RANK[name];
  return typeof rank === "number" ? rank : null;
}

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
         wp.enabled        AS install_enabled,
         pc.enabled        AS catalog_enabled,
         pc.min_plan       AS min_plan,
         org.plan_tier     AS plan_tier
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
        err: err instanceof Error ? err.message : String(err),
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
  // NULL plan_tier (workspace pre-dates the column, or LEFT JOIN miss)
  // ranks 0 — same fail-closed default as an explicit `'free'`.
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
} as const;
