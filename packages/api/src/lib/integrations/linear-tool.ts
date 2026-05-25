/**
 * `createLinearIssue` agent tool (#2750).
 *
 * Per-Workspace lazy-plugin tool that dispatches through whichever
 * Linear install is enabled for the active workspace:
 *
 *   1. Look up `catalog:linear` (OAuth mode) first — preferred path
 *      because access tokens rotate automatically.
 *   2. Fall back to `catalog:linear-apikey` (API-key mode) when no
 *      OAuth install is present.
 *   3. If neither is installed, return `no_install` with the
 *      `/admin/integrations` install copy.
 *
 * Two-mode dispatch lives in this tool — not in the lazy-loader —
 * because the loader's contract is "one builder per catalog id." The
 * tool is the natural seam where "Linear is one *capability* with two
 * install paths" is expressed; the loader stays unaware that the two
 * catalog rows are related.
 *
 * Surfaces seven distinct status discriminants to the agent so the
 * model can self-correct or stop looping (sendEmail #2698 set the
 * pattern):
 *
 *   - **`created`** — happy path; carries the issue id + URL.
 *   - **`no_workspace`** — request had no `activeOrganizationId`.
 *   - **`no_install`** — actionable "install at /admin/integrations"
 *     message. Triggered when NEITHER `catalog:linear` nor
 *     `catalog:linear-apikey` has an enabled `workspace_plugins` row.
 *   - **`decrypt_failure`** — selective-field decrypt threw. Surfaces
 *     `requestId` for ops correlation. Terminal — retry won't help.
 *   - **`misconfigured`** — `LazyPluginBuilderMissingError` from the
 *     loader. The catalog row is installed but the boot DAG never
 *     registered the matching builder — an operator-side bug.
 *   - **`reconnect_required`** — the OAuth install's refresh-token
 *     rotation failed permanently OR the API-key was rejected. Distinct
 *     remediation per mode: OAuth → Reconnect button at
 *     /admin/integrations; API-key → rotate the personal key and
 *     re-submit the install form.
 *   - **`create_failure`** — Linear's GraphQL returned errors. Wraps
 *     the upstream message (scrubbed via `errorMessage()` so credentials
 *     embedded in upstream error text don't leak to the agent).
 *
 * Workspace context resolution: read from {@link getRequestContext}'s
 * `user.activeOrganizationId`. Tool registration happens at boot;
 * workspace presence is NOT checked at registration time — the tool is
 * always discoverable, and the per-Workspace install gate runs at
 * execute time. Matches the sendEmail #2698 pattern.
 *
 * @see ./linear/lazy-builder.ts — per-mode builders + shared GraphQL helper
 * @see ./install/linear-oauth-handler.ts — OAuth install path
 * @see ./install/linear-apikey-form-handler.ts — API-key install path
 * @see ./email-tool.ts — first per-Workspace lazy-plugin tool reference
 * @see ../tools/registry.ts — `defaultRegistry` registration site
 */

import { tool } from "ai";
import { z } from "zod";

import { createLogger, getRequestContext } from "@atlas/api/lib/logger";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import {
  lazyPluginLoader,
  LazyPluginBuilderMissingError,
  LazyPluginInstallNotFoundError,
  type LazyPluginLoader,
} from "@atlas/api/lib/plugins/lazy-loader";
import {
  LINEAR_CATALOG_ID,
  LINEAR_APIKEY_CATALOG_ID,
  LinearApiKeyDecryptFailureError,
  LinearApiKeyMissingError,
  LinearApiKeyRejectedError,
  LinearGraphQLError,
  type LinearPluginInstance,
  type LinearIssueCreateResult,
} from "./linear/lazy-builder";
import { LinearReconnectRequiredError } from "./install/linear-token-refresh";

const log = createLogger("integrations.linear.tool");

export const CREATE_LINEAR_ISSUE_DESCRIPTION = `### Create Linear Issue
Use createLinearIssue to create a new Linear issue based on the agent's findings:
- Provide a concise title (the issue's name in Linear)
- Include relevant context in the description (markdown supported)
- Optionally specify a teamKey (e.g. "ENG") or teamId (UUID) to target a specific team — without one, Linear picks the bearer's default team
- Optionally include labelIds to tag the issue
- The Linear integration must be installed for the workspace at /admin/integrations
- Either OAuth mode (catalog:linear) or API-key mode (catalog:linear-apikey) works; the tool tries OAuth first and falls back to API-key`;

/**
 * Test seam — production calls go through the singleton
 * `lazyPluginLoader`. Tests inject a fake loader (and a fake context
 * source) so the tool's execute path can be exercised without booting
 * the loader.
 */
