/**
 * Action framework handler.
 *
 * Core logic for the action approval workflow:
 * - handleAction: persist request → check approval mode → auto-execute or pend
 * - approveAction / denyAction: CAS via PostgreSQL WHERE status = 'pending' RETURNING *; in-memory path uses non-atomic check-then-update
 * - getAction / listPendingActions: read-only queries
 * - defineActionExecutor / getActionExecutorForType: the action_type-keyed executor registry
 * - redispatchActionAsUser: the admin verb that runs an approved-but-stranded row
 * - getActionConfig: resolve per-action config from atlas.config.ts / defaults
 */

import type {
  ActionLogEntry,
  ActionRequest,
  ActionToolResult,
  ActionApprovalMode,
  ActionStatus,
  RollbackInfo,
} from "@atlas/api/lib/action-types";
import type { AtlasRole, AtlasUser } from "@atlas/api/lib/auth/types";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger, getRequestContext } from "@atlas/api/lib/logger";
import { getConfig, type ActionsConfig, type PerActionConfig } from "@atlas/api/lib/config";
import { canApprove, parseRole } from "@atlas/api/lib/auth/permissions";
import { logActionAudit } from "./audit";

const log = createLogger("action-handler");

import { ActionTimeoutError } from "@atlas/api/lib/effect/errors";
export { ActionTimeoutError } from "@atlas/api/lib/effect/errors";

// ---------------------------------------------------------------------------
// Timeout helper
// ---------------------------------------------------------------------------

function executeWithTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number | undefined,
): Promise<T> {
  if (timeoutMs == null) return fn();
  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ActionTimeoutError({ message: `Action timed out after ${timeoutMs}ms`, timeoutMs })), timeoutMs);
  });
  return Promise.race([fn(), timeoutPromise]).finally(() => clearTimeout(timer!));
}

// ---------------------------------------------------------------------------
// In-memory fallback store (when DATABASE_URL is not set)
// ---------------------------------------------------------------------------

const memoryStore = new Map<string, ActionLogEntry>();

// ---------------------------------------------------------------------------
// Executor registry (for deferred approval)
// ---------------------------------------------------------------------------

/**
 * Execution-time context handed to every action executor (#3766).
 *
 * `workspaceId` is the workspace the ACTION belongs to — `action_log.org_id`,
 * stamped from the requester's active organization when the action was
 * created. It is deliberately NOT re-read from the ambient request context at
 * execution time: a manual-approval action executes inside the APPROVER's
 * request, so reading the context there would let the approver's active
 * workspace decide whose credentials the action fires with. Threading the
 * requester's workspace through the registry keeps credential resolution
 * pinned to the tenant that asked.
 *
 * `null` when the action carries no workspace (self-host with auth off, or a
 * legacy pre-org-scoping row).
 */
export interface ActionExecutionContext {
  readonly workspaceId: string | null;
}

/**
 * How ONE ACTION TYPE executes. Registered at module load (#5570), never per
 * request — see {@link defineActionExecutor}.
 */
export type ActionExecutor = (
  payload: Record<string, unknown>,
  ctx: ActionExecutionContext,
) => Promise<unknown>;

/**
 * `action_type` → how that type executes.
 *
 * ⚠️ Keyed by TYPE, and that is the whole point (#5570). Until this change the
 * key was the action ID and the value was a closure `handleAction` stashed at
 * REQUEST time, which made the registry a per-process cache of in-flight
 * requests: approve after a restart, or on any other instance, and the lookup
 * missed. The row had already left `pending`, so nothing retried it — the
 * approver got a 200 whose entry status quietly said nothing ran.
 *
 * Type-keyed entries are populated at MODULE LOAD, so every instance holds the
 * same set and can execute any approved row by reconstructing the call from
 * the row itself — see {@link bindExecutorToRow}. Nothing about an individual
 * request is cached anywhere, so there is no per-process state left for a
 * restart to lose.
 *
 * ⚠️ "At module load" is only a durability guarantee if something LOADS the
 * modules. Nothing did, at first: `buildRegistry({ includeActions: true })`
 * reaches them through a lazy import that runs inside a chat turn, so a fresh
 * process taking an approve before serving one would have found this Map
 * empty — the old bug, rebuilt out of load order. `api/routes/actions.ts`
 * therefore imports the action barrel for its side effect, and
 * `actions-executor-boot.test.ts` fails if that import goes. A plugin type is
 * registered by `wireActionPlugins` instead, at wiring.
 */
const executorRegistry = new Map<string, ActionExecutor>();

/**
 * Declare how an action type executes. Call this at MODULE LOAD, beside the
 * `AtlasAction` it belongs to — never inside a request.
 *
 * The executor must be a pure function of `(payload, ctx)`: everything it
 * needs comes from the persisted row, because that is all a re-dispatching
 * instance has. In particular it must NOT close over the requesting user, the
 * ambient request context, or a resolved credential — `ctx.workspaceId` is the
 * ACTION's workspace (ADR-0046) and credential resolution happens inside the
 * executor, at execution time.
 *
 * Last registration wins at THIS level — the Map is a Map. That is not a
 * policy, and it must not be read as one: whether a plugin may take a type a
 * built-in owns is decided one layer up, by `wireActionPlugins`, which refuses
 * the collision and logs it at error level rather than letting an installed
 * plugin quietly inherit every approved `email:send`. Keep new callers to the
 * same discipline: check before you claim a type you do not own.
 */
export function defineActionExecutor(actionType: string, executor: ActionExecutor): void {
  executorRegistry.set(actionType, executor);
}

/** How `actionType` executes on THIS instance, or undefined if nothing registered it. */
export function getActionExecutorForType(actionType: string): ActionExecutor | undefined {
  return executorRegistry.get(actionType);
}

/** Does this instance know how to execute `actionType`? */
export function isActionTypeExecutable(actionType: string): boolean {
  return executorRegistry.has(actionType);
}

