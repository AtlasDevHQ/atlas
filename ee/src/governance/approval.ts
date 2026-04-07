/**
 * Enterprise approval workflows for sensitive queries.
 *
 * Approval rules define which queries require sign-off before execution:
 * - **table** rules match when a query accesses a specific table
 * - **column** rules match when a query accesses a specific column
 * - **cost** rules match when estimated row count exceeds a threshold
 *
 * When a query matches one or more rules, it is queued for approval instead
 * of executing. Designated approvers (via custom roles) can approve or deny.
 * Approved queries can then be re-executed. Stale requests auto-expire.
 *
 * All exported functions return Effect. CRUD and listing operations call
 * `requireEnterpriseEffect()` (fails with EnterpriseError). Functions in the agent's
 * critical path (`checkApprovalRequired`, `hasApprovedRequest`,
 * `expireStaleRequests`, `getPendingCount`) catch `EnterpriseError` and return
 * a safe default (false, 0, or empty) while re-throwing unexpected errors.
 */

import { Data, Effect } from "effect";
import { requireEnterpriseEffect, EnterpriseError } from "../index";
import { requireInternalDBEffect } from "../lib/db-guard";
import {
  hasInternalDB,
  internalQuery,
} from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import type {
  ApprovalRule,
  ApprovalRuleType,
  ApprovalRequest,
  ApprovalStatus,
  CreateApprovalRuleRequest,
  UpdateApprovalRuleRequest,
} from "@useatlas/types";
import { APPROVAL_RULE_TYPES, APPROVAL_STATUSES } from "@useatlas/types";

const log = createLogger("ee:approval-workflows");

// ── Typed errors ────────────────────────────────────────────────────

export type ApprovalErrorCode = "validation" | "not_found" | "conflict" | "expired";

export class ApprovalError extends Data.TaggedError("ApprovalError")<{
  message: string;
  code: ApprovalErrorCode;
}> {}

// ── Internal row shapes ─────────────────────────────────────────────

interface ApprovalRuleRow {
  id: string;
  org_id: string;
  name: string;
  rule_type: string;
  pattern: string;
  threshold: number | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

interface ApprovalQueueRow {
  id: string;
  org_id: string;
  rule_id: string;
  rule_name: string;
  requester_id: string;
  requester_email: string | null;
  query_sql: string;
  explanation: string | null;
  connection_id: string;
  tables_accessed: string | null;
  columns_accessed: string | null;
  status: string;
  reviewer_id: string | null;
  reviewer_email: string | null;
  review_comment: string | null;
  reviewed_at: string | null;
  created_at: string;
  expires_at: string;
  [key: string]: unknown;
}

// ── Helpers ─────────────────────────────────────────────────────────

function isValidRuleType(type: string): type is ApprovalRuleType {
  return (APPROVAL_RULE_TYPES as readonly string[]).includes(type);
}

function isValidStatus(status: string): status is ApprovalStatus {
  return (APPROVAL_STATUSES as readonly string[]).includes(status);
}

function rowToRule(row: ApprovalRuleRow): ApprovalRule | null {
  if (!isValidRuleType(row.rule_type)) {
    log.warn({ ruleId: row.id, ruleType: row.rule_type }, "Approval rule has unexpected rule_type in database — skipping rule");
    return null;
  }
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    ruleType: row.rule_type,
    pattern: row.pattern,
    threshold: row.threshold,
    enabled: row.enabled,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function parseJsonArray(val: string | null): string[] {
  if (!val) return [];
  try {
    const parsed: unknown = JSON.parse(val);
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === "string");
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), value: val.slice(0, 200) },
      "parseJsonArray: malformed JSON in approval queue column — returning empty array",
    );
  }
  return [];
}

function rowToRequest(row: ApprovalQueueRow): ApprovalRequest | null {
  if (!isValidStatus(row.status)) {
    log.warn({ requestId: row.id, status: row.status }, "Approval request has unexpected status in database — skipping request");
    return null;
  }
  return {
    id: row.id,
    orgId: row.org_id,
    ruleId: row.rule_id,
    ruleName: row.rule_name,
    requesterId: row.requester_id,
    requesterEmail: row.requester_email,
    querySql: row.query_sql,
    explanation: row.explanation,
    connectionId: row.connection_id,
    tablesAccessed: parseJsonArray(row.tables_accessed),
    columnsAccessed: parseJsonArray(row.columns_accessed),
    status: row.status,
    reviewerId: row.reviewer_id,
    reviewerEmail: row.reviewer_email,
    reviewComment: row.review_comment,
    reviewedAt: row.reviewed_at ? String(row.reviewed_at) : null,
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
  };
}

