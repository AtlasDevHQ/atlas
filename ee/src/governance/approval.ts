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
 * All exported functions require enterprise. CRUD and listing operations call
 * `requireEnterprise()` directly (throws on failure). Functions in the agent's
 * critical path (`checkApprovalRequired`, `hasApprovedRequest`,
 * `expireStaleRequests`, `getPendingCount`) catch `EnterpriseError` and return
 * a safe default (false, 0, or empty) while re-throwing unexpected errors.
 */

import { requireEnterprise, EnterpriseError } from "../index";
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

export class ApprovalError extends Error {
  constructor(message: string, public readonly code: ApprovalErrorCode) {
    super(message);
    this.name = "ApprovalError";
  }
}

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

function validateRuleInput(input: CreateApprovalRuleRequest): void {
  if (!input.name || input.name.trim().length === 0) {
    throw new ApprovalError("Rule name is required.", "validation");
  }
  if (input.name.trim().length > 200) {
    throw new ApprovalError("Rule name must be 200 characters or fewer.", "validation");
  }
  if (!isValidRuleType(input.ruleType)) {
    throw new ApprovalError(
      `Invalid rule type "${input.ruleType}". Supported: ${APPROVAL_RULE_TYPES.join(", ")}`,
      "validation",
    );
  }
  if (input.ruleType === "cost") {
    if (input.threshold == null || input.threshold <= 0) {
      throw new ApprovalError("Cost rules require a positive threshold value.", "validation");
    }
  } else {
    if (!input.pattern || input.pattern.trim().length === 0) {
      throw new ApprovalError(`Pattern is required for "${input.ruleType}" rules.`, "validation");
    }
  }
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
export async function listApprovalRules(orgId: string): Promise<ApprovalRule[]> {
  requireEnterprise("approval-workflows");
  if (!hasInternalDB()) return [];

  const rows = await internalQuery<ApprovalRuleRow>(
    `SELECT id, org_id, name, rule_type, pattern, threshold, enabled, created_at, updated_at
     FROM approval_rules
     WHERE org_id = $1
     ORDER BY created_at ASC`,
    [orgId],
  );
  return rows.map(rowToRule).filter((r): r is ApprovalRule => r !== null);
}

/** Get a single approval rule by ID. */
export async function getApprovalRule(orgId: string, ruleId: string): Promise<ApprovalRule | null> {
  requireEnterprise("approval-workflows");
  if (!hasInternalDB()) return null;

  const rows = await internalQuery<ApprovalRuleRow>(
    `SELECT id, org_id, name, rule_type, pattern, threshold, enabled, created_at, updated_at
     FROM approval_rules
     WHERE org_id = $1 AND id = $2
     LIMIT 1`,
    [orgId, ruleId],
  );
  if (rows.length === 0) return null;
  const rule = rowToRule(rows[0]);
  if (!rule) {
    log.warn({ orgId, ruleId, ruleType: rows[0].rule_type }, "Approval rule found but has invalid rule_type — treating as corrupt");
    throw new ApprovalError(
      `Approval rule "${ruleId}" exists but has an invalid type "${rows[0].rule_type}".`,
      "validation",
    );
  }
  return rule;
}

/** Create a new approval rule. */
export async function createApprovalRule(
  orgId: string,
  input: CreateApprovalRuleRequest,
): Promise<ApprovalRule> {
  requireEnterprise("approval-workflows");
  if (!hasInternalDB()) {
    throw new ApprovalError("Internal database required for approval rules.", "validation");
  }

  validateRuleInput(input);

  const rows = await internalQuery<ApprovalRuleRow>(
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
  );

  if (rows.length === 0) {
    throw new ApprovalError("Failed to create approval rule.", "validation");
  }

  log.info({ orgId, ruleId: rows[0].id, ruleType: input.ruleType, pattern: input.pattern }, "Approval rule created");
  const rule = rowToRule(rows[0]);
  if (!rule) throw new ApprovalError(`Created rule has unexpected rule_type "${rows[0].rule_type}" after insert.`, "conflict");
  return rule;
}

/** Update an existing approval rule. */
export async function updateApprovalRule(
  orgId: string,
  ruleId: string,
  input: UpdateApprovalRuleRequest,
): Promise<ApprovalRule> {
  requireEnterprise("approval-workflows");
  if (!hasInternalDB()) {
    throw new ApprovalError("Internal database required for approval rules.", "validation");
  }

  // Check the rule exists
  const existing = await getApprovalRule(orgId, ruleId);
  if (!existing) {
    throw new ApprovalError(`Approval rule "${ruleId}" not found.`, "not_found");
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 3; // $1 = orgId, $2 = ruleId

  if (input.name !== undefined) {
    if (input.name.trim().length === 0) {
      throw new ApprovalError("Rule name cannot be empty.", "validation");
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

  const rows = await internalQuery<ApprovalRuleRow>(
    `UPDATE approval_rules SET ${sets.join(", ")} WHERE org_id = $1 AND id = $2
     RETURNING id, org_id, name, rule_type, pattern, threshold, enabled, created_at, updated_at`,
    [orgId, ruleId, ...params],
  );

  if (rows.length === 0) {
    throw new ApprovalError(`Approval rule "${ruleId}" not found.`, "not_found");
  }

  log.info({ orgId, ruleId }, "Approval rule updated");
  const rule = rowToRule(rows[0]);
  if (!rule) throw new ApprovalError(`Updated rule has unexpected rule_type "${rows[0].rule_type}" after update.`, "conflict");
  return rule;
}

/** Delete an approval rule. Returns true if deleted, false if not found. */
export async function deleteApprovalRule(orgId: string, ruleId: string): Promise<boolean> {
  requireEnterprise("approval-workflows");
  if (!hasInternalDB()) return false;

  const rows = await internalQuery<{ id: string }>(
    `DELETE FROM approval_rules WHERE org_id = $1 AND id = $2 RETURNING id`,
    [orgId, ruleId],
  );
  if (rows.length > 0) {
    log.info({ orgId, ruleId }, "Approval rule deleted");
    return true;
  }
  return false;
}

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
 * `{ required: false }` instead of throwing. Unexpected errors from the
 * enterprise check are re-thrown to avoid silently bypassing governance.
 */
export async function checkApprovalRequired(
  orgId: string | undefined,
  tablesAccessed: string[],
  columnsAccessed: string[],
): Promise<ApprovalMatchResult> {
  if (!orgId || !hasInternalDB()) {
    return { required: false, matchedRules: [] };
  }

  // Check if enterprise is enabled — re-throw unexpected errors
  try {
    requireEnterprise("approval-workflows");
  } catch (err) {
    if (err instanceof EnterpriseError) {
      return { required: false, matchedRules: [] };
    }
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err: msg }, "Unexpected error checking enterprise status in approval check — re-throwing");
    throw err;
  }

  const rows = await internalQuery<ApprovalRuleRow>(
    `SELECT id, org_id, name, rule_type, pattern, threshold, enabled, created_at, updated_at
     FROM approval_rules
     WHERE org_id = $1 AND enabled = true`,
    [orgId],
  );

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
}

// ── Queue management ────────────────────────────────────────────────

/** Create an approval request (queue a query for review). */
export async function createApprovalRequest(opts: {
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
}): Promise<ApprovalRequest> {
  requireEnterprise("approval-workflows");
  if (!hasInternalDB()) {
    throw new ApprovalError("Internal database required for approval queue.", "validation");
  }

  const expiryHours = getExpiryHours();

  const rows = await internalQuery<ApprovalQueueRow>(
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
  );

  if (rows.length === 0) {
    throw new ApprovalError("Failed to create approval request.", "validation");
  }

  log.info({ orgId: opts.orgId, requestId: rows[0].id, ruleId: opts.ruleId }, "Approval request created");
  const request = rowToRequest(rows[0]);
  if (!request) throw new ApprovalError(`Created request has unexpected status "${rows[0].status}" after insert.`, "conflict");
  return request;
}

/** List approval requests for an organization, optionally filtered by status. */
export async function listApprovalRequests(
  orgId: string,
  status?: ApprovalStatus,
  limit = 100,
  offset = 0,
): Promise<ApprovalRequest[]> {
  requireEnterprise("approval-workflows");
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

  const rows = await internalQuery<ApprovalQueueRow>(sql, params);
  return rows.map(rowToRequest).filter((r): r is ApprovalRequest => r !== null);
}

/** Get a single approval request by ID. */
export async function getApprovalRequest(
  orgId: string,
  requestId: string,
): Promise<ApprovalRequest | null> {
  requireEnterprise("approval-workflows");
  if (!hasInternalDB()) return null;

  const rows = await internalQuery<ApprovalQueueRow>(
    `SELECT id, org_id, rule_id, rule_name, requester_id, requester_email, query_sql,
       explanation, connection_id, tables_accessed, columns_accessed, status,
       reviewer_id, reviewer_email, review_comment, reviewed_at, created_at, expires_at
     FROM approval_queue
     WHERE org_id = $1 AND id = $2
     LIMIT 1`,
    [orgId, requestId],
  );
  if (rows.length === 0) return null;
  const request = rowToRequest(rows[0]);
  if (!request) {
    log.warn({ orgId, requestId, status: rows[0].status }, "Approval request found but has invalid status — treating as corrupt");
    throw new ApprovalError(
      `Approval request "${requestId}" exists but has an invalid status "${rows[0].status}".`,
      "validation",
    );
  }
  return request;
}

/** Approve or deny an approval request. */
export async function reviewApprovalRequest(
  orgId: string,
  requestId: string,
  reviewerId: string,
  reviewerEmail: string | null,
  action: "approve" | "deny",
  comment?: string,
): Promise<ApprovalRequest> {
  requireEnterprise("approval-workflows");
  if (!hasInternalDB()) {
    throw new ApprovalError("Internal database required for approval queue.", "validation");
  }

  // Fetch the current request
  const existing = await getApprovalRequest(orgId, requestId);
  if (!existing) {
    throw new ApprovalError(`Approval request "${requestId}" not found.`, "not_found");
  }

  if (existing.status !== "pending") {
    throw new ApprovalError(
      `Cannot ${action} request — current status is "${existing.status}".`,
      "conflict",
    );
  }

  // Prevent self-approval — the requester cannot approve their own request
  if (existing.requesterId === reviewerId) {
    throw new ApprovalError(
      "Cannot review your own approval request. A different admin must approve or deny it.",
      "conflict",
    );
  }

  // Check if expired
  if (new Date(existing.expiresAt) < new Date()) {
    // Auto-expire it
    await internalQuery(
      `UPDATE approval_queue SET status = 'expired' WHERE id = $1`,
      [requestId],
    );
    throw new ApprovalError("Approval request has expired.", "expired");
  }

  const newStatus: ApprovalStatus = action === "approve" ? "approved" : "denied";

  const rows = await internalQuery<ApprovalQueueRow>(
    `UPDATE approval_queue
     SET status = $3, reviewer_id = $4, reviewer_email = $5, review_comment = $6, reviewed_at = now()
     WHERE org_id = $1 AND id = $2 AND status = 'pending'
     RETURNING id, org_id, rule_id, rule_name, requester_id, requester_email, query_sql,
       explanation, connection_id, tables_accessed, columns_accessed, status,
       reviewer_id, reviewer_email, review_comment, reviewed_at, created_at, expires_at`,
    [orgId, requestId, newStatus, reviewerId, reviewerEmail, comment ?? null],
  );

  if (rows.length === 0) {
    throw new ApprovalError(`Approval request "${requestId}" not found or already reviewed.`, "conflict");
  }

  log.info(
    { orgId, requestId, action, reviewerId },
    `Approval request ${action === "approve" ? "approved" : "denied"}`,
  );
  const request = rowToRequest(rows[0]);
  if (!request) throw new ApprovalError(`Reviewed request has unexpected status "${rows[0].status}" after update.`, "conflict");
  return request;
}

/** Expire all stale pending requests across all orgs. Returns count of expired. */
export async function expireStaleRequests(): Promise<number> {
  if (!hasInternalDB()) return 0;

  try {
    requireEnterprise("approval-workflows");
  } catch (err) {
    if (err instanceof EnterpriseError) {
      return 0;
    }
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err: msg }, "Unexpected error checking enterprise status in expireStaleRequests — re-throwing");
    throw err;
  }

  const rows = await internalQuery<{ id: string }>(
    `UPDATE approval_queue
     SET status = 'expired'
     WHERE status = 'pending' AND expires_at < now()
     RETURNING id`,
  );

  if (rows.length > 0) {
    log.info({ count: rows.length }, "Expired stale approval requests");
  }
  return rows.length;
}

