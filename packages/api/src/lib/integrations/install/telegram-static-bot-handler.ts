/**
 * `TelegramStaticBotInstallHandler` — keystone of 1.5.3 Phase D (issue
 * #2748). First real implementation of {@link StaticBotInstallHandler}.
 *
 * Telegram is the simplest static-bot platform — one operator-shared
 * bot (env: `TELEGRAM_BOT_TOKEN`), one routing identifier per Workspace
 * (`chat_id`, plus an optional `display_name`). The interface shape
 * this handler exercises is the one Discord (#2749), gchat (#2754), and
 * WhatsApp (#2753) will reuse: validate the routing identifier,
 * round-trip the Platform to verify reachability, persist into
 * `workspace_plugins.config` via UPSERT.
 *
 * Per-Workspace credential note: there isn't one. The bot's auth lives
 * with the operator (`TELEGRAM_BOT_TOKEN`). The catalog `chat_id` is a
 * routing identifier, not a secret — Telegram leaks it in `from.id` /
 * `chat.id` of every message envelope. The `workspace_plugins.config`
 * row is written by the chat-integration cap gate
 * (`checkChatIntegrationLimitAndInstall`), which owns the advisory-locked
 * UPSERT — so `encryptSecretFields` is not in the write path at all; the
 * absence of `secret: true` on the catalog row is consistent but not the
 * load-bearing reason.
 *
 * Cap gate (#3141): like Discord and Slack, the install UPSERT runs
 * through `checkChatIntegrationLimitAndInstall` so an over-cap net-new
 * install is refused with `ChatIntegrationLimitError` (→ 429) and a
 * reconnect (re-auth of an already-installed workspace) is grandfathered.
 * This replaced the keystone's original bare `internalQuery` UPSERT when
 * Telegram joined the unified install path under umbrella #2994.
 *
 * Reachability verification: rather than sending a real test message
 * (which would spam the channel on every install attempt), we call the
 * Bot API `getChat` endpoint with the supplied `chat_id`. `getChat`
 * succeeds when the chat exists AND the bot is a member. Telegram
 * collapses both failure cues into one `chat not found` error envelope;
 * the `hintForTelegramError` helper appends an admin-actionable second
 * sentence based on the status code so the surface message tells the
 * admin which side to fix.
 *
 * @see ./types.ts — {@link StaticBotInstallHandler}
 * @see https://core.telegram.org/bots/api#getchat
 */

import crypto from "crypto";
import { createLogger } from "@atlas/api/lib/logger";
import { internalQuery } from "@atlas/api/lib/db/internal";
import {
  BillingCheckFailedError,
  ChatIntegrationLimitError,
  TelegramApiUnavailableError,
  TelegramChatIdInvalidError,
  TelegramReachabilityError,
} from "@atlas/api/lib/effect/errors";
import { checkChatIntegrationLimitAndInstall } from "@atlas/api/lib/billing/enforcement";
import type { WorkspaceId } from "@useatlas/types";
import type {
  CatalogId,
  InstallRecord,
  StaticBotInstallHandler,
} from "./types";

const log = createLogger("integrations.install.telegram");

/** Catalog slug — the dispatch key in {@link registerStaticBotHandler}. */
export const TELEGRAM_SLUG: CatalogId = "telegram";

/**
 * Stable `plugin_catalog.id` for Telegram. The seeder derives row ids
 * as `catalog:${slug}` (see `catalog-seeder.ts::upsertEntry`), so the
 * FK target in `workspace_plugins.catalog_id` is `catalog:telegram`.
 *
 * Kept in lockstep with `catalog-seeder.ts::upsertEntry`'s id
 * derivation — change both together. A seeder rename without updating
 * this constant produces FK violations at first install.
 */
export const TELEGRAM_CATALOG_ID = "catalog:telegram";

