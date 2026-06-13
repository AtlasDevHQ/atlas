/**
 * Datasource lifecycle MCP tools (#3513 list/test/archive/restore, #3514
 * delete) — tool-level contract tests.
 *
 * Boundary: the real ADR-0016 gate pipeline is exhaustively covered in
 * `dispatch-gate.test.ts`. Here we mock `runMcpDispatchGate` to assert the
 * two halves of each tool's contract deterministically:
 *   1. it declares the CORRECT gate requirements (write/role/destructive) —
 *      especially that `delete_datasource` is destructive (approval-gated)
 *      and the read tools declare `requiresWrite: false`;
 *   2. it HONORS the gate's verdict — a denial / approval-required block is
 *      returned verbatim and the lib layer is never touched, while a `null`
 *      (proceed) runs the right lib call and shapes the right envelope.
 *
 * The lib layer (`mcp-lifecycle`) is mocked so the tools' dispatch + envelope
 * mapping is exercised without an internal DB / WorkspaceInstaller layer.
 */

import { describe, expect, it, mock, beforeEach } from "bun:test";
import { Effect } from "effect";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAtlasUser } from "@atlas/api/lib/auth/types";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { parseAtlasMcpToolError } from "@useatlas/types/mcp";

const TEST_ACTOR = createAtlasUser("u_ds", "managed", "ds@test", {
  role: "admin",
  activeOrganizationId: "org_ds",
});

// ── Lib-layer mocks (`mcp-lifecycle`) ─────────────────────────────────

const SAMPLE_SUMMARY = {
  id: "prod-us",
  dbType: "postgres",
  description: "Prod US",
  status: "published" as const,
  groupId: "prod",
  health: { status: "healthy", latencyMs: 12, checkedAt: "2026-06-13T00:00:00.000Z" },
};

const mockListDatasources = mock<(...a: unknown[]) => Promise<unknown>>(async () => [
  SAMPLE_SUMMARY,
  {
    id: "warehouse",
    dbType: "snowflake",
    description: null,
    status: "published" as const,
    groupId: null,
    health: null,
  },
]);

// `missing` resolves to null (not found); everything else to a slug.
const mockResolveCatalogSlug = mock<(...a: unknown[]) => Promise<string | null>>(
  async (_org: unknown, id: unknown) => (id === "missing" ? null : "postgres"),
);

const mockTestDatasource = mock<(...a: unknown[]) => Promise<unknown>>(async () => ({
  status: "healthy",
  latencyMs: 5,
  message: undefined,
  checkedAt: new Date("2026-06-13T00:00:00.000Z"),
}));

// `archived-ds` is unregistered (pool drained); everything else registered.
const mockIsRegistered = mock<(id: string) => boolean>((id) => id !== "archived-ds");

// Records the installer method/args the tool routes to, and returns a
// configurable outcome. Invokes the tool's `body(installer)` with a spy so
// archive (soft) vs delete (hard) vs restore is observable.
interface InstallerCall {
  method: "uninstallDatasource" | "updateDatasourceConfig";
  args: unknown[];
}
let installerCalls: InstallerCall[] = [];
let installerOutcome: unknown = {
  kind: "ok",
  value: { id: "prod-us", status: "published" },
};
const spyInstaller = {
  uninstallDatasource: (...args: unknown[]) => {
    installerCalls.push({ method: "uninstallDatasource", args });
    return Effect.void;
  },
  updateDatasourceConfig: (...args: unknown[]) => {
    installerCalls.push({ method: "updateDatasourceConfig", args });
    return Effect.succeed({ id: "prod-us", status: "published" });
  },
};
const mockRunInstaller = mock<(body: (i: unknown) => unknown) => Promise<unknown>>(
  async (body) => {
    body(spyInstaller);
    return installerOutcome;
  },
);

mock.module("@atlas/api/lib/datasources/mcp-lifecycle", () => ({
  listDatasources: mockListDatasources,
  resolveDatasourceCatalogSlug: mockResolveCatalogSlug,
  testDatasource: mockTestDatasource,
  isDatasourceRegistered: mockIsRegistered,
  runDatasourceInstaller: mockRunInstaller,
}));

// ── Dispatch-gate mock ────────────────────────────────────────────────

interface GateCall {
  ctx: { actor: { id: string }; orgId?: string; requesterId?: string };
  reqs: {
    toolName: string;
    requiresWrite: boolean;
    minRole: string;
    destructive?: { resource: string; description: string };
  };
}
let gateCalls: GateCall[] = [];
let gateReturn: CallToolResult | null = null;
const mockRunGate = mock(async (ctx: GateCall["ctx"], reqs: GateCall["reqs"]) => {
  gateCalls.push({ ctx, reqs });
  return gateReturn;
});

mock.module("../dispatch-gate.js", () => ({
  runMcpDispatchGate: mockRunGate,
}));

// Imports AFTER mock.module registrations.
const { registerDatasourceTools } = await import("../datasource-tools.js");

// ── Harness ───────────────────────────────────────────────────────────

