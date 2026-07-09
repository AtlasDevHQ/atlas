/**
 * Salesforce introspection (ADR-0017) — `listObjects` / `profile` against a
 * mocked jsforce client. Asserts external behavior through the contract: the
 * right SObjects/profiles come back, field → column mapping handles picklists
 * (enum-like + active sample values) and `reference` fields (foreign keys),
 * profiling stays read-only (describe + a bounded COUNT(Id) SELECT, no DML), an
 * empty SObject set is tolerated, a per-object failure is recorded (not thrown),
 * and a fatal login/connection error aborts.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// jsforce mock — each call returns a canned describe/query/describeGlobal
// response. The profiler reads `result.records` for queries and `desc.fields`
// for describe, so only those keys matter here.
const mockLogin = mock(() => Promise.resolve());
const mockLogout = mock(() => Promise.resolve());

const mockQuery = mock((_soql: string) =>
  Promise.resolve({ records: [{ attributes: { type: "AggregateResult" }, expr0: 42 }] }),
);

const mockDescribe = mock((objectName: string) =>
  Promise.resolve({
    name: objectName,
    label: objectName,
    fields: [
      {
        name: "Id",
        type: "id",
        label: "Record ID",
        picklistValues: [],
        referenceTo: [],
        nillable: false,
        length: 18,
      },
      {
        name: "Name",
        type: "string",
        label: "Name",
        picklistValues: [],
        referenceTo: [],
        nillable: true,
        length: 255,
      },
      {
        name: "Stage",
        type: "picklist",
        label: "Stage",
        picklistValues: [
          { value: "Open", label: "Open", active: true },
          { value: "Won", label: "Won", active: true },
          { value: "Lost (legacy)", label: "Lost", active: false },
        ],
        referenceTo: [],
        nillable: true,
        length: 0,
      },
      {
        name: "AccountId",
        type: "reference",
        label: "Account",
        picklistValues: [],
        referenceTo: ["Account"],
        nillable: true,
        length: 18,
      },
    ],
  }),
);

const mockDescribeGlobal = mock(() =>
  Promise.resolve({
    sobjects: [
      { name: "Account", label: "Account", queryable: true },
      { name: "Opportunity", label: "Opportunity", queryable: true },
      { name: "ApexLog", label: "Apex Log", queryable: false },
    ],
  }),
);

void mock.module("jsforce", () => ({
  Connection: class MockConnection {
    login = mockLogin;
    logout = mockLogout;
    query = mockQuery;
    describe = mockDescribe;
    describeGlobal = mockDescribeGlobal;
  },
}));

import { listSalesforceObjects, profileSalesforce } from "../src/profiler";

const URL = "salesforce://admin:s3cret@my.salesforce.com?token=SECRET";

beforeEach(() => {
  mockLogin.mockClear();
  mockLogout.mockClear();
  mockQuery.mockClear();
  mockDescribe.mockClear();
  mockDescribeGlobal.mockClear();

  mockLogin.mockImplementation(() => Promise.resolve());
  mockLogout.mockImplementation(() => Promise.resolve());
  mockQuery.mockImplementation((_soql: string) =>
    Promise.resolve({ records: [{ attributes: { type: "AggregateResult" }, expr0: 42 }] }),
  );
  mockDescribeGlobal.mockImplementation(() =>
    Promise.resolve({
      sobjects: [
        { name: "Account", label: "Account", queryable: true },
        { name: "Opportunity", label: "Opportunity", queryable: true },
        { name: "ApexLog", label: "Apex Log", queryable: false },
      ],
    }),
  );
});

describe("listSalesforceObjects", () => {
  test("enumerates queryable SObjects, mapping each to a table", async () => {
    const objects = await listSalesforceObjects({ url: URL });
    expect(objects).toEqual([
      { name: "Account", type: "table" },
      { name: "Opportunity", type: "table" },
    ]);
    // Non-queryable ApexLog is excluded by the connection's describeGlobal filter.
    expect(objects.some((o) => o.name === "ApexLog")).toBe(false);
    expect(mockLogout).toHaveBeenCalledTimes(1);
  });
});

describe("profileSalesforce", () => {
  test("maps fields → columns: PK, FK, picklist enum + active sample values", async () => {
    const result = await profileSalesforce({ url: URL, selectedTables: ["Opportunity"] });
    expect(result.errors).toEqual([]);
    expect(result.profiles).toHaveLength(1);

    const opp = result.profiles[0];
    expect(opp.table_name).toBe("Opportunity");
    expect(opp.object_type).toBe("table");
    expect(opp.row_count).toBe(42);
    expect(opp.primary_key_columns).toEqual(["Id"]);

    const idCol = opp.columns.find((c) => c.name === "Id");
    expect(idCol?.is_primary_key).toBe(true);
    expect(idCol?.is_foreign_key).toBe(false);

    // Picklist → enum-like, only ACTIVE values become sample values.
    const stageCol = opp.columns.find((c) => c.name === "Stage");
    expect(stageCol?.is_enum_like).toBe(true);
    expect(stageCol?.sample_values).toEqual(["Open", "Won"]);
    expect(stageCol?.sample_values).not.toContain("Lost (legacy)");

    // reference field → foreign key to the referenced SObject's Id.
    const fkCol = opp.columns.find((c) => c.name === "AccountId");
    expect(fkCol?.is_foreign_key).toBe(true);
    expect(fkCol?.fk_target_table).toBe("Account");
    expect(fkCol?.fk_target_column).toBe("Id");
    expect(opp.foreign_keys).toEqual([
      { from_column: "AccountId", to_table: "Account", to_column: "Id", source: "constraint" },
    ]);

    // Non-picklist, non-reference field stays a plain column.
    const nameCol = opp.columns.find((c) => c.name === "Name");
    expect(nameCol?.is_enum_like).toBe(false);
    expect(nameCol?.is_foreign_key).toBe(false);
    expect(nameCol?.nullable).toBe(true);
  });

  test("profiling is read-only — only describe + a COUNT(Id) SELECT, no DML", async () => {
    await profileSalesforce({ url: URL, selectedTables: ["Account"] });
    expect(mockDescribe).toHaveBeenCalledWith("Account");
    // The only SOQL issued is the bounded aggregate row-count query.
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const soql = mockQuery.mock.calls[0][0];
    expect(soql).toBe("SELECT COUNT(Id) FROM Account");
    expect(soql).not.toMatch(/\b(INSERT|UPDATE|DELETE|UPSERT|MERGE)\b/i);
  });

  test("honors prefetchedObjects (no second describeGlobal round-trip)", async () => {
    const result = await profileSalesforce({
      url: URL,
      prefetchedObjects: [{ name: "Account", type: "table" }],
    });
    expect(result.profiles).toHaveLength(1);
    expect(mockDescribeGlobal).not.toHaveBeenCalled();
  });

  test("tolerates an empty SObject set", async () => {
    mockDescribeGlobal.mockImplementation(() => Promise.resolve({ sobjects: [] }));
    const result = await profileSalesforce({ url: URL });
    expect(result.profiles).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(mockDescribe).not.toHaveBeenCalled();
  });

  test("records a per-object error instead of throwing on a non-fatal describe failure", async () => {
    mockDescribe.mockImplementation((objectName: string) => {
      if (objectName === "Opportunity") {
        return Promise.reject(new Error("No such SObject 'Opportunity'"));
      }
      return Promise.resolve({ name: objectName, label: objectName, fields: [] });
    });

    const result = await profileSalesforce({
      url: URL,
      prefetchedObjects: [
        { name: "Account", type: "table" },
        { name: "Opportunity", type: "table" },
      ],
    });

    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0].table_name).toBe("Account");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].table).toBe("Opportunity");
    expect(result.errors[0].error).toContain("No such SObject");
  });

  test("aborts on a fatal connection/login error", async () => {
    mockDescribe.mockImplementation(() => Promise.reject(new Error("INVALID_SESSION_ID: session expired")));
    await expect(
      profileSalesforce({ url: URL, prefetchedObjects: [{ name: "Account", type: "table" }] }),
    ).rejects.toThrow(/Fatal Salesforce error/);
    // Connection is still closed on the abort path.
    expect(mockLogout).toHaveBeenCalled();
  });

  test("never surfaces credentials/tokens in a recorded per-object error", async () => {
    // A non-fatal error whose message echoed a secret must not leak it — the
    // profiler only records the error string the driver produced (it does not
    // append the url/token), and the driver message here carries no secret.
    mockDescribe.mockImplementation(() => Promise.reject(new Error("FIELD_INTEGRITY_EXCEPTION")));
    const result = await profileSalesforce({
      url: URL,
      prefetchedObjects: [{ name: "Account", type: "table" }],
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).not.toContain("SECRET");
    expect(result.errors[0].error).not.toContain("s3cret");
  });
});
