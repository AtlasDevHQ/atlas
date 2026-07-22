/**
 * Shared per-workspace plugin teardown (#3681).
 *
 * Before this module, three uninstall entry points had materially different
 * teardown completeness and only `WorkspaceInstaller.uninstall` was complete:
 *
 *   - Catalog `DELETE /catalog/:id` (admin-marketplace.ts) relied on the
 *     `plugin_catalog` FK cascade. The cascade removes `workspace_plugins`
 *     + `integration_credentials`, but `scheduled_tasks` is a **soft FK**
 *     (migration 0044) so it is NOT cascaded, the dedicated credential
 *     tables (`slack_installations`, `discord_installations`,
 *     `twenty_integrations`) have no FK to `plugin_catalog` at all, and the
 *     route never invoked `onUninstall` nor evicted the loader. Deleting a
 *     catalog entry N workspaces installed orphaned state across ALL of them.
 *   - Marketplace `DELETE /:id` deleted `workspace_plugins` + `scheduled_tasks`
 *     but never touched dedicated credential stores.
 *   - Datasource soft-uninstall only archived `workspace_plugins`.
 *
 * This module factors the credential + scheduled-task + hook + loader-evict
 * teardown out of `WorkspaceInstaller.uninstall` so every path can run the
 * SAME teardown rather than each re-deriving (and forgetting) a subset.
 *
 *   - {@link deleteDedicatedCredentialStore} — the per-slug dedicated
 *     credential teardown (moved verbatim from `WorkspaceInstaller`). Shared
 *     so the marketplace/catalog routes clear `integration_credentials`,
 *     `slack_installations`, `discord_installations`, and `twenty_integrations`
 *     exactly the way `WorkspaceInstaller.uninstall` does.
 *   - {@link tearDownWorkspaceInstall} — the best-effort orchestrator the
 *     catalog/marketplace paths call per affected workspace: `onUninstall`
 *     hook (+ loader evict, inside the hook) → dedicated credentials →
 *     `scheduled_tasks`. It never throws; it returns a summary so callers
 *     can audit partial failures.
 *
 * `tearDownWorkspaceInstall` deliberately does NOT delete the
 * `workspace_plugins` row itself — each caller owns that statement (the
 * catalog path lets the `plugin_catalog` cascade remove it; the marketplace
 * path `DELETE`s it directly). The hook MUST run while the install row +
 * credentials still exist so the plugin can authenticate to revoke external
 * grants — callers therefore run this BEFORE removing `workspace_plugins`.
 *
 * #4353 — ONE teardown contract. The orchestrator accepts EITHER a resolved
 * `(catalogId, catalogSlug[, teamId])` identity (the catalog path, which is
 * already enumerating install rows) OR a bare `installationId` (the
 * marketplace `DELETE /:id` route, which only has the install id), resolving
 * the identity internally in the latter case. The former
 * `invokeOnUninstallHookForInstallRow` shim did that same row lookup and then
 * ran the hook ONLY — every route wired to it skipped credential + scheduled-
 * task teardown and had to re-derive those steps by hand (with a materially
 * different failure posture). The shim is gone; identity resolution is a
 * detail of the one orchestrator, so no entry point can run a subset again.
 *
 * The uninstall entry points, and what each runs (keep this list current):
 *
 *   1. Catalog `DELETE /catalog/:id` (admin-marketplace.ts) — calls
 *      {@link tearDownWorkspaceInstall} with `(catalogId, catalogSlug, teamId)`
 *      per affected workspace, before the `plugin_catalog` FK cascade.
 *   2. Marketplace `DELETE /marketplace/:id` (admin-marketplace.ts) — calls
 *      {@link tearDownWorkspaceInstall} with `installationId`, before the
 *      `workspace_plugins` DELETE. (Was the hook-only shim path.)
 *   3. `WorkspaceInstaller.uninstall` (effect/workspace-installer.ts) — runs
 *      the same three steps inline rather than through this orchestrator,
 *      deliberately: its credential teardown is fail-HARD (an error preserves
 *      the `workspace_plugins` row so the admin can retry — the ADR-0003
 *      "credentials must not outlive the install record" ordering), whereas
 *      this orchestrator is best-effort for the route paths where the row
 *      removal proceeds regardless. Any change to the step SET belongs in
 *      both places.
 *   4. `WorkspaceInstaller.uninstallDatasource` — calls
 *      {@link tearDownWorkspaceInstall} with `invokeHook: false` +
 *      `deleteCredentials: false`: a soft archive must not revoke external
 *      grants, and datasource credentials live inline in
 *      `workspace_plugins.config` (cleared by the row delete).
 */

