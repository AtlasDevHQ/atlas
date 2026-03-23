/**
 * PII detection and column masking types shared across API, frontend, and SDK.
 *
 * Enterprise customers can enable PII detection during database profiling to
 * auto-tag sensitive columns. Masking rules control how PII-tagged columns
 * appear in query results based on user role.
 */

// ── PII categories ──────────────────────────────────────────────

export const PII_CATEGORIES = [
  "email",
  "phone",
  "ssn",
  "credit_card",
  "name",
  "ip_address",
  "date_of_birth",
  "address",
  "passport",
  "driver_license",
  "other",
] as const;

export type PIICategory = (typeof PII_CATEGORIES)[number];

// ── Confidence levels ───────────────────────────────────────────

export const PII_CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;
export type PIIConfidence = (typeof PII_CONFIDENCE_LEVELS)[number];

// ── Masking strategies ──────────────────────────────────────────

export const MASKING_STRATEGIES = ["full", "partial", "hash", "redact"] as const;
export type MaskingStrategy = (typeof MASKING_STRATEGIES)[number];

// ── Detection methods ────────────────────────────────────────────

export const PII_DETECTION_METHODS = ["regex", "column_name", "type_heuristic"] as const;
export type PIIDetectionMethod = (typeof PII_DETECTION_METHODS)[number];

// ── Detection result ────────────────────────────────────────────

export interface PIIDetection {
  /** The detected PII category. */
  category: PIICategory;
  /** Confidence level of the detection. */
  confidence: PIIConfidence;
  /** How the detection was made. */
  method: PIIDetectionMethod;
  /** Human-readable reason for the detection. */
  reason: string;
}

// ── Masking role tiers ──────────────────────────────────────────

/** Roles relevant to masking decisions. */
export const MASKING_ROLES = ["admin", "owner", "analyst", "viewer", "member"] as const;
export type MaskingRole = (typeof MASKING_ROLES)[number];

// ── Column-level PII classification (stored in DB) ──────────────

export interface PIIColumnClassification {
  id: string;
  orgId: string;
  /** Entity table name. */
  tableName: string;
  /** Column name within the table. */
  columnName: string;
  /** Connection ID for the datasource. */
  connectionId: string;
  /** Detected or manually assigned PII category. */
  category: PIICategory;
  /** Detection confidence level. */
  confidence: PIIConfidence;
  /** Masking strategy to apply in query results. */
  maskingStrategy: MaskingStrategy;
  /** Whether this detection has been reviewed by an admin. */
  reviewed: boolean;
  /** If true, admin dismissed this as a false positive. */
  dismissed: boolean;
  createdAt: string;
  updatedAt: string;
}

// ── Request / response shapes ───────────────────────────────────

export interface UpdatePIIClassificationRequest {
  category?: PIICategory;
  maskingStrategy?: MaskingStrategy;
  dismissed?: boolean;
  reviewed?: boolean;
}

// ── Compliance report types ─────────────────────────────────────

export const COMPLIANCE_REPORT_TYPES = ["data-access", "user-activity"] as const;
export type ComplianceReportType = (typeof COMPLIANCE_REPORT_TYPES)[number];

export const COMPLIANCE_EXPORT_FORMATS = ["json", "csv"] as const;
export type ComplianceExportFormat = (typeof COMPLIANCE_EXPORT_FORMATS)[number];

export interface ComplianceReportFilters {
  startDate: string;
  endDate: string;
  userId?: string;
  role?: string;
  table?: string;
}

/** A single row in the data access report. */
export interface DataAccessRow {
  tableName: string;
  userId: string;
  userEmail: string | null;
  userRole: string | null;
  queryCount: number;
  uniqueColumns: string[];
  hasPII: boolean;
  firstAccess: string;
  lastAccess: string;
}

export interface DataAccessReport {
  rows: DataAccessRow[];
  summary: {
    totalQueries: number;
    uniqueUsers: number;
    uniqueTables: number;
    piiTablesAccessed: number;
  };
  filters: ComplianceReportFilters;
  generatedAt: string;
}

/** A single row in the user activity report. */
export interface UserActivityRow {
  userId: string;
  userEmail: string | null;
  role: string | null;
  totalQueries: number;
  tablesAccessed: string[];
  lastActiveAt: string | null;
  lastLoginAt: string | null;
}

export interface UserActivityReport {
  rows: UserActivityRow[];
  summary: {
    totalUsers: number;
    activeUsers: number;
    totalQueries: number;
  };
  filters: ComplianceReportFilters;
  generatedAt: string;
}

