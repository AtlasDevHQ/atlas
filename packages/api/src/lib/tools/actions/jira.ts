/**
 * JIRA action — create issues via JIRA REST API v3.
 *
 * Exports:
 * - executeJiraCreate(params, credentials) — raw JIRA API call
 * - createJiraTicket — AtlasAction for the agent tool registry
 *
 * CREDENTIALS ARE NOT READ HERE (#3766). This module used to read
 * `process.env.JIRA_*` directly, which meant every tenant's "create Jira
 * ticket" hit the one operator-configured Jira — the self-host shape, and
 * multi-tenant-broken. Credentials now arrive as an argument, resolved by
 * `credentials/resolver.ts` from the ACTION's workspace: a workspace row, or
 * `process.env` on self-hosted only. This module stays credential-agnostic so
 * the remaining action targets (Linear, GitHub App, Salesforce) are one-entry
 * registry additions rather than four more resolution sites.
 *
 * @see ADR-0046 — per-workspace action credentials
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

const log = createLogger("action:jira");

// ---------------------------------------------------------------------------
// ADF (Atlassian Document Format) helper
// ---------------------------------------------------------------------------

/** Convert plain text to a minimal ADF document (required by JIRA v3 API). */
export function textToADF(text: string) {
  const paragraphs = text
    .split("\n\n")
    .filter((p) => p.trim().length > 0);

  // Fallback for completely empty or whitespace-only text
  const segments = paragraphs.length > 0 ? paragraphs : ["(no description)"];

  return {
    version: 1,
    type: "doc",
    content: segments.map((paragraph) => ({
      type: "paragraph",
      content: [{ type: "text", text: paragraph }],
    })),
  };
}

// ---------------------------------------------------------------------------
// Raw JIRA API call
// ---------------------------------------------------------------------------

export interface JiraCreateParams {
  summary: string;
  description: string;
  project?: string;
  labels?: string[];
}

export interface JiraCreateResult {
  key: string;
  url: string;
}

/**
 * The credential set `executeJiraCreate` needs, keyed by the env-var names
 * declared in the Jira {@link ActionTargetSpec}. The resolver guarantees every
 * REQUIRED field is present and non-empty before this is built, which is why
 * the three required values are non-optional here — a missing one is a
 * resolver bug, not a runtime branch this function re-checks.
 */
export interface JiraCredentials {
  readonly JIRA_BASE_URL: string;
  readonly JIRA_EMAIL: string;
  readonly JIRA_API_TOKEN: string;
  /** Optional in the spec — the agent may name a project per call instead. */
  readonly JIRA_DEFAULT_PROJECT?: string;
}

/**
 * Narrow a resolved credential map to the Jira shape. Throws rather than
 * returning a partial: the resolver's all-or-nothing rule means a set that
 * reaches here is complete, so a gap is corruption between the two.
 */
export function toJiraCredentials(
  values: Readonly<Record<string, string>>,
): JiraCredentials {
  const baseUrl = values.JIRA_BASE_URL;
  const email = values.JIRA_EMAIL;
  const apiToken = values.JIRA_API_TOKEN;
  if (!baseUrl || !email || !apiToken) {
    // No values in the message — only the NAMES of what is missing.
    const missing = [
      !baseUrl && "JIRA_BASE_URL",
      !email && "JIRA_EMAIL",
      !apiToken && "JIRA_API_TOKEN",
    ].filter((v): v is string => typeof v === "string");
    log.error({ missing }, "Resolved Jira credentials are incomplete");
    throw new Error(`Missing JIRA credentials: ${missing.join(", ")}.`);
  }
  return {
    JIRA_BASE_URL: baseUrl,
    JIRA_EMAIL: email,
    JIRA_API_TOKEN: apiToken,
    ...(values.JIRA_DEFAULT_PROJECT
      ? { JIRA_DEFAULT_PROJECT: values.JIRA_DEFAULT_PROJECT }
      : {}),
  };
}

/**
 * Resolve the Jira credentials for an action execution context, then narrow
 * them. The single place the action path crosses into the credential seam.
 */
export async function resolveJiraCredentials(
  ctx: ActionExecutionContext,
): Promise<JiraCredentials> {
  const resolved = await resolveActionCredentials("jira", {
    workspaceId: ctx.workspaceId,
    deployMode: resolveActionDeployMode(),
  });
  log.info(
    { workspaceId: ctx.workspaceId, resolvedFrom: resolved.resolvedFrom },
    "Resolved Jira action credentials",
  );
  return toJiraCredentials(resolved.values);
}