// ── Validation ──────────────────────────────────────────────────────

function validateRuleInput(input: CreateApprovalRuleRequest): Effect.Effect<void, ApprovalError> {
  if (!input.name || input.name.trim().length === 0) {
    return Effect.fail(new ApprovalError({ message: "Rule name is required.", code: "validation" }));
  }
  if (input.name.trim().length > 200) {
    return Effect.fail(new ApprovalError({ message: "Rule name must be 200 characters or fewer.", code: "validation" }));
  }
  if (!isValidRuleType(input.ruleType)) {
    return Effect.fail(new ApprovalError({ message: `Invalid rule type "${input.ruleType}". Supported: ${APPROVAL_RULE_TYPES.join(", ")}`, code: "validation" }));
  }
  if (input.ruleType === "cost") {
    if (input.threshold == null || input.threshold <= 0) {
      return Effect.fail(new ApprovalError({ message: "Cost rules require a positive threshold value.", code: "validation" }));
    }
  } else {
    if (!input.pattern || input.pattern.trim().length === 0) {
      return Effect.fail(new ApprovalError({ message: `Pattern is required for "${input.ruleType}" rules.`, code: "validation" }));
    }
  }
  return Effect.void;
}

// ── Default expiry ──────────────────────────────────────────────────

/** Default expiry for approval requests: 24 hours. */
const DEFAULT_EXPIRY_HOURS = 24;

