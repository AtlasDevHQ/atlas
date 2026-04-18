/**
 * Enterprise IP allowlist — CIDR parsing, validation, and matching.
 *
 * Per-workspace IP allowlisting: when configured, only requests from
 * allowed CIDR ranges can access the workspace. Uses `ipaddr.js` for
 * robust IP/CIDR parsing with full IPv4-mapped IPv6 support.
 *
 * CRUD functions call `requireEnterprise("ip-allowlist")`.
 * Validation helpers do not require a license.
 */

import { Data, Effect } from "effect";
import ipaddr from "ipaddr.js";
import { requireEnterpriseEffect, EnterpriseError } from "../index";
import { requireInternalDBEffect } from "../lib/db-guard";
import {
  hasInternalDB,
  internalQuery,
  getInternalDB,
} from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("ee:ip-allowlist");

// ── Types ────────────────────────────────────────────────────────────

export interface ParsedCIDR {
  /** ipaddr.js CIDR tuple: [address, prefixLength] */
  cidr: [ipaddr.IPv4 | ipaddr.IPv6, number];
  /** Canonical normalized string: "network/prefix" (e.g. "10.0.0.0/8") */
  normalized: string;
  /** IP version: 4 or 6 */
  version: 4 | 6;
  /** Original input string (trimmed) */
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

export class IPAllowlistError extends Data.TaggedError("IPAllowlistError")<{
  message: string;
  code: IPAllowlistErrorCode;
}> {}

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

// ── CIDR helpers (ipaddr.js) ─────────────────────────────────────────

/**
 * Compute the canonical network address for a CIDR.
 *
 * Given an address and prefix length, zeros out the host bits to produce
 * the network address (e.g. 192.168.1.100/24 -> 192.168.1.0).
 */
function networkAddress(addr: ipaddr.IPv4 | ipaddr.IPv6, prefixLen: number): ipaddr.IPv4 | ipaddr.IPv6 {
  const bytes = addr.toByteArray();
  const totalBits = addr.kind() === "ipv4" ? 32 : 128;

  // Zero out host bits
  for (let i = prefixLen; i < totalBits; i++) {
    const byteIdx = Math.floor(i / 8);
    const bitIdx = 7 - (i % 8);
    bytes[byteIdx] &= ~(1 << bitIdx);
  }

  return ipaddr.fromByteArray(bytes);
}

// ── CIDR parsing and matching ────────────────────────────────────────

/**
 * Parse a CIDR notation string (or plain IP) into a structured representation.
 *
 * Supports:
 * - IPv4 CIDR: `10.0.0.0/8`, `192.168.1.0/24`, `10.0.0.1/32`
 * - IPv6 CIDR: `2001:db8::/32`, `::1/128`, `fe80::/10`
 * - Plain IPv4: `10.0.0.1` → treated as `10.0.0.1/32`
 * - Plain IPv6: `::1` → treated as `::1/128`
 *
 * Returns null for invalid input.
 */
export function parseCIDR(cidr: unknown): ParsedCIDR | null {
  if (typeof cidr !== "string") return null;
  const trimmed = cidr.trim();
  if (!trimmed) return null;

  const hasSlash = trimmed.includes("/");

  try {
    let addr: ipaddr.IPv4 | ipaddr.IPv6;
    let prefixLen: number;

    if (hasSlash) {
      const result = ipaddr.parseCIDR(trimmed);
      addr = result[0];
      prefixLen = result[1];
    } else {
      // Plain IP — default to /32 (IPv4) or /128 (IPv6)
      addr = ipaddr.parse(trimmed);
      prefixLen = addr.kind() === "ipv4" ? 32 : 128;
    }

    // Compute canonical network address
    const netAddr = networkAddress(addr, prefixLen);
    const version: 4 | 6 = addr.kind() === "ipv4" ? 4 : 6;
    const normalized = `${netAddr.toString()}/${prefixLen}`;

    return {
      cidr: [netAddr, prefixLen],
      normalized,
      version,
      original: trimmed,
    };
  } catch {
    // ipaddr.js throws on invalid input
    return null;
  }
}

/**
 * Check whether an IP address falls within a CIDR range.
 *
 * Handles IPv4-mapped IPv6 cross-matching: an IPv4-mapped IPv6 address
 * like `::ffff:10.0.0.1` will match an IPv4 CIDR like `10.0.0.0/8`.
 */
export function isIPInRange(ip: string, cidr: ParsedCIDR): boolean {
  try {
    // Use ipaddr.process() to normalize IPv4-mapped IPv6 → IPv4
    const addr = ipaddr.process(ip);
    const [network, prefix] = cidr.cidr;
    if (addr.kind() === "ipv4" && network.kind() === "ipv4") {
      return (addr as ipaddr.IPv4).match(network as ipaddr.IPv4, prefix);
    }
    if (addr.kind() === "ipv6" && network.kind() === "ipv6") {
      return (addr as ipaddr.IPv6).match(network as ipaddr.IPv6, prefix);
    }
    return false;
  } catch {
    // Invalid IP string
    return false;
  }
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
export const listIPAllowlistEntries = (orgId: string): Effect.Effect<IPAllowlistEntry[], EnterpriseError> =>
  Effect.gen(function* () {
    yield* requireEnterpriseEffect("ip-allowlist");
    if (!hasInternalDB()) return [];

    const rows = yield* Effect.promise(() => internalQuery<IPAllowlistRow>(
      `SELECT id, org_id, cidr, description, created_at, created_by
       FROM ip_allowlist
       WHERE org_id = $1
       ORDER BY created_at ASC`,
      [orgId],
    ));
    return rows.map(rowToEntry);
  });

/**
 * Add a CIDR range to an organization's IP allowlist.
 * Validates CIDR format and rejects duplicates (by normalized network address).
 *
 * Accepts plain IPs without prefix — they are treated as /32 (IPv4)
 * or /128 (IPv6). Duplicate detection uses the canonical network
 * address, so `10.0.0.5/8` and `10.0.0.0/8` are correctly identified
 * as the same range.
 */
export const addIPAllowlistEntry = (
  orgId: string,
  cidr: string,
  description: string | null,
  createdBy: string | null,
): Effect.Effect<IPAllowlistEntry, IPAllowlistError | EnterpriseError | Error> =>
  Effect.gen(function* () {
    yield* requireEnterpriseEffect("ip-allowlist");
    yield* requireInternalDBEffect("IP allowlist management");

    // Validate CIDR format
    const parsed = parseCIDR(cidr);
    if (!parsed) {
      return yield* Effect.fail(new IPAllowlistError({ message: `Invalid CIDR notation: "${cidr}". Expected format: 10.0.0.0/8 (IPv4), 2001:db8::/32 (IPv6), or plain IP.`, code: "validation" }));
    }

    // Use normalized form for both storage and duplicate check
    const normalizedCidr = parsed.normalized;

    // Check for duplicates using normalized CIDR (network address + prefix)
    const existing = yield* Effect.promise(() => internalQuery<{ id: string }>(
      `SELECT id FROM ip_allowlist WHERE org_id = $1 AND cidr = $2`,
      [orgId, normalizedCidr],
    ));
    if (existing.length > 0) {
      return yield* Effect.fail(new IPAllowlistError({ message: `CIDR range "${normalizedCidr}" is already in the allowlist.`, code: "conflict" }));
    }

    const rows = yield* Effect.promise(() => internalQuery<IPAllowlistRow>(
      `INSERT INTO ip_allowlist (org_id, cidr, description, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, org_id, cidr, description, created_at, created_by`,
      [orgId, normalizedCidr, description, createdBy],
    ));

    if (!rows[0]) return yield* Effect.die(new Error("Failed to add IP allowlist entry — no row returned."));

    log.info({ orgId, cidr: normalizedCidr }, "IP allowlist entry added");
    invalidateCache(orgId);
    return rowToEntry(rows[0]);
  });

/**
 * Remove an IP allowlist entry by ID.
 */
export const removeIPAllowlistEntry = (orgId: string, entryId: string): Effect.Effect<boolean, EnterpriseError> =>
  Effect.gen(function* () {
    yield* requireEnterpriseEffect("ip-allowlist");
    if (!hasInternalDB()) return false;

    const pool = getInternalDB();
    const result = yield* Effect.promise(() =>
      pool.query(
        `DELETE FROM ip_allowlist WHERE id = $1 AND org_id = $2 RETURNING id`,
        [entryId, orgId],
      ),
    );

    const deleted = result.rows.length > 0;
    if (deleted) {
      log.info({ orgId, entryId }, "IP allowlist entry removed");
      invalidateCache(orgId);
    }
    return deleted;
  });

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
export const checkIPAllowlist = (
  orgId: string,
  clientIP: string | null,
): Effect.Effect<{ allowed: boolean }, Error> =>
  Effect.gen(function* () {
    // Lazy import to avoid circular dependency
    const { isEnterpriseEnabled } = yield* Effect.promise(() => import("../index"));
    if (!isEnterpriseEnabled()) return { allowed: true };
    if (!hasInternalDB()) return { allowed: true };

    // Check cache
    const cached = cache.get(orgId);
    const now = Date.now();
    let ranges: ParsedCIDR[];

    if (cached && cached.expiry > now) {
      ranges = cached.ranges;
    } else {
      // Load from DB — fail closed per CLAUDE.md
      const rows = yield* Effect.tryPromise({
        try: () => internalQuery<{ cidr: string; [key: string]: unknown }>(
          `SELECT cidr FROM ip_allowlist WHERE org_id = $1`,
          [orgId],
        ),
        catch: (err) => {
          log.error(
            { err: err instanceof Error ? err.message : String(err), orgId },
            "Failed to load IP allowlist — blocking request (fail-closed)",
          );
          return err instanceof Error ? err : new Error(String(err));
        },
      });
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
    }

    // No entries = no restriction (opt-in)
    if (ranges.length === 0) return { allowed: true };

    // No client IP available = cannot verify, deny
    if (!clientIP) return { allowed: false };

    return { allowed: isIPAllowed(clientIP, ranges) };
  });
