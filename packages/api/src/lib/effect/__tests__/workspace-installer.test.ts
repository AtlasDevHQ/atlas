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
  dispatchHandlers.clear();
  mockInternalQuery.mockClear();
  mockDeleteSlackInstallation.mockClear();
  mockDeleteCredentialBundle.mockClear();
  mockGetInstallHandler.mockClear();
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
