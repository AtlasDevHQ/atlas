/**
 * Column masking for PII-tagged query results.
 *
 * Applies masking to query result rows based on:
 * 1. PII classifications stored in the internal DB (per-org)
 * 2. User role (admin sees raw, analyst sees partial, viewer sees full mask)
 * 3. Per-column masking strategy (configurable via admin UI)
 *
 * Integration: called from `packages/api/src/lib/tools/sql.ts` after query
 * execution, before results are returned to the agent/user.
 *
 * All mutating operations (saving classifications) call `requireEnterpriseEffect`.
 * The masking check itself (`applyMasking`) fails open when enterprise is
 * disabled — non-enterprise deployments get unmasked results.
 *
 * All exported functions return Effect — callers use `yield*` in Effect.gen.
 */

import { Effect } from "effect";
import { EEError } from "../lib/errors";
import { isEnterpriseEnabled } from "../index";
import { requireEnterpriseEffect, EnterpriseError } from "../index";
import {
  hasInternalDB,
  internalQuery,
} from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import type {
  PIICategory,
  PIIConfidence,
  PIIColumnClassification,
  MaskingStrategy,
  MaskingRole,
  UpdatePIIClassificationRequest,
} from "@useatlas/types";
import { PII_CATEGORIES, MASKING_STRATEGIES } from "@useatlas/types";
import { createHash } from "crypto";

const log = createLogger("ee:compliance");

// ── Typed errors ────────────────────────────────────────────────

export type ComplianceErrorCode = "validation" | "not_found" | "conflict";

export class ComplianceError extends EEError<ComplianceErrorCode> {
  readonly name = "ComplianceError";
}

// ── Table management ────────────────────────────────────────────

const TABLE_NAME = "pii_column_classifications";

const ensureTable = (): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    if (!hasInternalDB()) return;
    yield* Effect.tryPromise({
      try: () => internalQuery(`
        CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
          id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
          org_id TEXT NOT NULL,
          table_name TEXT NOT NULL,
          column_name TEXT NOT NULL,
          connection_id TEXT NOT NULL DEFAULT 'default',
          category TEXT NOT NULL,
          confidence TEXT NOT NULL DEFAULT 'medium',
          masking_strategy TEXT NOT NULL DEFAULT 'partial',
          reviewed BOOLEAN NOT NULL DEFAULT false,
          dismissed BOOLEAN NOT NULL DEFAULT false,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE(org_id, table_name, column_name, connection_id)
        )
      `),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    });
  });

let _tableReady = false;
const ready = (): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (!hasInternalDB()) return false;
    if (_tableReady) return true;
    return yield* ensureTable().pipe(
      Effect.map(() => {
        _tableReady = true;
        return true;
      }),
      Effect.catchAll((err) => {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "Failed to ensure PII classifications table",
        );
        return Effect.succeed(false);
      }),
    );
  });

// ── Internal row shape ──────────────────────────────────────────

