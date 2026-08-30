/**
 * Linear action — create issues via Linear's GraphQL API (#5554).
 *
 * Exports:
 * - executeLinearCreate(params, credentials) — raw Linear API call
 * - createLinearTicket — AtlasAction for the agent tool registry
 *
 * CREDENTIAL-AGNOSTIC BY CONSTRUCTION. This module never reads `process.env`:
 * credentials arrive as an argument, resolved by `credentials/resolver.ts` from
 * the ACTION's workspace (a workspace row, or `process.env` on self-hosted
 * only). Jira had to be ported off globals to get here; Linear is net-new and
 * starts there, which is the whole point of ADR-0046's seam — the target
 * registry entry plus this module are the entire target.
 *
 * ── Not the same thing as `createLinearIssue` ────────────────────────────
 *
 * `lib/integrations/linear-tool.ts` (#2750) also creates Linear issues, and
 * the two coexist deliberately — the same shape as `sendEmail` (integration)
 * alongside `sendEmailReport` (action):
 *
 *   - `createLinearIssue` dispatches through the workspace's Linear INSTALL
 *     (`catalog:linear` OAuth, or `catalog:linear-apikey`), fires immediately,
 *     and reports install/reconnect status back to the model.
 *   - `createLinearTicket` (this module) dispatches through the workspace's
 *     ACTION CREDENTIALS and goes through the approval queue, the action
 *     audit log and rollback metadata.
 *
 * They are separate credentials on purpose: ADR-0046 keeps a query plugin's
 * OAuth bundle in `integration_credentials` and an action target's field map
 * in `workspace_action_credentials`, because the two carry incompatible
 * payloads and lifecycles on the same natural key. Jira already has that
 * split; this is Linear's.
 *
 * @see ADR-0046 — per-workspace action credentials
 * @see ./jira.ts — the credential-agnostic action shape this mirrors
 * @see ../../integrations/linear-tool.ts — the install-backed sibling tool
 */

import { tool } from "ai";
import { z } from "zod";
import type { AtlasAction } from "@atlas/api/lib/action-types";
import { buildActionRequest, handleAction, type ActionExecutionContext } from "./handler";
import { createLogger } from "@atlas/api/lib/logger";
import {
  resolveActionCredentials,
  resolveActionDeployMode,
} from "./credentials/resolver";

const log = createLogger("action:linear");

/** Linear's single GraphQL endpoint — fixed, which is why the target has no base-URL field. */
const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

/** Outer budget for the create call, including the optional team lookup. */
const LINEAR_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export interface LinearCreateParams {
  title: string;
  description: string;
  teamKey?: string;
  priority?: number;
  labelIds?: string[];
}

export interface LinearCreateResult {
  /** Linear's internal UUID — the handle the rollback metadata names. */
  id: string;
  /** Human-facing key, e.g. `ENG-42`. */
  identifier: string;
  url: string;
}

/**
 * The credential set `executeLinearCreate` needs, keyed by the env-var names
 * declared in the Linear {@link ActionTargetSpec}. The resolver guarantees
 * every REQUIRED field is present and non-empty before this is built, which is
 * why the API key is non-optional here — a missing one is a resolver bug, not
 * a runtime branch this function re-checks.
 */
export interface LinearCredentials {
  readonly LINEAR_API_KEY: string;
  /** Optional in the spec — the agent may name a team per call instead. */
  readonly LINEAR_DEFAULT_TEAM_KEY?: string;
}

/**
 * Narrow a resolved credential map to the Linear shape. Throws rather than
 * returning a partial: the resolver's all-or-nothing rule means a set that
 * reaches here is complete, so a gap is corruption between the two.
 */
export function toLinearCredentials(
  values: Readonly<Record<string, string>>,
): LinearCredentials {
  const apiKey = values.LINEAR_API_KEY;
  if (!apiKey) {
    // No values in the message — only the NAME of what is missing.
    log.error({ missing: ["LINEAR_API_KEY"] }, "Resolved Linear credentials are incomplete");
    throw new Error("Missing Linear credentials: LINEAR_API_KEY.");
  }
  return {
    LINEAR_API_KEY: apiKey,
    ...(values.LINEAR_DEFAULT_TEAM_KEY
      ? { LINEAR_DEFAULT_TEAM_KEY: values.LINEAR_DEFAULT_TEAM_KEY }
      : {}),
  };
}

/**
 * Resolve the Linear credentials for an action execution context, then narrow
 * them. The single place the action path crosses into the credential seam.
 */
export async function resolveLinearCredentials(
  ctx: ActionExecutionContext,
): Promise<LinearCredentials> {
  const resolved = await resolveActionCredentials("linear", {
    workspaceId: ctx.workspaceId,
    deployMode: resolveActionDeployMode(),
  });
  log.info(
    { workspaceId: ctx.workspaceId, resolvedFrom: resolved.resolvedFrom },
    "Resolved Linear action credentials",
  );
  return toLinearCredentials(resolved.values);
}

// ---------------------------------------------------------------------------
// Raw Linear API call
// ---------------------------------------------------------------------------

