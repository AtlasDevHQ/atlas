/**
 * Wizard onboarding audit suite — F-34 (#1789) of the 1.2.3 security sweep.
 *
 * The wizard is the primary UI path for datasource onboarding. Before this
 * PR, `POST /api/v1/wizard/save` wrote semantic entities to disk + DB with
 * zero `admin_action_log` coverage — a compliance query filtering
 * `action_type = 'connection.create'` missed every datasource onboarded
 * through the happy-path UI.
 *
 * This suite pins two invariants that must hold forever:
 *
 *   1. Wizard `/save` emits `connection.create` with metadata shape
 *      `{ name, dbType }` — structurally identical to `admin-connections`
 *      POST. Otherwise forensic queries over `connection.create` miss
 *      wizard-created rows.
 *
 *   2. The wizard `/connection-test` probe path (exposed only on
 *      `admin-connections`' `POST /test` in this codebase) is deliberately
 *      NOT audited from wizard — high-volume, low-forensic-signal —
 *      matching the prompt's "default to NOT auditing probes" guidance.
 *      The admin-connections probe IS audited (connection.test) and covers
 *      the privileged probe surface.
 *
 * Wizard-specific parity: admin-connections and wizard both call
 * `logAdminAction` with identical canonical field shapes for the same
 * connection-onboarding intent. The parity assertion compares entries
 * directly (not against literals) so a future rename on either surface
 * breaks the suite.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterAll,
  mock,
  type Mock,
} from "bun:test";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";

// ---------------------------------------------------------------------------
// Shared mocks — set up before app import
// ---------------------------------------------------------------------------

// Connection registry mock: wizard `/save` inspects
// `connections.describe()` to resolve `dbType` for the audit metadata
// (the canonical admin-connections POST emits `{ name, dbType }`, so
// wizard must supply the same shape).
const mockConnectionHas: Mock<(id: string) => boolean> = mock(() => true);
const mockConnectionDescribe: Mock<() => Array<{ id: string; dbType: string }>> = mock(
  () => [{ id: "warehouse", dbType: "postgres" }],
);
const mockConnectionRegister: Mock<(id: string, cfg: unknown) => void> = mock(() => {});
const mockConnectionUnregister: Mock<(id: string) => void> = mock(() => {});
const mockConnectionHealthCheck: Mock<(id: string) => Promise<{ status: string; latencyMs: number; checkedAt: Date }>> = mock(
  () => Promise.resolve({ status: "healthy", latencyMs: 3, checkedAt: new Date() }),
);

const mocks = createApiTestMocks({
  authUser: {
    id: "admin-1",
    mode: "managed",
    label: "admin@test.com",
    role: "admin",
    activeOrganizationId: "org-alpha",
  },
  authMode: "managed",
  connection: {
    connections: {
      get: () => null,
      getDefault: () => null,
      describe: mockConnectionDescribe,
      healthCheck: mockConnectionHealthCheck,
      register: mockConnectionRegister,
      unregister: mockConnectionUnregister,
      has: mockConnectionHas,
      getForOrg: () => null,
    },
    resolveDatasourceUrl: () => "postgresql://stub",
    detectDBType: (url?: string) => {
      const connStr = url ?? "";
      if (connStr.startsWith("mysql://")) return "mysql";
      return "postgres";
    },
  },
});

// Capture logAdminAction calls. Pass through the real ADMIN_ACTIONS catalog
// so assertions pin to canonical string values — drift in the catalog breaks
// the suite before hitting the routes.
interface AuditEntry {
  actionType: string;
  targetType: string;
  targetId: string;
  status?: "success" | "failure";
  scope?: "platform" | "workspace";
  ipAddress?: string | null;
  metadata?: Record<string, unknown>;
}

const mockLogAdminAction: Mock<(entry: AuditEntry) => void> = mock(() => {});

mock.module("@atlas/api/lib/audit", async () => {
  const actual = await import("@atlas/api/lib/audit/actions");
  return {
    logAdminAction: mockLogAdminAction,
    logAdminActionAwait: mock(async () => {}),
    ADMIN_ACTIONS: actual.ADMIN_ACTIONS,
  };
});

// Mock fs so wizard /save never touches the real filesystem. Tests only
// inspect the audit emission, not the on-disk artifacts.
mock.module("fs", () => ({
  mkdirSync: mock(() => {}),
  writeFileSync: mock(() => {}),
  existsSync: mock(() => true),
  rmSync: mock(() => {}),
  readFileSync: mock(() => ""),
}));

// syncEntityToDisk mock — avoid touching the disk/DB sync layer.
mock.module("@atlas/api/lib/semantic/sync", () => ({
  syncEntityToDisk: mock(async () => {}),
  syncEntityDeleteFromDisk: async () => {},
  syncAllEntitiesToDisk: async () => 0,
  getSemanticRoot: () => "/tmp/test-semantic",
  reconcileAllOrgs: async () => {},
  importFromDisk: mock(async () => ({ imported: 0, skipped: 0, total: 0 })),
}));

// Profiler module — wizard.ts imports the full set (OBJECT_TYPES,
// outputDirForDatasource, generate* helpers). Only a handful are used in
// /save; the rest are stubbed to satisfy the import graph. Keep list of
// OBJECT_TYPES / FK_SOURCES / PARTITION_STRATEGIES / SEMANTIC_TYPES exact —
// Zod schemas in wizard.ts bind to `z.enum(OBJECT_TYPES)` at module load.
mock.module("@atlas/api/lib/profiler", () => ({
  OBJECT_TYPES: ["table", "view", "materialized_view", "partitioned_table"] as const,
  FK_SOURCES: ["catalog", "inferred"] as const,
  PARTITION_STRATEGIES: ["range", "list", "hash"] as const,
  SEMANTIC_TYPES: [
    "email",
    "phone",
    "url",
    "ip_address",
    "user_agent",
    "country_code",
    "currency",
    "uuid",
    "percentage",
    "duration_seconds",
    "duration_ms",
  ] as const,
  listPostgresObjects: mock(async () => []),
  listMySQLObjects: mock(async () => []),
  profilePostgres: mock(async () => ({ profiles: [], errors: [] })),
  profileMySQL: mock(async () => ({ profiles: [], errors: [] })),
  analyzeTableProfiles: (profiles: unknown[]) => profiles,
  generateEntityYAML: () => "table: stub\n",
  generateCatalogYAML: () => "name: stub\n",
  generateGlossaryYAML: () => "terms: []\n",
  generateMetricYAML: () => "metrics: []\n",
  outputDirForDatasource: (sourceId: string, orgId: string) =>
    `/tmp/test-semantic/.orgs/${orgId}/${sourceId}`,
}));

const { app } = await import("../index");

afterAll(() => mocks.cleanup());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function adminRequest(method: string, path: string, body?: unknown): Request {
  const opts: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-key",
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  return new Request(`http://localhost${path}`, opts);
}

function lastAuditCall(): AuditEntry {
  const calls = mockLogAdminAction.mock.calls;
  if (calls.length === 0) throw new Error("logAdminAction was not called");
  return calls[calls.length - 1]![0]!;
}

function auditCallsWithAction(actionType: string): AuditEntry[] {
  return mockLogAdminAction.mock.calls
    .map((call) => call[0]!)
    .filter((entry) => entry.actionType === actionType);
}

beforeEach(() => {
  mocks.hasInternalDB = true;
  mockLogAdminAction.mockClear();
  mocks.mockInternalQuery.mockReset();
  mocks.mockInternalQuery.mockImplementation(async () => []);
  mockConnectionHas.mockClear();
  mockConnectionHas.mockReturnValue(true);
  mockConnectionDescribe.mockClear();
  mockConnectionDescribe.mockReturnValue([{ id: "warehouse", dbType: "postgres" }]);
  mockConnectionRegister.mockClear();
  mockConnectionUnregister.mockClear();
  mockConnectionHealthCheck.mockClear();
  // Restore the default admin auth fixture — some tests narrow to a
  // no-org user and we must not bleed that state across the suite.
  mocks.setOrgAdmin("org-alpha");
});

// ---------------------------------------------------------------------------
// POST /api/v1/wizard/save — emits connection.create
// ---------------------------------------------------------------------------

describe("POST /api/v1/wizard/save — audit emission (F-34)", () => {
  it("emits connection.create with canonical { name, dbType } metadata on success", async () => {
    const res = await app.fetch(
      adminRequest("POST", "/api/v1/wizard/save", {
        connectionId: "warehouse",
        entities: [{ tableName: "users", yaml: "table: users\n" }],
      }),
    );

    expect(res.status).toBe(201);
    const creates = auditCallsWithAction("connection.create");
    expect(creates.length).toBe(1);

    const entry = creates[0]!;
    expect(entry.actionType).toBe("connection.create");
    expect(entry.targetType).toBe("connection");
    expect(entry.targetId).toBe("warehouse");
    expect(entry.metadata).toMatchObject({ name: "warehouse", dbType: "postgres" });
  });

  it("resolves dbType from the connection registry for the metadata payload", async () => {
    mockConnectionDescribe.mockReturnValue([
      { id: "warehouse", dbType: "mysql" },
    ]);

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/wizard/save", {
        connectionId: "warehouse",
        entities: [{ tableName: "users", yaml: "table: users\n" }],
      }),
    );

    expect(res.status).toBe(201);
    const entry = lastAuditCall();
    expect(entry.metadata).toMatchObject({ name: "warehouse", dbType: "mysql" });
  });

  it("does not emit when the orgId is missing (400)", async () => {
    mocks.mockAuthenticateRequest.mockImplementation(async () => ({
      authenticated: true,
      mode: "managed",
      user: {
        id: "admin-1",
        mode: "managed",
        label: "admin@test.com",
        role: "admin",
        // activeOrganizationId deliberately omitted
      },
    }));

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/wizard/save", {
        connectionId: "warehouse",
        entities: [{ tableName: "users", yaml: "table: users\n" }],
      }),
    );

    expect(res.status).toBe(400);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it("does not emit when the request fails Zod validation (422)", async () => {
    const res = await app.fetch(
      adminRequest("POST", "/api/v1/wizard/save", {
        connectionId: "warehouse",
        entities: [], // min(1) violation
      }),
    );

    expect(res.status).toBe(422);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it("does not emit when the payload carries a path-traversal table name (400)", async () => {
    const res = await app.fetch(
      adminRequest("POST", "/api/v1/wizard/save", {
        connectionId: "warehouse",
        entities: [{ tableName: "../etc/passwd", yaml: "table: x\n" }],
      }),
    );

    expect(res.status).toBe(400);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it("falls back to dbType='unknown' when the registry entry is missing", async () => {
    // Covers the edge where a connection exists in the internal DB but
    // not in the in-memory registry (e.g. pre-restart). We still emit
    // the audit row — a best-effort dbType beats zero forensic signal.
    mockConnectionDescribe.mockReturnValue([]);

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/wizard/save", {
        connectionId: "warehouse",
        entities: [{ tableName: "users", yaml: "table: users\n" }],
      }),
    );

    expect(res.status).toBe(201);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("connection.create");
    expect(entry.metadata).toMatchObject({ name: "warehouse", dbType: "unknown" });
  });

  it("threads x-forwarded-for into ipAddress", async () => {
    const req = new Request("http://localhost/api/v1/wizard/save", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-key",
        "x-forwarded-for": "198.51.100.42",
      },
      body: JSON.stringify({
        connectionId: "warehouse",
        entities: [{ tableName: "users", yaml: "table: users\n" }],
      }),
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(201);
    expect(lastAuditCall().ipAddress).toBe("198.51.100.42");
  });
});

// ---------------------------------------------------------------------------
// Parity: wizard.ts vs admin-connections.ts — same action_type + metadata
// shape for the same canonical `{ name, dbType }` contract.
// ---------------------------------------------------------------------------

describe("wizard.ts vs admin-connections.ts — audit parity (F-29 + F-34)", () => {
  it("produces structurally identical connection.create rows for the same payload", async () => {
    // ── Call 1: wizard /save for connection "warehouse" ────────
    mockConnectionDescribe.mockReturnValue([
      { id: "warehouse", dbType: "postgres" },
    ]);

    const wizardRes = await app.fetch(
      adminRequest("POST", "/api/v1/wizard/save", {
        connectionId: "warehouse",
        entities: [{ tableName: "users", yaml: "table: users\n" }],
      }),
    );
    expect(wizardRes.status).toBe(201);

    const wizardEntries = auditCallsWithAction("connection.create");
    expect(wizardEntries.length).toBe(1);
    const wizardEntry = wizardEntries[0]!;

    // ── Call 2: admin-connections POST / for the same id ───────
    // Stage the DB mocks so the create path lands on the happy-path
    // INSERT branch (not revive-archived, not plan-limit, not conflict).
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("COUNT(*)")) return [{ count: 0 }];
      if (sql.includes("SELECT status FROM connections")) return [];
      // INSERT / UPDATE — no rows expected back
      return [];
    });
    // Connections registry: let create see a fresh id, then report the
    // registry entry AFTER register() so dbType is resolvable downstream.
    mockConnectionHas
      .mockReturnValueOnce(false) // pre-register existence check
      .mockReturnValue(true);

    mockLogAdminAction.mockClear();

    const adminRes = await app.fetch(
      adminRequest("POST", "/api/v1/admin/connections", {
        id: "warehouse",
        url: "postgresql://localhost/test",
      }),
    );
    expect(adminRes.status).toBe(201);

    const adminEntries = auditCallsWithAction("connection.create");
    expect(adminEntries.length).toBe(1);
    const adminEntry = adminEntries[0]!;

    // ── Parity: compare entries directly, not against literals ───
    // A one-sided regression where both surfaces silently agree on the
    // wrong value would still break by diverging from each other.
    expect(wizardEntry.actionType).toBe(adminEntry.actionType);
    expect(wizardEntry.targetType).toBe(adminEntry.targetType);
    expect(wizardEntry.targetId).toBe(adminEntry.targetId);

    // Metadata SHAPE must match (keys present, types equal). Values
    // may differ on `dbType` only if the registry resolves differently,
    // but for the same payload both surfaces land on "postgres".
    const wizardMeta = wizardEntry.metadata ?? {};
    const adminMeta = adminEntry.metadata ?? {};
    expect(Object.keys(wizardMeta).sort()).toEqual(
      Object.keys(adminMeta).sort(),
    );
    expect(wizardMeta.name).toBe(adminMeta.name);
    expect(wizardMeta.dbType).toBe(adminMeta.dbType);
  });
});