/**
 * Cross-workspace ownership guard (#3141 / Codex #3153). `getChat` proves the
 * operator bot is a member of the chat, not that the installing workspace owns
 * it — and chat_ids are non-secret (they leak in every message envelope). So
 * reject a chat_id already bound to a *different* workspace before persisting.
 * The `workspace_id <> $3` filter excludes the installing workspace, so a
 * reconnect (same workspace re-binding its own chat) is never blocked.
 * Read-only pre-check: it narrows the cross-tenant window but isn't
 * transactionally fused with the cap gate's INSERT, so the simultaneous-race
 * case remains — tracked, with the full ownership-proof flow, in #3154.
 */
async function assertChatIdUnboundElsewhere(
  chatId: string,
  workspaceId: WorkspaceId,
): Promise<void> {
  const rows = await internalQuery<{ workspace_id: string }>(
    `SELECT workspace_id
       FROM workspace_plugins
      WHERE catalog_id = $1
        AND enabled = true
        AND config->>'chat_id' = $2
        AND workspace_id <> $3
      LIMIT 1`,
    [TELEGRAM_CATALOG_ID, chatId, workspaceId],
  );
  if (rows.length > 0) {
    log.warn(
      { workspaceId, conflictingWorkspaceId: rows[0]?.workspace_id },
      "Telegram install rejected — chat_id already bound to a different workspace",
    );
    throw new TelegramChatIdInvalidError({
      message:
        "This Telegram chat is already connected to a different Atlas workspace. Each chat can be linked to only one workspace — disconnect it there first, or contact your admin if you believe this is an error.",
    });
  }
}

/**
 * Telegram chat ids are 64-bit signed integers documented as ≤52
 * significant bits ([Telegram bot ID spec](https://core.telegram.org/api/bots/ids)),
 * so the longest legal value is ~16 chars (with the `-100` prefix for
 * supergroups/channels). The 32-char cap here is defensive — accepts
 * any structurally-valid id well above the published envelope so a
 * spec change doesn't immediately reject valid input.
 */
const TELEGRAM_CHAT_ID_RE = /^-?\d{1,32}$/;

/**
 * Reachability call timeout. Telegram's Bot API is normally sub-second;
 * 10s gives ample headroom for transient latency while keeping the
 * install POST bounded (Bun's default fetch has no timeout in
 * serverless runtimes, so a hung upstream would otherwise hold the
 * request open indefinitely). Mirrors the pattern in
 * `jira-oauth-handler.ts`.
 */
const TELEGRAM_FETCH_TIMEOUT_MS = 10_000;

/**
 * Per-deploy operator config. Read once from env by `register.ts` and
 * passed in here. The constructor refuses to build without a non-empty
 * `botToken` so direct callers (tests, future programmatic install
 * paths) get the same env-gated guarantee `register.ts` already has.
 */
export interface TelegramStaticBotHandlerConfig {
  /** Bot token from BotFather — the `TELEGRAM_BOT_TOKEN` env var. */
  readonly botToken: string;
  /** Test-only injection of the install id generator. */
  readonly idGenerator?: () => string;
}

/** Shape persisted into `workspace_plugins.config` JSONB. */
export interface TelegramInstallConfig {
  /** Telegram chat id (string-encoded signed integer). */
  readonly chat_id: string;
  /** Optional admin-friendly label rendered in the integrations card. */
  readonly display_name?: string;
}

/**
 * Telegram Bot API response envelope. `getChat` returns
 * `{ ok: true, result: { id, type, ... } }` on success and
 * `{ ok: false, error_code, description }` on failure. Modeled as a
 * discriminated union so the success/failure branches narrow cleanly
 * and a future `result.id` access can't crash on an undefined field.
 */
type TelegramBotApiResponse =
  | {
      readonly ok: true;
      readonly result?: { readonly id: number; readonly type: string };
    }
  | {
      readonly ok: false;
      readonly description?: string;
      readonly error_code?: number;
    };

export class TelegramStaticBotInstallHandler implements StaticBotInstallHandler {
  readonly kind = "static-bot" as const;

