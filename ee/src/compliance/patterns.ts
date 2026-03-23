/**
 * Shared regex patterns for PII detection and partial masking.
 *
 * Single source of truth — used by both pii-detection.ts (for sample value
 * matching) and masking.ts (for format-aware partial masking).
 */

export const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
export const PHONE_RE = /^[\s]*(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)?\d{3}[\s.-]?\d{4}[\s]*$/;
export const SSN_RE = /^\d{3}-\d{2}-\d{4}$/;
export const CREDIT_CARD_RE = /^\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}$/;
export const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)$/;
export const IPV6_RE = /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/;
export const DOB_RE = /^(?:19|20)\d{2}[-/](?:0[1-9]|1[0-2])[-/](?:0[1-9]|[12]\d|3[01])$/;
export const PASSPORT_RE = /^[A-Z]{1,2}\d{6,9}$/;
export const DRIVER_LICENSE_RE = /^[A-Z]\d{3,}-\d{3,}-\d{3,}$/;