import { createLogger } from "@atlas/api/lib/logger";
import { invokeOnUninstallHook } from "./uninstall-hook";
import type { LazyPluginLoader } from "./lazy-loader";
import type { PluginRegistry } from "./registry";

const log = createLogger("plugins:teardown");

type InternalQueryFn = <T = unknown>(sql: string, params?: unknown[]) => Promise<T[]>;

// Lazy `require` mirrors the pattern in `workspace-installer.ts`: keeps
// `db/internal` (and, below, the credential stores) off the static import
// graph so partial `mock.module()` setups elsewhere don't trip bun's
// "Export named 'X' not found" loader error. One cached resolver hit per call.
function lazyInternalQuery(): InternalQueryFn {
  // oxlint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("@atlas/api/lib/db/internal") as {
    internalQuery: InternalQueryFn;
  };
  return mod.internalQuery;
}

/**
 * OAuth integrations whose credentials live in the dedicated
 * `integration_credentials` table (ADR-0005). Adding a new lazy OAuth
 * integration is one line here + a `*-oauth-handler.ts` pair + registration
 * in `lib/integrations/install/register.ts`.
 *
 * @see docs/adr/0005-integration-credentials-table.md
 */
export const INTEGRATION_CREDENTIALS_SLUGS: ReadonlySet<string> = new Set<string>([
  "salesforce",
  "jira",
  // #2750 — Linear OAuth mode. The API-key mode (`linear-apikey`)
  // intentionally is NOT in this set: its credentials live inline in
  // `workspace_plugins.config` via selective-field encryption, so the
  // standard `workspace_plugins` DELETE teardown is sufficient. Only
  // OAuth installs that hydrate `integration_credentials` need
  // dual-store teardown.
  "linear",
]);

/**
 * Delete the dedicated credential store for a slug. A no-op for form-based
 * / static-bot plugins whose credentials live inline in
 * `workspace_plugins.config` (the `workspace_plugins` DELETE is their
 * credential teardown).
 *
 * Throws for a corrupted Slack install row (missing `team_id`) so the
 * caller can decide whether that is fatal — `WorkspaceInstaller.uninstall`
 * treats it as a hard error; the best-effort route paths catch it.
 *
 * Moved from `WorkspaceInstaller` (#3681) so the catalog/marketplace routes
 * share one credential-teardown switch instead of duplicating a subset.
 */
export async function deleteDedicatedCredentialStore(
  slug: string,
  workspaceId: string,
  catalogId: string,
  teamId: string | null,
): Promise<void> {
  if (slug === "slack") {
    if (!teamId) {
      // Defensive — a Slack install row should always carry team_id.
      // If it doesn't, the row is corrupted; surface as a hard error
      // so the admin disconnect attempt isn't silently a no-op.
      throw new Error(
        `Slack disconnect requires team_id from workspace_plugins.config for workspace=${workspaceId}`,
      );
    }
    // Lazy import — keeps `slack/store` and
    // `integrations/credentials/store` out of the static import graph
    // so partial `mock.module()` setups elsewhere (which intentionally
    // omit `deleteInstallation` / `deleteCredentialBundle` because
    // those tests don't exercise the disconnect path) don't trip
    // bun's "Export named 'X' not found" loader error. Production
    // perf cost is one resolver hit per disconnect call.
    // oxlint-disable-next-line @typescript-eslint/no-require-imports
    const { deleteInstallation } = require("@atlas/api/lib/slack/store") as {
      deleteInstallation: (teamId: string) => Promise<void>;
    };
    await deleteInstallation(teamId);
    return;
  }
  if (INTEGRATION_CREDENTIALS_SLUGS.has(slug)) {
    // oxlint-disable-next-line @typescript-eslint/no-require-imports
    const { deleteCredentialBundle } = require("@atlas/api/lib/integrations/credentials/store") as {
      deleteCredentialBundle: (workspaceId: string, catalogId: string) => Promise<boolean>;
    };
    await deleteCredentialBundle(workspaceId, catalogId);
    return;
  }
  if (slug === "twenty") {
    // Twenty CRM — credentials live in the dedicated `twenty_integrations`
    // table, not `workspace_plugins.config`. This step removes the
    // credential row so the dispatcher falls back to env var (or surfaces
    // the actionable "configure under Admin → Integrations → Twenty" error).
    // Lazy import for the same reason as the Slack branch above.
    // oxlint-disable-next-line @typescript-eslint/no-require-imports
    const { deleteTwentyIntegration } = require("@atlas/api/lib/integrations/twenty/store") as {
      deleteTwentyIntegration: (workspaceId: string) => Promise<boolean>;
    };
    await deleteTwentyIntegration(workspaceId);
    return;
  }
  if (slug === "discord") {
    // Discord is dual-store: the static-bot install writes only
    // `workspace_plugins` (routing), but a self-hosted BYOT install also
    // persists a bot token to `discord_installations` (#3161). When a
    // workspace has both, a unified disconnect must clear the BYOT credential
    // too. `deleteDiscordInstallationByOrg` is a no-op (returns false) for a
    // static-bot-only install with no BYOT row, so this is safe in both cases.
    // oxlint-disable-next-line @typescript-eslint/no-require-imports
    const { deleteDiscordInstallationByOrg } = require("@atlas/api/lib/discord/store") as {
      deleteDiscordInstallationByOrg: (orgId: string) => Promise<boolean>;
    };
    await deleteDiscordInstallationByOrg(workspaceId);
    return;
  }
  // Form-based / static-bot (telegram/gchat/whatsapp/teams): no separate
  // credential store; the DELETE on workspace_plugins is the credential
  // teardown. No-op here.
}

