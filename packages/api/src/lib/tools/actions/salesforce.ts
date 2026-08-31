/**
 * SALESFORCE action — create a record (Lead / Case / Task / Contact /
 * Opportunity) over the Salesforce REST API (#5556).
 *
 * Exports:
 * - executeSalesforceCreate(params, credentials) — raw Salesforce API call
 * - createSalesforceRecord — AtlasAction for the agent tool registry
 *
 * CREDENTIALS ARE NOT READ HERE. Like `jira.ts` since #3766, this module is
 * credential-agnostic: the set arrives as an argument, resolved by
 * `credentials/resolver.ts` from the ACTION's workspace (a
 * `workspace_action_credentials` row, or `process.env` on self-hosted only).
 * Salesforce is a one-entry child of that seam — a spec in `ACTION_TARGETS`
 * plus this action — with no per-target branch in the resolver, the store or
 * the Admin route.
 *
 * ── Why client-credentials, and not the workspace's Salesforce OAuth install ─
 *
 * A workspace may already hold a Salesforce OAuth bundle in
 * `integration_credentials` for the `querySalesforce` datasource path
 * (ADR-0014). This action deliberately does NOT reach for it, for the reason
 * ADR-0046 gives for Jira: that bundle is a user-delegated, refresh-driven
 * READ grant against a catalog row, and reading it here would put a second
 * lifecycle on one natural key and let a datasource disconnect silently
 * revoke a write path. The action instead takes its own static, admin-entered
 * server-to-server credential — a Connected App on the OAuth 2.0
 * client-credentials flow, which runs as an explicit integration user the
 * workspace admin picks. Client credentials (not a username + password +
 * security token) keeps ADR-0014's "no long-lived user password in stored
 * config" position intact.
 *
 * ⚠️ The field names are `SALESFORCE_ACTION_*`, NOT the existing
 * `SALESFORCE_CLIENT_ID` / `SALESFORCE_CLIENT_SECRET` / `SALESFORCE_LOGIN_URL`.
 * Those three are the OPERATOR's connected app for the datasource
 * authorization-code dance; they cannot mint a client-credentials token for a
 * tenant's org. Sharing the names would make the self-host env rung report
 * this target "configured" out of credentials that can never create a record.
 *
 * `jsforce` is the in-tree Salesforce client (already a dependency and already
 * in `serverExternalPackages` for the datasource path), reached through the
 * same optional-peer `require` shim `integrations/salesforce/lazy-builder.ts`
 * uses — a second HTTP client for the same vendor would be a second place to
 * get auth wrong.
 *
 * @see ADR-0046 — per-workspace action credentials
 * @see ADR-0014 — why the Salesforce DATASOURCE stays on OAuth
 */

import { tool } from "ai";
import { z } from "zod";
import type { AtlasAction } from "@atlas/api/lib/action-types";
import {
  buildActionRequest,
  handleAction,
  defineActionExecutor,
  type ActionExecutor,
} from "./handler";
import { createLogger } from "@atlas/api/lib/logger";
import { hostForLog } from "@atlas/api/lib/openapi/egress-guard";
import { pinVendorHost } from "@atlas/api/lib/vendor-http";
import { resolveCredentialsFor } from "./credentials/resolver";
import { SALESFORCE_TARGET, type ActionCredentialsOf } from "./credentials/targets";

const log = createLogger("action:salesforce");

// ---------------------------------------------------------------------------
// What the agent may create
// ---------------------------------------------------------------------------

/**
 * The sObjects this action may create.
 *
 * An allowlist, not a passthrough: the agent reaches this tool with
 * model-authored input, and "create any sObject" would put org configuration
 * (`User`, `PermissionSetAssignment`, `ApexClass`, …) one hallucinated string
 * away from an approval card that reads like ordinary work. These five are the
 * business records a data analyst actually files. Widening the list is a
 * deliberate edit here, reviewed on its own.
 */
export const SALESFORCE_ACTION_OBJECTS = [
  "Lead",
  "Case",
  "Task",
  "Contact",
  "Opportunity",
] as const;

export type SalesforceActionObject = (typeof SALESFORCE_ACTION_OBJECTS)[number];

