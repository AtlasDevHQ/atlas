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
import {
  mcpToolMutates,
  type McpToolAnnotationsShape,
} from "@atlas/api/lib/mcp/dispatch-gate-contract";

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

// Capability + config-field resolution (#3547). Defaults: provisionable native
// postgres with a single secret `url` field — the existing happy path.
let provisionCapability: unknown = { kind: "native", dbType: "postgres" };
const mockResolveCapability = mock<(...a: unknown[]) => Promise<unknown>>(async () => provisionCapability);
// Profiling capability (#3552) — the create_datasource success hint derives its
// "run profile_datasource" vs "not profilable" branch from this (the same
// resolver the profile tool uses). Default: native postgres → profilable.
let profileCapability: unknown = { kind: "native", dbType: "postgres" };
const mockResolveProfileCapability = mock<(...a: unknown[]) => Promise<unknown>>(
  async () => profileCapability,
);
let provisionConfigFields: unknown = {
  kind: "ok",
  fields: [
    { key: "url", label: "Connection URL", description: "postgres://…", required: true, secret: true },
  ],
  secretKeys: ["url"],
};
const mockLoadConfigFields = mock<(...a: unknown[]) => Promise<unknown>>(async () => provisionConfigFields);

// REST/OpenAPI provisioning (#3547) — the openapi-generic form-install seam.
let provisionRestOutcome: unknown = { kind: "ok", installId: "rest-abc123" };
const mockProvisionRest = mock<(...a: unknown[]) => Promise<unknown>>(async () => provisionRestOutcome);

// #3667 — the profile tool resolves a LIVE connection (across all transports)
// and profiles it. `okConn` builds the resolved-ok result with introspection as
// a capability of the connection (bound creds — no url/config surfaced).
function okConn(connectionGroupId: string | null, dbType = "postgres"): unknown {
  return {
    kind: "ok",
    connection: {
      dbType,
      connectionGroupId,
      query: async () => ({ columns: [], rows: [] }),
      listObjects: async () => [],
      profile: async () => ({ profiles: [], errors: [] }),
      close: async () => {},
    },
  };
}
let resolvedConnection: unknown = okConn(null);
const mockResolveLiveConnection = mock<(...a: unknown[]) => Promise<unknown>>(async () => resolvedConnection);

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
  // #3546 — non-null when the layer was durably persisted as drafts.
  persisted: { entities: 2, metrics: 1 },
};
interface ProfileProgressLike {
  onStart?: (n: number) => void;
  onTableStart?: (name: string, i: number, t: number) => void;
  onTableDone?: (name: string, i: number, t: number) => void;
  onTableError?: (name: string, e: string, i: number, t: number) => void;
  onComplete?: () => void;
}
const mockProfileLive = mock<(...a: unknown[]) => Promise<unknown>>(async (...a: unknown[]) => {
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
  provisionRestDatasource: mockProvisionRest,
  resolveProvisionCapability: mockResolveCapability,
  // #3667 — the create-hint's profilability proxy (gate-free) + the profile
  // tool's unified resolver + connection-based profiler.
  resolveProfileCapabilityByDbType: mockResolveProfileCapability,
  loadProvisionConfigFields: mockLoadConfigFields,
  resolveLiveConnection: mockResolveLiveConnection,
  profileLiveDatasource: mockProfileLive,
  MCP_PROVISIONABLE_CATALOG_SLUGS: ["postgres", "mysql"],
}));

// Masked multi-field elicitation (#3499 / #3547) — capture the call + return a
// configurable outcome. The default accepts with a sentinel secret we assert
// NEVER leaks, keyed by the `url` field the default config-field set declares.
const ELICITED_SECRET = "postgres://super:secret@db.internal:5432/prod";
let elicitOutcome: { action: "accept"; values: Record<string, string> } | { action: "decline" | "cancel" } = {
  action: "accept",
  values: { url: ELICITED_SECRET },
};
let elicitThrows = false;
interface ElicitFormCall {
  principal: string;
  fields: Array<{ name: string; title: string; required?: boolean; secret?: boolean }>;
}
let elicitCalls: ElicitFormCall[] = [];
const mockElicit = mock(async (_server: unknown, args: ElicitFormCall & { message: string }) => {
  elicitCalls.push({ principal: args.principal, fields: args.fields });
  if (elicitThrows) throw new Error("client does not support elicitation");
  return elicitOutcome;
});
mock.module("../elicitation.js", () => ({
  elicitMaskedForm: mockElicit,
}));