/** Options common to both identity forms of {@link tearDownWorkspaceInstall}. */
interface WorkspaceTeardownOptions {
  /** Workspace the plugin is being uninstalled from. */
  readonly workspaceId: string;
  /**
   * Run dedicated-credential teardown. Default `true`. Datasource paths set
   * this `false` — their credentials live inline in `workspace_plugins.config`
   * (cleared by the row delete), so there is no dedicated store to clear.
   */
  readonly deleteCredentials?: boolean;
  /**
   * Invoke the `onUninstall` hook (external grant revocation + loader evict).
   * Default `true`. Datasource paths set this `false`: a soft archive is meant
   * to be re-enabled (revoking external grants would be wrong) and datasource
   * teardown is owned by the pool unregister, not the plugin-instance loader.
   */
  readonly invokeHook?: boolean;
  /** Test seam — defaults to the process-wide `lazyPluginLoader` (inside the hook). */
  readonly loader?: Pick<LazyPluginLoader, "hasBuilder" | "getOrInstantiate" | "evict">;
  /** Test seam — defaults to the process-wide `plugins` registry (inside the hook). */
  readonly registry?: Pick<PluginRegistry, "get">;
  /** Test seam — defaults to `internalQuery`. */
  readonly queryFn?: InternalQueryFn;
  /** Test seam — per-hook deadline. */
  readonly hookTimeoutMs?: number;
}

/**
 * Identity form A — the caller already knows `(catalogId, catalogSlug)`.
 * Used by the catalog cascade (which enumerates `workspace_plugins` rows to
 * find affected workspaces) and by the datasource archive path.
 */
export interface WorkspaceTeardownByCatalogArgs extends WorkspaceTeardownOptions {
  /** `plugin_catalog.id` of the uninstalled entry. Also the `scheduled_tasks.plugin_id`. */
  readonly catalogId: string;
  /** `plugin_catalog.slug` — drives the dedicated-credential-store switch. */
  readonly catalogSlug: string;
  /** Slack `team_id` (from `workspace_plugins.config`), when known. */
  readonly teamId?: string | null;
  readonly installationId?: never;
}

/**
 * Identity form B — the caller only has the `workspace_plugins.id` (the
 * marketplace `DELETE /:id` route). `(catalog_id, slug, team_id)` are
 * resolved from the install row here. The lookup MUST run before the
 * caller's `DELETE … RETURNING`, so the row (and the credentials the hook
 * needs to authenticate) still exists.
 */
export interface WorkspaceTeardownByInstallationArgs extends WorkspaceTeardownOptions {
  /** `workspace_plugins.id` of the row being uninstalled. */
  readonly installationId: string;
  readonly catalogId?: never;
  readonly catalogSlug?: never;
  readonly teamId?: never;
}

