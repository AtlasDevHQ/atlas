/**
 * JIRA action — create issues via JIRA REST API v3.
 *
 * Exports:
 * - executeJiraCreate(params) — raw JIRA API call
 * - createJiraTicket — AtlasAction for the agent tool registry
 */

import { tool } from "ai";
import { z } from "zod";
import type { AtlasAction } from "@atlas/api/lib/action-types";
import { buildActionRequest, handleAction } from "./handler";
import { createLogger } from "@atlas/api/lib/logger";

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

export async function executeJiraCreate(
  params: JiraCreateParams,
): Promise<JiraCreateResult> {
  const baseUrl = process.env.JIRA_BASE_URL;
  const email = process.env.JIRA_EMAIL;
  const apiToken = process.env.JIRA_API_TOKEN;

  if (!baseUrl || !email || !apiToken) {
    log.error("Missing JIRA credentials");
    throw new Error(
      "Missing JIRA credentials. Set JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN.",
    );
  }

  const project = params.project ?? process.env.JIRA_DEFAULT_PROJECT;
  if (!project) {
    log.error({ summary: params.summary }, "No JIRA project specified");
    throw new Error(
      "No JIRA project specified. Provide a project key or set JIRA_DEFAULT_PROJECT.",
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
      // JSON parsing failed — try to get raw text for diagnostics
      let rawText = "";
      try {
        rawText = await response.text();
      } catch {
        // ignore — body may already be consumed
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
  requiredCredentials: ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"],

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
          "JIRA project key (e.g. 'PROJ'). Falls back to JIRA_DEFAULT_PROJECT env.",
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
        target: project ?? process.env.JIRA_DEFAULT_PROJECT ?? "unknown",
        summary: `Create JIRA ticket: ${summary}`,
        payload: { summary, description, project, labels },
        reversible: true,
      });

      return handleAction(request, async (payload) => {
        const result = await executeJiraCreate(
          payload as unknown as JiraCreateParams,
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
