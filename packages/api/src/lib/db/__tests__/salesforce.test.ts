/**
 * Tests for the Salesforce DataSource adapter and registry.
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";

// Mock jsforce before importing the module under test
const mockLogin = mock(() => Promise.resolve());
const mockLogout = mock(() => Promise.resolve());
const mockQuery = mock(() =>
  Promise.resolve({
    records: [
      { attributes: { type: "Account" }, Id: "001", Name: "Acme" },
      { attributes: { type: "Account" }, Id: "002", Name: "Widget Co" },
    ],
  }),
);
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
      {
        name: "Industry",
        type: "picklist",
        label: "Industry",
        picklistValues: [
          { value: "Technology", label: "Technology", active: true },
          { value: "Finance", label: "Finance", active: true },
        ],
        referenceTo: [],
        nillable: true,
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
    login = mockLogin;
    logout = mockLogout;
    query = mockQuery;
    describe = mockDescribe;
    describeGlobal = mockDescribeGlobal;
  },
}));

const {
  parseSalesforceURL,
  createSalesforceDataSource,
  registerSalesforceSource,
  getSalesforceSource,
  listSalesforceSources,
  describeSalesforceSources,
  _resetSalesforceSources,
} = await import("@atlas/api/lib/db/salesforce");

describe("parseSalesforceURL", () => {
  it("parses a full URL", () => {
    const config = parseSalesforceURL(
      "salesforce://user%40example.com:pass123@login.salesforce.com?token=SECTOKEN",
    );
    expect(config.loginUrl).toBe("https://login.salesforce.com");
    expect(config.username).toBe("user@example.com");
    expect(config.password).toBe("pass123");
    expect(config.securityToken).toBe("SECTOKEN");
  });

  it("parses minimal URL with defaults", () => {
    const config = parseSalesforceURL("salesforce://admin:secret@localhost");
    expect(config.loginUrl).toBe("https://localhost");
    expect(config.username).toBe("admin");
    expect(config.password).toBe("secret");
    expect(config.securityToken).toBeUndefined();
  });

  it("parses sandbox URL (test.salesforce.com)", () => {
    const config = parseSalesforceURL(
      "salesforce://user:pass@test.salesforce.com",
    );
    expect(config.loginUrl).toBe("https://test.salesforce.com");
  });

  it("parses OAuth params", () => {
    const config = parseSalesforceURL(
      "salesforce://user:pass@login.salesforce.com?clientId=CID&clientSecret=CSEC",
    );
    expect(config.clientId).toBe("CID");
    expect(config.clientSecret).toBe("CSEC");
  });

  it("throws for non-salesforce scheme", () => {
    expect(() => parseSalesforceURL("postgresql://user:pass@localhost")).toThrow(
      "expected salesforce://",
    );
  });

  it("throws for missing username", () => {
    expect(() =>
      parseSalesforceURL("salesforce://:pass@login.salesforce.com"),
    ).toThrow("missing username");
  });

  it("throws for missing password", () => {
    expect(() =>
      parseSalesforceURL("salesforce://user@login.salesforce.com"),
    ).toThrow("missing password");
  });
});

describe("createSalesforceDataSource", () => {
  beforeEach(() => {
    mockLogin.mockClear();
    mockLogout.mockClear();
    mockQuery.mockClear();
    mockDescribe.mockClear();
    mockDescribeGlobal.mockClear();
  });

  it("query returns columns and rows without attributes key", async () => {
    const source = createSalesforceDataSource({
      loginUrl: "https://login.salesforce.com",
      username: "user",
      password: "pass",
    });

    const result = await source.query("SELECT Id, Name FROM Account");
    expect(result.columns).toEqual(["Id", "Name"]);
    expect(result.rows).toEqual([
      { Id: "001", Name: "Acme" },
      { Id: "002", Name: "Widget Co" },
    ]);
    expect(mockLogin).toHaveBeenCalledTimes(1);
  });

  it("query returns empty result for no records", async () => {
    mockQuery.mockImplementationOnce(() =>
      Promise.resolve({ records: [] }),
    );
    const source = createSalesforceDataSource({
      loginUrl: "https://login.salesforce.com",
      username: "user",
      password: "pass",
    });

    const result = await source.query("SELECT Id FROM Account WHERE Id = 'none'");
    expect(result.columns).toEqual([]);
    expect(result.rows).toEqual([]);
  });

  it("describe returns mapped fields", async () => {
    const source = createSalesforceDataSource({
      loginUrl: "https://login.salesforce.com",
      username: "user",
      password: "pass",
    });

    const desc = await source.describe("Account");
    expect(desc.name).toBe("Account");
    expect(desc.fields).toHaveLength(3);
    expect(desc.fields[0].name).toBe("Id");
    expect(desc.fields[2].picklistValues).toHaveLength(2);
  });

  it("listObjects filters to queryable only", async () => {
    const source = createSalesforceDataSource({
      loginUrl: "https://login.salesforce.com",
      username: "user",
      password: "pass",
    });

    const objects = await source.listObjects();
    expect(objects).toHaveLength(2);
    expect(objects.map((o) => o.name)).toEqual(["Account", "Contact"]);
  });

  it("close calls logout", async () => {
    const source = createSalesforceDataSource({
      loginUrl: "https://login.salesforce.com",
      username: "user",
      password: "pass",
    });

    // Force login first
    await source.listObjects();
    await source.close();
    expect(mockLogout).toHaveBeenCalledTimes(1);
  });

  it("appends security token to password on login", async () => {
    const source = createSalesforceDataSource({
      loginUrl: "https://login.salesforce.com",
      username: "user",
      password: "pass",
      securityToken: "TOKEN123",
    });

    await source.listObjects();
    expect(mockLogin).toHaveBeenCalledWith("user", "passTOKEN123");
  });

  it("serializes concurrent login attempts (no duplicate logins)", async () => {
    // Make login take some time so concurrent calls overlap
    mockLogin.mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 50)),
    );

    const source = createSalesforceDataSource({
      loginUrl: "https://login.salesforce.com",
      username: "user",
      password: "pass",
    });

    // Fire three concurrent queries — all need login
    await Promise.all([
      source.query("SELECT Id FROM Account"),
      source.listObjects(),
      source.describe("Account"),
    ]);

    // Login should have been called exactly once despite three concurrent callers
    expect(mockLogin).toHaveBeenCalledTimes(1);
  });

  it("close without prior login is a no-op", async () => {
    const source = createSalesforceDataSource({
      loginUrl: "https://login.salesforce.com",
      username: "user",
      password: "pass",
    });

    // Close without ever calling login — should not throw or call logout
    await source.close();
    expect(mockLogout).not.toHaveBeenCalled();
    expect(mockLogin).not.toHaveBeenCalled();
  });
});

describe("Salesforce source registry", () => {
  beforeEach(() => {
    _resetSalesforceSources();
    mockLogin.mockClear();
    mockLogout.mockClear();
  });

  it("register and get a source", () => {
    registerSalesforceSource("sf1", {
      loginUrl: "https://login.salesforce.com",
      username: "user",
      password: "pass",
    });

    const source = getSalesforceSource("sf1");
    expect(source).toBeDefined();
    expect(source.query).toBeDefined();
  });

  it("throws for unregistered source", () => {
    expect(() => getSalesforceSource("nonexistent")).toThrow(
      'not registered',
    );
  });

  it("lists registered sources", () => {
    registerSalesforceSource("sf1", {
      loginUrl: "https://login.salesforce.com",
      username: "user",
      password: "pass",
    });
    registerSalesforceSource("sf2", {
      loginUrl: "https://test.salesforce.com",
      username: "admin",
      password: "secret",
    });

    expect(listSalesforceSources()).toEqual(["sf1", "sf2"]);
  });

  it("reset clears all sources", () => {
    registerSalesforceSource("sf1", {
      loginUrl: "https://login.salesforce.com",
      username: "user",
      password: "pass",
    });

    _resetSalesforceSources();
    expect(listSalesforceSources()).toEqual([]);
  });

  it("describeSalesforceSources returns metadata for registered sources", () => {
    registerSalesforceSource("sf1", {
      loginUrl: "https://login.salesforce.com",
      username: "user",
      password: "pass",
    });
    registerSalesforceSource("sf2", {
      loginUrl: "https://test.salesforce.com",
      username: "admin",
      password: "secret",
    });

    const meta = describeSalesforceSources();
    expect(meta).toEqual([
      { id: "sf1", dbType: "salesforce" },
      { id: "sf2", dbType: "salesforce" },
    ]);
  });

  it("describeSalesforceSources returns empty array when no sources registered", () => {
    expect(describeSalesforceSources()).toEqual([]);
  });
});
