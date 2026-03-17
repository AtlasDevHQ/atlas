/**
 * Unit tests for POST /api/v1/validate-sql.
 *
 * Tests the route in isolation by creating a minimal Hono app with only
 * the validate-sql route mounted, avoiding the need to mock the entire
 * application dependency graph.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  mock,
  type Mock,
} from "bun:test";
import type { AuthResult } from "@atlas/api/lib/auth/types";
import { createConnectionMock } from "@atlas/api/testing/connection";

// --- Mocks ---

const mockAuthenticateRequest: Mock<
  (req: Request) => Promise<AuthResult>
> = mock(() =>
  Promise.resolve({
    authenticated: true as const,
    mode: "none" as const,
    user: undefined,
  }),
);

const mockCheckRateLimit: Mock<
  (key: string) => { allowed: boolean; retryAfterMs?: number }
> = mock(() => ({ allowed: true }));

const mockGetClientIP: Mock<(req: Request) => string | null> = mock(
  () => null,
);

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mockAuthenticateRequest,
  checkRateLimit: mockCheckRateLimit,
  getClientIP: mockGetClientIP,
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
  getRequestContext: () => null,
}));

const mockValidateSQL: Mock<
  (sql: string, connectionId?: string) => { valid: boolean; error?: string }
> = mock(() => ({ valid: true }));

const mockParserDatabase: Mock<(dbType: string, connectionId?: string) => string> = mock(
  () => "PostgresQL",
);

mock.module("@atlas/api/lib/tools/sql", () => ({
  validateSQL: mockValidateSQL,
  parserDatabase: mockParserDatabase,
  executeSQL: {},
}));

const mockTableList: Mock<(sql: string, opts?: unknown) => string[]> = mock(
  () => ["select::null::users", "select::null::orders"],
);

mock.module("node-sql-parser", () => ({
  Parser: class {
    tableList = mockTableList;
    astify = mock(() => ({ type: "select" }));
  },
}));

const mockDetectDBType: Mock<() => string> = mock(() => "postgres");
const mockGetDBType: Mock<(id: string) => string> = mock(() => "postgres");

mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    connections: {
      getDBType: mockGetDBType,
      get: mock(() => ({})),
      getDefault: mock(() => ({})),
      list: mock(() => ["default"]),
      getTargetHost: mock(() => null),
      getParserDialect: mock(() => null),
      getForbiddenPatterns: mock(() => []),
      getValidator: mock(() => null),
      getForOrg: () => ({}),
    },
    detectDBType: mockDetectDBType,
    getDB: mock(() => ({})),
    resolveDatasourceUrl: mock(() => "postgresql://test"),
  }),
);

mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => "none",
  resetAuthModeCache: () => {},
}));

// Import after mocks
const { Hono } = await import("hono");
const { validateSqlRoute } = await import("../routes/validate-sql");

const app = new Hono();
app.route("/api/v1/validate-sql", validateSqlRoute);

// --- Helpers ---

function makeRequest(body?: unknown): Request {
  return new Request("http://localhost/api/v1/validate-sql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? { sql: "SELECT id FROM users" }),
  });
}

// --- Tests ---

describe("POST /api/v1/validate-sql", () => {
  beforeEach(() => {
    mockAuthenticateRequest.mockReset();
    mockAuthenticateRequest.mockResolvedValue({
      authenticated: true as const,
      mode: "none" as const,
      user: undefined,
    });
    mockCheckRateLimit.mockReset();
    mockCheckRateLimit.mockReturnValue({ allowed: true });
    mockValidateSQL.mockReset();
    mockValidateSQL.mockReturnValue({ valid: true });
    mockTableList.mockReset();
    mockTableList.mockReturnValue(["select::null::users", "select::null::orders"]);
    mockDetectDBType.mockReset();
    mockDetectDBType.mockReturnValue("postgres");
    mockGetDBType.mockReset();
    mockGetDBType.mockReturnValue("postgres");
    mockParserDatabase.mockReset();
    mockParserDatabase.mockReturnValue("PostgresQL");
  });

  it("returns valid=true with tables for a valid SELECT", async () => {
    const response = await app.fetch(makeRequest({ sql: "SELECT id FROM users JOIN orders ON users.id = orders.user_id" }));
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.valid).toBe(true);
    expect(body.errors).toEqual([]);
    expect(body.tables).toEqual(["users", "orders"]);
    expect(mockValidateSQL).toHaveBeenCalledTimes(1);
  });

  it("returns valid=false with layer info when validation fails", async () => {
    mockValidateSQL.mockReturnValueOnce({
      valid: false,
      error: 'Forbidden SQL operation detected: \\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE)\\b',
    });

    const response = await app.fetch(makeRequest({ sql: "INSERT INTO users VALUES (1)" }));
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.valid).toBe(false);
    const errors = body.errors as Array<{ layer: string; message: string }>;
    expect(errors).toHaveLength(1);
    expect(errors[0].layer).toBe("regex_guard");
    expect(body.tables).toEqual([]);
  });

  it("maps empty query error to empty_check layer", async () => {
    // validateSQL returns "Empty query" for whitespace-only inputs like ";"
    mockValidateSQL.mockReturnValueOnce({ valid: false, error: "Empty query" });

    const response = await app.fetch(makeRequest({ sql: ";" }));
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.valid).toBe(false);
    const errors = body.errors as Array<{ layer: string; message: string }>;
    expect(errors[0].layer).toBe("empty_check");
  });

  it("maps parse error to ast_parse layer", async () => {
    mockValidateSQL.mockReturnValueOnce({
      valid: false,
      error: "Only SELECT statements are allowed, got: insert",
    });

    const response = await app.fetch(makeRequest({ sql: "DROP TABLE users" }));
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    const errors = body.errors as Array<{ layer: string; message: string }>;
    expect(errors[0].layer).toBe("ast_parse");
  });

  it("maps table whitelist error correctly", async () => {
    mockValidateSQL.mockReturnValueOnce({
      valid: false,
      error: 'Table "secret_table" is not in the allowed list. Check catalog.yml for available tables.',
    });

    const response = await app.fetch(makeRequest({ sql: "SELECT * FROM secret_table" }));
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    const errors = body.errors as Array<{ layer: string; message: string }>;
    expect(errors[0].layer).toBe("table_whitelist");
  });

  it("maps connection error correctly", async () => {
    mockValidateSQL.mockReturnValueOnce({
      valid: false,
      error: 'Connection "bad-conn" is not registered.',
    });

    const response = await app.fetch(
      makeRequest({ sql: "SELECT 1", connectionId: "bad-conn" }),
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    const errors = body.errors as Array<{ layer: string; message: string }>;
    expect(errors[0].layer).toBe("connection");
  });

  it("passes connectionId through to validateSQL", async () => {
    const response = await app.fetch(
      makeRequest({ sql: "SELECT 1", connectionId: "my-conn" }),
    );
    expect(response.status).toBe(200);
    expect(mockValidateSQL).toHaveBeenCalledWith("SELECT 1", "my-conn");
  });

  it("deduplicates extracted tables", async () => {
    mockTableList.mockReturnValueOnce([
      "select::null::users",
      "select::null::users",
      "select::null::orders",
    ]);

    const response = await app.fetch(makeRequest());
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.tables).toEqual(["users", "orders"]);
  });

  it("returns empty tables when table extraction fails", async () => {
    mockTableList.mockImplementationOnce(() => {
      throw new Error("Parser crash");
    });

    const response = await app.fetch(makeRequest());
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.valid).toBe(true);
    expect(body.tables).toEqual([]);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuthenticateRequest.mockResolvedValueOnce({
      authenticated: false as const,
      mode: "simple-key" as const,
      status: 401 as const,
      error: "API key required",
    });

    const response = await app.fetch(makeRequest());
    expect(response.status).toBe(401);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("auth_error");
    expect(mockValidateSQL).not.toHaveBeenCalled();
  });

  it("returns 429 when rate limited", async () => {
    mockCheckRateLimit.mockReturnValueOnce({
      allowed: false,
      retryAfterMs: 30000,
    });

    const response = await app.fetch(makeRequest());
    expect(response.status).toBe(429);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("rate_limited");
    expect(mockValidateSQL).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed JSON", async () => {
    const response = await app.fetch(
      new Request("http://localhost/api/v1/validate-sql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      }),
    );
    expect(response.status).toBe(400);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("invalid_request");
  });

  it("returns 422 for missing sql field", async () => {
    const response = await app.fetch(makeRequest({}));
    expect(response.status).toBe(422);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("validation_error");
  });

  it("returns 422 for empty sql string", async () => {
    const response = await app.fetch(makeRequest({ sql: "" }));
    expect(response.status).toBe(422);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("validation_error");
  });

  it("preserves schema qualifier for non-null schemas", async () => {
    mockTableList.mockReturnValueOnce([
      "select::null::users",
      "select::public::orders",
    ]);

    const response = await app.fetch(makeRequest());
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.tables).toEqual(["users", "public.orders"]);
  });

  it("maps unrecognized error to ast_parse layer (default fallback)", async () => {
    mockValidateSQL.mockReturnValueOnce({
      valid: false,
      error: "Unexpected parser failure: syntax error near 'FOOBAR'",
    });

    const response = await app.fetch(makeRequest({ sql: "FOOBAR" }));
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    const errors = body.errors as Array<{ layer: string; message: string }>;
    expect(errors[0].layer).toBe("ast_parse");
  });

  it("maps 'No valid datasource' error to connection layer", async () => {
    mockValidateSQL.mockReturnValueOnce({
      valid: false,
      error: "No valid datasource configured. Set ATLAS_DATASOURCE_URL to a PostgreSQL or MySQL connection string, or register a datasource plugin.",
    });

    const response = await app.fetch(makeRequest({ sql: "SELECT 1" }));
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    const errors = body.errors as Array<{ layer: string; message: string }>;
    expect(errors[0].layer).toBe("connection");
  });

  it("maps 'Could not verify table' error to table_whitelist layer", async () => {
    mockValidateSQL.mockReturnValueOnce({
      valid: false,
      error: "Could not verify table permissions. Rewrite using standard SQL syntax.",
    });

    const response = await app.fetch(makeRequest({ sql: "SELECT * FROM (complex)" }));
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    const errors = body.errors as Array<{ layer: string; message: string }>;
    expect(errors[0].layer).toBe("table_whitelist");
  });

  it("uses connections.getDBType when connectionId is set for table extraction", async () => {
    mockGetDBType.mockReturnValueOnce("mysql");

    const response = await app.fetch(
      makeRequest({ sql: "SELECT 1 FROM t", connectionId: "my-conn" }),
    );
    expect(response.status).toBe(200);
    expect(mockGetDBType).toHaveBeenCalledWith("my-conn");
    expect(mockDetectDBType).not.toHaveBeenCalled();
  });

  it("returns 422 for whitespace-only sql string", async () => {
    const response = await app.fetch(makeRequest({ sql: "   " }));
    expect(response.status).toBe(422);
    expect(mockValidateSQL).not.toHaveBeenCalled();
  });

  it("returns 500 when auth system throws", async () => {
    mockAuthenticateRequest.mockRejectedValueOnce(new Error("Redis connection lost"));

    const response = await app.fetch(makeRequest());
    expect(response.status).toBe(500);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("auth_error");
  });
});