export interface CreateLinearIssueToolDeps {
  readonly loader?: Pick<LazyPluginLoader, "getOrInstantiate">;
  readonly resolveWorkspaceId?: () => string | undefined;
  readonly resolveRequestId?: () => string | undefined;
}

const CreateLinearIssueInput = z.object({
  title: z
    .string()
    .min(1, "title must not be empty")
    .max(255, "title must be 255 characters or fewer"),
  description: z.string().optional(),
  teamKey: z
    .string()
    .regex(
      /^[A-Z][A-Z0-9_]*$/,
      "teamKey must be uppercase alphanumeric (e.g. 'ENG')",
    )
    .optional(),
  teamId: z.string().uuid().optional(),
  priority: z
    .number()
    .int()
    .min(0)
    .max(4)
    .optional()
    .describe("0=no priority, 1=urgent, 2=high, 3=medium, 4=low"),
  labelIds: z.array(z.string().uuid()).optional(),
});

type CreateLinearIssueExecuteResult =
  | {
      status: "created";
      mode: "oauth" | "apikey";
      issue: LinearIssueCreateResult;
    }
  | {
      status: "no_workspace";
      message: string;
    }
  | {
      status: "no_install";
      message: string;
    }
  | {
      status: "decrypt_failure";
      message: string;
      requestId: string | undefined;
    }
  | {
      status: "misconfigured";
      message: string;
      requestId: string | undefined;
    }
  | {
      // OAuth refresh permanently failed OR API-key was rejected.
      // Mode tells the agent which remediation to point the user at.
      status: "reconnect_required";
      mode: "oauth" | "apikey";
      message: string;
    }
  | {
      status: "create_failure";
      message: string;
      requestId: string | undefined;
    };

function defaultResolveWorkspaceId(): string | undefined {
  return getRequestContext()?.user?.activeOrganizationId;
}

function defaultResolveRequestId(): string | undefined {
  return getRequestContext()?.requestId;
}

/**
 * Try to instantiate a Linear plugin for `(workspaceId, catalogId)`.
 * Returns:
 *   - `instance` on success
 *   - `null` on `LazyPluginInstallNotFoundError` (no enabled install row)
 *   - throws on every other class so the caller can branch into
 *     decrypt_failure / misconfigured / reconnect_required / create_failure
 */
async function tryInstantiate(
  loader: Pick<LazyPluginLoader, "getOrInstantiate">,
  workspaceId: string,
  catalogId: string,
): Promise<LinearPluginInstance | null> {
  try {
    const raw = await loader.getOrInstantiate(workspaceId, catalogId);
    return raw as LinearPluginInstance;
  } catch (err) {
    if (err instanceof LazyPluginInstallNotFoundError) {
      return null;
    }
    throw err;
  }
}

