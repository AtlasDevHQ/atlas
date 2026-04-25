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
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import {
  hasInternalDB,
  internalQuery,
  internalExecute,
} from "@atlas/api/lib/db/internal";

const log = createLogger("conversations");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a DB timestamp value (Date or string) to ISO 8601 for use in SQL parameters. */
function toISOTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/**
 * Build a parameterized WHERE-suffix that scopes a conversation query to the
 * caller's auth context.
 *
 * - `user_id = $N` when a userId is provided.
 * - `(org_id = $N OR org_id IS NULL)` when an orgId is provided. The NULL
 *   branch preserves access to rows written before `org_id` was stamped
 *   (self-hosted / legacy conversations) — matches the back-compat convention
 *   established for bulk actions in `tools/actions/bulk.ts`.
 *
 * Note: `listConversations` below uses a stricter `org_id = $N` (no NULL
 * fallback) for the list view — legacy rows stay reachable by direct id but
 * are filtered out of workspace-scoped lists. Divergence is intentional.
 *
 * @security Every CRUD helper in this file takes `orgId` as an optional
 * trailing param. Routes that serve authenticated users **must** forward
 * `user?.activeOrganizationId` — omitting it silently drops the workspace
 * scope filter. Route-layer tests in `packages/api/src/api/__tests__/`
 * assert orgId is threaded through at every call site (F-11, 1.2.3).
 */
function scopeClause(
  startIdx: number,
  userId?: string | null,
  orgId?: string | null,
): { sql: string; params: unknown[]; nextIdx: number } {
  const parts: string[] = [];
  const params: unknown[] = [];
  let idx = startIdx;
  if (userId) {
    parts.push(`user_id = $${idx++}`);
    params.push(userId);
  }
  if (orgId) {
    parts.push(`(org_id = $${idx++} OR org_id IS NULL)`);
    params.push(orgId);
  }
  return {
    sql: parts.length > 0 ? ` AND ${parts.join(" AND ")}` : "",
    params,
    nextIdx: idx,
  };
}

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
    log.error({ err: errorMessage(err) }, "createConversation failed");
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
        { err: errorMessage(err), conversationId },
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

/**
 * F-77 — atomically charge the per-request step budget against a
 * conversation's running total.
 *
 * Returns one of:
 *   - `{ status: "ok", totalStepsBefore }` — the reservation was
 *     accepted; the row's `total_steps` was bumped by `stepBudget`.
 *     The caller may run the agent. Settle the actual spend afterward
 *     via `settleConversationSteps` so follow-ups see real usage, not
 *     the worst-case reservation.
 *   - `{ status: "exceeded", totalSteps }` — the row was already at or
 *     past the cap. Reject with 429 `conversation_budget_exceeded`.
 *   - `{ status: "no_db" }` — internal DB not configured; caller fails
 *     open.
 *   - `{ status: "error" }` — query threw; caller fails open. A
 *     throttled `log.warn` surfaces sustained outages so operators
 *     don't miss that F-77 is no-op'd while the DB is down.
 *
 * Atomicity: the gate is enforced at the row by
 * `UPDATE … WHERE total_steps < $cap … RETURNING`. A non-atomic
 * read-then-write loop would let two concurrent follow-ups both pass
 * the gate at `cap - 1` and then both add their full step budget,
 * letting the row exceed the cap by `(parallelism − 1) × stepBudget`.
 * Charging upfront also closes the timing hole in the previous design,
 * where the post-stream increment ran after the handler returned and
 * dropped silently if the stream failed.
 */
export type ConversationBudgetReservation =
  | { status: "ok"; totalStepsBefore: number }
  | { status: "exceeded"; totalSteps: number }
  | { status: "no_db" }
  | { status: "error" };

let lastBudgetReadFailureWarnAt = 0;
const BUDGET_FAILURE_WARN_THROTTLE_MS = 60_000;

function maybeWarnBudgetFailure(conversationId: string, err: unknown): void {
  const now = Date.now();
  if (now - lastBudgetReadFailureWarnAt < BUDGET_FAILURE_WARN_THROTTLE_MS) {
    log.debug(
      { err: errorMessage(err), conversationId },
      "Conversation budget read failed (throttled)",
    );
    return;
  }
  lastBudgetReadFailureWarnAt = now;
  log.warn(
    { err: errorMessage(err), conversationId },
    "Conversation budget read/reserve failed — F-77 cap is failing open until the internal DB is reachable",
  );
}

/** @internal — test-only. Reset the throttled-warn cooldown. */
export function _resetConversationBudgetWarnState(): void {
  lastBudgetReadFailureWarnAt = 0;
}

