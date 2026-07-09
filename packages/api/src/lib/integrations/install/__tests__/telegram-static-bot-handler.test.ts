/**
 * Tests for {@link TelegramStaticBotInstallHandler} — slice 10 of 1.5.3
 * (issue #2748), migrated onto the atomic cap gate in #3141 (the keystone
 * for completing the static-bot family under umbrella #2994).
 *
 * Telegram is the keystone static-bot install — the interface this handler
 * exercises is the one Discord (#2749), gchat (#2754), and WhatsApp (#2753)
 * ride. #3141 brings Telegram's `confirmInstall` onto the same
 * `checkChatIntegrationLimitAndInstall` path Discord and Slack already use,
 * so an over-cap install is refused with a 429 and a reconnect is
 * grandfathered.
 *
 * The contract pinned here:
 *
 *   - `kind: "static-bot"` so the dispatch can narrow.
 *   - `confirmInstall(workspaceId, chatId)` validates the routing
 *     identifier shape, verifies reachability against the Telegram Bot
 *     API (`getChat`), runs the chat-integration cap gate which owns the
 *     `workspace_plugins` UPSERT, and returns an `InstallRecord`.
 *   - Reachability failure (chat_id wrong / bot not a member) throws an
 *     actionable error BEFORE the gate runs — no half-installed rows
 *     survive, and the cap is never consumed for a failed reachability.
 *   - At-cap installs throw `ChatIntegrationLimitError` (→ 429); a count
 *     check that fails closed throws `BillingCheckFailedError` (→ 503).
 *   - Re-install for the same (workspace, catalog) is a no-op UPSERT that
 *     the gate grandfathers (never blocked) and keeps the stable id.
 *   - When the operator hasn't wired `TELEGRAM_BOT_TOKEN`, the handler
 *     refuses to construct itself with the actionable env-var name in
 *     the error.
 *
 * `mock.module()` stubs the module dependencies the handler reaches into:
 * `lib/billing/enforcement` (`checkChatIntegrationLimitAndInstall` — the
 * atomic cap-gate that owns the `workspace_plugins` UPSERT post-#3001) and
 * the global `fetch` used for the Bot API call. Each mock exports every
 * named export it shadows (CLAUDE.md "mock all exports" rule).
 */

import { afterEach, beforeEach, describe, expect, it, mock, type Mock } from "bun:test";
import type { WorkspaceId } from "@useatlas/types";

// ---------------------------------------------------------------------------
// Module mocks — hoist above the handler import
// ---------------------------------------------------------------------------

// The handler's cross-workspace ownership guard (#3141) reads
// `workspace_plugins` via `internalQuery` before the cap gate. Default returns
// [] (no conflict); the guard test overrides it to a matching row.
const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<unknown[]>> = mock(
  () => Promise.resolve([]),
);
void mock.module("@atlas/api/lib/db/internal", () => ({
  internalQuery: mockInternalQuery,
  hasInternalDB: mock(() => true),
  getInternalDB: mock(() => ({ query: mock(() => Promise.resolve({ rows: [] })) })),
}));

// The chat-integration cap + the workspace_plugins UPSERT run atomically
// through `checkChatIntegrationLimitAndInstall` (#3001) — the gate owns the
// write and returns the RETURNING rows. We stub it to "allowed" with a
// scripted row id so these handler tests stay focused on the install contract
// (chat_id validation, reachability, config payload) and assert the UPSERT
// shape via the gate's `insert` arg. The cap-enforcement decision + transaction
// sequencing live in `billing/__tests__/enforcement.test.ts`. The cap /
// fail-closed / RETURNING-empty / DB-error tests override it per case.
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
> = mock(() => Promise.resolve({ allowed: true as const, rows: [{ id: "install-tg-row-1" }] }));

