/**
 * Salesforce action tests (#5556).
 *
 * Two things are pinned here that a generic seam test cannot pin for this
 * target:
 *   1. The action is CREDENTIAL-AGNOSTIC — it reads no `SALESFORCE_*` env var,
 *      including the operator's datasource connected-app pair, which shares a
 *      prefix and would be the easy mistake.
 *   2. The all-or-nothing rung rule holds FOR THIS TARGET: a partial workspace
 *      row throws and is never back-filled from env (ADR-0046).
 */

import { describe, it, expect, beforeEach, afterEach, mock, type Mock } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — handler (no DB/auth), logger, credential store, the Salesforce wire
// ---------------------------------------------------------------------------

let lastHandleActionCall: { request: unknown } | null = null;
/**
 * What the module registered at load, by action type (#5570).
 *
 * `handleAction` no longer takes an executor — the module declares one for its
 * TYPE when it is imported, so this map is where that call lands under the
 * mock. Capturing it is not optional bookkeeping: the top-level
 * `defineActionExecutor` call runs at import, so a mock without this key makes
 * the module under test throw before a single test runs.
 */
const registeredExecutors = new Map<string, unknown>();

void mock.module("@atlas/api/lib/tools/actions/handler", () => ({
  buildActionRequest: (params: Record<string, unknown>) => ({
    id: "test-action-id",
    ...params,
  }),
  handleAction: async (request: unknown) => {
    lastHandleActionCall = { request };
    return { status: "pending", actionId: "test-action-id", summary: "test" };
  },
  defineActionExecutor: (actionType: string, executor: unknown) => {
    registeredExecutors.set(actionType, executor);
  },
}));

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

/**
 * The resolver reads the workspace rung through this store, so mocking it is
 * how a target-specific rung test drives the ladder without a database.
 */
const mockRead: Mock<
  (workspaceId: string, target: string) => Promise<Record<string, string> | null>
> = mock(() => Promise.resolve(null));
void mock.module("@atlas/api/lib/tools/actions/credentials/store", () => ({
  readActionCredentials: mockRead,
}));
void mock.module("@atlas/api/lib/db/internal", () => ({ hasInternalDB: () => true }));

// The Salesforce wire, mocked at `fetch`, so no test touches a real org.
//
// #5572 replaced `jsforce` on the ACTION path with two hand-rolled calls, so
// what a test drives here is the token POST and the create POST — the wire
// itself — rather than an SDK's method names. That is a strictly better thing
// to pin: `lastCreateRequest.accessToken` is the header Salesforce would
// actually receive, where the old `lastConnectionArgs` was an SDK argument we
// trusted jsforce to turn into one.

interface TokenRequestCapture {
  loginUrl: string;
  clientId: string;
  clientSecret: string;
  grantType: string;
}

interface CreateRequestCapture {
  instanceUrl: string;
  apiVersion: string;
  object: string;
  accessToken: string;
  fields: Record<string, unknown>;
}

let lastTokenRequest: TokenRequestCapture | null = null;
let lastCreateRequest: CreateRequestCapture | null = null;

/**
 * Every `AbortSignal` handed to `fetch`, in order.
 *
 * The point of the list is identity, not length: ONE budget across the token
 * mint and the create means both legs get the SAME signal object. Two signals
 * would mean two 15-second budgets and a 30-second worst case — the thing
 * `SALESFORCE_TIMEOUT_MS`'s header says it is not.
 */
let seenSignals: Array<AbortSignal | undefined> = [];

let tokenStatus = 200;
let tokenBody: unknown = {
  access_token: "sf-access-token",
  instance_url: "https://tenant.my.salesforce.com",
};
/** Set to make the token leg reject at the transport, e.g. with an abort. */
let tokenThrows: (() => never) | null = null;
/** Set to make the token leg's HEADERS arrive but its body abort mid-stream. */
let tokenBodyAborts = false;

let createStatus = 201;
let createBody: unknown = { id: "00Q000000000001AAA", success: true, errors: [] };
/** Set to make the create leg reject at the transport, e.g. with an abort. */
let createThrows: (() => never) | null = null;
/** Set to make the create leg's HEADERS arrive but its body abort mid-stream. */
let createBodyAborts = false;

function jsonResponse(body: unknown, status: number): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * A response whose HEADERS arrived but whose body never finishes — the shape a
 * deadline actually hits on a half-hung host.
 *
 * `fetch` resolving is not the end of the exchange: the body is a stream, and
 * `response.json()` is a second place the abort can land. A mock that only
 * rejects at the `fetch` call cannot reach that path at all.
 */
