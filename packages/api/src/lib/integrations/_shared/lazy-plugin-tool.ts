/**
 * Shared scaffolding for per-Workspace lazy-plugin agent tools (#3326).
 *
 * `sendEmail` (#2698), `createLinearIssue` (#2750), and `querySalesforce`
 * (#3311) all follow the same shape: registered globally at boot, with the
 * workspace + install gate running at execute time through
 * `lazyPluginLoader.getOrInstantiate(workspaceId, catalogId)`. Before this
 * module each carried a verbatim copy of the request-context resolvers, a
 * near-identical `*ToolDeps` test seam, and a structurally-similar
 * error→status ladder. The next lazy-plugin tool (Jira) extends this module
 * instead of adding a fourth copy.
 *
 * What stays in each tool: the agent-facing status discriminants and their
 * remediation copy, tool-specific error classes (decrypt failures, API-key
 * rejections), and any message scrubbing (e.g. the SOQL `SENSITIVE_PATTERNS`
 * gate) — those are the tool's contract with the agent, not scaffolding.
 *
 * @see ../email-tool.ts / ../linear-tool.ts / ../salesforce-tool.ts — consumers
 * @see ../../plugins/lazy-loader.ts — the per-Workspace caching seam
 */

import { getRequestContext } from "@atlas/api/lib/logger";
import { IntegrationReconnectRequiredError } from "@atlas/api/lib/effect/errors";
import {
  lazyPluginLoader,
  LazyPluginBuilderMissingError,
  LazyPluginInstallNotFoundError,
  type LazyPluginLoader,
} from "@atlas/api/lib/plugins/lazy-loader";

/**
 * Base test seam shared by every per-Workspace lazy-plugin tool. Production
 * calls go through the singleton `lazyPluginLoader` and the request-context
 * resolvers; tests inject fakes so the execute path runs without booting the
 * loader. Tools with extra seams (whitelist resolution, member-email lookup)
 * extend this interface.
 */
export interface LazyPluginToolDeps {
  readonly loader?: Pick<LazyPluginLoader, "getOrInstantiate">;
  readonly resolveWorkspaceId?: () => string | undefined;
  readonly resolveRequestId?: () => string | undefined;
}

/** {@link LazyPluginToolDeps} with the production defaults applied. */
export interface ResolvedLazyPluginToolDeps {
  readonly loader: Pick<LazyPluginLoader, "getOrInstantiate">;
  readonly resolveWorkspaceId: () => string | undefined;
  readonly resolveRequestId: () => string | undefined;
}

/** Active workspace for the current request — the per-Workspace dispatch key. */
export function defaultResolveWorkspaceId(): string | undefined {
  return getRequestContext()?.user?.activeOrganizationId;
}

/** Request id for ops correlation in agent-visible error payloads. */
export function defaultResolveRequestId(): string | undefined {
  return getRequestContext()?.requestId;
}

/** Apply the production defaults to an injected (possibly partial) deps object. */
export function resolveLazyPluginToolDeps(
  deps: LazyPluginToolDeps,
): ResolvedLazyPluginToolDeps {
  return {
    loader: deps.loader ?? lazyPluginLoader,
    resolveWorkspaceId: deps.resolveWorkspaceId ?? defaultResolveWorkspaceId,
    resolveRequestId: deps.resolveRequestId ?? defaultResolveRequestId,
  };
}

/**
 * Try to instantiate a lazy plugin for `(workspaceId, catalogId)`.
 *
 * Returns the instance on success, `null` on
 * {@link LazyPluginInstallNotFoundError} (no enabled install row — the one
 * "not an error" outcome, used by multi-catalog dispatch like Linear's
 * OAuth→API-key fallback), and rethrows everything else for the caller's
 * status ladder (see {@link classifyLazyInstantiateError}).
 *
 * The cast to `T` is unchecked — same contract as the loader itself, whose
 * builders are registered per catalog id by the boot DAG.
 */
export async function tryInstantiate<T>(
  loader: Pick<LazyPluginLoader, "getOrInstantiate">,
  workspaceId: string,
  catalogId: string,
): Promise<T | null> {
  try {
    return (await loader.getOrInstantiate(workspaceId, catalogId)) as T;
  } catch (err) {
    if (err instanceof LazyPluginInstallNotFoundError) {
      return null;
    }
    throw err;
  }
}

/**
 * The loader-level failure classes every lazy-plugin tool maps to a status:
 *
 * - `install_not_found` — no enabled `workspace_plugins` row → `no_install`.
 * - `reconnect_required` — OAuth refresh failed permanently / install marked
 *   `reconnect_needed` → `reconnect_required`.
 * - `builder_missing` — install row present but the boot DAG registered no
 *   builder for the catalog id (operator-side bug) → `misconfigured`.
 * - `unknown` — anything else (decrypt failures, malformed config, builder
 *   construction errors); the tool maps it to its terminal `*_failure`
 *   status after checking its own tool-specific error classes.
 */
export type LazyInstantiateErrorKind =
  | "install_not_found"
  | "reconnect_required"
  | "builder_missing"
  | "unknown";

/**
 * Classify a `getOrInstantiate` throw into the shared rungs of the
 * error→status ladder. Tool-specific classes (e.g. decrypt failures) must be
 * checked by the tool BEFORE calling this — they all classify as `unknown`.
 */
export function classifyLazyInstantiateError(err: unknown): LazyInstantiateErrorKind {
  if (err instanceof LazyPluginInstallNotFoundError) return "install_not_found";
  if (err instanceof IntegrationReconnectRequiredError) return "reconnect_required";
  if (err instanceof LazyPluginBuilderMissingError) return "builder_missing";
  return "unknown";
}
