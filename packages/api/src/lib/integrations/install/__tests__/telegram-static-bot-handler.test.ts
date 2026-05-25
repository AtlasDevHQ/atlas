/**
 * Tests for {@link TelegramStaticBotInstallHandler} — slice 10 of 1.5.3
 * (issue #2748). Telegram is the keystone static-bot install — the
 * interface this handler exercises is the one Discord (#2749), gchat
 * (#2754), and WhatsApp (#2753) will ride.
 *
 * The contract pinned here:
 *
 *   - `kind: "static-bot"` so the dispatch can narrow.
 *   - `confirmInstall(workspaceId, chatId)` validates the routing
 *     identifier shape, verifies reachability against the Telegram Bot
 *     API (`getChat`), persists the install row via UPSERT, and returns
 *     an `InstallRecord`.
 *   - Reachability failure (chat_id wrong / bot not a member) throws an
 *     actionable error — no half-installed rows survive.
 *   - Re-install for the same (workspace, catalog) is a no-op UPSERT
 *     that updates `config` and keeps the stable install id.
 *   - When the operator hasn't wired `TELEGRAM_BOT_TOKEN`, the handler
 *     refuses to construct itself with the actionable env-var name in
 *     the error. The boot-time register helper skips registration in
 *     that case; this guard is the defensive backstop for tests / direct
 *     callers that construct the handler themselves.
 *
 * `mock.module()` stubs the two module dependencies the handler reaches
 * into: `lib/db/internal` (`internalQuery`) and the global `fetch` used
 * for the Bot API call. Each mock exports every named export it shadows.
 */

import { afterEach, beforeEach, describe, expect, it, mock, type Mock } from "bun:test";
import type { WorkspaceId } from "@useatlas/types";

// ---------------------------------------------------------------------------
// Module mocks — hoist above the handler import
// ---------------------------------------------------------------------------

const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<unknown[]>> = mock(() =>
  Promise.resolve([{ id: "install-tg-row-1" }]),
);

mock.module("@atlas/api/lib/db/internal", () => ({
  internalQuery: mockInternalQuery,
  hasInternalDB: mock(() => true),
  getInternalDB: mock(() => ({ query: mock(() => Promise.resolve({ rows: [] })) })),
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
    fetchCalls.push({ url: String(input), ...(init ? { init } : {}) });
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

function setFetchTelegramError(description: string, errorCode = 400): void {
  globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), ...(init ? { init } : {}) });
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
  mockInternalQuery.mockClear();
  mockInternalQuery.mockImplementation(() => Promise.resolve([{ id: "install-tg-row-1" }]));
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

// ---------------------------------------------------------------------------
// Constructor + kind
// ---------------------------------------------------------------------------

describe("TelegramStaticBotInstallHandler — shape", () => {
  it("identifies itself with kind: 'static-bot' for dispatch narrowing", () => {
    const handler = new TelegramStaticBotInstallHandler({ botToken: "123:abc" });
    expect(handler.kind).toBe("static-bot");
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
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("rejects chat_id with non-numeric characters", async () => {
    const handler = new TelegramStaticBotInstallHandler({ botToken: "123:abc" });
    // Telegram chat ids are integers (positive for users, negative for
    // groups/channels). A pasted `@username` is a common admin mistake;
    // reject before the API call.
    await expect(handler.confirmInstall(wsid, "@my_channel")).rejects.toThrow(/chat_id/);
    expect(mockInternalQuery).not.toHaveBeenCalled();
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

  it("throws with a clear error when Telegram returns chat_not_found", async () => {
    setFetchTelegramError("Bad Request: chat not found", 400);
    const handler = new TelegramStaticBotInstallHandler({ botToken: "987:xyz" });
    await expect(handler.confirmInstall(wsid, "999")).rejects.toThrow(/chat not found/i);
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("throws with a clear error when the bot is not a member of the chat", async () => {
    setFetchTelegramError("Forbidden: bot is not a member of the channel chat", 403);
    const handler = new TelegramStaticBotInstallHandler({ botToken: "987:xyz" });
    await expect(handler.confirmInstall(wsid, "-100999")).rejects.toThrow(/not a member/i);
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("throws when the Bot API call fails at the network layer (no install row)", async () => {
    setFetchNetworkError();
    const handler = new TelegramStaticBotInstallHandler({ botToken: "987:xyz" });
    await expect(handler.confirmInstall(wsid, "12345")).rejects.toThrow(/telegram/i);
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe("TelegramStaticBotInstallHandler.confirmInstall — persistence", () => {
  it("UPSERTs workspace_plugins with the catalog id + chat_id config payload", async () => {
    const handler = new TelegramStaticBotInstallHandler({ botToken: "123:abc" });
    await handler.confirmInstall(wsid, "12345", undefined, { display_name: "Team Standup" });

    expect(mockInternalQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockInternalQuery.mock.calls[0];
    const sqlText = String(sql);
    expect(sqlText).toMatch(/INSERT INTO workspace_plugins/);
    // Required NOT NULL columns post-0092 / 0096 — INSERT must name
    // pillar + install_id; chat-pillar installs target the partial
    // singleton index for idempotent re-install (codex P0).
    expect(sqlText).toMatch(/install_id/);
    expect(sqlText).toMatch(/pillar/);
    expect(sqlText).toMatch(/'chat'/);
    expect(sqlText).toMatch(/ON CONFLICT.*workspace_id.*catalog_id.*WHERE.*pillar.*DO UPDATE/s);

    expect(Array.isArray(params)).toBe(true);
    const paramsArr = params as unknown[];
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
    const [, params] = mockInternalQuery.mock.calls[0];
    const configJson = (params as unknown[]).find(
      (p): p is string => typeof p === "string" && p.includes("chat_id"),
    );
    const parsed = JSON.parse(configJson as string) as Record<string, unknown>;
    expect(parsed.chat_id).toBe("12345");
    expect("display_name" in parsed).toBe(false);
  });

  it("returns the persisted install id from RETURNING (re-install idempotency)", async () => {
    mockInternalQuery.mockImplementation(() =>
      Promise.resolve([{ id: "existing-install-row" }]),
    );
    const handler = new TelegramStaticBotInstallHandler({ botToken: "123:abc" });
    const result = await handler.confirmInstall(wsid, "12345");
    expect(result.installRecord.id).toBe("existing-install-row");
    expect(result.installRecord.workspaceId).toBe(wsid);
    expect(result.installRecord.catalogId).toBe(TELEGRAM_SLUG);
  });

  it("throws when RETURNING comes back empty — never ships a candidate id that doesn't match the persisted row", async () => {
    // Postgres ≥9.5 guarantees `INSERT … ON CONFLICT … RETURNING`
    // populates the row on both insert and update. Empty here means
    // a driver regression — silently shipping the candidate id would
    // strand re-install lookups (DB has the existing id, response says
    // a fresh UUID). Fail loud instead.
    mockInternalQuery.mockImplementation(() => Promise.resolve([]));
    const handler = new TelegramStaticBotInstallHandler({
      botToken: "123:abc",
      idGenerator: () => "candidate-id-xyz",
    });
    await expect(handler.confirmInstall(wsid, "12345")).rejects.toThrow(
      /RETURNING must always populate/,
    );
  });

  it("surfaces DB failure rather than half-installing — no return after a throw", async () => {
    mockInternalQuery.mockImplementation(() => Promise.reject(new Error("DB down")));
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