/** Get count of pending approval requests for an organization. */
export async function getPendingCount(orgId: string): Promise<number> {
  if (!hasInternalDB()) return 0;

  try {
    requireEnterprise("approval-workflows");
  } catch (err) {
    if (err instanceof EnterpriseError) {
      return 0;
    }
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err: msg }, "Unexpected error checking enterprise status in getPendingCount — re-throwing");
    throw err;
  }

  const rows = await internalQuery<{ count: string }>(
    `SELECT COUNT(*) as count FROM approval_queue
     WHERE org_id = $1 AND status = 'pending' AND expires_at > now()`,
    [orgId],
  );

  return rows.length > 0 ? Number(rows[0].count) : 0;
}

/**
 * Check whether a query already has an approved request for a given user.
 * Used by the SQL interception to allow re-execution of approved queries.
 * Returns true if an approved request exists for this exact query text.
 *
 * Returns false when enterprise is disabled — stale approved records from a
 * previously-enabled enterprise license should not grant query access.
 * Unexpected errors are re-thrown to avoid silently bypassing governance.
 */
export async function hasApprovedRequest(
  orgId: string,
  requesterId: string,
  querySql: string,
): Promise<boolean> {
  if (!hasInternalDB()) return false;

  try {
    requireEnterprise("approval-workflows");
  } catch (err) {
    if (err instanceof EnterpriseError) return false;
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err: msg }, "Unexpected error checking enterprise status in hasApprovedRequest — re-throwing");
    throw err;
  }

  const rows = await internalQuery<{ id: string }>(
    `SELECT id FROM approval_queue
     WHERE org_id = $1 AND requester_id = $2 AND query_sql = $3 AND status = 'approved'
     LIMIT 1`,
    [orgId, requesterId, querySql],
  );

  return rows.length > 0;
}