/**
 * Salesforce API names are case-insensitive, so a workspace default stored as
 * `lead` resolves to the canonical `Lead` rather than failing the allowlist.
 * `null` when the name is not on the list.
 */
export function canonicalSalesforceObject(name: string): SalesforceActionObject | null {
  const lowered = name.trim().toLowerCase();
  return SALESFORCE_ACTION_OBJECTS.find((o) => o.toLowerCase() === lowered) ?? null;
}

/**
 * Salesforce field API name — letters, digits and underscores, starting with a
 * letter. Custom fields (`Region__c`) match; relationship paths (`Account.Name`)
 * and anything else deliberately do not. Field names come from the model, and
 * the record body is assembled from them, so they are validated before use
 * rather than trusted — the same discipline `knowledge/salesforce/client.ts`
 * applies to describe metadata.
 */
const SALESFORCE_FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Defensive bound on one record's field count — a real record is far smaller. */
const MAX_RECORD_FIELDS = 50;

/** Field checked, in order, for a human label on the approval card. */
const SUMMARY_FIELDS = ["Subject", "Name", "LastName", "Company", "Title"] as const;

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/**
 * The credential set the Salesforce action executes with — DERIVED from its
 * target spec, so the required/optional split has exactly one author (the
 * registry). Resolution goes through `resolveCredentialsFor(SALESFORCE_TARGET, …)`,
 * whose all-or-nothing guarantee is what makes every required key present.
 */
export type SalesforceCredentials = ActionCredentialsOf<typeof SALESFORCE_TARGET>;

// ---------------------------------------------------------------------------
// Raw Salesforce API call
// ---------------------------------------------------------------------------

export interface SalesforceCreateParams {
  /** sObject to create. Falls back to the workspace's configured default. */
  object?: string;
  /** Field API name → value. Validated here, not trusted. */
  fields: Record<string, string>;
}

export interface SalesforceCreateResult {
  id: string;
  object: SalesforceActionObject;
  url: string;
}

/**
 * jsforce import shim. Mirrors `integrations/salesforce/lazy-builder.ts`:
 * jsforce is an optional peer dep with no types of its own here, so the
 * require is wrapped in a try/catch that throws a clear error if the operator
 * hasn't installed it.
 */
// oxlint-disable-next-line @typescript-eslint/no-explicit-any
function requireJsforce(): any {
  try {
    // oxlint-disable-next-line @typescript-eslint/no-require-imports
    return require("jsforce");
  } catch {
    throw new Error(
      "The Salesforce action requires the jsforce package. Install with: bun add jsforce",
    );
  }
}

/** One `SaveResult` row as Salesforce returns it — every field untrusted. */
interface JsforceSaveResult {
  readonly id?: unknown;
  readonly success?: unknown;
  readonly errors?: unknown;
}

/** The client-credentials token response — only two fields are used. */
interface JsforceTokenResponse {
  readonly access_token?: unknown;
  readonly instance_url?: unknown;
}

/**
 * Replace credential values with a marker anywhere in a message bound for a
 * user, an agent, or `action_log.error`.
 *
 * Salesforce's own error bodies do not echo the consumer secret, so this is
 * belt-and-braces — but the alternative is trusting a vendor's error text with
 * the one value that must never reach a response (CLAUDE.md: no secrets in
 * responses), and an error path is exactly where that trust goes unreviewed.
 */
function redactCredentials(message: string, secrets: readonly string[]): string {
  let out = message;
  for (const secret of secrets) {
    if (secret.length > 0) out = out.split(secret).join("[redacted]");
  }
  return out;
}

/** Normalize an unknown throw into a redacted message. */
function safeMessage(err: unknown, secrets: readonly string[]): string {
  return redactCredentials(err instanceof Error ? err.message : String(err), secrets);
}

/**
 * Salesforce's `SaveResult.errors[]`, flattened to `CODE: message` strings.
 *
 * Redacted like every other vendor text this module surfaces: a refusal body
 * is no more trustworthy than a thrown one, and leaving one path unguarded is
 * how the next editor concludes the file guards nothing.
 */