export async function reserveConversationBudget(
  conversationId: string,
  stepBudget: number,
  cap: number,
): Promise<ConversationBudgetReservation> {
  if (!hasInternalDB()) return { status: "no_db" };
  if (!Number.isFinite(stepBudget) || stepBudget <= 0) {
    return { status: "ok", totalStepsBefore: 0 };
  }
  if (!Number.isFinite(cap) || cap <= 0) {
    // Cap disabled — short-circuit before touching the DB.
    return { status: "ok", totalStepsBefore: 0 };
  }
  const delta = Math.floor(stepBudget);
  const ceiling = Math.floor(cap);
  try {
    const updated = await internalQuery<{ before: number | string | null }>(
      `UPDATE conversations
          SET total_steps = total_steps + $2
        WHERE id = $1 AND total_steps < $3
        RETURNING total_steps - $2 AS before`,
      [conversationId, delta, ceiling],
    );
    if (updated.length > 0) {
      const raw = updated[0].before;
      const n = typeof raw === "number" ? raw : Number(raw);
      return { status: "ok", totalStepsBefore: Number.isFinite(n) ? n : 0 };
    }
    // UPDATE returned 0 rows. Three possibilities — only one of them
    // is "exceeded", the others both mean the cap state is unknown
    // (the row vanished between auth check and reservation, or a
    // concurrent reservation just settled and freed budget). In both
    // unknown cases we MUST NOT return `ok` — the chat handler reads
    // `status === "ok"` as "charge applied, settle later" and a
    // false-positive ok corrupts `total_steps` accounting via a
    // settlement that refunds an unmade charge.
    const rows = await internalQuery<{ total_steps: number | string | null }>(
      `SELECT total_steps FROM conversations WHERE id = $1`,
      [conversationId],
    );
    if (rows.length === 0) {
      // TOCTOU: the conversation existed at the auth check but is gone
      // now. Surface the race so operators can tell genuine deletes
      // from a future logic bug.
      log.warn(
        { conversationId },
        "Reservation skipped — conversation row vanished between auth check and budget reserve (TOCTOU)",
      );
      return { status: "error" };
    }
    const raw = rows[0].total_steps;
    const n = typeof raw === "number" ? raw : Number(raw);
    const total = Number.isFinite(n) ? n : 0;
    if (total >= ceiling) {
      return { status: "exceeded", totalSteps: total };
    }
    // Row is below cap but UPDATE missed it — concurrent reservation
    // race. Fail open (the cap state is unknown), but log it; if this
    // fires repeatedly the cap parameters or transaction isolation
    // deserve a second look.
    log.warn(
      { conversationId, totalSteps: total, cap: ceiling },
      "Reservation skipped — UPDATE matched 0 rows but row is below cap (concurrent reservation race)",
    );
    return { status: "error" };
  } catch (err) {
    maybeWarnBudgetFailure(conversationId, err);
    return { status: "error" };
  }
}

/**
 * F-77 settlement adjustment. `reserveConversationBudget` charges the
 * row by the full `stepBudget` upfront so concurrent runs can't all
 * pass the gate at `cap − 1`. Once the agent loop settles, refund the
 * difference between reserved and actual spend so follow-ups see real
 * usage.
 *
 * Fire-and-forget — `internalExecute` swallows async errors with its
 * own circuit breaker + logging. The synchronous try/catch covers
 * pool-init throws. `GREATEST(0, …)` keeps the counter from going
 * negative when a stale settlement races with a concurrent reservation
 * that already settled.
 */
export function settleConversationSteps(
  conversationId: string,
  reservedSteps: number,
  actualSteps: number,
): void {
  if (!hasInternalDB()) return;
  if (!Number.isFinite(reservedSteps) || !Number.isFinite(actualSteps)) return;
  const refund =
    Math.max(0, Math.floor(reservedSteps)) -
    Math.max(0, Math.floor(actualSteps));
  if (refund <= 0) return;
  try {
    internalExecute(
      `UPDATE conversations
          SET total_steps = GREATEST(0, total_steps - $1)
        WHERE id = $2`,
      [refund, conversationId],
    );
  } catch (err) {
    log.warn(
      { err: errorMessage(err), conversationId, refund },
      "settleConversationSteps failed (synchronous throw)",
    );
  }
}

/**
 * Fetches a conversation with its messages. Scope filters are composed via
 * `scopeClause()` — `userId` enforces ownership, `orgId` restricts access to
 * the caller's active workspace (or legacy rows with NULL org_id). Omitting
 * both fetches without scoping.
 */
