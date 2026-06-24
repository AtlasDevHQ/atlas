/**
 * Demo mode — email-gated public demo with lead capture.
 *
 * Token mechanism: HMAC-SHA256 signed payload (email + expiry).
 * Conversations persisted with synthetic user ID: "demo:<email_hash>".
 * Separate rate limiter from the main auth flow.
 */

import * as crypto from "crypto";
import { Effect } from "effect";
import { createLogger } from "@atlas/api/lib/logger";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { SaasCrm } from "@atlas/api/lib/effect/services";
import { runEnterprise } from "@atlas/api/lib/effect/enterprise-layer";
import { getSettingAuto } from "@atlas/api/lib/settings";
import { getDefaultProvider, getModelForConfig } from "@atlas/api/lib/providers";
import type { AtlasAiModelShape } from "@atlas/api/lib/effect/ai";

const log = createLogger("demo");

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

/** Whether demo mode is enabled (ATLAS_DEMO_ENABLED=true). */
export function isDemoEnabled(): boolean {
  return process.env.ATLAS_DEMO_ENABLED === "true";
}

const DEMO_DEFAULT_MAX_STEPS = 10;
const DEMO_DEFAULT_RPM = 10;
const DEMO_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

let lastWarnedDemoMaxSteps: string | undefined;

/** Max agent steps for demo sessions. Default 10. */
export function getDemoMaxSteps(): number {
  // Platform-scoped settings registry (#3705): DB override > env > default.
  const raw = getSettingAuto("ATLAS_DEMO_MAX_STEPS") ?? String(DEMO_DEFAULT_MAX_STEPS);
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1 || n > 100) {
    if (raw !== lastWarnedDemoMaxSteps) {
      log.warn({ value: raw }, `Invalid ATLAS_DEMO_MAX_STEPS; using default ${DEMO_DEFAULT_MAX_STEPS}`);
      lastWarnedDemoMaxSteps = raw;
    }
    return DEMO_DEFAULT_MAX_STEPS;
  }
  return n;
}

let lastWarnedDemoRpm: string | undefined;

/** Requests per minute for demo users. Default 10. 0 = disabled. */
export function getDemoRpmLimit(): number {
  // Platform-scoped settings registry (#3705): DB override > env > default.
  const raw = getSettingAuto("ATLAS_DEMO_RATE_LIMIT_RPM") ?? String(DEMO_DEFAULT_RPM);
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    if (raw !== lastWarnedDemoRpm) {
      log.warn({ value: raw }, `Invalid ATLAS_DEMO_RATE_LIMIT_RPM; using default ${DEMO_DEFAULT_RPM}`);
      lastWarnedDemoRpm = raw;
    }
    return DEMO_DEFAULT_RPM;
  }
  return Math.floor(n);
}

/**
 * Default demo model on the gateway (SaaS) — Haiku, the cheapest tier. The
 * curated NovaMart demo dataset de-risks a cheaper model on the top-of-funnel
 * path. Keep in lockstep with the starter plan's `defaultModel`
 * (`billing/plans.ts`) — both are the cheap gateway-Haiku default.
 */
const DEMO_DEFAULT_GATEWAY_MODEL = "anthropic/claude-haiku-4.5";

/**
 * Resolve the model id demo turns should run on, or `null` to use the platform
 * default. (#3931)
 *
 * - `ATLAS_DEMO_MODEL` set (non-blank) → that model id, verbatim.
 * - Unset + resolved provider is the gateway (SaaS) → the cheap Haiku gateway
 *   model {@link DEMO_DEFAULT_GATEWAY_MODEL}.
 * - Unset + non-gateway (self-hosted / BYO) → `null`: fall back to the platform
 *   default, so a gateway-only model id can never break a non-gateway deploy.
 *
 * Provider resolution mirrors `providers.ts:resolveSelection`
 * (`ATLAS_PROVIDER ?? getDefaultProvider()`) so the demo default tracks the
 * same provider the platform would pick. Hot-reloadable: read per demo turn.
 */
export function getDemoModelId(): string | null {
  // Platform-scoped settings registry (#3705): DB override > env > default ("").
  const configured = getSettingAuto("ATLAS_DEMO_MODEL")?.trim();
  if (configured) return configured;

  const provider = process.env.ATLAS_PROVIDER ?? getDefaultProvider();
  return provider === "gateway" ? DEMO_DEFAULT_GATEWAY_MODEL : null;
}

/**
 * The `runAgent` params fragment that injects the demo model: `{ aiModel }`
 * when a demo model resolves, else `{}` so `runAgent` resolves the platform
 * default. Spread into the `runAgent({ ... })` call so the inject-or-omit
 * decision is one testable unit rather than an inline ternary. (#3931)
 *
 * Passing `aiModel` makes the demo model authoritative, so `token_usage.model`
 * / `provider` reflect it. Resolution failures propagate to the caller (the
 * demo route's `classifyDemoError` maps a missing gateway key / unknown model
 * to the same structured provider error the platform path raises) rather than
 * silently falling back to a different — billed — model.
 */
