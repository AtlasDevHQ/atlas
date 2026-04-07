/**
 * Shared DNS TXT domain verification utility.
 *
 * Used by both SSO domain verification (ee/src/auth/sso.ts) and custom
 * domain ownership verification (ee/src/platform/domains.ts) to prove
 * domain ownership via DNS TXT records. Custom domains also use Railway's
 * CNAME-based verification for DNS routing — DNS TXT is additive,
 * proving ownership independently.
 *
 * Token format: `atlas-verify=<uuid>`
 * Verification: DNS TXT lookup on the domain itself (not a subdomain),
 * with configurable timeout. Returns structured result.
 */

import { Effect } from "effect";
import dns from "node:dns";
import crypto from "node:crypto";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("ee:domain-verification");

// ── Types ──────────────────────────────────────────────────────────

export interface DnsTxtResult {
  readonly ok: true;
  readonly records: string[];
}

export interface DnsTxtFailure {
  readonly ok: false;
  readonly reason: "dns_error" | "no_match" | "timeout";
  readonly message: string;
  readonly records: string[];
}

export type DnsTxtVerificationResult = DnsTxtResult | DnsTxtFailure;

// ── Typed timeout sentinel ─────────────────────────────────────────

class DnsTimeoutError extends Error {
  readonly _tag = "DnsTimeoutError";
  constructor() { super("DNS lookup timed out"); }
}

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
 * Performs a DNS TXT lookup with a configurable timeout via `timeoutMs`
 * (default 10,000ms / 10s). TXT records are flattened (multi-part records
 * joined) before comparison. Returns a structured result with the error
 * encoded in the success channel (Effect error channel is `never`).
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
        onTimeout: () => new DnsTimeoutError(),
      }),
      Effect.map((records) => ({ ok: true as const, records })),
      Effect.catchAll((err) => {
        const reason = err instanceof DnsTimeoutError ? "timeout" as const : "dns_error" as const;
        log.warn({ domain, err: err.message, reason }, "DNS TXT lookup failed");
        return Effect.succeed({ ok: false as const, reason, message: err.message });
      }),
    );

    if (!dnsResult.ok) {
      return {
        ok: false as const,
        reason: dnsResult.reason,
        message: `DNS lookup failed for ${domain}: ${dnsResult.message}`,
        records: [] as string[],
      };
    }

    // Flatten multi-part TXT records (DNS splits long values into 255-byte chunks)
    const flatRecords = dnsResult.records.map((parts) => parts.join(""));
    const found = flatRecords.some((record) => record === expectedToken);

    if (found) {
      return {
        ok: true as const,
        records: flatRecords,
      };
    }

    return {
      ok: false as const,
      reason: "no_match" as const,
      message: `No matching TXT record found. Add a TXT record with value "${expectedToken}" to ${domain}.`,
      records: flatRecords,
    };
  });
