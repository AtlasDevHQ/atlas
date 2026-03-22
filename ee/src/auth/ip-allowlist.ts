/**
 * Enterprise IP allowlist — CIDR parsing, validation, and matching.
 *
 * Per-workspace IP allowlisting: when configured, only requests from
 * allowed CIDR ranges can access the workspace. Uses Node.js `net`
 * module for IP parsing — no external dependencies.
 *
 * CRUD functions call `requireEnterprise("ip-allowlist")`.
 * Validation helpers do not require a license.
 */

import * as net from "node:net";
import { requireEnterprise } from "../index";
import {
  hasInternalDB,
  internalQuery,
  getInternalDB,
} from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("ee:ip-allowlist");

// ── Types ────────────────────────────────────────────────────────────

export interface ParsedCIDR {
  network: bigint;
  mask: bigint;
  version: 4 | 6;
  original: string;
}

export interface IPAllowlistEntry {
  id: string;
  orgId: string;
  cidr: string;
  description: string | null;
  createdAt: string;
  createdBy: string | null;
}

/** Internal row shape from the ip_allowlist table. */
interface IPAllowlistRow {
  id: string;
  org_id: string;
  cidr: string;
  description: string | null;
  created_at: string;
  created_by: string | null;
  [key: string]: unknown;
}

// ── Typed errors ─────────────────────────────────────────────────────

export type IPAllowlistErrorCode = "validation" | "conflict" | "not_found";

export class IPAllowlistError extends Error {
  constructor(message: string, public readonly code: IPAllowlistErrorCode) {
    super(message);
    this.name = "IPAllowlistError";
  }
}

// ── In-memory cache ──────────────────────────────────────────────────

interface CacheEntry {
  ranges: ParsedCIDR[];
  expiry: number;
}

const CACHE_TTL_MS = 30_000; // 30 seconds
const cache = new Map<string, CacheEntry>();

/** Invalidate cached allowlist for an org. Call after any mutation. */
export function invalidateCache(orgId: string): void {
  cache.delete(orgId);
}

/** Clear all cached entries. For tests. */
export function _clearCache(): void {
  cache.clear();
}

// ── IPv4/IPv6 parsing ────────────────────────────────────────────────

/**
 * Parse an IPv4 address string into a bigint.
 * Returns null for invalid addresses.
 */
function parseIPv4(ip: string): bigint | null {
  if (!net.isIPv4(ip)) return null;
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let result = 0n;
  for (const part of parts) {
    const num = Number(part);
    if (num < 0 || num > 255 || !Number.isInteger(num)) return null;
    result = (result << 8n) | BigInt(num);
  }
  return result;
}

/**
 * Parse an IPv6 address string into a bigint.
 * Handles full, compressed (::), and IPv4-mapped (::ffff:1.2.3.4) forms.
 * Returns null for invalid addresses.
 */
function parseIPv6(ip: string): bigint | null {
  if (!net.isIPv6(ip)) return null;

  // Handle IPv4-mapped IPv6 (e.g. ::ffff:192.168.1.1)
  const v4Suffix = ip.match(/:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  let expandedIP = ip;
  if (v4Suffix) {
    const v4 = parseIPv4(v4Suffix[1]);
    if (v4 === null) return null;
    const hex1 = ((v4 >> 8n) & 0xFFn).toString(16).padStart(2, "0");
    const hex2 = (v4 & 0xFFn).toString(16).padStart(2, "0");
    const hex3 = ((v4 >> 24n) & 0xFFn).toString(16).padStart(2, "0");
    const hex4 = ((v4 >> 16n) & 0xFFn).toString(16).padStart(2, "0");
    expandedIP = ip.slice(0, v4Suffix.index) + `${hex3}${hex4}:${hex1}${hex2}`;
  }

  // Expand :: notation
  const sides = expandedIP.split("::");
  if (sides.length > 2) return null;

  let groups: string[];
  if (sides.length === 2) {
    const left = sides[0] ? sides[0].split(":") : [];
    const right = sides[1] ? sides[1].split(":") : [];
    const missing = 8 - left.length - right.length;
    if (missing < 0) return null;
    groups = [...left, ...Array(missing).fill("0"), ...right];
  } else {
    groups = expandedIP.split(":");
  }

  if (groups.length !== 8) return null;

  let result = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    result = (result << 16n) | BigInt(parseInt(group, 16));
  }
  return result;
}

