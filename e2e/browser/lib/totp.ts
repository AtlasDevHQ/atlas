/**
 * Minimal RFC 6238 TOTP — SHA-1, 6 digits, 30-second step.
 *
 * Shared between `scripts/seed-multi-env.ts` (Bun script) and
 * `e2e/browser/multi-env-tracer.spec.ts` (Playwright spec) so both
 * callers compute codes against the same algorithm. Pure helpers —
 * no Playwright / Bun deps so either runtime can import this.
 */

import { createHmac } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, "").toUpperCase();
  const bits: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`Invalid base32 char: ${ch}`);
    for (let i = 4; i >= 0; i--) bits.push((idx >> i) & 1);
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]!;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Returns a 6-digit code as a zero-padded string. */
export function totp(secret: string, atSeconds: number = Math.floor(Date.now() / 1000)): string {
  const counter = Math.floor(atSeconds / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", base32Decode(secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code =
    (((hmac[offset]! & 0x7f) << 24) |
      ((hmac[offset + 1]! & 0xff) << 16) |
      ((hmac[offset + 2]! & 0xff) << 8) |
      (hmac[offset + 3]! & 0xff)) %
    1_000_000;
  return code.toString().padStart(6, "0");
}

/** Parse the `secret=...` param out of an otpauth URI. */
export function secretFromOtpAuthUri(uri: string): string {
  const match = uri.match(/[?&]secret=([^&]+)/i);
  if (!match) throw new Error(`Could not parse secret from otpauth URI: ${uri.slice(0, 60)}...`);
  return decodeURIComponent(match[1]!);
}

/**
 * Clock-skew offsets to try in sequence when satisfying a 2FA challenge.
 * Covers ±30s of drift between the test runner and the API container.
 */
export const TOTP_CLOCK_SKEW_OFFSETS: readonly number[] = [0, -30, 30];
