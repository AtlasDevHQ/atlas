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

// Phase-2 lib mocks (#3511 provision, #3512 profile).
let provisionOutcome: unknown = {
  kind: "ok",
  value: {
    installId: "new-pg",
    dbType: "postgres",
    status: "draft",
    maskedUrl: "postgres://***@host/db",
    description: null,
    schema: null,
    groupId: null,
  },
};
const mockProvision = mock<(...a: unknown[]) => Promise<unknown>>(async () => provisionOutcome);

let profileTarget: unknown = {
  kind: "ok",
  target: { url: "postgres://user:pass@host/db", dbType: "postgres", schema: "public" },
};
const mockLoadProfileTarget = mock<(...a: unknown[]) => Promise<unknown>>(async () => profileTarget);

let profileResult: unknown = {
  kind: "ok",
  result: {
    entities: [{ table: "orders", fileName: "orders.yml", yaml: "" }, { table: "users", fileName: "users.yml", yaml: "" }],
    metrics: [{ table: "orders", fileName: "orders.metric.yml", yaml: "" }],
    catalog: "",
    glossary: "",
    profiles: [],
    errors: [],
    elapsedMs: 1234,
  },
};
interface ProfileProgressLike {
  onStart?: (n: number) => void;
  onTableStart?: (name: string, i: number, t: number) => void;
  onTableDone?: (name: string, i: number, t: number) => void;
  onTableError?: (name: string, e: string, i: number, t: number) => void;
  onComplete?: () => void;
}
const mockRunProfile = mock<(...a: unknown[]) => Promise<unknown>>(async (...a: unknown[]) => {
  const opts = a[0] as { progress?: ProfileProgressLike };
  // Exercise the progress bridge so a regression in the callback shape is caught.
  opts.progress?.onStart?.(2);
  opts.progress?.onTableDone?.("orders", 0, 2);
  opts.progress?.onTableDone?.("users", 1, 2);
  opts.progress?.onComplete?.();
  return profileResult;
});

mock.module("@atlas/api/lib/datasources/mcp-lifecycle", () => ({
  listDatasources: mockListDatasources,
  resolveDatasourceCatalogSlug: mockResolveCatalogSlug,
  testDatasource: mockTestDatasource,
  isDatasourceRegistered: mockIsRegistered,
  runDatasourceInstaller: mockRunInstaller,
  provisionDatasource: mockProvision,
  loadDatasourceProfileTarget: mockLoadProfileTarget,
  runSemanticProfile: mockRunProfile,
  MCP_PROVISIONABLE_CATALOG_SLUGS: ["postgres", "mysql"],
}));

// Masked elicitation (#3499) — capture the call + return a configurable
// outcome. The default accepts with a sentinel secret we assert NEVER leaks.
const ELICITED_SECRET = "postgres://super:secret@db.internal:5432/prod";
let elicitOutcome: { action: "accept"; value: string } | { action: "decline" | "cancel" } = {
  action: "accept",
  value: ELICITED_SECRET,
};
let elicitThrows = false;
interface ElicitCall {
  principal: string;
  field: { name?: string; title: string };
}
let elicitCalls: ElicitCall[] = [];
const mockElicit = mock(async (_server: unknown, args: ElicitCall & { message: string }) => {
  elicitCalls.push({ principal: args.principal, field: args.field });
  if (elicitThrows) throw new Error("client does not support elicitation");
  return elicitOutcome;
});
mock.module("../elicitation.js", () => ({
  elicitMaskedField: mockElicit,
}));

// ── Dispatch-gate mock ────────────────────────────────────────────────

interface GateCall {
  ctx: { actor: { id: string }; orgId?: string; requesterId?: string };
  reqs: {
    toolName: string;
    requiresWrite: boolean;
    minRole: string;
    actionCategory?: string;
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
  mockProvision.mockClear();
  mockLoadProfileTarget.mockClear();
  mockRunProfile.mockClear();
  mockElicit.mockClear();
  gateCalls = [];
  installerCalls = [];
  elicitCalls = [];
  gateReturn = null;
  installerOutcome = { kind: "ok", value: { id: "prod-us", status: "published" } };
  provisionOutcome = {
    kind: "ok",
    value: {
      installId: "new-pg",
      dbType: "postgres",
      status: "draft",
      maskedUrl: "postgres://***@host/db",
      description: null,
      schema: null,
      groupId: null,
    },
  };
  profileTarget = {
    kind: "ok",
    target: { url: "postgres://user:pass@host/db", dbType: "postgres", schema: "public" },
  };
  profileResult = {
    kind: "ok",
    result: {
      entities: [{ table: "orders", fileName: "orders.yml", yaml: "" }, { table: "users", fileName: "users.yml", yaml: "" }],
      metrics: [{ table: "orders", fileName: "orders.metric.yml", yaml: "" }],
      catalog: "",
      glossary: "",
      profiles: [],
      errors: [],
      elapsedMs: 1234,
    },
  };
  elicitOutcome = { action: "accept", value: ELICITED_SECRET };
  elicitThrows = false;
});