// Mock every value export — a partial `mock.module()` causes a `SyntaxError`
// in other files importing the missing exports (per CLAUDE.md "Mock all
// exports"). Only `checkChatIntegrationLimitAndInstall` is exercised here; the
// rest are inert no-ops.
void mock.module("@atlas/api/lib/billing/enforcement", () => ({
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

interface FetchCall {
  readonly url: string;
  readonly init?: RequestInit;
}
const fetchCalls: FetchCall[] = [];
const ORIGINAL_FETCH = globalThis.fetch;

type FetchInput = string | URL | Request;

function setFetchOk(payload: Record<string, unknown> = { ok: true, result: { id: 42, type: "private" } }): void {
  globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
    fetchCalls.push({ url: (typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url), ...(init ? { init } : {}) });
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

function setFetchTelegramError(description: string, errorCode = 400): void {
  globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
    fetchCalls.push({ url: (typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url), ...(init ? { init } : {}) });
    return new Response(
      JSON.stringify({ ok: false, error_code: errorCode, description }),
      { status: errorCode, headers: { "content-type": "application/json" } },
    );
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
    Promise.resolve({ allowed: true as const, rows: [{ id: "install-tg-row-1" }] }),
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
  TelegramStaticBotInstallHandler,
  TELEGRAM_CATALOG_ID,
  TELEGRAM_SLUG,
} from "../telegram-static-bot-handler";
import type { StaticBotInstallHandler } from "../types";

// ---------------------------------------------------------------------------
// Constructor + kind
// ---------------------------------------------------------------------------

describe("TelegramStaticBotInstallHandler — shape", () => {
  it("identifies itself with kind: 'static-bot' for dispatch narrowing", () => {
    const handler = new TelegramStaticBotInstallHandler({ botToken: "123:abc" });
    expect(handler.kind).toBe("static-bot");
  });

  it("is form-shaped (not OAuth-shaped) — the /install-form route accepts a pasted chat_id", () => {
    // Telegram captures its routing identifier as a directly-typed chat_id,
    // unlike Discord's OAuth-shaped bot-install redirect. The /install-form
    // route refuses `oauthShaped` handlers; Telegram leaves the optional
    // interface flag unset, so it must read falsy here.
    const handler: StaticBotInstallHandler = new TelegramStaticBotInstallHandler({
      botToken: "123:abc",
    });
    expect(handler.oauthShaped ?? false).toBe(false);
  });

  it("refuses to construct when botToken is empty — actionable env name in the error", () => {
    expect(() => new TelegramStaticBotInstallHandler({ botToken: "" })).toThrow(
      /TELEGRAM_BOT_TOKEN/,
    );
  });

  it("exports TELEGRAM_SLUG and TELEGRAM_CATALOG_ID — wired into register.ts + workspace-installer dispatch", () => {
    expect(TELEGRAM_SLUG).toBe("telegram");
    expect(TELEGRAM_CATALOG_ID).toBe("catalog:telegram");
  });
});

// ---------------------------------------------------------------------------
// chat_id validation
// ---------------------------------------------------------------------------

describe("TelegramStaticBotInstallHandler.confirmInstall — chat_id validation", () => {
  it("rejects empty chat_id", async () => {
    const handler = new TelegramStaticBotInstallHandler({ botToken: "123:abc" });
    await expect(handler.confirmInstall(wsid, "")).rejects.toThrow(/chat_id/);
    expect(mockCheckChatLimitAndInstall).not.toHaveBeenCalled();
  });

  it("rejects chat_id with non-numeric characters", async () => {
    const handler = new TelegramStaticBotInstallHandler({ botToken: "123:abc" });
    // Telegram chat ids are integers (positive for users, negative for
    // groups/channels). A pasted `@username` is a common admin mistake;
    // reject before the API call.
    await expect(handler.confirmInstall(wsid, "@my_channel")).rejects.toThrow(/chat_id/);
    expect(mockCheckChatLimitAndInstall).not.toHaveBeenCalled();
  });

  it("accepts negative chat_id (groups / channels)", async () => {
    const handler = new TelegramStaticBotInstallHandler({ botToken: "123:abc" });
    const result = await handler.confirmInstall(wsid, "-1001234567890");
    expect(result.installRecord.catalogId).toBe(TELEGRAM_SLUG);
  });

  it("accepts positive chat_id (private chat with a user)", async () => {
    const handler = new TelegramStaticBotInstallHandler({ botToken: "123:abc" });
    const result = await handler.confirmInstall(wsid, "12345678");
    expect(result.installRecord.catalogId).toBe(TELEGRAM_SLUG);
  });
});

// ---------------------------------------------------------------------------
// Reachability verification (getChat)
// ---------------------------------------------------------------------------

describe("TelegramStaticBotInstallHandler.confirmInstall — reachability verification", () => {
  it("calls Telegram Bot API getChat with the supplied chat_id + bot token", async () => {
    const handler = new TelegramStaticBotInstallHandler({ botToken: "987:xyz" });
    await handler.confirmInstall(wsid, "-100999");
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain("https://api.telegram.org/bot987:xyz/getChat");
    expect(fetchCalls[0].url).toContain("chat_id=-100999");
  });

  it("throws with a clear error when Telegram returns chat_not_found (and never touches the cap gate)", async () => {
    setFetchTelegramError("Bad Request: chat not found", 400);
    const handler = new TelegramStaticBotInstallHandler({ botToken: "987:xyz" });
    await expect(handler.confirmInstall(wsid, "999")).rejects.toThrow(/chat not found/i);
    expect(mockCheckChatLimitAndInstall).not.toHaveBeenCalled();
  });

  it("throws with a clear error when the bot is not a member of the chat", async () => {
    setFetchTelegramError("Forbidden: bot is not a member of the channel chat", 403);
    const handler = new TelegramStaticBotInstallHandler({ botToken: "987:xyz" });
    await expect(handler.confirmInstall(wsid, "-100999")).rejects.toThrow(/not a member/i);
    expect(mockCheckChatLimitAndInstall).not.toHaveBeenCalled();
  });

  it("throws when the Bot API call fails at the network layer (no install row)", async () => {
    setFetchNetworkError();
    const handler = new TelegramStaticBotInstallHandler({ botToken: "987:xyz" });
    await expect(handler.confirmInstall(wsid, "12345")).rejects.toThrow(/telegram/i);
    expect(mockCheckChatLimitAndInstall).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Cross-workspace ownership guard (#3141 / Codex #3153)
// ---------------------------------------------------------------------------

describe("TelegramStaticBotInstallHandler.confirmInstall — cross-workspace guard", () => {
  it("rejects a chat_id already bound to a different workspace, and never reaches the cap gate", async () => {
    // getChat proves the bot is in the chat, not that THIS workspace owns it.
    // The guard SELECT finds an existing bind in another workspace and refuses
    // before the cap gate runs — so a chat member can't claim the chat.
    mockInternalQuery.mockImplementation(() =>
      Promise.resolve([{ workspace_id: "org-victim" }]),
    );
    const handler = new TelegramStaticBotInstallHandler({ botToken: "123:abc" });
    await expect(handler.confirmInstall(wsid, "-100999")).rejects.toThrow(
      /already connected to a different Atlas workspace/i,
    );
    expect(mockCheckChatLimitAndInstall).not.toHaveBeenCalled();
    // The guard scopes its lookup to (catalog:telegram, enabled, the chat_id,
    // workspace_id <> self) so a reconnect by the same workspace is never caught.
    const [sql, params] = mockInternalQuery.mock.calls[0];
    expect(String(sql)).toMatch(/config->>'chat_id'/);
    expect(String(sql)).toMatch(/workspace_id\s*<>\s*\$3/);
    expect(params).toEqual([TELEGRAM_CATALOG_ID, "-100999", wsid]);
  });

  it("allows the install when the chat_id is bound only to the installing workspace (reconnect) — guard returns no conflict", async () => {
    mockInternalQuery.mockImplementation(() => Promise.resolve([]));
    const handler = new TelegramStaticBotInstallHandler({ botToken: "123:abc" });
    const result = await handler.confirmInstall(wsid, "-100999");
    expect(result.installRecord.catalogId).toBe(TELEGRAM_SLUG);
    expect(mockCheckChatLimitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("maps a concurrent routing-id unique violation (23505) from the cap gate to the actionable conflict error (#3167)", async () => {
    // Pre-check passes (no existing bind), but a concurrent install in another
    // workspace claimed the chat_id first. The migration-0120 partial unique
    // index rejects our UPSERT with a 23505 naming
    // `workspace_plugins_chat_routing_id_unique`. The handler must surface the
    // SAME error its pre-check returns, not leak a raw 500.
    mockInternalQuery.mockImplementation(() => Promise.resolve([]));
    mockCheckChatLimitAndInstall.mockImplementation(() =>
      Promise.reject(
        Object.assign(new Error("duplicate key value violates unique constraint"), {
          code: "23505",
          constraint: "workspace_plugins_chat_routing_id_unique",
        }),
      ),
    );
    const handler = new TelegramStaticBotInstallHandler({ botToken: "123:abc" });
    await expect(handler.confirmInstall(wsid, "-100999")).rejects.toThrow(
      /already connected to a different Atlas workspace/i,
    );
  });

  it("re-throws a 23505 on a DIFFERENT index untouched — not relabelled as a cross-workspace conflict (#3167)", async () => {
    mockInternalQuery.mockImplementation(() => Promise.resolve([]));
    mockCheckChatLimitAndInstall.mockImplementation(() =>
      Promise.reject(
        Object.assign(
          new Error('duplicate key value violates unique constraint "workspace_plugins_id_unique"'),
          { code: "23505", constraint: "workspace_plugins_id_unique" },
        ),
      ),
    );
    const handler = new TelegramStaticBotInstallHandler({ botToken: "123:abc" });
    await expect(handler.confirmInstall(wsid, "-100999")).rejects.toThrow(/duplicate key value/i);
  });
});

// ---------------------------------------------------------------------------
// Chat-integration cap (#3141 — migrated onto the atomic gate)
// ---------------------------------------------------------------------------

describe("TelegramStaticBotInstallHandler.confirmInstall — chat-integration cap", () => {
  it("throws ChatIntegrationLimitError and writes no install row when at cap", async () => {
    // The gate rolls back its UPSERT internally on a cap denial and returns
    // `cap_reached` — the row is never committed.
    mockCheckChatLimitAndInstall.mockImplementationOnce(() =>
      Promise.resolve({
        allowed: false as const,
        reason: "cap_reached" as const,
        errorMessage: "Your starter plan allows up to 1 chat integration. Upgrade to add more.",
        limit: 1,
      }),
    );
    const handler = new TelegramStaticBotInstallHandler({ botToken: "123:abc" });

    await expect(handler.confirmInstall(wsid, "12345")).rejects.toMatchObject({
      _tag: "ChatIntegrationLimitError",
      limit: 1,
    });

    // The gate enforced the cap (after reachability), keyed on the workspace +
    // Telegram catalog id, with the UPSERT it would have committed.
    expect(mockCheckChatLimitAndInstall).toHaveBeenCalledTimes(1);
    const [gateOrg, gateCatalog, gateInsert] = mockCheckChatLimitAndInstall.mock.calls[0];
    expect(gateOrg).toBe(wsid);
    expect(gateCatalog).toBe(TELEGRAM_CATALOG_ID);
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
    const handler = new TelegramStaticBotInstallHandler({ botToken: "123:abc" });

    await expect(handler.confirmInstall(wsid, "12345")).rejects.toMatchObject({
      _tag: "BillingCheckFailedError",
    });

    // Still fail closed — the gate returned check_failed without committing.
    expect(mockCheckChatLimitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("grandfathers a reconnect — the gate allows an already-installed workspace and returns the existing id", async () => {
    // Reconnect (re-auth of an already-installed platform) never grows the
    // distinct chat-integration count, so the gate allows it even when the
    // workspace is at/over cap. The handler must surface the existing row id.
    mockCheckChatLimitAndInstall.mockImplementationOnce(() =>
      Promise.resolve({ allowed: true as const, rows: [{ id: "existing-install-row" }] }),
    );
    const handler = new TelegramStaticBotInstallHandler({ botToken: "123:abc" });
    const result = await handler.confirmInstall(wsid, "12345");
    expect(result.installRecord.id).toBe("existing-install-row");
    expect(mockCheckChatLimitAndInstall).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe("TelegramStaticBotInstallHandler.confirmInstall — persistence", () => {
  /** Pull the gate's `insert` arg from the most recent call. */
  function lastGateInsert(): { sql: string; params: readonly unknown[] } {
    const calls = mockCheckChatLimitAndInstall.mock.calls;
    return calls[calls.length - 1][2];
  }

  it("UPSERTs workspace_plugins with the catalog id + chat_id config payload via the cap gate", async () => {
    const handler = new TelegramStaticBotInstallHandler({ botToken: "123:abc" });
    await handler.confirmInstall(wsid, "12345", undefined, { display_name: "Team Standup" });

    expect(mockCheckChatLimitAndInstall).toHaveBeenCalledTimes(1);
    const insert = lastGateInsert();
    const sqlText = insert.sql;
    expect(sqlText).toMatch(/INSERT INTO workspace_plugins/);
    // Required NOT NULL columns post-0092 / 0096 — INSERT must name
    // pillar + install_id; chat-pillar installs target the partial
    // singleton index for idempotent re-install (codex P0).
    expect(sqlText).toMatch(/install_id/);
    expect(sqlText).toMatch(/pillar/);
    expect(sqlText).toMatch(/'chat'/);
    expect(sqlText).toMatch(/ON CONFLICT.*workspace_id.*catalog_id.*WHERE.*pillar.*DO UPDATE/s);
    // The gate runs the UPSERT under the lock, so RETURNING id must be present.
    expect(sqlText).toMatch(/RETURNING id/);

    const paramsArr = insert.params as unknown[];
    // (id, workspace_id, catalog_id, config_json, enabled implied true)
    expect(paramsArr).toContain(wsid);
    expect(paramsArr).toContain(TELEGRAM_CATALOG_ID);
    // config payload comes through as JSON string in the bound params
    const configJson = paramsArr.find(
      (p): p is string => typeof p === "string" && p.includes("chat_id"),
    );
    expect(configJson).toBeDefined();
    const parsed = JSON.parse(configJson as string) as Record<string, unknown>;
    expect(parsed.chat_id).toBe("12345");
    expect(parsed.display_name).toBe("Team Standup");
  });

  it("omits display_name from config when the routing identifier is the only field supplied", async () => {
    const handler = new TelegramStaticBotInstallHandler({ botToken: "123:abc" });
    await handler.confirmInstall(wsid, "12345");
    const configJson = (lastGateInsert().params as unknown[]).find(
      (p): p is string => typeof p === "string" && p.includes("chat_id"),
    );
    const parsed = JSON.parse(configJson as string) as Record<string, unknown>;
    expect(parsed.chat_id).toBe("12345");
    expect("display_name" in parsed).toBe(false);
  });

  it("returns the persisted install id from the gate's RETURNING rows (re-install idempotency)", async () => {
    mockCheckChatLimitAndInstall.mockImplementation(() =>
      Promise.resolve({ allowed: true as const, rows: [{ id: "existing-install-row" }] }),
    );
    const handler = new TelegramStaticBotInstallHandler({ botToken: "123:abc" });
    const result = await handler.confirmInstall(wsid, "12345");
    expect(result.installRecord.id).toBe("existing-install-row");
    expect(result.installRecord.workspaceId).toBe(wsid);
    expect(result.installRecord.catalogId).toBe(TELEGRAM_SLUG);
  });

  it("throws when the gate's RETURNING rows are empty — never ships a candidate id that doesn't match the persisted row", async () => {
    // Postgres ≥9.5 guarantees `INSERT … ON CONFLICT … RETURNING`
    // populates the row on both insert and update. Empty here means
    // a driver regression — silently shipping the candidate id would
    // strand re-install lookups (DB has the existing id, response says
    // a fresh UUID). Fail loud instead.
    mockCheckChatLimitAndInstall.mockImplementation(() =>
      Promise.resolve({ allowed: true as const, rows: [] }),
    );
    const handler = new TelegramStaticBotInstallHandler({
      botToken: "123:abc",
      idGenerator: () => "candidate-id-xyz",
    });
    await expect(handler.confirmInstall(wsid, "12345")).rejects.toThrow(
      /RETURNING must always populate/,
    );
  });

  it("surfaces DB failure rather than half-installing — no return after a throw", async () => {
    // The gate throws on a genuine write-path failure (after rolling back).
    mockCheckChatLimitAndInstall.mockImplementation(() => Promise.reject(new Error("DB down")));
    const handler = new TelegramStaticBotInstallHandler({ botToken: "123:abc" });
    await expect(handler.confirmInstall(wsid, "12345")).rejects.toThrow(/DB down/);
  });
});

// ---------------------------------------------------------------------------
// verificationProof — interface-defined but unused for Telegram today
// ---------------------------------------------------------------------------

describe("TelegramStaticBotInstallHandler.confirmInstall — verificationProof", () => {
  it("ignores verificationProof when supplied — reachability is verified server-side via getChat", async () => {
    const handler = new TelegramStaticBotInstallHandler({ botToken: "123:abc" });
    const result = await handler.confirmInstall(wsid, "12345", "ignored-proof");
    expect(result.installRecord.catalogId).toBe(TELEGRAM_SLUG);
    // The single fetch call we made is the getChat reachability check —
    // not a verification-proof handshake the caller supplied.
    expect(fetchCalls).toHaveLength(1);
  });
});