function getExpiryHours(): number {
  const envVal = process.env.ATLAS_APPROVAL_EXPIRY_HOURS;
  if (envVal) {
    const parsed = Number(envVal);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_EXPIRY_HOURS;
}

// ── Rule CRUD ───────────────────────────────────────────────────────

/** List all approval rules for an organization. */
export const listApprovalRules = (orgId: string): Effect.Effect<ApprovalRule[], EnterpriseError> =>
  Effect.gen(function* () {
    yield* requireEnterpriseEffect("approval-workflows");
    if (!hasInternalDB()) return [];

    const rows = yield* Effect.promise(() => internalQuery<ApprovalRuleRow>(
      `SELECT id, org_id, name, rule_type, pattern, threshold, enabled, created_at, updated_at
       FROM approval_rules
       WHERE org_id = $1
       ORDER BY created_at ASC`,
      [orgId],
    ));
    return rows.map(rowToRule).filter((r): r is ApprovalRule => r !== null);
  });

/** Get a single approval rule by ID. */
export const getApprovalRule = (orgId: string, ruleId: string): Effect.Effect<ApprovalRule | null, ApprovalError | EnterpriseError> =>
  Effect.gen(function* () {
    yield* requireEnterpriseEffect("approval-workflows");
    if (!hasInternalDB()) return null;

    const rows = yield* Effect.promise(() => internalQuery<ApprovalRuleRow>(
      `SELECT id, org_id, name, rule_type, pattern, threshold, enabled, created_at, updated_at
       FROM approval_rules
       WHERE org_id = $1 AND id = $2
       LIMIT 1`,
      [orgId, ruleId],
    ));
    if (rows.length === 0) return null;
    const rule = rowToRule(rows[0]);
    if (!rule) {
      log.warn({ orgId, ruleId, ruleType: rows[0].rule_type }, "Approval rule found but has invalid rule_type — treating as corrupt");
      return yield* Effect.fail(new ApprovalError({ message: `Approval rule "${ruleId}" exists but has an invalid type "${rows[0].rule_type}".`, code: "validation" }));
    }
    return rule;
  });

/** Create a new approval rule. */
export const createApprovalRule = (
  orgId: string,
  input: CreateApprovalRuleRequest,
): Effect.Effect<ApprovalRule, ApprovalError | EnterpriseError | Error> =>
  Effect.gen(function* () {
    yield* requireEnterpriseEffect("approval-workflows");
    yield* requireInternalDBEffect("approval rules", () => new ApprovalError({ message: "Internal database required for approval rules.", code: "validation" }));

    yield* validateRuleInput(input);

    const rows = yield* Effect.promise(() => internalQuery<ApprovalRuleRow>(
      `INSERT INTO approval_rules (org_id, name, rule_type, pattern, threshold, enabled)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, org_id, name, rule_type, pattern, threshold, enabled, created_at, updated_at`,
      [
        orgId,
        input.name.trim(),
        input.ruleType,
        input.pattern?.trim() ?? "",
        input.threshold ?? null,
        input.enabled ?? true,
      ],
    ));

    if (rows.length === 0) {
      return yield* Effect.fail(new ApprovalError({ message: "Failed to create approval rule.", code: "validation" }));
    }

    log.info({ orgId, ruleId: rows[0].id, ruleType: input.ruleType, pattern: input.pattern }, "Approval rule created");
    const rule = rowToRule(rows[0]);
    if (!rule) return yield* Effect.fail(new ApprovalError({ message: `Created rule has unexpected rule_type "${rows[0].rule_type}" after insert.`, code: "conflict" }));
    return rule;
  });

/** Update an existing approval rule. */
export const updateApprovalRule = (
  orgId: string,
  ruleId: string,
  input: UpdateApprovalRuleRequest,
): Effect.Effect<ApprovalRule, ApprovalError | EnterpriseError | Error> =>
  Effect.gen(function* () {
    yield* requireEnterpriseEffect("approval-workflows");
    yield* requireInternalDBEffect("approval rules", () => new ApprovalError({ message: "Internal database required for approval rules.", code: "validation" }));

    // Check the rule exists
    const existing = yield* getApprovalRule(orgId, ruleId);
    if (!existing) {
      return yield* Effect.fail(new ApprovalError({ message: `Approval rule "${ruleId}" not found.`, code: "not_found" }));
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    let idx = 3; // $1 = orgId, $2 = ruleId

    if (input.name !== undefined) {
      if (input.name.trim().length === 0) {
        return yield* Effect.fail(new ApprovalError({ message: "Rule name cannot be empty.", code: "validation" }));
      }
      sets.push(`name = $${idx}`);
      params.push(input.name.trim());
      idx++;
    }
    if (input.pattern !== undefined) {
      sets.push(`pattern = $${idx}`);
      params.push(input.pattern.trim());
      idx++;
    }
    if (input.threshold !== undefined) {
      sets.push(`threshold = $${idx}`);
      params.push(input.threshold);
      idx++;
    }
    if (input.enabled !== undefined) {
      sets.push(`enabled = $${idx}`);
      params.push(input.enabled);
    }

    if (sets.length === 0) {
      return existing; // Nothing to update
    }

    sets.push("updated_at = now()");

    const rows = yield* Effect.promise(() => internalQuery<ApprovalRuleRow>(
      `UPDATE approval_rules SET ${sets.join(", ")} WHERE org_id = $1 AND id = $2
       RETURNING id, org_id, name, rule_type, pattern, threshold, enabled, created_at, updated_at`,
      [orgId, ruleId, ...params],
    ));

    if (rows.length === 0) {
      return yield* Effect.fail(new ApprovalError({ message: `Approval rule "${ruleId}" not found.`, code: "not_found" }));
    }

    log.info({ orgId, ruleId }, "Approval rule updated");
    const rule = rowToRule(rows[0]);
    if (!rule) return yield* Effect.fail(new ApprovalError({ message: `Updated rule has unexpected rule_type "${rows[0].rule_type}" after update.`, code: "conflict" }));
    return rule;
  });

/** Delete an approval rule. Returns true if deleted, false if not found. */
export const deleteApprovalRule = (orgId: string, ruleId: string): Effect.Effect<boolean, EnterpriseError> =>
  Effect.gen(function* () {
    yield* requireEnterpriseEffect("approval-workflows");
    if (!hasInternalDB()) return false;

    const rows = yield* Effect.promise(() => internalQuery<{ id: string }>(
      `DELETE FROM approval_rules WHERE org_id = $1 AND id = $2 RETURNING id`,
      [orgId, ruleId],
    ));
    if (rows.length > 0) {
      log.info({ orgId, ruleId }, "Approval rule deleted");
      return true;
    }
    return false;
  });

// ── Matching ────────────────────────────────────────────────────────

export interface ApprovalMatchResult {
  required: boolean;
  matchedRules: ApprovalRule[];
}

/**
 * Check whether a query requires approval based on the org's rules.
 * Matches validated SQL classification (tables/columns) against enabled rules.
 *
 * This function gracefully degrades when enterprise is disabled, returning
 * `{ required: false }` instead of throwing. Only `EnterpriseError` is
 * caught — unexpected errors propagate to avoid silently bypassing governance.
 */
export const checkApprovalRequired = (
  orgId: string | undefined,
  tablesAccessed: string[],
  columnsAccessed: string[],
): Effect.Effect<ApprovalMatchResult, never> =>
  Effect.gen(function* () {
    if (!orgId || !hasInternalDB()) {
      return { required: false, matchedRules: [] };
    }

    yield* requireEnterpriseEffect("approval-workflows");

    const rows = yield* Effect.promise(() => internalQuery<ApprovalRuleRow>(
      `SELECT id, org_id, name, rule_type, pattern, threshold, enabled, created_at, updated_at
       FROM approval_rules
       WHERE org_id = $1 AND enabled = true`,
      [orgId],
    ));

    if (rows.length === 0) {
      return { required: false, matchedRules: [] };
    }

    const matchedRules: ApprovalRule[] = [];
    const tablesLower = tablesAccessed.map((t) => t.toLowerCase());
    const columnsLower = columnsAccessed.map((c) => c.toLowerCase());

    for (const row of rows) {
      const rule = rowToRule(row);
      if (!rule) continue;
      const patternLower = rule.pattern.toLowerCase();

      if (rule.ruleType === "table") {
        if (tablesLower.some((t) => t === patternLower || t.endsWith(`.${patternLower}`))) {
          matchedRules.push(rule);
        }
      } else if (rule.ruleType === "column") {
        if (columnsLower.includes(patternLower)) {
          matchedRules.push(rule);
        }
      }
      // Cost rules are matched externally by caller (requires row estimate)
    }

    return {
      required: matchedRules.length > 0,
      matchedRules,
    };
  }).pipe(
    // intentionally caught: enterprise disabled — return safe default so agent queries proceed without approval
    Effect.catchAll((err) => {
      log.debug({ err: err instanceof Error ? err.message : String(err) }, "Approval check skipped — enterprise not enabled");
      return Effect.succeed({ required: false, matchedRules: [] as ApprovalRule[] });
    }),
  );

// ── Queue management ────────────────────────────────────────────────

/** Create an approval request (queue a query for review). */
export const createApprovalRequest = (opts: {
  orgId: string;
  ruleId: string;
  ruleName: string;
  requesterId: string;
  requesterEmail: string | null;
  querySql: string;
  explanation: string | null;
  connectionId: string;
  tablesAccessed: string[];
  columnsAccessed: string[];
}): Effect.Effect<ApprovalRequest, ApprovalError | EnterpriseError | Error> =>
  Effect.gen(function* () {
    yield* requireEnterpriseEffect("approval-workflows");
    yield* requireInternalDBEffect("approval queue", () => new ApprovalError({ message: "Internal database required for approval queue.", code: "validation" }));

    const expiryHours = getExpiryHours();

    const rows = yield* Effect.promise(() => internalQuery<ApprovalQueueRow>(
      `INSERT INTO approval_queue
         (org_id, rule_id, rule_name, requester_id, requester_email, query_sql, explanation,
          connection_id, tables_accessed, columns_accessed, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() + make_interval(hours => $11))
       RETURNING id, org_id, rule_id, rule_name, requester_id, requester_email, query_sql,
         explanation, connection_id, tables_accessed, columns_accessed, status,
         reviewer_id, reviewer_email, review_comment, reviewed_at, created_at, expires_at`,
      [
        opts.orgId,
        opts.ruleId,
        opts.ruleName,
        opts.requesterId,
        opts.requesterEmail,
        opts.querySql,
        opts.explanation,
        opts.connectionId,
        JSON.stringify(opts.tablesAccessed),
        JSON.stringify(opts.columnsAccessed),
        expiryHours,
      ],
    ));

    if (rows.length === 0) {
      return yield* Effect.fail(new ApprovalError({ message: "Failed to create approval request.", code: "validation" }));
    }

    log.info({ orgId: opts.orgId, requestId: rows[0].id, ruleId: opts.ruleId }, "Approval request created");
    const request = rowToRequest(rows[0]);
    if (!request) return yield* Effect.fail(new ApprovalError({ message: `Created request has unexpected status "${rows[0].status}" after insert.`, code: "conflict" }));
    return request;
  });

/** List approval requests for an organization, optionally filtered by status. */
export const listApprovalRequests = (
  orgId: string,
  status?: ApprovalStatus,
  limit = 100,
  offset = 0,
): Effect.Effect<ApprovalRequest[], EnterpriseError> =>
  Effect.gen(function* () {
    yield* requireEnterpriseEffect("approval-workflows");
    if (!hasInternalDB()) return [];

    const safeLimit = Math.min(Math.max(1, limit), 1000);
    const safeOffset = Math.max(0, offset);

    let sql = `SELECT id, org_id, rule_id, rule_name, requester_id, requester_email, query_sql,
         explanation, connection_id, tables_accessed, columns_accessed, status,
         reviewer_id, reviewer_email, review_comment, reviewed_at, created_at, expires_at
       FROM approval_queue
       WHERE org_id = $1`;
    const params: unknown[] = [orgId];

    if (status) {
      sql += ` AND status = $2`;
      params.push(status);
    }

    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(safeLimit, safeOffset);

    const rows = yield* Effect.promise(() => internalQuery<ApprovalQueueRow>(sql, params));
    return rows.map(rowToRequest).filter((r): r is ApprovalRequest => r !== null);
  });

/** Get a single approval request by ID. */
export const getApprovalRequest = (
  orgId: string,
  requestId: string,
): Effect.Effect<ApprovalRequest | null, ApprovalError | EnterpriseError> =>
  Effect.gen(function* () {
    yield* requireEnterpriseEffect("approval-workflows");
    if (!hasInternalDB()) return null;

    const rows = yield* Effect.promise(() => internalQuery<ApprovalQueueRow>(
      `SELECT id, org_id, rule_id, rule_name, requester_id, requester_email, query_sql,
         explanation, connection_id, tables_accessed, columns_accessed, status,
         reviewer_id, reviewer_email, review_comment, reviewed_at, created_at, expires_at
       FROM approval_queue
       WHERE org_id = $1 AND id = $2
       LIMIT 1`,
      [orgId, requestId],
    ));
    if (rows.length === 0) return null;
    const request = rowToRequest(rows[0]);
    if (!request) {
      log.warn({ orgId, requestId, status: rows[0].status }, "Approval request found but has invalid status — treating as corrupt");
      return yield* Effect.fail(new ApprovalError({ message: `Approval request "${requestId}" exists but has an invalid status "${rows[0].status}".`, code: "validation" }));
    }
    return request;
  });

/** Approve or deny an approval request. */
export const reviewApprovalRequest = (
  orgId: string,
  requestId: string,
  reviewerId: string,
  reviewerEmail: string | null,
  action: "approve" | "deny",
  comment?: string,
): Effect.Effect<ApprovalRequest, ApprovalError | EnterpriseError | Error> =>
  Effect.gen(function* () {
    yield* requireEnterpriseEffect("approval-workflows");
    yield* requireInternalDBEffect("approval queue", () => new ApprovalError({ message: "Internal database required for approval queue.", code: "validation" }));

    // Fetch the current request
    const existing = yield* getApprovalRequest(orgId, requestId);
    if (!existing) {
      return yield* Effect.fail(new ApprovalError({ message: `Approval request "${requestId}" not found.`, code: "not_found" }));
    }

    if (existing.status !== "pending") {
      return yield* Effect.fail(new ApprovalError({ message: `Cannot ${action} request — current status is "${existing.status}".`, code: "conflict" }));
    }

    // Prevent self-approval — the requester cannot approve their own request
    if (existing.requesterId === reviewerId) {
      return yield* Effect.fail(new ApprovalError({ message: "Cannot review your own approval request. A different admin must approve or deny it.", code: "conflict" }));
    }

    // Check if expired
    if (new Date(existing.expiresAt) < new Date()) {
      // Auto-expire it
      yield* Effect.promise(() => internalQuery(
        `UPDATE approval_queue SET status = 'expired' WHERE id = $1`,
        [requestId],
      ));
      return yield* Effect.fail(new ApprovalError({ message: "Approval request has expired.", code: "expired" }));
    }

    const newStatus: ApprovalStatus = action === "approve" ? "approved" : "denied";

    const rows = yield* Effect.promise(() => internalQuery<ApprovalQueueRow>(
      `UPDATE approval_queue
       SET status = $3, reviewer_id = $4, reviewer_email = $5, review_comment = $6, reviewed_at = now()
       WHERE org_id = $1 AND id = $2 AND status = 'pending'
       RETURNING id, org_id, rule_id, rule_name, requester_id, requester_email, query_sql,
         explanation, connection_id, tables_accessed, columns_accessed, status,
         reviewer_id, reviewer_email, review_comment, reviewed_at, created_at, expires_at`,
      [orgId, requestId, newStatus, reviewerId, reviewerEmail, comment ?? null],
    ));

    if (rows.length === 0) {
      return yield* Effect.fail(new ApprovalError({ message: `Approval request "${requestId}" not found or already reviewed.`, code: "conflict" }));
    }

    log.info(
      { orgId, requestId, action, reviewerId },
      `Approval request ${action === "approve" ? "approved" : "denied"}`,
    );
    const request = rowToRequest(rows[0]);
    if (!request) return yield* Effect.fail(new ApprovalError({ message: `Reviewed request has unexpected status "${rows[0].status}" after update.`, code: "conflict" }));
    return request;
  });

/** Expire all stale pending requests across all orgs. Returns count of expired. */
export const expireStaleRequests = (): Effect.Effect<number, never> =>
  Effect.gen(function* () {
    if (!hasInternalDB()) return 0;

    yield* requireEnterpriseEffect("approval-workflows");

    const rows = yield* Effect.promise(() => internalQuery<{ id: string }>(
      `UPDATE approval_queue
       SET status = 'expired'
       WHERE status = 'pending' AND expires_at < now()
       RETURNING id`,
    ));

    if (rows.length > 0) {
      log.info({ count: rows.length }, "Expired stale approval requests");
    }
    return rows.length;
  }).pipe(
    // intentionally caught: enterprise disabled — skip expiration silently
    Effect.catchAll((err) => {
      log.debug({ err: err instanceof Error ? err.message : String(err) }, "Stale request expiration skipped — enterprise not enabled");
      return Effect.succeed(0);
    }),
  );

/** Get count of pending approval requests for an organization. */
export const getPendingCount = (orgId: string): Effect.Effect<number, never> =>
  Effect.gen(function* () {
    if (!hasInternalDB()) return 0;

    yield* requireEnterpriseEffect("approval-workflows");

    const rows = yield* Effect.promise(() => internalQuery<{ count: string }>(
      `SELECT COUNT(*) as count FROM approval_queue
       WHERE org_id = $1 AND status = 'pending' AND expires_at > now()`,
      [orgId],
    ));

    return rows.length > 0 ? Number(rows[0].count) : 0;
  }).pipe(
    // intentionally caught: enterprise disabled — report zero pending
    Effect.catchAll((err) => {
      log.debug({ err: err instanceof Error ? err.message : String(err) }, "Pending count skipped — enterprise not enabled");
      return Effect.succeed(0);
    }),
  );

/**
 * Check whether a query already has an approved request for a given user.
 * Used by the SQL interception to allow re-execution of approved queries.
 * Returns true if an approved request exists for this exact query text.
 *
 * Returns false when enterprise is disabled — stale approved records from a
 * previously-enabled enterprise license should not grant query access.
 * Only `EnterpriseError` is caught — unexpected errors propagate to avoid
 * silently bypassing governance.
 */
export const hasApprovedRequest = (
  orgId: string,
  requesterId: string,
  querySql: string,
): Effect.Effect<boolean, never> =>
  Effect.gen(function* () {
    if (!hasInternalDB()) return false;

    yield* requireEnterpriseEffect("approval-workflows");

    const rows = yield* Effect.promise(() => internalQuery<{ id: string }>(
      `SELECT id FROM approval_queue
       WHERE org_id = $1 AND requester_id = $2 AND query_sql = $3 AND status = 'approved'
       LIMIT 1`,
      [orgId, requesterId, querySql],
    ));

    return rows.length > 0;
  }).pipe(
    // intentionally caught: enterprise disabled — stale approved records should not grant access
    Effect.catchAll((err) => {
      log.debug({ err: err instanceof Error ? err.message : String(err) }, "Approved request check skipped — enterprise not enabled");
      return Effect.succeed(false);
    }),
  );
