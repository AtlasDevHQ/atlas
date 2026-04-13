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

import type { MessageRole, Surface, Conversation, Message, ConversationWithMessages, NotebookStateWire } from "@atlas/api/lib/conversation-types";
export type { MessageRole, Surface, Conversation, Message, ConversationWithMessages, NotebookStateWire };

import type { ShareMode, ShareExpiryKey } from "@useatlas/types/share";
import { SHARE_EXPIRY_OPTIONS } from "@useatlas/types/share";
export type { ShareMode };

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
    notebookState: r.notebook_state
      ? (r.notebook_state as Conversation["notebookState"])
      : null,
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
  orgId?: string | null;
}): Promise<{ id: string } | null> {
  if (!hasInternalDB()) return null;
  try {
    const rows = opts.id
      ? await internalQuery<{ id: string }>(
          `INSERT INTO conversations (id, user_id, title, surface, connection_id, org_id)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id`,
          [
            opts.id,
            opts.userId ?? null,
            opts.title ?? null,
            opts.surface ?? "web",
            opts.connectionId ?? null,
            opts.orgId ?? null,
          ],
        )
      : await internalQuery<{ id: string }>(
          `INSERT INTO conversations (user_id, title, surface, connection_id, org_id)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [
            opts.userId ?? null,
            opts.title ?? null,
            opts.surface ?? "web",
            opts.connectionId ?? null,
            opts.orgId ?? null,
          ],
        );
    return rows[0] ?? null;
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "createConversation failed");
    return null;
  }
}

/**
 * Fire-and-forget: persist assistant text + tool results after the agent stream completes.
 * Iterates steps, builds a content array, and calls addMessage. Skips
 * persistence with an error log if no text or tool results are found.
 * Logs and returns on failure — never throws.
 */
export function persistAssistantSteps(opts: {
  conversationId: string;
  steps: PromiseLike<{ text: string; toolResults?: readonly { toolCallId: string; toolName: string; input: unknown; output: unknown }[] }[]>;
  label: string;
}): void {
  const { conversationId, label } = opts;
  void Promise.resolve(opts.steps)
    .then((steps) => {
      try {
        const content: unknown[] = steps.flatMap((step) => {
          const parts: unknown[] = [];
          if (step.text) {
            parts.push({ type: "text", text: step.text });
          }
          for (const tr of step.toolResults ?? []) {
            parts.push({
              type: "tool-invocation",
              toolCallId: tr.toolCallId,
              toolName: tr.toolName,
              args: tr.input,
              result: tr.output,
            });
          }
          return parts;
        });
        if (content.length === 0) {
          log.error(
            { conversationId, stepCount: steps.length },
            "[%s] Agent produced steps but no text or tool results — skipping persistence",
            label,
          );
          return;
        }
        addMessage({ conversationId, role: "assistant", content });
      } catch (persistErr) {
        log.error(
          { err: persistErr instanceof Error ? persistErr.message : String(persistErr), conversationId },
          "[%s] Failed to persist assistant message",
          label,
        );
      }
    })
    .catch((err: unknown) => {
      log.error(
        { err: err instanceof Error ? err.message : String(err), conversationId },
        "[%s] Agent stream failed — assistant response not available",
        label,
      );
    });
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
          `SELECT id, user_id, title, surface, connection_id, starred, notebook_state, created_at, updated_at
           FROM conversations WHERE id = $1 AND user_id = $2`,
          [id, userId],
        )
      : await internalQuery<Record<string, unknown>>(
          `SELECT id, user_id, title, surface, connection_id, starred, notebook_state, created_at, updated_at
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

/** List conversations (metadata only, no messages). Auth-scoped when userId/orgId is provided. */
export async function listConversations(opts?: {
  userId?: string | null;
  orgId?: string | null;
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
    if (opts?.orgId) {
      conditions.push(`org_id = $${paramIdx++}`);
      params.push(opts.orgId);
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

/** Update notebook state on a conversation. Auth-scoped when userId is provided. */
export async function updateNotebookState(
  id: string,
  notebookState: NotebookStateWire,
  userId?: string | null,
): Promise<CrudResult> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  try {
    const rows = userId
      ? await internalQuery<{ id: string }>(
          `UPDATE conversations SET notebook_state = $1, updated_at = now()
           WHERE id = $2 AND user_id = $3 RETURNING id`,
          [JSON.stringify(notebookState), id, userId],
        )
      : await internalQuery<{ id: string }>(
          `UPDATE conversations SET notebook_state = $1, updated_at = now()
           WHERE id = $2 RETURNING id`,
          [JSON.stringify(notebookState), id],
        );
    return rows.length > 0 ? { ok: true } : { ok: false, reason: "not_found" };
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "updateNotebookState failed");
    return { ok: false, reason: "error" };
  }
}

/** Fork a conversation at a specific message, copying messages up to that point. */
export async function forkConversation(opts: {
  sourceId: string;
  forkPointMessageId: string;
  userId?: string | null;
  orgId?: string | null;
}): Promise<CrudDataResult<{ id: string; messageCount: number }>> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  let newId: string | null = null;
  try {
    // Verify source exists and user owns it
    const sourceRows = opts.userId
      ? await internalQuery<Record<string, unknown>>(
          `SELECT id, title, surface, connection_id, org_id FROM conversations WHERE id = $1 AND user_id = $2`,
          [opts.sourceId, opts.userId],
        )
      : await internalQuery<Record<string, unknown>>(
          `SELECT id, title, surface, connection_id, org_id FROM conversations WHERE id = $1`,
          [opts.sourceId],
        );
    if (sourceRows.length === 0) return { ok: false, reason: "not_found" };

    const source = sourceRows[0];
    const sourceTitle = (source.title as string) ?? "Notebook";

    // Get the fork point message timestamp
    const forkMsg = await internalQuery<Record<string, unknown>>(
      `SELECT created_at FROM messages WHERE id = $1 AND conversation_id = $2`,
      [opts.forkPointMessageId, opts.sourceId],
    );
    if (forkMsg.length === 0) return { ok: false, reason: "not_found" };

    const forkTimestamp = String(forkMsg[0].created_at);

    // Check if the next message after the fork point is an assistant response
    const nextMsg = await internalQuery<Record<string, unknown>>(
      `SELECT role, created_at FROM messages
       WHERE conversation_id = $1 AND created_at > $2
       ORDER BY created_at ASC LIMIT 1`,
      [opts.sourceId, forkTimestamp],
    );

    // Include the assistant response if it follows the fork point
    const includeNext = nextMsg.length > 0 && (nextMsg[0].role as string) === "assistant";
    const cutoffTimestamp = includeNext
      ? String(nextMsg[0].created_at)
      : forkTimestamp;

    // Create new conversation
    const orgId = opts.orgId ?? (source.org_id as string) ?? null;
    const newConv = await internalQuery<{ id: string }>(
      `INSERT INTO conversations (user_id, title, surface, connection_id, org_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        opts.userId ?? null,
        `${sourceTitle} (fork)`,
        (source.surface as string) ?? "web",
        (source.connection_id as string) ?? null,
        orgId,
      ],
    );

    if (newConv.length === 0) return { ok: false, reason: "error" };
    newId = newConv[0].id;

    // Bulk-copy messages into the new conversation in a single INSERT ... SELECT
    const copyResult = await internalQuery<{ id: string }>(
      `INSERT INTO messages (conversation_id, role, content, created_at)
       SELECT $1, role, content, created_at FROM messages
       WHERE conversation_id = $2 AND created_at <= $3
       ORDER BY created_at ASC
       RETURNING id`,
      [newId, opts.sourceId, cutoffTimestamp],
    );

    if (copyResult.length === 0) {
      log.warn({ sourceId: opts.sourceId, forkPointMessageId: opts.forkPointMessageId, newId }, "Fork copied zero messages — fork point may reference a missing or mismatched message");
    }

    return { ok: true, data: { id: newId, messageCount: copyResult.length } };
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err), sourceId: opts.sourceId }, "forkConversation failed");
    // Clean up partially-created conversation to avoid orphans
    if (newId) {
      try {
        await internalQuery(`DELETE FROM conversations WHERE id = $1`, [newId]);
      } catch (cleanupErr) {
        log.error({ err: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr) }, "Failed to clean up partial fork");
      }
    }
    return { ok: false, reason: "error" };
  }
}

/** Convert a chat conversation into a notebook by copying all messages to a new conversation with surface "notebook". */
export async function convertToNotebook(opts: {
  sourceId: string;
  userId?: string | null;
  orgId?: string | null;
}): Promise<CrudDataResult<{ id: string; messageCount: number }>> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  let newId: string | null = null;
  try {
    // Verify source exists and user owns it
    const sourceRows = opts.userId
      ? await internalQuery<Record<string, unknown>>(
          `SELECT id, title, surface, connection_id, org_id FROM conversations WHERE id = $1 AND user_id = $2`,
          [opts.sourceId, opts.userId],
        )
      : await internalQuery<Record<string, unknown>>(
          `SELECT id, title, surface, connection_id, org_id FROM conversations WHERE id = $1`,
          [opts.sourceId],
        );
    if (sourceRows.length === 0) return { ok: false, reason: "not_found" };

    const source = sourceRows[0];
    const sourceTitle = (source.title as string) ?? "Conversation";
    const orgId = opts.orgId ?? (source.org_id as string) ?? null;

    // Create new conversation with surface "notebook"
    const newConv = await internalQuery<{ id: string }>(
      `INSERT INTO conversations (user_id, title, surface, connection_id, org_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        opts.userId ?? null,
        `${sourceTitle} (notebook)`,
        "notebook",
        (source.connection_id as string) ?? null,
        orgId,
      ],
    );

    if (newConv.length === 0) return { ok: false, reason: "error" };
    newId = newConv[0].id;

    // Bulk-copy all messages into the new conversation
    const copyResult = await internalQuery<{ id: string }>(
      `INSERT INTO messages (conversation_id, role, content, created_at)
       SELECT $1, role, content, created_at FROM messages
       WHERE conversation_id = $2
       ORDER BY created_at ASC
       RETURNING id`,
      [newId, opts.sourceId],
    );

    if (copyResult.length === 0) {
      log.warn({ sourceId: opts.sourceId, newId }, "convertToNotebook copied zero messages — source conversation may be empty");
    }

    return { ok: true, data: { id: newId, messageCount: copyResult.length } };
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err), sourceId: opts.sourceId }, "convertToNotebook failed");
    // Clean up partially-created conversation to avoid orphans
    if (newId) {
      try {
        await internalQuery(`DELETE FROM conversations WHERE id = $1`, [newId]);
      } catch (cleanupErr) {
        log.error({ err: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr) }, "Failed to clean up partial notebook conversion");
      }
    }
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

/** Compute an absolute expiry timestamp from a duration key. Returns null for 'never'. */
function computeExpiresAt(expiresIn?: ShareExpiryKey | null): string | null {
  if (!expiresIn || expiresIn === "never") return null;
  const seconds = SHARE_EXPIRY_OPTIONS[expiresIn];
  if (seconds === null) return null;
  return new Date(Date.now() + seconds * 1000).toISOString();
}

/** Enable sharing for a conversation. Returns the share token. Auth-scoped when userId is provided. */
export async function shareConversation(
  id: string,
  userId?: string | null,
  opts?: { expiresIn?: ShareExpiryKey | null; shareMode?: ShareMode },
): Promise<CrudDataResult<{ token: string; expiresAt: string | null; shareMode: ShareMode }>> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  try {
    const token = generateShareToken();
    const expiresAt = computeExpiresAt(opts?.expiresIn);
    const shareMode: ShareMode = opts?.shareMode ?? "public";
    const rows = userId
      ? await internalQuery<{ share_token: string }>(
          `UPDATE conversations SET share_token = $1, share_expires_at = $2, share_mode = $3, updated_at = now()
           WHERE id = $4 AND user_id = $5 RETURNING share_token`,
          [token, expiresAt, shareMode, id, userId],
        )
      : await internalQuery<{ share_token: string }>(
          `UPDATE conversations SET share_token = $1, share_expires_at = $2, share_mode = $3, updated_at = now()
           WHERE id = $4 RETURNING share_token`,
          [token, expiresAt, shareMode, id],
        );
    if (rows.length === 0) return { ok: false, reason: "not_found" };
    return { ok: true, data: { token: rows[0].share_token, expiresAt, shareMode } };
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
          `UPDATE conversations SET share_token = NULL, share_expires_at = NULL, share_mode = 'public', updated_at = now()
           WHERE id = $1 AND user_id = $2 RETURNING id`,
          [id, userId],
        )
      : await internalQuery<{ id: string }>(
          `UPDATE conversations SET share_token = NULL, share_expires_at = NULL, share_mode = 'public', updated_at = now()
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
  | { shared: false; token: null; expiresAt: null; shareMode: null }
  | { shared: true; token: string; expiresAt: string | null; shareMode: ShareMode };

/** Fetch the share status of a conversation. Auth-scoped when userId is provided. Expired tokens are treated as not shared. */
export async function getShareStatus(
  id: string,
  userId?: string | null,
): Promise<CrudDataResult<ShareStatusData>> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  try {
    const rows = userId
      ? await internalQuery<Record<string, unknown>>(
          `SELECT share_token, share_expires_at, share_mode FROM conversations WHERE id = $1 AND user_id = $2`,
          [id, userId],
        )
      : await internalQuery<Record<string, unknown>>(
          `SELECT share_token, share_expires_at, share_mode FROM conversations WHERE id = $1`,
          [id],
        );
    if (rows.length === 0) return { ok: false, reason: "not_found" };
    const token = (rows[0].share_token as string) ?? null;
    const expiresAt = token && rows[0].share_expires_at ? String(rows[0].share_expires_at) : null;
    const shareMode = (rows[0].share_mode as ShareMode) ?? "public";
    const isExpired = expiresAt !== null && new Date(expiresAt) < new Date();
    if (!token || isExpired) {
      return { ok: true, data: { shared: false, token: null, expiresAt: null, shareMode: null } };
    }
    return { ok: true, data: { shared: true, token, expiresAt, shareMode } };
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
         SET share_token = NULL, share_expires_at = NULL, share_mode = 'public'
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

/** Failure reason for shared conversation access (extends CrudFailReason). */
export type SharedConversationFailReason = CrudFailReason | "expired";

/** Result type for shared conversation access. */
export type SharedConversationResult =
  | { ok: true; data: ConversationWithMessages & { shareMode: ShareMode } }
  | { ok: false; reason: SharedConversationFailReason };

/**
 * Fetch a shared conversation by token. Returns `expired` if the share link
 * has passed its expiry time (distinct from `not_found` for missing tokens).
 * Returns `shareMode` so the route layer can enforce org-scoped access.
 */
export async function getSharedConversation(
  token: string,
): Promise<SharedConversationResult> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  try {
    const convRows = await internalQuery<Record<string, unknown>>(
      `SELECT id, user_id, title, surface, connection_id, starred, share_expires_at, share_mode, created_at, updated_at
       FROM conversations
       WHERE share_token = $1`,
      [token],
    );

    if (convRows.length === 0) return { ok: false, reason: "not_found" };

    const expiresAt = convRows[0].share_expires_at ? String(convRows[0].share_expires_at) : null;
    if (expiresAt !== null && new Date(expiresAt) < new Date()) {
      return { ok: false, reason: "expired" };
    }

    const shareMode = (convRows[0].share_mode as ShareMode) ?? "public";
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
        shareMode,
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
