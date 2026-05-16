/**
 * Better Auth sign-in + 2FA helpers — runtime-agnostic.
 *
 * Both callers (Bun script via `fetch`, Playwright spec via
 * `APIRequestContext`) provide a small HTTP shim so the auth flow logic
 * lives in one place. The shim is `(path, init) => Promise<Reply>`; see
 * `BunHttpShim` / `PlaywrightHttpShim` in the call sites for
 * concrete adapters.
 */

import { totp, TOTP_CLOCK_SKEW_OFFSETS } from "./totp";

export interface HttpReply<T = unknown> {
  status: number;
  body: T | null;
  rawText?: string;
}

export interface HttpRequestInit {
  method: "GET" | "POST";
  /** Additional headers; the shim sets origin + content-type as needed. */
  headers?: Record<string, string>;
  body?: unknown;
}

export type HttpShim = <T = unknown>(path: string, init: HttpRequestInit) => Promise<HttpReply<T>>;

export interface SignInResult {
  /** Which password from the candidate list succeeded — needed for rotation. */
  password: string;
  /** Body of the sign-in/email response. May carry twoFactorRedirect. */
  body: { twoFactorRedirect?: boolean; user?: { id: string }; token?: string };
}

/**
 * Try each candidate password in order until one returns 200. Surfaces
 * the original 401-only retry pattern: `401` falls through to the next
 * password; any other non-200 short-circuits with a thrown error so the
 * caller doesn't paper over a real failure (5xx, rate limit).
 */
export async function signInWithPassword(
  shim: HttpShim,
  email: string,
  passwords: readonly string[],
): Promise<SignInResult> {
  let lastError: string | null = null;
  // Track which candidate failed by *position* (1-based), never by value
  // — CodeQL's clear-text-logging taint analysis flags any password
  // derivative reaching a log sink, even a partial redact like
  // `password.slice(0, 3)`. The candidate count is enough to debug
  // (e.g. "all 2 candidates 401'd" → check ATLAS_ADMIN_PASSWORD).
  for (let i = 0; i < passwords.length; i++) {
    const password = passwords[i]!;
    const r = await shim<SignInResult["body"]>("/api/auth/sign-in/email", {
      method: "POST",
      body: { email, password },
    });
    if (r.status === 200 && r.body) {
      return { password, body: r.body };
    }
    if (r.status !== 401) {
      lastError = `${r.status}: ${r.rawText ?? "<no body>"}`;
      break;
    }
    lastError = `401 on candidate ${i + 1}/${passwords.length}`;
  }
  throw new Error(
    `Sign-in failed for ${email} — last error: ${lastError ?? "unknown"}. ` +
      `Tip: if you just ran \`bun run db:reset\`, delete \`.atlas/mfa-secret\` and re-seed.`,
  );
}

/**
 * Satisfy a 2FA challenge by computing a TOTP from the saved secret and
 * trying it across a small clock-skew window. Returns the verify
 * response so the caller can extract any rotated session token.
 */
export async function satisfyTotpChallenge<T = unknown>(
  shim: HttpShim,
  secret: string,
): Promise<HttpReply<T>> {
  let lastReply: HttpReply<T> | null = null;
  for (const offset of TOTP_CLOCK_SKEW_OFFSETS) {
    const code = totp(secret, Math.floor(Date.now() / 1000) + offset);
    const r = await shim<T>("/api/auth/two-factor/verify-totp", {
      method: "POST",
      body: { code, trustDevice: true },
    });
    if (r.status === 200) return r;
    lastReply = r;
  }
  throw new Error(
    `two-factor/verify-totp failed for all clock-skew offsets ` +
      `(last status ${lastReply?.status ?? "?"}: ${lastReply?.rawText ?? "<no body>"}). ` +
      `Likely causes: the saved secret is for a different user (did you \`bun run db:reset\` ` +
      `without re-running \`bun scripts/seed-multi-env.ts\`?), or the API and runner clocks ` +
      `drifted by more than 30 seconds.`,
  );
}
