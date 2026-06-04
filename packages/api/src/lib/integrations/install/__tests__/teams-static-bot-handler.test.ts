/**
 * Tests for {@link TeamsStaticBotInstallHandler} — slice 14 of 1.5.3
 * (issue #2752). Teams is the third concrete implementation of the
 * `StaticBotInstallHandler` interface keystoned by Telegram (#2748)
 * after Discord (#2749).
 *
 * The shared contract pinned by `telegram-static-bot-handler.test.ts`
 * and `discord-static-bot-handler.test.ts` carries over (validate
 * identifier → reachability round-trip → UPSERT → tagged errors → no
 * half-installed rows). The Teams-specific divergences this suite
 * exercises:
 *
 *   - Routing identifier is a Microsoft Entra ID **tenant GUID**
 *     (8-4-4-4-12 hex digit format) rather than a Discord snowflake or
 *     Telegram chat_id. Pasted `onmicrosoft.com` domains or display
 *     names are rejected before the API call.
 *   - Reachability is verified via Microsoft's public OIDC discovery
 *     endpoint (`https://login.microsoftonline.com/{tenant_id}/v2.0/.well-known/openid-configuration`).
 *     Microsoft's failure envelope is `{ error, error_description }`
 *     (AADSTS-prefixed strings); the surface message preserves
 *     `error_description` verbatim when present.
 *   - No operator credentials are sent on the wire — the OIDC
 *     discovery endpoint takes no auth, so there's no token-redaction
 *     surface to test.
 *   - Optional `tenant_name` rides through `extras` analogous to
 *     Discord's `guild_name` — admin-facing label only, dropped
 *     silently when malformed.
 *   - Mixed-case GUID inputs are normalized to lowercase before
 *     persistence so lookups by tenant_id stay consistent regardless
 *     of paste source.
 *
 * `mock.module()` stubs the module dependencies the handler reaches into:
 * `lib/billing/enforcement` (`checkChatIntegrationLimitAndInstall` — the
 * atomic cap-gate that owns the `workspace_plugins` UPSERT post-#3001, which
 * Teams adopted in #3142) and the global `fetch` used for the OIDC discovery
 * call. Each mock exports every named export it shadows (CLAUDE.md "mock all
 * exports" rule).
 */

import { afterEach, beforeEach, describe, expect, it, mock, type Mock } from "bun:test";
import type { WorkspaceId } from "@useatlas/types";

// ---------------------------------------------------------------------------
// Module mocks — hoist above the handler import
// ---------------------------------------------------------------------------

// The handler's cross-workspace ownership guard (#3154) reads
// `workspace_plugins` via `internalQuery` before the cap gate. Default returns
// [] (no conflict); the guard test overrides it to a matching row.
const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<unknown[]>> = mock(
  () => Promise.resolve([]),
);
mock.module("@atlas/api/lib/db/internal", () => ({
  internalQuery: mockInternalQuery,
  hasInternalDB: mock(() => true),
  getInternalDB: mock(() => ({ query: mock(() => Promise.resolve({ rows: [] })) })),
}));

// The chat-integration cap + the workspace_plugins UPSERT run atomically
// through `checkChatIntegrationLimitAndInstall` (#3001) — the gate owns the
// write and returns the RETURNING rows. We stub it to "allowed" with a scripted
// row id so these handler tests stay focused on the install contract (tenant_id
// validation, OIDC reachability, config payload) and assert the UPSERT shape via
// the gate's `insert` arg. The cap-enforcement decision + transaction
// sequencing live in `billing/__tests__/enforcement.test.ts`.
type GateResult =
  | { allowed: true; rows: Array<Record<string, unknown>> }
  | { allowed: false; reason: "cap_reached"; errorMessage: string; limit: number }
  | { allowed: false; reason: "check_failed"; errorMessage: string };
const mockCheckChatLimitAndInstall: Mock<
  (
    orgId: string | undefined,
    catalogId: string,
    insert: { sql: string; params: readonly unknown[] },
  ) => Promise<GateResult>
> = mock(() => Promise.resolve({ allowed: true as const, rows: [{ id: "install-teams-row-1" }] }));