  private readonly botToken: string;
  private readonly newId: () => string;

  constructor(config: TelegramStaticBotHandlerConfig) {
    if (!config.botToken || config.botToken.length === 0) {
      throw new Error(
        "TelegramStaticBotInstallHandler requires a non-empty botToken — set TELEGRAM_BOT_TOKEN in the deploy env and re-register via registerBuiltinInstallHandlers().",
      );
    }
    this.botToken = config.botToken;
    this.newId = config.idGenerator ?? (() => crypto.randomUUID());
  }

  async confirmInstall(
    workspaceId: WorkspaceId,
    routingIdentifier: string,
    _verificationProof?: string,
    extras?: Record<string, unknown>,
  ): Promise<{ readonly installRecord: InstallRecord }> {
    // ── 1. Validate the routing identifier ─────────────────────────
    if (!routingIdentifier || routingIdentifier.length === 0) {
      throw new TelegramChatIdInvalidError({
        message:
          "Telegram install requires a non-empty chat_id (numeric — copy from the chat's URL or use a bot like @userinfobot).",
      });
    }
    if (!TELEGRAM_CHAT_ID_RE.test(routingIdentifier)) {
      throw new TelegramChatIdInvalidError({
        message: `Telegram chat_id "${routingIdentifier}" is not a valid integer id. Public usernames (@channel) aren't accepted — use the numeric id (negative for groups/channels, e.g. -1001234567890).`,
      });
    }

    // ── 2. Reachability via Bot API getChat ─────────────────────────
    // Throws on Bot API errors / network failures *before* any DB write,
    // so a failed verification never leaves a half-installed row behind.
    await this.verifyReachability(routingIdentifier);

    // ── 2b. Cross-workspace ownership guard (#3141 / Codex #3153) ────
    // `getChat` proves the operator bot is a member of the chat, NOT that
    // THIS workspace owns it — and chat_ids leak in every message envelope.
    // Reject a chat_id already bound to a *different* workspace so a member
    // of the chat can't bind it to their own workspace and intercept the
    // chat's messages (a reconnect by the same workspace is excluded by the
    // `workspace_id <> $3` filter). This narrows the cross-tenant window; the
    // residual (two workspaces racing a never-before-bound id) is tracked,
    // with the full ownership-proof flow, in #3154.
    await assertChatIdUnboundElsewhere(routingIdentifier, workspaceId);

    // ── 3. Plan cap + install row — atomic (#3141, #3001) ──────────
    // Enforce the chat-integration cap and persist the workspace_plugins row
    // in ONE transaction guarded by a per-workspace advisory lock, so two
    // *distinct* net-new platforms installing concurrently can't both slip
    // past the cap. Reconnecting Telegram (already installed) is never blocked
    // — the gate excludes Telegram's own row from the count, and the UPSERT
    // collapses the duplicate. Identical schema + UPSERT shape to
    // discord-static-bot-handler.ts (see there for the full rationale on the
    // NOT NULL columns from 0092/0096 and the singleton-index conflict target).
    const candidateId = this.newId();
    const configPayload: TelegramInstallConfig = {
      chat_id: routingIdentifier,
      ...extractDisplayName(extras, workspaceId),
    };

    let capCheck;
    try {
      capCheck = await checkChatIntegrationLimitAndInstall<{ id: string }>(
        workspaceId,
        TELEGRAM_CATALOG_ID,
        {
          sql: `INSERT INTO workspace_plugins
           (id, workspace_id, catalog_id, install_id, pillar, config, enabled, installed_at)
         VALUES ($1, $2, $3, $1, 'chat', $4::jsonb, true, NOW())
         ON CONFLICT (workspace_id, catalog_id) WHERE pillar IN ('chat', 'action')
         DO UPDATE
           SET config = EXCLUDED.config,
               enabled = true
         RETURNING id`,
          params: [candidateId, workspaceId, TELEGRAM_CATALOG_ID, JSON.stringify(configPayload)],
        },
      );
    } catch (err) {
      log.error(
        {
          workspaceId,
          err: err instanceof Error ? err : new Error(String(err)),
        },
        "Failed to persist Telegram install record — aborting install",
      );
      throw err;
    }
    if (!capCheck.allowed) {
      if (capCheck.reason === "check_failed") {
        // Count couldn't be determined — fail closed, but as a transient
        // 503 "try again", not a misleading 429 "upgrade your plan".
        log.error(
          { workspaceId },
          "Telegram install blocked — chat-integration count check failed (failing closed)",
        );
        throw new BillingCheckFailedError({
          message: capCheck.errorMessage,
          workspaceId,
        });
      }
      log.info(
        { workspaceId, limit: capCheck.limit },
        "Telegram install blocked — workspace at chat-integration cap",
      );
      throw new ChatIntegrationLimitError({
        message: capCheck.errorMessage,
        workspaceId,
        limit: capCheck.limit,
      });
    }

    const returned = capCheck.rows[0]?.id;
    if (typeof returned !== "string" || returned.length === 0) {
      // Postgres ≥9.5 guarantees `INSERT … ON CONFLICT … RETURNING` returns
      // the row on both insert and update. Empty here means a driver /
      // wrapper regression — fail loudly rather than ship a stale id back (on
      // re-install the DB row has the existing id; falling back to the fresh
      // candidateId would strand subsequent lookups).
      throw new Error(
        `workspace_plugins UPSERT returned no id for Telegram install (workspaceId=${workspaceId}). RETURNING must always populate on PG ≥9.5; this indicates a driver regression. Aborting install.`,
      );
    }
    const persistedId: string = returned;

    log.info(
      {
        workspaceId,
        installId: persistedId,
        chatIdFingerprint: fingerprintChatId(routingIdentifier),
      },
      "Telegram install completed (chat_id reachable, install row UPSERTed)",
    );

    return {
      installRecord: {
        id: persistedId,
        workspaceId,
        catalogId: TELEGRAM_SLUG,
      },
    };
  }