export async function getConversation(
  id: string,
  userId?: string | null,
  orgId?: string | null,
): Promise<CrudDataResult<ConversationWithMessages>> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  try {
    const scope = scopeClause(2, userId, orgId);
    const convRows = await internalQuery<Record<string, unknown>>(
      `SELECT id, user_id, title, surface, connection_id, starred, notebook_state, created_at, updated_at
       FROM conversations WHERE id = $1${scope.sql}`,
      [id, ...scope.params],
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
    log.error({ err: errorMessage(err) }, "getConversation failed");
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
    log.error({ err: errorMessage(err) }, "listConversations failed");
    return empty;
  }
}

/** Set the starred flag on a conversation. Scoped via userId + orgId (see `scopeClause`). */
export async function starConversation(
  id: string,
  starred: boolean,
  userId?: string | null,
  orgId?: string | null,
): Promise<CrudResult> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  try {
    const scope = scopeClause(3, userId, orgId);
    const rows = await internalQuery<{ id: string }>(
      `UPDATE conversations SET starred = $1, updated_at = now()
       WHERE id = $2${scope.sql} RETURNING id`,
      [starred, id, ...scope.params],
    );
    return rows.length > 0 ? { ok: true } : { ok: false, reason: "not_found" };
  } catch (err) {
    log.error({ err: errorMessage(err) }, "starConversation failed");
    return { ok: false, reason: "error" };
  }
}

