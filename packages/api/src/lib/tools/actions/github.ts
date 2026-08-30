/**
 * GitHub action — create issues via the GitHub REST API as a GitHub App.
 *
 * Exports:
 * - executeGitHubIssueCreate(params, credentials) — raw GitHub API call
 * - createGitHubIssue — AtlasAction for the agent tool registry
 *
 * CREDENTIALS ARE NOT READ HERE (#5555). This target was net-new, so unlike
 * `jira.ts` there was never a `process.env.GITHUB_*` read to port — it is
 * credential-agnostic from its first commit, and stays that way: the
 * credential set arrives as an argument, resolved by `credentials/resolver.ts`
 * from the ACTION's workspace (a workspace row, or `process.env` on
 * self-hosted only). Nothing below reads `process.env`, and the one helper it
 * calls that WOULD default to operator env (`getGitHubInstallationToken`) is
 * always passed explicit `appId` / `privateKey`, never allowed to fall back.
 *
 * ── Why an App, and what that costs ──────────────────────────────────────
 *
 * A GitHub App does not hand out a long-lived bearer token. Each call signs a
 * short RS256 JWT with the App's private key and exchanges it for an
 * installation token (`lib/github/installation-token.ts`, which caches per
 * credential set). That is the whole reason this target's credential bundle is
 * three fields and one of them is a PEM, rather than the flat token Jira uses.
 * The shape question that came with #5555 — does the field-spec vocabulary
 * cover this, or does it need a new field kind — is settled and recorded on
 * `ActionCredentialField.multiline` in `credentials/targets.ts`. Short version:
 * a PEM is a long string, not a new kind of value; the only thing the spec was
 * missing was "render a textarea", which is one declarative boolean.
 *
 * The PARSING half of that answer lives here rather than in the spec, because
 * it is protocol detail of this one target — see {@link normalizeAppPrivateKey}.
 *
 * @see ADR-0046 — per-workspace action credentials
 */

import { createPrivateKey } from "node:crypto";
import { tool } from "ai";
import { z } from "zod";
import type { AtlasAction } from "@atlas/api/lib/action-types";
import { buildActionRequest, handleAction, type ActionExecutionContext } from "./handler";
import { createLogger } from "@atlas/api/lib/logger";
import { getGitHubInstallationToken } from "@atlas/api/lib/github/installation-token";
import {
  resolveActionCredentials,
  resolveActionDeployMode,
} from "./credentials/resolver";

const log = createLogger("action:github");

const GITHUB_API_BASE = "https://api.github.com";

/**
 * `owner/repo`, validated before it is interpolated into an API path. GitHub
 * allows alphanumerics, `-`, `_` and `.` in both halves and nothing else, so
 * this rejects a traversal (`../`), a query-string smuggle (`?`) and a second
 * slash outright rather than trusting the model's tool argument.
 */
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/**
 * The credential set `executeGitHubIssueCreate` needs, keyed by the env-var
 * names declared in the GitHub {@link ActionTargetSpec}. The resolver
 * guarantees every REQUIRED field is present and non-empty before this is
 * built, which is why the three required values are non-optional here — a
 * missing one is a resolver bug, not a runtime branch this re-checks.
 */
export interface GitHubCredentials {
  readonly GITHUB_ACTION_APP_ID: string;
  readonly GITHUB_ACTION_INSTALLATION_ID: string;
  readonly GITHUB_ACTION_PRIVATE_KEY: string;
  /** Optional in the spec — the agent may name a repo per call instead. */
  readonly GITHUB_ACTION_DEFAULT_REPO?: string;
}

/**
 * Coerce a stored App private key into the PKCS#8 PEM the JWT signer wants.
 *
 * Two shapes reach us that a strict PKCS#8 parser rejects, and both are what a
 * correct operator or tenant admin will actually produce:
 *
 *   1. **PKCS#1.** GitHub's "Generate a private key" button downloads a
 *      `-----BEGIN RSA PRIVATE KEY-----` file. Telling a workspace admin to
 *      run `openssl pkcs8` on it before pasting is a support ticket, not a
 *      product, so convert instead — `createPrivateKey` reads both encodings
 *      and re-exports one.
 *   2. **`\n`-escaped.** A single-line `.env` value (`KEY="-----BEGIN…\n…"`)
 *      arrives with literal backslash-n, because dotenv does not unescape it.
 *      Only relevant to the self-host env rung — a value pasted into the Admin
 *      textarea has real newlines — but that rung is exactly where a key gets
 *      flattened onto one line.
 *
 * Throws with a message that names the SHAPE problem and never any part of the
 * key: a PEM's payload is the secret, so echoing "near byte 40" or the failing
 * line would leak it into logs and into the action's stored `error` column.
 */