// ── Tool registration ─────────────────────────────────────────────────

describe("datasource tools — registration", () => {
  it("registers all seven lifecycle tools", async () => {
    const client = await createTestClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "archive_datasource",
        "create_datasource",
        "delete_datasource",
        "list_datasources",
        "profile_datasource",
        "restore_datasource",
        "test_datasource",
      ].sort(),
    );
  });

  it("read tools declare readOnlyHint; mutating tools do not", async () => {
    const client = await createTestClient();
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get("list_datasources")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("test_datasource")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("delete_datasource")?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get("delete_datasource")?.annotations?.destructiveHint).toBe(true);
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

  it("every mutating tool declares actionCategory 'datasource' for the gate-1 kill-switch (#3509)", async () => {
    const client = await createTestClient();
    await client.callTool({ name: "archive_datasource", arguments: { id: "prod-us" } });
    await client.callTool({ name: "restore_datasource", arguments: { id: "prod-us" } });
    await client.callTool({ name: "delete_datasource", arguments: { id: "prod-us" } });
    await client.callTool({ name: "create_datasource", arguments: { db_type: "postgres", install_id: "new-pg" } });
    await client.callTool({ name: "profile_datasource", arguments: { id: "prod-us" } });
    for (const tool of [
      "archive_datasource",
      "restore_datasource",
      "delete_datasource",
      "create_datasource",
      "profile_datasource",
    ]) {
      expect(gateCallFor(tool)?.reqs.actionCategory).toBe("datasource");
    }
    // Read tools must NOT be category-gated (the kill-switch is for mutations).
    await client.callTool({ name: "list_datasources", arguments: {} });
    expect(gateCallFor("list_datasources")?.reqs.actionCategory).toBeUndefined();
  });

  it("create/profile declare requiresWrite=true, admin, and are NOT destructive", async () => {
    const client = await createTestClient();
    await client.callTool({ name: "create_datasource", arguments: { db_type: "postgres", install_id: "new-pg" } });
    await client.callTool({ name: "profile_datasource", arguments: { id: "prod-us" } });
    for (const tool of ["create_datasource", "profile_datasource"]) {
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

  it("the action-policy kill-switch block (gate-1, #3509/#3514) short-circuits delete", async () => {
    // gate-1 denial is shaped as a `forbidden` envelope by runMcpDispatchGate;
    // the tool must surface it and never reach the installer.
    gateReturn = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            code: "forbidden",
            message: "Datasource actions are disabled for this workspace by policy.",
          }),
        },
      ],
      isError: true,
    };
    const client = await createTestClient();
    const res = await client.callTool({ name: "delete_datasource", arguments: { id: "prod-us" } });
    expect(res.isError).toBe(true);
    expect(parseAtlasMcpToolError(getContentText(res.content))?.code).toBe("forbidden");
    expect(mockRunInstaller).not.toHaveBeenCalled();
  });
});

// ── No-org session guard (mutations) ──────────────────────────────────