export function demoRunAgentModelParams(): { aiModel?: AtlasAiModelShape } {
  const modelId = getDemoModelId();
  if (!modelId) return {};
  return { aiModel: getModelForConfig(undefined, modelId) };
}

/**
 * Raw `ATLAS_DEMO_MODEL` override exactly as configured (blank = use the
 * resolved default). Distinct from {@link getDemoModelId}, which resolves the
 * blank case to the gateway Haiku default / platform default. The platform
 * demo config form edits this raw value. (#3931)
 */
export function getDemoModelRaw(): string {
  return getSettingAuto("ATLAS_DEMO_MODEL") ?? "";
}

/**
 * Snapshot of the demo runtime config for the /platform/demo tracking page
 * (#3931). `model` is the raw editable override; `effectiveModel` is what it
 * resolves to right now (override → gateway Haiku on SaaS → null on a
 * non-gateway deploy, meaning the platform default). Co-located with the other
 * demo getters so the page's config half reads from one place.
 */
export function getDemoConfig(): {
  model: string;
  maxSteps: number;
  rpm: number;
  effectiveModel: string | null;
} {
  return {
    model: getDemoModelRaw(),
    maxSteps: getDemoMaxSteps(),
    rpm: getDemoRpmLimit(),
    effectiveModel: getDemoModelId(),
  };
}

// ---------------------------------------------------------------------------
// Token signing / verification
// ---------------------------------------------------------------------------

/**
 * Derive the HMAC key for demo tokens. Uses BETTER_AUTH_SECRET with a
 * ":demo" suffix to avoid collision with other derived keys.
 */
function getDemoKey(): Buffer | null {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) return null;
  return crypto.createHash("sha256").update(secret + ":demo").digest();
}

function base64urlEncode(data: Buffer | string): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  return buf.toString("base64url");
}

function base64urlDecode(str: string): Buffer {
  return Buffer.from(str, "base64url");
}

interface DemoTokenPayload {
  email: string;
  exp: number;
}

/**
 * Sign a demo token for the given email.
 * Returns the token string, or null if no signing key is available.
 */
export function signDemoToken(email: string): { token: string; expiresAt: number } | null {
  const key = getDemoKey();
  if (!key) {
    log.error("Cannot sign demo token: BETTER_AUTH_SECRET is not set");
    return null;
  }

  const normalized = email.toLowerCase().trim();
  const exp = Date.now() + DEMO_TOKEN_TTL_MS;
  const payload: DemoTokenPayload = { email: normalized, exp };
  const payloadStr = base64urlEncode(JSON.stringify(payload));
  const signature = crypto.createHmac("sha256", key).update(payloadStr).digest();
  const signatureStr = base64urlEncode(signature);

  return {
    token: `${payloadStr}.${signatureStr}`,
    expiresAt: exp,
  };
}

/**
 * Verify a demo token and extract the email.
 * Returns the email on success, null on failure (expired, tampered, malformed).
 */
export function verifyDemoToken(token: string): string | null {
  const key = getDemoKey();
  if (!key) {
    log.warn("Cannot verify demo token: BETTER_AUTH_SECRET is not set");
    return null;
  }

  const parts = token.split(".");
  if (parts.length !== 2) {
    // Active-attack signal: a non-empty Bearer header that doesn't even
    // match the demo-token shape. Probe traffic is worth seeing in logs.
    log.warn({ partsCount: parts.length }, "Demo token rejected — malformed structure");
    return null;
  }

  const [payloadStr, signatureStr] = parts;

  // Recompute signature and compare in constant time
  const expectedSig = crypto.createHmac("sha256", key).update(payloadStr).digest();
  let actualSig: Buffer;
  try {
    actualSig = base64urlDecode(signatureStr);
  } catch {
    // intentionally ignored: malformed base64 in signature — reject token
    return null;
  }

  if (expectedSig.length !== actualSig.length) return null;
  if (!crypto.timingSafeEqual(expectedSig, actualSig)) {
    // Active-attack signal: token structure is valid but signature does
    // not match the server's HMAC key. This is the bright-line "tampered"
    // event security ops should be able to see.
    log.warn("Demo token rejected — signature mismatch");
    return null;
  }

  // Parse payload
  let payload: DemoTokenPayload;
  try {
    const decoded = base64urlDecode(payloadStr).toString("utf8");
    payload = JSON.parse(decoded) as DemoTokenPayload;
  } catch {
    // intentionally ignored: malformed or unparseable payload JSON — reject token
    return null;
  }

  if (typeof payload.email !== "string" || typeof payload.exp !== "number") return null;
  if (payload.exp < Date.now()) return null;

  return payload.email;
}

// ---------------------------------------------------------------------------
// User ID helper
// ---------------------------------------------------------------------------

/** Deterministic user ID for demo conversations. Hashed to avoid PII. */
export function demoUserId(email: string): string {
  const normalized = email.toLowerCase().trim();
  const hash = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `demo:${hash}`;
}

// ---------------------------------------------------------------------------
// Demo rate limiter (separate from main rate limiter)
// ---------------------------------------------------------------------------

const WINDOW_MS = 60_000;
const demoWindows = new Map<string, number[]>();

