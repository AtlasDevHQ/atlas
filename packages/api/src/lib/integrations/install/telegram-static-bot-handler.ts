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
 * with the operator (`TELEGRAM_BOT_TOKEN`). The catalog config_schema's
 * `chat_id` is a routing identifier, not a secret — it's a Telegram
 * integer (signed) that Bot API responses leak freely in `from.id` /
 * `chat.id` of every message. We store it plaintext inside
 * `workspace_plugins.config` JSONB; the `secret: true` flag is NOT set
 * in the catalog schema so `encryptSecretFields` doesn't touch it.
 *
 * Reachability verification: rather than sending a real test message
 * (which would spam the channel on every install attempt), we call the
 * Bot API `getChat` endpoint with the supplied `chat_id`. `getChat`
 * succeeds iff (a) the chat exists and (b) the bot is a member, which
 * is exactly the install-time precondition. The error envelope from
 * Telegram (`description` field on 400/403) is propagated verbatim
 * into the thrown error message so the admin sees "Bad Request: chat
 * not found" / "Forbidden: bot is not a member of the channel chat"
 * instead of a generic "install failed".
 *
 * @see ./types.ts — {@link StaticBotInstallHandler}
 * @see https://core.telegram.org/bots/api#getchat
 */

import crypto from "crypto";
import { createLogger } from "@atlas/api/lib/logger";
import { internalQuery } from "@atlas/api/lib/db/internal";
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
 * Hardcoded here rather than read from the DB at install time — the
 * handler is Telegram-specific by construction, so resolving the id
 * dynamically would be ceremony.
 */
export const TELEGRAM_CATALOG_ID = "catalog:telegram";

/**
 * Telegram chat ids are integers (positive for users, negative for
 * groups/channels — supergroups start with `-100`). Admins typically
 * copy/paste them, and the only legal characters are an optional `-`
 * followed by digits. Reject anything else (e.g. `@channelname`,
 * which Telegram resolves on the server but isn't what the catalog
 * config_schema declares).
 *
 * Permissive on length: Telegram has crept ids over 13 digits (with
 * the `-100` prefix that's 16 chars), and there's no documented upper
 * bound. Cap at 32 chars defensively so a paste-mistake (full URL)
 * doesn't round-trip the Bot API only to fail.
 */
const TELEGRAM_CHAT_ID_RE = /^-?\d{1,32}$/;

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
 * Telegram Bot API response envelope. `getChat` returns `{ ok: true,
 * result: { id, type, ... } }` on success; failures return `{ ok:
 * false, error_code, description }`. We narrow only the fields we
 * read.
 */
interface TelegramBotApiResponse {
  readonly ok: boolean;
  readonly description?: string;
  readonly error_code?: number;
  readonly result?: { readonly id: number; readonly type: string };
}

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
      throw new Error(
        "Telegram install requires a non-empty chat_id (numeric — copy from the chat's URL or use a bot like @userinfobot).",
      );
    }
    if (!TELEGRAM_CHAT_ID_RE.test(routingIdentifier)) {
      throw new Error(
        `Telegram chat_id "${routingIdentifier}" is not a valid integer id. Public usernames (@channel) aren't accepted — use the numeric id (negative for groups/channels, e.g. -1001234567890).`,
      );
    }

    // ── 2. Reachability via Bot API getChat ─────────────────────────
    // Throws on Bot API errors / network failures *before* any DB write,
    // so a failed verification never leaves a half-installed row behind.
    await this.verifyReachability(routingIdentifier);

    // ── 3. Persist install row — UPSERT keyed on (workspace, catalog) ─
    // Mirrors the email-form-handler pattern: candidate id on the
    // INSERT side, RETURNING id so a CONFLICT lands on the existing
    // row's id (idempotent re-install).
    const candidateId = this.newId();
    const configPayload: TelegramInstallConfig = {
      chat_id: routingIdentifier,
      ...extractDisplayName(extras),
    };

    let persistedId: string;
    try {
      const rows = await internalQuery<{ id: string }>(
        `INSERT INTO workspace_plugins (id, workspace_id, catalog_id, config, enabled, installed_at)
         VALUES ($1, $2, $3, $4::jsonb, true, NOW())
         ON CONFLICT (workspace_id, catalog_id) DO UPDATE
           SET config = EXCLUDED.config,
               enabled = true
         RETURNING id`,
        [candidateId, workspaceId, TELEGRAM_CATALOG_ID, JSON.stringify(configPayload)],
      );
      const returned = rows[0]?.id;
      if (typeof returned !== "string" || returned.length === 0) {
        log.warn(
          { workspaceId, candidateId },
          "workspace_plugins UPSERT returned no id for Telegram install — falling back to candidate",
        );
        persistedId = candidateId;
      } else {
        persistedId = returned;
      }
    } catch (err) {
      log.error(
        { workspaceId, err: err instanceof Error ? err.message : String(err) },
        "Failed to persist Telegram install record — aborting install",
      );
      throw err;
    }

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
   */
  private async verifyReachability(chatId: string): Promise<void> {
    const url = `https://api.telegram.org/bot${this.botToken}/getChat?chat_id=${encodeURIComponent(chatId)}`;
    let response: Response;
    try {
      response = await fetch(url);
    } catch (err) {
      // Network-layer failure — DNS, timeout, etc. Surface Telegram in
      // the message so the admin knows which upstream to retry; attach
      // the original via `cause` so log scrapers keep the full stack.
      throw new Error(
        `Telegram Bot API unreachable when verifying chat_id (${err instanceof Error ? err.message : String(err)}). Retry, or check operator-side TELEGRAM_BOT_TOKEN wiring.`,
        { cause: err },
      );
    }

    let parsed: TelegramBotApiResponse;
    try {
      parsed = (await response.json()) as TelegramBotApiResponse;
    } catch (err) {
      throw new Error(
        `Telegram Bot API returned a non-JSON response when verifying chat_id "${chatId}" (status ${response.status}): ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    if (!parsed.ok) {
      const desc = parsed.description ?? "unknown error";
      // Common cases get a friendlier hint appended. The error_code +
      // description carry the upstream truth for ops triage.
      const hint = hintForTelegramError(parsed.error_code, desc);
      throw new Error(
        `Telegram rejected chat_id "${chatId}": ${desc}${hint ? ` — ${hint}` : ""}`,
      );
    }
  }
}

/**
 * Extract the optional `display_name` field from the install extras
 * blob. Drops any other keys silently — the catalog `config_schema`
 * declares the contract; new fields land via a new schema row, not via
 * arbitrary extras injection.
 */
function extractDisplayName(
  extras: Record<string, unknown> | undefined,
): { display_name?: string } {
  if (!extras) return {};
  const raw = extras.display_name;
  if (typeof raw !== "string") return {};
  const trimmed = raw.trim();
  if (trimmed.length === 0) return {};
  return { display_name: trimmed };
}

/**
 * Per-status-code follow-up text appended to the upstream description.
 * Keeps the thrown error actionable without leaking the bot token or
 * any other operator-scoped detail.
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