function abortingBodyResponse(status: number): Response {
  const stream = new ReadableStream<Uint8Array>({
    pull() {
      return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
    },
  });
  return new Response(stream, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const CREATE_URL =
  /^(?<instance>https:\/\/[^/]+)\/services\/data\/(?<version>v[\d.]+)\/sobjects\/(?<object>\w+)$/;

const realFetch = globalThis.fetch;

function installFetchMock(): void {
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    // Narrowed rather than `String(input)`: `Request` has no useful
    // `toString`, so the loose form is a `no-base-to-string` warning AND would
    // silently yield "[object Request]" if a caller ever passed one.
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    seenSignals.push(init?.signal ?? undefined);

    // Both legs send a string body; anything else is a test bug, not a case to
    // coerce past.
    const body = typeof init?.body === "string" ? init.body : "";

    if (url.endsWith("/services/oauth2/token")) {
      if (tokenThrows) tokenThrows();
      if (tokenBodyAborts) return abortingBodyResponse(tokenStatus);
      const form = new URLSearchParams(body);
      lastTokenRequest = {
        loginUrl: url.slice(0, -"/services/oauth2/token".length),
        clientId: form.get("client_id") ?? "",
        clientSecret: form.get("client_secret") ?? "",
        grantType: form.get("grant_type") ?? "",
      };
      return jsonResponse(tokenBody, tokenStatus);
    }

    const create = CREATE_URL.exec(url);
    if (create?.groups) {
      if (createThrows) createThrows();
      if (createBodyAborts) return abortingBodyResponse(createStatus);
      const headers = new Headers(init?.headers);
      lastCreateRequest = {
        instanceUrl: create.groups.instance ?? "",
        apiVersion: create.groups.version ?? "",
        object: create.groups.object ?? "",
        accessToken: (headers.get("Authorization") ?? "").replace(/^Bearer /, ""),
        fields: JSON.parse(body || "{}") as Record<string, unknown>,
      };
      return jsonResponse(createBody, createStatus);
    }

    // A URL neither leg recognises is a test bug, not a vendor condition —
    // fail loudly rather than returning a plausible 200.
    throw new Error(`Unexpected fetch in test: ${url}`);
  }) as typeof globalThis.fetch;
}

/** The abort a deadline produces: a DOMException, which is why the module duck-types it. */
function abortRejection(): never {
  throw new DOMException("The operation was aborted.", "AbortError");
}

const {
  executeSalesforceCreate,
  createSalesforceRecord,
  canonicalSalesforceObject,
  SALESFORCE_ACTION_OBJECTS,
} = await import("@atlas/api/lib/tools/actions/salesforce");
const { resolveCredentialsFor } = await import(
  "@atlas/api/lib/tools/actions/credentials/resolver"
);
const { SALESFORCE_TARGET } = await import(
  "@atlas/api/lib/tools/actions/credentials/targets"
);

/** A complete tenant-owned credential set, built directly (never from env). */
function creds(overrides: Record<string, string | undefined> = {}) {
  return {
    SALESFORCE_ACTION_INSTANCE_URL: "https://tenant.my.salesforce.com",
    SALESFORCE_ACTION_CLIENT_ID: "tenant-consumer-key",
    SALESFORCE_ACTION_CLIENT_SECRET: "tenant-consumer-secret",
    ...overrides,
  } as Parameters<typeof executeSalesforceCreate>[1];
}

const ENV_KEYS = [
  "SALESFORCE_ACTION_INSTANCE_URL",
  "SALESFORCE_ACTION_CLIENT_ID",
  "SALESFORCE_ACTION_CLIENT_SECRET",
  "SALESFORCE_ACTION_DEFAULT_OBJECT",
  "SALESFORCE_CLIENT_ID",
  "SALESFORCE_CLIENT_SECRET",
  "SALESFORCE_LOGIN_URL",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  lastHandleActionCall = null;
  lastTokenRequest = null;
  lastCreateRequest = null;
  seenSignals = [];
  tokenThrows = null;
  createThrows = null;
  tokenBodyAborts = false;
  createBodyAborts = false;
  tokenStatus = 200;
  tokenBody = {
    access_token: "sf-access-token",
    instance_url: "https://tenant.my.salesforce.com",
  };
  createStatus = 201;
  createBody = { id: "00Q000000000001AAA", success: true, errors: [] };
  installFetchMock();
  mockRead.mockReset();
  mockRead.mockResolvedValue(null);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] !== undefined) process.env[key] = saved[key];
    else delete process.env[key];
  }
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------
// AtlasAction metadata — parity with createJiraTicket
// ---------------------------------------------------------------------------