/**
 * Sliding-window rate limit for demo users.
 * Returns `{ allowed: true }` or `{ allowed: false, retryAfterMs }`.
 */
export function checkDemoRateLimit(email: string): {
  allowed: boolean;
  retryAfterMs?: number;
} {
  const limit = getDemoRpmLimit();
  if (limit === 0) return { allowed: true };

  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const key = demoUserId(email);

  let timestamps = demoWindows.get(key);
  if (!timestamps) {
    timestamps = [];
    demoWindows.set(key, timestamps);
  }

  // Evict stale entries
  const firstValid = timestamps.findIndex((t) => t > cutoff);
  if (firstValid > 0) timestamps.splice(0, firstValid);
  else if (firstValid === -1) timestamps.length = 0;

  if (timestamps.length < limit) {
    timestamps.push(now);
    return { allowed: true };
  }

  const retryAfterMs = Math.max(1, timestamps[0] + WINDOW_MS - now);
  return { allowed: false, retryAfterMs };
}

/** Clear demo rate limit state. For tests. */
export function resetDemoRateLimits(): void {
  demoWindows.clear();
}

/** Interval for demo rate-limit cleanup. Exported for SchedulerLayer. */
export const DEMO_CLEANUP_INTERVAL_MS = WINDOW_MS;

/**
 * Evict stale demo rate-limit entries. Called periodically by the
 * SchedulerLayer fiber in lib/effect/layers.ts.
 */
export function demoCleanupTick(): void {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [key, timestamps] of demoWindows) {
    if (timestamps.length === 0 || timestamps[timestamps.length - 1] <= cutoff) {
      demoWindows.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Lead capture
// ---------------------------------------------------------------------------

export interface DemoLeadResult {
  returning: boolean;
  sessionCount: number;
}

/** Same pattern used in the /demo route to mask emails before logging. */
function maskEmailForLog(email: string): string {
  return email.replace(/(.{2}).*(@.*)/, "$1***$2");
}

/**
 * Capture or update a demo lead in the internal DB.
 * Returns whether this is a returning user and their session count.
 */
export async function captureDemoLead(opts: {
  email: string;
  ip?: string | null;
  userAgent?: string | null;
  /** Request correlation ID — included on every log emitted by this function. */
  requestId?: string;
}): Promise<DemoLeadResult> {
  const email = opts.email.toLowerCase().trim();
  const emailMasked = maskEmailForLog(email);
  const { requestId } = opts;

  if (!hasInternalDB()) {
    log.debug({ requestId, emailMasked }, "No internal DB — demo lead not captured");
    return { returning: false, sessionCount: 1 };
  }

  let result: DemoLeadResult;
  try {
    // Try to insert; on conflict update last_active_at and bump session_count
    const rows = await internalQuery(
      `INSERT INTO demo_leads (email, ip_address, user_agent)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE
         SET last_active_at = now(),
             session_count = demo_leads.session_count + 1,
             ip_address = COALESCE(EXCLUDED.ip_address, demo_leads.ip_address),
             user_agent = COALESCE(EXCLUDED.user_agent, demo_leads.user_agent)
       RETURNING session_count`,
      [email, opts.ip ?? null, opts.userAgent ?? null],
    );

    const sessionCount = (rows[0] as { session_count: number } | undefined)?.session_count ?? 1;
    result = { returning: sessionCount > 1, sessionCount };
  } catch (err) {
    log.error(
      {
        requestId,
        emailMasked,
        err: err instanceof Error ? err : new Error(String(err)),
      },
      "Failed to capture demo lead — lead data lost. Check that demo_leads table exists (run migrations)",
    );
    result = { returning: false, sessionCount: 1 };
  }

  // SaaS CRM dispatch via the SaasCrm Tag. Self-hosted resolves to
  // NoopSaasCrmLayer (no Twenty traffic). Atlas SaaS resolves to
  // SaasCrmLive which dispatches via TwentyClient — failures are
  // swallowed inside the layer so a Twenty outage never blocks the
  // demo response.
  try {
    await runEnterprise(
      Effect.gen(function* () {
        const crm = yield* SaasCrm;
        yield* crm.upsertLead({
          source: "demo",
          email,
          ip: opts.ip,
          userAgent: opts.userAgent,
        });
      }),
    );
  } catch (err) {
    // SaasCrm.upsertLead has no error channel today; catch guards against future Tag-shape widening + runPromise defects.
    log.warn(
      {
        requestId,
        emailMasked,
        err: err instanceof Error ? err.message : String(err),
      },
      "Unexpected SaasCrm dispatch error — swallowed to keep demo response unblocked",
    );
  }

  return result;
}

/**
 * Count conversations for a demo user.
 */
export async function countDemoConversations(email: string): Promise<number> {
  if (!hasInternalDB()) return 0;

  const userId = demoUserId(email);
  try {
    const rows = await internalQuery(
      `SELECT COUNT(*)::int AS count FROM conversations WHERE user_id = $1 AND surface = 'demo' AND deleted_at IS NULL`,
      [userId],
    );
    return (rows[0] as { count: number } | undefined)?.count ?? 0;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to count demo conversations",
    );
    return 0;
  }
}
