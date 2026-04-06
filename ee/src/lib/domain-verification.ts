/**
 * Shared DNS TXT domain verification utility.
 *
 * Used by SSO domain verification (ee/src/auth/sso.ts) to prove domain
 * ownership via DNS TXT records. Custom domains (ee/src/platform/domains.ts)
 * use Railway's CNAME/cert verification instead, but could adopt this
 * utility for additional ownership proof in the future.
 *
 * Token format: `atlas-verify=<uuid>`
 * Verification: DNS TXT lookup with timeout, returns structured result.
 */

import { Effect } from "effect";
import dns from "node:dns";
import crypto from "node:crypto";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("ee:domain-verification");

// ── Types ──────────────────────────────────────────────────────────

export type DomainVerificationStatus = "pending" | "verified" | "failed";

export interface DnsTxtResult {
  readonly ok: true;
  readonly verified: true;
  readonly records: string[];
}

export interface DnsTxtFailure {
  readonly ok: false;
  readonly verified: false;
  readonly reason: "dns_error" | "no_match" | "timeout";
  readonly message: string;
  readonly records?: string[];
}

export type DnsTxtVerificationResult = DnsTxtResult | DnsTxtFailure;

// ── Token generation ───────────────────────────────────────────────

const TOKEN_PREFIX = "atlas-verify=";

/**
 * Generate a DNS TXT verification token for domain ownership proof.
 * Returns a token in the format `atlas-verify=<uuid>` that the admin
 * must add as a TXT record on their domain.
 */
export function generateVerificationToken(): string {
  return `${TOKEN_PREFIX}${crypto.randomUUID()}`;
}

// ── DNS TXT verification ───────────────────────────────────────────

/**
 * Verify domain ownership by checking DNS TXT records for the expected token.
 *
 * Performs a DNS TXT lookup with a configurable timeout (default 10s).
 * TXT records are flattened (multi-part records joined) before comparison.
 * Returns a structured result — never throws.
 */
export const verifyDnsTxt = (
  domain: string,
  expectedToken: string,
  timeoutMs = 10_000,
): Effect.Effect<DnsTxtVerificationResult, never> =>
  Effect.gen(function* () {
    const dnsResult = yield* Effect.tryPromise({
      try: () => dns.promises.resolveTxt(domain),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    }).pipe(
      Effect.timeoutFail({
        duration: `${timeoutMs} millis`,
        onTimeout: () => new Error("DNS lookup timed out"),
      }),
      Effect.map((records) => ({ ok: true as const, records })),
      Effect.catchAll((err) => {
        log.warn({ domain, err: err.message }, "DNS TXT lookup failed");
        return Effect.succeed({
          ok: false as const,
          reason: err.message.includes("timed out") ? "timeout" as const : "dns_error" as const,
          message: err.message,
        });
      }),
    );

    if (!dnsResult.ok) {
      return {
        ok: false as const,
        verified: false as const,
        reason: dnsResult.reason,
        message: `DNS lookup failed for ${domain}: ${dnsResult.message}`,
      };
    }

    // Flatten multi-part TXT records (DNS splits long values into 255-byte chunks)
    const flatRecords = dnsResult.records.map((parts) => parts.join(""));
    const found = flatRecords.some((record) => record === expectedToken);

    if (found) {
      return {
        ok: true as const,
        verified: true as const,
        records: flatRecords,
      };
    }

    return {
      ok: false as const,
      verified: false as const,
      reason: "no_match" as const,
      message: `No matching TXT record found. Add a TXT record with value "${expectedToken}" to ${domain}.`,
      records: flatRecords,
    };
  });
