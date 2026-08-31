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
 * ── Why two hand-rolled `fetch` calls, and not `jsforce` (#5572) ─────────
 *
 * This action drove `jsforce` until #5572 — the datasource path's client,
 * reached through the optional-peer `require` shim — on the reasoning that a
 * second HTTP client for one vendor is a second place to get auth wrong. That
 * held until the bound did not. `jsforce` exposes no `AbortSignal` seam, and
 * on a default deployment `getActionConfig` leaves `timeout` undefined, so
 * `executeWithTimeout(fn, undefined)` returns `fn()` unguarded: a hung
 * Salesforce host held the agent turn open with no bound at all. Salesforce
 * was the one sibling #5567 could not hand the 15-second bound to.
 *
 * Issue 5572 weighed a `Promise.race` deadline against hand-rolling. **The
 * hand-roll is what shipped, and the difference is what gets cancelled.** A
 * race bounds only the agent turn: the underlying request runs on to whatever
 * `jsforce`'s socket does with it, and a write still in flight after we have
 * stopped waiting is the worst thing to be vague about on a record-creating
 * action. The `AbortController` here aborts the in-flight `fetch` itself, and
 * the error names which leg the deadline fired on — because that, not the
 * bound, is what tells an operator whether a record may exist.
 *
 * The cost the old header named is paid down rather than accepted: this is
 * two `fetch` calls against a documented wire format — the client-credentials
 * token POST and one REST create — which is the shape ADR-0045 ratifies, and
 * #5569's `lib/vendor-http` spine supplies every part of it that is not
 * Salesforce-specific. `jsforce` stays a dependency for the DATASOURCE path
 * (`integrations/salesforce/lazy-builder.ts`, `knowledge/salesforce/client.ts`);
 * it is only the action that no longer reaches for it.
 *
 * @see ADR-0045 — hand-rolled vendor HTTP clients, and the `lib/vendor-http` spine
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
import {
  describeHttpFailure,
  isAbortError,
  pinVendorHost,
  withVendorDeadline,
} from "@atlas/api/lib/vendor-http";
import { resolveCredentialsFor } from "./credentials/resolver";
import { SALESFORCE_TARGET, type ActionCredentialsOf } from "./credentials/targets";

const log = createLogger("action:salesforce");

/**
 * Outer budget for the WHOLE exchange — the token mint and the record create
 * share one deadline, the shape `linear.ts` uses for its team lookup + create
 * pair. Two 15-second budgets would let a half-hung org hold the turn for 30
 * (#5572); one signal threaded through both legs cannot outlast the bound
 * between them. 15s matches the jira, github and linear siblings.
 */
const SALESFORCE_TIMEOUT_MS = 15_000;

/**
 * The REST API version the create POST targets, pinned rather than
 * discovered: a version probe would be a third request inside the same
 * budget, and the create payload for these five sObjects has been stable for
 * far longer than this floor. Matches the version the datasource path's
 * paging URLs already carry.
 */
const SALESFORCE_API_VERSION = "v60.0";

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

/** The create response as Salesforce returns it — every field untrusted. */
interface SalesforceSaveResult {
  readonly id?: unknown;
  readonly success?: unknown;
  readonly errors?: unknown;
}

/** The client-credentials token response — only two fields are used. */
interface SalesforceTokenResponse {
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
    const e = raw as {
      errorCode?: unknown;
      statusCode?: unknown;
      message?: unknown;
      fields?: unknown;
    };
    // The single-record sObject endpoint names it `errorCode`; the composite
    // and collections endpoints name the same thing `statusCode`, which is
    // also what `jsforce` surfaced before #5572. Both are read so the copy an
    // operator sees does not depend on which one Salesforce chose.
    const code =
      typeof e.errorCode === "string"
        ? e.errorCode
        : typeof e.statusCode === "string"
          ? e.statusCode
          : "ERROR";
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
 * scheme, internal-hostname denylist, IP-literal ranges), reached through
 * `pinVendorHost`.
 *
 * ⚠️ This module's reason for taking the SYNC guard changed under it in
 * #5572 and is worth stating rather than inheriting. It used to be that the
 * async `assertSafeEgressTarget` hands back a pin the caller must connect
 * through and `jsforce` gave us no way to honour one. Hand-rolling the two
 * `fetch` calls removes that obstacle — this module now could honour a pin.
 * What it takes instead is the spine's shape: `pinVendorHost` is the one call
 * shape all the action clients share, and moving one of them to a different
 * guard is a change to `lib/vendor-http`, not a local edit. Not done here,
 * and not an oversight.
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
 * Salesforce's OAuth error body — `{ error, error_description }` — flattened
 * for the operator-facing refusal. The structured extractor
 * `describeHttpFailure` takes; a body that is not this shape falls through to
 * its bounded text fallback.
 */
function describeTokenError(body: unknown, status: number): string {
  const b = body as { error?: unknown; error_description?: unknown };
  const code = typeof b.error === "string" ? b.error : "";
  const description = typeof b.error_description === "string" ? b.error_description : "";
  return [code, description].filter((part) => part.length > 0).join(": ") || `HTTP ${status}`;
}

/**
 * Mint a client-credentials access token against the org's My Domain token
 * endpoint.
 *
 * The wire format is the same `POST /services/oauth2/token` the datasource
 * install already speaks (`integrations/install/salesforce-oauth-handler.ts`),
 * with `client_credentials` in place of the auth code. The minted token lives
 * for this one exchange: there is no refresh lifecycle to store, which is what
 * makes the static credential set the resolver hands over sufficient — and no
 * module-level cache, per ADR-0045's fourth property.
 *
 * `signal` is the caller's deadline, not this function's: the token mint and
 * the record create share one budget, so a slow mint eats into the create's
 * time rather than granting it a fresh 15 seconds.
 */
async function mintAccessToken(
  instanceUrl: string,
  credentials: SalesforceCredentials,
  secrets: readonly string[],
  signal: AbortSignal,
): Promise<SalesforceTokenResponse> {
  const form = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: credentials.SALESFORCE_ACTION_CLIENT_ID,
    client_secret: credentials.SALESFORCE_ACTION_CLIENT_SECRET,
  });

  let response: Response;
  try {
    response = await fetch(`${instanceUrl}/services/oauth2/token`, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: form.toString(),
    });
  } catch (err) {
    // ⚠️ The deadline's own abort must reach `withVendorDeadline` unchanged.
    // Swallowing it here would re-label every timeout as an unreachable host —
    // the exact distinction acceptance criterion 2 of #5572 asks for.
    if (isAbortError(err)) throw err;
    const detail = safeMessage(err, secrets);
    log.error(
      { host: hostForLog(instanceUrl), detail },
      "Salesforce token endpoint unreachable",
    );
    throw new Error(
      `Could not reach the Salesforce token endpoint: ${detail}. Check the instance URL is your org's My Domain host and that it is reachable.`,
    );
  }

  if (!response.ok) {
    const failure = await describeHttpFailure(response, describeTokenError);
    // Redacted again on the way out: `describeTokenError` reads vendor text,
    // and `describeHttpFailure`'s own text fallback is not redacted at all.
    const detail = redactCredentials(failure.detail, secrets);
    log.error(
      { host: hostForLog(instanceUrl), status: failure.status, detail },
      "Salesforce client-credentials token request failed",
    );
    throw new Error(
      `Salesforce rejected the connected app's credentials: ${detail}. Check the Consumer Key/Secret and that the app enables the client-credentials flow with a run-as user.`,
    );
  }

  try {
    return (await response.json()) as SalesforceTokenResponse;
  } catch (err) {
    // ⚠️ The body is a STREAM, so the deadline can fire here — after the
    // headers arrived and before the body finished. Without this re-throw a
    // hung body reads as "unreadable token response", which is the exact
    // misclassification the bound exists to prevent.
    if (isAbortError(err)) throw err;
    log.error(
      { host: hostForLog(instanceUrl), status: response.status },
      "Salesforce token response was not readable JSON",
    );
    throw new Error(
      "Salesforce returned an unreadable token response for the connected app.",
      { cause: err },
    );
  }
}