export function normalizeAppPrivateKey(raw: string): string {
  // Only rewrite `\n` when the value contains no real newline: a genuine
  // multi-line PEM whose base64 happens to contain the two characters `\` and
  // `n` must be left alone (base64 has neither, but the BEGIN/END lines are
  // free text and a future GitHub format need not be).
  const unescaped = raw.includes("\n") ? raw : raw.replace(/\\n/g, "\n");
  try {
    return createPrivateKey(unescaped)
      .export({ type: "pkcs8", format: "pem" })
      .toString();
  } catch (err) {
    // The caught error's message can quote the malformed input, so it is
    // deliberately NOT forwarded — only the fact that parsing failed. This
    // catch is not silent (it throws), so it takes no `intentionally ignored`
    // marker; the dropped detail is a secrecy decision, not an ignored error.
    log.error(
      { reason: err instanceof Error ? err.name : "unknown" },
      "Stored GitHub App private key could not be parsed as a PEM private key",
    );
    throw new Error(
      "The stored GitHub App private key is not a readable PEM. Re-paste the whole key, " +
        "including its BEGIN and END lines, under Admin → Action Credentials → GitHub.",
    );
  }
}

/**
 * Narrow a resolved credential map to the GitHub shape. Throws rather than
 * returning a partial: the resolver's all-or-nothing rule means a set that
 * reaches here is complete, so a gap is corruption between the two.
 */
export function toGitHubCredentials(
  values: Readonly<Record<string, string>>,
): GitHubCredentials {
  const appId = values.GITHUB_ACTION_APP_ID;
  const installationId = values.GITHUB_ACTION_INSTALLATION_ID;
  const privateKey = values.GITHUB_ACTION_PRIVATE_KEY;
  if (!appId || !installationId || !privateKey) {
    // No values in the message — only the NAMES of what is missing.
    const missing = [
      !appId && "GITHUB_ACTION_APP_ID",
      !installationId && "GITHUB_ACTION_INSTALLATION_ID",
      !privateKey && "GITHUB_ACTION_PRIVATE_KEY",
    ].filter((v): v is string => typeof v === "string");
    log.error({ missing }, "Resolved GitHub credentials are incomplete");
    throw new Error(`Missing GitHub credentials: ${missing.join(", ")}.`);
  }
  return {
    GITHUB_ACTION_APP_ID: appId,
    GITHUB_ACTION_INSTALLATION_ID: installationId,
    GITHUB_ACTION_PRIVATE_KEY: privateKey,
    ...(values.GITHUB_ACTION_DEFAULT_REPO
      ? { GITHUB_ACTION_DEFAULT_REPO: values.GITHUB_ACTION_DEFAULT_REPO }
      : {}),
  };
}

/**
 * Resolve the GitHub credentials for an action execution context, then narrow
 * them. The single place this action path crosses into the credential seam.
 */
export async function resolveGitHubCredentials(
  ctx: ActionExecutionContext,
): Promise<GitHubCredentials> {
  const resolved = await resolveActionCredentials("github", {
    workspaceId: ctx.workspaceId,
    deployMode: resolveActionDeployMode(),
  });
  log.info(
    { workspaceId: ctx.workspaceId, resolvedFrom: resolved.resolvedFrom },
    "Resolved GitHub action credentials",
  );
  return toGitHubCredentials(resolved.values);
}

// ---------------------------------------------------------------------------
// Raw GitHub API call
// ---------------------------------------------------------------------------

export interface GitHubIssueCreateParams {
  title: string;
  body: string;
  repo?: string;
  labels?: string[];
}

export interface GitHubIssueCreateResult {
  number: number;
  url: string;
  repo: string;
}

/**
 * Extract an actionable detail from a GitHub error body without echoing
 * anything we sent. GitHub replies `{ message, errors: [{ resource, field,
 * code }] }`; the field-level entries name a FIELD and a CODE, never a value,
 * which is why they are safe to surface.
 */
function describeGitHubError(body: unknown, status: number): string {
  if (!body || typeof body !== "object") return `HTTP ${status}`;
  const b = body as { message?: unknown; errors?: unknown };
  const parts: string[] = [];
  if (typeof b.message === "string" && b.message.length > 0) parts.push(b.message);
  if (Array.isArray(b.errors)) {
    for (const entry of b.errors) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as { field?: unknown; code?: unknown };
      if (typeof e.field === "string" && typeof e.code === "string") {
        parts.push(`${e.field}: ${e.code}`);
      }
    }
  }
  return parts.join("; ") || `HTTP ${status}`;
}