describe("createSalesforceRecord — metadata", () => {
  it("has the actionType the startup high-risk check already names", () => {
    expect(createSalesforceRecord.actionType).toBe("salesforce:create");
  });

  it("is reversible", () => {
    expect(createSalesforceRecord.reversible).toBe(true);
  });

  it("defaults to manual approval", () => {
    expect(createSalesforceRecord.defaultApproval).toBe("manual");
  });

  it("declares no global required credentials (they are per-workspace)", () => {
    // `validateActionCredentials()` checks this list against the GLOBAL
    // process.env, which has no meaningful answer for a per-workspace target.
    expect(createSalesforceRecord.requiredCredentials).toEqual([]);
  });

  it("has a name and a description", () => {
    expect(createSalesforceRecord.name).toBe("createSalesforceRecord");
    expect(createSalesforceRecord.description).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Object allowlist
// ---------------------------------------------------------------------------

describe("canonicalSalesforceObject", () => {
  it("accepts the allowlisted objects case-insensitively", () => {
    expect(canonicalSalesforceObject("lead")).toBe("Lead");
    expect(canonicalSalesforceObject("  CASE ")).toBe("Case");
    expect(canonicalSalesforceObject("Opportunity")).toBe("Opportunity");
  });

  it("rejects org-configuration objects", () => {
    // The reason the allowlist exists: model-authored input must not be able
    // to reach `User` or `PermissionSetAssignment`.
    expect(canonicalSalesforceObject("User")).toBeNull();
    expect(canonicalSalesforceObject("PermissionSetAssignment")).toBeNull();
    expect(canonicalSalesforceObject("Account__c")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// executeSalesforceCreate — the raw API call
// ---------------------------------------------------------------------------

describe("executeSalesforceCreate", () => {
  it("mints a client-credentials token against the org's My Domain host and creates the record", async () => {
    const result = await executeSalesforceCreate(
      { object: "Lead", fields: { LastName: "Reyes", Company: "Acme" } },
      creds(),
    );

    expect(lastTokenRequest).toEqual({
      loginUrl: "https://tenant.my.salesforce.com",
      clientId: "tenant-consumer-key",
      clientSecret: "tenant-consumer-secret",
      grantType: "client_credentials",
    });
    expect(lastCreateRequest).toEqual({
      instanceUrl: "https://tenant.my.salesforce.com",
      apiVersion: "v60.0",
      object: "Lead",
      // The bearer header Salesforce actually receives, not an SDK argument.
      accessToken: "sf-access-token",
      fields: { LastName: "Reyes", Company: "Acme" },
    });
    expect(result.id).toBe("00Q000000000001AAA");
    expect(result.object).toBe("Lead");
    expect(result.url).toBe(
      "https://tenant.my.salesforce.com/lightning/r/Lead/00Q000000000001AAA/view",
    );
  });

  it("reads no SALESFORCE_* env var, even when every one of them is set", async () => {
    // The regression this action is built to avoid: a tenant's record must
    // never be filed against the deployment's globals — and the operator's
    // DATASOURCE connected app shares the vendor prefix, so it is the
    // easiest wrong value to pick up.
    process.env.SALESFORCE_ACTION_INSTANCE_URL = "https://operator.my.salesforce.com";
    process.env.SALESFORCE_ACTION_CLIENT_ID = "operator-key";
    process.env.SALESFORCE_ACTION_CLIENT_SECRET = "operator-secret";
    process.env.SALESFORCE_ACTION_DEFAULT_OBJECT = "Case";
    process.env.SALESFORCE_CLIENT_ID = "datasource-key";
    process.env.SALESFORCE_CLIENT_SECRET = "datasource-secret";
    process.env.SALESFORCE_LOGIN_URL = "https://login.salesforce.com";

    await executeSalesforceCreate({ fields: { LastName: "Reyes", Company: "Acme" } }, creds({
      SALESFORCE_ACTION_DEFAULT_OBJECT: "Lead",
    }));

    expect(lastTokenRequest?.loginUrl).toBe("https://tenant.my.salesforce.com");
    expect(lastTokenRequest?.clientId).toBe("tenant-consumer-key");
    expect(lastTokenRequest?.clientSecret).toBe("tenant-consumer-secret");
    expect(lastCreateRequest?.object).toBe("Lead");
  });

  it("falls back to the credential set's default object when the agent names none", async () => {
    await executeSalesforceCreate(
      { fields: { Subject: "Churn risk" } },
      creds({ SALESFORCE_ACTION_DEFAULT_OBJECT: "case" }),
    );
    expect(lastCreateRequest?.object).toBe("Case");
  });

  it("throws when no object is named and the credential set carries no default", async () => {
    await expect(
      executeSalesforceCreate({ fields: { Subject: "x" } }, creds()),
    ).rejects.toThrow("No Salesforce object specified");
  });

  it("refuses an object outside the allowlist, naming what is allowed", async () => {
    await expect(
      executeSalesforceCreate({ object: "User", fields: { Username: "x" } }, creds()),
    ).rejects.toThrow(/not one this action may create/);
    expect(lastCreateRequest).toBeNull();
  });

  it("rejects a field name that is not a Salesforce API name", async () => {
    // Re-validated at EXECUTION time, not only in the tool's zod schema: a
    // manual-approval action executes from the payload persisted in
    // `action_log`, which is what actually reaches Salesforce.
    await expect(
      executeSalesforceCreate(
        { object: "Lead", fields: { "Account.Name": "Acme" } },
        creds(),
      ),
    ).rejects.toThrow(/not a valid Salesforce field API name/);
    expect(lastCreateRequest).toBeNull();
  });

  it("rejects an empty field set", async () => {
    await expect(
      executeSalesforceCreate({ object: "Lead", fields: {} }, creds()),
    ).rejects.toThrow(/at least one field/);
  });

  it("rejects a non-https instance URL before any network call", async () => {
    await expect(
      executeSalesforceCreate(
        { object: "Lead", fields: { LastName: "Reyes" } },
        creds({ SALESFORCE_ACTION_INSTANCE_URL: "http://tenant.my.salesforce.com" }),
      ),
    ).rejects.toThrow(/must use https/);
    expect(lastTokenRequest).toBeNull();
  });

  it("refuses an internal instance URL before the consumer secret leaves the process", async () => {
    // The instance URL is typed by a WORKSPACE admin — a tenant on SaaS, not
    // the operator — and the consumer secret is POSTed to whatever host it
    // names. Unguarded, that turns a settings form into an outbound probe of
    // the deployment's own network.
    for (const host of ["https://localhost", "https://127.0.0.1", "https://169.254.169.254"]) {
      await expect(
        executeSalesforceCreate(
          { object: "Lead", fields: { LastName: "Reyes" } },
          creds({ SALESFORCE_ACTION_INSTANCE_URL: host }),
        ),
      ).rejects.toThrow(/reachable public Salesforce host/);
    }
    // Never reached the network, and the refusal names no internal detail —
    // repeating the guard's verdict back would make the form a scanner with a
    // readout.
    expect(lastTokenRequest).toBeNull();
    expect(seenSignals).toEqual([]);
  });

  it("re-validates the instance URL Salesforce echoes back", async () => {
    // The echo decides where the record POST goes and what host the approval
    // card links to, so it gets the same guard the configured URL got.
    tokenBody = {
      access_token: "sf-access-token",
      instance_url: "http://169.254.169.254",
    };
    await expect(
      executeSalesforceCreate({ object: "Lead", fields: { LastName: "Reyes" } }, creds()),
    ).rejects.toThrow(/Salesforce returned/);
    expect(lastCreateRequest).toBeNull();
  });

  it("surfaces a token rejection without echoing the consumer secret", async () => {
    // Salesforce does not normally echo the secret; the redaction is the
    // belt-and-braces that keeps an unreviewed vendor error path from
    // becoming the one place a secret reaches a response.
    tokenStatus = 400;
    tokenBody = {
      error: "invalid_client",
      error_description: "bad secret tenant-consumer-secret for this app",
    };
    try {
      await executeSalesforceCreate(
        { object: "Lead", fields: { LastName: "Reyes" } },
        creds(),
      );
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("invalid_client");
      expect(message).not.toContain("tenant-consumer-secret");
      // Salesforce's `invalid_client` description commonly echoes the key back.
      expect(message).not.toContain("tenant-consumer-key");
      expect(message).toContain("[redacted]");
    }
  });

  it("surfaces an API failure without echoing the access token", async () => {
    createStatus = 401;
    createBody = [
      { errorCode: "INVALID_SESSION_ID", message: "Session sf-access-token is invalid" },
    ];
    try {
      await executeSalesforceCreate(
        { object: "Lead", fields: { LastName: "Reyes" } },
        creds(),
      );
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("Salesforce API error");
      expect(message).not.toContain("sf-access-token");
    }
  });

  it("throws with Salesforce's own reason when the save is refused", async () => {
    // The REST create endpoint refuses with a non-2xx whose body is an ARRAY
    // of `{ errorCode, message, fields }` — where `jsforce` surfaced a 200
    // `SaveResult` carrying `statusCode`. `describeSaveErrors` reads both keys
    // so this copy did not change when #5572 changed the wire under it.
    createStatus = 400;
    createBody = [
      {
        errorCode: "REQUIRED_FIELD_MISSING",
        message: "Required fields are missing: [Company]",
        fields: ["Company"],
      },
    ];
    await expect(
      executeSalesforceCreate({ object: "Lead", fields: { LastName: "Reyes" } }, creds()),
    ).rejects.toThrow(/REQUIRED_FIELD_MISSING: Required fields are missing/);
  });

  it("redacts credentials out of a REFUSAL body too, not just a thrown error", async () => {
    // A refusal body is no more trustworthy than a thrown one; leaving this
    // path unguarded is how a file ends up guarding only the paths someone
    // happened to think about.
    createStatus = 403;
    createBody = [
      {
        errorCode: "INSUFFICIENT_ACCESS",
        message: "App tenant-consumer-secret cannot create this record",
      },
      "raw string error mentioning sf-access-token",
    ];
    try {
      await executeSalesforceCreate(
        { object: "Lead", fields: { LastName: "Reyes" } },
        creds(),
      );
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("INSUFFICIENT_ACCESS");
      expect(message).not.toContain("tenant-consumer-secret");
      expect(message).not.toContain("sf-access-token");
    }
  });

  it("throws when the token response carries no access token", async () => {
    tokenBody = { instance_url: "https://tenant.my.salesforce.com" };
    await expect(
      executeSalesforceCreate({ object: "Lead", fields: { LastName: "Reyes" } }, creds()),
    ).rejects.toThrow(/no access token/);
  });

  it("refuses a 2xx body that still says success: false", async () => {
    // Not a shape Salesforce documents — the single-record endpoint signals a
    // refusal with a non-2xx. It is kept because reporting it as a success is
    // the one unrecoverable way to be wrong here, and an untested guard is
    // indistinguishable from a missing one.
    createStatus = 200;
    createBody = {
      success: false,
      errors: [{ errorCode: "UNKNOWN_EXCEPTION", message: "something went sideways" }],
    };
    await expect(
      executeSalesforceCreate({ object: "Lead", fields: { LastName: "Reyes" } }, creds()),
    ).rejects.toThrow(/did not create the Lead: UNKNOWN_EXCEPTION/);
  });

  it("throws when a successful save carries no record id", async () => {
    createBody = { success: true, errors: [] };
    await expect(
      executeSalesforceCreate({ object: "Lead", fields: { LastName: "Reyes" } }, creds()),
    ).rejects.toThrow(/carried no record id/);
  });

  it("prefers the org's echoed instance_url for the session and the record link", async () => {
    tokenBody = {
      access_token: "sf-access-token",
      instance_url: "https://tenant--sandbox.sandbox.my.salesforce.com/",
    };
    const result = await executeSalesforceCreate(
      { object: "Case", fields: { Subject: "Churn risk" } },
      creds(),
    );
    expect(lastCreateRequest?.instanceUrl).toBe(
      "https://tenant--sandbox.sandbox.my.salesforce.com",
    );
    expect(result.url).toBe(
      "https://tenant--sandbox.sandbox.my.salesforce.com/lightning/r/Case/00Q000000000001AAA/view",
    );
  });

  it("strips a trailing slash from the configured instance URL", async () => {
    await executeSalesforceCreate(
      { object: "Lead", fields: { LastName: "Reyes" } },
      creds({ SALESFORCE_ACTION_INSTANCE_URL: "https://tenant.my.salesforce.com/" }),
    );
    expect(lastTokenRequest?.loginUrl).toBe("https://tenant.my.salesforce.com");
  });

});

// ---------------------------------------------------------------------------
// The bound (#5572) — the half of the defence pair Salesforce could not have
// while it drove jsforce
// ---------------------------------------------------------------------------

describe("executeSalesforceCreate — the 15s bound", () => {
  // Every case here pins the bound WITHOUT waiting it out: the runtime's
  // abort rejection is injected directly, exactly as the jira suite does it.
  // A test that actually slept 15 seconds would be the slowest suite in the
  // package and would still only prove `setTimeout` works.

  it("⭐ threads ONE budget through the token mint and the create", async () => {
    // The property the copy in `SALESFORCE_TIMEOUT_MS` claims. Two controllers
    // would be two 15-second budgets and a 30-second worst case on a
    // half-hung org — which is not "a fixed bound", and is invisible to any
    // test that only checks each leg times out.
    await executeSalesforceCreate(
      { object: "Lead", fields: { LastName: "Reyes", Company: "Acme" } },
      creds(),
    );

    expect(seenSignals).toHaveLength(2);
    expect(seenSignals[0]).toBeInstanceOf(AbortSignal);
    // Identity, not equality: the SAME controller's signal reached both legs.
    expect(seenSignals[1]).toBe(seenSignals[0]);
  });

  it("⭐ classifies a timeout on the token leg as a timeout, and says no record exists", async () => {
    // Before #5572 there was no bound at all on this path: jsforce exposes no
    // AbortSignal, and `executeWithTimeout(fn, undefined)` is unguarded on a
    // default deployment, so a hung org held the agent turn open indefinitely.
    tokenThrows = abortRejection;

    try {
      await executeSalesforceCreate(
        { object: "Lead", fields: { LastName: "Reyes" } },
        creds(),
      );
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      const message = (err as Error).message;
      // Distinct from an upstream failure: not "rejected the credentials".
      expect(message).toMatch(/did not respond within 15s while authenticating/);
      expect(message).not.toMatch(/rejected the connected app/);
      // A timeout before the token was minted provably created nothing.
      expect(message).toMatch(/No Lead was created/);
    }
  });

  it("⭐ says the record MAY exist when the deadline fires on the create leg", async () => {
    // The distinction the leg tracking exists for. Aborting our own request
    // says nothing about whether Salesforce had already committed the record,
    // and on a write that is the difference between "retry" and "go look".
    createThrows = abortRejection;

    try {
      await executeSalesforceCreate(
        { object: "Case", fields: { Subject: "Churn risk" } },
        creds(),
      );
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toMatch(/did not respond within 15s/);
      expect(message).toMatch(/may or may not have been created/);
      // And it must NOT claim the create was safe — the token-leg copy would
      // be an outright false statement here.
      expect(message).not.toMatch(/No Case was created/);
    }
  });

  it("the timeout copy names no credential and no host", async () => {
    // Same copy discipline as jira/github: a timeout reaches the model's
    // context, the approval card and `action_log.error`.
    const messages: string[] = [];
    for (const leg of ["token", "create"] as const) {
      tokenThrows = leg === "token" ? abortRejection : null;
      createThrows = leg === "create" ? abortRejection : null;
      try {
        await executeSalesforceCreate(
          { object: "Lead", fields: { LastName: "Reyes" } },
          creds(),
        );
        expect(true).toBe(false); // should not reach here
      } catch (err) {
        messages.push((err as Error).message);
      }
    }

    expect(messages).toHaveLength(2);
    for (const message of messages) {
      expect(message).not.toContain("tenant-consumer-secret");
      expect(message).not.toContain("tenant-consumer-key");
      expect(message).not.toContain("sf-access-token");
      expect(message).not.toContain("tenant.my.salesforce.com");
    }
  });

  it("⭐ a deadline that fires during the token BODY is still a timeout", async () => {
    // `fetch` resolving is not the end of the exchange. The headers can arrive
    // and the body hang, and `response.json()` is where the abort then lands —
    // a `catch` there that does not re-throw turns the timeout into
    // "unreadable token response", which is not a timeout classification at all.
    tokenBodyAborts = true;

    await expect(
      executeSalesforceCreate({ object: "Lead", fields: { LastName: "Reyes" } }, creds()),
    ).rejects.toThrow(/did not respond within 15s while authenticating/);
  });

  it("⭐ a deadline during the create BODY does not claim the record was accepted", async () => {
    // The worst misclassification available on this path: the create-leg parse
    // failure message ASSERTS Salesforce accepted the record, and a deadline
    // that fired mid-body is not evidence of that.
    createBodyAborts = true;

    try {
      await executeSalesforceCreate(
        { object: "Lead", fields: { LastName: "Reyes" } },
        creds(),
      );
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toMatch(/may or may not have been created/);
      expect(message).not.toMatch(/accepted the Lead/);
    }
  });

  it("an unreachable host is NOT reported as a timeout", async () => {
    // The other side of the classification: a transport failure that is not
    // an abort must keep its own actionable copy. The module's `isAbortError`
    // re-throw is what keeps these two apart, and dropping it would make
    // every DNS failure read as a 15-second hang.
    tokenThrows = () => {
      throw new TypeError("fetch failed");
    };

    await expect(
      executeSalesforceCreate({ object: "Lead", fields: { LastName: "Reyes" } }, creds()),
    ).rejects.toThrow(/Could not reach the Salesforce token endpoint/);
  });
});

// ---------------------------------------------------------------------------
// All-or-nothing per rung, for THIS target (ADR-0046)
// ---------------------------------------------------------------------------

describe("resolveCredentialsFor(SALESFORCE_TARGET) — all-or-nothing per rung", () => {
  it("a complete workspace row wins and the operator env is ignored", async () => {
    process.env.SALESFORCE_ACTION_INSTANCE_URL = "https://operator.my.salesforce.com";
    process.env.SALESFORCE_ACTION_CLIENT_ID = "operator-key";
    process.env.SALESFORCE_ACTION_CLIENT_SECRET = "operator-secret";
    mockRead.mockResolvedValue({
      SALESFORCE_ACTION_INSTANCE_URL: "https://tenant.my.salesforce.com",
      SALESFORCE_ACTION_CLIENT_ID: "tenant-consumer-key",
      SALESFORCE_ACTION_CLIENT_SECRET: "tenant-consumer-secret",
    });

    const resolved = await resolveCredentialsFor(SALESFORCE_TARGET, { workspaceId: "ws-1" }, { deployMode: "self-hosted" });

    expect(resolved.SALESFORCE_ACTION_CLIENT_ID).toBe("tenant-consumer-key");
    expect(resolved.SALESFORCE_ACTION_CLIENT_SECRET).toBe("tenant-consumer-secret");
    expect(mockRead).toHaveBeenCalledWith("ws-1", "salesforce");
  });

  it("a PARTIAL workspace row throws and is never back-filled from env", async () => {
    // The leak this rule exists to stop, one target over from Jira's: the
    // tenant's org URL plus ATLAS'S consumer secret would file the record
    // against the tenant's Salesforce using the operator's app — or, with the
    // URL blank instead, file the tenant's record in the operator's org.
    process.env.SALESFORCE_ACTION_INSTANCE_URL = "https://operator.my.salesforce.com";
    process.env.SALESFORCE_ACTION_CLIENT_ID = "operator-key";
    process.env.SALESFORCE_ACTION_CLIENT_SECRET = "operator-secret";
    mockRead.mockResolvedValue({
      SALESFORCE_ACTION_INSTANCE_URL: "https://tenant.my.salesforce.com",
      SALESFORCE_ACTION_CLIENT_ID: "tenant-consumer-key",
      // SALESFORCE_ACTION_CLIENT_SECRET deliberately absent.
    });

    try {
      await resolveCredentialsFor(SALESFORCE_TARGET, { workspaceId: "ws-1" }, { deployMode: "self-hosted" });
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("SALESFORCE_ACTION_CLIENT_SECRET");
      expect((err as { reason?: string }).reason).toBe("partial-workspace-row");
      // Never a value, tenant's or operator's.
      expect(message).not.toContain("operator-secret");
      expect(message).not.toContain("tenant-consumer-key");
    }
  });

  it("an empty-string secret in the row counts as absent, not as a credential", async () => {
    mockRead.mockResolvedValue({
      SALESFORCE_ACTION_INSTANCE_URL: "https://tenant.my.salesforce.com",
      SALESFORCE_ACTION_CLIENT_ID: "tenant-consumer-key",
      SALESFORCE_ACTION_CLIENT_SECRET: "",
    });
    await expect(
      resolveCredentialsFor(SALESFORCE_TARGET, { workspaceId: "ws-1" }, { deployMode: "self-hosted" }),
    ).rejects.toThrow(
      /SALESFORCE_ACTION_CLIENT_SECRET/,
    );
  });
});

// ---------------------------------------------------------------------------
// Tool execute — approval-queue parity with createJiraTicket
// ---------------------------------------------------------------------------

describe("createSalesforceRecord — tool execute", () => {
  it("pends the action with the right actionType, target and payload", async () => {
    const aiTool = createSalesforceRecord.tool as unknown as {
      execute: (args: unknown, options: unknown) => Promise<unknown>;
    };

    await aiTool.execute(
      { object: "Lead", fields: { LastName: "Reyes", Company: "Acme" } },
      { toolCallId: "test-call", messages: [], abortSignal: undefined as unknown as AbortSignal },
    );

    expect(lastHandleActionCall).not.toBeNull();
    const request = lastHandleActionCall!.request as Record<string, unknown>;
    expect(request.actionType).toBe("salesforce:create");
    expect(request.target).toBe("Lead");
    expect(request.reversible).toBe(true);
    // `LastName` outranks `Company` in the label search — the lead is the
    // person, and that is what an approver is deciding about.
    expect(request.summary).toBe("Create Salesforce Lead: Reyes");
    expect((request.payload as Record<string, unknown>).object).toBe("Lead");
  });

  it("says so on the approval card when the agent names no object", async () => {
    // The stored default must NOT decide the card's target: it resolves at
    // execution time, so a change between request and approval is picked up.
    process.env.SALESFORCE_ACTION_DEFAULT_OBJECT = "Case";

    const aiTool = createSalesforceRecord.tool as unknown as {
      execute: (args: unknown, options: unknown) => Promise<unknown>;
    };

    await aiTool.execute(
      { fields: { Subject: "Churn risk" } },
      { toolCallId: "test-call-2", messages: [], abortSignal: undefined as unknown as AbortSignal },
    );

    const request = lastHandleActionCall!.request as Record<string, unknown>;
    expect(request.target).toBe("(workspace default object)");
    expect(request.target).not.toBe("Case");
    expect(request.summary).toBe("Create Salesforce record: Churn risk");
  });

  it("records best-effort delete rollback metadata on execution", async () => {
    const aiTool = createSalesforceRecord.tool as unknown as {
      execute: (args: unknown, options: unknown) => Promise<unknown>;
    };
    mockRead.mockResolvedValue({
      SALESFORCE_ACTION_INSTANCE_URL: "https://tenant.my.salesforce.com",
      SALESFORCE_ACTION_CLIENT_ID: "tenant-consumer-key",
      SALESFORCE_ACTION_CLIENT_SECRET: "tenant-consumer-secret",
    });

    await aiTool.execute(
      { object: "Case", fields: { Subject: "Churn risk" } },
      { toolCallId: "test-call-3", messages: [], abortSignal: undefined as unknown as AbortSignal },
    );

    // The executor the module registered for its action type (#5570) — the
    // one a re-dispatch would run, not a per-request closure.
    const executeFn = registeredExecutors.get(createSalesforceRecord.actionType) as (
      payload: Record<string, unknown>,
      ctx: { workspaceId: string | null },
    ) => Promise<Record<string, unknown>>;

    // The ACTION's workspace, not the approver's — the context the handler
    // threads at execution time.
    const result = await executeFn(
      { object: "Case", fields: { Subject: "Churn risk" } },
      { workspaceId: "ws-1" },
    );

    expect(mockRead).toHaveBeenCalledWith("ws-1", "salesforce");
    expect(result.rollbackInfo).toEqual({
      method: "delete",
      params: { object: "Case", recordId: "00Q000000000001AAA" },
    });
  });
});

// ---------------------------------------------------------------------------
// Tool schema
// ---------------------------------------------------------------------------

describe("createSalesforceRecord — input schema", () => {
  it("constrains `object` to the allowlist so the model cannot name another", () => {
    const schema = (createSalesforceRecord.tool as unknown as {
      inputSchema: { safeParse: (v: unknown) => { success: boolean } };
    }).inputSchema;

    expect(schema.safeParse({ object: "Lead", fields: { LastName: "R" } }).success).toBe(true);
    expect(schema.safeParse({ object: "User", fields: { Username: "x" } }).success).toBe(false);
    // `object` is optional — the workspace default covers it.
    expect(schema.safeParse({ fields: { Subject: "x" } }).success).toBe(true);
  });

  it("the schema's objects are exactly the exported allowlist", () => {
    expect([...SALESFORCE_ACTION_OBJECTS]).toEqual([
      "Lead",
      "Case",
      "Task",
      "Contact",
      "Opportunity",
    ]);
  });
});

describe("executor registration (#5570)", () => {
  it("registers an executor under its own actionType at module load", () => {
    // The property that makes an approval durable: the key is the TYPE the
    // `AtlasAction` declares and the rows carry, so any instance can execute
    // an approved row by looking it up. Reading `createSalesforceRecord.actionType`
    // rather than re-typing the literal is what keeps this a check on the
    // module's agreement with itself.
    expect(createSalesforceRecord.actionType).toBe("salesforce:create");
    expect(registeredExecutors.get(createSalesforceRecord.actionType)).toBeTypeOf("function");
  });
});