describe("no bound workspace → mutations refused (consistency with gate orgId)", () => {
  const NO_ORG_ACTOR = createAtlasUser("u_noorg", "managed", "noorg@test", { role: "admin" });

  for (const tool of ["archive_datasource", "restore_datasource", "delete_datasource", "profile_datasource"]) {
    it(`${tool} → forbidden, no lib mutation`, async () => {
      const client = await createTestClient(NO_ORG_ACTOR);
      const res = await client.callTool({ name: tool, arguments: { id: "prod-us" } });
      expect(res.isError).toBe(true);
      expect(parseAtlasMcpToolError(getContentText(res.content))?.code).toBe("forbidden");
      expect(mockRunInstaller).not.toHaveBeenCalled();
      expect(mockRunProfile).not.toHaveBeenCalled();
    });
  }

  it("create_datasource → forbidden before elicitation", async () => {
    const client = await createTestClient(NO_ORG_ACTOR);
    const res = await client.callTool({
      name: "create_datasource",
      arguments: { db_type: "postgres", install_id: "x" },
    });
    expect(parseAtlasMcpToolError(getContentText(res.content))?.code).toBe("forbidden");
    expect(mockElicit).not.toHaveBeenCalled();
    expect(mockProvision).not.toHaveBeenCalled();
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

  it("lists in developer mode so freshly-created drafts are discoverable", async () => {
    const client = await createTestClient();
    await client.callTool({ name: "list_datasources", arguments: {} });
    // (orgId, mode, options) — mode must include drafts.
    expect(mockListDatasources.mock.calls[0]?.[1]).toBe("developer");
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

// ── create_datasource (#3511) — masked-elicitation credential ─────────

describe("create_datasource", () => {
  it("collects the URL via masked elicitation bound to the workspace, then provisions", async () => {
    const client = await createTestClient();
    const res = await client.callTool({
      name: "create_datasource",
      arguments: { db_type: "postgres", install_id: "new-pg" },
    });
    // Elicitation was called, bound to the org, for a field named `url`.
    expect(elicitCalls).toHaveLength(1);
    expect(elicitCalls[0].principal).toBe("org_ds");
    expect(elicitCalls[0].field.name).toBe("url");
    // The secret reached provisionDatasource (the lib), in `url`.
    const provisionArgs = mockProvision.mock.calls[0];
    expect((provisionArgs?.[1] as { url: string }).url).toBe(ELICITED_SECRET);

    const body = JSON.parse(getContentText(res.content));
    expect(body.created).toBe(true);
    expect(body.status).toBe("draft");
  });

  it("NEVER leaks the elicited credential into the tool response", async () => {
    const client = await createTestClient();
    const res = await client.callTool({
      name: "create_datasource",
      arguments: { db_type: "postgres", install_id: "new-pg" },
    });
    const text = getContentText(res.content);
    expect(text).not.toContain(ELICITED_SECRET);
    expect(text).not.toContain("super:secret");
    // Only the masked URL is surfaced.
    expect(text).toContain("***");
  });

  it("a declined/cancelled elicitation → validation_failed, nothing provisioned", async () => {
    elicitOutcome = { action: "decline" };
    const client = await createTestClient();
    const res = await client.callTool({
      name: "create_datasource",
      arguments: { db_type: "postgres", install_id: "new-pg" },
    });
    expect(res.isError).toBe(true);
    expect(parseAtlasMcpToolError(getContentText(res.content))?.code).toBe("validation_failed");
    expect(mockProvision).not.toHaveBeenCalled();
  });

  it("an elicitation failure (unsupported client) → validation_failed, no leak", async () => {
    elicitThrows = true;
    const client = await createTestClient();
    const res = await client.callTool({
      name: "create_datasource",
      arguments: { db_type: "postgres", install_id: "new-pg" },
    });
    expect(parseAtlasMcpToolError(getContentText(res.content))?.code).toBe("validation_failed");
    expect(mockProvision).not.toHaveBeenCalled();
  });

  it("a pre-flight health failure surfaces validation_failed (credential-scrubbed by lib)", async () => {
    provisionOutcome = { kind: "health_error", message: "Connection test failed: timeout. Verify the host…" };
    const client = await createTestClient();
    const res = await client.callTool({
      name: "create_datasource",
      arguments: { db_type: "postgres", install_id: "new-pg" },
    });
    expect(res.isError).toBe(true);
    expect(parseAtlasMcpToolError(getContentText(res.content))?.code).toBe("validation_failed");
  });

  it("an unsupported db_type is rejected at the inputSchema boundary", async () => {
    // `db_type` is a Zod enum of provisionable slugs — an out-of-enum value
    // is rejected by the SDK's input validation (error result), so it never
    // reaches the handler / elicitation.
    const client = await createTestClient();
    const res = await client.callTool({
      name: "create_datasource",
      arguments: { db_type: "snowflake", install_id: "x" },
    });
    expect(res.isError).toBe(true);
    expect(mockElicit).not.toHaveBeenCalled();
    expect(mockProvision).not.toHaveBeenCalled();
  });
});

// ── profile_datasource (#3512) — long-running, progress + cancellable ──

describe("profile_datasource", () => {
  it("profiles + generates and reports the datasource as queryable", async () => {
    const client = await createTestClient();
    const res = await client.callTool({ name: "profile_datasource", arguments: { id: "prod-us" } });
    const body = JSON.parse(getContentText(res.content));
    expect(body.queryable).toBe(true);
    expect(body.entities_generated).toBe(2);
    expect(body.tables).toEqual(["orders", "users"]);
    expect(body.elapsed_ms).toBe(1234);
    // The decrypted URL the profiler used must not surface.
    expect(getContentText(res.content)).not.toContain("user:pass");
  });

  it("a not-found datasource → unknown_entity", async () => {
    profileTarget = { kind: "not_found" };
    const client = await createTestClient();
    const res = await client.callTool({ name: "profile_datasource", arguments: { id: "missing" } });
    expect(parseAtlasMcpToolError(getContentText(res.content))?.code).toBe("unknown_entity");
    expect(mockRunProfile).not.toHaveBeenCalled();
  });

  it("an unsupported dbType → validation_failed", async () => {
    profileTarget = { kind: "unsupported", dbType: "clickhouse" };
    const client = await createTestClient();
    const res = await client.callTool({ name: "profile_datasource", arguments: { id: "ch" } });
    expect(parseAtlasMcpToolError(getContentText(res.content))?.code).toBe("validation_failed");
    expect(mockRunProfile).not.toHaveBeenCalled();
  });

  it("a ProfilingFailedError outcome → validation_failed (not a 500)", async () => {
    profileResult = { kind: "error", reason: "no_tables", message: "No tables found to profile." };
    const client = await createTestClient();
    const res = await client.callTool({ name: "profile_datasource", arguments: { id: "prod-us" } });
    expect(parseAtlasMcpToolError(getContentText(res.content))?.code).toBe("validation_failed");
  });
});