/**
 * POST the validated record body to the sObject create endpoint.
 *
 * `object` is interpolated into the path, which is safe because it is not the
 * agent's string: `canonicalSalesforceObject` has already resolved it to one
 * of the five `SALESFORCE_ACTION_OBJECTS` literals. The FIELD names went
 * through `validateRecordFields` and travel in the JSON body, never the path.
 */
async function postRecord(
  sessionUrl: string,
  object: SalesforceActionObject,
  fields: Record<string, string>,
  accessToken: string,
  secrets: readonly string[],
  signal: AbortSignal,
): Promise<SalesforceSaveResult> {
  const url = `${sessionUrl}/services/data/${SALESFORCE_API_VERSION}/sobjects/${object}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(fields),
    });
  } catch (err) {
    if (isAbortError(err)) throw err;
    const detail = safeMessage(err, secrets);
    log.error(
      { host: hostForLog(sessionUrl), object, detail },
      "Salesforce record creation could not be sent",
    );
    throw new Error(`Salesforce API error: ${detail}`);
  }

  if (!response.ok) {
    const failure = await describeHttpFailure(
      response,
      (body, status) => describeSaveErrors(body, secrets).join("; ") || `HTTP ${status}`,
    );
    const detail = redactCredentials(failure.detail, secrets);
    log.error(
      { host: hostForLog(sessionUrl), object, status: failure.status, detail },
      "Salesforce record creation failed",
    );
    throw new Error(`Salesforce API error: ${detail}`);
  }

  try {
    return (await response.json()) as SalesforceSaveResult;
  } catch (err) {
    // ⚠️ Same stream case as the token leg, and worse here: the message below
    // ASSERTS Salesforce accepted the record. On a deadline that fired mid-body
    // that is a claim we cannot make, so the abort goes back to
    // `withVendorDeadline` and comes out as the create-leg timeout instead.
    if (isAbortError(err)) throw err;
    log.error(
      { object, status: response.status },
      "Salesforce create response was not readable JSON",
    );
    throw new Error(
      `Salesforce accepted the ${object} but its response could not be read, so the record id is unknown.`,
      { cause: err },
    );
  }
}

/**
 * Create one Salesforce record.
 *
 * Auth is the OAuth 2.0 client-credentials flow against the org's My Domain
 * token endpoint, then one REST create — two `fetch` calls under ONE
 * {@link SALESFORCE_TIMEOUT_MS} deadline, so the pair cannot hold the agent
 * turn past the bound between them (#5572). See the module header for why
 * this hand-rolls rather than driving `jsforce`.
 */
export async function executeSalesforceCreate(
  params: SalesforceCreateParams,
  credentials: SalesforceCredentials,
): Promise<SalesforceCreateResult> {
  // The Consumer Key is not a secret the way the Consumer Secret is, but
  // Salesforce's `invalid_client` description commonly echoes it back and it
  // is not ours to put in an agent-visible string either.
  const secrets = [
    credentials.SALESFORCE_ACTION_CLIENT_SECRET,
    credentials.SALESFORCE_ACTION_CLIENT_ID,
  ];

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

  /**
   * Which leg the deadline could fire on. This is the whole reason the bound
   * is worth having on a WRITE: a timeout during the token mint provably
   * created nothing, while one during the create POST is genuinely unknown —
   * aborting our request says nothing about whether Salesforce had already
   * committed the record. Telling an operator which of those happened is the
   * difference between "retry" and "go look first".
   */
  let reachedCreate = false;

  const exchange = await withVendorDeadline(SALESFORCE_TIMEOUT_MS, async (signal) => {
    const token = await mintAccessToken(instanceUrl, credentials, secrets, signal);

    const accessToken = typeof token.access_token === "string" ? token.access_token : "";
    if (accessToken === "") {
      log.error(
        { host: hostForLog(instanceUrl) },
        "Salesforce token response carried no access_token",
      );
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

    // The minted token joins the redaction set for the create leg: it is a
    // credential derivative, and Salesforce's session errors quote it back.
    const createSecrets = [...secrets, accessToken];

    reachedCreate = true;
    const saved = await postRecord(
      sessionUrl,
      object,
      fields,
      accessToken,
      createSecrets,
      signal,
    );
    return { sessionUrl, createSecrets, saved };
  });

  if (!exchange.ok) {
    const seconds = SALESFORCE_TIMEOUT_MS / 1000;
    log.error(
      {
        host: hostForLog(instanceUrl),
        object,
        timeoutMs: SALESFORCE_TIMEOUT_MS,
        leg: reachedCreate ? "create" : "token",
      },
      "Salesforce request timed out",
    );
    throw new Error(
      reachedCreate
        ? `Salesforce did not respond within ${seconds}s and the request was cancelled. The ${object} may or may not have been created — check the org before retrying.`
        : `Salesforce did not respond within ${seconds}s while authenticating. No ${object} was created — check the org is reachable and retry.`,
    );
  }

  const { sessionUrl, createSecrets, saved } = exchange.value;

  // Belt-and-braces: the single-record endpoint signals a refusal with a
  // non-2xx, which `postRecord` already threw on. A 2xx body that still says
  // `success: false` is not a shape Salesforce documents, and reporting it as
  // a success would be the one unrecoverable way to be wrong here.
  if (saved.success !== true) {
    const detail = describeSaveErrors(saved.errors, createSecrets).join("; ") || "no reason given";
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