// ── Dispatch-gate mock ────────────────────────────────────────────────

interface GateCall {
  ctx: { actor: { id: string }; orgId?: string; requesterId?: string };
  reqs: {
    toolName: string;
    checksBilling?: boolean;
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

// Billing is no longer invoked by this module: #3601 folded it into
// runMcpDispatchGate as gate-0, so a datasource tool only DECLARES
// `checksBilling` in its requirement set (asserted below). The gate-0 BLOCK
// behavior runs in dispatch-gate.test.ts where the real composer executes.

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
  mockProvisionRest.mockClear();
  mockResolveCapability.mockClear();
  mockResolveProfileCapability.mockClear();
  mockLoadConfigFields.mockClear();
  mockResolveLiveConnection.mockClear();
  mockProfileLive.mockClear();
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
  resolvedConnection = okConn(null);
  profileCapability = { kind: "native", dbType: "postgres" };
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
    persisted: { entities: 2, metrics: 1 },
  };
  elicitOutcome = { action: "accept", values: { url: ELICITED_SECRET } };
  elicitThrows = false;
  provisionCapability = { kind: "native", dbType: "postgres" };
  profileCapability = { kind: "native", dbType: "postgres" };
  provisionConfigFields = {
    kind: "ok",
    fields: [
      { key: "url", label: "Connection URL", description: "postgres://…", required: true, secret: true },
    ],
    secretKeys: ["url"],
  };
  provisionRestOutcome = { kind: "ok", installId: "rest-abc123" };
});

// ── Tool registration ─────────────────────────────────────────────────