function describeSaveErrors(errors: unknown, secrets: readonly string[]): string[] {
  if (!Array.isArray(errors)) return [];
  return errors.map((raw) => {
    if (typeof raw === "string") return redactCredentials(raw, secrets);
    const e = raw as { statusCode?: unknown; message?: unknown; fields?: unknown };
    const code = typeof e.statusCode === "string" ? e.statusCode : "ERROR";
    const detail = typeof e.message === "string" ? e.message : "(no message)";
    const fields = Array.isArray(e.fields) && e.fields.length > 0 ? ` [${e.fields.join(", ")}]` : "";
    return redactCredentials(`${code}: ${detail}${fields}`, secrets);
  });
}

/**
 * Validate the record body the agent proposed.
 *
 * Re-validated HERE rather than only in the tool's zod schema, because a
 * manual-approval action executes from the payload persisted in `action_log` —
 * the schema ran at REQUEST time, and what actually reaches Salesforce is
 * whatever round-tripped through the database.
 */
function validateRecordFields(fields: unknown): Record<string, string> {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    throw new Error("Salesforce record fields must be an object of field name → value.");
  }
  const entries = Object.entries(fields as Record<string, unknown>);
  if (entries.length === 0) {
    throw new Error(
      "No Salesforce fields provided — a record needs at least one field (e.g. LastName + Company for a Lead, Subject for a Case).",
    );
  }
  if (entries.length > MAX_RECORD_FIELDS) {
    throw new Error(
      `Too many Salesforce fields (${entries.length}); the limit is ${MAX_RECORD_FIELDS} per record.`,
    );
  }
  const validated: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (!SALESFORCE_FIELD_NAME.test(name)) {
      // The NAME is safe to echo (it is not a credential) and is the only
      // thing that makes this actionable.
      throw new Error(
        `"${name}" is not a valid Salesforce field API name — use letters, digits and underscores, starting with a letter (e.g. Company, Region__c).`,
      );
    }
    if (typeof value !== "string") {
      throw new Error(
        `Salesforce field "${name}" must be a string value; numbers and dates are accepted as their Salesforce string form.`,
      );
    }
    validated[name] = value;
  }
  return validated;
}

/**
 * A Salesforce origin this module is willing to talk to: https, and past the
 * repo's SSRF chokepoint.
 *
 * Both URLs that reach the network here are attacker-influenceable in the
 * threat model the guard exists for. The instance URL is typed by a workspace
 * admin — on SaaS that is a tenant, not the operator — and the consumer secret
 * is POSTed to whatever host it names, so an unguarded value turns a settings
 * form into an outbound probe of the deployment's own network. The token
 * response's `instance_url` is the same problem one hop later: it decides where
 * the record POST goes and what link the approval card shows. `assertBaseUrlAllowed`
 * is the sync chokepoint the form-install handlers use (`isSafeExternalUrl`:
 * scheme, internal-hostname denylist, IP-literal ranges), and the sync one is
 * the right one here — the async `assertSafeEgressTarget` hands back a pin the
 * caller must connect through, which `jsforce` gives us no way to honour.
 *
 * The call shape — parse, require https, guard, normalize, and refuse with
 * copy that is NOT the guard's own wording — is `lib/vendor-http`'s since
 * #5569. This module and `jira.ts` were the two independent derivations of
 * it, and only one of them had it. The Salesforce-shaped copy and the
 * origin-only normalization are what stayed here, as arguments.
 *
 * @param label how to name this URL in the operator-facing error.
 */
function normalizeInstanceUrl(raw: string, label: string): string {
  return pinVendorHost(raw, {
    log,
    label,
    subject: "Salesforce instance URL",
    vendor: "Salesforce",
    shouldBe: "your org's My Domain URL, e.g. https://acme.my.salesforce.com",
  });
}

/**
 * Create one Salesforce record.
 *
 * Auth is the OAuth 2.0 client-credentials flow against the org's My Domain
 * token endpoint — `jsforce`'s `OAuth2.requestToken` takes the grant verbatim
 * and adds the app credentials. The minted access token lives for this one
 * call: there is no refresh lifecycle to store, which is what makes the static
 * credential set the resolver hands over sufficient.
 */
