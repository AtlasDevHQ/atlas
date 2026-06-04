/**
 * Tests for {@link WhatsAppStaticBotInstallHandler} — slice 15 of 1.5.3
 * (issue #2753). WhatsApp is the fourth concrete implementation of the
 * `StaticBotInstallHandler` interface keystoned by Telegram (#2748)
 * after Discord (#2749) and Teams (#2752).
 *
 * The shared contract pinned by the sibling handler tests carries over
 * (validate identifier → reachability round-trip → UPSERT → tagged
 * errors → no half-installed rows). The WhatsApp-specific divergences
 * this suite exercises:
 *
 *   - Routing identifier is a **Meta phone_number_id** — a numeric
 *     routing id distinct from the human-readable phone number. Pasted
 *     phone numbers (`+1 415 555 0100`) and WhatsApp Business Account
 *     IDs are rejected before the API call.
 *   - Reachability is verified via Meta Graph API
 *     `GET /v21.0/{phone_number_id}` with the operator access token in
 *     `Authorization: Bearer`. Meta's failure envelope is nested under
 *     `{ error: { message, code, ... } }` — distinct from Discord's
 *     top-level `{ message, code }`.
 *   - Optional `display_phone` rides through `extras` analogous to
 *     Discord's `guild_name`, and falls back to Meta's
 *     `display_phone_number` when extras don't supply one (mirrors the
 *     Discord guild-name fallback).
 *   - Token redaction is NOT required for the URL — the access token
 *     rides in `Authorization: Bearer`, not in the path — but we still
 *     assert errors don't attach `cause: err` (preserves symmetry with
 *     the Discord / Telegram / Teams safe-by-default posture).
 *
 * `mock.module()` stubs the module dependencies the handler reaches into:
 * `lib/billing/enforcement` (`checkChatIntegrationLimitAndInstall` — the
 * atomic cap-gate that owns the `workspace_plugins` UPSERT post-#3001, which
 * WhatsApp adopted in #3144) and the global `fetch` used for the Meta Graph
 * API call. Each mock exports every named export it shadows (CLAUDE.md "mock
 * all exports" rule).
 */

import { afterEach, beforeEach, describe, expect, it, mock, type Mock } from "bun:test";
import type { WorkspaceId } from "@useatlas/types";

// ---------------------------------------------------------------------------
// Module mocks — hoist above the handler import
// ---------------------------------------------------------------------------

// The handler's cross-workspace ownership guard (#3144) reads
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
// row id so these handler tests stay focused on the install contract
// (phone_number_id validation, Meta Graph reachability, config payload) and
// assert the UPSERT shape via the gate's `insert` arg. The cap-enforcement
// decision + transaction sequencing live in `billing/__tests__/enforcement.test.ts`.
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
> = mock(() => Promise.resolve({ allowed: true as const, rows: [{ id: "install-whatsapp-row-1" }] }));

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

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

const wsid = "org-test" as WorkspaceId;

// Sample phone_number_id — Meta's docs use 15-digit numeric ids; this
// is shape-correct without being any real production number.
const SAMPLE_PHONE_NUMBER_ID = "1098765432109876";

interface FetchCall {
  readonly url: string;
  readonly init?: RequestInit;
}
const fetchCalls: FetchCall[] = [];
const ORIGINAL_FETCH = globalThis.fetch;

type FetchInput = string | URL | Request;