/**
 * Parse an IP address (v4 or v6) into a bigint and its version.
 * Returns null for invalid addresses.
 */
function parseIP(ip: string): { value: bigint; version: 4 | 6 } | null {
  const v4 = parseIPv4(ip);
  if (v4 !== null) return { value: v4, version: 4 };
  const v6 = parseIPv6(ip);
  if (v6 !== null) return { value: v6, version: 6 };
  return null;
}

// ── CIDR parsing and matching ────────────────────────────────────────

/**
 * Parse a CIDR notation string into a structured representation.
 *
 * Supports:
 * - IPv4: `10.0.0.0/8`, `192.168.1.0/24`, `10.0.0.1/32`
 * - IPv6: `2001:db8::/32`, `::1/128`, `fe80::/10`
 *
 * Returns null for invalid CIDR notation.
 */
export function parseCIDR(cidr: string): ParsedCIDR | null {
  const trimmed = cidr.trim();
  const slashIdx = trimmed.lastIndexOf("/");
  if (slashIdx === -1) return null;

  const ipPart = trimmed.slice(0, slashIdx);
  const prefixStr = trimmed.slice(slashIdx + 1);

  // Validate prefix length
  if (!/^\d+$/.test(prefixStr)) return null;
  const prefixLen = parseInt(prefixStr, 10);

  const parsed = parseIP(ipPart);
  if (!parsed) return null;

  const maxPrefix = parsed.version === 4 ? 32 : 128;
  if (prefixLen < 0 || prefixLen > maxPrefix) return null;

  // Build mask: all ones shifted left by (maxPrefix - prefixLen)
  const totalBits = BigInt(maxPrefix);
  const prefixBits = BigInt(prefixLen);
  const mask = prefixLen === 0
    ? 0n
    : ((1n << totalBits) - 1n) ^ ((1n << (totalBits - prefixBits)) - 1n);

  // Network address = IP & mask (normalize the network)
  const network = parsed.value & mask;

  return { network, mask, version: parsed.version, original: trimmed };
}

/**
 * Check whether an IP address falls within a CIDR range.
 */
export function isIPInRange(ip: string, cidr: ParsedCIDR): boolean {
  const parsed = parseIP(ip);
  if (!parsed) return false;

  // IP version must match CIDR version
  if (parsed.version !== cidr.version) return false;

  return (parsed.value & cidr.mask) === cidr.network;
}

/**
 * Check whether an IP address is allowed by any of the given CIDR ranges.
 * Returns true if the IP matches at least one range.
 */
export function isIPAllowed(ip: string, ranges: ParsedCIDR[]): boolean {
  if (ranges.length === 0) return true; // No ranges = allow all
  return ranges.some((range) => isIPInRange(ip, range));
}

// ── Row mapping ──────────────────────────────────────────────────────

function rowToEntry(row: IPAllowlistRow): IPAllowlistEntry {
  return {
    id: row.id,
    orgId: row.org_id,
    cidr: row.cidr,
    description: row.description,
    createdAt: String(row.created_at),
    createdBy: row.created_by,
  };
}

// ── CRUD ─────────────────────────────────────────────────────────────

/**
 * List IP allowlist entries for an organization.
 */
export async function listIPAllowlistEntries(orgId: string): Promise<IPAllowlistEntry[]> {
  requireEnterprise("ip-allowlist");
  if (!hasInternalDB()) return [];

  const rows = await internalQuery<IPAllowlistRow>(
    `SELECT id, org_id, cidr, description, created_at, created_by
     FROM ip_allowlist
     WHERE org_id = $1
     ORDER BY created_at ASC`,
    [orgId],
  );
  return rows.map(rowToEntry);
}

/**
 * Add a CIDR range to an organization's IP allowlist.
 * Validates CIDR format and rejects duplicates.
 */