/**
 * Thrown when an action's type has no executor on THIS instance.
 *
 * Only the auto path throws it: there the caller is waiting, so the honest
 * answer is a failed action with a message naming the type. The deferred paths
 * do not throw — they return a typed outcome instead
 * (`approved_not_executed` / `unregistered_type`), because there the row must
 * survive to be re-dispatched by an instance that has the type loaded.
 */
class UnregisteredActionTypeError extends Error {
  constructor(readonly actionType: string) {
    // ⚠️ In the auto path this message is persisted to `action_log.error` and
    // returned to the AGENT, so it reaches a chat user. It therefore says what
    // happened and stops: the remediation ("actions enabled on this deploy?",
    // "is the plugin wired?") is deploy posture, and belongs in the log line
    // at the throw site, not in an answer to someone who asked a question
    // about their data.
    super(
      `This deployment cannot perform "${actionType}" actions right now. ` +
        "Nothing was sent. Contact an administrator if you expected this to work.",
    );
    this.name = "UnregisteredActionTypeError";
  }
}

/**
 * Reconstruct one action's execution from its PERSISTED ROW — the factory half
 * of the registry, and the single place `action_log.org_id` becomes
 * `ActionExecutionContext.workspaceId`.
 *
 * ⚠️ That mapping has exactly one author on purpose (ADR-0046). The row's
 * `org_id` is the REQUESTER's workspace, stamped at request time; the approver
 * — or, now, the re-dispatcher — may be sitting in a different one. Every
 * execution path (auto, approve, re-dispatch) binds through here, so none of
 * them can reach for the ambient context instead.
 *
 * Returns `undefined` when no executor is registered for the row's type, which
 * is the one residual case `approved_not_executed` still names.
 */
function bindExecutorToRow(entry: ActionLogEntry): (() => Promise<unknown>) | undefined {
  const executor = executorRegistry.get(entry.action_type);
  if (!executor) return undefined;
  return () => executor(entry.payload, { workspaceId: entry.org_id ?? null });
}

// ---------------------------------------------------------------------------
// Rollback method registry
// ---------------------------------------------------------------------------

type RollbackMethodHandler = (params: Record<string, unknown>) => Promise<unknown>;
const rollbackMethodRegistry = new Map<string, RollbackMethodHandler>();

export function registerRollbackMethod(method: string, handler: RollbackMethodHandler): void {
  rollbackMethodRegistry.set(method, handler);
}

