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

// ── Detection result ────────────────────────────────────────────

export interface PIIDetection {
  /** The detected PII category. */
  category: PIICategory;
  /** Confidence level of the detection. */
  confidence: PIIConfidence;
  /** How the detection was made. */
  method: "regex" | "column_name" | "type_heuristic";
  /** Human-readable reason for the detection. */
  reason: string;
}

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

// ── Masking rule configuration ──────────────────────────────────

export interface MaskingRuleConfig {
  /** Role name (e.g. "admin", "analyst", "viewer") → masking behavior. */
  roleMasks: Record<string, MaskingStrategy | "none">;
  /** Default masking strategy for unlisted roles. */
  defaultStrategy: MaskingStrategy;
}

// ── Request / response shapes ───────────────────────────────────

export interface UpdatePIIClassificationRequest {
  category?: PIICategory;
  maskingStrategy?: MaskingStrategy;
  dismissed?: boolean;
  reviewed?: boolean;
}

export interface PIIColumnSummary {
  tableName: string;
  columnName: string;
  connectionId: string;
  category: PIICategory;
  confidence: PIIConfidence;
  maskingStrategy: MaskingStrategy;
  reviewed: boolean;
  dismissed: boolean;
}