export async function executeJiraCreate(
  params: JiraCreateParams,
  credentials: JiraCredentials,
): Promise<JiraCreateResult> {
  const baseUrl = credentials.JIRA_BASE_URL;
  const email = credentials.JIRA_EMAIL;
  const apiToken = credentials.JIRA_API_TOKEN;

  const project = params.project ?? credentials.JIRA_DEFAULT_PROJECT;
  if (!project) {
    log.error({ summary: params.summary }, "No JIRA project specified");
    throw new Error(
      "No JIRA project specified. Provide a project key, or set a default project under Admin → Integrations → Jira.",
    );
  }

  const auth = Buffer.from(`${email}:${apiToken}`).toString("base64");
  const url = `${baseUrl.replace(/\/$/, "")}/rest/api/3/issue`;

  const body = {
    fields: {
      project: { key: project },
      summary: params.summary,
      description: textToADF(params.description),
      issuetype: { name: "Task" },
      ...(params.labels?.length ? { labels: params.labels } : {}),
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    let detail: string;
    try {
      const errorBody = await response.json();
      // JIRA returns { errorMessages, errors } — extract actionable info without exposing internals
      const messages = (errorBody as { errorMessages?: string[] }).errorMessages ?? [];
      const fieldErrors = Object.entries(
        (errorBody as { errors?: Record<string, string> }).errors ?? {},
      ).map(([field, msg]) => `${field}: ${msg}`);
      detail = [...messages, ...fieldErrors].join("; ") || `HTTP ${response.status}`;
    } catch {
      // intentionally ignored: JSON parse failed, fall through to text() attempt
      let rawText = "";
      try {
        rawText = await response.text();
      } catch {
        // intentionally ignored: body may already be consumed
      }
      detail = rawText
        ? `HTTP ${response.status}: ${rawText.slice(0, 200)}`
        : `HTTP ${response.status}`;
    }
    log.error({ status: response.status, url, detail, project }, "JIRA API request failed");
    throw new Error(`JIRA API error: ${detail}`);
  }

  let data: { key: string; self: string };
  try {
    data = (await response.json()) as { key: string; self: string };
  } catch (err) {
    log.error({ err }, "Failed to parse JIRA success response");
    throw new Error(
      "JIRA issue may have been created but response could not be parsed",
      { cause: err },
    );
  }

  if (!data.key) {
    log.error({ data }, "JIRA response missing issue key");
    throw new Error(
      "JIRA issue may have been created but response could not be parsed",
    );
  }

  return {
    key: data.key,
    url: `${baseUrl.replace(/\/$/, "")}/browse/${data.key}`,
  };
}

// ---------------------------------------------------------------------------
// Agent tool (AtlasAction)
// ---------------------------------------------------------------------------

const CREATE_JIRA_DESCRIPTION = `### Create JIRA Ticket
Use createJiraTicket to create a new JIRA issue based on the analysis findings:
- Provide a clear, concise summary (max 255 chars)
- Include relevant details in the description
- Optionally specify a project key and labels
- The ticket will require approval before creation`;

export const createJiraTicket: AtlasAction = {
  name: "createJiraTicket",
  description: CREATE_JIRA_DESCRIPTION,
  actionType: "jira:create",
  reversible: true,
  defaultApproval: "manual",
  // Empty since #3766, same as `sendEmailReport`. `requiredCredentials` is
  // checked by `ToolRegistry.validateActionCredentials()` against the GLOBAL
  // `process.env` — a question that no longer has a meaningful answer for this
  // action. Jira credentials are per-workspace: on SaaS there is no global rung
  // at all, and on self-hosted the env rung is one of two, so a workspace that
  // configured Jira from Admin would still be reported "missing credentials".
  // Configuration status is per-workspace and lives on the Admin surface
  // (`getActionTargetStatus`), not in a process-wide startup warning.
  requiredCredentials: [],

  tool: tool({
    description:
      "Create a JIRA issue. Requires approval before the issue is actually created.",
    inputSchema: z.object({
      summary: z
        .string()
        .max(255)
        .describe("Issue summary / title (max 255 characters)"),
      description: z
        .string()
        .describe("Detailed issue description"),
      project: z
        .string()
        .optional()
        .describe(
          "JIRA project key (e.g. 'PROJ'). Falls back to the workspace's configured default project.",
        ),
      labels: z
        .array(z.string())
        .optional()
        .describe("Optional labels to apply to the issue"),
    }),
    execute: async ({ summary, description, project, labels }) => {
      log.info({ summary, project }, "createJiraTicket invoked");

      const request = buildActionRequest({
        actionType: "jira:create",
        // No env read here (#3766): the default project now lives in the
        // workspace's credential row and is resolved at EXECUTION time, so a
        // rotation between request and approval is picked up. When the agent
        // names no project, the approval card says so rather than guessing.
        target: project ?? "(workspace default project)",
        summary: `Create JIRA ticket: ${summary}`,
        payload: { summary, description, project, labels },
        reversible: true,
      });

      return handleAction(request, async (payload, ctx) => {
        // Resolved from the ACTION's workspace, not the approver's — a
        // manual-approval action executes inside the approver's request.
        const credentials = await resolveJiraCredentials(ctx);
        const result = await executeJiraCreate(
          payload as unknown as JiraCreateParams,
          credentials,
        );
        return {
          ...result,
          // Best-effort rollback metadata — transitioning to "Closed" depends on
          // the JIRA workflow configuration and is NOT guaranteed to work in all
          // JIRA instances or project configurations.
          rollbackInfo: {
            method: "transition",
            params: { issueKey: result.key, targetStatus: "Closed" },
          },
        };
      });
    },
  }),
};