export async function executeSalesforceCreate(
  params: SalesforceCreateParams,
  credentials: SalesforceCredentials,
): Promise<SalesforceCreateResult> {
  const secrets = [credentials.SALESFORCE_ACTION_CLIENT_SECRET];

  const requested = params.object ?? credentials.SALESFORCE_ACTION_DEFAULT_OBJECT;
  if (!requested) {
    // Field NAMES, never values — enough to correlate the failed dispatch in
    // logs without putting record content in them.
    log.error(
      { fields: Object.keys(params.fields ?? {}) },
      "No Salesforce object specified",
    );
    throw new Error(
      "No Salesforce object specified. Name one, or set a default object under Admin → Integrations → Salesforce.",
    );
  }
  const object = canonicalSalesforceObject(requested);
  if (!object) {
    throw new Error(
      `Salesforce object "${requested}" is not one this action may create. Allowed: ${SALESFORCE_ACTION_OBJECTS.join(", ")}.`,
    );
  }

  const fields = validateRecordFields(params.fields);
  const instanceUrl = normalizeInstanceUrl(
    credentials.SALESFORCE_ACTION_INSTANCE_URL,
    "The configured Salesforce instance URL",
  );

  const jsforce = requireJsforce();

  let token: JsforceTokenResponse;
  try {
    const oauth2 = new jsforce.OAuth2({
      loginUrl: instanceUrl,
      clientId: credentials.SALESFORCE_ACTION_CLIENT_ID,
      clientSecret: credentials.SALESFORCE_ACTION_CLIENT_SECRET,
    });
    token = (await oauth2.requestToken({
      grant_type: "client_credentials",
    })) as JsforceTokenResponse;
  } catch (err) {
    const detail = safeMessage(err, secrets);
    log.error({ host: hostForLog(instanceUrl), detail }, "Salesforce client-credentials token request failed");
    throw new Error(
      `Salesforce rejected the connected app's credentials: ${detail}. Check the Consumer Key/Secret and that the app enables the client-credentials flow with a run-as user.`,
    );
  }

  const accessToken = typeof token.access_token === "string" ? token.access_token : "";
  if (accessToken === "") {
    log.error({ host: hostForLog(instanceUrl) }, "Salesforce token response carried no access_token");
    throw new Error(
      "Salesforce returned no access token for the connected app — the client-credentials flow may not be enabled on it.",
    );
  }
  // Salesforce echoes the org's canonical host; fall back to the configured
  // one rather than failing a call that is otherwise authorized. The echo is
  // re-validated rather than trusted: it decides where the record POST goes
  // and what host the approval card links to, so it gets the same guard the
  // configured URL got.
  const sessionUrl =
    typeof token.instance_url === "string" && token.instance_url.length > 0
      ? normalizeInstanceUrl(token.instance_url, "The instance URL Salesforce returned")
      : instanceUrl;

  let saved: JsforceSaveResult;
  try {
    const connection = new jsforce.Connection({ instanceUrl: sessionUrl, accessToken });
    saved = (await connection.sobject(object).create(fields)) as JsforceSaveResult;
  } catch (err) {
    const detail = safeMessage(err, [...secrets, accessToken]);
    log.error(
      { host: hostForLog(sessionUrl), object, detail },
      "Salesforce record creation failed",
    );
    throw new Error(`Salesforce API error: ${detail}`);
  }

  if (saved.success !== true) {
    const detail =
      describeSaveErrors(saved.errors, [...secrets, accessToken]).join("; ") ||
      "no reason given";
    log.error({ object, detail }, "Salesforce refused the record");
    throw new Error(`Salesforce did not create the ${object}: ${detail}`);
  }

  const id = typeof saved.id === "string" ? saved.id : "";
  if (id === "") {
    log.error({ object }, "Salesforce reported success with no record id");
    throw new Error(
      `Salesforce ${object} may have been created but the response carried no record id.`,
    );
  }

  return {
    id,
    object,
    url: `${sessionUrl}/lightning/r/${object}/${encodeURIComponent(id)}/view`,
  };
}