function setFetchOk(
  body: { id?: string; display_phone_number?: string; verified_name?: string } = {},
): void {
  globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), ...(init ? { init } : {}) });
    return new Response(
      JSON.stringify({
        id: body.id ?? SAMPLE_PHONE_NUMBER_ID,
        ...(body.display_phone_number !== undefined
          ? { display_phone_number: body.display_phone_number }
          : { display_phone_number: "+1 415 555 0100" }),
        ...(body.verified_name !== undefined
          ? { verified_name: body.verified_name }
          : { verified_name: "Atlas Test Co" }),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

function setFetchMetaError(message: string, code: number, status: number): void {
  globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), ...(init ? { init } : {}) });
    return new Response(
      JSON.stringify({ error: { message, type: "OAuthException", code } }),
      { status, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

function setFetchNonJson(status: number): void {
  globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), ...(init ? { init } : {}) });
    return new Response("<html>error</html>", {
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
    Promise.resolve({ allowed: true as const, rows: [{ id: "install-whatsapp-row-1" }] }),
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
  WhatsAppStaticBotInstallHandler,
  WHATSAPP_CATALOG_ID,
  WHATSAPP_SLUG,
  WHATSAPP_PHONE_NUMBER_ID_RE,
} from "../whatsapp-static-bot-handler";

// ---------------------------------------------------------------------------
// Constructor + kind
// ---------------------------------------------------------------------------

describe("WhatsAppStaticBotInstallHandler — shape", () => {
  it("identifies itself with kind: 'static-bot' for dispatch narrowing", () => {
    const handler = new WhatsAppStaticBotInstallHandler({
      accessToken: "EAAxxx",
      appId: "111222333",
    });
    expect(handler.kind).toBe("static-bot");
  });

  it("refuses to construct when accessToken is empty — actionable env name in the error", () => {
    expect(
      () => new WhatsAppStaticBotInstallHandler({ accessToken: "", appId: "id" }),
    ).toThrow(/META_BUSINESS_ACCESS_TOKEN/);
  });

  it("refuses to construct when appId is empty — actionable env name in the error", () => {
    expect(
      () => new WhatsAppStaticBotInstallHandler({ accessToken: "t", appId: "" }),
    ).toThrow(/META_BUSINESS_APP_ID/);
  });

  it("exposes applicationId for the setup link / manifest deep-link routes", () => {
    const handler = new WhatsAppStaticBotInstallHandler({
      accessToken: "EAAxxx",
      appId: "the-meta-app-id",
    });
    expect(handler.applicationId).toBe("the-meta-app-id");
  });

  it("exports WHATSAPP_SLUG and WHATSAPP_CATALOG_ID — wired into register.ts + workspace-installer dispatch", () => {
    expect(WHATSAPP_SLUG).toBe("whatsapp");
    expect(WHATSAPP_CATALOG_ID).toBe("catalog:whatsapp");
  });

  it("WHATSAPP_PHONE_NUMBER_ID_RE accepts numeric ids and rejects obvious paste-mistakes", () => {
    // Canonical 16-digit id
    expect(WHATSAPP_PHONE_NUMBER_ID_RE.test(SAMPLE_PHONE_NUMBER_ID)).toBe(true);
    // 10-digit edge of the valid range
    expect(WHATSAPP_PHONE_NUMBER_ID_RE.test("1234567890")).toBe(true);
    // Human-readable phone number — rejected
    expect(WHATSAPP_PHONE_NUMBER_ID_RE.test("+1 415 555 0100")).toBe(false);
    expect(WHATSAPP_PHONE_NUMBER_ID_RE.test("+14155550100")).toBe(false);
    // Too short
    expect(WHATSAPP_PHONE_NUMBER_ID_RE.test("123456")).toBe(false);
    // Non-numeric characters
    expect(WHATSAPP_PHONE_NUMBER_ID_RE.test("12345abc6789")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// phone_number_id validation
// ---------------------------------------------------------------------------

describe("WhatsAppStaticBotInstallHandler.confirmInstall — phone_number_id validation", () => {
  it("rejects empty phone_number_id", async () => {
    const handler = new WhatsAppStaticBotInstallHandler({ accessToken: "t", appId: "id" });
    await expect(handler.confirmInstall(wsid, "")).rejects.toThrow(/phone_number_id/);
    expect(mockCheckChatLimitAndInstall).not.toHaveBeenCalled();
    // No upstream call either — format validation happens first.
    expect(fetchCalls).toHaveLength(0);
  });

  it("rejects human-readable phone numbers — admins routinely paste these by mistake", async () => {
    const handler = new WhatsAppStaticBotInstallHandler({ accessToken: "t", appId: "id" });
    await expect(handler.confirmInstall(wsid, "+1 415 555 0100")).rejects.toThrow(
      /phone_number_id/,
    );
    await expect(handler.confirmInstall(wsid, "+14155550100")).rejects.toThrow(
      /phone_number_id/,
    );
    expect(mockCheckChatLimitAndInstall).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
  });

  it("rejects non-numeric strings (display names, etc.)", async () => {
    const handler = new WhatsAppStaticBotInstallHandler({ accessToken: "t", appId: "id" });
    await expect(handler.confirmInstall(wsid, "Acme Inc")).rejects.toThrow(
      /phone_number_id/,
    );
    await expect(handler.confirmInstall(wsid, "12345abc")).rejects.toThrow(
      /phone_number_id/,
    );
    expect(mockCheckChatLimitAndInstall).not.toHaveBeenCalled();
  });

  it("accepts a canonical numeric id", async () => {
    const handler = new WhatsAppStaticBotInstallHandler({ accessToken: "t", appId: "id" });
    const result = await handler.confirmInstall(wsid, SAMPLE_PHONE_NUMBER_ID);
    expect(result.installRecord.catalogId).toBe(WHATSAPP_SLUG);
  });
});

// ---------------------------------------------------------------------------
// Reachability verification (Meta Graph API)
// ---------------------------------------------------------------------------

describe("WhatsAppStaticBotInstallHandler.confirmInstall — reachability verification", () => {
  it("calls Meta Graph API with the phone_number_id in the path and bearer auth", async () => {
    const handler = new WhatsAppStaticBotInstallHandler({
      accessToken: "EAA-test-token",
      appId: "id",
    });
    await handler.confirmInstall(wsid, SAMPLE_PHONE_NUMBER_ID);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(
      `https://graph.facebook.com/v21.0/${SAMPLE_PHONE_NUMBER_ID}?fields=verified_name,display_phone_number`,
    );
    const headers = (fetchCalls[0].init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer EAA-test-token");
  });

  it("never embeds the access token in the URL — token rides in Authorization header", async () => {
    const handler = new WhatsAppStaticBotInstallHandler({
      accessToken: "EAA-secret-do-not-leak",
      appId: "id",
    });
    await handler.confirmInstall(wsid, SAMPLE_PHONE_NUMBER_ID);
    expect(fetchCalls[0].url).not.toContain("EAA-secret-do-not-leak");
  });

  it("throws WhatsAppReachabilityError when Meta returns code 100 (phone not in operator's Business Account)", async () => {
    setFetchMetaError(
      "Unsupported get request. Object with ID '0' does not exist, cannot be loaded due to missing permissions, or does not support this operation.",
      100,
      400,
    );
    const handler = new WhatsAppStaticBotInstallHandler({ accessToken: "t", appId: "id" });
    await expect(handler.confirmInstall(wsid, SAMPLE_PHONE_NUMBER_ID)).rejects.toThrow(
      /Unsupported get request/,
    );
    expect(mockCheckChatLimitAndInstall).not.toHaveBeenCalled();
  });

  it("appends the operator-side hint for code 100 (phone not shared into Business Account)", async () => {
    setFetchMetaError("Tried accessing nonexisting field", 100, 400);
    const handler = new WhatsAppStaticBotInstallHandler({ accessToken: "t", appId: "id" });
    let caught: Error | undefined;
    try {
      await handler.confirmInstall(wsid, SAMPLE_PHONE_NUMBER_ID);
    } catch (err) {
      caught = err instanceof Error ? err : new Error(String(err));
    }
    expect(caught?.message).toContain("isn't visible to the operator's Meta Business Account");
  });

  it("throws with token-rotation hint when Meta returns code 190 (token expired)", async () => {
    setFetchMetaError("Error validating access token: Session has expired.", 190, 401);
    const handler = new WhatsAppStaticBotInstallHandler({ accessToken: "t", appId: "id" });
    let caught: Error | undefined;
    try {
      await handler.confirmInstall(wsid, SAMPLE_PHONE_NUMBER_ID);
    } catch (err) {
      caught = err instanceof Error ? err : new Error(String(err));
    }
    expect(caught?.message).toMatch(/META_BUSINESS_ACCESS_TOKEN/);
    expect(mockCheckChatLimitAndInstall).not.toHaveBeenCalled();
  });

  it("throws WhatsAppApiUnavailableError when the Graph API call fails at the network layer (no install row)", async () => {
    setFetchNetworkError();
    const handler = new WhatsAppStaticBotInstallHandler({ accessToken: "t", appId: "id" });
    await expect(handler.confirmInstall(wsid, SAMPLE_PHONE_NUMBER_ID)).rejects.toThrow(
      /Meta Graph API unreachable/,
    );
    expect(mockCheckChatLimitAndInstall).not.toHaveBeenCalled();
  });

  it("throws when Meta returns a non-JSON body — upstream contract violation", async () => {
    setFetchNonJson(503);
    const handler = new WhatsAppStaticBotInstallHandler({ accessToken: "t", appId: "id" });
    await expect(handler.confirmInstall(wsid, SAMPLE_PHONE_NUMBER_ID)).rejects.toThrow(
      /Meta Graph API/,
    );
    expect(mockCheckChatLimitAndInstall).not.toHaveBeenCalled();
  });

  it("throws when Meta returns 2xx but no id field — upstream contract violation, not silent success", async () => {
    globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), ...(init ? { init } : {}) });
      return new Response(JSON.stringify({ foo: "bar" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const handler = new WhatsAppStaticBotInstallHandler({ accessToken: "t", appId: "id" });
    await expect(handler.confirmInstall(wsid, SAMPLE_PHONE_NUMBER_ID)).rejects.toThrow(
      /unexpected response shape/,
    );
    expect(mockCheckChatLimitAndInstall).not.toHaveBeenCalled();
  });

  it("refuses 2xx responses that ALSO carry an error envelope — silent-success defense (P0 from review)", async () => {
    // Meta has been observed to ship 200/204 responses with a populated
    // `error` object on partial-batch traversals / debug-payload opt-ins
    // / proxy-injected envelopes. Treating those as success would write
    // a workspace_plugins row for a phone number Meta is actively
    // rejecting. Parser refuses; caller surfaces upstream-contract
    // violation. The previous version of this parser would silently
    // succeed here.
    globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), ...(init ? { init } : {}) });
      return new Response(
        JSON.stringify({
          id: SAMPLE_PHONE_NUMBER_ID,
          error: { message: "Partial batch failure", type: "Exception", code: 200 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const handler = new WhatsAppStaticBotInstallHandler({ accessToken: "t", appId: "id" });
    await expect(handler.confirmInstall(wsid, SAMPLE_PHONE_NUMBER_ID)).rejects.toThrow(
      /unexpected response shape/,
    );
    expect(mockCheckChatLimitAndInstall).not.toHaveBeenCalled();
  });

  it("refuses non-2xx responses with an empty error envelope — upstream contract violation", async () => {
    // The `{ message: "", code: 0 }` empty-body branch in the parser
    // forces this path through `WhatsAppApiUnavailableError` rather
    // than fabricating a WhatsAppReachabilityError with an empty
    // message (which would surface as "Meta rejected …:  — " with no
    // hint for the admin).
    globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), ...(init ? { init } : {}) });
      return new Response(JSON.stringify({ error: {} }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const handler = new WhatsAppStaticBotInstallHandler({ accessToken: "t", appId: "id" });
    await expect(handler.confirmInstall(wsid, SAMPLE_PHONE_NUMBER_ID)).rejects.toThrow(
      /unexpected response shape/,
    );
    expect(mockCheckChatLimitAndInstall).not.toHaveBeenCalled();
  });

  it("does NOT attach the underlying fetch error as `cause` — preserves the no-leak posture on Authorization headers", async () => {
    // A future pino serializer walking through `cause` could otherwise
    // dump the request headers (which include `Authorization: Bearer
    // <token>`). The keystone family preserves `cause: undefined`
    // explicitly; this test locks the invariant on the WhatsApp
    // handler so a well-intentioned refactor can't silently
    // re-introduce the leak.
    setFetchNetworkError();
    const handler = new WhatsAppStaticBotInstallHandler({
      accessToken: "EAA-secret-do-not-leak",
      appId: "id",
    });
    let caught: Error | undefined;
    try {
      await handler.confirmInstall(wsid, SAMPLE_PHONE_NUMBER_ID);
    } catch (err) {
      caught = err instanceof Error ? err : new Error(String(err));
    }
    expect(caught).toBeDefined();
    expect(caught?.cause).toBeUndefined();
    // Belt-and-suspenders: the surface message must not contain the
    // raw token either.
    expect(caught?.message).not.toContain("EAA-secret-do-not-leak");
  });

  it("does NOT attach `cause` on the reachability-error path (Meta returned 4xx)", async () => {
    setFetchMetaError("Tried accessing nonexisting field", 100, 400);
    const handler = new WhatsAppStaticBotInstallHandler({
      accessToken: "EAA-secret-do-not-leak",
      appId: "id",
    });
    let caught: Error | undefined;
    try {
      await handler.confirmInstall(wsid, SAMPLE_PHONE_NUMBER_ID);
    } catch (err) {
      caught = err instanceof Error ? err : new Error(String(err));
    }
    expect(caught?.cause).toBeUndefined();
    expect(caught?.message).not.toContain("EAA-secret-do-not-leak");
  });
});

// ---------------------------------------------------------------------------
// Cross-workspace ownership guard (#3144 / Codex #3153)
// ---------------------------------------------------------------------------

describe("WhatsAppStaticBotInstallHandler.confirmInstall — cross-workspace guard", () => {
  it("rejects a phone_number_id already bound to a different workspace, and never reaches the cap gate", async () => {
    // Reachability proves the number is in the operator's Meta account, not
    // that THIS workspace owns it. The guard SELECT finds an existing bind in
    // another workspace and refuses before the cap gate runs — so an admin
    // can't claim another customer's number.
    mockInternalQuery.mockImplementation(() =>
      Promise.resolve([{ workspace_id: "org-victim" }]),
    );
    const handler = new WhatsAppStaticBotInstallHandler({ accessToken: "t", appId: "id" });
    await expect(handler.confirmInstall(wsid, SAMPLE_PHONE_NUMBER_ID)).rejects.toThrow(
      /already connected to a different Atlas workspace/i,
    );
    expect(mockCheckChatLimitAndInstall).not.toHaveBeenCalled();
    // The guard scopes its lookup to (catalog:whatsapp, enabled, the routing id,
    // workspace_id <> self) so a reconnect by the same workspace is never caught.
    const [sql, params] = mockInternalQuery.mock.calls[0];
    expect(String(sql)).toMatch(/config->>'phone_number_id'/);
    expect(String(sql)).toMatch(/workspace_id\s*<>\s*\$3/);
    expect(params).toEqual([WHATSAPP_CATALOG_ID, SAMPLE_PHONE_NUMBER_ID, wsid]);
  });

  it("allows the install when the routing id is bound only to the installing workspace (reconnect) — guard returns no conflict", async () => {
    // The `workspace_id <> $3` filter means a same-workspace reconnect returns
    // no rows; the install proceeds to the cap gate (which grandfathers it).
    mockInternalQuery.mockImplementation(() => Promise.resolve([]));
    const handler = new WhatsAppStaticBotInstallHandler({ accessToken: "t", appId: "id" });
    const result = await handler.confirmInstall(wsid, SAMPLE_PHONE_NUMBER_ID);
    expect(result.installRecord.catalogId).toBe(WHATSAPP_SLUG);
    expect(mockCheckChatLimitAndInstall).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Chat-integration cap (#3144 — migrated onto the atomic gate)
// ---------------------------------------------------------------------------

describe("WhatsAppStaticBotInstallHandler.confirmInstall — chat-integration cap", () => {
  it("throws ChatIntegrationLimitError and writes no install row when at cap", async () => {
    // The gate rolls back its UPSERT internally on a cap denial and returns
    // `cap_reached` — the row is never committed.
    mockCheckChatLimitAndInstall.mockImplementationOnce(() =>
      Promise.resolve({
        allowed: false as const,
        reason: "cap_reached" as const,
        errorMessage: "Your business plan allows up to 1 chat integration. Upgrade to add more.",
        limit: 1,
      }),
    );
    const handler = new WhatsAppStaticBotInstallHandler({ accessToken: "t", appId: "id" });

    await expect(handler.confirmInstall(wsid, SAMPLE_PHONE_NUMBER_ID)).rejects.toMatchObject({
      _tag: "ChatIntegrationLimitError",
      limit: 1,
    });

    // The gate enforced the cap (after the Meta Graph round-trip), keyed on the
    // workspace + WhatsApp catalog id, with the UPSERT it would have committed.
    expect(mockCheckChatLimitAndInstall).toHaveBeenCalledTimes(1);
    const [gateOrg, gateCatalog, gateInsert] = mockCheckChatLimitAndInstall.mock.calls[0];
    expect(gateOrg).toBe(wsid);
    expect(gateCatalog).toBe(WHATSAPP_CATALOG_ID);
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
    const handler = new WhatsAppStaticBotInstallHandler({ accessToken: "t", appId: "id" });

    await expect(handler.confirmInstall(wsid, SAMPLE_PHONE_NUMBER_ID)).rejects.toMatchObject({
      _tag: "BillingCheckFailedError",
    });
    expect(mockCheckChatLimitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("grandfathers a reconnect — the gate allows an already-installed workspace and returns the existing id", async () => {
    mockCheckChatLimitAndInstall.mockImplementationOnce(() =>
      Promise.resolve({ allowed: true as const, rows: [{ id: "existing-install-row" }] }),
    );
    const handler = new WhatsAppStaticBotInstallHandler({ accessToken: "t", appId: "id" });
    const result = await handler.confirmInstall(wsid, SAMPLE_PHONE_NUMBER_ID);
    expect(result.installRecord.id).toBe("existing-install-row");
    expect(mockCheckChatLimitAndInstall).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe("WhatsAppStaticBotInstallHandler.confirmInstall — persistence", () => {
  /** Pull the gate's `insert` arg from the most recent call. */
  function lastGateInsert(): { sql: string; params: readonly unknown[] } {
    const calls = mockCheckChatLimitAndInstall.mock.calls;
    return calls[calls.length - 1][2];
  }

  it("UPSERTs workspace_plugins with the catalog id + phone_number_id config payload via the cap gate", async () => {
    const handler = new WhatsAppStaticBotInstallHandler({ accessToken: "t", appId: "id" });
    await handler.confirmInstall(wsid, SAMPLE_PHONE_NUMBER_ID, undefined, {
      display_phone: "Acme Sales Line",
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
    expect(paramsArr).toContain(WHATSAPP_CATALOG_ID);
    const configJson = paramsArr.find(
      (p): p is string => typeof p === "string" && p.includes("phone_number_id"),
    );
    expect(configJson).toBeDefined();
    const parsed = JSON.parse(configJson as string) as Record<string, unknown>;
    expect(parsed.phone_number_id).toBe(SAMPLE_PHONE_NUMBER_ID);
    // extras override beats the API fallback
    expect(parsed.display_phone).toBe("Acme Sales Line");
  });

  it("falls back to Meta's display_phone_number when extras don't supply display_phone (Discord-style fallback)", async () => {
    setFetchOk({ display_phone_number: "+44 20 7946 0958" });
    const handler = new WhatsAppStaticBotInstallHandler({ accessToken: "t", appId: "id" });
    await handler.confirmInstall(wsid, SAMPLE_PHONE_NUMBER_ID);
    const params = lastGateInsert().params;
    const configJson = (params as unknown[]).find(
      (p): p is string => typeof p === "string" && p.includes("phone_number_id"),
    );
    const parsed = JSON.parse(configJson as string) as Record<string, unknown>;
    expect(parsed.display_phone).toBe("+44 20 7946 0958");
  });

  it("omits display_phone when neither extras nor API supplied one", async () => {
    // Override the fetch to return only `id`, no display_phone_number.
    globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), ...(init ? { init } : {}) });
      return new Response(JSON.stringify({ id: SAMPLE_PHONE_NUMBER_ID }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const handler = new WhatsAppStaticBotInstallHandler({ accessToken: "t", appId: "id" });
    await handler.confirmInstall(wsid, SAMPLE_PHONE_NUMBER_ID);
    const params = lastGateInsert().params;
    const configJson = (params as unknown[]).find(
      (p): p is string => typeof p === "string" && p.includes("phone_number_id"),
    );
    const parsed = JSON.parse(configJson as string) as Record<string, unknown>;
    expect("display_phone" in parsed).toBe(false);
  });

  it("drops display_phone when extras supplies the wrong type (number / null) — logs but doesn't throw", async () => {
    // Isolate the "wrong-type drop" behavior from the fallback chain
    // by giving Meta nothing to fall back through.
    globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), ...(init ? { init } : {}) });
      return new Response(JSON.stringify({ id: SAMPLE_PHONE_NUMBER_ID }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const handler = new WhatsAppStaticBotInstallHandler({ accessToken: "t", appId: "id" });
    await handler.confirmInstall(wsid, SAMPLE_PHONE_NUMBER_ID, undefined, {
      display_phone: 12345 as unknown as string,
    });
    const params = lastGateInsert().params;
    const configJson = (params as unknown[]).find(
      (p): p is string => typeof p === "string" && p.includes("phone_number_id"),
    );
    const parsed = JSON.parse(configJson as string) as Record<string, unknown>;
    // With no API fallback either, the field is omitted entirely.
    expect("display_phone" in parsed).toBe(false);
  });

  it("falls back to Meta's verified_name when display_phone_number is absent (third-tier fallback)", async () => {
    globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), ...(init ? { init } : {}) });
      return new Response(
        JSON.stringify({ id: SAMPLE_PHONE_NUMBER_ID, verified_name: "Acme Test Co" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const handler = new WhatsAppStaticBotInstallHandler({ accessToken: "t", appId: "id" });
    await handler.confirmInstall(wsid, SAMPLE_PHONE_NUMBER_ID);
    const params = lastGateInsert().params;
    const configJson = (params as unknown[]).find(
      (p): p is string => typeof p === "string" && p.includes("phone_number_id"),
    );
    const parsed = JSON.parse(configJson as string) as Record<string, unknown>;
    expect(parsed.display_phone).toBe("Acme Test Co");
  });

  it("prefers display_phone_number over verified_name when both are present", async () => {
    globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), ...(init ? { init } : {}) });
      return new Response(
        JSON.stringify({
          id: SAMPLE_PHONE_NUMBER_ID,
          display_phone_number: "+1 415 555 0100",
          verified_name: "Acme Test Co",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const handler = new WhatsAppStaticBotInstallHandler({ accessToken: "t", appId: "id" });
    await handler.confirmInstall(wsid, SAMPLE_PHONE_NUMBER_ID);
    const params = lastGateInsert().params;
    const configJson = (params as unknown[]).find(
      (p): p is string => typeof p === "string" && p.includes("phone_number_id"),
    );
    const parsed = JSON.parse(configJson as string) as Record<string, unknown>;
    expect(parsed.display_phone).toBe("+1 415 555 0100");
  });

  it("returns the persisted install id from the gate's RETURNING rows (re-install idempotency)", async () => {
    mockCheckChatLimitAndInstall.mockImplementation(() =>
      Promise.resolve({ allowed: true as const, rows: [{ id: "existing-install-row" }] }),
    );
    const handler = new WhatsAppStaticBotInstallHandler({ accessToken: "t", appId: "id" });
    const result = await handler.confirmInstall(wsid, SAMPLE_PHONE_NUMBER_ID);
    expect(result.installRecord.id).toBe("existing-install-row");
    expect(result.installRecord.workspaceId).toBe(wsid);
    expect(result.installRecord.catalogId).toBe(WHATSAPP_SLUG);
  });

  it("throws when the gate's RETURNING rows are empty — never ships a candidate id that doesn't match the persisted row", async () => {
    mockCheckChatLimitAndInstall.mockImplementation(() =>
      Promise.resolve({ allowed: true as const, rows: [] }),
    );
    const handler = new WhatsAppStaticBotInstallHandler({
      accessToken: "t",
      appId: "id",
      idGenerator: () => "candidate-id-xyz",
    });
    await expect(handler.confirmInstall(wsid, SAMPLE_PHONE_NUMBER_ID)).rejects.toThrow(
      /RETURNING must always populate/,
    );
  });

  it("surfaces DB failure rather than half-installing — no return after a throw", async () => {
    // The gate throws on a genuine write-path failure (after rolling back).
    mockCheckChatLimitAndInstall.mockImplementation(() => Promise.reject(new Error("DB down")));
    const handler = new WhatsAppStaticBotInstallHandler({ accessToken: "t", appId: "id" });
    await expect(handler.confirmInstall(wsid, SAMPLE_PHONE_NUMBER_ID)).rejects.toThrow(/DB down/);
  });
});

// ---------------------------------------------------------------------------
// verificationProof — interface-defined but unused for WhatsApp today
// ---------------------------------------------------------------------------

describe("WhatsAppStaticBotInstallHandler.confirmInstall — verificationProof", () => {
  it("ignores verificationProof when supplied — reachability is verified server-side via Graph API", async () => {
    const handler = new WhatsAppStaticBotInstallHandler({ accessToken: "t", appId: "id" });
    const result = await handler.confirmInstall(
      wsid,
      SAMPLE_PHONE_NUMBER_ID,
      "ignored-proof",
    );
    expect(result.installRecord.catalogId).toBe(WHATSAPP_SLUG);
    expect(fetchCalls).toHaveLength(1);
  });
});
