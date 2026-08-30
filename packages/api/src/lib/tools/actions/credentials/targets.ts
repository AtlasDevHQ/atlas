/**
 * Registry of ACTION TARGETS whose credentials are configured per workspace
 * (#3766).
 *
 * This is the REUSABLE SEAM. Adding an action target to the workspace
 * credential surface is a one-entry addition here — the resolver, the store,
 * the Admin route and the health surface all iterate this registry and have
 * no per-target branches. That is what makes the remaining targets one-entry
 * children of #3765 rather than four more design passes — Linear (#5554) was
 * the first to test the claim, and cost exactly one entry here plus its own
 * credential-agnostic action module. GitHub App and Salesforce remain.
 *
 * Workspace tier, deliberately. This registry is the analogue of
 * `integrations/operator-credentials/platforms.ts` (`OperatorPlatformSpec`),
 * one tier down, and the two are NOT symmetric:
 *
 *   - Operator tier — Atlas's own app registrations, operator-shared across
 *     every workspace, keyed by platform. A shared default is meaningful
 *     there: every tenant's Slack install talks to the same Slack app.
 *   - Workspace tier (this file) — a tenant's own external system. A
 *     "platform default Jira" is meaningless: each tenant brings their own.
 *     So there is no operator rung in the ladder (ADR-0046).
 *
 * Each field maps to an EXISTING global env var so `process.env` stays the
 * self-host fallback unchanged — the field's `envVar` is both the storage key
 * in the encrypted bundle AND the `process.env` key the self-host rung reads.
 * One field spec therefore reads both rungs with no per-target mapping table.
 *
 * @see ADR-0046 — per-workspace action credentials
 * @see ./resolver.ts — where the precedence ladder is decided
 */

/** One settable field of an action target's per-workspace credentials. */
export interface ActionCredentialField {
  /** The env var this field maps to (bundle storage key + self-host env key). */
  readonly envVar: string;
  /** Human label for the workspace Admin form. */
  readonly label: string;
  /** Short helper text shown under the field in the Admin UI. */
  readonly hint: string;
  /**
   * Whether the value is a secret (masked in the Admin UI + never echoed back
   * on read). Base URLs and account emails are not secrets; API tokens are.
   * Non-secret fields are still never logged verbatim.
   */
  readonly secret: boolean;
  /**
   * Whether the field is required for the action to execute. The target is
   * "configured" for a workspace only when every required field resolves.
   * Optional fields (e.g. a default project key) may legitimately be unset.
   */
  readonly required: boolean;
}

/** An action target managed by the workspace credential surface. */
export interface ActionTargetSpec {
  /** Target slug — the `target` key in `workspace_action_credentials`. */
  readonly target: string;
  /** Human label for the Admin UI. */
  readonly label: string;
  /** Settable credential fields, in display order. */
  readonly fields: readonly ActionCredentialField[];
}

/**
 * Jira — the pilot action target (#3766). The three required fields are
 * exactly the globals `lib/tools/actions/jira.ts` used to read directly;
 * keeping the same env-var names is what makes the self-host rung a no-op
 * change for existing operators.
 *
 * `JIRA_DEFAULT_PROJECT` is optional: the agent may pass a project key per
 * call, and the stored default is only consulted when it doesn't.
 *
 * Auth is Basic (email + API token), which is why this is a separate
 * credential from the Jira *query* plugin's OAuth bundle in
 * `integration_credentials` — see ADR-0046 on why the two do not share a row.
 */
const JIRA_TARGET: ActionTargetSpec = {
  target: "jira",
  label: "Jira",
  fields: [
    {
      envVar: "JIRA_BASE_URL",
      label: "Base URL",
      hint: "Your Jira site URL, e.g. https://acme.atlassian.net.",
      secret: false,
      required: true,
    },
    {
      envVar: "JIRA_EMAIL",
      label: "Account Email",
      hint: "Atlassian account email the API token belongs to. Issues are created as this user.",
      secret: false,
      required: true,
    },
    {
      envVar: "JIRA_API_TOKEN",
      label: "API Token",
      hint: "Atlassian API token (id.atlassian.com → Security → API tokens).",
      secret: true,
      required: true,
    },
    {
      envVar: "JIRA_DEFAULT_PROJECT",
      label: "Default Project Key",
      hint: "Optional. Project key (e.g. PROJ) used when the agent doesn't name one.",
      secret: false,
      required: false,
    },
  ],
};

/**
 * Linear — the first target added on the seam rather than with it (#5554).
 *
 * Net-new, not a migration: no Linear action existed before this entry, so
 * unlike Jira there is no pre-existing global whose NAME had to be preserved.
 * `LINEAR_API_KEY` / `LINEAR_DEFAULT_TEAM_KEY` are chosen here and are read by
 * the self-host env rung on those names.
 *
 * ⚠️ These are NOT the Linear *integration* install's credentials. The
 * `createLinearIssue` tool (#2750) dispatches through a workspace's
 * `catalog:linear` OAuth install or `catalog:linear-apikey` form install, both
 * stored against a catalog row with their own lifecycle. This target is the
 * ACTION path — approval-queued, audited, keyed `(workspace_id, "linear")` in
 * `workspace_action_credentials`. ADR-0046 is explicit that the query plugin's
 * bundle and the action's credentials do not share a row; the same split Jira
 * already has, and the reason `linear-tool.ts` is untouched by this entry.
 *
 * Two fields, against Jira's four, because Linear's API needs less: the
 * endpoint is a fixed GraphQL URL (no per-tenant base URL), and the key
 * identifies the actor (no account email). `LINEAR_DEFAULT_TEAM_KEY` is
 * optional for the same reason `JIRA_DEFAULT_PROJECT` is — the agent may name
 * a team per call, and the stored default is consulted only when it doesn't.
 */
const LINEAR_TARGET: ActionTargetSpec = {
  target: "linear",
  label: "Linear",
  fields: [
    {
      envVar: "LINEAR_API_KEY",
      label: "API Key",
      hint: "Linear personal API key (Linear → Settings → Security & access → Personal API keys). Issues are created as this user.",
      secret: true,
      required: true,
    },
    {
      envVar: "LINEAR_DEFAULT_TEAM_KEY",
      label: "Default Team Key",
      hint: "Optional. Team key (e.g. ENG) used when the agent doesn't name one. Without it Linear picks the key owner's default team.",
      secret: false,
      required: false,
    },
  ],
};

/**
 * Every action target managed by the workspace credential surface.
 *
 * Pilot scope (#3766): Jira. Linear joined on the seam (#5554) as exactly what
 * the seam promised — one entry here plus a credential-agnostic action module,
 * with no branch added to the resolver, the store or the Admin route. GitHub
 * App and Salesforce are the remaining children of #3765.
 */
export const ACTION_TARGETS: readonly ActionTargetSpec[] = [JIRA_TARGET, LINEAR_TARGET];

/** Look up a managed action target by slug. `undefined` if unmanaged. */
export function getActionTarget(target: string): ActionTargetSpec | undefined {
  return ACTION_TARGETS.find((t) => t.target === target);
}