export type WorkspaceTeardownArgs =
  | WorkspaceTeardownByCatalogArgs
  | WorkspaceTeardownByInstallationArgs;

interface InstallRowIdentity extends Record<string, unknown> {
  catalog_id: string;
  slug: string | null;
  team_id: string | null;
}

/**
 * Best-effort teardown outcome — a diagnostics / audit record, NOT a
 * control-flow contract. Callers persist it to the uninstall audit row and at
 * most branch on the error fields (`credentialError`, `hookFailures.length`);
 * the success flags (`credentialStoreCleared`, `hookInvoked`,
 * `scheduledTasksError`) exist so a partial failure is fully reconstructable
 * from the audit trail. Do not add invariant-dependent logic on these fields.
 */
export interface WorkspaceTeardownResult {
  /**
   * Whether the `(catalogId, catalogSlug)` identity was available. Always
   * `true` for the `(catalogId, catalogSlug)` form. For the `installationId`
   * form it is `false` when the install row was absent (the caller's DELETE
   * will 404) or the lookup threw ({@link identityError}) — in both cases NO
   * teardown step ran and every count below is zero.
   */
  readonly identityResolved: boolean;
  /** Install-row lookup error (`installationId` form only), when it threw. */
  readonly identityError?: string;
  /** Resolved `plugin_catalog.id`, when identity resolved. */
  readonly catalogId?: string;
  /** Resolved `plugin_catalog.slug`, when identity resolved (`""` if the catalog row was gone). */
  readonly catalogSlug?: string;
  /** Plugin ids whose `onUninstall` ran to completion. */
  readonly hookInvoked: readonly string[];
  /** `onUninstall` hook throws / builder failures, normalized to messages. */
  readonly hookFailures: ReadonlyArray<{ pluginId: string; error: string }>;
  /** Whether dedicated-credential teardown ran without throwing. */
  readonly credentialStoreCleared: boolean;
  /** Dedicated-credential teardown error, when it threw. */
  readonly credentialError?: string;
  /** Number of `scheduled_tasks` rows removed for this (catalog, workspace). */
  readonly scheduledTasksDeleted: number;
  /** `scheduled_tasks` cleanup error, when it threw. */
  readonly scheduledTasksError?: string;
}

/**
 * Best-effort, never-throwing per-workspace teardown shared by the catalog
 * and marketplace uninstall paths. Identity comes in as either
 * `(catalogId, catalogSlug[, teamId])` or a bare `installationId` (resolved
 * here from `workspace_plugins` — see {@link WorkspaceTeardownByInstallationArgs}).
 * Runs the same external/auxiliary teardown `WorkspaceInstaller.uninstall`
 * performs, in the same order:
 *
 *   1. `onUninstall(workspaceId)` hook (revokes external webhook / OAuth
 *      grants) — MUST run while credentials still exist, so callers invoke
 *      this BEFORE removing `workspace_plugins`. The hook also evicts the
 *      `LazyPluginLoader` entry for `(workspace, catalog)`.
 *   2. dedicated credential store ({@link deleteDedicatedCredentialStore}).
 *   3. `scheduled_tasks` (soft FK — never cascaded by any DELETE).
 *
 * Every step is best-effort: a failure in one is recorded in the result and
 * the rest still run, because the caller's row removal proceeds regardless
 * and an orphan is recoverable (scheduled-task orphans are skipped by the
 * execution-time guard and swept by the reconcile fiber; a stranded
 * credential row is cleared on the next disconnect).
 */