// Mock every value export — a partial `mock.module()` causes a `SyntaxError`
// in other files importing the missing exports (per CLAUDE.md "Mock all
// exports"). Only `checkChatIntegrationLimitAndInstall` is exercised here.
mock.module("@atlas/api/lib/billing/enforcement", () => ({
  checkChatIntegrationLimitAndInstall: mockCheckChatLimitAndInstall,
  CHAT_INTEGRATION_COUNT_SQL: "SELECT 1",
  checkResourceLimit: () => Promise.resolve({ allowed: true }),
  checkPlanLimits: () => Promise.resolve({ allowed: true }),
  getCachedWorkspace: () => Promise.resolve(null),
  invalidatePlanCache: () => {},
  buildMetricStatus: () => ({ metric: "tokens", currentUsage: 0, limit: 0, usagePercent: 0, status: "ok" }),
  severityOf: () => 0,
}));

/** Pull the gate's `insert` arg from the most recent call (module-level so the
 *  validation + persistence describes can both read the UPSERT it would run). */
function lastGateInsert(): { sql: string; params: readonly unknown[] } {
  const calls = mockCheckChatLimitAndInstall.mock.calls;
  return calls[calls.length - 1][2];
}

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

const wsid = "org-test" as WorkspaceId;

// Sample tenant GUID — Microsoft's well-known `72f988bf-…` example used
// throughout their docs. The handler doesn't care what tenant this is;
// the OIDC fetch is mocked.
const SAMPLE_TENANT = "72f988bf-86f1-41af-91ab-2d7cd011db47";

interface FetchCall {
  readonly url: string;
  readonly init?: RequestInit;
}
const fetchCalls: FetchCall[] = [];
const ORIGINAL_FETCH = globalThis.fetch;

type FetchInput = string | URL | Request;

function setFetchOk(): void {
  globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), ...(init ? { init } : {}) });
    // Minimal subset of the OIDC discovery payload — the handler
    // doesn't read any field, only the 2xx status.
    return new Response(
      JSON.stringify({
        issuer: `https://login.microsoftonline.com/${SAMPLE_TENANT}/v2.0`,
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as unknown as typeof fetch;
}

function setFetchMicrosoftError(
  errorDescription: string,
  status: number,
  errorCode = "invalid_tenant",
): void {
  globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), ...(init ? { init } : {}) });
    return new Response(
      JSON.stringify({ error: errorCode, error_description: errorDescription }),
      { status, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

function setFetchNonJson(status: number): void {
  globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), ...(init ? { init } : {}) });
    return new Response("not json at all", {
      status,
      headers: { "content-type": "text/html" },
    });
  }) as unknown as typeof fetch;
}

