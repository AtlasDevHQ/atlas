/**
 * Registry of ACTION TARGETS whose credentials are configured per workspace
 * (#3766).
 *
 * This is the REUSABLE SEAM. Adding an action target to the workspace
 * credential surface is a one-entry addition here — the resolver, the store,
 * the Admin route and the health surface all iterate this registry and have
 * no per-target branches. That is what makes the remaining targets one-entry
 * children of #3765 rather than four more design passes — GitHub (#5555),
 * Linear (#5554) and Salesforce (#5556) tested the claim in parallel, none of
 * the three knowing about the others, and each cost exactly one entry here
 * plus its own credential-agnostic action module. The three lanes conflicted
 * only as adjacent additions to this list and to the tool-name copy in
 * `registry.ts`, which is the seam holding rather than failing.
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
 * A field's `envVar` is both the storage key in the encrypted bundle AND the
 * `process.env` key the self-host rung reads, so one field spec reads both
 * rungs with no per-target mapping table. For a target PORTED off globals
 * (Jira) that name is the existing global, which is what makes the self-host
 * rung a no-op change for an existing operator. For a NET-NEW target (GitHub)
 * there is no existing global to keep, and the name is chosen not to collide
 * with an unrelated one — see `GITHUB_TARGET` on why it is not `GITHUB_APP_*`.
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
  /**
   * Whether the value spans several lines, so the Admin form renders a
   * textarea rather than a single-line input. Defaults to false.
   *
   * ── Why this attribute exists (#5555, the GitHub App target) ────────────
   *
   * The GitHub App target was the first entry whose credential is not the
   * flat token-shaped bundle Jira uses: it authenticates with an app id, an
   * installation id and an RSA PRIVATE KEY IN PEM FORM. #5555 asked whether
   * this vocabulary covers that, or whether the spec has to grow a field
   * KIND. It covers it, and the reason is worth keeping:
   *
   *   A PEM is a long string, not a new kind of value. It is still one entry
   *   in the `{ <ENV_VAR>: <value> }` map, so the store's JSON + AES-GCM
   *   round trip, the resolver's all-or-nothing rule, the env rung and the
   *   masking convention all carry it with no change at all.
   *
   * The single thing the vocabulary genuinely could NOT express was that the
   * Admin form must offer a textarea — a `<input type=password>` makes a
   * 1,700-character key unpasteable in practice. That is presentation, so it
   * lands as one more declarative boolean that every consumer reads off the
   * registry, exactly like `secret`.
   *
   * A `kind: "text" | "secret" | "pem"` discriminant was the alternative and
   * was rejected twice over: `secret` already answers "mask this", so a kind
   * would give two ways to say it and invite them to disagree; and a
   * target-named kind is the per-target branch this registry exists to
   * prevent — the next target with an odd credential would add a fourth.
   *
   * What is deliberately NOT here: parsing. Unescaping `\n` and converting a
   * PKCS#1 key to the PKCS#8 the signer wants is protocol detail of ONE
   * target, so it lives in that target's action module (`../github.ts`),
   * never in the spec every target shares.
   */
  readonly multiline?: boolean;
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
 * Salesforce — a record-creation target on a Connected App the TENANT owns
 * (#5556). Net-new: unlike Jira there was no Salesforce ACTION reading
 * globals, so these field names are chosen rather than inherited.
 *
 * ⚠️ `SALESFORCE_ACTION_*`, deliberately NOT the existing `SALESFORCE_CLIENT_ID`
 * / `SALESFORCE_CLIENT_SECRET` / `SALESFORCE_LOGIN_URL`. Those are the
 * OPERATOR's connected app for the datasource OAuth dance (ADR-0014) — a
 * different app, a different grant, and useless for creating a record in a
 * tenant's org. Reusing the names would let the self-host env rung report this
 * target "configured" from credentials the action can never authenticate with,
 * which is the failure mode the all-or-nothing rule exists to prevent, one
 * level up. Exactly the reasoning `GITHUB_ACTION_` follows below, arrived at
 * independently on the sibling target.
 *
 * Auth is the OAuth 2.0 client-credentials flow, so the stored set is static
 * (no refresh lifecycle) and carries no user password — keeping ADR-0014's
 * objection to long-lived stored passwords intact.
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
 * GitHub — a GitHub App the TENANT owns and installs on their own repos
 * (#5555). Net-new: unlike Jira this was never an env-reading action, so no
 * existing global is being preserved.
 *
 * Auth is the App flow, not a personal access token: an RS256 JWT signed with
 * the App's private key is exchanged for a short-lived installation token per
 * call (`lib/github/installation-token.ts`). A PAT would have been the flat
 * token-shaped bundle Jira uses, and was rejected — it is bound to a human,
 * carries that human's full account scope, and dies when they leave.
 *
 * ── Why these names are not `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` ────
 *
 * Those exact env vars are ALREADY read, by the operator-tier GitHub App that
 * backs the `github-data` datasource. Reusing them would make this
 * workspace-tier target's self-host rung read Atlas's OWN app registration —
 * a textual coupling of the two tiers that ADR-0046 keeps structurally apart,
 * and one that would silently arm this target on any self-host box that had
 * only ever configured the datasource App. The `GITHUB_ACTION_` prefix keeps
 * the two sets disjoint by construction.
 *
 * `GITHUB_ACTION_DEFAULT_REPO` is optional: the agent may name a repo per
 * call, and the stored default is only consulted when it doesn't.
 */
const GITHUB_TARGET: ActionTargetSpec = {
  target: "github",
  label: "GitHub",
  fields: [
    {
      envVar: "GITHUB_ACTION_APP_ID",
      label: "App ID",
      hint: "Your GitHub App's numeric App ID (GitHub → Settings → Developer settings → GitHub Apps).",
      secret: false,
      required: true,
    },
    {
      envVar: "GITHUB_ACTION_INSTALLATION_ID",
      label: "Installation ID",
      hint: "The installation of that App on your org or account — the trailing number in the App's 'Configure' URL.",
      secret: false,
      required: true,
    },
    {
      envVar: "GITHUB_ACTION_PRIVATE_KEY",
      label: "Private Key (PEM)",
      hint: "The App's private key, pasted whole including the BEGIN/END lines. Either PKCS#1 (GitHub's download) or PKCS#8.",
      secret: true,
      required: true,
      multiline: true,
    },
    {
      envVar: "GITHUB_ACTION_DEFAULT_REPO",
      label: "Default Repository",
      hint: "Optional. owner/repo (e.g. acme/platform) used when the agent doesn't name one.",
      secret: false,
      required: false,
    },
  ],
};

/**
 * Every action target managed by the workspace credential surface.
 *
 * Pilot scope (#3766): Jira. GitHub (#5555), Linear (#5554) and Salesforce
 * (#5556) then landed independently, each costing exactly what the seam
 * promised — one entry here plus a credential-agnostic action module, with no
 * branch added to the resolver, the store or the Admin route. Three targets
 * arriving in parallel, none of them needing to know about the others, is the
 * strongest evidence the seam holds: all #3765 asked of them was this list and
 * the tool-name copy in `registry.ts`, and that is exactly where they met.
 */
export const ACTION_TARGETS: readonly ActionTargetSpec[] = [
  JIRA_TARGET,
  GITHUB_TARGET,
  LINEAR_TARGET,
  SALESFORCE_TARGET,
];

/** Look up a managed action target by slug. `undefined` if unmanaged. */
export function getActionTarget(target: string): ActionTargetSpec | undefined {
  return ACTION_TARGETS.find((t) => t.target === target);
}
