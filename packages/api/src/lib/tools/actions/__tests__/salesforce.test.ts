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
// Mocks — handler (no DB/auth), logger, credential store, jsforce
// ---------------------------------------------------------------------------

let lastHandleActionCall: { request: unknown; executeFn: unknown } | null = null;

void mock.module("@atlas/api/lib/tools/actions/handler", () => ({
  buildActionRequest: (params: Record<string, unknown>) => ({
    id: "test-action-id",
    ...params,
  }),
  handleAction: async (request: unknown, executeFn: unknown) => {
    lastHandleActionCall = { request, executeFn };
    return { status: "pending", actionId: "test-action-id", summary: "test" };
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

// jsforce — mocked so no test touches a real org. Captures the OAuth2 config,
// the grant, the Connection args and the created record.
let lastOAuth2Config: Record<string, unknown> | null = null;
let lastGrant: Record<string, unknown> | null = null;
let lastConnectionArgs: Record<string, unknown> | null = null;
let lastCreate: { object: string; fields: Record<string, unknown> } | null = null;

let tokenResponse: unknown = {
  access_token: "sf-access-token",
  instance_url: "https://tenant.my.salesforce.com",
};
let tokenError: Error | null = null;
let createResponse: unknown = { id: "00Q000000000001AAA", success: true, errors: [] };
let createError: Error | null = null;

class MockOAuth2 {
  constructor(config: Record<string, unknown>) {
    lastOAuth2Config = config;
  }
  async requestToken(grant: Record<string, unknown>) {
    lastGrant = grant;
    if (tokenError) throw tokenError;
    return tokenResponse;
  }
}

class MockConnection {
  constructor(args: Record<string, unknown>) {
    lastConnectionArgs = args;
  }
  sobject(object: string) {
    return {
      create: async (fields: Record<string, unknown>) => {
        lastCreate = { object, fields };
        if (createError) throw createError;
        return createResponse;
      },
    };
  }
}

void mock.module("jsforce", () => ({
  default: { OAuth2: MockOAuth2, Connection: MockConnection },
  OAuth2: MockOAuth2,
  Connection: MockConnection,
}));

const {
  executeSalesforceCreate,
  createSalesforceRecord,
  resolveSalesforceCredentials,
  toSalesforceCredentials,
  canonicalSalesforceObject,
  SALESFORCE_ACTION_OBJECTS,
} = await import("@atlas/api/lib/tools/actions/salesforce");

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
  lastOAuth2Config = null;
  lastGrant = null;
  lastConnectionArgs = null;
  lastCreate = null;
  tokenError = null;
  createError = null;
  tokenResponse = {
    access_token: "sf-access-token",
    instance_url: "https://tenant.my.salesforce.com",
  };
  createResponse = { id: "00Q000000000001AAA", success: true, errors: [] };
  mockRead.mockReset();
  mockRead.mockResolvedValue(null);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] !== undefined) process.env[key] = saved[key];
    else delete process.env[key];
  }
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

    expect(lastOAuth2Config).toEqual({
      loginUrl: "https://tenant.my.salesforce.com",
      clientId: "tenant-consumer-key",
      clientSecret: "tenant-consumer-secret",
    });
    expect(lastGrant).toEqual({ grant_type: "client_credentials" });
    expect(lastConnectionArgs).toEqual({
      instanceUrl: "https://tenant.my.salesforce.com",
      accessToken: "sf-access-token",
    });
    expect(lastCreate).toEqual({
      object: "Lead",
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

    expect(lastOAuth2Config?.loginUrl).toBe("https://tenant.my.salesforce.com");
    expect(lastOAuth2Config?.clientId).toBe("tenant-consumer-key");
    expect(lastOAuth2Config?.clientSecret).toBe("tenant-consumer-secret");
    expect(lastCreate?.object).toBe("Lead");
  });

  it("falls back to the credential set's default object when the agent names none", async () => {
    await executeSalesforceCreate(
      { fields: { Subject: "Churn risk" } },
      creds({ SALESFORCE_ACTION_DEFAULT_OBJECT: "case" }),
    );
    expect(lastCreate?.object).toBe("Case");
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
    expect(lastCreate).toBeNull();
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
    expect(lastCreate).toBeNull();
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
    expect(lastOAuth2Config).toBeNull();
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
    expect(lastOAuth2Config).toBeNull();
  });

  it("re-validates the instance URL Salesforce echoes back", async () => {
    // The echo decides where the record POST goes and what host the approval
    // card links to, so it gets the same guard the configured URL got.
    tokenResponse = {
      access_token: "sf-access-token",
      instance_url: "http://169.254.169.254",
    };
    await expect(
      executeSalesforceCreate({ object: "Lead", fields: { LastName: "Reyes" } }, creds()),
    ).rejects.toThrow(/Salesforce returned/);
    expect(lastCreate).toBeNull();
  });

  it("surfaces a token rejection without echoing the consumer secret", async () => {
    // Salesforce does not normally echo the secret; the redaction is the
    // belt-and-braces that keeps an unreviewed vendor error path from
    // becoming the one place a secret reaches a response.
    tokenError = new Error(
      "invalid_client: bad secret tenant-consumer-secret for this app",
    );
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
      expect(message).toContain("[redacted]");
    }
  });

  it("surfaces an API failure without echoing the access token", async () => {
    createError = new Error("Session sf-access-token is invalid");
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
    createResponse = {
      success: false,
      errors: [
        {
          statusCode: "REQUIRED_FIELD_MISSING",
          message: "Required fields are missing: [Company]",
          fields: ["Company"],
        },
      ],
    };
    await expect(
      executeSalesforceCreate({ object: "Lead", fields: { LastName: "Reyes" } }, creds()),
    ).rejects.toThrow(/REQUIRED_FIELD_MISSING: Required fields are missing/);
  });

  it("redacts credentials out of a REFUSAL body too, not just a thrown error", async () => {
    // A refusal body is no more trustworthy than a thrown one; leaving this
    // path unguarded is how a file ends up guarding only the paths someone
    // happened to think about.
    createResponse = {
      success: false,
      errors: [
        {
          statusCode: "INSUFFICIENT_ACCESS",
          message: "App tenant-consumer-secret cannot create this record",
        },
        "raw string error mentioning sf-access-token",
      ],
    };
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
    tokenResponse = { instance_url: "https://tenant.my.salesforce.com" };
    await expect(
      executeSalesforceCreate({ object: "Lead", fields: { LastName: "Reyes" } }, creds()),
    ).rejects.toThrow(/no access token/);
  });

  it("throws when a successful save carries no record id", async () => {
    createResponse = { success: true, errors: [] };
    await expect(
      executeSalesforceCreate({ object: "Lead", fields: { LastName: "Reyes" } }, creds()),
    ).rejects.toThrow(/carried no record id/);
  });

  it("prefers the org's echoed instance_url for the session and the record link", async () => {
    tokenResponse = {
      access_token: "sf-access-token",
      instance_url: "https://tenant--sandbox.sandbox.my.salesforce.com/",
    };
    const result = await executeSalesforceCreate(
      { object: "Case", fields: { Subject: "Churn risk" } },
      creds(),
    );
    expect(lastConnectionArgs?.instanceUrl).toBe(
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
    expect(lastOAuth2Config?.loginUrl).toBe("https://tenant.my.salesforce.com");
  });

  it("toSalesforceCredentials rejects a partial set and names only the missing KEYS", () => {
    try {
      toSalesforceCredentials({
        SALESFORCE_ACTION_INSTANCE_URL: "https://tenant.my.salesforce.com",
        SALESFORCE_ACTION_CLIENT_SECRET: "tenant-consumer-secret",
      });
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("SALESFORCE_ACTION_CLIENT_ID");
      // Names, never values — the message must not echo a credential.
      expect(message).not.toContain("tenant-consumer-secret");
      expect(message).not.toContain("tenant.my.salesforce.com");
    }
  });
});

// ---------------------------------------------------------------------------
// All-or-nothing per rung, for THIS target (ADR-0046)
// ---------------------------------------------------------------------------

describe("resolveSalesforceCredentials — all-or-nothing per rung", () => {
  it("a complete workspace row wins and the operator env is ignored", async () => {
    process.env.SALESFORCE_ACTION_INSTANCE_URL = "https://operator.my.salesforce.com";
    process.env.SALESFORCE_ACTION_CLIENT_ID = "operator-key";
    process.env.SALESFORCE_ACTION_CLIENT_SECRET = "operator-secret";
    mockRead.mockResolvedValue({
      SALESFORCE_ACTION_INSTANCE_URL: "https://tenant.my.salesforce.com",
      SALESFORCE_ACTION_CLIENT_ID: "tenant-consumer-key",
      SALESFORCE_ACTION_CLIENT_SECRET: "tenant-consumer-secret",
    });

    const resolved = await resolveSalesforceCredentials({ workspaceId: "ws-1" });

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
      await resolveSalesforceCredentials({ workspaceId: "ws-1" });
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
    await expect(resolveSalesforceCredentials({ workspaceId: "ws-1" })).rejects.toThrow(
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

    const executeFn = lastHandleActionCall!.executeFn as (
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