function setFetchNetworkError(): void {
  globalThis.fetch = (async () => {
    throw new TypeError("simulated network failure");
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  mockCheckChatLimitAndInstall.mockClear();
  mockCheckChatLimitAndInstall.mockImplementation(() =>
    Promise.resolve({ allowed: true as const, rows: [{ id: "install-teams-row-1" }] }),
  );
  mockInternalQuery.mockClear();
  mockInternalQuery.mockImplementation(() => Promise.resolve([]));
  fetchCalls.length = 0;
  setFetchOk();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

// ---------------------------------------------------------------------------
// Handler import (after mocks)
// ---------------------------------------------------------------------------

import {
  TeamsStaticBotInstallHandler,
  TEAMS_CATALOG_ID,
  TEAMS_SLUG,
  TEAMS_TENANT_ID_RE,
} from "../teams-static-bot-handler";

// ---------------------------------------------------------------------------
// Constructor + kind
// ---------------------------------------------------------------------------

describe("TeamsStaticBotInstallHandler — shape", () => {
  it("identifies itself with kind: 'static-bot' for dispatch narrowing", () => {
    const handler = new TeamsStaticBotInstallHandler({
      appId: "app-id",
      appPassword: "app-pwd",
    });
    expect(handler.kind).toBe("static-bot");
  });

  it("refuses to construct when appId is empty — actionable env name in the error", () => {
    expect(
      () => new TeamsStaticBotInstallHandler({ appId: "", appPassword: "pwd" }),
    ).toThrow(/TEAMS_APP_ID/);
  });

  it("refuses to construct when appPassword is empty — actionable env name in the error", () => {
    expect(
      () => new TeamsStaticBotInstallHandler({ appId: "id", appPassword: "" }),
    ).toThrow(/TEAMS_APP_PASSWORD/);
  });

  it("exposes applicationId for the manifest download / AppSource deep-link routes", () => {
    const handler = new TeamsStaticBotInstallHandler({
      appId: "the-app-id",
      appPassword: "pwd",
    });
    expect(handler.applicationId).toBe("the-app-id");
  });

  it("exports TEAMS_SLUG and TEAMS_CATALOG_ID — wired into register.ts + workspace-installer dispatch", () => {
    expect(TEAMS_SLUG).toBe("teams");
    expect(TEAMS_CATALOG_ID).toBe("catalog:teams");
  });

  it("TEAMS_TENANT_ID_RE accepts canonical GUIDs and rejects obvious paste-mistakes", () => {
    // Canonical lowercase
    expect(TEAMS_TENANT_ID_RE.test("72f988bf-86f1-41af-91ab-2d7cd011db47")).toBe(true);
    // Uppercase — accepted, normalized to lowercase at confirmInstall
    expect(TEAMS_TENANT_ID_RE.test("72F988BF-86F1-41AF-91AB-2D7CD011DB47")).toBe(true);
    // Tenant domain — rejected
    expect(TEAMS_TENANT_ID_RE.test("contoso.onmicrosoft.com")).toBe(false);
    // Missing hyphens
    expect(TEAMS_TENANT_ID_RE.test("72f988bf86f141af91ab2d7cd011db47")).toBe(false);
    // Non-hex character
    expect(TEAMS_TENANT_ID_RE.test("72f988bg-86f1-41af-91ab-2d7cd011db47")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// tenant_id validation
// ---------------------------------------------------------------------------

describe("TeamsStaticBotInstallHandler.confirmInstall — tenant_id validation", () => {
  it("rejects empty tenant_id", async () => {
    const handler = new TeamsStaticBotInstallHandler({ appId: "id", appPassword: "pwd" });
    await expect(handler.confirmInstall(wsid, "")).rejects.toThrow(/tenant_id/);
    expect(mockCheckChatLimitAndInstall).not.toHaveBeenCalled();
    // No upstream call either — format validation happens first.
    expect(fetchCalls).toHaveLength(0);
  });

  it("rejects tenant domains (contoso.onmicrosoft.com) — admins routinely paste these by mistake", async () => {
    const handler = new TeamsStaticBotInstallHandler({ appId: "id", appPassword: "pwd" });
    await expect(handler.confirmInstall(wsid, "contoso.onmicrosoft.com")).rejects.toThrow(
      /tenant_id/,
    );
    expect(mockCheckChatLimitAndInstall).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
  });

  it("rejects tenant display names / non-GUID strings", async () => {
    const handler = new TeamsStaticBotInstallHandler({ appId: "id", appPassword: "pwd" });
    await expect(handler.confirmInstall(wsid, "Contoso Engineering")).rejects.toThrow(
      /tenant_id/,
    );
    await expect(handler.confirmInstall(wsid, "12345")).rejects.toThrow(/tenant_id/);
    expect(mockCheckChatLimitAndInstall).not.toHaveBeenCalled();
  });

  it("rejects malformed GUIDs (missing hyphens, wrong segment lengths)", async () => {
    const handler = new TeamsStaticBotInstallHandler({ appId: "id", appPassword: "pwd" });
    await expect(
      handler.confirmInstall(wsid, "72f988bf86f141af91ab2d7cd011db47"),
    ).rejects.toThrow(/tenant_id/);
    await expect(
      handler.confirmInstall(wsid, "72f988bf-86f1-41af-91ab-2d7cd011db4"),
    ).rejects.toThrow(/tenant_id/);
    expect(mockCheckChatLimitAndInstall).not.toHaveBeenCalled();
  });

  it("accepts a canonical lowercase tenant GUID", async () => {
    const handler = new TeamsStaticBotInstallHandler({ appId: "id", appPassword: "pwd" });
    const result = await handler.confirmInstall(wsid, SAMPLE_TENANT);
    expect(result.installRecord.catalogId).toBe(TEAMS_SLUG);
  });

  it("normalizes uppercase tenant GUIDs to lowercase before persist (so lookups by tenant_id stay consistent)", async () => {
    const handler = new TeamsStaticBotInstallHandler({ appId: "id", appPassword: "pwd" });
    await handler.confirmInstall(wsid, SAMPLE_TENANT.toUpperCase());
    const params = lastGateInsert().params;
    const configJson = (params as unknown[]).find(
      (p): p is string => typeof p === "string" && p.includes("tenant_id"),
    );
    expect(configJson).toBeDefined();
    const parsed = JSON.parse(configJson as string) as Record<string, unknown>;
    expect(parsed.tenant_id).toBe(SAMPLE_TENANT);
  });
});

// ---------------------------------------------------------------------------
// Cross-workspace ownership guard (#3154 GAP 2)
// ---------------------------------------------------------------------------

describe("TeamsStaticBotInstallHandler.confirmInstall — cross-workspace guard", () => {
  it("rejects a tenant_id already bound to a different workspace, and never reaches the cap gate", async () => {
    // Admin-consent proves tenant ownership, but two Atlas workspaces in the
    // same Microsoft tenant could both consent it — binding it twice would
    // collapse the read-side resolver. The guard SELECT finds an existing bind
    // in another workspace and refuses before the cap gate runs (first binder
    // wins).
    mockInternalQuery.mockImplementation(() =>
      Promise.resolve([{ workspace_id: "org-victim" }]),
    );
    const handler = new TeamsStaticBotInstallHandler({ appId: "id", appPassword: "pwd" });
    await expect(handler.confirmInstall(wsid, SAMPLE_TENANT)).rejects.toThrow(
      /already connected to a different Atlas workspace/i,
    );
    expect(mockCheckChatLimitAndInstall).not.toHaveBeenCalled();
    // The guard scopes its lookup to (catalog:teams, enabled, the normalized
    // tenant_id, workspace_id <> self) so a reconnect by the same workspace is
    // never caught.
    const [sql, params] = mockInternalQuery.mock.calls[0];
    expect(String(sql)).toMatch(/config->>'tenant_id'/);
    expect(String(sql)).toMatch(/workspace_id\s*<>\s*\$3/);
    expect(params).toEqual([TEAMS_CATALOG_ID, SAMPLE_TENANT, wsid]);
  });

  it("normalizes the tenant_id to lowercase before the cross-workspace lookup", async () => {
    mockInternalQuery.mockImplementation(() =>
      Promise.resolve([{ workspace_id: "org-victim" }]),
    );
    const handler = new TeamsStaticBotInstallHandler({ appId: "id", appPassword: "pwd" });
    await expect(handler.confirmInstall(wsid, SAMPLE_TENANT.toUpperCase())).rejects.toThrow(
      /already connected to a different Atlas workspace/i,
    );
    // The guard queries with the lowercased GUID so an uppercase paste still
    // collides with an existing lowercase-stored bind.
    const [, params] = mockInternalQuery.mock.calls[0];
    expect(params).toEqual([TEAMS_CATALOG_ID, SAMPLE_TENANT, wsid]);
  });

  it("allows the install when the tenant_id is bound only to the installing workspace (reconnect)", async () => {
    mockInternalQuery.mockImplementation(() => Promise.resolve([]));
    const handler = new TeamsStaticBotInstallHandler({ appId: "id", appPassword: "pwd" });
    const result = await handler.confirmInstall(wsid, SAMPLE_TENANT);
    expect(result.installRecord.catalogId).toBe(TEAMS_SLUG);
    expect(mockCheckChatLimitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the uniqueness pre-check query errors — aborts before the cap gate", async () => {
    mockInternalQuery.mockImplementation(() => Promise.reject(new Error("db down")));
    const handler = new TeamsStaticBotInstallHandler({ appId: "id", appPassword: "pwd" });
    await expect(handler.confirmInstall(wsid, SAMPLE_TENANT)).rejects.toThrow(/db down/);
    expect(mockCheckChatLimitAndInstall).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Reachability verification (OIDC discovery)
// ---------------------------------------------------------------------------

describe("TeamsStaticBotInstallHandler.confirmInstall — reachability verification", () => {
  it("calls the Microsoft OIDC discovery endpoint with the normalized tenant_id in the path", async () => {
    const handler = new TeamsStaticBotInstallHandler({ appId: "id", appPassword: "pwd" });
    await handler.confirmInstall(wsid, SAMPLE_TENANT);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(
      `https://login.microsoftonline.com/${SAMPLE_TENANT}/v2.0/.well-known/openid-configuration`,
    );
  });

  it("sends no Authorization header — the OIDC discovery endpoint takes no auth", async () => {
    const handler = new TeamsStaticBotInstallHandler({ appId: "id", appPassword: "pwd-secret" });
    await handler.confirmInstall(wsid, SAMPLE_TENANT);
    const headers = (fetchCalls[0].init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
  });

  it("throws with a clear error when Microsoft returns 'tenant not found' (400)", async () => {
    setFetchMicrosoftError(
      "AADSTS90002: Tenant '00000000-0000-0000-0000-000000000000' not found.",
      400,
    );
    const handler = new TeamsStaticBotInstallHandler({ appId: "id", appPassword: "pwd" });
    await expect(
      handler.confirmInstall(wsid, "00000000-0000-0000-0000-000000000000"),
    ).rejects.toThrow(/AADSTS90002/);
    expect(mockCheckChatLimitAndInstall).not.toHaveBeenCalled();
  });

  it("throws with a clear error when Microsoft returns 401/403 (tenant restricted)", async () => {
    setFetchMicrosoftError("AADSTS900561: The endpoint only accepts POST requests.", 401);
    const handler = new TeamsStaticBotInstallHandler({ appId: "id", appPassword: "pwd" });
    await expect(handler.confirmInstall(wsid, SAMPLE_TENANT)).rejects.toThrow(
      /AADSTS900561/,
    );
    expect(mockCheckChatLimitAndInstall).not.toHaveBeenCalled();
  });

  it("throws when the Microsoft API call fails at the network layer (no install row)", async () => {
    setFetchNetworkError();
    const handler = new TeamsStaticBotInstallHandler({ appId: "id", appPassword: "pwd" });
    await expect(handler.confirmInstall(wsid, SAMPLE_TENANT)).rejects.toThrow(
      /Microsoft tenant discovery unreachable/i,
    );
    expect(mockCheckChatLimitAndInstall).not.toHaveBeenCalled();
  });

  it("surfaces a status-only message when Microsoft returns a non-JSON error body", async () => {
    setFetchNonJson(503);
    const handler = new TeamsStaticBotInstallHandler({ appId: "id", appPassword: "pwd" });
    await expect(handler.confirmInstall(wsid, SAMPLE_TENANT)).rejects.toThrow(/HTTP 503/);
    expect(mockCheckChatLimitAndInstall).not.toHaveBeenCalled();
  });

  it("treats any 2xx as success even with an empty body — 200 is the only signal we use", async () => {
    // Pins the documented "skip JSON parse on 2xx" branch
    // (teams-static-bot-handler.ts: `if (response.status >= 200 ...`).
    // Microsoft's OIDC discovery payload is informational only — the
    // handler doesn't read any field from it, so a contract change that
    // ever returned an empty 200 should still resolve. If a future
    // refactor adds field validation, this test will fail and force a
    // rethink.
    globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), ...(init ? { init } : {}) });
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const handler = new TeamsStaticBotInstallHandler({ appId: "id", appPassword: "pwd" });
    const result = await handler.confirmInstall(wsid, SAMPLE_TENANT);
    expect(result.installRecord.catalogId).toBe(TEAMS_SLUG);
    expect(mockCheckChatLimitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("appends a hint when Microsoft returns a non-JSON 5xx (the actionable status-only voice)", async () => {
    // Counterpart to "no hint when upstreamMessage is present" — when
    // Microsoft returns a non-JSON body and we fall back to
    // `HTTP {status}`, the hint IS appended because it's the only
    // actionable text the admin gets.
    setFetchNonJson(500);
    const handler = new TeamsStaticBotInstallHandler({ appId: "id", appPassword: "pwd" });
    await expect(handler.confirmInstall(wsid, SAMPLE_TENANT)).rejects.toThrow(
      /Microsoft's identity platform is degraded/,
    );
  });

  it("does NOT append a hint when Microsoft's error_description already carries actionable text (no duplication)", async () => {
    // AADSTS90002 already says "Tenant '…' not found" — the 400 hint
    // ("double-check the tenant_id …") would just paraphrase that.
    // Keep the surface message clean.
    setFetchMicrosoftError(
      "AADSTS90002: Tenant 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' not found.",
      400,
    );
    const handler = new TeamsStaticBotInstallHandler({ appId: "id", appPassword: "pwd" });
    let caught: Error | undefined;
    try {
      await handler.confirmInstall(wsid, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    } catch (err) {
      caught = err instanceof Error ? err : new Error(String(err));
    }
    expect(caught?.message).toMatch(/AADSTS90002/);
    expect(caught?.message).not.toMatch(/double-check the tenant_id/);
  });
});

// ---------------------------------------------------------------------------
// Chat-integration cap (#3142 — migrated onto the atomic gate)
// ---------------------------------------------------------------------------

describe("TeamsStaticBotInstallHandler.confirmInstall — chat-integration cap", () => {
  it("throws ChatIntegrationLimitError and writes no install row when at cap", async () => {
    mockCheckChatLimitAndInstall.mockImplementationOnce(() =>
      Promise.resolve({
        allowed: false as const,
        reason: "cap_reached" as const,
        errorMessage: "Your starter plan allows up to 1 chat integration. Upgrade to add more.",
        limit: 1,
      }),
    );
    const handler = new TeamsStaticBotInstallHandler({ appId: "id", appPassword: "pwd" });

    await expect(handler.confirmInstall(wsid, SAMPLE_TENANT)).rejects.toMatchObject({
      _tag: "ChatIntegrationLimitError",
      limit: 1,
    });

    // The gate enforced the cap (after the OIDC round-trip), keyed on the
    // workspace + Teams catalog id, with the UPSERT it would have committed.
    expect(mockCheckChatLimitAndInstall).toHaveBeenCalledTimes(1);
    const [gateOrg, gateCatalog, gateInsert] = mockCheckChatLimitAndInstall.mock.calls[0];
    expect(gateOrg).toBe(wsid);
    expect(gateCatalog).toBe(TEAMS_CATALOG_ID);
    expect(gateInsert.sql).toMatch(/INSERT INTO workspace_plugins/);
  });

  it("throws BillingCheckFailedError (not the cap error) when the count check fails closed", async () => {
    mockCheckChatLimitAndInstall.mockImplementationOnce(() =>
      Promise.resolve({
        allowed: false as const,
        reason: "check_failed" as const,
        errorMessage: "Unable to verify plan limits. Please try again.",
      }),
    );
    const handler = new TeamsStaticBotInstallHandler({ appId: "id", appPassword: "pwd" });

    await expect(handler.confirmInstall(wsid, SAMPLE_TENANT)).rejects.toMatchObject({
      _tag: "BillingCheckFailedError",
    });
    expect(mockCheckChatLimitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("grandfathers a reconnect — the gate allows an already-installed workspace and returns the existing id", async () => {
    mockCheckChatLimitAndInstall.mockImplementationOnce(() =>
      Promise.resolve({ allowed: true as const, rows: [{ id: "existing-install-row" }] }),
    );
    const handler = new TeamsStaticBotInstallHandler({ appId: "id", appPassword: "pwd" });
    const result = await handler.confirmInstall(wsid, SAMPLE_TENANT);
    expect(result.installRecord.id).toBe("existing-install-row");
    expect(mockCheckChatLimitAndInstall).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe("TeamsStaticBotInstallHandler.confirmInstall — persistence", () => {
  it("UPSERTs workspace_plugins with the catalog id + tenant_id config payload via the cap gate", async () => {
    const handler = new TeamsStaticBotInstallHandler({ appId: "id", appPassword: "pwd" });
    await handler.confirmInstall(wsid, SAMPLE_TENANT, undefined, {
      tenant_name: "Acme Engineering",
    });

    expect(mockCheckChatLimitAndInstall).toHaveBeenCalledTimes(1);
    const insert = lastGateInsert();
    const sqlText = insert.sql;
    expect(sqlText).toMatch(/INSERT INTO workspace_plugins/);
    // Required NOT NULL columns post-0092 / 0096 — the INSERT must
    // name pillar + install_id explicitly, and chat-pillar installs
    // target the partial singleton index via the WHERE clause on the
    // conflict target so re-install is idempotent.
    expect(sqlText).toMatch(/install_id/);
    expect(sqlText).toMatch(/pillar/);
    expect(sqlText).toMatch(/'chat'/);
    expect(sqlText).toMatch(/ON CONFLICT.*workspace_id.*catalog_id.*WHERE.*pillar.*DO UPDATE/s);
    // The gate runs the UPSERT under the lock, so RETURNING id must be present.
    expect(sqlText).toMatch(/RETURNING id/);

    const paramsArr = insert.params as unknown[];
    expect(paramsArr).toContain(wsid);
    expect(paramsArr).toContain(TEAMS_CATALOG_ID);
    const configJson = paramsArr.find(
      (p): p is string => typeof p === "string" && p.includes("tenant_id"),
    );
    expect(configJson).toBeDefined();
    const parsed = JSON.parse(configJson as string) as Record<string, unknown>;
    expect(parsed.tenant_id).toBe(SAMPLE_TENANT);
    expect(parsed.tenant_name).toBe("Acme Engineering");
  });

  it("omits tenant_name from config when extras don't supply one (no API-side fallback like Discord)", async () => {
    // Unlike Discord's `GET /guilds/{id}` (which returns the guild
    // name), Microsoft's OIDC discovery payload doesn't carry a
    // human-readable tenant name. We deliberately don't roundtrip to
    // MS Graph for it — the field stays optional.
    const handler = new TeamsStaticBotInstallHandler({ appId: "id", appPassword: "pwd" });
    await handler.confirmInstall(wsid, SAMPLE_TENANT);
    const params = lastGateInsert().params;
    const configJson = (params as unknown[]).find(
      (p): p is string => typeof p === "string" && p.includes("tenant_id"),
    );
    const parsed = JSON.parse(configJson as string) as Record<string, unknown>;
    expect(parsed.tenant_id).toBe(SAMPLE_TENANT);
    expect("tenant_name" in parsed).toBe(false);
  });

  it("drops tenant_name when extras supplies the wrong type (number / null) — logs but doesn't throw", async () => {
    const handler = new TeamsStaticBotInstallHandler({ appId: "id", appPassword: "pwd" });
    await handler.confirmInstall(wsid, SAMPLE_TENANT, undefined, {
      tenant_name: 12345 as unknown as string,
    });
    const params = lastGateInsert().params;
    const configJson = (params as unknown[]).find(
      (p): p is string => typeof p === "string" && p.includes("tenant_id"),
    );
    const parsed = JSON.parse(configJson as string) as Record<string, unknown>;
    expect("tenant_name" in parsed).toBe(false);
  });

  it("returns the persisted install id from the gate's RETURNING rows (re-install idempotency)", async () => {
    mockCheckChatLimitAndInstall.mockImplementation(() =>
      Promise.resolve({ allowed: true as const, rows: [{ id: "existing-install-row" }] }),
    );
    const handler = new TeamsStaticBotInstallHandler({ appId: "id", appPassword: "pwd" });
    const result = await handler.confirmInstall(wsid, SAMPLE_TENANT);
    expect(result.installRecord.id).toBe("existing-install-row");
    expect(result.installRecord.workspaceId).toBe(wsid);
    expect(result.installRecord.catalogId).toBe(TEAMS_SLUG);
  });

  it("throws when the gate's RETURNING rows are empty — never ships a candidate id that doesn't match the persisted row", async () => {
    mockCheckChatLimitAndInstall.mockImplementation(() =>
      Promise.resolve({ allowed: true as const, rows: [] }),
    );
    const handler = new TeamsStaticBotInstallHandler({
      appId: "id",
      appPassword: "pwd",
      idGenerator: () => "candidate-id-xyz",
    });
    await expect(handler.confirmInstall(wsid, SAMPLE_TENANT)).rejects.toThrow(
      /RETURNING must always populate/,
    );
  });

  it("surfaces DB failure rather than half-installing — no return after a throw", async () => {
    // The gate throws on a genuine write-path failure (after rolling back).
    mockCheckChatLimitAndInstall.mockImplementation(() => Promise.reject(new Error("DB down")));
    const handler = new TeamsStaticBotInstallHandler({ appId: "id", appPassword: "pwd" });
    await expect(handler.confirmInstall(wsid, SAMPLE_TENANT)).rejects.toThrow(/DB down/);
  });
});

// ---------------------------------------------------------------------------
// verificationProof — interface-defined but unused for Teams today
// ---------------------------------------------------------------------------

describe("TeamsStaticBotInstallHandler.confirmInstall — verificationProof", () => {
  it("ignores verificationProof when supplied — reachability is verified server-side via OIDC discovery", async () => {
    const handler = new TeamsStaticBotInstallHandler({ appId: "id", appPassword: "pwd" });
    const result = await handler.confirmInstall(wsid, SAMPLE_TENANT, "ignored-proof");
    expect(result.installRecord.catalogId).toBe(TEAMS_SLUG);
    expect(fetchCalls).toHaveLength(1);
  });
});
