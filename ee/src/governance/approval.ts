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

import { Effect, Layer } from "effect";
import { requireEnterpriseEffect } from "../index";
import { EnterpriseError } from "@atlas/api/lib/effect/errors";
import { requireInternalDBEffect } from "../lib/db-guard";
import {
  hasInternalDB,
  internalQuery,
  queryEffect,
} from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import type {
  ApprovalRule,
  ApprovalRuleType,
  ApprovalRuleSurface,
  ApprovalRequest,
  ApprovalRequestSurface,
  ApprovalStatus,
  CreateApprovalRuleRequest,
  UpdateApprovalRuleRequest,
} from "@useatlas/types";
import {
  APPROVAL_RULE_TYPES,
  APPROVAL_RULE_SURFACES,
  APPROVAL_REQUEST_SURFACES,
  APPROVAL_STATUSES,
} from "@useatlas/types";
import {
  ApprovalGate,
  type ApprovalGateShape,
} from "@atlas/api/lib/effect/services";
import {
  ApprovalError,
  type ApprovalErrorCode,
} from "@atlas/api/lib/governance/errors";

const log = createLogger("ee:approval-workflows");

// ── Typed errors ────────────────────────────────────────────────────

/**
 * `ApprovalError` lives in `@atlas/api/lib/governance/errors` post-#2567
 * so the `ApprovalGate` Tag can type its failure channels without core
 * importing from `@atlas/ee`. Re-exported here for back-compat — same
 * `_tag` + payload shape + `instanceof` semantics.
 */
export { ApprovalError, type ApprovalErrorCode };

// ── Internal row shapes ─────────────────────────────────────────────