export async function executeGitHubIssueCreate(
  params: GitHubIssueCreateParams,
  credentials: GitHubCredentials,
): Promise<GitHubIssueCreateResult> {
  const repo = params.repo ?? credentials.GITHUB_ACTION_DEFAULT_REPO;
  if (!repo) {
    log.error({ title: params.title }, "No GitHub repository specified");
    throw new Error(
      "No GitHub repository specified. Provide one as owner/repo, or set a default repository under Admin → Action Credentials → GitHub.",
    );
  }
  if (!REPO_RE.test(repo)) {
    log.error({ repo }, "GitHub repository is not in owner/repo form");
    throw new Error(
      `GitHub repository "${repo}" is not in owner/repo form (letters, digits, '.', '-' and '_' only).`,
    );
  }

  // Mint (or serve from cache) an installation token for THIS workspace's App.
  // Both credential fields are passed explicitly: `getGitHubInstallationToken`
  // otherwise defaults them to the operator's `GITHUB_APP_*` env, which is the
  // single line that would turn a tenant's issue into one filed as Atlas.
  const token = await getGitHubInstallationToken(
    credentials.GITHUB_ACTION_INSTALLATION_ID,
    {
      appId: credentials.GITHUB_ACTION_APP_ID,
      privateKey: normalizeAppPrivateKey(credentials.GITHUB_ACTION_PRIVATE_KEY),
    },
  );

  const url = `${GITHUB_API_BASE}/repos/${repo}/issues`;
  const body = {
    title: params.title,
    body: params.body,
    ...(params.labels?.length ? { labels: params.labels } : {}),
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    let detail: string;
    try {
      detail = describeGitHubError(await response.json(), response.status);
    } catch {
      // intentionally ignored: JSON parse failed, fall through to text()
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
    log.error({ status: response.status, repo, detail }, "GitHub API request failed");
    throw new Error(`GitHub API error: ${detail}`);
  }

  let data: { number?: number; html_url?: string };
  try {
    data = (await response.json()) as { number?: number; html_url?: string };
  } catch (err) {
    log.error({ err }, "Failed to parse GitHub success response");
    throw new Error(
      "GitHub issue may have been created but response could not be parsed",
      { cause: err },
    );
  }

  if (typeof data.number !== "number") {
    log.error({ repo }, "GitHub response missing issue number");
    throw new Error(
      "GitHub issue may have been created but response could not be parsed",
    );
  }

  return {
    number: data.number,
    // Prefer GitHub's own link; fall back to the canonical shape if absent.
    url: data.html_url ?? `https://github.com/${repo}/issues/${data.number}`,
    repo,
  };
}

// ---------------------------------------------------------------------------
// Agent tool (AtlasAction)
// ---------------------------------------------------------------------------

const CREATE_GITHUB_ISSUE_DESCRIPTION = `### Create GitHub Issue
Use createGitHubIssue to open a GitHub issue based on the analysis findings:
- Provide a clear, concise title (max 255 chars)
- Include relevant details in the body (Markdown is rendered)
- Optionally specify a repository as owner/repo, and labels
- The issue will require approval before creation`;

export const createGitHubIssue: AtlasAction = {
  name: "createGitHubIssue",
  description: CREATE_GITHUB_ISSUE_DESCRIPTION,
  actionType: "github:create_issue",
  reversible: true,
  defaultApproval: "manual",
  // Empty by construction, same as `createJiraTicket` and `sendEmailReport`.
  // `requiredCredentials` is checked by `ToolRegistry.validateActionCredentials()`
  // against the GLOBAL `process.env`, a question with no meaningful answer for a
  // per-workspace target: on SaaS there is no global rung at all, and on
  // self-hosted the env rung is one of two, so a workspace that configured
  // GitHub from Admin would still be reported "missing credentials".
  // Configuration status is per-workspace and lives on the Admin surface
  // (`getActionTargetStatus`).
  requiredCredentials: [],

  tool: tool({
    description:
      "Create a GitHub issue. Requires approval before the issue is actually created.",
    inputSchema: z.object({
      title: z
        .string()
        .max(255)
        .describe("Issue title (max 255 characters)"),
      body: z.string().describe("Detailed issue body (Markdown)"),
      repo: z
        .string()
        .optional()
        .describe(
          "Repository as owner/repo (e.g. 'acme/platform'). Falls back to the workspace's configured default repository.",
        ),
      labels: z
        .array(z.string())
        .optional()
        .describe("Optional labels to apply to the issue"),
    }),
    execute: async ({ title, body, repo, labels }) => {
      log.info({ title, repo }, "createGitHubIssue invoked");

      const request = buildActionRequest({
        actionType: "github:create_issue",
        // No env read here: the default repository lives in the workspace's
        // credential row and resolves at EXECUTION time, so a rotation between
        // request and approval is picked up. When the agent names no repo, the
        // approval card says so rather than guessing.
        target: repo ?? "(workspace default repository)",
        summary: `Create GitHub issue: ${title}`,
        payload: { title, body, repo, labels },
        reversible: true,
      });

      return handleAction(request, async (payload, ctx) => {
        // Resolved from the ACTION's workspace, not the approver's — a
        // manual-approval action executes inside the approver's request.
        const credentials = await resolveGitHubCredentials(ctx);
        const result = await executeGitHubIssueCreate(
          payload as unknown as GitHubIssueCreateParams,
          credentials,
        );
        return {
          ...result,
          // Recorded for a human, not dispatched: `registerRollbackMethod`
          // handlers take only `params` and no ActionExecutionContext, so a
          // handler here could not resolve the workspace's credentials to
          // close the issue with. Same position `createJiraTicket` is in with
          // its `transition` method — the metadata is what an operator needs
          // to undo this by hand, and nothing auto-closes.
          rollbackInfo: {
            method: "github-close-issue",
            params: { repo: result.repo, issueNumber: result.number },
          },
        };
      });
    },
  }),
};
