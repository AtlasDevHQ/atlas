/**
 * Registry of ACTION TARGETS whose credentials are configured per workspace
 * (#3766).
 *
 * This is the REUSABLE SEAM. Adding an action target to the workspace
 * credential surface is a one-entry addition here — the resolver, the store,
 * the Admin route and the health surface all iterate this registry and have
 * no per-target branches. That is what makes the remaining targets (Linear,
 * GitHub App) one-entry children of #3765 rather than more design passes.
 * Salesforce (#5556) was the first to cash that in: a spec below plus
 * `../salesforce.ts`, and nothing else in the seam moved.
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
 * Salesforce — the first one-entry child of the seam (#5556). Net-new: unlike
 * Jira there was no Salesforce ACTION reading globals, so these field names
 * are chosen rather than inherited.
 *
 * ⚠️ `SALESFORCE_ACTION_*`, deliberately NOT the existing `SALESFORCE_CLIENT_ID`
 * / `SALESFORCE_CLIENT_SECRET` / `SALESFORCE_LOGIN_URL`. Those are the
 * OPERATOR's connected app for the datasource OAuth dance (ADR-0014) — a
 * different app, a different grant, and useless for creating a record in a
 * tenant's org. Reusing the names would let the self-host env rung report this
 * target "configured" from credentials the action can never authenticate with,
 * which is the failure mode the all-or-nothing rule exists to prevent, one
 * level up.
 *
 * Auth is the OAuth 2.0 client-credentials flow on a Connected App, so the
 * stored set is static (no refresh lifecycle) and carries no user password —
 * keeping ADR-0014's objection to long-lived stored passwords intact.
 *
 * `SALESFORCE_ACTION_DEFAULT_OBJECT` is optional: the agent may name an object
 * per call, and the stored default is only consulted when it doesn't.
 */
const SALESFORCE_TARGET: ActionTargetSpec = {
  target: "salesforce",
  label: "Salesforce",
  fields: [
    {
      envVar: "SALESFORCE_ACTION_INSTANCE_URL",
      label: "Instance URL",
      hint: "Your org's My Domain URL, e.g. https://acme.my.salesforce.com. Client-credentials tokens are minted here, not at login.salesforce.com.",
      secret: false,
      required: true,
    },
    {
      envVar: "SALESFORCE_ACTION_CLIENT_ID",
      label: "Consumer Key",
      hint: "Connected App consumer key (Setup → App Manager → your app → View). Enable the client-credentials flow and set a run-as user.",
      secret: false,
      required: true,
    },
    {
      envVar: "SALESFORCE_ACTION_CLIENT_SECRET",
      label: "Consumer Secret",
      hint: "Connected App consumer secret. Records are created as the app's run-as user.",
      secret: true,
      required: true,
    },
    {
      envVar: "SALESFORCE_ACTION_DEFAULT_OBJECT",
      label: "Default Object",
      hint: "Optional. Object (Lead, Case, Task, Contact or Opportunity) used when the agent doesn't name one.",
      secret: false,
      required: false,
    },
  ],
};

/**
 * Every action target managed by the workspace credential surface.
 *
 * Pilot (#3766): Jira. Salesforce (#5556) is the first one-entry child —
 * a spec here plus its action; the resolver, store, Admin route and status
 * surface gained nothing. Linear and GitHub App follow the same way, tracked
 * as children of #3765.
 */
export const ACTION_TARGETS: readonly ActionTargetSpec[] = [JIRA_TARGET, SALESFORCE_TARGET];

/** Look up a managed action target by slug. `undefined` if unmanaged. */
export function getActionTarget(target: string): ActionTargetSpec | undefined {
  return ACTION_TARGETS.find((t) => t.target === target);
}