export async function tearDownWorkspaceInstall(
  args: WorkspaceTeardownArgs,
): Promise<WorkspaceTeardownResult> {
  const { workspaceId } = args;
  const queryFn = args.queryFn ?? lazyInternalQuery();
  const deleteCredentials = args.deleteCredentials ?? true;
  const invokeHook = args.invokeHook ?? true;

  // 0) Identity. Either supplied directly, or resolved from the install row
  //    (#4353 — folded in from the retired `invokeOnUninstallHookForInstallRow`
  //    shim so the `installationId` entry point can no longer run a subset of
  //    the teardown). The lookup also carries `team_id`, which the Slack branch
  //    of the credential switch needs.
  let catalogId: string;
  let catalogSlug: string;
  let teamId: string | null;
  if (args.installationId !== undefined) {
    const { installationId } = args;
    let rows: InstallRowIdentity[];
    try {
      rows = await queryFn<InstallRowIdentity>(
        `SELECT wp.catalog_id, pc.slug, wp.config->>'team_id' AS team_id
           FROM workspace_plugins wp
           LEFT JOIN plugin_catalog pc ON pc.id = wp.catalog_id
          WHERE wp.id = $1 AND wp.workspace_id = $2
          LIMIT 1`,
        [installationId, workspaceId],
      );
    } catch (err) {
      const identityError = err instanceof Error ? err.message : String(err);
      log.warn(
        { workspaceId, installationId, err: identityError },
        "tearDownWorkspaceInstall: install-row lookup failed — no teardown step ran; hook, credential store and scheduled_tasks may be orphaned (uninstall proceeds)",
      );
      return {
        identityResolved: false,
        identityError,
        hookInvoked: [],
        hookFailures: [],
        credentialStoreCleared: false,
        scheduledTasksDeleted: 0,
      };
    }
    const row = rows[0];
    if (row === undefined) {
      // Row already gone (or never existed) — the caller's DELETE will 404.
      // Nothing to tear down.
      return {
        identityResolved: false,
        hookInvoked: [],
        hookFailures: [],
        credentialStoreCleared: false,
        scheduledTasksDeleted: 0,
      };
    }
    catalogId = row.catalog_id;
    // `slug` is NULL only when the catalog row is already gone (a racing
    // catalog delete). The credential switch then no-ops, but the hook +
    // scheduled_tasks + loader evict still run keyed on catalog id.
    catalogSlug = row.slug ?? "";
    teamId = row.team_id;
  } else {
    catalogId = args.catalogId;
    catalogSlug = args.catalogSlug;
    teamId = args.teamId ?? null;
  }

  // 1) onUninstall hook (+ loader evict, inside). Never throws by contract.
  const hookResult = invokeHook
    ? await invokeOnUninstallHook({
        workspaceId,
        catalogId,
        catalogSlug,
        ...(args.loader ? { loader: args.loader } : {}),
        ...(args.registry ? { registry: args.registry } : {}),
        ...(args.hookTimeoutMs !== undefined ? { hookTimeoutMs: args.hookTimeoutMs } : {}),
      })
    : { invoked: [], failures: [] };

  // 2) dedicated credential store (slack/discord/twenty/integration_credentials).
  let credentialStoreCleared = false;
  let credentialError: string | undefined;
  if (deleteCredentials) {
    try {
      await deleteDedicatedCredentialStore(catalogSlug, workspaceId, catalogId, teamId);
      credentialStoreCleared = true;
    } catch (err) {
      credentialError = err instanceof Error ? err.message : String(err);
      log.warn(
        { workspaceId, catalogSlug, catalogId, err: credentialError },
        "tearDownWorkspaceInstall: dedicated credential teardown failed — credential row may be orphaned; teardown proceeds",
      );
    }
  }

  // 3) scheduled_tasks (soft FK from migration 0044 — never cascaded).
  //    Scoped by (plugin_id = catalog_id, org_id = workspace_id), exactly the
  //    pair the orphan guard in getTasksDueForExecution + the reconcile sweep use.
  let scheduledTasksDeleted = 0;
  let scheduledTasksError: string | undefined;
  try {
    const rows = await queryFn<{ id: string }>(
      `DELETE FROM scheduled_tasks WHERE plugin_id = $1 AND org_id = $2 RETURNING id`,
      [catalogId, workspaceId],
    );
    scheduledTasksDeleted = rows.length;
  } catch (err) {
    scheduledTasksError = err instanceof Error ? err.message : String(err);
    log.warn(
      { workspaceId, catalogSlug, catalogId, err: scheduledTasksError },
      "tearDownWorkspaceInstall: scheduled-task cleanup failed — orphan tasks are skipped by the execution-time guard and swept by the reconcile fiber",
    );
  }

  return {
    identityResolved: true,
    catalogId,
    catalogSlug,
    hookInvoked: hookResult.invoked,
    hookFailures: hookResult.failures,
    credentialStoreCleared,
    ...(credentialError !== undefined && { credentialError }),
    scheduledTasksDeleted,
    ...(scheduledTasksError !== undefined && { scheduledTasksError }),
  };
}