export function getRollbackMethod(method: string): RollbackMethodHandler | undefined {
  return rollbackMethodRegistry.get(method);
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the effective action config for an action type (approval, timeout, requiredRole).
 * Priority: per-action override > config defaults > action's defaultApproval > "manual".
 */
export function getActionConfig(
  actionType: string,
  defaultApproval?: ActionApprovalMode,
): { approval: ActionApprovalMode; requiredRole?: AtlasRole; timeout?: number; maxPerConversation?: number } {
  const config = getConfig();
  const actionsConfig = config?.actions as ActionsConfig | undefined;

  let approval: ActionApprovalMode = defaultApproval ?? "manual";
  let requiredRole: AtlasRole | undefined;
  let timeout: number | undefined;
  let maxPerConversation: number | undefined;

  // Layer 1: config defaults
  if (actionsConfig?.defaults) {
    if (actionsConfig.defaults.approval) approval = actionsConfig.defaults.approval;
    if (actionsConfig.defaults.timeout) timeout = actionsConfig.defaults.timeout;
    if (actionsConfig.defaults.maxPerConversation) maxPerConversation = actionsConfig.defaults.maxPerConversation;
  }

  // Layer 2: per-action override
  const perAction = actionsConfig?.[actionType] as PerActionConfig | undefined;
  if (perAction) {
    if (perAction.approval) approval = perAction.approval;
    if (perAction.requiredRole) {
      const validated = parseRole(perAction.requiredRole as string);
      if (validated) {
        requiredRole = validated;
      } else {
        log.warn({ actionType, value: perAction.requiredRole }, "Per-action requiredRole is not a valid Atlas role — ignoring override");
      }
    }
    if (typeof perAction.timeout === "number" && perAction.timeout > 0) {
      timeout = perAction.timeout;
    }
  }

  return { approval, ...(requiredRole !== undefined ? { requiredRole } : {}), ...(timeout !== undefined ? { timeout } : {}), ...(maxPerConversation !== undefined ? { maxPerConversation } : {})};
}

// ---------------------------------------------------------------------------
// Build action request helper
// ---------------------------------------------------------------------------

export function buildActionRequest(params: {
  actionType: string;
  target: string;
  summary: string;
  payload: Record<string, unknown>;
  reversible: boolean;
}): ActionRequest {
  return {
    id: crypto.randomUUID(),
    ...params,
  };
}

// ---------------------------------------------------------------------------
// Persist helpers
// ---------------------------------------------------------------------------

async function persistAction(entry: ActionLogEntry): Promise<void> {
  memoryStore.set(entry.id, entry);
  if (hasInternalDB()) {
    try {
      await internalQuery(
        `INSERT INTO action_log (id, requested_by, approved_by, auth_mode, action_type, target, summary, payload, status, result, error, rollback_info, conversation_id, request_id, org_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          entry.id,
          entry.requested_by,
          entry.approved_by,
          entry.auth_mode,
          entry.action_type,
          entry.target,
          entry.summary,
          JSON.stringify(entry.payload),
          entry.status,
          entry.result ? JSON.stringify(entry.result) : null,
          entry.error,
          entry.rollback_info ? JSON.stringify(entry.rollback_info) : null,
          entry.conversation_id,
          entry.request_id,
          entry.org_id,
        ],
      );
    } catch (err) {
      // Surface the failure: a silent DB INSERT error leaves the memoryStore
      // entry divergent from the DB (caller thinks "pending" exists, admin
      // console can't find it). Drop the orphan memory entry and propagate so
      // auto-approve flows fail loudly and manual flows never register a
      // phantom pending action.
      memoryStore.delete(entry.id);
      log.error({ err, actionId: entry.id }, "Failed to persist action to DB");
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
}

/**
 * Build a parameterized `AND (org_id = $N OR org_id IS NULL)` clause for
 * action_log CRUD queries. NULL-safe so rows written before org-stamping
 * existed remain accessible. See F-12 in security audit 1.2.3.
 *
 * @security Every CRUD helper in this file (`getAction`, `approveAction`,
 * `denyAction`, `rollbackAction`, `listPendingActions`) takes `orgId` as
 * an optional trailing param. Authenticated routes **must** forward
 * `user?.activeOrganizationId` — omitting it silently drops the workspace
 * scope filter. Route-layer tests in `packages/api/src/api/__tests__/`
 * assert orgId is threaded through at every call site.
 */
function orgScopeClause(
  startIdx: number,
  orgId: string | null | undefined,
): { sql: string; params: unknown[] } {
  if (!orgId) return { sql: "", params: [] };
  return {
    sql: ` AND (org_id = $${startIdx} OR org_id IS NULL)`,
    params: [orgId],
  };
}

/** In-memory equivalent of `orgScopeClause` — NULL-safe match. */
function inMemoryOrgMatch(rowOrgId: unknown, callerOrgId: string | null | undefined): boolean {
  if (!callerOrgId) return true;
  if (rowOrgId === null || rowOrgId === undefined) return true;
  return rowOrgId === callerOrgId;
}

const COLUMN_MAP: Record<string, string> = {
  status: "status",
  resolved_at: "resolved_at",
  executed_at: "executed_at",
  approved_by: "approved_by",
  result: "result",
  error: "error",
  rollback_info: "rollback_info",
};

const JSON_COLUMNS: ReadonlySet<string> = new Set(["result", "rollback_info"]);

async function updateActionStatus(
  id: string,
  updates: Partial<Pick<ActionLogEntry, "status" | "resolved_at" | "executed_at" | "approved_by" | "result" | "error" | "rollback_info">>,
): Promise<void> {
  // Update memory store first
  const existing = memoryStore.get(id);
  if (existing) {
    memoryStore.set(id, { ...existing, ...updates });
  }

  const setClauses: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      const colName = COLUMN_MAP[key];
      if (!colName) throw new Error(`Unknown action_log column key: ${key}`);
      setClauses.push(`${colName} = $${paramIdx}`);
      params.push(JSON_COLUMNS.has(colName) ? JSON.stringify(value) : value);
      paramIdx++;
    }
  }

  if (hasInternalDB() && setClauses.length > 0) {
    params.push(id);
    try {
      await internalQuery(
        `UPDATE action_log SET ${setClauses.join(", ")} WHERE id = $${paramIdx}`,
        params,
      );
    } catch (err) {
      log.error({ err, actionId: id }, "Failed to update action status in DB — memory store updated");
    }
  }
}

// ---------------------------------------------------------------------------
// Core handler
// ---------------------------------------------------------------------------

export interface HandleActionOptions {
  conversationId?: string;
}

/**
 * Main entry point: persist pending action → check approval mode → if auto: execute immediately.
 *
 * ⚠️ Takes NO executor (#5570). How `request.actionType` executes is declared
 * once at module load via {@link defineActionExecutor}, and both the inline
 * auto path below and every later approval resolve through the same
 * {@link bindExecutorToRow}. The parameter used to exist, and it was the
 * durability bug's other half: a caller could pass a closure here and forget
 * to register the type, which worked in auto mode and silently stranded every
 * manual-approval row. With no parameter, forgetting to register is a failure
 * on the FIRST invocation, loudly, rather than at approval time on a row
 * nothing will retry.
 */
export async function handleAction(
  request: ActionRequest,
  opts?: HandleActionOptions,
): Promise<ActionToolResult> {
  const ctx = getRequestContext();
  const userId = ctx?.user?.id;
  const authMode = ctx?.user?.mode ?? "none";
  const requestId = ctx?.requestId ?? null;
  // Stamp the caller's active workspace so cross-org CRUD filters can work.
  // See F-12 in security audit 1.2.3.
  const orgId = ctx?.user?.activeOrganizationId ?? null;
  const now = new Date().toISOString();

  const entry: ActionLogEntry = {
    id: request.id,
    requested_at: now,
    resolved_at: null,
    executed_at: null,
    requested_by: userId ?? null,
    approved_by: null,
    auth_mode: authMode,
    action_type: request.actionType,
    target: request.target,
    summary: request.summary,
    payload: request.payload,
    status: "pending",
    result: null,
    error: null,
    rollback_info: null,
    conversation_id: opts?.conversationId ?? null,
    request_id: requestId,
    org_id: orgId,
  };

  await persistAction(entry);
  logActionAudit({
    actionId: request.id,
    actionType: request.actionType,
    status: "pending",
    ...(userId !== undefined ? { userId } : {}),
  });

  // Resolve approval mode
  const actionConfig = getActionConfig(request.actionType);

  if (actionConfig.approval === "auto") {
    // Execute immediately — through the same row binding a later approval or
    // re-dispatch would use, so the auto path cannot drift from them.
    const startMs = Date.now();
    try {
      const invoke = bindExecutorToRow(entry);
      if (!invoke) {
        // The operator half of the story — the user-facing half is the error's
        // own message, deliberately narrower. See the class.
        log.error(
          { actionId: request.id, actionType: request.actionType },
          "Auto-approved action cannot execute — no executor is registered for its type on this instance. The action's module did not load: check that actions are enabled on this deploy, and that any plugin declaring this type is healthy and wired.",
        );
        throw new UnregisteredActionTypeError(request.actionType);
      }
      const result = await executeWithTimeout(invoke, actionConfig.timeout);
      const latencyMs = Date.now() - startMs;

      const rbInfo = extractRollbackInfo(result);
      await updateActionStatus(request.id, {
        status: "auto_approved",
        resolved_at: new Date().toISOString(),
        executed_at: new Date().toISOString(),
        approved_by: "system:auto",
        result,
        ...(rbInfo && { rollback_info: rbInfo }),
      });
      logActionAudit({
        actionId: request.id,
        actionType: request.actionType,
        status: "auto_approved",
        latencyMs,
        ...(userId !== undefined ? { userId } : {}),
      });

      return { status: "auto_approved", actionId: request.id, result };
    } catch (err) {
      const latencyMs = Date.now() - startMs;

      if (err instanceof ActionTimeoutError) {
        await updateActionStatus(request.id, {
          status: "timed_out",
          resolved_at: new Date().toISOString(),
          error: err.message,
        });
        logActionAudit({
          actionId: request.id,
          actionType: request.actionType,
          status: "timed_out",
          latencyMs,
          timeoutMs: err.timeoutMs,
          ...(userId !== undefined ? { userId } : {}),
        });
        return { status: "timed_out", actionId: request.id, error: err.message };
      }

      const errorMsg = err instanceof Error ? err.message : String(err);

      await updateActionStatus(request.id, {
        status: "failed",
        resolved_at: new Date().toISOString(),
        error: errorMsg,
      });
      logActionAudit({
        actionId: request.id,
        actionType: request.actionType,
        status: "failed",
        latencyMs,
        ...(userId !== undefined ? { userId } : {}),
        error: errorMsg,
      });

      return { status: "failed", actionId: request.id, error: errorMsg };
    }
  }

  // Manual or admin-only: pend for approval.
  //
  // Deliberately NOT gated on the type being registered here. A row for an
  // unregistered type is the one case `approved_not_executed` still names, and
  // it is recoverable: the module may load on another instance, or on this one
  // after actions are re-enabled, and the admin re-dispatch verb then runs it.
  // Refusing to persist would turn a recoverable pend into a lost request.
  if (!isActionTypeExecutable(request.actionType)) {
    log.warn(
      { actionId: request.id, actionType: request.actionType },
      "Action pended for a type no executor is registered for on this instance — approval will report approved_not_executed until a deploy that has the type loaded re-dispatches it",
    );
  }
  return { status: "pending", actionId: request.id, summary: request.summary };
}

// ---------------------------------------------------------------------------
// Approval / denial (CAS via PostgreSQL WHERE status = 'pending' RETURNING *; in-memory path uses non-atomic check-then-update)
// ---------------------------------------------------------------------------

/**
 * Execute an approved action with timeout handling.
 * Returns the final entry state (executed, timed_out, or failed).
 */
async function executeApprovedAction(
  actionId: string,
  entry: ActionLogEntry,
  invoke: () => Promise<unknown>,
  approverId: string,
): Promise<ActionLogEntry> {
  const { timeout } = getActionConfig(entry.action_type);
  const startMs = Date.now();
  try {
    // `invoke` came from `bindExecutorToRow`, which is where the action's OWN
    // workspace (stamped at request time) — not the approver's — became the
    // execution context. See `ActionExecutionContext` (#3766) and ADR-0046.
    const result = await executeWithTimeout(invoke, timeout);
    const latencyMs = Date.now() - startMs;
    const rbInfo = extractRollbackInfo(result);

    await updateActionStatus(actionId, {
      status: "executed",
      executed_at: new Date().toISOString(),
      result,
      ...(rbInfo && { rollback_info: rbInfo }),
    });
    logActionAudit({
      actionId,
      actionType: entry.action_type,
      status: "executed",
      latencyMs,
      approverId,
    });

    const updated = memoryStore.get(actionId);
    return updated ?? { ...entry, status: "executed" as ActionStatus, executed_at: new Date().toISOString(), result, ...(rbInfo && { rollback_info: rbInfo }) };
  } catch (err) {
    const latencyMs = Date.now() - startMs;

    if (err instanceof ActionTimeoutError) {
      await updateActionStatus(actionId, {
        status: "timed_out",
        error: err.message,
      });
      logActionAudit({
        actionId,
        actionType: entry.action_type,
        status: "timed_out",
        latencyMs,
        timeoutMs: err.timeoutMs,
        approverId,
      });
      return memoryStore.get(actionId) ?? { ...entry, status: "timed_out" as ActionStatus, error: err.message };
    }

    const errorMsg = err instanceof Error ? err.message : String(err);
    await updateActionStatus(actionId, {
      status: "failed",
      error: errorMsg,
    });
    logActionAudit({
      actionId,
      actionType: entry.action_type,
      status: "failed",
      latencyMs,
      approverId,
      error: errorMsg,
    });
    return memoryStore.get(actionId) ?? { ...entry, status: "failed" as ActionStatus, error: errorMsg };
  }
}

/**
 * Approve a pending action. Returns the updated entry, or null if CAS failed
 * (action already resolved — 409 scenario).
 *
 * When `orgId` is provided, the CAS filter also requires the row's org_id
 * to match (NULL-safe for legacy rows). A cross-org caller sees the same
 * null return as a CAS race, consistent with the "don't leak existence"
 * convention established in bulk.ts.
 */
export async function approveAction(
  actionId: string,
  approverId: string,
  orgId?: string | null,
): Promise<ActionLogEntry | null> {
  // CAS in DB (atomic via WHERE status = 'pending' RETURNING *)
  if (hasInternalDB()) {
    const scope = orgScopeClause(3, orgId);
    const rows = await internalQuery(
      `UPDATE action_log
       SET status = 'approved', resolved_at = now(), approved_by = $1
       WHERE id = $2 AND status = 'pending'${scope.sql}
       RETURNING *`,
      [approverId, actionId, ...scope.params],
    ) as unknown as ActionLogEntry[];
    if (rows.length === 0) return null;

    const entry = rows[0];
    memoryStore.set(actionId, entry);

    logActionAudit({
      actionId,
      actionType: entry.action_type,
      status: "approved",
      approverId,
    });

    const invoke = bindExecutorToRow(entry);
    if (invoke) {
      return executeApprovedAction(actionId, entry, invoke, approverId);
    }

    log.warn(
      { actionId, actionType: entry.action_type },
      "Action approved but this instance has no executor registered for its type — will not execute. Re-dispatch from an instance that has the type loaded.",
    );
    return entry;
  }

  // Memory-only fallback
  const entry = memoryStore.get(actionId);
  if (!entry || entry.status !== "pending") return null;
  if (!inMemoryOrgMatch(entry.org_id, orgId)) return null;

  const approved: ActionLogEntry = {
    ...entry,
    status: "approved",
    resolved_at: new Date().toISOString(),
    approved_by: approverId,
  };
  memoryStore.set(actionId, approved);

  logActionAudit({
    actionId,
    actionType: entry.action_type,
    status: "approved",
    approverId,
  });

  const invoke = bindExecutorToRow(approved);
  if (invoke) {
    return executeApprovedAction(actionId, approved, invoke, approverId);
  }

  log.warn(
    { actionId, actionType: entry.action_type },
    "Action approved but this instance has no executor registered for its type — will not execute. Re-dispatch from an instance that has the type loaded.",
  );
  return approved;
}

/**
 * Deny a pending action. Returns the updated entry, or null if CAS failed.
 * Cross-org semantics mirror `approveAction` — see that doc.
 */
export async function denyAction(
  actionId: string,
  denierId: string,
  reason?: string,
  orgId?: string | null,
): Promise<ActionLogEntry | null> {
  if (hasInternalDB()) {
    const scope = orgScopeClause(4, orgId);
    const rows = await internalQuery(
      `UPDATE action_log
       -- approved_by is overloaded: stores approver for approved actions, denier for denied actions
       SET status = 'denied', resolved_at = now(), approved_by = $1, error = $2
       WHERE id = $3 AND status = 'pending'${scope.sql}
       RETURNING *`,
      [denierId, reason ?? null, actionId, ...scope.params],
    ) as unknown as ActionLogEntry[];
    if (rows.length === 0) return null;

    const entry = rows[0];
    memoryStore.set(actionId, entry);

    logActionAudit({
      actionId,
      actionType: entry.action_type,
      status: "denied",
      approverId: denierId,
    });

    return entry;
  }

  // Memory-only fallback
  const entry = memoryStore.get(actionId);
  if (!entry || entry.status !== "pending") return null;
  if (!inMemoryOrgMatch(entry.org_id, orgId)) return null;

  const denied: ActionLogEntry = {
    ...entry,
    status: "denied",
    resolved_at: new Date().toISOString(),
    approved_by: denierId, // approved_by is overloaded: stores approver for approved actions, denier for denied actions
    error: reason ?? null,
  };
  memoryStore.set(actionId, denied);

  logActionAudit({
    actionId,
    actionType: entry.action_type,
    status: "denied",
    approverId: denierId,
  });

  return denied;
}

// ---------------------------------------------------------------------------
// Authorized resolution — the verbs a caller with a user actually wants
// ---------------------------------------------------------------------------

/** Who is resolving (approving/denying), and from which workspace. */
export interface ActionResolutionActor {
  readonly user: AtlasUser | undefined;
  /**
   * The CALLER's active workspace — scopes the lookup and the CAS so a
   * cross-org id surfaces as `not_found` rather than leaking existence.
   * Distinct from the workspace whose credentials fire at execution: that is
   * `action_log.org_id`, stamped at REQUEST time (ADR-0046).
   */
  readonly orgId: string | null | undefined;
}

/** Why a resolution was refused before any state changed. */
export type ActionResolutionRefusal =
  | { readonly kind: "not_found" }
  | { readonly kind: "forbidden"; readonly reason: "role" | "self_approval" }
  /** Lost the CAS — the action was already resolved (or raced). */
  | { readonly kind: "conflict" };

export type ApproveActionOutcome =
  | ActionResolutionRefusal
  | { readonly kind: "approved"; readonly entry: ActionLogEntry }
  /**
   * The row is `approved` but NOTHING RAN, and since #5570 that means exactly
   * one thing: this instance has no executor registered for the row's ACTION
   * TYPE. The restart and multi-instance cases this arm used to cover are
   * gone — the registry is type-keyed and populated at module load, so any
   * instance can execute any approved row.
   *
   * What survives is the residual window where the type genuinely is not
   * loaded here: actions disabled on this deploy, an action module that
   * failed to import, or a plugin-declared type whose plugin is unhealthy.
   * The row is no longer `pending`, so nothing will retry it on its own —
   * but it IS recoverable now, through `redispatchActionAsUser` on an
   * instance that has the type. Callers must not report this as plain
   * success; the split in the type is what makes forgetting that a compile
   * error instead of a silent drop.
   */
  | { readonly kind: "approved_not_executed"; readonly entry: ActionLogEntry };

export type DenyActionOutcome =
  | ActionResolutionRefusal
  | { readonly kind: "denied"; readonly entry: ActionLogEntry };

/**
 * The authorization preamble both resolution verbs share. Until this
 * existed, its five steps were duplicated across `api/routes/actions.ts`
 * (approve AND deny handlers) and `bulk.ts`'s preClassify — and the copies
 * had already diverged once: bulk fetched the action UNSCOPED and re-applied
 * the org filter by hand, the exact omission the `@security` note on
 * `orgScopeClause` warns about.
 */
async function authorizeResolution(
  actionId: string,
  { user, orgId }: ActionResolutionActor,
): Promise<ActionResolutionRefusal | { readonly kind: "authorized"; readonly entry: ActionLogEntry }> {
  const entry = await getAction(actionId, orgId);
  if (!entry) return { kind: "not_found" };

  const cfg = getActionConfig(entry.action_type);
  if (!canApprove(user, cfg.approval, cfg.requiredRole)) {
    return { kind: "forbidden", reason: "role" };
  }
  // Separation of duties: the requester cannot resolve their own
  // admin-only action.
  if (cfg.approval === "admin-only" && user?.id === entry.requested_by) {
    return { kind: "forbidden", reason: "self_approval" };
  }
  return { kind: "authorized", entry };
}

/**
 * Approve as a user: authorization, the CAS, the executor lookup and the
 * executed/not-executed distinction, behind one interface. Callers keep only
 * their genuinely different jobs — HTTP status mapping for the route,
 * per-id partitioning for bulk. Neither passes an executor: the registry
 * lives in this module, and both callers used to fetch the value out of it
 * just to hand it straight back.
 */
export async function approveActionAsUser(
  actionId: string,
  actor: ActionResolutionActor,
): Promise<ApproveActionOutcome> {
  const auth = await authorizeResolution(actionId, actor);
  if (auth.kind !== "authorized") return auth;

  const entry = await approveAction(actionId, actor.user?.id ?? "anonymous", actor.orgId);
  if (entry === null) return { kind: "conflict" };

  // `executeApprovedAction` always advances the status past `approved`
  // (executed / failed / timed_out / rolled_back), so a row still sitting at
  // `approved` means the executor branch never ran.
  if (entry.status === "approved") {
    log.error(
      { actionId, actionType: entry.action_type },
      "Action approved but never executed — no executor is registered for its ACTION TYPE on this instance (actions disabled here, or a plugin that declares the type is not wired). The row has left 'pending', so nothing will retry it on its own; an admin can re-dispatch it from an instance that has the type loaded.",
    );
    return { kind: "approved_not_executed", entry };
  }
  return { kind: "approved", entry };
}

/** Deny as a user — same authorization, same refusal vocabulary. */
export async function denyActionAsUser(
  actionId: string,
  actor: ActionResolutionActor,
  reason?: string,
): Promise<DenyActionOutcome> {
  const auth = await authorizeResolution(actionId, actor);
  if (auth.kind !== "authorized") return auth;

  const entry = await denyAction(actionId, actor.user?.id ?? "anonymous", reason, actor.orgId);
  if (entry === null) return { kind: "conflict" };
  return { kind: "denied", entry };
}

// ---------------------------------------------------------------------------
// Re-dispatch — the human verb that clears a stranded approval (#5570)
// ---------------------------------------------------------------------------

/** Why a re-dispatch was refused, or what it did. */
export type RedispatchActionOutcome =
  | ActionResolutionRefusal
  /**
   * Nothing here can run it: no executor is registered for the row's action
   * type on this instance. Returned BEFORE the claim, so the row is untouched
   * and stays re-dispatchable from an instance that has the type loaded.
   */
  | { readonly kind: "unregistered_type"; readonly entry: ActionLogEntry }
  /**
   * It ran. `entry` carries the terminal status — `executed`, `failed` or
   * `timed_out` — exactly as the approve path reports it.
   */
  | { readonly kind: "redispatched"; readonly entry: ActionLogEntry };

/**
 * Run an action that was approved but never executed.
 *
 * ## Why a human verb and NOT a boot sweep
 *
 * The obvious fix for stranded rows is to scan for `status = 'approved'` at
 * startup and drain it. That is the wrong shape and the issue rules it out:
 * an approval is a human decision about a side effect in someone else's
 * system — a Jira ticket, an email, a Salesforce record — and it was made
 * with a summary in front of a person at a particular moment. A sweep fires
 * it hours later, after a deploy, with nobody watching, and the approver
 * cannot know it happened. So the state stays stuck until a person looks at
 * the row and says run it, on the triage re-queue's posture
 * (`lib/brain/triage-requeue.ts`): a stranded row is VISIBLE — the approval
 * that stranded it returned `approved_not_executed` and logged at error level,
 * and the row sits at `approved` for anyone reading it — and clearing it is
 * deliberate.
 *
 * ⚠️ Visible is not the same as ENUMERABLE, and this verb does not close that
 * gap: `GET /api/v1/actions?status=approved` is scoped to the rows the caller
 * requested, so there is no workspace-wide stranded-row listing today. An
 * admin reaches someone else's stranded action by id. A backlog surface
 * belongs beside the triage backlog's `GET /` if the residual window ever
 * proves wide enough to need one — it should not, since `api/routes/actions.ts`
 * imports the built-in action modules for their registration side effect, so
 * every process serving these verbs holds every built-in type from the moment
 * the router exists.
 *
 * ## The CAS, and why it claims `executed_at`
 *
 * Two admins clicking at once must not send the email twice, so the claim has
 * to be atomic and it has to happen BEFORE execution. The predicate is
 * `status = 'approved' AND executed_at IS NULL` — precisely "approved, and
 * nothing has ever run for this row" — and the claim stamps `executed_at`.
 * The loser of the race sees zero rows and gets `conflict`.
 *
 * No new status was added for the in-flight state, deliberately: `ActionStatus`
 * is a closed vocabulary mirrored in `@useatlas/types` and rendered by every
 * action surface, and the wire contracts here are meant to be unchanged.
 *
 * ⚠️ A crash BETWEEN the claim and the terminal update leaves the row
 * `approved` with `executed_at` set, and this verb will then refuse it as a
 * conflict — permanently. That is the safe answer, not an oversight: the
 * process died mid-flight, so nobody can say whether the Jira ticket was
 * created, and an automatic second attempt is the double-execution this CAS
 * exists to prevent. An operator reads the target system and, if nothing
 * landed, resolves the row by hand.
 */
export async function redispatchActionAsUser(
  actionId: string,
  actor: ActionResolutionActor,
): Promise<RedispatchActionOutcome> {
  // The SAME bar as approving, self-approval separation included. Re-dispatch
  // is the execution half of an approval: for an admin-only action, letting
  // the requester trigger the side effect would reopen exactly the separation
  // of duties the approve path closes, one verb over.
  const auth = await authorizeResolution(actionId, actor);
  if (auth.kind !== "authorized") return auth;

  if (auth.entry.status !== "approved") {
    // Not stranded — pending (approve it), or already terminal. Reported as
    // `conflict` for the same reason `approveAction` does: the caller asked to
    // move a row out of a state it is not in.
    return { kind: "conflict" };
  }

  // Checked BEFORE the claim. Claiming a row this instance cannot execute
  // would strand it harder than it already is — `executed_at` would be set,
  // so the CAS below would refuse every future attempt, including the one
  // from the instance that does have the type.
  if (!isActionTypeExecutable(auth.entry.action_type)) {
    log.warn(
      { actionId, actionType: auth.entry.action_type, approverId: actor.user?.id },
      "Action re-dispatch declined — no executor registered for its type on this instance. The row is untouched and stays re-dispatchable.",
    );
    return { kind: "unregistered_type", entry: auth.entry };
  }

  const claimed = await claimApprovedAction(actionId, actor.orgId);
  if (claimed === null) return { kind: "conflict" };

  const invoke = bindExecutorToRow(claimed);
  if (!invoke) {
    // Unreachable in practice: `isActionTypeExecutable` said yes moments ago,
    // and nothing unregisters a type at runtime. Handled rather than asserted
    // because the row is now CLAIMED — swallowing this would leave it stuck at
    // `approved` with a dispatch stamp and no explanation anywhere.
    log.error(
      { actionId, actionType: claimed.action_type },
      "Action re-dispatch claimed the row and then found no executor — the registry changed mid-call. The row is claimed and will not re-dispatch again.",
    );
    return { kind: "unregistered_type", entry: claimed };
  }

  log.info(
    { actionId, actionType: claimed.action_type, approverId: actor.user?.id, orgId: claimed.org_id },
    "Action re-dispatch claimed — executing a previously stranded approval",
  );

  const entry = await executeApprovedAction(
    actionId,
    claimed,
    invoke,
    // The row's ORIGINAL approver, not the re-dispatcher: this audit line is
    // about the action, whose approval decision has not changed. Who
    // re-dispatched is recorded by the route's admin-action row.
    claimed.approved_by ?? actor.user?.id ?? "anonymous",
  );
  return { kind: "redispatched", entry };
}

/**
 * Atomically claim an `approved`-but-never-executed row for dispatch.
 *
 * Returns the claimed row, or `null` when the claim was lost — the row moved
 * on, or another dispatcher got there first. See
 * {@link redispatchActionAsUser} for why the claim is `executed_at`.
 */
async function claimApprovedAction(
  actionId: string,
  orgId?: string | null,
): Promise<ActionLogEntry | null> {
  if (hasInternalDB()) {
    const scope = orgScopeClause(2, orgId);
    const rows = await internalQuery(
      `UPDATE action_log
       SET executed_at = now()
       WHERE id = $1 AND status = 'approved' AND executed_at IS NULL${scope.sql}
       RETURNING *`,
      [actionId, ...scope.params],
    ) as unknown as ActionLogEntry[];
    if (rows.length === 0) return null;
    const entry = rows[0];
    memoryStore.set(actionId, entry);
    return entry;
  }

  // Memory-only fallback: check-then-set, non-atomic, exactly as
  // `approveAction`'s memory path documents. Single-process by definition, so
  // the race this guards against cannot arise here.
  const entry = memoryStore.get(actionId);
  if (!entry || entry.status !== "approved" || entry.executed_at !== null) return null;
  if (!inMemoryOrgMatch(entry.org_id, orgId)) return null;

  const claimedEntry: ActionLogEntry = { ...entry, executed_at: new Date().toISOString() };
  memoryStore.set(actionId, claimedEntry);
  return claimedEntry;
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

export async function getAction(
  actionId: string,
  orgId?: string | null,
): Promise<ActionLogEntry | null> {
  if (hasInternalDB()) {
    const scope = orgScopeClause(2, orgId);
    const rows = await internalQuery(
      `SELECT * FROM action_log WHERE id = $1${scope.sql}`,
      [actionId, ...scope.params],
    ) as unknown as ActionLogEntry[];
    return rows[0] ?? null;
  }
  const entry = memoryStore.get(actionId);
  if (!entry) return null;
  if (!inMemoryOrgMatch(entry.org_id, orgId)) return null;
  return entry;
}

export interface ListActionsOptions {
  status?: ActionStatus;
  userId?: string;
  conversationId?: string;
  orgId?: string | null;
  limit?: number;
}

/**
 * Despite the name, supports filtering by any ActionStatus via opts.status.
 * Defaults to "pending" when no status filter is provided.
 *
 * When `orgId` is provided, restricts to rows matching that org (or legacy
 * rows with NULL org_id). Uses the same NULL-safe shape as `orgScopeClause`
 * above — not the helper itself, because `listPendingActions` builds the
 * whole WHERE clause dynamically with multiple optional conditions.
 */
export async function listPendingActions(opts?: ListActionsOptions): Promise<ActionLogEntry[]> {
  const limit = Math.min(opts?.limit ?? 50, 100);

  if (hasInternalDB()) {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (opts?.status) {
      conditions.push(`status = $${paramIdx++}`);
      params.push(opts.status);
    } else {
      conditions.push(`status = $${paramIdx++}`);
      params.push("pending");
    }

    if (opts?.userId) {
      conditions.push(`requested_by = $${paramIdx++}`);
      params.push(opts.userId);
    }

    if (opts?.conversationId) {
      conditions.push(`conversation_id = $${paramIdx++}`);
      params.push(opts.conversationId);
    }

    if (opts?.orgId) {
      conditions.push(`(org_id = $${paramIdx++} OR org_id IS NULL)`);
      params.push(opts.orgId);
    }

    params.push(limit);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = await internalQuery(
      `SELECT * FROM action_log ${where} ORDER BY requested_at DESC LIMIT $${paramIdx}`,
      params,
    ) as unknown as ActionLogEntry[];
    return rows;
  }

  // Memory-only fallback
  const targetStatus = opts?.status ?? "pending";
  let results = Array.from(memoryStore.values())
    .filter((e) => e.status === targetStatus);

  if (opts?.userId) {
    results = results.filter((e) => e.requested_by === opts.userId);
  }
  if (opts?.conversationId) {
    results = results.filter((e) => e.conversation_id === opts.conversationId);
  }
  if (opts?.orgId) {
    results = results.filter((e) => inMemoryOrgMatch(e.org_id, opts.orgId));
  }

  return results
    .sort((a, b) => b.requested_at.localeCompare(a.requested_at))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Rollback info extraction
// ---------------------------------------------------------------------------

/** Statuses from which an action can be rolled back. */
const ROLLBACKABLE_STATUSES: ReadonlySet<ActionStatus> = new Set(["executed", "auto_approved"]);

/** Extract RollbackInfo from an action execution result, if present. */
export function extractRollbackInfo(result: unknown): RollbackInfo | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  const info = r.rollbackInfo;
  if (!info || typeof info !== "object") return null;
  const ri = info as Record<string, unknown>;
  if (typeof ri.method !== "string") return null;
  if (!ri.params || typeof ri.params !== "object" || Array.isArray(ri.params)) return null;
  return { method: ri.method, params: ri.params as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

/** Best-effort dispatch of a rollback handler. Updates the entry with any error. */
async function dispatchRollback(
  actionId: string,
  entry: ActionLogEntry,
  rollbackInfo: RollbackInfo,
  userId: string,
): Promise<void> {
  const handler = getRollbackMethod(rollbackInfo.method);
  if (handler) {
    try {
      await handler(rollbackInfo.params);
      log.info({ actionId, method: rollbackInfo.method }, "Rollback method executed successfully");
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error({ actionId, method: rollbackInfo.method, err: errorMsg }, "Rollback method failed");
      await updateActionStatus(actionId, { error: errorMsg });
      logActionAudit({
        actionId,
        actionType: entry.action_type,
        status: "rolled_back",
        userId,
        error: errorMsg,
      });
    }
  } else {
    const noHandlerMsg = `No rollback handler registered for method: ${rollbackInfo.method}`;
    log.warn({ actionId, method: rollbackInfo.method }, "No rollback handler registered for method — status updated but rollback not dispatched");
    await updateActionStatus(actionId, { error: noHandlerMsg });
  }
}

/**
 * Roll back an executed action using its stored rollback_info.
 *
 * Rollback is best-effort: the status transitions to "rolled_back" via CAS,
 * then the rollback method handler is dispatched. If dispatch fails, the error
 * is logged and stored but the status remains "rolled_back".
 *
 * Returns the updated entry, or null if CAS failed (action not in rollbackable state).
 */
export async function rollbackAction(
  actionId: string,
  userId: string,
  orgId?: string | null,
): Promise<ActionLogEntry | null> {
  const action = await getAction(actionId, orgId);
  if (!action) return null;

  if (!ROLLBACKABLE_STATUSES.has(action.status)) {
    return null;
  }

  if (!action.rollback_info) {
    return null;
  }

  const rollbackInfo = action.rollback_info;

  // CAS: transition to rolled_back
  if (hasInternalDB()) {
    const scope = orgScopeClause(2, orgId);
    const rows = await internalQuery(
      `UPDATE action_log
       SET status = 'rolled_back', resolved_at = now()
       WHERE id = $1 AND status IN ('executed', 'auto_approved')${scope.sql}
       RETURNING *`,
      [actionId, ...scope.params],
    ) as unknown as ActionLogEntry[];
    if (rows.length === 0) return null;

    const entry = rows[0];
    memoryStore.set(actionId, entry);

    logActionAudit({
      actionId,
      actionType: entry.action_type,
      status: "rolled_back",
      userId,
    });

    await dispatchRollback(actionId, entry, rollbackInfo, userId);
    return memoryStore.get(actionId) ?? entry;
  }

  // Memory-only fallback
  const entry = memoryStore.get(actionId);
  if (!entry || !ROLLBACKABLE_STATUSES.has(entry.status)) return null;
  if (!inMemoryOrgMatch(entry.org_id, orgId)) return null;

  const rolledBack: ActionLogEntry = {
    ...entry,
    status: "rolled_back",
    resolved_at: new Date().toISOString(),
  };
  memoryStore.set(actionId, rolledBack);

  logActionAudit({
    actionId,
    actionType: entry.action_type,
    status: "rolled_back",
    userId,
  });

  await dispatchRollback(actionId, rolledBack, rollbackInfo, userId);
  return memoryStore.get(actionId) ?? rolledBack;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Test-only: back to a bare module — no rows, no executors, no rollback
 * handlers.
 *
 * ⚠️ It clears the TYPE registry too, so a test file that imports an action
 * module for its module-load `defineActionExecutor` call loses that
 * registration on the first `beforeEach`. Register what the test needs after
 * the reset; that is what the suites here do.
 */
export function _resetActionStore(): void {
  memoryStore.clear();
  _resetActionExecutors();
  rollbackMethodRegistry.clear();
}

/**
 * Test-only: unregister ONE action TYPE while keeping the rows that carry it.
 *
 * Post-#5570 this stages the only state `approveActionAsUser`'s
 * `approved_not_executed` arm still names: an approved row whose type has no
 * executor on this instance. `_resetActionStore` cannot stage it because it
 * clears the rows too.
 *
 * ⚠️ It no longer stages a RESTART — that is the point of the change. A
 * restart is now `_resetActionExecutors()` followed by re-registering, and the
 * row still executes; `execution-context.test.ts` pins exactly that.
 */
export function _undefineActionExecutor(actionType: string): void {
  executorRegistry.delete(actionType);
}

/**
 * Test-only: drop every registered executor while keeping the rows — a
 * process restart, before the action modules have re-registered.
 */
export function _resetActionExecutors(): void {
  executorRegistry.clear();
}