function getContentText(content: unknown): string {
  const arr = content as Array<{ type: string; text: string }>;
  return arr[0]?.text ?? "";
}

async function createTestClient(actor = TEST_ACTOR, clientId?: string) {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  registerDatasourceTools(server, {
    actor,
    transport: "stdio",
    workspaceId: actor.activeOrganizationId ?? actor.id,
    deployMode: "self-hosted",
    ...(clientId ? { clientId } : {}),
  });
  const client = new Client({ name: "test-client", version: "0.0.1" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  await client.connect(c);
  return client;
}

function gateCallFor(tool: string): GateCall | undefined {
  return gateCalls.find((g) => g.reqs.toolName === tool);
}

beforeEach(() => {
  mockListDatasources.mockClear();
  mockResolveCatalogSlug.mockClear();
  mockTestDatasource.mockClear();
  mockIsRegistered.mockClear();
  mockRunInstaller.mockClear();
  mockRunGate.mockClear();
  gateCalls = [];
  installerCalls = [];
  gateReturn = null;
  installerOutcome = { kind: "ok", value: { id: "prod-us", status: "published" } };
});

// ── Tool registration ─────────────────────────────────────────────────

describe("datasource tools — registration", () => {
  it("registers all five lifecycle tools", async () => {
    const client = await createTestClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "archive_datasource",
        "delete_datasource",
        "list_datasources",
        "restore_datasource",
        "test_datasource",
      ].sort(),
    );
  });
});

// ── Gate requirements (the ADR-0016 contract per tool) ────────────────

describe("datasource tools — gate requirements", () => {
  it("read tools declare requiresWrite=false, admin role, no destructive", async () => {
    const client = await createTestClient();
    await client.callTool({ name: "list_datasources", arguments: {} });
    await client.callTool({ name: "test_datasource", arguments: { id: "prod-us" } });

    for (const tool of ["list_datasources", "test_datasource"]) {
      const g = gateCallFor(tool);
      expect(g?.reqs.requiresWrite).toBe(false);
      expect(g?.reqs.minRole).toBe("admin");
      expect(g?.reqs.destructive).toBeUndefined();
    }
  });

  it("archive/restore declare requiresWrite=true but are NOT destructive (reversible)", async () => {
    const client = await createTestClient();
    await client.callTool({ name: "archive_datasource", arguments: { id: "prod-us" } });
    await client.callTool({ name: "restore_datasource", arguments: { id: "prod-us" } });

    for (const tool of ["archive_datasource", "restore_datasource"]) {
      const g = gateCallFor(tool);
      expect(g?.reqs.requiresWrite).toBe(true);
      expect(g?.reqs.minRole).toBe("admin");
      expect(g?.reqs.destructive).toBeUndefined();
    }
  });

  it("delete declares destructive with an approval-matchable resource (#3514)", async () => {
    const client = await createTestClient();
    await client.callTool({ name: "delete_datasource", arguments: { id: "prod-us" } });
    const g = gateCallFor("delete_datasource");
    expect(g?.reqs.requiresWrite).toBe(true);
    expect(g?.reqs.minRole).toBe("admin");
    expect(g?.reqs.destructive?.resource).toBe("datasource:prod-us");
    expect(g?.reqs.destructive?.description).toContain("Delete datasource");
  });

  it("threads the bound actor's identity into the gate context", async () => {
    const client = await createTestClient();
    await client.callTool({ name: "delete_datasource", arguments: { id: "prod-us" } });
    const g = gateCallFor("delete_datasource");
    expect(g?.ctx.orgId).toBe("org_ds");
    expect(g?.ctx.requesterId).toBe("u_ds");
  });
});

// ── Gate verdict is honored ───────────────────────────────────────────

describe("datasource tools — honor the gate verdict", () => {
  it("a gate denial short-circuits BEFORE any lib call", async () => {
    gateReturn = {
      content: [{ type: "text", text: JSON.stringify({ code: "forbidden", message: "nope" }) }],
      isError: true,
    };
    const client = await createTestClient();
    const res = await client.callTool({ name: "delete_datasource", arguments: { id: "prod-us" } });
    expect(res.isError).toBe(true);
    expect(parseAtlasMcpToolError(getContentText(res.content))?.code).toBe("forbidden");
    // Neither the slug lookup nor the installer ran.
    expect(mockResolveCatalogSlug).not.toHaveBeenCalled();
    expect(mockRunInstaller).not.toHaveBeenCalled();
  });

  it("an approval-required block is surfaced verbatim and the installer never runs (#3514)", async () => {
    gateReturn = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            approval_required: true,
            approval_request_id: "req_42",
            matched_rules: ["MCP destructive"],
            message: "needs approval",
          }),
        },
      ],
    };
    const client = await createTestClient();
    const res = await client.callTool({ name: "delete_datasource", arguments: { id: "prod-us" } });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(getContentText(res.content));
    expect(body.approval_required).toBe(true);
    expect(body.approval_request_id).toBe("req_42");
    expect(mockRunInstaller).not.toHaveBeenCalled();
  });
});

// ── Happy paths + envelope mapping (gate returns null) ────────────────