  /**
   * Round-trip the Bot API to confirm the chat exists and the bot is a
   * member. The thrown errors carry Telegram's `description` verbatim
   * — admins routinely re-paste the wrong id (or forget to add the bot
   * to the channel), and the upstream message is the actionable cue.
   *
   * Token redaction: `fetch` errors from `undici` may stringify the
   * request URL (which contains the bot token in the path). The
   * sanitization step strips any `/bot<id>:<secret>/` substring from
   * the surface message; we also intentionally do NOT attach
   * `cause: err` so downstream `pino`-style serializers can't walk
   * through to a raw error object carrying the URL.
   */
  private async verifyReachability(chatId: string): Promise<void> {
    const url = `https://api.telegram.org/bot${this.botToken}/getChat?chat_id=${encodeURIComponent(chatId)}`;
    let response: Response;
    try {
      response = await fetchWithTimeout(url, TELEGRAM_FETCH_TIMEOUT_MS);
    } catch (err) {
      const message = redactBotTokens(
        err instanceof Error ? err.message : String(err),
      );
      // Network-layer failure — DNS, timeout, etc. Pino captures the
      // sanitized message via the explicit field below; we intentionally
      // do NOT attach `cause: err` because the raw cause may include
      // the bot-token URL in its message / Symbol(captured-data) fields.
      log.warn(
        {
          chatIdFingerprint: fingerprintChatId(chatId),
          fetchError: message,
        },
        "Telegram Bot API unreachable when verifying chat_id",
      );
      throw new TelegramApiUnavailableError({
        message: `Telegram Bot API unreachable when verifying chat_id (${message}). Retry, or check operator-side TELEGRAM_BOT_TOKEN wiring.`,
      });
    }

    let parsed: TelegramBotApiResponse;
    try {
      parsed = (await response.json()) as TelegramBotApiResponse;
    } catch (err) {
      const message = redactBotTokens(
        err instanceof Error ? err.message : String(err),
      );
      log.warn(
        {
          chatIdFingerprint: fingerprintChatId(chatId),
          status: response.status,
          parseError: message,
        },
        "Telegram Bot API returned non-JSON response",
      );
      throw new TelegramApiUnavailableError({
        message: `Telegram Bot API returned a non-JSON response when verifying chat_id "${chatId}" (status ${response.status}).`,
      });
    }

    if (!parsed.ok) {
      const desc = parsed.description ?? "unknown error";
      const code = parsed.error_code ?? response.status;
      const hint = hintForTelegramError(code, desc);
      throw new TelegramReachabilityError({
        message: `Telegram rejected chat_id "${chatId}": ${desc}${hint ? ` — ${hint}` : ""}`,
        errorCode: code,
      });
    }
  }
}