// ---------------------------------------------------------------------------
// Agent tool (AtlasAction)
// ---------------------------------------------------------------------------

/** Human label for the approval card — what is being created, not how many. */
function summarizeRecord(object: string, fields: Record<string, string>): string {
  const labelKey = SUMMARY_FIELDS.find(
    (key) => typeof fields[key] === "string" && fields[key].length > 0,
  );
  const label = labelKey
    ? fields[labelKey]
    : `${Object.keys(fields).length} field(s)`;
  return `Create Salesforce ${object}: ${label}`;
}

const CREATE_SALESFORCE_DESCRIPTION = `### Create Salesforce Record
Use createSalesforceRecord to file a record in Salesforce from the analysis findings:
- Choose the object: ${SALESFORCE_ACTION_OBJECTS.join(", ")}
- Supply Salesforce field API names (e.g. LastName, Company for a Lead; Subject for a Case)
- Include the fields the object requires, or Salesforce will reject the record
- The record will require approval before it is created`;

/**
 * The one place this module's action type is spelled — the `AtlasAction`
 * below, the request it builds, and the executor registration all read it,
 * so the registry key provably matches the rows this module writes (#5570).
 */
const SALESFORCE_CREATE_ACTION_TYPE = "salesforce:create";

/**
 * How `salesforce:create` executes — a pure function of the persisted row's payload and
 * execution context, registered by TYPE at module load so ANY instance can run
 * an approved `salesforce:create` row, including one it never took the request for.
 */
const executeSalesforceCreateAction: ActionExecutor = async (payload, ctx) => {
  // Resolved from the ACTION's workspace, not the approver's — a
  // manual-approval action executes inside the approver's request.
  const credentials = await resolveCredentialsFor(SALESFORCE_TARGET, ctx);
  const result = await executeSalesforceCreate(
    payload as unknown as SalesforceCreateParams,
    credentials,
  );
  return {
    ...result,
    // Best-effort rollback metadata, exactly as `createJiraTicket`
    // records it: whether a delete succeeds depends on the org's sharing
    // rules and the run-as user's permissions, so it is NOT guaranteed.
    rollbackInfo: {
      method: "delete",
      params: { object: result.object, recordId: result.id },
    },
  };
};

defineActionExecutor(SALESFORCE_CREATE_ACTION_TYPE, executeSalesforceCreateAction);

export const createSalesforceRecord: AtlasAction = {
  name: "createSalesforceRecord",
  description: CREATE_SALESFORCE_DESCRIPTION,
  actionType: SALESFORCE_CREATE_ACTION_TYPE,
  reversible: true,
  defaultApproval: "manual",
  // Vestigial (ADR-0046): credentials are per-workspace, so the global-env
  // question this field used to answer has no subject — status lives on the
  // Admin surface (`getActionTargetStatus`). Kept because the published
  // action shape and `isAction` still carry the field.
  requiredCredentials: [],

  tool: tool({
    description:
      "Create a Salesforce record (Lead, Case, Task, Contact or Opportunity). Requires approval before the record is actually created.",
    inputSchema: z.object({
      object: z
        .enum(SALESFORCE_ACTION_OBJECTS)
        .optional()
        .describe(
          "Salesforce object to create. Falls back to the workspace's configured default object.",
        ),
      fields: z
        .record(z.string(), z.string())
        .describe(
          "Field API name → value (e.g. { LastName: 'Reyes', Company: 'Acme' }). Custom fields end in __c.",
        ),
    }),
    execute: async ({ object, fields }) => {
      log.info({ object, fieldCount: Object.keys(fields).length }, "createSalesforceRecord invoked");

      const request = buildActionRequest({
        actionType: SALESFORCE_CREATE_ACTION_TYPE,
        // No env read here: the default object lives in the workspace's
        // credential row and is resolved at EXECUTION time, so a change
        // between request and approval is picked up. When the agent names no
        // object, the approval card says so rather than guessing.
        target: object ?? "(workspace default object)",
        summary: summarizeRecord(object ?? "record", fields),
        payload: { object, fields },
        reversible: true,
      });

      return handleAction(request);
    },
  }),
};