describe("list_datasources", () => {
  it("returns credential-free summaries (no url / secret keys)", async () => {
    const client = await createTestClient();
    const res = await client.callTool({ name: "list_datasources", arguments: {} });
    const text = getContentText(res.content);
    const body = JSON.parse(text);
    expect(body.count).toBe(2);
    expect(body.datasources[0].id).toBe("prod-us");
    // Masking guarantee — the serialized payload must carry no credential.
    expect(text).not.toContain("url");
    expect(text).not.toContain("password");
    expect(text.toLowerCase()).not.toContain("secret");
  });

  it("passes include_archived through to the lib layer", async () => {
    const client = await createTestClient();
    await client.callTool({ name: "list_datasources", arguments: { include_archived: true } });
    const call = mockListDatasources.mock.calls[0];
    expect(call?.[2]).toEqual({ includeArchived: true });
  });

  it("filters by substring across id / dbType / description", async () => {
    const client = await createTestClient();
    const res = await client.callTool({ name: "list_datasources", arguments: { filter: "snow" } });
    const body = JSON.parse(getContentText(res.content));
    expect(body.count).toBe(1);
    expect(body.datasources[0].id).toBe("warehouse");
  });
});

describe("test_datasource", () => {
  it("returns the health probe for a registered datasource", async () => {
    const client = await createTestClient();
    const res = await client.callTool({ name: "test_datasource", arguments: { id: "prod-us" } });
    const body = JSON.parse(getContentText(res.content));
    expect(body.id).toBe("prod-us");
    expect(body.status).toBe("healthy");
    expect(body.latency_ms).toBe(5);
    expect(body.checked_at).toBe("2026-06-13T00:00:00.000Z");
  });

  it("an unregistered/archived datasource → unknown_entity", async () => {
    const client = await createTestClient();
    const res = await client.callTool({ name: "test_datasource", arguments: { id: "archived-ds" } });
    expect(res.isError).toBe(true);
    expect(parseAtlasMcpToolError(getContentText(res.content))?.code).toBe("unknown_entity");
    expect(mockTestDatasource).not.toHaveBeenCalled();
  });
});

describe("archive_datasource", () => {
  it("routes to a SOFT uninstall (no hard flag) and reports archived", async () => {
    const client = await createTestClient();
    const res = await client.callTool({ name: "archive_datasource", arguments: { id: "prod-us" } });
    const body = JSON.parse(getContentText(res.content));
    expect(body.archived).toBe(true);
    expect(body.status).toBe("archived");
    const call = installerCalls[0];
    expect(call.method).toBe("uninstallDatasource");
    // (workspaceId, catalogSlug, installId) — no { hard: true } 4th arg.
    expect(call.args[3]).toBeUndefined();
    expect(call.args[2]).toBe("prod-us");
  });

  it("a missing datasource → unknown_entity, installer not called", async () => {
    const client = await createTestClient();
    const res = await client.callTool({ name: "archive_datasource", arguments: { id: "missing" } });
    expect(parseAtlasMcpToolError(getContentText(res.content))?.code).toBe("unknown_entity");
    expect(mockRunInstaller).not.toHaveBeenCalled();
  });
});

describe("restore_datasource", () => {
  it("routes to updateDatasourceConfig({ status: 'published' }) and reports restored", async () => {
    const client = await createTestClient();
    const res = await client.callTool({ name: "restore_datasource", arguments: { id: "prod-us" } });
    const body = JSON.parse(getContentText(res.content));
    expect(body.restored).toBe(true);
    const call = installerCalls[0];
    expect(call.method).toBe("updateDatasourceConfig");
    expect(call.args[3]).toEqual({ status: "published" });
  });
});

describe("delete_datasource", () => {
  it("routes to a HARD uninstall and reports deleted", async () => {
    const client = await createTestClient();
    const res = await client.callTool({ name: "delete_datasource", arguments: { id: "prod-us" } });
    const body = JSON.parse(getContentText(res.content));
    expect(body.deleted).toBe(true);
    const call = installerCalls[0];
    expect(call.method).toBe("uninstallDatasource");
    expect(call.args[3]).toEqual({ hard: true });
  });

  it("a missing datasource → unknown_entity, installer not called", async () => {
    const client = await createTestClient();
    const res = await client.callTool({ name: "delete_datasource", arguments: { id: "missing" } });
    expect(parseAtlasMcpToolError(getContentText(res.content))?.code).toBe("unknown_entity");
    expect(mockRunInstaller).not.toHaveBeenCalled();
  });

  it("an installer error outcome maps to a typed envelope (validation_failed)", async () => {
    installerOutcome = {
      kind: "error",
      status: 400,
      code: "bad_request",
      message: "install_id \"default\" is reserved",
      body: {},
    };
    const client = await createTestClient();
    const res = await client.callTool({ name: "delete_datasource", arguments: { id: "prod-us" } });
    expect(res.isError).toBe(true);
    expect(parseAtlasMcpToolError(getContentText(res.content))?.code).toBe("validation_failed");
  });
});