interface LinearGraphQLResponse {
  data?: {
    issueCreate?: {
      success?: boolean;
      issue?: { id?: string; identifier?: string; url?: string };
    };
    teams?: { nodes?: Array<{ id?: string }> };
  };
  errors?: ReadonlyArray<{ message?: string }>;
}

/**
 * An abort from the outer timeout. Duck-typed rather than `instanceof Error`:
 * `AbortController` rejects with a `DOMException`, which does not subclass
 * `Error` on every runtime, so an instanceof check would misreport a timeout
 * as an upstream failure.
 */
function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "AbortError"
  );
}

/**
 * POST one GraphQL document and return the parsed envelope.
 *
 * No message built here interpolates the API key — it travels in the
 * `Authorization` header and nothing reads it back. A non-2xx body is
 * truncated to bound the size of an agent-visible error, not as a redaction:
 * if an upstream ever reflected the request headers, truncation would not save
 * us, so the rule is simply that this module never puts the key in a string.
 */
async function linearGraphQL(
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
  signal: AbortSignal,
): Promise<LinearGraphQLResponse> {
  const response = await fetch(LINEAR_GRAPHQL_URL, {
    method: "POST",
    signal,
    headers: {
      // `Bearer <personal key>`, matching the shipped API-key install path in
      // `integrations/linear/lazy-builder.ts` (its `runIssueCreate` takes the
      // personal key as the bearer directly). Linear accepts a personal key
      // both bare and Bearer-prefixed; this module cannot exercise the live
      // API in tests, so it follows the form already proven in production here
      // rather than the other one.
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    let rawText = "";
    try {
      rawText = await response.text();
    } catch {
      // intentionally ignored: the body of an already-failed response may be
      // unreadable, and the status alone is enough to report.
    }
    const detail = rawText
      ? `HTTP ${response.status}: ${rawText.slice(0, 200)}`
      : `HTTP ${response.status}`;
    log.error({ status: response.status, detail }, "Linear API request failed");
    throw new Error(
      response.status === 401 || response.status === 403
        ? `Linear API error: ${detail}. Linear rejected this workspace's API key — rotate it via PUT /api/v1/admin/action-credentials/linear (or LINEAR_API_KEY on a self-hosted deployment).`
        : `Linear API error: ${detail}`,
    );
  }

  let parsed: LinearGraphQLResponse;
  try {
    parsed = (await response.json()) as LinearGraphQLResponse;
  } catch (err) {
    log.error({ err }, "Failed to parse Linear response");
    throw new Error(
      "Linear issue may have been created but response could not be parsed",
      { cause: err },
    );
  }

  if (parsed.errors && parsed.errors.length > 0) {
    const detail = parsed.errors
      .map((e) => e.message)
      .filter((m): m is string => typeof m === "string" && m.length > 0)
      .join("; ");
    log.error({ detail }, "Linear GraphQL returned errors");
    throw new Error(`Linear API error: ${detail || "unknown GraphQL error"}`);
  }

  return parsed;
}

/**
 * Resolve a team key (`ENG`) to the UUID `issueCreate` wants.
 *
 * Unlike the install-backed tool, a lookup miss is FATAL here rather than a
 * fall-through to the key owner's default team. The team came from a human's
 * approval card — silently creating the issue on a different team than the one
 * the approver read is the wrong failure for an approval-gated action.
 */
async function resolveTeamIdByKey(
  apiKey: string,
  teamKey: string,
  signal: AbortSignal,
): Promise<string> {
  const parsed = await linearGraphQL(
    apiKey,
    `query TeamByKey($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id } } }`,
    { key: teamKey },
    signal,
  );
  const id = parsed.data?.teams?.nodes?.[0]?.id;
  if (typeof id !== "string" || id.length === 0) {
    log.error({ teamKey }, "Linear team key did not resolve to a team");
    throw new Error(
      `Linear team "${teamKey}" was not found. Use a team key visible to this workspace's Linear API key, or configure a default team for the workspace.`,
    );
  }
  return id;
}

export async function executeLinearCreate(
  params: LinearCreateParams,
  credentials: LinearCredentials,
): Promise<LinearCreateResult> {
  const apiKey = credentials.LINEAR_API_KEY;
  const teamKey = params.teamKey ?? credentials.LINEAR_DEFAULT_TEAM_KEY;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LINEAR_TIMEOUT_MS);
  try {
    // No team named anywhere → let Linear use the key owner's default team.
    const teamId = teamKey
      ? await resolveTeamIdByKey(apiKey, teamKey, controller.signal)
      : undefined;

    const input: Record<string, unknown> = {
      title: params.title,
      description: params.description,
      ...(teamId ? { teamId } : {}),
      ...(typeof params.priority === "number" ? { priority: params.priority } : {}),
      ...(params.labelIds?.length ? { labelIds: params.labelIds } : {}),
    };

    const parsed = await linearGraphQL(
      apiKey,
      `mutation IssueCreate($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { id identifier url }
        }
      }`,
      { input },
      controller.signal,
    );

    // Every one of the three is in the mutation's selection set, so a missing
    // one means a malformed response, not an optional field. Defaulting them
    // to "" would hand the agent a success carrying a blank issue key and a
    // blank link — a silent fallback where CLAUDE.md wants an error.
    const issue = parsed.data?.issueCreate?.issue;
    const { id, identifier, url } = issue ?? {};
    if (parsed.data?.issueCreate?.success !== true || !id || !identifier || !url) {
      log.error(
        {
          success: parsed.data?.issueCreate?.success,
          // Names only — which fields were absent, never the response body.
          missing: [!id && "id", !identifier && "identifier", !url && "url"].filter(
            (v): v is string => typeof v === "string",
          ),
        },
        "Linear issueCreate returned an incomplete issue",
      );
      throw new Error(
        "Linear issue may have been created but response could not be parsed",
      );
    }

    return { id, identifier, url };
  } catch (err) {
    if (isAbortError(err)) {
      log.error({ timeoutMs: LINEAR_TIMEOUT_MS }, "Linear issueCreate timed out");
      throw new Error(
        `Linear API error: the request timed out after ${LINEAR_TIMEOUT_MS}ms. Retry, or check Linear's status.`,
        { cause: err },
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Agent tool (AtlasAction)
// ---------------------------------------------------------------------------

const CREATE_LINEAR_TICKET_DESCRIPTION = `### Create Linear Issue (approval-gated)
Use createLinearTicket to file a Linear issue from the analysis findings:
- Provide a clear, concise title (max 255 chars)
- Include relevant details in the description (markdown supported)
- Optionally specify a team key (e.g. 'ENG'), a priority and label ids
- The issue will require approval before creation
- This uses the workspace's Linear ACTION credentials (Admin → action credentials).
  It is not the same path as createLinearIssue, which posts immediately through
  the workspace's Linear integration install. Prefer this one when the issue
  should be reviewed before it is filed.`;

export const createLinearTicket: AtlasAction = {
  name: "createLinearTicket",
  description: CREATE_LINEAR_TICKET_DESCRIPTION,
  actionType: "linear:create",
  reversible: true,
  defaultApproval: "manual",
  // Empty, same as `createJiraTicket` and `sendEmailReport`.
  // `requiredCredentials` is checked by `ToolRegistry.validateActionCredentials()`
  // against the GLOBAL `process.env` — a question with no meaningful answer for
  // a per-workspace target: on SaaS there is no global rung at all, and on
  // self-hosted the env rung is one of two, so a workspace that configured
  // Linear from Admin would still be reported "missing credentials".
  // Configuration status is per-workspace and lives on the Admin surface
  // (`getActionTargetStatus`), not in a process-wide startup warning.
  requiredCredentials: [],

  tool: tool({
    description:
      "Create a Linear issue. Requires approval before the issue is actually created.",
    inputSchema: z.object({
      title: z
        .string()
        .min(1)
        .max(255)
        .describe("Issue title (max 255 characters)"),
      description: z.string().describe("Detailed issue description (markdown)"),
      teamKey: z
        .string()
        .regex(
          /^[A-Z][A-Z0-9_]*$/,
          "teamKey must be uppercase alphanumeric (e.g. 'ENG')",
        )
        .optional()
        .describe(
          "Linear team key (e.g. 'ENG'). Falls back to the workspace's configured default team.",
        ),
      priority: z
        .number()
        .int()
        .min(0)
        .max(4)
        .optional()
        .describe("0=no priority, 1=urgent, 2=high, 3=medium, 4=low"),
      labelIds: z
        .array(z.string().uuid())
        .optional()
        .describe("Optional Linear label ids (UUIDs) to apply"),
    }),
    execute: async ({ title, description, teamKey, priority, labelIds }) => {
      log.info({ title, teamKey }, "createLinearTicket invoked");

      const request = buildActionRequest({
        actionType: "linear:create",
        // The default team lives in the workspace's credential row and is
        // resolved at EXECUTION time, so a rotation between request and
        // approval is picked up. When the agent names no team, the approval
        // card says so rather than guessing.
        target: teamKey ?? "(workspace default team)",
        summary: `Create Linear issue: ${title}`,
        payload: { title, description, teamKey, priority, labelIds },
        reversible: true,
      });

      return handleAction(request, async (payload, ctx) => {
        // Resolved from the ACTION's workspace, not the approver's — a
        // manual-approval action executes inside the approver's request.
        const credentials = await resolveLinearCredentials(ctx);
        const result = await executeLinearCreate(
          payload as unknown as LinearCreateParams,
          credentials,
        );
        return {
          ...result,
          // Best-effort rollback metadata, same standing as Jira's: no handler
          // is registered for this method today, so `dispatchRollback` logs
          // "no rollback handler" rather than archiving anything. Recorded so
          // the undo has a target the moment one is wired.
          rollbackInfo: {
            method: "archive",
            params: { issueId: result.id },
          },
        };
      });
    },
  }),
};