interface PIIClassificationRow {
  id: string;
  org_id: string;
  table_name: string;
  column_name: string;
  connection_id: string;
  category: string;
  confidence: string;
  masking_strategy: string;
  reviewed: boolean;
  dismissed: boolean;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

function rowToClassification(row: PIIClassificationRow): PIIColumnClassification {
  return {
    id: row.id,
    orgId: row.org_id,
    tableName: row.table_name,
    columnName: row.column_name,
    connectionId: row.connection_id,
    category: row.category as PIICategory,
    confidence: row.confidence as PIIConfidence,
    maskingStrategy: row.masking_strategy as MaskingStrategy,
    reviewed: row.reviewed,
    dismissed: row.dismissed,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── CRUD operations (enterprise-gated) ──────────────────────────

export const listPIIClassifications = (
  orgId: string | undefined,
  connectionId?: string,
): Effect.Effect<PIIColumnClassification[], EnterpriseError> =>
  Effect.gen(function* () {
    yield* requireEnterpriseEffect("pii-detection");
    if (!(yield* ready())) return [];

    let sql = `SELECT * FROM ${TABLE_NAME} WHERE dismissed = false`;
    const params: unknown[] = [];

    if (orgId) {
      params.push(orgId);
      sql += ` AND org_id = $${params.length}`;
    }
    if (connectionId) {
      params.push(connectionId);
      sql += ` AND connection_id = $${params.length}`;
    }
    sql += " ORDER BY table_name, column_name";

    const rows = yield* Effect.promise(() => internalQuery<PIIClassificationRow>(sql, params));
    return rows.map(rowToClassification);
  });

export const savePIIClassification = (
  orgId: string,
  tableName: string,
  columnName: string,
  connectionId: string,
  category: PIICategory,
  confidence: PIIConfidence,
  maskingStrategy: MaskingStrategy = "partial",
): Effect.Effect<PIIColumnClassification, ComplianceError | EnterpriseError> =>
  Effect.gen(function* () {
    yield* requireEnterpriseEffect("pii-detection");
    if (!(yield* ready())) {
      return yield* Effect.fail(new ComplianceError("Internal database not available", "validation"));
    }

    validateCategory(category);
    validateStrategy(maskingStrategy);

    const rows = yield* Effect.promise(() => internalQuery<PIIClassificationRow>(
      `INSERT INTO ${TABLE_NAME} (org_id, table_name, column_name, connection_id, category, confidence, masking_strategy)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (org_id, table_name, column_name, connection_id)
       DO UPDATE SET category = $5, confidence = $6, masking_strategy = $7, updated_at = now(), dismissed = false
       RETURNING *`,
      [orgId, tableName, columnName, connectionId, category, confidence, maskingStrategy],
    ));
    return rowToClassification(rows[0]);
  });

export const updatePIIClassification = (
  orgId: string,
  id: string,
  updates: UpdatePIIClassificationRequest,
): Effect.Effect<PIIColumnClassification, ComplianceError | EnterpriseError> =>
  Effect.gen(function* () {
    yield* requireEnterpriseEffect("pii-detection");
    if (!(yield* ready())) {
      return yield* Effect.fail(new ComplianceError("Internal database not available", "validation"));
    }

    if (updates.category) validateCategory(updates.category);
    if (updates.maskingStrategy) validateStrategy(updates.maskingStrategy);

    const setClauses: string[] = ["updated_at = now()"];
    const params: unknown[] = [orgId, id];

    if (updates.category !== undefined) {
      params.push(updates.category);
      setClauses.push(`category = $${params.length}`);
    }
    if (updates.maskingStrategy !== undefined) {
      params.push(updates.maskingStrategy);
      setClauses.push(`masking_strategy = $${params.length}`);
    }
    if (updates.dismissed !== undefined) {
      params.push(updates.dismissed);
      setClauses.push(`dismissed = $${params.length}`);
    }
    if (updates.reviewed !== undefined) {
      params.push(updates.reviewed);
      setClauses.push(`reviewed = $${params.length}`);
    }

    const rows = yield* Effect.promise(() => internalQuery<PIIClassificationRow>(
      `UPDATE ${TABLE_NAME} SET ${setClauses.join(", ")} WHERE org_id = $1 AND id = $2 RETURNING *`,
      params,
    ));

    if (rows.length === 0) {
      return yield* Effect.fail(new ComplianceError("PII classification not found", "not_found"));
    }
    return rowToClassification(rows[0]);
  });

export const deletePIIClassification = (
  orgId: string,
  id: string,
): Effect.Effect<void, ComplianceError | EnterpriseError> =>
  Effect.gen(function* () {
    yield* requireEnterpriseEffect("pii-detection");
    if (!(yield* ready())) {
      return yield* Effect.fail(new ComplianceError("Internal database not available", "validation"));
    }

    const rows = yield* Effect.promise(() => internalQuery<{ id: string }>(
      `DELETE FROM ${TABLE_NAME} WHERE org_id = $1 AND id = $2 RETURNING id`,
      [orgId, id],
    ));
    if (rows.length === 0) {
      return yield* Effect.fail(new ComplianceError("PII classification not found", "not_found"));
    }
  });

// ── Masking application (query result path) ─────────────────────

/**
 * In-memory cache for PII classifications per org.
 * TTL: 60 seconds — balances freshness with performance.
 */
const _classificationCache = new Map<string, { data: PIIClassificationRow[]; expiresAt: number }>();
const CACHE_TTL_MS = 60_000;

const getClassificationsForOrg = (
  orgId: string,
): Effect.Effect<PIIClassificationRow[], Error> =>
  Effect.gen(function* () {
    const cached = _classificationCache.get(orgId);
    if (cached && cached.expiresAt > Date.now()) return cached.data;

    if (!(yield* ready())) return [];

    const data = yield* Effect.tryPromise({
      try: () => internalQuery<PIIClassificationRow>(
        `SELECT * FROM ${TABLE_NAME} WHERE org_id = $1 AND dismissed = false`,
        [orgId],
      ),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    });
    _classificationCache.set(orgId, { data, expiresAt: Date.now() + CACHE_TTL_MS });
    return data;
  });

/** Invalidate the classification cache for an org (call after CRUD). */
export function invalidateClassificationCache(orgId: string): void {
  _classificationCache.delete(orgId);
}

export interface MaskingContext {
  /** The query result columns. */
  columns: string[];
  /** The query result rows. */
  rows: Record<string, unknown>[];
  /** Tables accessed by the query (from SQL classification). */
  tablesAccessed: string[];
  /** Organization ID. */
  orgId: string;
  /** User role — determines masking level. */
  userRole: MaskingRole | string | undefined;
}

/**
 * Apply PII masking to query results based on column classifications and user role.
 *
 * - Fails open when enterprise is disabled (returns unmodified results).
 * - Admins/owners always see raw data.
 * - Analysts see partial masks.
 * - Viewers/members see full masks.
 *
 * Returns a new rows array with masked values (does not mutate input).
 */
export const applyMasking = (
  ctx: MaskingContext,
): Effect.Effect<Record<string, unknown>[]> =>
  Effect.gen(function* () {
    // Fail open when enterprise is disabled — no masking for non-enterprise deployments
    if (!isEnterpriseEnabled()) return ctx.rows;
    if (!hasInternalDB()) return ctx.rows;
    if (ctx.rows.length === 0) return ctx.rows;

    // Admins and owners always see raw data
    const role = ctx.userRole ?? "viewer";
    if (role === "admin" || role === "owner") return ctx.rows;

    const classifications = yield* getClassificationsForOrg(ctx.orgId).pipe(
      Effect.catchAll((err) => {
        log.warn(
          { err: err instanceof Error ? err.message : String(err), orgId: ctx.orgId },
          "Failed to load PII classifications — returning unmasked results",
        );
        return Effect.succeed([] as PIIClassificationRow[]);
      }),
    );

    if (classifications.length === 0) return ctx.rows;

    // Build a lookup: columnName → masking strategy (filtered to tables accessed by this query)
    const maskLookup = new Map<string, MaskingStrategy>();
    for (const cls of classifications) {
      const tableNameLower = cls.table_name.toLowerCase();
      const colNameLower = cls.column_name.toLowerCase();
      // Match against tables accessed by this query
      for (const table of ctx.tablesAccessed) {
        if (table.toLowerCase() === tableNameLower) {
          maskLookup.set(colNameLower, cls.masking_strategy as MaskingStrategy);
        }
      }
    }

    if (maskLookup.size === 0) return ctx.rows;

    // Determine effective strategy based on role
    const strategyForRole = resolveStrategyForRole(role);

    // Apply masking to each row
    return ctx.rows.map((row) => {
      const masked = { ...row };
      for (const [colName, strategy] of maskLookup) {
        // Match column names case-insensitively
        const matchingKey = ctx.columns.find((c) => c.toLowerCase() === colName);
        if (matchingKey && matchingKey in masked) {
          masked[matchingKey] = maskValue(masked[matchingKey], strategy, strategyForRole);
        }
      }
      return masked;
    });
  });

// ── Masking functions ───────────────────────────────────────────

/**
 * Resolve the effective masking level for a given role.
 * Admins/owners are filtered upstream (applyMasking exits early),
 * so this handles analyst (partial) and all other roles (full).
 */
function resolveStrategyForRole(role: string): "full" | "partial" {
  switch (role) {
    case "admin":
    case "owner":
      return "partial"; // unreachable — admins exit early, but type-safe
    case "analyst":
      return "partial";
    default:
      return "full";
  }
}

/**
 * Mask a single value according to the column's strategy and the role's override.
 *
 * Role determines the effective masking level:
 * - **viewer/member** (roleStrategy = "full"): always fully masked, regardless of column strategy
 * - **analyst** (roleStrategy = "partial"): uses column strategy, but "full" is downgraded to "partial"
 */
export function maskValue(
  value: unknown,
  columnStrategy: MaskingStrategy,
  roleStrategy: "full" | "partial",
): unknown {
  // Preserve null/undefined — no data to mask
  if (value == null) return value;

  // For non-string types, convert to string for masking
  const str = String(value);
  if (str === "") return str;

  // Viewers/members always see full mask
  if (roleStrategy === "full") {
    return "***";
  }

  // Analysts: use column strategy but downgrade "full" to "partial"
  const effectiveStrategy = columnStrategy === "full" ? "partial" : columnStrategy;

  switch (effectiveStrategy) {
    case "partial":
      return partialMask(str);
    case "hash":
      return hashValue(str);
    case "redact":
      return "[REDACTED]";
    default:
      return partialMask(str);
  }
}

/**
 * Apply partial masking that preserves structure while hiding content.
 *
 * Examples:
 * - email: alice@example.com → a***@example.com
 * - phone: 555-123-4567 → 555-***-4567
 * - SSN: 123-45-6789 → ***-**-6789
 * - generic: abcdefgh → ab***gh
 */
export function partialMask(value: string): string {
  // Email: show first char + domain
  if (EMAIL_RE.test(value)) {
    const [local, domain] = value.split("@");
    return `${local[0]}***@${domain}`;
  }

  // SSN: mask first 5 digits
  if (SSN_RE.test(value)) {
    return `***-**-${value.slice(-4)}`;
  }

  // Credit card: show last 4 digits
  if (CREDIT_CARD_RE.test(value)) {
    return `****-****-****-${value.replace(/[\s-]/g, "").slice(-4)}`;
  }

  // Phone: show area code + last 4
  if (PHONE_RE.test(value)) {
    const digits = value.replace(/\D/g, "");
    if (digits.length >= 10) {
      return `${digits.slice(0, 3)}-***-${digits.slice(-4)}`;
    }
  }

  // Generic: show first 2 + last 2 characters
  if (value.length <= 4) return "***";
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

import { EMAIL_RE, SSN_RE, CREDIT_CARD_RE, PHONE_RE } from "./patterns";

// ── Validation helpers ──────────────────────────────────────────

function validateCategory(category: string): asserts category is PIICategory {
  if (!(PII_CATEGORIES as readonly string[]).includes(category)) {
    throw new ComplianceError(
      `Invalid PII category "${category}". Must be one of: ${PII_CATEGORIES.join(", ")}`,
      "validation",
    );
  }
}

function validateStrategy(strategy: string): asserts strategy is MaskingStrategy {
  if (!(MASKING_STRATEGIES as readonly string[]).includes(strategy)) {
    throw new ComplianceError(
      `Invalid masking strategy "${strategy}". Must be one of: ${MASKING_STRATEGIES.join(", ")}`,
      "validation",
    );
  }
}

/** Reset internal state. For testing only. */
export function _resetComplianceState(): void {
  _classificationCache.clear();
  _tableReady = false;
}