/**
 * Extract the optional `display_name` field from the install extras
 * blob. Drops any other keys silently — the catalog `config_schema`
 * declares the contract; new fields land via a new schema row, not via
 * arbitrary extras injection.
 *
 * When `display_name` is present but the wrong type (number, null,
 * etc.), we log at warn so the silent drop is at least observable in
 * server logs — the admin UI's form validation should never let this
 * through, so a warn here is operator signal that a non-UI caller
 * passed a malformed payload.
 */
function extractDisplayName(
  extras: Record<string, unknown> | undefined,
  workspaceId: WorkspaceId,
): { display_name?: string } {
  if (!extras) return {};
  const raw = extras.display_name;
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "string") {
    log.warn(
      { workspaceId, rawType: typeof raw },
      "Telegram extras.display_name is not a string — dropping",
    );
    return {};
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return {};
  return { display_name: trimmed };
}

/**
 * Per-status-code follow-up text appended to the upstream description.
 * Logs a warn when the code is novel (none of the known buckets match)
 * so operators see observability gaps before users do — the verbatim
 * description still propagates in the thrown error, so the user does
 * get *some* info, but a recurring null-return signals a new failure
 * mode worth a follow-up entry here.
 */
function hintForTelegramError(code: number | undefined, description: string): string | null {
  const desc = description.toLowerCase();
  if (code === 401 || desc.includes("unauthorized")) {
    return "the operator-side TELEGRAM_BOT_TOKEN may be revoked or wrong";
  }
  if (code === 403 || desc.includes("not a member") || desc.includes("forbidden")) {
    return "add the Atlas bot to the chat first (private chat: /start the bot; group/channel: invite the bot as a member)";
  }
  if (desc.includes("chat not found")) {
    return "double-check the numeric chat_id — for groups/channels it starts with -100";
  }
  log.warn(
    { errorCode: code, description },
    "Telegram error code not mapped in hintForTelegramError — consider adding a hint branch",
  );
  return null;
}

/**
 * Short, log-safe fingerprint of the chat_id — last 4 chars only. The
 * chat_id is a routing identifier, not a secret, but logging the full
 * value in every install line is noisy and lets log scrapers correlate
 * Workspace ↔ Telegram chat without going through the install row.
 */
function fingerprintChatId(chatId: string): string {
  return chatId.length <= 4 ? chatId : `…${chatId.slice(-4)}`;
}

/**
 * Strip any bot-token path segment from a message. Telegram bot tokens
 * have the documented shape `<bot_id>:<35-chars>` and ride in the URL
 * path; `undici` and similar HTTP errors sometimes surface the full
 * URL in their `.message`. This is the last-mile redaction before the
 * message reaches a log line or a thrown error.
 */
function redactBotTokens(message: string): string {
  return message.replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot<redacted>");
}

/**
 * `fetch` with a timeout. Bun's fetch has no built-in timeout in
 * serverless runtimes; without an AbortController-driven cap a hung
 * Telegram upstream would hold the install POST open indefinitely.
 * Mirrors `jira-oauth-handler.ts`'s `fetchWithTimeout`.
 */
async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
