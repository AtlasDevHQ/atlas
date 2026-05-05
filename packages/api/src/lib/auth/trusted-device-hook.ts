/**
 * Better Auth `databaseHooks.verification.create.after` handler that
 * captures device metadata for trust grants.
 *
 * The 2FA plugin writes `{ identifier: "trust-device-<rand>", value: userId,
 * expiresAt }` to the verification table when the user opts in to "trust this
 * browser" on the sign-in challenge. Better Auth has no slot for the data the
 * admin trusted-browsers list needs — userAgent, IP, a human label — so we
 * mirror those columns into `trusted_device` keyed on the same identifier.
 *
 * The hook is fire-and-forget: it MUST NOT throw. A metadata-write failure
 * would otherwise abort the auth flow on the user's NEXT request (Better Auth
 * awaits queueAfterTransactionHook results and rethrows). Auth correctness >
 * our metadata. The DB write goes through `internalExecute` which is `void`,
 * participates in the shared circuit breaker (5-failure trip → exponential
 * recovery), and logs each error itself — the outer try/catch here exists
 * only to defend against unexpected throws in the metadata-extraction path
 * (UA parsing, header reads).
 *
 * Cookie rotation (Better Auth re-issues `trust-device-<new>` on every sign-in
 * within the trust window): the new identifier flows in as a separate INSERT
 * with a fresh `created_at`. The previous row's identifier no longer matches
 * a verification row and falls out of the admin list at read time (the join
 * filters on `verification.identifier`). Merging rotated rows to preserve the
 * original `created_at` is a known follow-up.
 */

import { internalExecute } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { deriveDeviceLabel } from "@atlas/api/lib/auth/device-label";

const log = createLogger("auth:trusted-device-hook");

const TRUST_DEVICE_PREFIX = "trust-device-";

/**
 * Read the leftmost entry from `x-forwarded-for: a, b, c` (or `x-real-ip`).
 * No private-range filtering — operators are expected to configure their
 * ingress to strip spoofed prefixes. The leftmost XFF entry is the original
 * client claim by RFC convention.
 */
function extractClientIp(headers: Headers | undefined): string | null {
  if (!headers) return null;
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = headers.get("x-real-ip");
  return real?.trim() || null;
}

/** Shape of the row Better Auth's `verification.create.after` hook receives. */
export interface VerificationCreateRecord {
  identifier?: unknown;
  value?: unknown;
  // other fields exist (createdAt, expiresAt, ...) but we don't read them here
  [key: string]: unknown;
}

/** Hook context shape we read — both fields are Partial in Better Auth's types. */
export interface VerificationHookCtx {
  headers?: Headers;
  request?: Request;
  // other fields exist on AuthEndpointContext; we don't need them
}

/**
 * Insert a `trusted_device` row when the verification row was created for a
 * trust-device cookie. No-op for every other verification flow (email verify,
 * password reset, 2FA challenge cookie, magic link, etc.) — those identifiers
 * don't carry the `trust-device-` prefix.
 *
 * Idempotent on `identifier` — `ON CONFLICT DO NOTHING` covers the case where
 * a hook fires twice for the same row (defensive; with-hooks shouldn't, but a
 * test layer or a Better Auth regression would surface as a duplicate-key
 * error otherwise).
 */
export async function onVerificationCreated(
  record: VerificationCreateRecord | null | undefined,
  ctx: VerificationHookCtx | null | undefined,
): Promise<void> {
  try {
    if (!record) return;
    const identifier = typeof record.identifier === "string" ? record.identifier : null;
    if (!identifier || !identifier.startsWith(TRUST_DEVICE_PREFIX)) return;

    const userId = typeof record.value === "string" ? record.value : null;
    if (!userId) {
      // A trust-device row without a userId would be a Better Auth bug, but
      // failing closed (no row written) is safer than guessing.
      log.warn(
        { identifier },
        "trust-device verification row had non-string `value`; skipping metadata write",
      );
      return;
    }

    const headers = ctx?.headers ?? undefined;
    const userAgent = headers?.get("user-agent") ?? null;
    const ip = extractClientIp(headers);
    const deviceLabel = userAgent ? deriveDeviceLabel(userAgent) : null;

    // `internalExecute` is void — it never rejects. The shared circuit breaker
    // logs failures and trips after 5 consecutive errors. The hook can return
    // immediately; the actual INSERT runs on the pool's next available worker.
    internalExecute(
      `INSERT INTO trusted_device (identifier, user_id, user_agent, ip_address, device_label)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (identifier) DO NOTHING`,
      [identifier, userId, userAgent, ip, deviceLabel],
    );

    log.debug(
      { identifier, userId, hasUa: !!userAgent, hasIp: !!ip },
      "trust-device metadata queued",
    );
  } catch (err) {
    // Reaches here only if extractClientIp / deriveDeviceLabel / a record-shape
    // narrow throws unexpectedly. The DB write itself is fire-and-forget and
    // logs its own errors via internalExecute's circuit breaker.
    log.warn(
      { err: errorMessage(err) },
      "trust-device metadata extraction failed — admin list may be missing this device until next rotation",
    );
  }
}
