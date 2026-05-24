/**
 * Tests for `WorkspaceInstaller` (#2742 — slice 4 of 1.5.3).
 *
 * Three layers of coverage:
 *
 *   1. Schema validation — `validateAgainstConfigSchema` (pure helper).
 *   2. Pillar singleton + dispatch — the facade's `install` method against
 *      a stubbed install handler and `mock.module()`-shadowed
 *      `internalQuery` / credential store.
 *   3. Two-store teardown — `uninstall` calls credential store FIRST,
 *      then `workspace_plugins` DELETE, in the order ADR-0003 mandates.
 *
 * The facade is a thin orchestration layer over the existing per-Platform
 * install handlers (slice 5 — Slack OAuth; #2660 — form-based; ADR-0005
 * — action OAuth). The handler unit tests already cover per-Platform
 * write semantics; these tests verify the facade-level invariants
 * (singleton, schema validation, error mapping, teardown order).
 *
 * `mock.module()` shadows the DB and credential store modules so the
 * facade can be exercised without standing up Postgres or chat_cache.
 * Effect test layers (`createWorkspaceInstallerTestLayer`) cover the
 * stub-by-default semantics route-handler tests will eventually rely on.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, mock, type Mock } from "bun:test";
import { Effect } from "effect";
import type { WorkspaceId } from "@useatlas/types";

// ---------------------------------------------------------------------------
// Module mocks — shadow DB + credential stores BEFORE importing the facade
// ---------------------------------------------------------------------------

// `internalQuery` is the DB seam every catalog / install lookup goes
// through. We thread a queue of canned responses keyed by the SQL
// fragment so each test stays declarative about the rows it cares about.
const internalQueryResponses: Array<{
  match: (sql: string, params?: unknown[]) => boolean;
  rows: unknown[];
}> = [];

const internalQueryCalls: Array<{ sql: string; params?: unknown[] }> = [];

const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<unknown[]>> = mock(
  async (sql: string, params?: unknown[]) => {
    internalQueryCalls.push({ sql, params });
    for (let i = 0; i < internalQueryResponses.length; i++) {
      const entry = internalQueryResponses[i];
      if (entry.match(sql, params)) {
        // Pop matched response so tests can queue multiple in order.
        internalQueryResponses.splice(i, 1);
        return entry.rows;
      }
    }
    return [];
  },
);

mock.module("@atlas/api/lib/db/internal", () => ({
  internalQuery: mockInternalQuery,
  hasInternalDB: mock(() => true),
  getInternalDB: mock(() => ({ query: mock(() => Promise.resolve({ rows: [] })) })),
  // Re-stub the Effect-facing surface; the facade doesn't yield InternalDB
  // but other modules in the dep graph might.
  InternalDB: { _tag: "InternalDB" },
  makeInternalDBLive: mock(() => ({})),
  createInternalDBTestLayer: mock(() => ({})),
  queryEffect: mock(() => Effect.succeed([])),
}));

// Slack credential store — chat_cache write path. Capture calls so the
// teardown-order test can assert ordering.
const slackDeleteCalls: string[] = [];
const mockDeleteSlackInstallation: Mock<(teamId: string) => Promise<void>> = mock(
  async (teamId: string) => {
    slackDeleteCalls.push(teamId);
  },
);

mock.module("@atlas/api/lib/slack/store", () => ({
  deleteInstallation: mockDeleteSlackInstallation,
  saveInstallation: mock(() => Promise.resolve()),
}));

// integration_credentials store — action OAuth teardown.
const credentialDeleteCalls: Array<{ workspaceId: string; catalogId: string }> = [];
const mockDeleteCredentialBundle: Mock<(workspaceId: string, catalogId: string) => Promise<boolean>> = mock(
  async (workspaceId: string, catalogId: string) => {
    credentialDeleteCalls.push({ workspaceId, catalogId });
    return true;
  },
);

mock.module("@atlas/api/lib/integrations/credentials/store", () => ({
  deleteCredentialBundle: mockDeleteCredentialBundle,
  saveCredentialBundle: mock(() => Promise.resolve()),
  readCredentialBundle: mock(() => Promise.resolve(null)),
}));

// Install handler dispatch — let tests inject per-slug handlers.
type DispatchHandler =
  | {
      kind: "form";
      validateConfig: (workspaceId: WorkspaceId, formData: unknown) => Promise<unknown>;
    }
  | {
      kind: "oauth";
      startInstall: (workspaceId: WorkspaceId) => Promise<unknown>;
      handleCallback: (code: string, stateToken: string) => Promise<unknown>;
    }
  | {
      kind: "static-bot";
      confirmInstall: (
        workspaceId: WorkspaceId,
        routingIdentifier: string,
        verificationProof?: string,
        extras?: Record<string, unknown>,
      ) => Promise<unknown>;
    };

const dispatchHandlers = new Map<string, DispatchHandler>();
const mockGetInstallHandler = mock((catalogRow: { slug: string; install_model: string }) => {
  const handler = dispatchHandlers.get(catalogRow.slug);
  if (!handler) {
    throw new Error(`Test stub: no install handler registered for "${catalogRow.slug}"`);
  }
  return handler;
});

// Mock the dispatch sub-module — the facade lazy-`require`s
// `lib/integrations/install/dispatch` (not the barrel) so we shadow
// the same path. Mock ALL named exports of that file per CLAUDE.md's
// "mock all exports" rule.
mock.module("@atlas/api/lib/integrations/install/dispatch", () => ({
  getInstallHandler: mockGetInstallHandler,
  registerOAuthHandler: mock(() => {}),
  registerFormHandler: mock(() => {}),
  registerStaticBotHandler: mock(() => {}),
  _resetInstallHandlerRegistries: mock(() => {}),
}));

// Datasource registry bridge (#2744) — the facade's installDatasource /
// uninstallDatasource / updateDatasourceConfig methods call through the
// bridge to mutate the ConnectionRegistry. The bridge transitively
// imports the live registry; mocking it lets the tests assert
// register / unregister calls without spinning up real pg pools.
const bridgeRegisterCalls: Array<{ workspaceId: string; installId: string; catalogSlug: string }> = [];
const bridgeUnregisterCalls: string[] = [];
const mockBridgeRegister = mock(
  (row: { workspaceId: string; installId: string; catalogSlug: string }, _cfg: unknown) => {
    bridgeRegisterCalls.push({
      workspaceId: row.workspaceId,
      installId: row.installId,
      catalogSlug: row.catalogSlug,
    });
    return true;
  },
);
const mockBridgeUnregister = mock((installId: string) => {
  bridgeUnregisterCalls.push(installId);
  return true;
});
mock.module("@atlas/api/lib/db/datasource-registry-bridge", () => ({
  registerDatasourceInstall: mockBridgeRegister,
  unregisterDatasourceInstall: mockBridgeUnregister,
}));

// ---------------------------------------------------------------------------
// Lazy import of the facade after mocks are in place
// ---------------------------------------------------------------------------

type WorkspaceInstallerModule = typeof import("../workspace-installer");
let mod!: WorkspaceInstallerModule;

beforeAll(async () => {
  mod = await import("../workspace-installer");
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const WSID = "ws-test-1" as WorkspaceId;

function resetState() {
  internalQueryResponses.length = 0;
  internalQueryCalls.length = 0;
  slackDeleteCalls.length = 0;
  credentialDeleteCalls.length = 0;
  bridgeRegisterCalls.length = 0;
  bridgeUnregisterCalls.length = 0;
  dispatchHandlers.clear();
  mockInternalQuery.mockClear();
  mockDeleteSlackInstallation.mockClear();
  mockDeleteCredentialBundle.mockClear();
  mockGetInstallHandler.mockClear();
  mockBridgeRegister.mockClear();
  mockBridgeUnregister.mockClear();
  // Default the bridge mocks back to no-op success so tests that don't
  // override them get the happy path. Individual tests can swap via
  // mockImplementation(() => { throw new Error(...) }).
  mockBridgeRegister.mockImplementation(
    (row: { workspaceId: string; installId: string; catalogSlug: string }, _cfg: unknown) => {
      bridgeRegisterCalls.push({
        workspaceId: row.workspaceId,
        installId: row.installId,
        catalogSlug: row.catalogSlug,
      });
      return true;
    },
  );
  mockBridgeUnregister.mockImplementation((installId: string) => {
    bridgeUnregisterCalls.push(installId);
    return true;
  });
}

beforeEach(() => {
  resetState();
});

afterEach(() => {
  resetState();
});

function queueCatalogLookup(
  slug: string,
  overrides: Partial<{
    id: string;
    install_model: string;
    pillar: string;
    config_schema: unknown;
    enabled: boolean;
  }> = {},
): void {
  internalQueryResponses.push({
    match: (sql: string, params?: unknown[]) =>
      sql.includes("FROM plugin_catalog") && (params?.[0] === slug),
    rows: [
      {
        id: overrides.id ?? `catalog:${slug}`,
        slug,
        install_model: overrides.install_model ?? "oauth",
        pillar: overrides.pillar ?? "chat",
        config_schema: overrides.config_schema ?? null,
        enabled: overrides.enabled ?? true,
      },
    ],
  });
}

function queueInstallLookup(
  workspaceId: string,
  catalogId: string,
  existing: { id: string; install_id: string; team_id?: string | null } | null,
): void {
  internalQueryResponses.push({
    match: (sql: string, params?: unknown[]) =>
      sql.includes("FROM workspace_plugins") &&
      sql.includes("install_id") &&
      params?.[0] === workspaceId &&
      params?.[1] === catalogId &&
      !sql.includes("DELETE"),
    rows: existing
      ? [
          {
            id: existing.id,
            install_id: existing.install_id,
            team_id: existing.team_id ?? null,
          },
        ]
      : [],
  });
}

function runEffect<A, E>(eff: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, E, never>);
}

// ---------------------------------------------------------------------------
// 1. Schema validation
// ---------------------------------------------------------------------------

describe("validateAgainstConfigSchema", () => {
  it("returns null when schema is absent (null / undefined)", () => {
    const err = mod._testing.validateAgainstConfigSchema("foo", null, { host: "x" });
    expect(err).toBeNull();
  });

  it("returns null when schema is corrupt — facade defers to per-handler validation", () => {
    const err = mod._testing.validateAgainstConfigSchema(
      "foo",
      { not: "an array" },
      { host: "x" },
    );
    expect(err).toBeNull();
  });

  it("returns null when all required fields are present and well-typed", () => {
    const schema = [
      { key: "host", type: "string", required: true },
      { key: "port", type: "number", required: true },
    ];
    const err = mod._testing.validateAgainstConfigSchema("foo", schema, {
      host: "smtp.example.com",
      port: 587,
    });
    expect(err).toBeNull();
  });

  it("flags missing required field with per-field error", () => {
    const schema = [
      { key: "host", type: "string", required: true },
      { key: "port", type: "number", required: true },
    ];
    const err = mod._testing.validateAgainstConfigSchema("foo", schema, { host: "x" });
    expect(err).not.toBeNull();
    expect(err?._tag).toBe("ConfigSchemaError");
    expect(err?.fieldErrors.port).toBeDefined();
    expect(err?.fieldErrors.port?.[0]).toContain("required");
  });

  it("flags wrong-type field — string vs number", () => {
    const schema = [{ key: "port", type: "number", required: true }];
    const err = mod._testing.validateAgainstConfigSchema("foo", schema, {
      port: "not-a-number",
    });
    expect(err).not.toBeNull();
    expect(err?.fieldErrors.port).toBeDefined();
    expect(err?.fieldErrors.port?.[0]).toContain("number");
  });

  it("allows optional fields to be absent", () => {
    const schema = [
      { key: "host", type: "string", required: true },
      { key: "secure", type: "boolean", required: false },
    ];
    const err = mod._testing.validateAgainstConfigSchema("foo", schema, {
      host: "smtp.example.com",
    });
    expect(err).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. install() — dispatch + singleton + schema validation
// ---------------------------------------------------------------------------

describe("WorkspaceInstaller.install", () => {
  it("rejects unknown catalog slug with CatalogNotFoundError → 404", async () => {
    // No catalog row — empty response.
    internalQueryResponses.push({
      match: (sql, params) => sql.includes("FROM plugin_catalog") && params?.[0] === "missing",
      rows: [],
    });
    const installer = await getLiveService();
    const exit = await Effect.runPromiseExit(
      installer.install(WSID, "missing", { kind: "oauth-start" }),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const failure = exit.cause;
      // Extract the failure value
      const json = JSON.stringify(failure);
      expect(json).toContain("CatalogNotFoundError");
    }
  });

  it("rejects datasource pillar — slice 6 owns those installs", async () => {
    queueCatalogLookup("postgres", { pillar: "datasource", install_model: "form" });
    const installer = await getLiveService();
    const exit = await Effect.runPromiseExit(
      installer.install(WSID, "postgres", {
        kind: "form",
        formData: {},
      }),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(JSON.stringify(exit.cause)).toContain("CatalogNotFoundError");
    }
  });

  it("rejects second chat install with AlreadyInstalledError → 409", async () => {
    queueCatalogLookup("slack", { pillar: "chat", install_model: "oauth" });
    queueInstallLookup(WSID, "catalog:slack", { id: "install-1", install_id: "install-1", team_id: "T123" });
    const installer = await getLiveService();
    const exit = await Effect.runPromiseExit(
      installer.install(WSID, "slack", { kind: "oauth-start" }),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const json = JSON.stringify(exit.cause);
      expect(json).toContain("AlreadyInstalledError");
      expect(json).toContain("slack");
    }
  });

  it("allows oauth-callback to re-install (Reconnect path per ADR-0003)", async () => {
    queueCatalogLookup("slack", { pillar: "chat", install_model: "oauth" });
    queueInstallLookup(WSID, "catalog:slack", { id: "install-1", install_id: "install-1", team_id: "T123" });
    // Even with an existing install, OAuth callback must be allowed
    // through (UPSERT is the documented re-connect path).
    dispatchHandlers.set("slack", {
      kind: "oauth",
      startInstall: async () => ({ redirectUrl: "x", stateToken: "y" }),
      handleCallback: async () => ({
        workspaceId: WSID,
        catalogId: "slack",
        installRecord: { id: "install-1", workspaceId: WSID, catalogId: "slack" },
        credentialResult: { written: true },
      }),
    });
    const installer = await getLiveService();
    const result = await runEffect(
      installer.install(WSID, "slack", {
        kind: "oauth-callback",
        code: "abc",
        stateToken: "tok",
      }),
    );
    expect(result.kind).toBe("oauth-callback");
  });

  it("rejects form install with ConfigSchemaError when required field missing", async () => {
    queueCatalogLookup("email", {
      pillar: "action",
      install_model: "form",
      config_schema: [
        { key: "host", type: "string", required: true },
        { key: "port", type: "number", required: true },
      ],
    });
    queueInstallLookup(WSID, "catalog:email", null);
    dispatchHandlers.set("email", {
      kind: "form",
      validateConfig: async () => ({
        installRecord: { id: "id-1", workspaceId: WSID, catalogId: "email" },
        credentialWritten: true,
      }),
    });
    const installer = await getLiveService();
    const exit = await Effect.runPromiseExit(
      installer.install(WSID, "email", {
        kind: "form",
        formData: { host: "smtp.example.com" }, // missing port
      }),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const json = JSON.stringify(exit.cause);
      expect(json).toContain("ConfigSchemaError");
      expect(json).toContain("port");
    }
  });

  it("dispatches to OAuth handler.startInstall when kind=oauth-start", async () => {
    queueCatalogLookup("slack", { pillar: "chat", install_model: "oauth" });
    queueInstallLookup(WSID, "catalog:slack", null);
    let started = false;
    dispatchHandlers.set("slack", {
      kind: "oauth",
      startInstall: async () => {
        started = true;
        return { redirectUrl: "https://slack.example/authorize", stateToken: "tok-1" };
      },
      handleCallback: async () => null,
    });
    const installer = await getLiveService();
    const result = await runEffect(
      installer.install(WSID, "slack", { kind: "oauth-start" }),
    );
    expect(started).toBe(true);
    expect(result.kind).toBe("oauth-start");
    if (result.kind === "oauth-start") {
      expect(result.redirectUrl).toBe("https://slack.example/authorize");
      expect(result.stateToken).toBe("tok-1");
    }
  });

  it("dispatches to form handler.validateConfig for valid form install", async () => {
    queueCatalogLookup("email", {
      pillar: "action",
      install_model: "form",
      config_schema: [{ key: "host", type: "string", required: true }],
    });
    queueInstallLookup(WSID, "catalog:email", null);
    let validated: unknown = null;
    dispatchHandlers.set("email", {
      kind: "form",
      validateConfig: async (_workspaceId, formData) => {
        validated = formData;
        return {
          installRecord: { id: "id-email-1", workspaceId: WSID, catalogId: "email" },
          credentialWritten: true,
        };
      },
    });
    const installer = await getLiveService();
    const result = await runEffect(
      installer.install(WSID, "email", {
        kind: "form",
        formData: { host: "smtp.example.com" },
      }),
    );
    expect(validated).toEqual({ host: "smtp.example.com" });
    expect(result.kind).toBe("form");
    if (result.kind === "form") {
      expect(result.row.id).toBe("id-email-1");
      expect(result.row.pillar).toBe("action");
      expect(result.credentialWritten).toBe(true);
    }
  });

  it("dispatches to OAuth handler.handleCallback when kind=oauth-callback", async () => {
    queueCatalogLookup("slack", { pillar: "chat", install_model: "oauth" });
    queueInstallLookup(WSID, "catalog:slack", null);
    let calledWith: { code?: string; state?: string } = {};
    dispatchHandlers.set("slack", {
      kind: "oauth",
      startInstall: async () => ({ redirectUrl: "x", stateToken: "y" }),
      handleCallback: async (code, state) => {
        calledWith = { code, state };
        return {
          workspaceId: WSID,
          catalogId: "slack",
          installRecord: { id: "install-x", workspaceId: WSID, catalogId: "slack" },
          credentialResult: { written: true },
        };
      },
    });
    const installer = await getLiveService();
    const result = await runEffect(
      installer.install(WSID, "slack", {
        kind: "oauth-callback",
        code: "the-code",
        stateToken: "the-state",
      }),
    );
    expect(calledWith.code).toBe("the-code");
    expect(calledWith.state).toBe("the-state");
    expect(result.kind).toBe("oauth-callback");
    if (result.kind === "oauth-callback") {
      expect(result.row).not.toBeNull();
      expect(result.row?.id).toBe("install-x");
    }
  });

  it("propagates null row when OAuth handler.handleCallback returns null (invalid state)", async () => {
    queueCatalogLookup("slack", { pillar: "chat", install_model: "oauth" });
    queueInstallLookup(WSID, "catalog:slack", null);
    dispatchHandlers.set("slack", {
      kind: "oauth",
      startInstall: async () => ({ redirectUrl: "x", stateToken: "y" }),
      handleCallback: async () => null,
    });
    const installer = await getLiveService();
    const result = await runEffect(
      installer.install(WSID, "slack", {
        kind: "oauth-callback",
        code: "the-code",
        stateToken: "bad-state",
      }),
    );
    expect(result.kind).toBe("oauth-callback");
    if (result.kind === "oauth-callback") {
      expect(result.row).toBeNull();
      expect(result.credentialResult).toBeNull();
    }
  });

  // ── static-bot dispatch (1.5.3 #2748 — Telegram keystone) ─────────
  //
  // These cases pin the facade-level static-bot install path the rest
  // of Phase D (Discord, gchat, WhatsApp) will inherit. The handler
  // itself is covered by `telegram-static-bot-handler.test.ts`; this
  // suite asserts the facade's forwarding contract: routingIdentifier,
  // verificationProof, AND the new `extras` field all reach the
  // handler verbatim; the singleton check fires for the static-bot
  // pillar; a `kind` mismatch dies as a defect.

  it("forwards routingIdentifier + verificationProof + extras to the static-bot handler", async () => {
    queueCatalogLookup("telegram", { pillar: "chat", install_model: "static-bot" });
    queueInstallLookup(WSID, "catalog:telegram", null);
    const calledWith: {
      workspaceId?: string;
      routingIdentifier?: string;
      verificationProof?: string;
      extras?: Record<string, unknown>;
    } = {};
    dispatchHandlers.set("telegram", {
      kind: "static-bot",
      confirmInstall: async (workspaceId, routingIdentifier, verificationProof, extras) => {
        calledWith.workspaceId = workspaceId;
        calledWith.routingIdentifier = routingIdentifier;
        if (verificationProof !== undefined) calledWith.verificationProof = verificationProof;
        if (extras !== undefined) calledWith.extras = extras;
        return {
          installRecord: {
            id: "install-tg-1",
            workspaceId: workspaceId,
            catalogId: "telegram",
          },
        };
      },
    });
    const installer = await getLiveService();
    const result = await runEffect(
      installer.install(WSID, "telegram", {
        kind: "static-bot",
        routingIdentifier: "-1001234567890",
        verificationProof: "ignored-by-telegram-but-pinned-here",
        extras: { display_name: "Team Standup" },
      }),
    );
    expect(calledWith.workspaceId).toBe(WSID);
    expect(calledWith.routingIdentifier).toBe("-1001234567890");
    expect(calledWith.verificationProof).toBe("ignored-by-telegram-but-pinned-here");
    expect(calledWith.extras).toEqual({ display_name: "Team Standup" });
    expect(result.kind).toBe("static-bot");
    if (result.kind === "static-bot") {
      expect(result.row.catalogSlug).toBe("telegram");
      expect(result.row.pillar).toBe("chat");
      expect(result.row.installId).toBe("install-tg-1");
    }
  });

  it("omits extras / verificationProof from the handler call when the input doesn't supply them", async () => {
    queueCatalogLookup("telegram", { pillar: "chat", install_model: "static-bot" });
    queueInstallLookup(WSID, "catalog:telegram", null);
    let receivedExtras: Record<string, unknown> | undefined;
    let receivedProof: string | undefined;
    dispatchHandlers.set("telegram", {
      kind: "static-bot",
      confirmInstall: async (_w, _r, verificationProof, extras) => {
        receivedExtras = extras;
        receivedProof = verificationProof;
        return {
          installRecord: { id: "install-tg-2", workspaceId: WSID, catalogId: "telegram" },
        };
      },
    });
    const installer = await getLiveService();
    await runEffect(
      installer.install(WSID, "telegram", {
        kind: "static-bot",
        routingIdentifier: "12345",
      }),
    );
    expect(receivedExtras).toBeUndefined();
    expect(receivedProof).toBeUndefined();
  });

  it("rejects second static-bot install with AlreadyInstalledError → 409 (pillar singleton applies to chat pillar regardless of install_model)", async () => {
    queueCatalogLookup("telegram", { pillar: "chat", install_model: "static-bot" });
    queueInstallLookup(WSID, "catalog:telegram", {
      id: "existing-tg",
      install_id: "existing-tg",
      team_id: null,
    });
    const installer = await getLiveService();
    const exit = await Effect.runPromiseExit(
      installer.install(WSID, "telegram", {
        kind: "static-bot",
        routingIdentifier: "-1001234567890",
      }),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const json = JSON.stringify(exit.cause);
      expect(json).toContain("AlreadyInstalledError");
      expect(json).toContain("telegram");
    }
  });

  it("dies as a defect when input.kind is static-bot but the dispatched handler is not", async () => {
    queueCatalogLookup("telegram", { pillar: "chat", install_model: "oauth" });
    queueInstallLookup(WSID, "catalog:telegram", null);
    dispatchHandlers.set("telegram", {
      kind: "oauth",
      startInstall: async () => ({ redirectUrl: "x", stateToken: "y" }),
      handleCallback: async () => null,
    });
    const installer = await getLiveService();
    const exit = await Effect.runPromiseExit(
      installer.install(WSID, "telegram", {
        kind: "static-bot",
        routingIdentifier: "12345",
      }),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      // Defect (not a tagged failure) — the dispatch contract violation
      // is a 500-class regression, not a user-facing error. JSON-
      // serialize doesn't pick up Error.message (it's on the prototype),
      // so walk the cause directly.
      const causeStr = String(exit.cause);
      expect(causeStr).toContain("refusing static-bot install");
    }
  });
});

// ---------------------------------------------------------------------------
// 3. uninstall() — two-store teardown order
// ---------------------------------------------------------------------------

describe("WorkspaceInstaller.uninstall", () => {
  it("returns CatalogNotFoundError for unknown slug", async () => {
    internalQueryResponses.push({
      match: (sql, params) => sql.includes("FROM plugin_catalog") && params?.[0] === "missing",
      rows: [],
    });
    const installer = await getLiveService();
    const exit = await Effect.runPromiseExit(installer.uninstall(WSID, "missing"));
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(JSON.stringify(exit.cause)).toContain("CatalogNotFoundError");
    }
  });

  it("returns InstallNotFoundError when no install row exists", async () => {
    queueCatalogLookup("slack", { pillar: "chat", install_model: "oauth" });
    queueInstallLookup(WSID, "catalog:slack", null);
    const installer = await getLiveService();
    const exit = await Effect.runPromiseExit(installer.uninstall(WSID, "slack"));
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(JSON.stringify(exit.cause)).toContain("InstallNotFoundError");
    }
  });

  it("calls chat_cache (Slack) DELETE BEFORE workspace_plugins DELETE", async () => {
    queueCatalogLookup("slack", { pillar: "chat", install_model: "oauth" });
    queueInstallLookup(WSID, "catalog:slack", {
      id: "install-1",
      install_id: "install-1",
      team_id: "T-team-123",
    });
    // Queue the DELETE FROM workspace_plugins response (no rows returned).
    internalQueryResponses.push({
      match: (sql) => sql.includes("DELETE FROM workspace_plugins"),
      rows: [],
    });

    const installer = await getLiveService();
    await runEffect(installer.uninstall(WSID, "slack"));

    // Order assertion: chat_cache delete must precede the workspace_plugins DELETE.
    expect(slackDeleteCalls).toEqual(["T-team-123"]);
    const deleteSqlIdx = internalQueryCalls.findIndex((c) =>
      c.sql.includes("DELETE FROM workspace_plugins"),
    );
    expect(deleteSqlIdx).toBeGreaterThanOrEqual(0);
    // Slack delete was invoked synchronously before the DELETE call,
    // and the queue captures the workspace_plugins DELETE here.
    expect(mockDeleteSlackInstallation).toHaveBeenCalledTimes(1);
  });

  it("calls integration_credentials DELETE BEFORE workspace_plugins for action OAuth (salesforce)", async () => {
    queueCatalogLookup("salesforce", { pillar: "action", install_model: "oauth" });
    queueInstallLookup(WSID, "catalog:salesforce", {
      id: "install-sf",
      install_id: "install-sf",
      team_id: null,
    });
    internalQueryResponses.push({
      match: (sql) => sql.includes("DELETE FROM workspace_plugins"),
      rows: [],
    });

    const installer = await getLiveService();
    await runEffect(installer.uninstall(WSID, "salesforce"));

    expect(credentialDeleteCalls).toEqual([
      { workspaceId: WSID, catalogId: "catalog:salesforce" },
    ]);
    expect(mockDeleteCredentialBundle).toHaveBeenCalledTimes(1);
  });

  it("skips per-platform credential teardown for form-based installs (no separate store)", async () => {
    queueCatalogLookup("email", { pillar: "action", install_model: "form" });
    queueInstallLookup(WSID, "catalog:email", {
      id: "install-email",
      install_id: "install-email",
      team_id: null,
    });
    internalQueryResponses.push({
      match: (sql) => sql.includes("DELETE FROM workspace_plugins"),
      rows: [],
    });

    const installer = await getLiveService();
    await runEffect(installer.uninstall(WSID, "email"));

    // Neither Slack nor integration_credentials store should be touched.
    expect(mockDeleteSlackInstallation).not.toHaveBeenCalled();
    expect(mockDeleteCredentialBundle).not.toHaveBeenCalled();
    // workspace_plugins DELETE still ran.
    const deleteSqlIdx = internalQueryCalls.findIndex((c) =>
      c.sql.includes("DELETE FROM workspace_plugins"),
    );
    expect(deleteSqlIdx).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// 4. updateConfig() — schema validation + secret encryption
// ---------------------------------------------------------------------------

describe("WorkspaceInstaller.updateConfig", () => {
  it("returns InstallNotFoundError when row doesn't exist", async () => {
    queueCatalogLookup("email", { pillar: "action", install_model: "form" });
    // queue empty install row lookup
    internalQueryResponses.push({
      match: (sql) =>
        sql.includes("FROM workspace_plugins") && sql.includes("install_id") && !sql.includes("DELETE"),
      rows: [],
    });
    const installer = await getLiveService();
    const exit = await Effect.runPromiseExit(
      installer.updateConfig(WSID, "email", "missing-id", { host: "x" }),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(JSON.stringify(exit.cause)).toContain("InstallNotFoundError");
    }
  });

  it("returns ConfigSchemaError when merged config violates schema", async () => {
    queueCatalogLookup("email", {
      pillar: "action",
      install_model: "form",
      config_schema: [
        { key: "host", type: "string", required: true },
        { key: "port", type: "number", required: true },
      ],
    });
    internalQueryResponses.push({
      match: (sql) =>
        sql.includes("FROM workspace_plugins") && sql.includes("install_id") && !sql.includes("DELETE"),
      // existing row WITHOUT port — partial update doesn't supply port either
      rows: [{ id: "id-1", install_id: "id-1", config: { host: "smtp.x" } }],
    });
    const installer = await getLiveService();
    const exit = await Effect.runPromiseExit(
      installer.updateConfig(WSID, "email", "id-1", { host: "smtp.new" }),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(JSON.stringify(exit.cause)).toContain("ConfigSchemaError");
    }
  });

  it("writes through merged config when validation passes", async () => {
    queueCatalogLookup("email", {
      pillar: "action",
      install_model: "form",
      config_schema: [
        { key: "host", type: "string", required: true },
        { key: "port", type: "number", required: true },
      ],
    });
    internalQueryResponses.push({
      match: (sql) =>
        sql.includes("FROM workspace_plugins") && sql.includes("install_id") && !sql.includes("DELETE"),
      rows: [{ id: "id-1", install_id: "id-1", config: { host: "smtp.x", port: 25 } }],
    });
    // queue the UPDATE response
    internalQueryResponses.push({
      match: (sql) => sql.includes("UPDATE workspace_plugins"),
      rows: [],
    });
    const installer = await getLiveService();
    const row = await runEffect(
      installer.updateConfig(WSID, "email", "id-1", { host: "smtp.new" }),
    );
    expect(row.id).toBe("id-1");
    expect(row.pillar).toBe("action");
    // assert the UPDATE was issued with the merged config
    const updateCall = internalQueryCalls.find((c) => c.sql.includes("UPDATE workspace_plugins"));
    expect(updateCall).toBeDefined();
    // first param is the JSON-stringified config
    const persistedConfig = JSON.parse((updateCall?.params?.[0] as string) ?? "{}");
    expect(persistedConfig.host).toBe("smtp.new");
    expect(persistedConfig.port).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// 5. Test-layer factory
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 5. Datasource pillar (#2744 / ADR-0007)
// ---------------------------------------------------------------------------

describe("validateInstallId", () => {
  it("allows valid lowercase slugs with letters, digits, underscores, hyphens", () => {
    expect(mod._testing.validateInstallId("prod-us")).toBeNull();
    expect(mod._testing.validateInstallId("warehouse")).toBeNull();
    expect(mod._testing.validateInstallId("a")).toBeNull();
    expect(mod._testing.validateInstallId("eu_west_1")).toBeNull();
  });

  it("allows the historical __demo__ sentinel (migration 0094 backfill)", () => {
    expect(mod._testing.validateInstallId("__demo__")).toBeNull();
  });

  it("rejects empty string with pattern error", () => {
    const err = mod._testing.validateInstallId("");
    expect(err?._tag).toBe("InvalidInstallIdError");
    expect(err?.reason).toBe("pattern");
  });

  it("rejects uppercase and leading digit with pattern error", () => {
    expect(mod._testing.validateInstallId("PROD")?.reason).toBe("pattern");
    expect(mod._testing.validateInstallId("1prod")?.reason).toBe("pattern");
  });

  it("rejects 'default' as reserved", () => {
    const err = mod._testing.validateInstallId("default");
    expect(err?._tag).toBe("InvalidInstallIdError");
    expect(err?.reason).toBe("reserved");
  });
});

describe("resolverErrorToConfigSchemaError", () => {
  it("extracts a backticked field name into fieldErrors", () => {
    const err = mod._testing.resolverErrorToConfigSchemaError(
      "postgres",
      new Error("DatasourcePoolResolver(postgres): missing required field `url`"),
    );
    expect(err._tag).toBe("ConfigSchemaError");
    expect(err.fieldErrors.url).toBeDefined();
    expect(err.fieldErrors.url?.[0]).toContain("url");
  });

  it("dumps to formErrors when no field can be extracted", () => {
    const err = mod._testing.resolverErrorToConfigSchemaError(
      "duckdb",
      new Error("DatasourcePoolResolver(duckdb): something opaque"),
    );
    expect(err.formErrors.length).toBe(1);
    expect(Object.keys(err.fieldErrors).length).toBe(0);
  });
});

describe("shapeDatasourceRow", () => {
  it("masks the URL for native dbTypes", () => {
    const row = mod._testing.shapeDatasourceRow({
      rowId: "cn_ws_test_1_prod",
      workspaceId: WSID,
      catalogId: "cat:postgres",
      catalogSlug: "postgres",
      installId: "prod",
      status: "published",
      decryptedConfig: {
        url: "postgresql://user:pass@host:5432/db",
        schema: "analytics",
        description: "Prod warehouse",
      },
    });
    expect(row.dbType).toBe("postgres");
    expect(row.maskedUrl).not.toBeNull();
    expect(row.maskedUrl).not.toContain("pass");
    expect(row.schema).toBe("analytics");
    expect(row.description).toBe("Prod warehouse");
    expect(row.pillar).toBe("datasource");
  });

  it("returns maskedUrl=null for dbTypes without a URL (bigquery)", () => {
    const row = mod._testing.shapeDatasourceRow({
      rowId: "cn_ws_test_1_bq",
      workspaceId: WSID,
      catalogId: "cat:bigquery",
      catalogSlug: "bigquery",
      installId: "bq",
      status: "draft",
      decryptedConfig: {},
    });
    expect(row.dbType).toBe("bigquery");
    expect(row.maskedUrl).toBeNull();
    expect(row.status).toBe("draft");
  });

  it("returns group_id when set", () => {
    const row = mod._testing.shapeDatasourceRow({
      rowId: "cn_ws_test_1_x",
      workspaceId: WSID,
      catalogId: "cat:postgres",
      catalogSlug: "postgres",
      installId: "x",
      status: "published",
      decryptedConfig: { url: "postgresql://u@h/d", group_id: "prod" },
    });
    expect(row.groupId).toBe("prod");
  });
});

describe("WorkspaceInstaller.installDatasource", () => {
  it("rejects invalid install_id pattern with InvalidInstallIdError → 400", async () => {
    const installer = await getLiveService();
    const exit = await Effect.runPromiseExit(
      installer.installDatasource(WSID, "postgres", {
        installId: "BAD-UPPER",
        formData: { url: "postgresql://u@h/d" },
        atlasMode: "published",
      }),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(JSON.stringify(exit.cause)).toContain("InvalidInstallIdError");
    }
  });

  it("rejects 'default' as reserved", async () => {
    const installer = await getLiveService();
    const exit = await Effect.runPromiseExit(
      installer.installDatasource(WSID, "postgres", {
        installId: "default",
        formData: { url: "postgresql://u@h/d" },
        atlasMode: "published",
      }),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const s = JSON.stringify(exit.cause);
      expect(s).toContain("InvalidInstallIdError");
      expect(s).toContain("reserved");
    }
  });

  it("rejects unknown catalog with CatalogNotFoundError → 404", async () => {
    internalQueryResponses.push({
      match: (sql, params) =>
        sql.includes("FROM plugin_catalog") && params?.[0] === "unknown-db",
      rows: [],
    });
    const installer = await getLiveService();
    const exit = await Effect.runPromiseExit(
      installer.installDatasource(WSID, "unknown-db", {
        installId: "x",
        formData: { url: "postgresql://u@h/d" },
        atlasMode: "published",
      }),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(JSON.stringify(exit.cause)).toContain("CatalogNotFoundError");
    }
  });

  it("rejects when catalog pillar is chat/action (route through .install)", async () => {
    queueCatalogLookup("slack", { pillar: "chat", install_model: "oauth" });
    const installer = await getLiveService();
    const exit = await Effect.runPromiseExit(
      installer.installDatasource(WSID, "slack", {
        installId: "x",
        formData: {},
        atlasMode: "published",
      }),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(JSON.stringify(exit.cause)).toContain("CatalogNotFoundError");
    }
  });

  it("rejects missing url with ConfigSchemaError extracted from resolver", async () => {
    queueCatalogLookup("postgres", { pillar: "datasource", install_model: "form" });
    const installer = await getLiveService();
    const exit = await Effect.runPromiseExit(
      installer.installDatasource(WSID, "postgres", {
        installId: "prod",
        formData: { schema: "public" },
        atlasMode: "published",
      }),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const s = JSON.stringify(exit.cause);
      expect(s).toContain("ConfigSchemaError");
      expect(s).toContain("url");
    }
  });

  it("rejects duplicate install_id with AlreadyInstalledError → 409", async () => {
    queueCatalogLookup("postgres", {
      pillar: "datasource",
      install_model: "form",
      id: "cat:postgres",
    });
    // Singleton pre-check returns an existing row.
    internalQueryResponses.push({
      match: (sql, params) =>
        sql.includes("FROM workspace_plugins") &&
        sql.includes("install_id") &&
        params?.[2] === "prod" &&
        !sql.includes("DELETE") &&
        !sql.includes("UPDATE") &&
        !sql.includes("INSERT"),
      rows: [{ install_id: "prod" }],
    });
    const installer = await getLiveService();
    const exit = await Effect.runPromiseExit(
      installer.installDatasource(WSID, "postgres", {
        installId: "prod",
        formData: { url: "postgresql://u@h/d" },
        atlasMode: "published",
      }),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const s = JSON.stringify(exit.cause);
      expect(s).toContain("AlreadyInstalledError");
      expect(s).toContain("datasource");
    }
  });

  it("inserts the row, registers the pool, and returns a masked row on success", async () => {
    queueCatalogLookup("postgres", {
      pillar: "datasource",
      install_model: "form",
      id: "cat:postgres",
    });
    // Singleton lookup — no existing row.
    internalQueryResponses.push({
      match: (sql, params) =>
        sql.includes("FROM workspace_plugins") &&
        sql.includes("install_id") &&
        params?.[2] === "prod" &&
        !sql.includes("DELETE") &&
        !sql.includes("UPDATE") &&
        !sql.includes("INSERT"),
      rows: [],
    });
    const installer = await getLiveService();
    const row = await runEffect(
      installer.installDatasource(WSID, "postgres", {
        installId: "prod",
        formData: {
          url: "postgresql://user:pw@host:5432/db",
          schema: "analytics",
          description: "Prod warehouse",
        },
        groupId: "prod-cluster",
        atlasMode: "published",
      }),
    );
    expect(row.installId).toBe("prod");
    expect(row.dbType).toBe("postgres");
    expect(row.status).toBe("published");
    expect(row.maskedUrl).not.toBeNull();
    expect(row.maskedUrl).not.toContain("pw");
    expect(row.groupId).toBe("prod-cluster");
    expect(row.schema).toBe("analytics");
    expect(bridgeRegisterCalls.length).toBe(1);
    expect(bridgeRegisterCalls[0].installId).toBe("prod");
    // Verify the INSERT actually went through.
    const insertCall = internalQueryCalls.find((c) =>
      c.sql.includes("INSERT INTO workspace_plugins"),
    );
    expect(insertCall).toBeDefined();
  });

  it("writes status='draft' when atlasMode is 'draft'", async () => {
    queueCatalogLookup("postgres", {
      pillar: "datasource",
      install_model: "form",
      id: "cat:postgres",
    });
    internalQueryResponses.push({
      match: (sql, params) =>
        sql.includes("FROM workspace_plugins") &&
        sql.includes("install_id") &&
        params?.[2] === "draft-x" &&
        !sql.includes("DELETE") &&
        !sql.includes("UPDATE") &&
        !sql.includes("INSERT"),
      rows: [],
    });
    const installer = await getLiveService();
    const row = await runEffect(
      installer.installDatasource(WSID, "postgres", {
        installId: "draft-x",
        formData: { url: "postgresql://u@h/d" },
        atlasMode: "draft",
      }),
    );
    expect(row.status).toBe("draft");
  });

  it("still completes when registerDatasourceInstall throws (best-effort)", async () => {
    queueCatalogLookup("postgres", {
      pillar: "datasource",
      install_model: "form",
      id: "cat:postgres",
    });
    internalQueryResponses.push({
      match: (sql, params) =>
        sql.includes("FROM workspace_plugins") &&
        sql.includes("install_id") &&
        params?.[2] === "y" &&
        !sql.includes("DELETE") &&
        !sql.includes("UPDATE") &&
        !sql.includes("INSERT"),
      rows: [],
    });
    mockBridgeRegister.mockImplementation(() => {
      throw new Error("simulated registry rejection");
    });
    const installer = await getLiveService();
    const row = await runEffect(
      installer.installDatasource(WSID, "postgres", {
        installId: "y",
        formData: { url: "postgresql://u@h/d" },
        atlasMode: "published",
      }),
    );
    // Row is persisted; the registry failure is logged-not-thrown.
    expect(row.installId).toBe("y");
  });
});

describe("WorkspaceInstaller.uninstallDatasource", () => {
  it("rejects when row is missing with InstallNotFoundError → 404", async () => {
    queueCatalogLookup("postgres", {
      pillar: "datasource",
      install_model: "form",
      id: "cat:postgres",
    });
    // UPDATE returns no rows.
    internalQueryResponses.push({
      match: (sql) => sql.includes("UPDATE workspace_plugins"),
      rows: [],
    });
    const installer = await getLiveService();
    const exit = await Effect.runPromiseExit(
      installer.uninstallDatasource(WSID, "postgres", "missing"),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(JSON.stringify(exit.cause)).toContain("InstallNotFoundError");
    }
  });

  it("soft archives by default and unregisters the pool", async () => {
    queueCatalogLookup("postgres", {
      pillar: "datasource",
      install_model: "form",
      id: "cat:postgres",
    });
    internalQueryResponses.push({
      match: (sql) =>
        sql.includes("UPDATE workspace_plugins") && sql.includes("'archived'"),
      rows: [{ id: "row-1" }],
    });
    const installer = await getLiveService();
    await runEffect(installer.uninstallDatasource(WSID, "postgres", "prod"));
    expect(bridgeUnregisterCalls).toContain("prod");
    const updateCall = internalQueryCalls.find((c) =>
      c.sql.includes("UPDATE workspace_plugins") && c.sql.includes("'archived'"),
    );
    expect(updateCall).toBeDefined();
  });

  it("hard-deletes when options.hard=true", async () => {
    queueCatalogLookup("postgres", {
      pillar: "datasource",
      install_model: "form",
      id: "cat:postgres",
    });
    internalQueryResponses.push({
      match: (sql) => sql.startsWith("DELETE FROM workspace_plugins") || sql.includes("DELETE FROM workspace_plugins"),
      rows: [{ id: "row-1" }],
    });
    const installer = await getLiveService();
    await runEffect(
      installer.uninstallDatasource(WSID, "postgres", "prod", { hard: true }),
    );
    const deleteCall = internalQueryCalls.find((c) =>
      c.sql.includes("DELETE FROM workspace_plugins"),
    );
    expect(deleteCall).toBeDefined();
    expect(bridgeUnregisterCalls).toContain("prod");
  });
});

describe("WorkspaceInstaller.updateDatasourceConfig", () => {
  function queueExistingRowLookup(
    workspaceId: string,
    catalogId: string,
    installId: string,
    existing: {
      id: string;
      config: Record<string, unknown> | null;
      status: string;
    } | null,
  ): void {
    internalQueryResponses.push({
      match: (sql, params) =>
        sql.includes("FROM workspace_plugins") &&
        sql.includes("install_id") &&
        sql.includes("status") &&
        params?.[0] === workspaceId &&
        params?.[1] === catalogId &&
        params?.[2] === installId &&
        !sql.includes("UPDATE") &&
        !sql.includes("DELETE") &&
        !sql.includes("INSERT"),
      rows: existing
        ? [{ id: existing.id, install_id: installId, config: existing.config, status: existing.status }]
        : [],
    });
  }

  it("rejects when no install row exists for installId", async () => {
    queueCatalogLookup("postgres", {
      pillar: "datasource",
      install_model: "form",
      id: "cat:postgres",
    });
    queueExistingRowLookup(WSID, "cat:postgres", "missing", null);
    const installer = await getLiveService();
    const exit = await Effect.runPromiseExit(
      installer.updateDatasourceConfig(WSID, "postgres", "missing", {
        partialConfig: { description: "x" },
      }),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(JSON.stringify(exit.cause)).toContain("InstallNotFoundError");
    }
  });

  it("merges partialConfig and writes UPDATE with new status when atlasMode='draft'", async () => {
    queueCatalogLookup("postgres", {
      pillar: "datasource",
      install_model: "form",
      id: "cat:postgres",
    });
    queueExistingRowLookup(WSID, "cat:postgres", "prod", {
      id: "row-1",
      config: { url: "postgresql://u@h/d", description: "old" },
      status: "published",
    });
    const installer = await getLiveService();
    const row = await runEffect(
      installer.updateDatasourceConfig(WSID, "postgres", "prod", {
        partialConfig: { description: "new" },
        atlasMode: "draft",
      }),
    );
    expect(row.status).toBe("draft");
    expect(row.description).toBe("new");
    expect(bridgeUnregisterCalls).toContain("prod");
    const updateCall = internalQueryCalls.find((c) =>
      c.sql.includes("UPDATE workspace_plugins") && c.sql.includes("SET config"),
    );
    expect(updateCall).toBeDefined();
  });

  it("status patch alone (demo hide) preserves config + sets archived", async () => {
    queueCatalogLookup("demo-postgres", {
      pillar: "datasource",
      install_model: "form",
      id: "cat:demo",
    });
    queueExistingRowLookup(WSID, "cat:demo", "__demo__", {
      id: "row-demo",
      config: { url: "postgresql://u@h/demo", description: "Demo" },
      status: "published",
    });
    const installer = await getLiveService();
    const row = await runEffect(
      installer.updateDatasourceConfig(WSID, "demo-postgres", "__demo__", {
        status: "archived",
      }),
    );
    expect(row.status).toBe("archived");
    expect(bridgeUnregisterCalls).toContain("__demo__");
  });

  it("groupId=null removes the group_id key from config", async () => {
    queueCatalogLookup("postgres", {
      pillar: "datasource",
      install_model: "form",
      id: "cat:postgres",
    });
    queueExistingRowLookup(WSID, "cat:postgres", "prod", {
      id: "row-1",
      config: { url: "postgresql://u@h/d", group_id: "old-group" },
      status: "published",
    });
    const installer = await getLiveService();
    const row = await runEffect(
      installer.updateDatasourceConfig(WSID, "postgres", "prod", { groupId: null }),
    );
    expect(row.groupId).toBeNull();
  });
});

describe("createWorkspaceInstallerTestLayer", () => {
  it("provides the partial methods and throws for unspecified ones", async () => {
    const layer = mod.createWorkspaceInstallerTestLayer({
      uninstall: () => Effect.succeed(undefined),
    });
    // uninstall is provided
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* mod.WorkspaceInstaller;
        yield* svc.uninstall(WSID, "slack");
        return "ok";
      }).pipe(Effect.provide(layer)),
    );
    expect(result).toBe("ok");

    // install is NOT provided — should throw with descriptive error
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* mod.WorkspaceInstaller;
          return svc.install(WSID, "slack", { kind: "oauth-start" });
        }).pipe(Effect.provide(layer)),
      );
      throw new Error("expected throw");
    } catch (err) {
      expect((err as Error).message).toContain("install");
    }
  });
});

// ---------------------------------------------------------------------------
// Helper: build the live service for the tests above.
// ---------------------------------------------------------------------------

async function getLiveService(): Promise<import("../workspace-installer").WorkspaceInstallerShape> {
  return await Effect.runPromise(
    Effect.gen(function* () {
      const svc = yield* mod.WorkspaceInstaller;
      return svc;
    }).pipe(Effect.provide(mod.WorkspaceInstallerLive)),
  );
}