/** Update notebook state on a conversation. Scoped via userId + orgId (see `scopeClause`). */
export async function updateNotebookState(
  id: string,
  notebookState: NotebookStateWire,
  userId?: string | null,
  orgId?: string | null,
): Promise<CrudResult> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  try {
    const scope = scopeClause(3, userId, orgId);
    const rows = await internalQuery<{ id: string }>(
      `UPDATE conversations SET notebook_state = $1, updated_at = now()
       WHERE id = $2${scope.sql} RETURNING id`,
      [JSON.stringify(notebookState), id, ...scope.params],
    );
    return rows.length > 0 ? { ok: true } : { ok: false, reason: "not_found" };
  } catch (err) {
    log.error({ err: errorMessage(err) }, "updateNotebookState failed");
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
    // Verify source exists and caller has access in both the user + org dimensions.
    // orgId from opts is the caller's *active* org — may or may not match the
    // source row's org_id; scopeClause rejects mismatches (NULL-safe for legacy rows).
    const sourceScope = scopeClause(2, opts.userId, opts.orgId);
    const sourceRows = await internalQuery<Record<string, unknown>>(
      `SELECT id, title, surface, connection_id, org_id FROM conversations WHERE id = $1${sourceScope.sql}`,
      [opts.sourceId, ...sourceScope.params],
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

    const forkTimestamp = toISOTimestamp(forkMsg[0].created_at);

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
      ? toISOTimestamp(nextMsg[0].created_at)
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
    log.error({ err: errorMessage(err), sourceId: opts.sourceId }, "forkConversation failed");
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

/** Delete a branch conversation and remove it from the root's notebookState.branches array. */
export async function deleteBranch(opts: {
  rootId: string;
  branchId: string;
  userId?: string | null;
  orgId?: string | null;
}): Promise<CrudResult> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  try {
    // Read root conversation's notebook_state — scoped to caller's auth context.
    const rootScope = scopeClause(2, opts.userId, opts.orgId);
    const rootRows = await internalQuery<Record<string, unknown>>(
      `SELECT id, notebook_state FROM conversations WHERE id = $1${rootScope.sql}`,
      [opts.rootId, ...rootScope.params],
    );
    if (rootRows.length === 0) return { ok: false, reason: "not_found" };

    const state = (rootRows[0].notebook_state ?? {}) as NotebookStateWire;
    const branches = state.branches ?? [];
    const branchIndex = branches.findIndex((b) => b.conversationId === opts.branchId);
    if (branchIndex === -1) return { ok: false, reason: "not_found" };

    // Remove from branches array
    const updatedBranches = branches.filter((b) => b.conversationId !== opts.branchId);
    const updatedState: NotebookStateWire = {
      ...state,
      branches: updatedBranches.length > 0 ? updatedBranches : undefined,
    };

    // Delete the branch conversation (CASCADE deletes messages) — scoped to the same auth context.
    const branchScope = scopeClause(2, opts.userId, opts.orgId);
    const delRows = await internalQuery<{ id: string }>(
      `DELETE FROM conversations WHERE id = $1${branchScope.sql} RETURNING id`,
      [opts.branchId, ...branchScope.params],
    );
    if (delRows.length === 0) {
      log.warn({ rootId: opts.rootId, branchId: opts.branchId }, "Branch conversation not found during delete — removing from root state anyway");
    }

    // Update root's notebook_state
    await internalQuery(
      `UPDATE conversations SET notebook_state = $1, updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(updatedState), opts.rootId],
    );

    return { ok: true };
  } catch (err) {
    log.error({ err: errorMessage(err), rootId: opts.rootId, branchId: opts.branchId }, "deleteBranch failed");
    return { ok: false, reason: "error" };
  }
}

/** Rename a branch by updating its label in the root's notebookState.branches array. */
export async function renameBranch(opts: {
  rootId: string;
  branchId: string;
  label: string;
  userId?: string | null;
  orgId?: string | null;
}): Promise<CrudResult> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  try {
    // Read root conversation's notebook_state — scoped to caller's auth context.
    const scope = scopeClause(2, opts.userId, opts.orgId);
    const rootRows = await internalQuery<Record<string, unknown>>(
      `SELECT id, notebook_state FROM conversations WHERE id = $1${scope.sql}`,
      [opts.rootId, ...scope.params],
    );
    if (rootRows.length === 0) return { ok: false, reason: "not_found" };

    const state = (rootRows[0].notebook_state ?? {}) as NotebookStateWire;
    const branches = state.branches ?? [];
    const branchIndex = branches.findIndex((b) => b.conversationId === opts.branchId);
    if (branchIndex === -1) return { ok: false, reason: "not_found" };

    // Update the label
    const updatedBranches = branches.map((b) =>
      b.conversationId === opts.branchId ? { ...b, label: opts.label } : b,
    );
    const updatedState: NotebookStateWire = { ...state, branches: updatedBranches };

    await internalQuery(
      `UPDATE conversations SET notebook_state = $1, updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(updatedState), opts.rootId],
    );

    return { ok: true };
  } catch (err) {
    log.error({ err: errorMessage(err), rootId: opts.rootId, branchId: opts.branchId }, "renameBranch failed");
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
    // Verify source exists and caller has access in both the user + org dimensions.
    const sourceScope = scopeClause(2, opts.userId, opts.orgId);
    const sourceRows = await internalQuery<Record<string, unknown>>(
      `SELECT id, title, surface, connection_id, org_id FROM conversations WHERE id = $1${sourceScope.sql}`,
      [opts.sourceId, ...sourceScope.params],
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
    log.error({ err: errorMessage(err), sourceId: opts.sourceId }, "convertToNotebook failed");
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

/** Delete a conversation (CASCADE deletes messages). Scoped via userId + orgId (see `scopeClause`). */
export async function deleteConversation(
  id: string,
  userId?: string | null,
  orgId?: string | null,
): Promise<CrudResult> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  try {
    const scope = scopeClause(2, userId, orgId);
    const rows = await internalQuery<{ id: string }>(
      `DELETE FROM conversations WHERE id = $1${scope.sql} RETURNING id`,
      [id, ...scope.params],
    );
    return rows.length > 0 ? { ok: true } : { ok: false, reason: "not_found" };
  } catch (err) {
    log.error({ err: errorMessage(err) }, "deleteConversation failed");
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

/** Failure reason for shareConversation — extends CrudFailReason with the invariant violation. */
export type ShareConversationFailReason = CrudFailReason | "invalid_org_scope";

/** Result type for shareConversation — carries the broader failure enum. */
export type ShareConversationResult =
  | { ok: true; data: { token: string; expiresAt: string | null; shareMode: ShareMode } }
  | { ok: false; reason: ShareConversationFailReason };

/**
 * Enable sharing for a conversation. Returns the share token. Auth-scoped
 * when userId is provided.
 *
 * Rejects `share_mode='org'` requests when the target conversation has no
 * `org_id`. This is the same invariant the DB CHECK constraint
 * (`chk_org_scoped_share`, 0034) enforces — raising it at the application
 * layer surfaces a structured `invalid_org_scope` reason instead of the
 * caller having to match on a Postgres error string. See #1737.
 */
export async function shareConversation(
  id: string,
  userId?: string | null,
  opts?: { orgId?: string | null; expiresIn?: ShareExpiryKey | null; shareMode?: ShareMode },
): Promise<ShareConversationResult> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  try {
    const token = generateShareToken();
    const expiresAt = computeExpiresAt(opts?.expiresIn);
    const shareMode: ShareMode = opts?.shareMode ?? "public";
    const orgId = opts?.orgId;

    // Belt-and-suspenders for the DB CHECK (#1737): if the caller asks for
    // org-scoped sharing, the target conversation must already have an
    // org_id, otherwise the share is meaningless and opens F-01.
    if (shareMode === "org") {
      const preflightScope = scopeClause(2, userId, orgId);
      const orgRows = await internalQuery<{ org_id: string | null }>(
        `SELECT org_id FROM conversations WHERE id = $1${preflightScope.sql}`,
        [id, ...preflightScope.params],
      );
      if (orgRows.length === 0) return { ok: false, reason: "not_found" };
      if (!orgRows[0].org_id) {
        log.warn(
          { conversationId: id },
          "Refusing to create org-scoped share: conversation has no org_id (#1737)",
        );
        return { ok: false, reason: "invalid_org_scope" };
      }
    }

    const scope = scopeClause(5, userId, orgId);
    const rows = await internalQuery<{ share_token: string }>(
      `UPDATE conversations SET share_token = $1, share_expires_at = $2, share_mode = $3, updated_at = now()
       WHERE id = $4${scope.sql} RETURNING share_token`,
      [token, expiresAt, shareMode, id, ...scope.params],
    );
    if (rows.length === 0) return { ok: false, reason: "not_found" };
    return { ok: true, data: { token: rows[0].share_token, expiresAt, shareMode } };
  } catch (err) {
    log.error({ err: errorMessage(err) }, "shareConversation failed");
    return { ok: false, reason: "error" };
  }
}

/** Revoke sharing for a conversation. Scoped via userId + orgId (see `scopeClause`). */
export async function unshareConversation(
  id: string,
  userId?: string | null,
  orgId?: string | null,
): Promise<CrudResult> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  try {
    const scope = scopeClause(2, userId, orgId);
    const rows = await internalQuery<{ id: string }>(
      `UPDATE conversations SET share_token = NULL, share_expires_at = NULL, share_mode = 'public', updated_at = now()
       WHERE id = $1${scope.sql} RETURNING id`,
      [id, ...scope.params],
    );
    return rows.length > 0 ? { ok: true } : { ok: false, reason: "not_found" };
  } catch (err) {
    log.error({ err: errorMessage(err) }, "unshareConversation failed");
    return { ok: false, reason: "error" };
  }
}

/** Share status data — discriminated union keyed on `shared`. */
export type ShareStatusData =
  | { shared: false; token: null; expiresAt: null; shareMode: null }
  | { shared: true; token: string; expiresAt: string | null; shareMode: ShareMode };

/** Fetch the share status of a conversation. Scoped via userId + orgId (see `scopeClause`). Expired tokens are treated as not shared. */
export async function getShareStatus(
  id: string,
  userId?: string | null,
  orgId?: string | null,
): Promise<CrudDataResult<ShareStatusData>> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  try {
    const scope = scopeClause(2, userId, orgId);
    const rows = await internalQuery<Record<string, unknown>>(
      `SELECT share_token, share_expires_at, share_mode FROM conversations WHERE id = $1${scope.sql}`,
      [id, ...scope.params],
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
    log.error({ err: errorMessage(err) }, "getShareStatus failed");
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
    log.error({ err: errorMessage(err) }, "cleanupExpiredShares failed");
    return -1;
  }
}

/** Failure reason for shared conversation access (extends CrudFailReason). */
export type SharedConversationFailReason = CrudFailReason | "expired";

/**
 * Result type for shared conversation access.
 *
 * `orgId` is the owning workspace for org-scoped shares. The route layer
 * must verify the caller belongs to this org before returning content; it
 * is NOT part of the public wire type and must be stripped from responses.
 */
export type SharedConversationResult =
  | { ok: true; data: ConversationWithMessages & { shareMode: ShareMode; orgId: string | null } }
  | { ok: false; reason: SharedConversationFailReason };

/**
 * Fetch a shared conversation by token. Returns `expired` if the share link
 * has passed its expiry time (distinct from `not_found` for missing tokens).
 * Returns `shareMode` and `orgId` so the route layer can enforce org-scoped
 * access against the caller's active organization.
 */
export async function getSharedConversation(
  token: string,
): Promise<SharedConversationResult> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  try {
    const convRows = await internalQuery<Record<string, unknown>>(
      `SELECT id, user_id, org_id, title, surface, connection_id, starred, share_expires_at, share_mode, notebook_state, created_at, updated_at
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
    const orgId = (convRows[0].org_id as string | null) ?? null;
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
        orgId,
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
    log.error({ err: errorMessage(err) }, "getSharedConversation failed");
    return { ok: false, reason: "error" };
  }
}
