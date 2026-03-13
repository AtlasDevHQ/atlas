/**
 * Conversation persistence — CRUD operations for conversations and messages,
 * plus share/unshare operations for public link sharing.
 *
 * Functions that need callers to distinguish failure modes (get, delete, star,
 * share, unshare, getShared) return discriminated union results
 * (CrudResult / CrudDataResult). Functions that are fire-and-forget
 * (createConversation, addMessage) still return null/void. Failures are
 * logged but never propagate as exceptions.
 */

import * as crypto from "crypto";
import { createLogger } from "@atlas/api/lib/logger";
import {
  hasInternalDB,
  internalQuery,
  internalExecute,
} from "@atlas/api/lib/db/internal";

const log = createLogger("conversations");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

import type { MessageRole, Surface, Conversation, Message, ConversationWithMessages } from "@atlas/api/lib/conversation-types";
export type { MessageRole, Surface, Conversation, Message, ConversationWithMessages };

/** Failure reason for CRUD operations that need to distinguish no-DB / not-found / error. */
export type CrudFailReason = "no_db" | "not_found" | "error";

/** Discriminated union result for mutation CRUD ops (star, delete). */
export type CrudResult = { ok: true } | { ok: false; reason: CrudFailReason };

/** Discriminated union result for CRUD ops that return data on success. */
export type CrudDataResult<T> = { ok: true; data: T } | { ok: false; reason: CrudFailReason };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToConversation(r: Record<string, unknown>): Conversation {
  return {
    id: r.id as string,
    userId: (r.user_id as string) ?? null,
    title: (r.title as string) ?? null,
    surface: (r.surface as Surface) ?? "web",
    connectionId: (r.connection_id as string) ?? null,
    starred: r.starred === true,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

/** Generate a short title from the first user question. */
export function generateTitle(question: string): string {
  const cleaned = question.replace(/[\r\n]+/g, " ").trim();
  if (!cleaned) return "New conversation";
  if (cleaned.length <= 80) return cleaned;
  return cleaned.slice(0, 77) + "...";
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/** Create a new conversation. Returns { id } or null if unavailable. */
export async function createConversation(opts: {
  id?: string;
  userId?: string | null;
  title?: string | null;
  surface?: string;
  connectionId?: string | null;
}): Promise<{ id: string } | null> {
  if (!hasInternalDB()) return null;
  try {
    const rows = opts.id
      ? await internalQuery<{ id: string }>(
          `INSERT INTO conversations (id, user_id, title, surface, connection_id)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [
            opts.id,
            opts.userId ?? null,
            opts.title ?? null,
            opts.surface ?? "web",
            opts.connectionId ?? null,
          ],
        )
      : await internalQuery<{ id: string }>(
          `INSERT INTO conversations (user_id, title, surface, connection_id)
           VALUES ($1, $2, $3, $4)
           RETURNING id`,
          [
            opts.userId ?? null,
            opts.title ?? null,
            opts.surface ?? "web",
            opts.connectionId ?? null,
          ],
        );
    return rows[0] ?? null;
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "createConversation failed");
    return null;
  }
}

/** Fire-and-forget — inserts the message and bumps updated_at in two separate non-transactional writes. */
export function addMessage(opts: {
  conversationId: string;
  role: MessageRole;
  content: unknown;
}): void {
  if (!hasInternalDB()) return;
  // internalExecute is fire-and-forget — async errors are logged internally.
  // Two separate non-transactional writes (partial success is possible).
  internalExecute(
    `INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)`,
    [opts.conversationId, opts.role, JSON.stringify(opts.content)],
  );
  internalExecute(
    `UPDATE conversations SET updated_at = now() WHERE id = $1`,
    [opts.conversationId],
  );
}

/** Fetches a conversation with its messages. When userId is provided, enforces ownership (AND user_id = $2); when omitted, fetches without ownership check. */
export async function getConversation(
  id: string,
  userId?: string | null,
): Promise<CrudDataResult<ConversationWithMessages>> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  try {
    const convRows = userId
      ? await internalQuery<Record<string, unknown>>(
          `SELECT id, user_id, title, surface, connection_id, starred, created_at, updated_at
           FROM conversations WHERE id = $1 AND user_id = $2`,
          [id, userId],
        )
      : await internalQuery<Record<string, unknown>>(
          `SELECT id, user_id, title, surface, connection_id, starred, created_at, updated_at
           FROM conversations WHERE id = $1`,
          [id],
        );

    if (convRows.length === 0) return { ok: false, reason: "not_found" };

    const msgRows = await internalQuery<Record<string, unknown>>(
      `SELECT id, conversation_id, role, content, created_at
       FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [id],
    );

    return {
      ok: true,
      data: {
        ...rowToConversation(convRows[0]),
        messages: msgRows.map((m) => ({
          id: m.id as string,
          conversationId: m.conversation_id as string,
          role: m.role as MessageRole,
          content: m.content,
          createdAt: String(m.created_at),
        })),
      },
    };
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "getConversation failed");
    return { ok: false, reason: "error" };
  }
}

/** List conversations (metadata only, no messages). Auth-scoped when userId is provided. */
export async function listConversations(opts?: {
  userId?: string | null;
  starred?: boolean;
  limit?: number;
  offset?: number;
}): Promise<{ conversations: Conversation[]; total: number }> {
  const empty = { conversations: [], total: 0 };
  if (!hasInternalDB()) return empty;

  const limit = opts?.limit ?? 20;
  const offset = opts?.offset ?? 0;

  try {
    // Build WHERE clause dynamically
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (opts?.userId) {
      conditions.push(`user_id = $${paramIdx++}`);
      params.push(opts.userId);
    }
    if (opts?.starred !== undefined) {
      conditions.push(`starred = $${paramIdx++}`);
      params.push(opts.starred);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countRows = await internalQuery<Record<string, unknown>>(
      `SELECT COUNT(*)::int AS total FROM conversations ${where}`,
      params,
    );
    const dataRows = await internalQuery<Record<string, unknown>>(
      `SELECT id, user_id, title, surface, connection_id, starred, created_at, updated_at
       FROM conversations ${where}
       ORDER BY updated_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
      [...params, limit, offset],
    );

    const total = (countRows[0]?.total as number) ?? 0;

    return {
      conversations: dataRows.map(rowToConversation),
      total,
    };
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "listConversations failed");
    return empty;
  }
}

/** Set the starred flag on a conversation. Auth-scoped when userId is provided. */
export async function starConversation(
  id: string,
  starred: boolean,
  userId?: string | null,
): Promise<CrudResult> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  try {
    const rows = userId
      ? await internalQuery<{ id: string }>(
          `UPDATE conversations SET starred = $1, updated_at = now()
           WHERE id = $2 AND user_id = $3 RETURNING id`,
          [starred, id, userId],
        )
      : await internalQuery<{ id: string }>(
          `UPDATE conversations SET starred = $1, updated_at = now()
           WHERE id = $2 RETURNING id`,
          [starred, id],
        );
    return rows.length > 0 ? { ok: true } : { ok: false, reason: "not_found" };
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "starConversation failed");
    return { ok: false, reason: "error" };
  }
}

/** Delete a conversation (CASCADE deletes messages). Auth-scoped when userId is provided. */
export async function deleteConversation(
  id: string,
  userId?: string | null,
): Promise<CrudResult> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  try {
    const rows = userId
      ? await internalQuery<{ id: string }>(
          `DELETE FROM conversations WHERE id = $1 AND user_id = $2 RETURNING id`,
          [id, userId],
        )
      : await internalQuery<{ id: string }>(
          `DELETE FROM conversations WHERE id = $1 RETURNING id`,
          [id],
        );
    return rows.length > 0 ? { ok: true } : { ok: false, reason: "not_found" };
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "deleteConversation failed");
    return { ok: false, reason: "error" };
  }
}

// ---------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------

/** Generate a cryptographically random share token (28 chars, base64url). */
function generateShareToken(): string {
  return crypto.randomBytes(21).toString("base64url");
}

/** Enable sharing for a conversation. Returns the share token. Auth-scoped when userId is provided. */
export async function shareConversation(
  id: string,
  userId?: string | null,
): Promise<CrudDataResult<{ token: string }>> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  try {
    const token = generateShareToken();
    const rows = userId
      ? await internalQuery<{ share_token: string }>(
          `UPDATE conversations SET share_token = $1, updated_at = now()
           WHERE id = $2 AND user_id = $3 RETURNING share_token`,
          [token, id, userId],
        )
      : await internalQuery<{ share_token: string }>(
          `UPDATE conversations SET share_token = $1, updated_at = now()
           WHERE id = $2 RETURNING share_token`,
          [token, id],
        );
    if (rows.length === 0) return { ok: false, reason: "not_found" };
    return { ok: true, data: { token: rows[0].share_token } };
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "shareConversation failed");
    return { ok: false, reason: "error" };
  }
}

/** Revoke sharing for a conversation. Auth-scoped when userId is provided. */
export async function unshareConversation(
  id: string,
  userId?: string | null,
): Promise<CrudResult> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  try {
    const rows = userId
      ? await internalQuery<{ id: string }>(
          `UPDATE conversations SET share_token = NULL, share_expires_at = NULL, updated_at = now()
           WHERE id = $1 AND user_id = $2 RETURNING id`,
          [id, userId],
        )
      : await internalQuery<{ id: string }>(
          `UPDATE conversations SET share_token = NULL, share_expires_at = NULL, updated_at = now()
           WHERE id = $1 RETURNING id`,
          [id],
        );
    return rows.length > 0 ? { ok: true } : { ok: false, reason: "not_found" };
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "unshareConversation failed");
    return { ok: false, reason: "error" };
  }
}

/** Share status data — discriminated union keyed on `shared`. */
export type ShareStatusData =
  | { shared: false; token: null; expiresAt: null }
  | { shared: true; token: string; expiresAt: string | null };

/** Fetch the share status of a conversation. Auth-scoped when userId is provided. Expired tokens are treated as not shared. */
export async function getShareStatus(
  id: string,
  userId?: string | null,
): Promise<CrudDataResult<ShareStatusData>> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  try {
    const rows = userId
      ? await internalQuery<Record<string, unknown>>(
          `SELECT share_token, share_expires_at FROM conversations WHERE id = $1 AND user_id = $2`,
          [id, userId],
        )
      : await internalQuery<Record<string, unknown>>(
          `SELECT share_token, share_expires_at FROM conversations WHERE id = $1`,
          [id],
        );
    if (rows.length === 0) return { ok: false, reason: "not_found" };
    const token = (rows[0].share_token as string) ?? null;
    const expiresAt = token && rows[0].share_expires_at ? String(rows[0].share_expires_at) : null;
    const isExpired = expiresAt !== null && new Date(expiresAt) < new Date();
    if (!token || isExpired) {
      return { ok: true, data: { shared: false, token: null, expiresAt: null } };
    }
    return { ok: true, data: { shared: true, token, expiresAt } };
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "getShareStatus failed");
    return { ok: false, reason: "error" };
  }
}

/**
 * Clean up expired share tokens by NULLing out `share_token` and
 * `share_expires_at` for rows where the expiry has passed. Returns the
 * number of rows cleaned, 0 if nothing to clean, or -1 on error.
 */
export async function cleanupExpiredShares(): Promise<number> {
  if (!hasInternalDB()) return 0;
  try {
    const rows = await internalQuery<{ id: string }>(
      `UPDATE conversations
         SET share_token = NULL, share_expires_at = NULL
       WHERE share_expires_at IS NOT NULL AND share_expires_at < NOW()
       RETURNING id`,
    );
    const count = rows.length;
    if (count > 0) {
      log.info({ count }, "Cleaned up expired share tokens");
    }
    return count;
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "cleanupExpiredShares failed");
    return -1;
  }
}

/**
 * Fetch a shared conversation by token. Returns not_found if token is missing
 * or expired. No auth required.
 *
 * Note: `share_expires_at` is reserved for future use — `shareConversation`
 * does not currently set it, so the expiry check is a no-op for now.
 */
export async function getSharedConversation(
  token: string,
): Promise<CrudDataResult<ConversationWithMessages>> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  try {
    const convRows = await internalQuery<Record<string, unknown>>(
      `SELECT id, user_id, title, surface, connection_id, starred, created_at, updated_at
       FROM conversations
       WHERE share_token = $1
         AND (share_expires_at IS NULL OR share_expires_at > now())`,
      [token],
    );

    if (convRows.length === 0) return { ok: false, reason: "not_found" };

    const convId = convRows[0].id as string;
    const msgRows = await internalQuery<Record<string, unknown>>(
      `SELECT id, conversation_id, role, content, created_at
       FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [convId],
    );

    return {
      ok: true,
      data: {
        ...rowToConversation(convRows[0]),
        messages: msgRows.map((m) => ({
          id: m.id as string,
          conversationId: m.conversation_id as string,
          role: m.role as MessageRole,
          content: m.content,
          createdAt: String(m.created_at),
        })),
      },
    };
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "getSharedConversation failed");
    return { ok: false, reason: "error" };
  }
}