interface ApprovalRuleRow {
  id: string;
  org_id: string;
  name: string;
  rule_type: string;
  pattern: string;
  threshold: number | null;
  enabled: boolean;
  /** #2072 — surface scope. Defaults to 'any' via the migration. */
  surface: string;
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
  /** #2344 — group scope. NULL for legacy rows and for callers without a group context. */
  connection_group_id: string | null;
  tables_accessed: string | null;
  columns_accessed: string | null;
  status: string;
  reviewer_id: string | null;
  reviewer_email: string | null;
  review_comment: string | null;
  reviewed_at: string | null;
  /** #2072 — origin surface stamped at request creation. NULL for legacy. */
  surface: string | null;
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

function isValidRuleSurface(surface: string): surface is ApprovalRuleSurface {
  return (APPROVAL_RULE_SURFACES as readonly string[]).includes(surface);
}

function isValidRequestSurface(surface: string): surface is ApprovalRequestSurface {
  return (APPROVAL_REQUEST_SURFACES as readonly string[]).includes(surface);
}

const mirrorGlobalConnectionGroupForTenantSql = `INSERT INTO connection_groups (id, org_id, name)
SELECT g.id, $1, ('__global__:' || g.id) AS name
  FROM connections c
  JOIN connection_groups g
    ON g.id = c.group_id
   AND g.org_id = c.org_id
 WHERE c.id = $2
   AND c.org_id = '__global__'
   AND c.group_id IS NOT NULL
ON CONFLICT (id, org_id) DO NOTHING`;

const mirrorExplicitGlobalGroupForTenantSql = `INSERT INTO connection_groups (id, org_id, name)
SELECT id, $1, ('__global__:' || id) AS name
  FROM connection_groups
 WHERE id = $2
   AND org_id = '__global__'
ON CONFLICT (id, org_id) DO NOTHING`;

function rowToRule(row: ApprovalRuleRow): ApprovalRule | null {
  if (!isValidRuleType(row.rule_type)) {
    log.warn({ ruleId: row.id, ruleType: row.rule_type }, "Approval rule has unexpected rule_type in database — skipping rule");
    return null;
  }
  // #2072: fail-closed-strict on surface drift. The column is NOT NULL
  // with DEFAULT 'any' post-0052, so a NULL/missing read indicates
  // schema drift (partial restore, hand-rolled migration, ORM
  // misbehavior). Coercing to 'any' would silently broaden a surface-
  // scoped rule that an admin authored to ALL surfaces — exactly the
  // governance bypass shape this column exists to prevent. Drop the
  // row instead so the operator sees the warning and the missing rule.
  if (typeof row.surface !== "string") {
    log.warn({ ruleId: row.id }, "Approval rule has missing/null surface in database — schema drift, skipping rule");
    return null;
  }
  if (!isValidRuleSurface(row.surface)) {
    log.warn({ ruleId: row.id, surface: row.surface }, "Approval rule has unexpected surface in database — skipping rule");
    return null;
  }
  const surfaceValue = row.surface;
  const base = {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    enabled: row.enabled,
    surface: surfaceValue,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
  // The discriminated union (#1660) requires each variant constructed
  // explicitly so TypeScript narrows `pattern`/`threshold` against the
  // chosen `ruleType`. Legacy rows with the wrong nullness for their
  // type are treated as corrupt and dropped with a warning.
  if (row.rule_type === "cost") {
    if (row.threshold == null) {
      log.warn({ ruleId: row.id }, "Cost rule missing threshold in database — skipping rule");
      return null;
    }
    return { ...base, ruleType: "cost", threshold: row.threshold, pattern: "" };
  }
  return { ...base, ruleType: row.rule_type, pattern: row.pattern, threshold: null };
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
  // #2072: surface on a queued row is request-side (no 'any'). Drop on
  // unknown values rather than coerce — a corrupt surface column means
  // the audit dimension would silently mis-bucket reports.
  let surface: ApprovalRequestSurface | null = null;
  if (row.surface !== null && row.surface !== undefined) {
    if (!isValidRequestSurface(row.surface)) {
      log.warn({ requestId: row.id, surface: row.surface }, "Approval request has unexpected surface in database — skipping request");
      return null;
    }
    surface = row.surface;
  }
  const base = {
    id: row.id,
    orgId: row.org_id,
    ruleId: row.rule_id,
    ruleName: row.rule_name,
    requesterId: row.requester_id,
    requesterEmail: row.requester_email,
    querySql: row.query_sql,
    explanation: row.explanation,
    connectionId: null,
    // #2344 — undefined-tolerant access guards the in-memory test
    // fixtures (`makeQueueRow` in approval.test.ts predates the
    // column). Real DB rows always carry the column post-0065 — the
    // missing-column case is purely a unit-test convenience.
    connectionGroupId: row.connection_group_id ?? null,
    tablesAccessed: parseJsonArray(row.tables_accessed),
    columnsAccessed: parseJsonArray(row.columns_accessed),
    surface,
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
  };
  // Variant construction (#1660): approved/denied rows must carry reviewer
  // metadata; pending/expired rows must not. A row stored with an invalid
  // combination (e.g. status='pending' with reviewer_id populated) is
  // treated as corrupt and dropped. The route layer's schema parse would
  // fail on the same record; surfacing the warning here gives operators a
  // log breadcrumb.
  if (row.status === "approved" || row.status === "denied") {
    if (!row.reviewer_id || !row.reviewed_at) {
      log.warn(
        { requestId: row.id, status: row.status },
        "Approval request in reviewed status is missing reviewer metadata — skipping request",
      );
      return null;
    }
    return {
      ...base,
      status: row.status,
      reviewerId: row.reviewer_id,
      reviewerEmail: row.reviewer_email,
      reviewComment: row.review_comment,
      reviewedAt: String(row.reviewed_at),
    };
  }
  // pending / expired
  return {
    ...base,
    status: row.status,
    reviewerId: null,
    reviewerEmail: null,
    reviewComment: null,
    reviewedAt: null,
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
  // ruleType is narrowed by the discriminated union (#1660); runtime check
  // still covers wire-layer inputs that bypass the route Zod (e.g. direct
  // test usage) — those paths receive a string that TS has already typed.
  if (!isValidRuleType(input.ruleType as string)) {
    return Effect.fail(new ApprovalError({ message: `Invalid rule type "${input.ruleType as string}". Supported: ${APPROVAL_RULE_TYPES.join(", ")}`, code: "validation" }));
  }
  // #2072 — surface is optional on create (defaults to 'any'). When
  // present, validate against the canonical enum so a typo can't reach
  // the DB CHECK constraint as a 500.
  if (input.surface !== undefined && !isValidRuleSurface(input.surface as string)) {
    return Effect.fail(new ApprovalError({
      message: `Invalid surface "${input.surface as string}". Supported: ${APPROVAL_RULE_SURFACES.join(", ")}`,
      code: "validation",
    }));
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

// #2344 — single source of truth for the approval_queue projection so
// SELECT, RETURNING (insert), and RETURNING (update) all carry the
// new `connection_group_id` column without drifting from each other.
// Drift was the exact #2191-class regression PR review caught on the
// surface column rollout; centralizing here keeps the three sites in
// lockstep.
const APPROVAL_QUEUE_COLUMNS = `id, org_id, rule_id, rule_name, requester_id, requester_email, query_sql,
  explanation, connection_group_id, tables_accessed, columns_accessed, status,
  reviewer_id, reviewer_email, review_comment, reviewed_at, surface, created_at, expires_at`;

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
      `SELECT id, org_id, name, rule_type, pattern, threshold, enabled, surface, created_at, updated_at
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
      `SELECT id, org_id, name, rule_type, pattern, threshold, enabled, surface, created_at, updated_at
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
      `INSERT INTO approval_rules (org_id, name, rule_type, pattern, threshold, enabled, surface)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, org_id, name, rule_type, pattern, threshold, enabled, surface, created_at, updated_at`,
      [
        orgId,
        input.name.trim(),
        input.ruleType,
        // Discriminated union guarantees pattern for table/column and empty for cost.
        input.ruleType === "cost" ? "" : input.pattern.trim(),
        input.ruleType === "cost" ? input.threshold : null,
        input.enabled ?? true,
        // #2072 — default 'any' preserves pre-2072 fires-everywhere behavior.
        input.surface ?? "any",
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
      idx++;
    }
    if (input.surface !== undefined) {
      // #2072 — validate before writing so a typo doesn't reach the DB
      // CHECK as a 500 with no diagnostic for the admin.
      if (!isValidRuleSurface(input.surface as string)) {
        return yield* Effect.fail(new ApprovalError({
          message: `Invalid surface "${input.surface as string}". Supported: ${APPROVAL_RULE_SURFACES.join(", ")}`,
          code: "validation",
        }));
      }
      sets.push(`surface = $${idx}`);
      params.push(input.surface);
    }

    if (sets.length === 0) {
      return existing; // Nothing to update
    }

    sets.push("updated_at = now()");

    const rows = yield* Effect.promise(() => internalQuery<ApprovalRuleRow>(
      `UPDATE approval_rules SET ${sets.join(", ")} WHERE org_id = $1 AND id = $2
       RETURNING id, org_id, name, rule_type, pattern, threshold, enabled, surface, created_at, updated_at`,
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
  /**
   * Set when `checkApprovalRequired` was invoked with neither `orgId` nor
   * `requesterId` and at least one approval rule exists somewhere in the
   * database. Callers (`lib/tools/sql.ts`) treat this as a hard block —
   * running the query would silently bypass governance because no caller
   * has bound any context at all. A bound `requesterId` without `orgId`
   * (demo / single-user mode) does NOT set this flag and falls through to
   * `required: false`. F-54 / F-55 defensive belt-and-suspenders.
   */
  identityMissing?: boolean;
}

/**
 * Sentinel rule used to surface "approval gate active but no requester
 * identity" through the existing `required: true` path. The caller's
 * user-identity check then short-circuits with a clear error instead of
 * silently executing.
 */
const IDENTITY_MISSING_RULE: ApprovalRule = {
  id: "__identity_missing__",
  orgId: "__unknown__",
  name: "missing-requester-identity",
  ruleType: "table",
  pattern: "*",
  threshold: null,
  enabled: true,
  // 'any' on the sentinel — this is the fail-closed shape and must fire
  // regardless of which surface the unidentified caller came from.
  surface: "any",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

/**
 * Returns true when at least one enabled approval rule exists in the
 * database, regardless of org. Used as a defensive check when an agent
 * invocation arrives without an `orgId` — the previous behaviour
 * (`checkApprovalRequired(undefined, …) → { required: false }`) silently
 * bypassed governance for any caller that forgot to bind a user.
 */
export const anyApprovalRuleEnabled = (): Effect.Effect<boolean, never> =>
  Effect.gen(function* () {
    if (!hasInternalDB()) return false;
    return yield* Effect.tryPromise({
      try: () =>
        internalQuery<{ exists: number }>(
          `SELECT 1 AS exists FROM approval_rules WHERE enabled = true LIMIT 1`,
          [],
        ),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    }).pipe(Effect.map((rows) => rows.length > 0));
  }).pipe(
    Effect.catchAll((err: Error) => {
      log.warn(
        { err: err.message },
        "anyApprovalRuleEnabled lookup failed — assuming rules exist (fail-closed)",
      );
      // Fail-closed: when we can't tell, assume rules exist so the caller
      // blocks anonymous queries. The alternative (assuming none) is the
      // exact silent-bypass shape this defensive check exists to prevent.
      return Effect.succeed(true);
    }),
  );

/**
 * Check whether a query requires approval based on the org's rules.
 * Matches validated SQL classification (tables/columns) against enabled rules.
 *
 * This function gracefully degrades when enterprise is disabled, returning
 * `{ required: false }` instead of throwing. Only `EnterpriseError` is
 * caught — unexpected errors propagate to avoid silently bypassing governance.
 *
 * F-54 / F-55 defensive: when called with neither `orgId` nor `requesterId`
 * while any rule exists in the database, returns `{ required: true,
 * identityMissing: true }` with a sentinel rule so the caller's user-
 * identity gate fires. This closes the silent-bypass that scheduler /
 * chat-platform paths used to hit before they were retrofitted to bind a
 * user. A bound `requesterId` without `orgId` (demo / single-user mode) is
 * an explicit "this caller has a user but no org" signal and falls
 * through to `required: false` — there's nothing for an org-scoped rule
 * to match against, so the gate has nothing to do.
 */
export const checkApprovalRequired = (
  orgId: string | undefined,
  tablesAccessed: string[],
  columnsAccessed: string[],
  options?: {
    requesterId?: string | undefined;
    /**
     * #2072 — origin surface stamped by the calling route. The SQL filter
     * applies `surface = $surface OR surface = 'any'`; passing `undefined`
     * (legacy / unstamped routes) only fires `'any'` rules, which is the
     * fail-closed shape — a route that forgets to stamp surface can't
     * accidentally trip surface-scoped rules.
     */
    surface?: ApprovalRequestSurface | undefined;
  },
): Effect.Effect<ApprovalMatchResult, never> =>
  Effect.gen(function* () {
    if (!hasInternalDB()) {
      return { required: false, matchedRules: [] };
    }

    if (!orgId) {
      // No org context. If the caller has bound a user (demo, single-user
      // mode), pass through cleanly — no rule can match an unbound org and
      // the operator made the no-org choice deliberately. If the caller
      // has bound NEITHER an org NOR a user, it's the scheduler / chat-
      // platform / MCP shape: fail closed via `identityMissing` so the
      // caller's user-identity gate (lib/tools/sql.ts) returns a clear
      // "approve via the Atlas web app" error instead of the previous
      // silent bypass.
      if (options?.requesterId) {
        return { required: false, matchedRules: [] };
      }
      const ruleExists = yield* anyApprovalRuleEnabled();
      if (ruleExists) {
        log.warn(
          {},
          "checkApprovalRequired called with neither orgId nor requesterId while rules exist — failing closed",
        );
        return {
          required: true,
          matchedRules: [IDENTITY_MISSING_RULE],
          identityMissing: true,
        };
      }
      return { required: false, matchedRules: [] };
    }

    yield* requireEnterpriseEffect("approval-workflows");

    // #2072 — surface filter pushed into the SQL: rules pinned to a
    // specific surface only fetch when the request stamped that surface.
    // `surface = $2 OR surface = 'any'` with `$2 IS NULL` still fires
    // 'any' rules (NULL = 'any' is false in three-valued logic) — that's
    // the desired pre-2072 backwards-compat shape. The
    // `idx_approval_rules_org_surface` index covers both branches.
    const requestSurface: string | null = options?.surface ?? null;
    const rows = yield* Effect.promise(() => internalQuery<ApprovalRuleRow>(
      `SELECT id, org_id, name, rule_type, pattern, threshold, enabled, surface, created_at, updated_at
       FROM approval_rules
       WHERE org_id = $1 AND enabled = true AND (surface = 'any' OR surface = $2)`,
      [orgId, requestSurface],
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
    // `catchIf` (not `catchAll`) — only the "enterprise disabled" failure
    // should degrade to "approval not required"; a transient DB error
    // must bubble so the route returns 500 instead of silently bypassing
    // governance. See CLAUDE.md: `catch { return false }` on a security
    // check is a bug, not a safe default.
    Effect.catchIf(
      (err): err is EnterpriseError => err instanceof EnterpriseError,
      (err) => {
        log.debug({ err: err.message }, "Approval check skipped — enterprise not enabled");
        return Effect.succeed({ required: false, matchedRules: [] as ApprovalRule[] });
      },
    ),
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
  /**
   * Originating connection id. Nullable post-#2344 — the lookup keys
   * on {@link connectionGroupId}; this column survives as the audit
   * trail for which member submitted the request.
   */
  connectionId: string | null;
  /**
   * #2344 — group scope. When provided, stored verbatim. When omitted
   * and a `connectionId` is given, the INSERT resolves the group
   * inline via a scalar subquery against `connections.group_id`
   * (mirrors `inlineConnectionGroupSql` in semantic/entities.ts). When
   * neither is provided, the row carries NULL and is only eligible for
   * the legacy 3-arg unscoped lookup path.
   */
  connectionGroupId?: string | null;
  tablesAccessed: string[];
  columnsAccessed: string[];
  /**
   * #2072 — origin surface stamped on the queued row for audit. Optional
   * because legacy callers (and tests pinned to the old shape) don't
   * stamp it; missing surface stores NULL and renders as "unknown
   * origin" in admin reports.
   */
  surface?: ApprovalRequestSurface | null;
}): Effect.Effect<ApprovalRequest, ApprovalError | EnterpriseError | Error> =>
  Effect.gen(function* () {
    yield* requireEnterpriseEffect("approval-workflows");
    yield* requireInternalDBEffect("approval queue", () => new ApprovalError({ message: "Internal database required for approval queue.", code: "validation" }));

    // F-54/F-55 defense-in-depth: refuse to insert any row whose ruleId or
    // orgId smells like an internal sentinel. The `__identity_missing__`
    // rule + `__unknown__` org are produced by the defensive identityMissing
    // path and are intercepted by the user-identity gate in
    // `lib/tools/sql.ts` before this function is ever called. A future
    // refactor that swapped the order of those checks would silently insert
    // a sentinel row into `approval_queue` and present operators with a
    // request whose rule_id has no FK target. Fail loud here so the bug
    // shows up in the run log instead of the queue.
    if (opts.ruleId.startsWith("__") || opts.orgId.startsWith("__")) {
      log.error(
        { ruleId: opts.ruleId, orgId: opts.orgId, requesterId: opts.requesterId },
        "createApprovalRequest received a sentinel ruleId/orgId — refusing to queue",
      );
      return yield* Effect.fail(new ApprovalError({
        message: "createApprovalRequest received a sentinel rule or org id — caller did not gate on identityMissing",
        code: "validation",
      }));
    }

    const expiryHours = getExpiryHours();

    // #2072 — defensive validation. The DB CHECK enforces this too, but
    // surfacing the bad input as a typed ApprovalError beats a 500 from
    // the SQL layer with no diagnostic for the caller.
    if (opts.surface != null && !isValidRequestSurface(opts.surface as string)) {
      return yield* Effect.fail(new ApprovalError({
        message: `Invalid request surface "${opts.surface as string}". Supported: ${APPROVAL_REQUEST_SURFACES.join(", ")}`,
        code: "validation",
      }));
    }

    // #2344 — branch on whether the caller passed a group id verbatim.
    // Inline shape: when omitted but a connectionId is present, resolve
    // the group via a scalar subquery against `connections` in the
    // same INSERT — no SELECT-then-INSERT race with concurrent
    // connection deletes. Matches the resolution rule in
    // `semantic/entities.ts: inlineConnectionGroupSql`: prefer the
    // org's own connection row, fall back to `__global__` for demo /
    // built-in connections.
    const hasExplicitGroup = opts.connectionGroupId !== undefined;
    const hasConnectionForResolve = !hasExplicitGroup && opts.connectionId !== null && opts.connectionId !== undefined;
    const groupExpression = hasExplicitGroup
      ? "$8"
      : hasConnectionForResolve
        ? `(
            SELECT group_id FROM connections
            WHERE id = $8
              AND (org_id = $1 OR org_id = '__global__')
            ORDER BY CASE WHEN org_id = $1 THEN 0 ELSE 1 END
            LIMIT 1
          )`
        : "NULL";
    const groupParam: string | null = hasExplicitGroup
      ? (opts.connectionGroupId ?? null)
      : hasConnectionForResolve
        ? (opts.connectionId as string)
        : null;

    // Global/demo connections live under `__global__`, while approval
    // rows are tenant-scoped. The composite FK on approval_queue requires
    // `(connection_group_id, org_id)` to exist in `connection_groups`, so
    // mirror the global group into the tenant before inserting the queue
    // row. This is idempotent and preserves the same group id that lookup
    // uses, without weakening cross-tenant FK protection.
    if (opts.connectionId !== null && opts.connectionId !== undefined) {
      yield* Effect.promise(() => internalQuery(
        mirrorGlobalConnectionGroupForTenantSql,
        [opts.orgId, opts.connectionId],
      ));
    }
    if (hasExplicitGroup && opts.connectionGroupId != null) {
      yield* Effect.promise(() => internalQuery(
        mirrorExplicitGlobalGroupForTenantSql,
        [opts.orgId, opts.connectionGroupId],
      ));
    }

    // Param ordering: $1..$7 stable; $8 carries either the explicit
    // group_id or (when resolving inline) the connection_id consumed by
    // the scalar subquery.
    const insertSql = `INSERT INTO approval_queue
         (org_id, rule_id, rule_name, requester_id, requester_email, query_sql, explanation,
          connection_group_id, tables_accessed, columns_accessed, surface, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, ${groupExpression}, $9, $10, $11, now() + make_interval(hours => $12))
       RETURNING ${APPROVAL_QUEUE_COLUMNS}`;

    const rows = yield* Effect.promise(() => internalQuery<ApprovalQueueRow>(
      insertSql,
      [
        opts.orgId,
        opts.ruleId,
        opts.ruleName,
        opts.requesterId,
        opts.requesterEmail,
        opts.querySql,
        opts.explanation,
        groupParam,
        JSON.stringify(opts.tablesAccessed),
        JSON.stringify(opts.columnsAccessed),
        opts.surface ?? null,
        expiryHours,
      ],
    ));

    if (rows.length === 0) {
      return yield* Effect.fail(new ApprovalError({ message: "Failed to create approval request.", code: "validation" }));
    }

    log.info(
      { orgId: opts.orgId, requestId: rows[0].id, ruleId: opts.ruleId, connectionGroupId: rows[0].connection_group_id },
      "Approval request created",
    );
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

    let sql = `SELECT ${APPROVAL_QUEUE_COLUMNS}
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
      `SELECT ${APPROVAL_QUEUE_COLUMNS}
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
       RETURNING ${APPROVAL_QUEUE_COLUMNS}`,
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

/**
 * Expire stale pending approval requests for the given org. Returns count of
 * expired rows.
 *
 * @security F-13 (security audit 1.2.3). `orgId` is required and the UPDATE
 * is scoped to that workspace's queue — removing either the parameter or
 * the `AND org_id = $1` clause reopens the cross-tenant-state-change bug.
 */
export const expireStaleRequests = (orgId: string): Effect.Effect<number, Error> =>
  Effect.gen(function* () {
    if (!hasInternalDB()) return 0;

    yield* requireEnterpriseEffect("approval-workflows");

    // queryEffect (not Effect.promise) so DB rejections surface in the typed
    // error channel — see `lib/db/internal.ts` for the rationale.
    const rows = yield* queryEffect<{ id: string }>(
      `UPDATE approval_queue
       SET status = 'expired'
       WHERE status = 'pending' AND expires_at < now() AND org_id = $1
       RETURNING id`,
      [orgId],
    );

    if (rows.length > 0) {
      log.info({ orgId, count: rows.length }, "Expired stale approval requests");
    }
    return rows.length;
  }).pipe(
    // `catchIf` over EnterpriseError — a DB outage must not look like "no
    // requests to expire"; let it surface as a defect so ops can spot it.
    Effect.catchIf(
      (err): err is EnterpriseError => err instanceof EnterpriseError,
      (err) => {
        log.debug({ err: err.message }, "Stale request expiration skipped — enterprise not enabled");
        return Effect.succeed(0);
      },
    ),
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
    // `catchIf` over EnterpriseError — a DB outage must not masquerade
    // as "zero pending approvals" (governance bypass surface); let it
    // propagate so the admin banner surfaces a real error.
    Effect.catchIf(
      (err): err is EnterpriseError => err instanceof EnterpriseError,
      (err) => {
        log.debug({ err: err.message }, "Pending count skipped — enterprise not enabled");
        return Effect.succeed(0);
      },
    ),
  );

/**
 * Check whether a query already has an approved request for a given user.
 * Used by the SQL interception to allow re-execution of approved queries.
 * Returns true if an approved request exists for this exact query text.
 *
 * #2344 — when `connectionId` is provided, the lookup resolves the
 * caller's `group_id` from `connections` and matches on
 * `connection_group_id`. One approval covers every member of the same
 * group running the same query — keying on connection forced re-
 * approval per replica even when an admin had already greenlit the
 * query for the group. Connections are required to belong to a group
 * after 0069; when the connection is archived / deleted and cannot be
 * resolved, no approval applies.
 *
 * The legacy 3-arg shape (`omit connectionId`) keeps the pre-#2344
 * unscoped match for callers that don't yet thread the connection
 * id. Used by the agent loop and the test harnesses; removed in a
 * follow-up slice once every caller carries a connection.
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
  connectionId?: string,
): Effect.Effect<boolean, never> =>
  Effect.gen(function* () {
    if (!hasInternalDB()) return false;

    yield* requireEnterpriseEffect("approval-workflows");

    // #2344 — legacy 3-arg shape preserves the pre-migration unscoped
    // lookup so the agent loop and the test harnesses that still call
    // through the old signature don't regress. The new branch only
    // engages when the caller supplies a connection — sql.ts does so;
    // a follow-up slice removes the legacy branch once every consumer
    // is migrated.
    if (connectionId === undefined) {
      const legacyRows = yield* Effect.promise(() => internalQuery<{ id: string }>(
        `SELECT id FROM approval_queue
         WHERE org_id = $1 AND requester_id = $2 AND query_sql = $3 AND status = 'approved'
         LIMIT 1`,
        [orgId, requesterId, querySql],
      ));
      return legacyRows.length > 0;
    }

    // #2344 — resolve the connection's group_id at lookup time.
    // Separate SELECT (not a joined CTE on `approval_queue`) so the
    // archived-connection case is a clean signal: the resolver
    // returning zero rows means the connection has been removed /
    // archived and no connection-scoped approval can safely apply.
    const groupRows = yield* Effect.promise(() => internalQuery<{ group_id: string | null }>(
      `SELECT group_id FROM connections
       WHERE id = $1 AND (org_id = $2 OR org_id = '__global__')
       ORDER BY CASE WHEN org_id = $2 THEN 0 ELSE 1 END
       LIMIT 1`,
      [connectionId, orgId],
    ));
    if (groupRows.length === 0) return false;

    const resolvedGroupId = groupRows[0]?.group_id ?? null;
    if (resolvedGroupId === null) return false;

    // Match approval rows whose group equals the resolved group. NULL-group
    // rows are handled by the connection-scoped branch above, because NULL
    // does not identify a shared environment group.
    const rows = yield* Effect.promise(() => internalQuery<{ id: string }>(
      `SELECT id FROM approval_queue
       WHERE org_id = $1
         AND requester_id = $2
         AND query_sql = $3
         AND status = 'approved'
         AND connection_group_id = $4
       LIMIT 1`,
      [orgId, requesterId, querySql, resolvedGroupId],
    ));

    return rows.length > 0;
  }).pipe(
    // `catchIf` over EnterpriseError — SQL-interception relies on this
    // check. A DB outage returning `false` would force every query back
    // through fresh approval (annoying) — and worse, a DB outage
    // returning `true` (if the query ever drifted that way) would grant
    // access. Only the "enterprise off" path degrades; everything else
    // is a defect.
    Effect.catchIf(
      (err): err is EnterpriseError => err instanceof EnterpriseError,
      (err) => {
        log.debug({ err: err.message }, "Approved request check skipped — enterprise not enabled");
        return Effect.succeed(false);
      },
    ),
  );

// ── Tag wiring (#2567 — slice 5/11 of #2017) ─────────────────────────
//
// Bridges this module's functions into the `ApprovalGate` Tag so core
// call sites (`lib/tools/sql.ts`, `api/routes/admin-approval.ts`) can
// `yield* ApprovalGate` instead of dynamic-importing this module.
// Aggregated into `ee/src/layers.ts:EELayer`; the no-op default in
// `lib/effect/services.ts:NoopApprovalGateLayer` covers self-hosted
// installs (returns `{ required: false }` so queries bypass the gate).

export const makeApprovalGateLive = (): ApprovalGateShape => ({
  available: true,
  checkApprovalRequired,
  hasApprovedRequest,
  createApprovalRequest,
  listApprovalRules,
  createApprovalRule,
  updateApprovalRule,
  deleteApprovalRule,
  listApprovalRequests,
  getApprovalRequest,
  reviewApprovalRequest,
  expireStaleRequests,
  getPendingCount,
});

export const ApprovalGateLive: Layer.Layer<ApprovalGate> = Layer.sync(
  ApprovalGate,
  makeApprovalGateLive,
);
