/**
 * Admin action audit logger.
 *
 * Logs every admin mutation to pino (always) and to the internal Postgres
 * admin_action_log table (when DATABASE_URL is set). Fire-and-forget DB
 * writes — two layers of protection:
 *
 * 1. internalExecute() returns a promise whose rejections are swallowed
 *    (async errors — the .catch prevents unhandled rejection crashes).
 * 2. The surrounding try/catch covers synchronous throws from getInternalDB()
 *    (e.g. pool not initialized).
 *
 * Either way, audit failures never propagate to the caller.
 */

import { createLogger, getRequestContext } from "@atlas/api/lib/logger";
import { hasInternalDB, internalExecute, internalQuery } from "@atlas/api/lib/db/internal";
import type { AdminActionType, AdminTargetType } from "./actions";

const log = createLogger("admin-audit");

const ADMIN_ACTION_LOG_INSERT_SQL = `INSERT INTO admin_action_log
  (actor_id, actor_email, scope, org_id, action_type, target_type, target_id, status, metadata, ip_address, request_id)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`;

export interface AdminActionEntry {
  /** The action type from ADMIN_ACTIONS catalog. */
  actionType: AdminActionType;
  /** The target entity type (domain prefix, e.g. "workspace", "connection"). */
  targetType: AdminTargetType;
  /** The ID of the target entity. */
  targetId: string;
  /** Whether the action succeeded or failed. Defaults to "success". */
  status?: "success" | "failure";
  /** Action-specific details stored as JSONB. */
  metadata?: Record<string, unknown>;
  /** "platform" or "workspace". Defaults to "workspace" — or "platform" when systemActor is set. */
  scope?: "platform" | "workspace";
  /** Client IP address (extracted from request headers by caller). */
  ipAddress?: string | null;
  /**
   * Auto-resolved from the AsyncLocalStorage request context populated by
   * the auth middlewares — callers don't need to pass it explicitly.
   * Explicit values still win, mirroring the `metadata` precedence rule.
   * Surfaced into `admin_action_log.metadata.trustDeviceIdentifier` and
   * the pino line as a top-level field. See `lib/auth/trust-device-cookie.ts`.
   */
  trustDeviceIdentifier?: string;
  /**
   * Reserved actor for system-initiated writes with no HTTP request context
   * (schedulers, background jobs). Must match `SYSTEM_ACTOR_PATTERN`
   * (`^system:[a-z0-9][a-z0-9_-]*$`, where the leading char must be
   * alphanumeric). When set, the string is used as both actor_id and
   * actor_email (overriding any user-from-context), seeds `request_id` when
   * no request context is present, and defaults `scope` to "platform".
   * Prevents unlabeled null/"unknown" actors on the audit row for system
   * writes. See F-27 in .claude/research/security-audit-1-2-3.md.
   */
  systemActor?: string;
}

/**
 * Pinned at module scope so a typo in a caller (`audit-purge` vs
 * `audit-purge-scheduler`) or a rename of the scheduler module can't
 * silently break the forensic queries that filter on the actor. Validated
 * against this regex by `assertSystemActor`.
 */
const SYSTEM_ACTOR_PATTERN = /^system:[a-z0-9][a-z0-9_-]*$/;

function assertSystemActor(value: string): void {
  if (!SYSTEM_ACTOR_PATTERN.test(value)) {
    throw new TypeError(
      `Invalid systemActor "${value}" — must match ${SYSTEM_ACTOR_PATTERN}. See logAdminAction() docs.`,
    );
  }
}

/**
 * Log an admin action to pino and the internal DB.
 *
 * Auto-pulls actor_id, actor_email, org_id, and request_id from
 * the AsyncLocalStorage request context. The caller provides the
 * action-specific fields.
 *
 * This function NEVER throws — it is safe to call fire-and-forget. A
 * malformed `systemActor` is a programmer error: we log a warning and
 * drop the row rather than crash the caller (preserving the contract
 * every non-awaited call site relies on). The awaitable variant
 * `logAdminActionAwait` surfaces the TypeError to its caller instead.
 */
export function logAdminAction(entry: AdminActionEntry): void {
  let resolved: ResolvedEntry;
  try {
    resolved = resolveEntry(entry);
  } catch (err: unknown) {
    // The only synchronous throw path through resolveEntry is a
    // malformed systemActor. Log loudly; skip the row. Callers treat
    // this as fire-and-forget, so we can't let a typo crash the
    // scheduler loop or any other programmatic path.
    log.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        actionType: entry.actionType,
        targetId: entry.targetId,
      },
      "admin_action dropped — resolveEntry rejected (likely malformed systemActor)",
    );
    return;
  }
  emitPino(resolved);

  // Insert into admin_action_log when internal DB is available.
  // internalExecute() is fire-and-forget (returns void, handles its own
  // async errors via circuit breaker). The try/catch here guards against
  // synchronous throws from pool initialization.
  if (hasInternalDB()) {
    try {
      internalExecute(ADMIN_ACTION_LOG_INSERT_SQL, resolved.params);
    } catch (err: unknown) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "admin_action_log insert failed",
      );
    }
  }
}

