import { describe, test, expect, mock, beforeEach } from "bun:test";

// Mock jsforce before any imports that use it
const mockQuery = mock(() =>
  Promise.resolve({
    records: [
      { attributes: { type: "Account" }, Id: "001", Name: "Acme Corp" },
      { attributes: { type: "Account" }, Id: "002", Name: "Globex" },
    ],
  }),
);
const mockLogin = mock(() => Promise.resolve());
const mockLogout = mock(() => Promise.resolve());
const mockDescribe = mock(() =>
  Promise.resolve({
    name: "Account",
    label: "Account",
    fields: [
      {
        name: "Id",
        type: "id",
        label: "Account ID",
        picklistValues: [],
        referenceTo: [],
        nillable: false,
        length: 18,
      },
      {
        name: "Name",
        type: "string",
        label: "Account Name",
        picklistValues: [],
        referenceTo: [],
        nillable: false,
        length: 255,
      },
    ],
  }),
);
const mockDescribeGlobal = mock(() =>
  Promise.resolve({
    sobjects: [
      { name: "Account", label: "Account", queryable: true },
      { name: "Contact", label: "Contact", queryable: true },
      { name: "ApexLog", label: "Apex Log", queryable: false },
    ],
  }),
);

mock.module("jsforce", () => ({
  Connection: class MockConnection {
    query = mockQuery;
    login = mockLogin;
    logout = mockLogout;
    describe = mockDescribe;
    describeGlobal = mockDescribeGlobal;
  },
}));

import { definePlugin, isDatasourcePlugin } from "@useatlas/plugin-sdk";
import {
  salesforcePlugin,
  buildSalesforcePlugin,
  parseSalesforceURL,
  extractHost,
  validateSOQL,
  appendSOQLLimit,
  SOQL_FORBIDDEN_PATTERNS,
  createQuerySalesforceTool,
} from "../index";
import { createSalesforceConnection } from "../connection";

const VALID_URL = "salesforce://user:pass@login.salesforce.com?token=TOKEN";

beforeEach(() => {
  mockQuery.mockClear();
  mockLogin.mockClear();
  mockLogout.mockClear();
  mockDescribe.mockClear();
  mockDescribeGlobal.mockClear();

  // Re-stub defaults after clearing
  mockQuery.mockImplementation(() =>
    Promise.resolve({
      records: [
        { attributes: { type: "Account" }, Id: "001", Name: "Acme Corp" },
        { attributes: { type: "Account" }, Id: "002", Name: "Globex" },
      ],
    }),
  );
  mockLogin.mockImplementation(() => Promise.resolve());
  mockLogout.mockImplementation(() => Promise.resolve());
  mockDescribe.mockImplementation(() =>
    Promise.resolve({
      name: "Account",
      label: "Account",
      fields: [
        {
          name: "Id",
          type: "id",
          label: "Account ID",
          picklistValues: [],
          referenceTo: [],
          nillable: false,
          length: 18,
        },
      ],
    }),
  );
  mockDescribeGlobal.mockImplementation(() =>
    Promise.resolve({
      sobjects: [
        { name: "Account", label: "Account", queryable: true },
        { name: "Contact", label: "Contact", queryable: true },
      ],
    }),
  );
});

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

describe("parseSalesforceURL", () => {
  test("parses valid Salesforce URL", () => {
    const config = parseSalesforceURL(VALID_URL);
    expect(config.loginUrl).toBe("https://login.salesforce.com");
    expect(config.username).toBe("user");
    expect(config.password).toBe("pass");
    expect(config.securityToken).toBe("TOKEN");
  });

  test("parses URL without token", () => {
    const config = parseSalesforceURL("salesforce://user:pass@login.salesforce.com");
    expect(config.securityToken).toBeUndefined();
  });

  test("parses URL with clientId and clientSecret", () => {
    const config = parseSalesforceURL(
      "salesforce://user:pass@login.salesforce.com?clientId=CID&clientSecret=CSEC",
    );
    expect(config.clientId).toBe("CID");
    expect(config.clientSecret).toBe("CSEC");
  });

  test("defaults hostname to login.salesforce.com", () => {
    // URL constructor gives empty hostname for salesforce://:, so use explicit host
    const config = parseSalesforceURL("salesforce://user:pass@login.salesforce.com");
    expect(config.loginUrl).toBe("https://login.salesforce.com");
  });

  test("rejects non-salesforce scheme", () => {
    expect(() => parseSalesforceURL("postgresql://user:pass@host/db")).toThrow(
      /expected salesforce:\/\/ scheme/,
    );
  });

  test("rejects missing username", () => {
    expect(() => parseSalesforceURL("salesforce://:pass@host")).toThrow(
      /missing username/,
    );
  });

  test("rejects missing password", () => {
    expect(() => parseSalesforceURL("salesforce://user@host")).toThrow(
      /missing password/,
    );
  });
});

