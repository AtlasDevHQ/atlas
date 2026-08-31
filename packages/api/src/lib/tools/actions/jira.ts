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
import { buildActionRequest, handleAction } from "./handler";
import { createLogger } from "@atlas/api/lib/logger";
import { assertBaseUrlAllowed, hostForLog } from "@atlas/api/lib/openapi/egress-guard";
import { resolveCredentialsFor } from "./credentials/resolver";
import { JIRA_TARGET, type ActionCredentialsOf } from "./credentials/targets";

const log = createLogger("action:jira");

/** Outer budget for the create call — the same bound the Linear action uses.
 * Without it, `getActionConfig` leaves `timeout` undefined on a default
 * deployment and `executeWithTimeout(fn, undefined)` returns `fn()`
 * unguarded, so a hung Jira host would hang the agent turn with no bound. */
const JIRA_TIMEOUT_MS = 15_000;

/**
 * An abort from the outer timeout. Duck-typed rather than `instanceof Error`:
 * `AbortController` rejects with a `DOMException`, which does not subclass
 * `Error` on every runtime, so an instanceof check would misreport a timeout
 * as an upstream failure. (Same shape as the Linear action's — a third copy
 * would justify reopening ADR-0045's deferred `lib/vendor-http` extraction,
 * which is exactly where this belongs when that happens.)
 */
function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "AbortError"
  );
}

/**
 * Validate the tenant-typed base URL before any request carries the Basic
 * auth header to it. `JIRA_BASE_URL` comes from the same
 * `workspace_action_credentials` row as Salesforce's instance URL, typed by
 * the same tenant admin — and the Salesforce action already reasoned its way
 * to this guard (`normalizeInstanceUrl`): an unguarded value turns a
 * settings form into an outbound probe of the deployment's own network,
 * with a credential attached. The refusal message deliberately does not echo
 * the guard's own wording — naming "blocked internal address" back to
 * whoever typed the URL turns the form into a network scanner with a
 * readout.
 */
function normalizeJiraBaseUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "Jira base URL is not a valid URL");
    throw new Error(
      "The configured Jira base URL is not a valid URL. It should be your Jira site URL, e.g. https://acme.atlassian.net.",
    );
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`The configured Jira base URL must use https (got "${parsed.protocol}").`);
  }
  try {
    assertBaseUrlAllowed(parsed.origin);
  } catch (err) {
    log.error(
      { host: hostForLog(parsed.origin), err: err instanceof Error ? err.message : String(err) },
      "Jira base URL was refused by the egress guard",
    );
    throw new Error(
      "The configured Jira base URL does not point at a reachable public Jira host. Use your Jira site URL, e.g. https://acme.atlassian.net.",
    );
  }
  return parsed.origin + parsed.pathname.replace(/\/+$/, "");
}

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
 * The credential set `executeJiraCreate` needs — DERIVED from the Jira
 * target spec, so the required/optional split has exactly one author (the
 * registry). Resolution goes through `resolveCredentialsFor(JIRA_TARGET, …)`,
 * whose all-or-nothing guarantee is what makes every required key present.
 */
export type JiraCredentials = ActionCredentialsOf<typeof JIRA_TARGET>;

export async function executeJiraCreate(
  params: JiraCreateParams,
  credentials: JiraCredentials,
): Promise<JiraCreateResult> {
  const baseUrl = normalizeJiraBaseUrl(credentials.JIRA_BASE_URL);
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
  const url = `${baseUrl}/rest/api/3/issue`;

  const body = {
    fields: {
      project: { key: project },
      summary: params.summary,
      description: textToADF(params.description),
      issuetype: { name: "Task" },
      ...(params.labels?.length ? { labels: params.labels } : {}),
    },
  };

  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), JIRA_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      signal: abort.signal,
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (isAbortError(err)) {
      log.error({ host: hostForLog(url), timeoutMs: JIRA_TIMEOUT_MS }, "JIRA API request timed out");
      throw new Error(
        `JIRA did not respond within ${JIRA_TIMEOUT_MS / 1000}s. The issue was not created — check the site is reachable and retry.`,
      );
    }
    throw err;
  } finally {
    clearTimeout(deadline);
  }

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
    url: `${baseUrl}/browse/${data.key}`,
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
  // Vestigial (ADR-0046): credentials are per-workspace, so the global-env
  // question this field used to answer has no subject — status lives on the
  // Admin surface (`getActionTargetStatus`). Kept because the published
  // action shape and `isAction` still carry the field.
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
        const credentials = await resolveCredentialsFor(JIRA_TARGET, ctx);
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