/**
 * Synchronous variant for surfaces where the audit row is the security
 * control itself — e.g. the audit-retention surface, where a fire-and-forget
 * gap during a circuit-breaker open would let an attacker shrink retention
 * with no record. The Promise resolves only after the row is committed (or
 * the internal DB is absent, in which case the pino line is the trail).
 * Callers should treat a rejection as "audit row not committed — surface
 * an error to the admin so they retry."
 */
export async function logAdminActionAwait(entry: AdminActionEntry): Promise<void> {
  const resolved = resolveEntry(entry);
  emitPino(resolved);
  if (!hasInternalDB()) return;
  await internalQuery(ADMIN_ACTION_LOG_INSERT_SQL, resolved.params);
}

interface ResolvedEntry {
  readonly entry: AdminActionEntry;
  readonly actorId: string;
  readonly actorEmail: string;
  readonly orgId: string | null;
  readonly requestId: string;
  readonly scope: "platform" | "workspace";
  readonly status: "success" | "failure";
  readonly trustDeviceIdentifier: string | undefined;
  readonly metadata: Record<string, unknown> | null;
  readonly params: unknown[];
}

function resolveEntry(entry: AdminActionEntry): ResolvedEntry {
  const ctx = getRequestContext();
  // systemActor wins over request-context user so a scheduler inside an
  // outer request (e.g., a test wrapped in withRequestContext) still
  // labels itself correctly. Validated up front — a bad format throws
  // synchronously rather than writing a malformed row.
  if (entry.systemActor !== undefined) assertSystemActor(entry.systemActor);
  const useSystemActor = entry.systemActor !== undefined;
  const actorId = useSystemActor ? entry.systemActor! : (ctx?.user?.id ?? "unknown");
  const actorEmail = useSystemActor ? entry.systemActor! : (ctx?.user?.label ?? "unknown");
  const orgId = ctx?.user?.activeOrganizationId ?? null;
  const requestId = ctx?.requestId ?? (useSystemActor ? entry.systemActor! : "unknown");
  const scope = entry.scope ?? (useSystemActor ? "platform" : "workspace");
  const status = entry.status ?? "success";

  // Trust-device identifier: explicit caller value wins over the
  // request-context value so unit tests / future explicit pass paths can
  // override. systemActor writes have no HTTP request and stay undefined.
  const trustDeviceIdentifier = useSystemActor
    ? entry.trustDeviceIdentifier
    : (entry.trustDeviceIdentifier ?? ctx?.trustDeviceIdentifier);

  // Merge trustDeviceIdentifier into metadata under the same key so
  // forensic queries can pivot via `metadata->>'trustDeviceIdentifier'`.
  // Caller-supplied metadata wins on key collision — no surprise
  // overwrites of an explicit metadata field with the auto-resolved
  // identifier. `null` (not "{}") when there's nothing to record so the
  // existing zero-metadata audit rows look identical to before.
  const metadata: Record<string, unknown> | null =
    trustDeviceIdentifier !== undefined
      ? { trustDeviceIdentifier, ...(entry.metadata ?? {}) }
      : (entry.metadata ?? null);

  const params: unknown[] = [
    actorId,
    actorEmail,
    scope,
    orgId,
    entry.actionType,
    entry.targetType,
    entry.targetId,
    status,
    metadata ? JSON.stringify(metadata) : null,
    entry.ipAddress ?? null,
    requestId,
  ];
  return {
    entry,
    actorId,
    actorEmail,
    orgId,
    requestId,
    scope,
    status,
    trustDeviceIdentifier,
    metadata,
    params,
  };
}

function emitPino(resolved: ResolvedEntry): void {
  const logFn = resolved.status === "success" ? log.info.bind(log) : log.warn.bind(log);
  logFn(
    {
      actionType: resolved.entry.actionType,
      targetType: resolved.entry.targetType,
      targetId: resolved.entry.targetId,
      scope: resolved.scope,
      status: resolved.status,
      actorId: resolved.actorId,
      actorEmail: resolved.actorEmail,
      orgId: resolved.orgId,
      requestId: resolved.requestId,
      // Log the merged metadata (caller-provided + auto-resolved
      // trustDeviceIdentifier) so the pino line matches the DB row 1:1.
      // Top-level `trustDeviceIdentifier` mirrors the `ipAddress` pattern
      // for grep-friendly forensic queries against the log stream.
      ...(resolved.metadata && { metadata: resolved.metadata }),
      ...(resolved.entry.ipAddress && { ipAddress: resolved.entry.ipAddress }),
      ...(resolved.trustDeviceIdentifier && {
        trustDeviceIdentifier: resolved.trustDeviceIdentifier,
      }),
    },
    `admin_action: ${resolved.entry.actionType}`,
  );
}