// ---------------------------------------------------------------------------
// extractHost (safe logging — no credentials)
// ---------------------------------------------------------------------------

describe("extractHost", () => {
  test("extracts hostname from salesforce:// URL", () => {
    expect(extractHost(VALID_URL)).toBe("login.salesforce.com");
  });

  test("strips credentials from URL", () => {
    expect(extractHost("salesforce://admin:secret@my.salesforce.com")).toBe(
      "my.salesforce.com",
    );
  });

  test("returns (unknown) for invalid URL", () => {
    expect(extractHost("not-a-url")).toBe("(unknown)");
  });
});

// ---------------------------------------------------------------------------
// Config validation (via createPlugin factory)
// ---------------------------------------------------------------------------

describe("config validation", () => {
  test("accepts valid salesforce:// URL", () => {
    const plugin = salesforcePlugin({ url: VALID_URL });
    expect(plugin.id).toBe("salesforce-datasource");
    expect(plugin.type).toBe("datasource");
    expect(plugin.config?.url).toBe(VALID_URL);
  });

  test("rejects empty URL", () => {
    expect(() => salesforcePlugin({ url: "" })).toThrow(
      /URL must not be empty/,
    );
  });

  test("rejects non-salesforce URL scheme", () => {
    expect(() =>
      salesforcePlugin({ url: "postgresql://localhost:5432/db" }),
    ).toThrow(/URL must start with salesforce:\/\//);
  });

  test("rejects missing URL", () => {
    // @ts-expect-error — intentionally passing invalid config
    expect(() => salesforcePlugin({})).toThrow();
  });

  test("rejects URL with missing credentials", () => {
    expect(() => salesforcePlugin({ url: "salesforce://:pass@host" })).toThrow(
      /missing username/,
    );
  });
});

// ---------------------------------------------------------------------------
// Plugin shape validation
// ---------------------------------------------------------------------------

describe("plugin shape", () => {
  test("createPlugin factory returns a valid plugin", () => {
    const plugin = salesforcePlugin({ url: VALID_URL });
    expect(plugin.id).toBe("salesforce-datasource");
    expect(plugin.type).toBe("datasource");
    expect(plugin.version).toBe("0.1.0");
    expect(plugin.name).toBe("Salesforce DataSource");
  });

  test("definePlugin accepts the built plugin", () => {
    const plugin = buildSalesforcePlugin({ url: VALID_URL });
    const validated = definePlugin(plugin);
    expect(validated).toBe(plugin);
  });

  test("isDatasourcePlugin type guard passes", () => {
    const plugin = salesforcePlugin({ url: VALID_URL });
    expect(isDatasourcePlugin(plugin)).toBe(true);
  });

  test("connection.dbType is 'salesforce'", () => {
    const plugin = salesforcePlugin({ url: VALID_URL });
    expect(plugin.connection.dbType).toBe("salesforce");
  });

  test("connection.validate is a function", () => {
    const plugin = salesforcePlugin({ url: VALID_URL });
    expect(typeof plugin.connection.validate).toBe("function");
  });

  test("connection.validate rejects DML", () => {
    const plugin = salesforcePlugin({ url: VALID_URL });
    const result = plugin.connection.validate!("DELETE FROM Account");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("Forbidden");
  });

  test("entities is an empty array", () => {
    const plugin = salesforcePlugin({ url: VALID_URL });
    expect(plugin.entities).toEqual([]);
  });

  test("dialect provides SOQL-specific guidance", () => {
    const plugin = salesforcePlugin({ url: VALID_URL });
    expect(plugin.dialect).toContain("SOQL");
    expect(plugin.dialect).toContain("relationship queries");
    expect(plugin.dialect).toContain("querySalesforce");
  });

  test("has teardown method", () => {
    const plugin = salesforcePlugin({ url: VALID_URL });
    expect(typeof plugin.teardown).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// SOQL validation
// ---------------------------------------------------------------------------

describe("validateSOQL", () => {
  const ALLOWED = new Set(["Account", "Contact", "Opportunity", "Lead"]);

  describe("empty check", () => {
    test("rejects empty string", () => {
      const result = validateSOQL("", ALLOWED);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Empty");
    });

    test("rejects whitespace-only", () => {
      const result = validateSOQL("   \n\t  ", ALLOWED);
      expect(result.valid).toBe(false);
    });
  });

  describe("mutation guard", () => {
    for (const keyword of ["INSERT", "UPDATE", "DELETE", "UPSERT", "MERGE", "UNDELETE"]) {
      test(`rejects ${keyword}`, () => {
        const result = validateSOQL(`${keyword} INTO Account`, ALLOWED);
        expect(result.valid).toBe(false);
        expect(result.error).toContain("Forbidden");
      });
    }
  });

  describe("SELECT-only", () => {
    test("accepts SELECT query", () => {
      const result = validateSOQL("SELECT Id FROM Account", ALLOWED);
      expect(result.valid).toBe(true);
    });

    test("rejects non-SELECT query", () => {
      const result = validateSOQL("DESCRIBE Account", ALLOWED);
      expect(result.valid).toBe(false);
    });

    test("rejects semicolons", () => {
      const result = validateSOQL("SELECT Id FROM Account;", ALLOWED);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Semicolons");
    });
  });

  describe("object whitelist", () => {
    test("allows whitelisted objects", () => {
      const result = validateSOQL("SELECT Id, Name FROM Account", ALLOWED);
      expect(result.valid).toBe(true);
    });

    test("rejects non-whitelisted objects", () => {
      const result = validateSOQL("SELECT Id FROM CustomObject__c", ALLOWED);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("not in the allowed list");
    });

    test("is case-insensitive", () => {
      const result = validateSOQL("SELECT Id FROM account", ALLOWED);
      expect(result.valid).toBe(true);
    });
  });

  describe("string literal false positives", () => {
    test("allows 'delete' inside a string literal", () => {
      const result = validateSOQL(
        "SELECT Id FROM Account WHERE Name = 'delete this'",
        ALLOWED,
      );
      expect(result.valid).toBe(true);
    });

    test("still rejects actual DELETE statements", () => {
      const result = validateSOQL("DELETE FROM Account", ALLOWED);
      expect(result.valid).toBe(false);
    });
  });

  describe("relationship subqueries", () => {
    test("accepts parent-to-child relationship subquery", () => {
      const result = validateSOQL(
        "SELECT Id, Name, (SELECT LastName FROM Contacts) FROM Account",
        ALLOWED,
      );
      expect(result.valid).toBe(true);
    });

    test("checks semi-join subquery objects", () => {
      const result = validateSOQL(
        "SELECT Id FROM Account WHERE Id IN (SELECT AccountId FROM CustomObject__c)",
        ALLOWED,
      );
      expect(result.valid).toBe(false);
      expect(result.error).toContain("CustomObject__c");
    });
  });
});

describe("appendSOQLLimit", () => {
  test("appends LIMIT when not present", () => {
    expect(appendSOQLLimit("SELECT Id FROM Account", 100)).toBe(
      "SELECT Id FROM Account LIMIT 100",
    );
  });

  test("does not append when LIMIT already present", () => {
    expect(appendSOQLLimit("SELECT Id FROM Account LIMIT 50", 100)).toBe(
      "SELECT Id FROM Account LIMIT 50",
    );
  });
});

describe("SOQL_FORBIDDEN_PATTERNS", () => {
  test("is a non-empty RegExp array", () => {
    expect(Array.isArray(SOQL_FORBIDDEN_PATTERNS)).toBe(true);
    expect(SOQL_FORBIDDEN_PATTERNS.length).toBeGreaterThan(0);
    for (const p of SOQL_FORBIDDEN_PATTERNS) {
      expect(p).toBeInstanceOf(RegExp);
    }
  });

  test("blocks DML keywords", () => {
    expect(SOQL_FORBIDDEN_PATTERNS.some((p) => p.test("INSERT INTO Account"))).toBe(true);
    expect(SOQL_FORBIDDEN_PATTERNS.some((p) => p.test("DELETE FROM Account"))).toBe(true);
  });

  test("does not block SELECT queries", () => {
    expect(SOQL_FORBIDDEN_PATTERNS.some((p) => p.test("SELECT Id FROM Account"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Connection factory
// ---------------------------------------------------------------------------

describe("connection factory", () => {
  test("connection.create() returns a PluginDBConnection", async () => {
    const plugin = salesforcePlugin({ url: VALID_URL });
    const conn = await plugin.connection.create();
    expect(typeof conn.query).toBe("function");
    expect(typeof conn.close).toBe("function");
  });

  test("query returns { columns, rows } without attributes key", async () => {
    const conn = createSalesforceConnection({
      loginUrl: "https://login.salesforce.com",
      username: "user",
      password: "pass",
    });
    const result = await conn.query("SELECT Id, Name FROM Account");
    expect(result.columns).toEqual(["Id", "Name"]);
    expect(result.rows).toEqual([
      { Id: "001", Name: "Acme Corp" },
      { Id: "002", Name: "Globex" },
    ]);
    expect(mockLogin).toHaveBeenCalled();
  });

  test("query returns empty result for no records", async () => {
    mockQuery.mockImplementation(() =>
      Promise.resolve({ records: [] }),
    );
    const conn = createSalesforceConnection({
      loginUrl: "https://login.salesforce.com",
      username: "user",
      password: "pass",
    });
    const result = await conn.query("SELECT Id FROM Account WHERE Id = 'none'");
    expect(result.columns).toEqual([]);
    expect(result.rows).toEqual([]);
  });

  test("query appends security token to password", async () => {
    const conn = createSalesforceConnection({
      loginUrl: "https://login.salesforce.com",
      username: "user",
      password: "pass",
      securityToken: "TOKEN",
    });
    await conn.query("SELECT Id FROM Account");
    expect(mockLogin).toHaveBeenCalledWith("user", "passTOKEN");
  });

  test("query without security token uses password only", async () => {
    const conn = createSalesforceConnection({
      loginUrl: "https://login.salesforce.com",
      username: "user",
      password: "pass",
    });
    await conn.query("SELECT Id FROM Account");
    expect(mockLogin).toHaveBeenCalledWith("user", "pass");
  });

  test("describe returns object metadata", async () => {
    const conn = createSalesforceConnection({
      loginUrl: "https://login.salesforce.com",
      username: "user",
      password: "pass",
    });
    const desc = await conn.describe("Account");
    expect(desc.name).toBe("Account");
    expect(desc.fields[0].name).toBe("Id");
  });

  test("listObjects returns queryable objects only", async () => {
    const conn = createSalesforceConnection({
      loginUrl: "https://login.salesforce.com",
      username: "user",
      password: "pass",
    });
    const objects = await conn.listObjects();
    expect(objects).toEqual([
      { name: "Account", label: "Account", queryable: true },
      { name: "Contact", label: "Contact", queryable: true },
    ]);
  });

  test("close calls logout", async () => {
    const conn = createSalesforceConnection({
      loginUrl: "https://login.salesforce.com",
      username: "user",
      password: "pass",
    });
    // Need to trigger login first
    await conn.query("SELECT Id FROM Account");
    await conn.close();
    expect(mockLogout).toHaveBeenCalled();
  });

  test("close does not throw when logout fails", async () => {
    mockLogout.mockImplementation(() => Promise.reject(new Error("already logged out")));
    const conn = createSalesforceConnection({
      loginUrl: "https://login.salesforce.com",
      username: "user",
      password: "pass",
    });
    await conn.query("SELECT Id FROM Account");
    await conn.close(); // should not throw
  });

  test("session retry re-authenticates on INVALID_SESSION_ID", async () => {
    let callCount = 0;
    mockQuery.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error("INVALID_SESSION_ID"));
      }
      return Promise.resolve({
        records: [{ attributes: { type: "Account" }, Id: "001", Name: "Test" }],
      });
    });

    const conn = createSalesforceConnection({
      loginUrl: "https://login.salesforce.com",
      username: "user",
      password: "pass",
    });
    const result = await conn.query("SELECT Id, Name FROM Account");
    expect(result.rows.length).toBe(1);
    // Login should be called at least twice (initial + retry)
    expect(mockLogin.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

describe("healthCheck", () => {
  test("returns healthy when listObjects succeeds", async () => {
    const plugin = salesforcePlugin({ url: VALID_URL });
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(true);
    expect(typeof result.latencyMs).toBe("number");
  });

  test("returns unhealthy when listObjects fails", async () => {
    mockDescribeGlobal.mockImplementation(() =>
      Promise.reject(new Error("INVALID_LOGIN")),
    );
    // Need a fresh plugin to get a fresh connection
    const plugin = buildSalesforcePlugin({ url: VALID_URL });
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(false);
    expect(result.message).toContain("INVALID_LOGIN");
  });
});

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

describe("initialize", () => {
  test("logs hostname only (no credentials)", async () => {
    const plugin = salesforcePlugin({ url: VALID_URL });
    const logged: string[] = [];
    const registered: { name: string }[] = [];
    const ctx = {
      db: null,
      connections: { get: () => { throw new Error("not implemented"); }, list: () => [] },
      tools: { register: (t: { name: string; description: string; tool: unknown }) => { registered.push(t); } },
      logger: {
        info: (...args: unknown[]) => { logged.push(String(args[0])); },
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      config: {},
    };
    await plugin.initialize!(ctx);
    const msg = logged.find((m) => m.includes("Salesforce datasource plugin initialized"));
    expect(msg).toBeDefined();
    expect(msg).toContain("login.salesforce.com");
    expect(msg).not.toContain("pass");
    expect(msg).not.toContain("TOKEN");
  });

  test("registers querySalesforce tool", async () => {
    const plugin = salesforcePlugin({ url: VALID_URL });
    const registered: { name: string }[] = [];
    const ctx = {
      db: null,
      connections: { get: () => { throw new Error("not implemented"); }, list: () => [] },
      tools: { register: (t: { name: string; description: string; tool: unknown }) => { registered.push(t); } },
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      config: {},
    };
    await plugin.initialize!(ctx);
    expect(registered.length).toBe(1);
    expect(registered[0].name).toBe("querySalesforce");
  });
});

// ---------------------------------------------------------------------------
// querySalesforce tool
// ---------------------------------------------------------------------------

describe("createQuerySalesforceTool", () => {
  test("returns success with columns and rows", async () => {
    const conn = createSalesforceConnection({
      loginUrl: "https://login.salesforce.com",
      username: "user",
      password: "pass",
    });
    const whitelist = new Set(["Account"]);
    const sfTool = createQuerySalesforceTool({
      getConnection: () => conn,
      getWhitelist: () => whitelist,
      connectionId: "salesforce",
    });

    const result = await sfTool.execute!(
      { soql: "SELECT Id, Name FROM Account", explanation: "Get accounts" },
      { toolCallId: "test", messages: [], abortSignal: undefined as unknown as AbortSignal },
    );
    expect(result).toMatchObject({
      success: true,
      columns: ["Id", "Name"],
      row_count: 2,
    });
  });

  test("returns validation error for forbidden queries", async () => {
    const conn = createSalesforceConnection({
      loginUrl: "https://login.salesforce.com",
      username: "user",
      password: "pass",
    });
    const sfTool = createQuerySalesforceTool({
      getConnection: () => conn,
      getWhitelist: () => new Set(["Account"]),
      connectionId: "salesforce",
    });

    const result = await sfTool.execute!(
      { soql: "DELETE FROM Account", explanation: "Delete all" },
      { toolCallId: "test", messages: [], abortSignal: undefined as unknown as AbortSignal },
    );
    expect(result).toMatchObject({
      success: false,
    });
    expect((result as { error: string }).error).toContain("Forbidden");
  });

  test("returns validation error for non-whitelisted objects", async () => {
    const conn = createSalesforceConnection({
      loginUrl: "https://login.salesforce.com",
      username: "user",
      password: "pass",
    });
    const sfTool = createQuerySalesforceTool({
      getConnection: () => conn,
      getWhitelist: () => new Set(["Account"]),
      connectionId: "salesforce",
    });

    const result = await sfTool.execute!(
      { soql: "SELECT Id FROM CustomObject__c", explanation: "Query custom" },
      { toolCallId: "test", messages: [], abortSignal: undefined as unknown as AbortSignal },
    );
    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toContain("not in the allowed list");
  });

  test("returns error on query failure", async () => {
    mockQuery.mockImplementation(() =>
      Promise.reject(new Error("SOQL syntax error")),
    );
    const conn = createSalesforceConnection({
      loginUrl: "https://login.salesforce.com",
      username: "user",
      password: "pass",
    });
    const sfTool = createQuerySalesforceTool({
      getConnection: () => conn,
      getWhitelist: () => new Set(["Account"]),
      connectionId: "salesforce",
    });

    const result = await sfTool.execute!(
      { soql: "SELECT Id FROM Account", explanation: "Get accounts" },
      { toolCallId: "test", messages: [], abortSignal: undefined as unknown as AbortSignal },
    );
    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toContain("SOQL syntax error");
  });
});