export function createCreateLinearIssueTool(deps: CreateLinearIssueToolDeps = {}) {
  const loader = deps.loader ?? lazyPluginLoader;
  const resolveWorkspaceId = deps.resolveWorkspaceId ?? defaultResolveWorkspaceId;
  const resolveRequestId = deps.resolveRequestId ?? defaultResolveRequestId;

  return tool({
    description:
      "Create a Linear issue from the agent's findings. Uses the workspace's installed Linear integration (OAuth-preferred, API-key fallback).",
    inputSchema: CreateLinearIssueInput,
    execute: async ({
      title,
      description,
      teamKey,
      teamId,
      priority,
      labelIds,
    }): Promise<CreateLinearIssueExecuteResult> => {
      const workspaceId = resolveWorkspaceId();
      if (!workspaceId) {
        log.warn(
          { requestId: resolveRequestId() },
          "createLinearIssue invoked with no active workspaceId",
        );
        return {
          status: "no_workspace",
          message:
            "No workspace is selected for this request. Open a workspace-scoped session before creating Linear issues.",
        };
      }

      // ── Dispatch: OAuth first, then API-key ─────────────────────────
      // Both modes can coexist (different catalog_id under the partial
      // unique index) but OAuth is preferred because it refreshes
      // automatically. If both are installed we pick OAuth and ignore
      // the API-key row entirely.
      let mode: "oauth" | "apikey" = "oauth";
      let instance: LinearPluginInstance | null;

      try {
        instance = await tryInstantiate(loader, workspaceId, LINEAR_CATALOG_ID);
        if (!instance) {
          instance = await tryInstantiate(loader, workspaceId, LINEAR_APIKEY_CATALOG_ID);
          if (instance) mode = "apikey";
        }
      } catch (err) {
        if (err instanceof LinearReconnectRequiredError) {
          log.warn(
            { workspaceId, err: err.message },
            "createLinearIssue aborted — Linear OAuth install needs Reconnect",
          );
          return {
            status: "reconnect_required",
            mode: "oauth",
            message:
              "Linear install needs to be reconnected. Open /admin/integrations and click Reconnect on the Linear (OAuth) card.",
          };
        }
        if (err instanceof LinearApiKeyDecryptFailureError) {
          const requestId = resolveRequestId();
          log.error(
            { workspaceId, requestId, err: err.message },
            "createLinearIssue aborted — Linear API-key install decrypt failure",
          );
          return {
            status: "decrypt_failure",
            message: `Linear API-key credentials could not be decrypted for this workspace. Verify the encryption keyset and retry; request id ${requestId ?? "<unset>"}.`,
            requestId,
          };
        }
        if (err instanceof LinearApiKeyMissingError) {
          const requestId = resolveRequestId();
          log.error(
            { workspaceId, requestId, err: err.message },
            "createLinearIssue aborted — Linear API-key install row missing api_key field",
          );
          return {
            status: "create_failure",
            message: `Linear API-key install row is missing the api_key field. Disconnect + reinstall at /admin/integrations. Request id ${requestId ?? "<unset>"}.`,
            requestId,
          };
        }
        if (err instanceof LazyPluginBuilderMissingError) {
          const requestId = resolveRequestId();
          log.error(
            { workspaceId, requestId, err: err.message },
            "createLinearIssue aborted — Linear lazy builder not registered (boot DAG issue)",
          );
          return {
            status: "misconfigured",
            message: `Linear integration is installed but no builder is registered. This is a deploy-side configuration issue; contact your operator. Request id ${requestId ?? "<unset>"}.`,
            requestId,
          };
        }
        const requestId = resolveRequestId();
        log.error(
          { workspaceId, requestId, err: err instanceof Error ? err.message : String(err) },
          "createLinearIssue aborted — failed to instantiate Linear plugin",
        );
        return {
          status: "create_failure",
          message: `Could not initialise the Linear integration: ${errorMessage(err)}`,
          requestId,
        };
      }

      if (!instance) {
        log.info(
          { workspaceId },
          "createLinearIssue rejected — workspace has no Linear install (OAuth or API-key)",
        );
        return {
          status: "no_install",
          message:
            "Install the Linear integration at /admin/integrations before creating issues. Neither catalog:linear (OAuth) nor catalog:linear-apikey (API key) is enabled for this workspace.",
        };
      }

      // ── Execute the create ─────────────────────────────────────────
      try {
        const issue = await instance.createLinearIssue({
          title,
          ...(description ? { description } : {}),
          ...(teamKey ? { teamKey } : {}),
          ...(teamId ? { teamId } : {}),
          ...(typeof priority === "number" ? { priority } : {}),
          ...(labelIds && labelIds.length > 0 ? { labelIds } : {}),
        });
        log.info(
          {
            workspaceId,
            mode,
            issueId: issue.id,
            issueIdentifier: issue.identifier,
          },
          "createLinearIssue created Linear issue",
        );
        return { status: "created", mode, issue };
      } catch (err) {
        if (err instanceof LinearReconnectRequiredError) {
          log.warn(
            { workspaceId, err: err.message },
            "createLinearIssue: Linear OAuth refresh failed permanently mid-call",
          );
          return {
            status: "reconnect_required",
            mode: "oauth",
            message:
              "Linear OAuth refresh failed permanently. Open /admin/integrations and click Reconnect on the Linear (OAuth) card.",
          };
        }
        if (err instanceof LinearApiKeyRejectedError) {
          log.warn(
            { workspaceId, err: err.message },
            "createLinearIssue: Linear rejected the stored API key",
          );
          return {
            status: "reconnect_required",
            mode: "apikey",
            message:
              "Linear rejected the stored API key. Generate a new personal API key in Linear settings and re-submit the install form at /admin/integrations.",
          };
        }
        if (err instanceof LinearGraphQLError) {
          const requestId = resolveRequestId();
          log.warn(
            { workspaceId, requestId, err: err.upstreamMessage },
            "createLinearIssue: Linear GraphQL rejected the mutation",
          );
          return {
            status: "create_failure",
            message: `Linear rejected the issue creation: ${err.upstreamMessage}`,
            requestId,
          };
        }
        const requestId = resolveRequestId();
        log.error(
          { workspaceId, requestId, err: err instanceof Error ? err.message : String(err) },
          "createLinearIssue: Linear issueCreate threw",
        );
        return {
          status: "create_failure",
          // `errorMessage()` scrubs connection-string-shaped substrings
          // from the underlying error text and truncates to 512 chars.
          message: `Linear issue creation failed: ${errorMessage(err)}`,
          requestId,
        };
      }
    },
  });
}

/** Production tool instance, registered with `defaultRegistry` in `tools/registry.ts`. */
export const createLinearIssueTool = createCreateLinearIssueTool();