describe("datasource tools — registration", () => {
  it("registers all eight lifecycle tools", async () => {
    const client = await createTestClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "archive_datasource",
        "create_datasource",
        "create_rest_datasource",
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

// ── Gate-0 billing is DECLARED, not hand-called (#3570/#3601) ──────────
//
// #3601 folded billing into runMcpDispatchGate as gate-0: every datasource
// tool — read AND write — declares `checksBilling: true` in its requirement
// set, and the single composer enforces it before gates 1-4. We assert the
// declarative requirement here (so a tool can never silently drop billing);
// the gate-0 BLOCK behavior (suspended workspace → `billing_blocked`,
// short-circuit before action-policy/scope/RBAC/approval) is exercised against
// the real composer in dispatch-gate.test.ts.

describe("datasource tools declare gate-0 billing (#3601)", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["list_datasources", {}],
    ["test_datasource", { id: "prod-us" }],
    ["archive_datasource", { id: "prod-us" }],
    ["restore_datasource", { id: "prod-us" }],
    ["delete_datasource", { id: "prod-us" }],
    ["profile_datasource", { id: "prod-us" }],
    ["create_datasource", { db_type: "postgres", install_id: "new-pg" }],
    ["create_rest_datasource", {}],
  ];
  for (const [tool, args] of cases) {
    it(`${tool} passes checksBilling:true so gate-0 enforces workspace solvency`, async () => {
      const client = await createTestClient();
      await client.callTool({ name: tool, arguments: args });
      expect(gateCallFor(tool)?.reqs.checksBilling).toBe(true);
    });
  }
});

// ── Single mutates notion (#3599) ─────────────────────────────────────
//
// The native datasource tools declare `requiresWrite` explicitly while plugin
// tools derive it via `mcpToolMutates(annotations)`. These must be ONE notion,
// not two that can drift: a tool's explicit `requiresWrite` must equal the
// shared predicate applied to its declared MCP annotations. The annotations
// below mirror each tool's `annotations:` block in datasource-tools.ts; if a
// tool's hand-set `requiresWrite` ever disagrees with its read/write hint this
// fails, pointing at the divergence.

describe("native requiresWrite agrees with the shared mcpToolMutates predicate (#3599)", () => {
  const annotationsByTool: Record<string, McpToolAnnotationsShape> = {
    list_datasources: { readOnlyHint: true, openWorldHint: false },
    test_datasource: { readOnlyHint: true, openWorldHint: true },
    archive_datasource: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    restore_datasource: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    delete_datasource: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    create_datasource: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    create_rest_datasource: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    profile_datasource: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  };
  const args: Record<string, Record<string, unknown>> = {
    list_datasources: {},
    test_datasource: { id: "prod-us" },
    archive_datasource: { id: "prod-us" },
    restore_datasource: { id: "prod-us" },
    delete_datasource: { id: "prod-us" },
    profile_datasource: { id: "prod-us" },
    create_datasource: { db_type: "postgres", install_id: "new-pg" },
    create_rest_datasource: {},
  };
  for (const [tool, annotations] of Object.entries(annotationsByTool)) {
    it(`${tool}: requiresWrite === mcpToolMutates(annotations)`, async () => {
      const client = await createTestClient();
      await client.callTool({ name: tool, arguments: args[tool] });
      expect(gateCallFor(tool)?.reqs.requiresWrite).toBe(mcpToolMutates(annotations));
    });
  }
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
      expect(mockProfileLive).not.toHaveBeenCalled();
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
  it("revives to 'draft' (mirroring admin route) so the publish endpoint must promote it (#3588)", async () => {
    // AC: a created→archived→restored MCP datasource must NOT be published
    // without going through the atomic publish endpoint. The restore branch
    // stamps status:'draft' + atlasMode:'draft' — identical to the admin route
    // (admin-connections.ts #944-960, legacy #2177). Setting 'published' here
    // would bypass the content-mode gate (CLAUDE.md rule).
    const client = await createTestClient();
    const res = await client.callTool({ name: "restore_datasource", arguments: { id: "prod-us" } });
    const body = JSON.parse(getContentText(res.content));
    expect(body.restored).toBe(true);
    const call = installerCalls[0];
    expect(call.method).toBe("updateDatasourceConfig");
    // AC(1) — The installer must be called with status:'draft' + atlasMode:'draft'
    // (not 'published'). This is the content-mode gate: the restored datasource
    // lands as a draft and must go through /api/v1/admin/publish to become queryable.
    expect(call.args[3]).toEqual({ status: "draft", atlasMode: "draft" });
    // (The response body reflects whatever the installer returns — the critical
    // assertion is the CALL args above, not the response status string, because
    // the mock installer is free to return any status for test purposes.)
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
  it("collects config via the schema-driven masked form, then provisions", async () => {
    const client = await createTestClient();
    const res = await client.callTool({
      name: "create_datasource",
      arguments: { db_type: "postgres", install_id: "new-pg" },
    });
    // Elicitation was a masked FORM bound to the org, carrying the catalog's
    // `url` field (marked required + secret).
    expect(elicitCalls).toHaveLength(1);
    expect(elicitCalls[0].principal).toBe("org_ds");
    expect(elicitCalls[0].fields.map((f) => f.name)).toEqual(["url"]);
    expect(elicitCalls[0].fields[0].secret).toBe(true);
    // The secret reached provisionDatasource (the lib) inside `config`, with
    // `secretKeys` driving the scrub.
    const provisionArgs = mockProvision.mock.calls[0];
    const input = provisionArgs?.[1] as { config: Record<string, string>; secretKeys: string[] };
    expect(input.config.url).toBe(ELICITED_SECRET);
    expect(input.secretKeys).toEqual(["url"]);

    const body = JSON.parse(getContentText(res.content));
    expect(body.created).toBe(true);
    expect(body.status).toBe("draft");
  });

  it("collects multi-field credentials (e.g. Elasticsearch apiKey) as one masked form", async () => {
    // ES: non-secret url + secret apiKey — the config_schema drives the form.
    provisionConfigFields = {
      kind: "ok",
      fields: [
        { key: "url", label: "Connection URL", required: true, secret: false },
        { key: "apiKey", label: "API Key", required: false, secret: true },
      ],
      secretKeys: ["apiKey"],
    };
    provisionCapability = { kind: "plugin", dbType: "elasticsearch" };
    elicitOutcome = { action: "accept", values: { url: "elasticsearch://h:9200", apiKey: "BASE64KEY==" } };
    const client = await createTestClient();
    await client.callTool({
      name: "create_datasource",
      arguments: { db_type: "elasticsearch", install_id: "logs" },
    });
    expect(elicitCalls[0].fields.map((f) => f.name)).toEqual(["url", "apiKey"]);
    const input = mockProvision.mock.calls[0]?.[1] as { config: Record<string, string>; secretKeys: string[] };
    expect(input.config).toEqual({ url: "elasticsearch://h:9200", apiKey: "BASE64KEY==" });
    expect(input.secretKeys).toEqual(["apiKey"]);
  });

  it("merges the optional non-secret schema (search_path) tool arg into config — not into the masked prompt", async () => {
    const client = await createTestClient();
    await client.callTool({
      name: "create_datasource",
      arguments: { db_type: "postgres", install_id: "new-pg", schema: "analytics" },
    });
    // `schema` is an agent-set arg, NOT an elicited credential field.
    expect(elicitCalls[0].fields.map((f) => f.name)).toEqual(["url"]);
    const input = mockProvision.mock.calls[0]?.[1] as { config: Record<string, string> };
    expect(input.config.schema).toBe("analytics");
    expect(input.config.url).toBe(ELICITED_SECRET);
  });

  it("an unsupported (no-plugin) type is rejected BEFORE elicitation", async () => {
    provisionCapability = { kind: "unsupported", dbType: "clickhouse", message: "no clickhouse plugin installed" };
    const client = await createTestClient();
    const res = await client.callTool({
      name: "create_datasource",
      arguments: { db_type: "postgres", install_id: "x" },
    });
    expect(parseAtlasMcpToolError(getContentText(res.content))?.code).toBe("validation_failed");
    expect(mockElicit).not.toHaveBeenCalled();
    expect(mockProvision).not.toHaveBeenCalled();
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

  it("a non-compliant client that accepts with a required field blank → validation_failed, nothing provisioned", async () => {
    // elicitMaskedForm drops empty values, so a blank required `url` arrives as
    // an accept with no `url` key — the tool must reject before pre-flight.
    elicitOutcome = { action: "accept", values: {} };
    const client = await createTestClient();
    const res = await client.callTool({
      name: "create_datasource",
      arguments: { db_type: "postgres", install_id: "new-pg" },
    });
    expect(res.isError).toBe(true);
    const err = parseAtlasMcpToolError(getContentText(res.content));
    expect(err?.code).toBe("validation_failed");
    expect(err?.message).toContain("Connection URL"); // the required field's label
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

  it("a non-provisionable db_type is rejected at the inputSchema boundary", async () => {
    // `db_type` is a Zod enum of provisionable slugs (the real
    // MCP_PROVISIONABLE_CATALOG_SLUGS the tool imports directly). `duckdb` is a
    // real datasource slug but NOT MCP-provisionable, so it's an out-of-enum
    // value rejected by the SDK's input validation — never reaching the handler.
    const client = await createTestClient();
    const res = await client.callTool({
      name: "create_datasource",
      arguments: { db_type: "duckdb", install_id: "x" },
    });
    expect(res.isError).toBe(true);
    expect(mockElicit).not.toHaveBeenCalled();
    expect(mockProvision).not.toHaveBeenCalled();
  });

  it("#3587 — success hint tells user to run profile_datasource for profilable types (postgres/mysql)", async () => {
    // postgres is a native profilable type — the next-step hint must direct the
    // agent to run profile_datasource to generate the semantic layer. The hint
    // derives `profilable` from `resolveProfileCapabilityByDbType` (#3667 — an
    // accurate, gate-free proxy for what `profile_datasource` accepts now that
    // the URL-shape gate is gone), so the test drives THAT mock.
    profileCapability = { kind: "native", dbType: "postgres" };
    provisionOutcome = {
      kind: "ok",
      value: { installId: "new-pg", dbType: "postgres", status: "draft", maskedUrl: "postgres://***@host/db", description: null, schema: null, groupId: null },
    };
    const client = await createTestClient();
    const res = await client.callTool({ name: "create_datasource", arguments: { db_type: "postgres", install_id: "new-pg" } });
    const body = JSON.parse(getContentText(res.content));
    expect(body.created).toBe(true);
    // Resolved off the provisioned dbType.
    expect(mockResolveProfileCapability).toHaveBeenCalledWith("postgres");
    // Hint must tell the agent to run profile_datasource.
    expect(body.next).toContain("profile_datasource");
    // Must NOT warn about unavailable profiling for a profilable type.
    expect(body.next).not.toContain("not available in this deployment");
  });

  it("#3552 — success hint tells user to profile a PLUGIN type when its profiler IS registered", async () => {
    // clickhouse with a registered profiling plugin AND a url-shaped pool config
    // is profilable over MCP (#3552 / ADR-0017) — `loadDatasourceProfileTarget`
    // resolves to `ok`, so the hint directs the agent to run profile_datasource.
    provisionCapability = { kind: "plugin", dbType: "clickhouse" };
    profileCapability = { kind: "plugin", dbType: "clickhouse", profileFn: () => Promise.resolve({ profiles: [], errors: [] }) };
    provisionOutcome = {
      kind: "ok",
      value: { installId: "ch-wh", dbType: "clickhouse", status: "draft", maskedUrl: null, description: null, schema: null, groupId: null },
    };
    const client = await createTestClient();
    const res = await client.callTool({ name: "create_datasource", arguments: { db_type: "clickhouse", install_id: "ch-wh" } });
    const body = JSON.parse(getContentText(res.content));
    expect(body.created).toBe(true);
    expect(body.next).toContain("profile_datasource");
    expect(body.next).not.toContain("not available in this deployment");
  });

  it("#3587 — success hint does NOT advertise profile_datasource when the type's profiler is absent", async () => {
    // A plugin type provisionable (createFromConfig) but with no registered
    // `connection.profile` → `resolveProfileCapabilityByDbType` is `unsupported`.
    // The hint must NOT claim 'run profile_datasource' — that would leave the
    // agent in an impossible loop trying an unavailable operation.
    provisionCapability = { kind: "plugin", dbType: "clickhouse" };
    profileCapability = { kind: "unsupported", dbType: "clickhouse", message: "no profiler" };
    provisionOutcome = {
      kind: "ok",
      value: { installId: "ch-wh", dbType: "clickhouse", status: "draft", maskedUrl: null, description: null, schema: null, groupId: null },
    };
    const client = await createTestClient();
    const res = await client.callTool({ name: "create_datasource", arguments: { db_type: "clickhouse", install_id: "ch-wh" } });
    const body = JSON.parse(getContentText(res.content));
    expect(body.created).toBe(true);
    // Hint must NOT tell the agent to profile — that operation is unavailable.
    expect(body.next).not.toContain("profile_datasource");
    // Must clearly state profiling is not available in this deployment.
    expect(body.next).toContain("not available in this deployment");
  });

  it("#3667 — success hint DOES advertise profile_datasource for bigquery (the URL-shape gate is gone)", async () => {
    // #3667 inverts the old #3587 behavior: BigQuery is multi-field / non-url-shaped
    // (project + service-account JSON), but profiling now rides the unified
    // `resolveLiveConnection` and reads creds from config — there is no URL-shape
    // gate to fail it closed. So a provisionable BigQuery datasource that implements
    // `connection.profile` IS profilable over MCP, and the create hint must say so.
    provisionCapability = { kind: "plugin", dbType: "bigquery" };
    profileCapability = { kind: "plugin", dbType: "bigquery", profileFn: () => Promise.resolve({ profiles: [], errors: [] }) };
    provisionOutcome = {
      kind: "ok",
      value: { installId: "bq-wh", dbType: "bigquery", status: "draft", maskedUrl: null, description: null, schema: null, groupId: null },
    };
    const client = await createTestClient();
    const res = await client.callTool({ name: "create_datasource", arguments: { db_type: "bigquery", install_id: "bq-wh" } });
    const body = JSON.parse(getContentText(res.content));
    expect(body.created).toBe(true);
    expect(body.next).toContain("profile_datasource");
    expect(body.next).not.toContain("not available in this deployment");
  });
});

// ── create_rest_datasource (#3547) — OpenAPI spec + auth via masked form ──

describe("create_rest_datasource", () => {
  // The openapi-generic config_schema: spec URL + auth_kind + secret auth_value.
  const REST_FIELDS = {
    kind: "ok",
    fields: [
      { key: "openapi_url", label: "OpenAPI spec URL", required: true, secret: false },
      { key: "auth_kind", label: "Authentication", required: true, secret: false },
      { key: "auth_value", label: "Credential", required: false, secret: true },
    ],
    secretKeys: ["auth_value"],
  };

  it("collects the spec URL + auth as a masked form, then installs via the openapi seam", async () => {
    provisionConfigFields = REST_FIELDS;
    elicitOutcome = {
      action: "accept",
      values: { openapi_url: "https://api.example.com/openapi.json", auth_kind: "bearer", auth_value: "sk-secret" },
    };
    const client = await createTestClient();
    const res = await client.callTool({ name: "create_rest_datasource", arguments: {} });

    // Masked form carried the schema's fields, with auth_value marked secret.
    expect(elicitCalls).toHaveLength(1);
    expect(elicitCalls[0].fields.map((f) => f.name)).toEqual(["openapi_url", "auth_kind", "auth_value"]);
    expect(elicitCalls[0].fields[2].secret).toBe(true);
    // The lib seam received the formData + secretKeys.
    const args = mockProvisionRest.mock.calls[0];
    expect(args?.[1]).toEqual({ openapi_url: "https://api.example.com/openapi.json", auth_kind: "bearer", auth_value: "sk-secret" });
    expect(args?.[2]).toEqual(["auth_value"]);

    const body = JSON.parse(getContentText(res.content));
    expect(body.created).toBe(true);
    expect(body.kind).toBe("rest");
    expect(body.id).toBe("rest-abc123");
    // The credential never appears in the response.
    expect(getContentText(res.content)).not.toContain("sk-secret");
  });

  it("merges the optional display_name tool arg (non-secret) into the install config", async () => {
    provisionConfigFields = REST_FIELDS;
    elicitOutcome = {
      action: "accept",
      values: { openapi_url: "https://api.example.com/openapi.json", auth_kind: "none" },
    };
    const client = await createTestClient();
    await client.callTool({
      name: "create_rest_datasource",
      arguments: { display_name: "My CRM API" },
    });
    const formData = mockProvisionRest.mock.calls[0]?.[1] as Record<string, string>;
    expect(formData.display_name).toBe("My CRM API");
    expect(formData.openapi_url).toBe("https://api.example.com/openapi.json");
  });

  it("a spec-probe / validation failure → validation_failed, nothing installed (scrubbed by lib)", async () => {
    provisionConfigFields = REST_FIELDS;
    provisionRestOutcome = { kind: "validation", message: "openapi_url: spec could not be fetched" };
    const client = await createTestClient();
    const res = await client.callTool({ name: "create_rest_datasource", arguments: {} });
    expect(res.isError).toBe(true);
    expect(parseAtlasMcpToolError(getContentText(res.content))?.code).toBe("validation_failed");
  });

  it("a declined elicitation → validation_failed, nothing installed", async () => {
    provisionConfigFields = REST_FIELDS;
    elicitOutcome = { action: "decline" };
    const client = await createTestClient();
    const res = await client.callTool({ name: "create_rest_datasource", arguments: {} });
    expect(res.isError).toBe(true);
    expect(mockProvisionRest).not.toHaveBeenCalled();
  });
});

// ── profile_datasource (#3512) — long-running, progress + cancellable ──

describe("profile_datasource", () => {
  it("profiles + generates and reports the datasource as queryable + durably persisted", async () => {
    const client = await createTestClient();
    const res = await client.callTool({ name: "profile_datasource", arguments: { id: "prod-us" } });
    const body = JSON.parse(getContentText(res.content));
    expect(body.queryable).toBe(true);
    expect(body.entities_generated).toBe(2);
    expect(body.tables).toEqual(["orders", "users"]);
    expect(body.elapsed_ms).toBe(1234);
    // #3546 — a durably-persisted layer is surfaced as drafts with a publish hint.
    expect(body.persisted).toBe(true);
    expect(body.persisted_status).toBe("draft");
    expect(body.publish_hint).toBeDefined();
    // The bound workspace is threaded to the lib; the install's group scope rides
    // on the resolved connection so the persisted drafts land where the whitelist
    // loader reads them. The decrypted creds stay inside the lib.
    const profileArgs = mockProfileLive.mock.calls[0]?.[0] as {
      orgId?: string;
      connectionId?: string;
      connection?: { connectionGroupId?: string | null };
    };
    expect(profileArgs.orgId).toBe("org_ds");
    expect(profileArgs.connectionId).toBe("prod-us");
    expect(profileArgs.connection?.connectionGroupId).toBeNull();
    // The decrypted URL the profiler used must not surface.
    expect(getContentText(res.content)).not.toContain("user:pass");
  });

  it("a not-found datasource → unknown_entity", async () => {
    resolvedConnection = { kind: "not_found" };
    const client = await createTestClient();
    const res = await client.callTool({ name: "profile_datasource", arguments: { id: "missing" } });
    expect(parseAtlasMcpToolError(getContentText(res.content))?.code).toBe("unknown_entity");
    expect(mockProfileLive).not.toHaveBeenCalled();
  });

  it("an unsupported dbType → validation_failed (surfacing the lib's actionable message)", async () => {
    resolvedConnection = {
      kind: "unsupported",
      dbType: "clickhouse",
      message: 'Datasource type "clickhouse" cannot be profiled in this deployment.',
    };
    const client = await createTestClient();
    const res = await client.callTool({ name: "profile_datasource", arguments: { id: "ch" } });
    const err = parseAtlasMcpToolError(getContentText(res.content));
    expect(err?.code).toBe("validation_failed");
    // The actionable lib message is surfaced (not a hardcoded "postgres and mysql only").
    expect(err?.message).toContain("cannot be profiled in this deployment");
    expect(mockProfileLive).not.toHaveBeenCalled();
  });

  it("#3667 — a reconnect_required (OAuth) outcome → validation_failed with the reconnect prompt", async () => {
    // Salesforce-style: the OAuth tokens are stale/revoked, so the unified
    // resolver returns reconnect_required — surfaced as an actionable message,
    // not a silent failure or a 500.
    resolvedConnection = {
      kind: "reconnect_required",
      dbType: "salesforce",
      message: "The salesforce connection needs to be reconnected before it can be profiled.",
    };
    const client = await createTestClient();
    const res = await client.callTool({ name: "profile_datasource", arguments: { id: "sf" } });
    const err = parseAtlasMcpToolError(getContentText(res.content));
    expect(err?.code).toBe("validation_failed");
    expect(err?.message).toContain("reconnected");
    expect(mockProfileLive).not.toHaveBeenCalled();
  });

  it("#3667 — profiles the RESOLVED LIVE CONNECTION (carrying its group scope) without re-resolving auth", async () => {
    // A plugin-managed datasource resolves a live connection off the unified
    // resolver; the tool profiles THAT connection (no url/profileFn threading).
    resolvedConnection = okConn("warehouse", "clickhouse");
    const client = await createTestClient();
    const res = await client.callTool({ name: "profile_datasource", arguments: { id: "ch" } });
    const body = JSON.parse(getContentText(res.content));
    expect(body.queryable).toBe(true);
    const profileArgs = mockProfileLive.mock.calls[0]?.[0] as {
      connectionId?: string;
      connection?: { dbType?: string; connectionGroupId?: string | null };
    };
    expect(profileArgs.connectionId).toBe("ch");
    expect(profileArgs.connection?.dbType).toBe("clickhouse");
    expect(profileArgs.connection?.connectionGroupId).toBe("warehouse");
  });

  it("a ProfilingFailedError outcome → validation_failed (not a 500)", async () => {
    profileResult = { kind: "error", reason: "no_tables", message: "No tables found to profile." };
    const client = await createTestClient();
    const res = await client.callTool({ name: "profile_datasource", arguments: { id: "prod-us" } });
    expect(parseAtlasMcpToolError(getContentText(res.content))?.code).toBe("validation_failed");
  });
});
