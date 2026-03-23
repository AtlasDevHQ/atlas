/**
 * PII detection engine for Atlas Enterprise.
 *
 * Pure-function detector that analyzes column metadata (name, type, sample
 * values) to identify likely PII columns. Three detection methods:
 *
 * - **regex**: Pattern match against sample values (highest confidence)
 * - **column_name**: Heuristic match on column name conventions
 * - **type_heuristic**: Type-based guess (lowest confidence)
 *
 * All functions are stateless and have no DB dependency — easy to test
 * and safe to call during profiling without side effects.
 */

import type { PIICategory, PIIDetection } from "@useatlas/types";
import {
  EMAIL_RE,
  PHONE_RE,
  SSN_RE,
  CREDIT_CARD_RE,
  IPV4_RE,
  IPV6_RE,
  DOB_RE,
  PASSPORT_RE,
  DRIVER_LICENSE_RE,
} from "./patterns";

interface ValuePattern {
  category: PIICategory;
  regex: RegExp;
  minMatchRatio: number;
}

const VALUE_PATTERNS: ValuePattern[] = [
  { category: "email", regex: EMAIL_RE, minMatchRatio: 0.5 },
  { category: "ssn", regex: SSN_RE, minMatchRatio: 0.5 },
  { category: "credit_card", regex: CREDIT_CARD_RE, minMatchRatio: 0.5 },
  { category: "phone", regex: PHONE_RE, minMatchRatio: 0.4 },
  { category: "ip_address", regex: IPV4_RE, minMatchRatio: 0.5 },
  { category: "ip_address", regex: IPV6_RE, minMatchRatio: 0.5 },
  { category: "date_of_birth", regex: DOB_RE, minMatchRatio: 0.3 },
  { category: "passport", regex: PASSPORT_RE, minMatchRatio: 0.5 },
  { category: "driver_license", regex: DRIVER_LICENSE_RE, minMatchRatio: 0.5 },
];

// ── Column name heuristics ──────────────────────────────────────

interface NamePattern {
  category: PIICategory;
  patterns: RegExp[];
}

const NAME_PATTERNS: NamePattern[] = [
  {
    category: "email",
    patterns: [/email/i, /e_?mail/i, /email_?addr/i],
  },
  {
    category: "phone",
    patterns: [/phone/i, /phone_?num/i, /tel(?:ephone)?/i, /mobile/i, /cell/i, /fax/i],
  },
  {
    category: "ssn",
    patterns: [/\bssn\b/i, /social_?security/i, /sin\b/i, /national_?id/i, /tax_?id/i],
  },
  {
    category: "credit_card",
    patterns: [/credit_?card/i, /card_?num/i, /cc_?num/i, /pan\b/i],
  },
  {
    category: "name",
    patterns: [
      /^first_?name$/i, /^last_?name$/i, /^full_?name$/i,
      /^given_?name$/i, /^family_?name$/i, /^surname$/i,
      /^middle_?name$/i, /^display_?name$/i,
    ],
  },
  {
    category: "ip_address",
    patterns: [/\bip_?addr/i, /\bclient_?ip\b/i, /\bremote_?ip\b/i, /\bsource_?ip\b/i, /\bip_?address/i],
  },
  {
    category: "date_of_birth",
    patterns: [/\bdob\b/i, /\bdate_?of_?birth\b/i, /\bbirth_?date\b/i, /\bbirthday\b/i],
  },
  {
    category: "address",
    patterns: [
      /^street_?addr/i, /^mailing_?addr/i, /^home_?addr/i,
      /^postal_?code$/i, /^zip_?code$/i, /^zip$/i,
    ],
  },
  {
    category: "passport",
    patterns: [/passport/i],
  },
  {
    category: "driver_license",
    patterns: [/driver_?lic/i, /driving_?lic/i, /\bdl_?num/i],
  },
];

// ── Public API ──────────────────────────────────────────────────

export interface DetectPIIInput {
  name: string;
  type: string;
  sampleValues: unknown[];
}

/**
 * Detect PII in a single column based on its name, type, and sample values.
 *
 * Returns the highest-confidence detection, or null if no PII is detected.
 * Detection priority: regex match on values > column name heuristic > type guess.
 */
export function detectPII(column: DetectPIIInput): PIIDetection | null {
  // 1. Regex match on sample values (highest confidence)
  const valueDetection = detectFromValues(column.sampleValues);
  if (valueDetection) return valueDetection;

  // 2. Column name heuristic (medium confidence)
  const nameDetection = detectFromName(column.name);
  if (nameDetection) return nameDetection;

  // 3. Type-based guess (lowest confidence)
  const typeDetection = detectFromType(column.name, column.type);
  if (typeDetection) return typeDetection;

  return null;
}

/**
 * Batch-detect PII across multiple columns.
 *
 * Returns a map of column name → detection result (only columns with detections).
 */
export function detectPIIBatch(
  columns: DetectPIIInput[],
): Map<string, PIIDetection> {
  const results = new Map<string, PIIDetection>();
  for (const col of columns) {
    const detection = detectPII(col);
    if (detection) {
      results.set(col.name, detection);
    }
  }
  return results;
}

// ── Internal detection methods ──────────────────────────────────

function detectFromValues(sampleValues: unknown[]): PIIDetection | null {
  const stringValues = sampleValues
    .filter((v): v is string | number => v != null && v !== "")
    .map(String);

  if (stringValues.length === 0) return null;

  for (const pattern of VALUE_PATTERNS) {
    const matches = stringValues.filter((v) => pattern.regex.test(v));
    const ratio = matches.length / stringValues.length;
    if (ratio >= pattern.minMatchRatio) {
      return {
        category: pattern.category,
        confidence: "high",
        method: "regex",
        reason: `${matches.length}/${stringValues.length} sample values match ${pattern.category} pattern`,
      };
    }
  }

  return null;
}

function detectFromName(columnName: string): PIIDetection | null {
  for (const namePattern of NAME_PATTERNS) {
    for (const regex of namePattern.patterns) {
      if (regex.test(columnName)) {
        return {
          category: namePattern.category,
          confidence: "medium",
          method: "column_name",
          reason: `Column name "${columnName}" matches ${namePattern.category} naming pattern`,
        };
      }
    }
  }
  return null;
}

function detectFromType(columnName: string, columnType: string): PIIDetection | null {
  const lowerName = columnName.toLowerCase();
  const lowerType = columnType.toLowerCase();

  // Date columns named with birth-related terms
  if ((lowerType === "date" || lowerType === "timestamp") && /birth|dob/i.test(lowerName)) {
    return {
      category: "date_of_birth",
      confidence: "low",
      method: "type_heuristic",
      reason: `Date column "${columnName}" may contain date of birth`,
    };
  }

  // inet/cidr types are likely IP addresses
  if (lowerType === "inet" || lowerType === "cidr") {
    return {
      category: "ip_address",
      confidence: "low",
      method: "type_heuristic",
      reason: `Column type "${columnType}" is likely an IP address`,
    };
  }

  return null;
}