export async function addIPAllowlistEntry(
  orgId: string,
  cidr: string,
  description: string | null,
  createdBy: string | null,
): Promise<IPAllowlistEntry> {
  requireEnterprise("ip-allowlist");
  if (!hasInternalDB()) {
    throw new Error("Internal database required for IP allowlist management.");
  }

  // Validate CIDR format
  const parsed = parseCIDR(cidr);
  if (!parsed) {
    throw new IPAllowlistError(
      `Invalid CIDR notation: "${cidr}". Expected format: 10.0.0.0/8 (IPv4) or 2001:db8::/32 (IPv6).`,
      "validation",
    );
  }

  // Check for duplicates
  const existing = await internalQuery<{ id: string }>(
    `SELECT id FROM ip_allowlist WHERE org_id = $1 AND cidr = $2`,
    [orgId, parsed.original],
  );
  if (existing.length > 0) {
    throw new IPAllowlistError(
      `CIDR range "${parsed.original}" is already in the allowlist.`,
      "conflict",
    );
  }

  const rows = await internalQuery<IPAllowlistRow>(
    `INSERT INTO ip_allowlist (org_id, cidr, description, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING id, org_id, cidr, description, created_at, created_by`,
    [orgId, parsed.original, description, createdBy],
  );

  if (!rows[0]) throw new Error("Failed to add IP allowlist entry — no row returned.");

  log.info({ orgId, cidr: parsed.original }, "IP allowlist entry added");
  invalidateCache(orgId);
  return rowToEntry(rows[0]);
}

/**
 * Remove an IP allowlist entry by ID.
 */
export async function removeIPAllowlistEntry(orgId: string, entryId: string): Promise<boolean> {
  requireEnterprise("ip-allowlist");
  if (!hasInternalDB()) return false;

  const pool = getInternalDB();
  const result = await pool.query(
    `DELETE FROM ip_allowlist WHERE id = $1 AND org_id = $2 RETURNING id`,
    [entryId, orgId],
  );

  const deleted = result.rows.length > 0;
  if (deleted) {
    log.info({ orgId, entryId }, "IP allowlist entry removed");
    invalidateCache(orgId);
  }
  return deleted;
}

// ── Middleware helper ─────────────────────────────────────────────────

/**
 * Check whether a client IP is allowed by the workspace's IP allowlist.
 *
 * Returns `{ allowed: true }` when:
 * - Enterprise is not enabled (feature gate)
 * - No internal DB configured
 * - No allowlist entries for the org (opt-in)
 * - IP matches at least one CIDR range
 *
 * Returns `{ allowed: false }` when the IP is not in any allowed range.
 * Uses an in-memory cache with 30s TTL for performance.
 */
export async function checkIPAllowlist(
  orgId: string,
  clientIP: string | null,
): Promise<{ allowed: boolean }> {
  // Lazy import to avoid circular dependency
  const { isEnterpriseEnabled } = await import("../index");
  if (!isEnterpriseEnabled()) return { allowed: true };
  if (!hasInternalDB()) return { allowed: true };

  // Check cache
  const cached = cache.get(orgId);
  const now = Date.now();
  let ranges: ParsedCIDR[];

  if (cached && cached.expiry > now) {
    ranges = cached.ranges;
  } else {
    // Load from DB
    try {
      const rows = await internalQuery<{ cidr: string; [key: string]: unknown }>(
        `SELECT cidr FROM ip_allowlist WHERE org_id = $1`,
        [orgId],
      );
      ranges = [];
      for (const row of rows) {
        const parsed = parseCIDR(row.cidr);
        if (parsed) {
          ranges.push(parsed);
        } else {
          log.warn({ orgId, cidr: row.cidr }, "Invalid CIDR in ip_allowlist table — skipping");
        }
      }
      cache.set(orgId, { ranges, expiry: now + CACHE_TTL_MS });
    } catch (err) {
      // Fail closed per CLAUDE.md: "catch { return false } on a security check is a bug"
      log.error(
        { err: err instanceof Error ? err.message : String(err), orgId },
        "Failed to load IP allowlist — blocking request (fail-closed)",
      );
      throw err;
    }
  }

  // No entries = no restriction (opt-in)
  if (ranges.length === 0) return { allowed: true };

  // No client IP available = cannot verify, deny
  if (!clientIP) return { allowed: false };

  return { allowed: isIPAllowed(clientIP, ranges) };
}
