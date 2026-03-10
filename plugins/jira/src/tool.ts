/**
 * JIRA tool — creates issues via JIRA REST API v3.
 *
 * Adapted from packages/api/src/lib/tools/actions/jira.ts as a standalone
 * plugin tool. The original remains in the API package for non-plugin usage.
 * Uses config-provided credentials instead of environment variables.
 */

import { tool } from "ai";
import { z } from "zod";

// ---------------------------------------------------------------------------
// ADF (Atlassian Document Format) helper
// ---------------------------------------------------------------------------

/** Convert plain text to a minimal ADF document (required by JIRA v3 API). */
export function textToADF(text: string) {
  const paragraphs = text
    .split("\n\n")
    .filter((p) => p.trim().length > 0);

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
// Config type — canonical interface used by both tool.ts and index.ts.
// index.ts imports this type and validates it via Zod at factory call time.
// ---------------------------------------------------------------------------

export interface JiraPluginConfig {
  host: string;
  email: string;
  apiToken: string;
  projectKey: string;
  labels?: string[];
}

// ---------------------------------------------------------------------------
// Raw JIRA API call (config-driven, no env vars)
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
  config: JiraPluginConfig,
  params: JiraCreateParams,
): Promise<JiraCreateResult> {
  const project = params.project ?? config.projectKey;
  const auth = Buffer.from(`${config.email}:${config.apiToken}`).toString("base64");
  const apiUrl = `${config.host.replace(/\/$/, "")}/rest/api/3/issue`;

  const body = {
    fields: {
      project: { key: project },
      summary: params.summary,
      description: textToADF(params.description),
      issuetype: { name: "Task" },
      ...(params.labels?.length
        ? { labels: params.labels }
        : config.labels?.length
          ? { labels: config.labels }
          : {}),
    },
  };

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    let detail: string;
    try {
      const errorBody = await response.json();
      const messages = (errorBody as { errorMessages?: string[] }).errorMessages ?? [];
      const fieldErrors = Object.entries(
        (errorBody as { errors?: Record<string, string> }).errors ?? {},
      ).map(([field, msg]) => `${field}: ${msg}`);
      detail = [...messages, ...fieldErrors].join("; ") || `HTTP ${response.status}`;
    } catch {
      let rawText = "";
      try {
        rawText = await response.text();
      } catch (textErr) {
        rawText = `[body unreadable: ${textErr instanceof Error ? textErr.message : String(textErr)}]`;
      }
      detail = rawText
        ? `HTTP ${response.status}: ${rawText.slice(0, 200)}`
        : `HTTP ${response.status}`;
    }
    throw new Error(`JIRA API error: ${detail}`);
  }

  let data: { key: string; self: string };
  try {
    data = (await response.json()) as { key: string; self: string };
  } catch (err) {
    throw new Error(
      "JIRA issue may have been created but response could not be parsed",
      { cause: err },
    );
  }

  if (!data.key) {
    throw new Error(
      "JIRA issue may have been created but response could not be parsed",
    );
  }

  return {
    key: data.key,
    url: `${config.host.replace(/\/$/, "")}/browse/${data.key}`,
  };
}

// ---------------------------------------------------------------------------
// AI SDK tool factory
// ---------------------------------------------------------------------------

const TOOL_DESCRIPTION = `Create a JIRA issue. Requires approval before the issue is actually created.`;

export function createJiraTool(config: JiraPluginConfig) {
  return tool({
    description: TOOL_DESCRIPTION,
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
          `JIRA project key (e.g. 'PROJ'). Defaults to '${config.projectKey}'.`,
        ),
      labels: z
        .array(z.string())
        .optional()
        .describe("Optional labels to apply to the issue"),
    }),
    execute: async ({ summary, description, project, labels }) => {
      return executeJiraCreate(config, { summary, description, project, labels });
    },
  });
}
