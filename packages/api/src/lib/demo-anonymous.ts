/**
 * The anonymous demo principal (#5604) — the MCP front door answers before it
 * asks for an email.
 *
 * Every demo path used to be email-gated: the email keyed the demo JWT, the
 * per-identity rate limit and the lead capture. That is the right gate for the
 * web demo and the wrong one for an MCP client, which has no form to put an
 * email in. This module mints a principal that is NOT an email:
 *
 *   - **Minted per client.** `startAnonymousDemoSession` inserts one row in
 *     `demo_anonymous_sessions` and the row's id IS the identity. The token is
 *     an HMAC-signed `{ sid, ws, exp }` under its own derived key
 *     (`deriveDemoKey("demo-anon")`), so it can never verify as an email demo
 *     token and an email demo token can never verify here.
 *   - **Scoped to the demo workspace only.** The workspace is resolved by SLUG
 *     from the settings registry (`ATLAS_DEMO_WORKSPACE_SLUG`), never from the
 *     request. The principal carries that org as `activeOrganizationId`, which
 *     is what `searchAtlas` and `executeSQL` key on — and nothing else. The
 *     token also pins the workspace it was minted for, and the MCP edge refuses
 *     a token whose pin disagrees with the current resolution (fail closed).
 *   - **Less reach than the email demo, never more** — on tool surface, role
 *     and lifetime. `member` role, no `mcp:write`, and the MCP surface
 *     registers exactly two read tools plus the optional email hand-off. The
 *     ACL sees a principal with no member row, so only `org`-granted facts are
 *     visible. (The one asymmetry: the web demo's principal is bound to no
 *     workspace and cannot search the Atlas at all; this one can, for the demo
 *     workspace — the capability this door exists to ship.)
 *   - **Rate limited twice.** Per client IP (session mints and tool calls
 *     share the bucket) and per minted identity (tool calls). Both budgets are
 *     settings-registry entries, hot-reloadable.
 *   - **No raw IPs at rest.** The session row stores an HMAC of the IP under
 *     `deriveDemoKey("demo-ip")`, enough to count distinct sources and to see a
 *     single source minting in bulk, and nothing that identifies a visitor.
 *   - **Email capture is optional and AFTER the first answer.** A session with
 *     `answer_count = 0` cannot hand over an email at all — the lead capture
 *     moves from a precondition to an explicit, later act.
 *
 * The launch-cycle gate reads this table directly:
 * `SELECT count(*) FROM demo_anonymous_sessions WHERE created_at >= <date>` —
 * so `id` and `created_at` are load-bearing column names.
 */

import * as crypto from "crypto";
import { createLogger } from "@atlas/api/lib/logger";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { getSettingAuto } from "@atlas/api/lib/settings";
import { createAtlasUser, type AtlasUser } from "@atlas/api/lib/auth/types";
import {
  captureDemoLead,
  deriveDemoKey,
  signDemoPayload,
  verifyDemoPayload,
} from "@atlas/api/lib/demo";
import {
  createSlidingWindowLimiter,
  RATE_LIMIT_WINDOW_MS,
} from "@atlas/api/lib/sliding-window-rate-limit";

const log = createLogger("demo-anonymous");

// ---------------------------------------------------------------------------
// Settings (platform-scoped, hot-reloadable; literal keys for check-settings-readers R1)
// ---------------------------------------------------------------------------

const DEFAULT_WORKSPACE_SLUG = "novamart-demo";
const DEFAULT_IP_RPM = 20;
const DEFAULT_IDENTITY_RPM = 10;
const DEFAULT_TOKEN_TTL_MINUTES = 120;
const MAX_TOKEN_TTL_MINUTES = 24 * 60;

const warnedInvalid = new Map<string, string>();

function parseNonNegativeInt(raw: string | undefined, fallback: number, key: string): number {
  const value = raw ?? String(fallback);
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    if (warnedInvalid.get(key) !== value) {
      log.warn({ value, key }, `Invalid ${key}; using default ${fallback}`);
      warnedInvalid.set(key, value);
    }
    return fallback;
  }
  return Math.floor(n);
}

/** Slug of the one organization the anonymous principal may reach. */
export function getDemoWorkspaceSlug(): string {
  const raw = getSettingAuto("ATLAS_DEMO_WORKSPACE_SLUG")?.trim();
  return raw && raw.length > 0 ? raw : DEFAULT_WORKSPACE_SLUG;
}

/** Anonymous-demo requests per minute per client IP. Default 20. 0 = disabled. */
export function getAnonymousDemoIpRpmLimit(): number {
  return parseNonNegativeInt(
    getSettingAuto("ATLAS_DEMO_ANON_IP_RATE_LIMIT_RPM"),
    DEFAULT_IP_RPM,
    "ATLAS_DEMO_ANON_IP_RATE_LIMIT_RPM",
  );
}

/** Tool calls per minute per minted identity. Default 10. 0 = disabled. */
export function getAnonymousDemoIdentityRpmLimit(): number {
  return parseNonNegativeInt(
    getSettingAuto("ATLAS_DEMO_ANON_RATE_LIMIT_RPM"),
    DEFAULT_IDENTITY_RPM,
    "ATLAS_DEMO_ANON_RATE_LIMIT_RPM",
  );
}

/** Token lifetime in milliseconds. Default 2h; clamped to 1 minute … 24 hours. */
export function getAnonymousDemoTokenTtlMs(): number {
  const key = "ATLAS_DEMO_ANON_TOKEN_TTL_MINUTES";
  const raw = getSettingAuto(key) ?? String(DEFAULT_TOKEN_TTL_MINUTES);
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > MAX_TOKEN_TTL_MINUTES) {
    if (warnedInvalid.get(key) !== raw) {
      log.warn({ value: raw, key }, `Invalid ${key}; using default ${DEFAULT_TOKEN_TTL_MINUTES}`);
      warnedInvalid.set(key, raw);
    }
    return DEFAULT_TOKEN_TTL_MINUTES * 60_000;
  }
  return Math.floor(n) * 60_000;
}

// ---------------------------------------------------------------------------
// Principal
// ---------------------------------------------------------------------------

/**
 * Prefix of the OAuth-client stand-in stamped on every anonymous dispatch
 * (`audit_log.client_id = 'demo-anonymous:<session id>'`). A NON-EMPTY client
 * id is load-bearing: `writeScopeDenied` and the per-client MCP rate limit
 * both treat an absent `clientId` as "stdio, exempt" — the anonymous principal
 * must never be exempt from either. Per SESSION rather than one shared label
 * so the per-client limiter keys each minted identity separately: one shared
 * id would put every demo visitor in a single bucket, and a launch-day crowd
 * would rate-limit itself.
 */
export const ANONYMOUS_DEMO_CLIENT_PREFIX = "demo-anonymous";

export function anonymousDemoClientId(sessionId: string): string {
  return `${ANONYMOUS_DEMO_CLIENT_PREFIX}:${sessionId}`;
}

/** The scopes an anonymous session carries: read, and only read. */
export const ANONYMOUS_DEMO_SCOPES: readonly string[] = ["mcp:read"];

export function anonymousDemoPrincipalId(sessionId: string): string {
  return `demo-anon:${sessionId}`;
}

/**
 * The bound actor for one anonymous session. `member`, never inferred from the
 * auth mode — `simple-key` would default to `admin` — and bound to the demo
 * workspace as `activeOrganizationId`, which is the ONLY workspace it names.
 */
export function anonymousDemoActor(sessionId: string, workspaceId: string): AtlasUser {
  const id = anonymousDemoPrincipalId(sessionId);
  return createAtlasUser(id, "managed", id, {
    role: "member",
    activeOrganizationId: workspaceId,
    claims: { sub: id, transport: "mcp", demo: "anonymous" },
  });
}

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

export interface AnonymousDemoTokenClaims {
  readonly sessionId: string;
  /** The workspace the token was minted for — re-checked at the MCP edge. */
  readonly workspaceId: string;
  readonly expiresAt: number;
}

export function signAnonymousDemoToken(
  sessionId: string,
  workspaceId: string,
  ttlMs: number = getAnonymousDemoTokenTtlMs(),
): { token: string; expiresAt: number } | null {
  const exp = Date.now() + ttlMs;
  const token = signDemoPayload({ kind: "anon", sid: sessionId, ws: workspaceId, exp }, "demo-anon");
  if (!token) return null;
  return { token, expiresAt: exp };
}

export function verifyAnonymousDemoToken(token: string): AnonymousDemoTokenClaims | null {
  const payload = verifyDemoPayload(token, "demo-anon");
  if (!payload) return null;
  if (payload.kind !== "anon") return null;
  if (typeof payload.sid !== "string" || payload.sid.length === 0) return null;
  if (typeof payload.ws !== "string" || payload.ws.length === 0) return null;
  return { sessionId: payload.sid, workspaceId: payload.ws, expiresAt: payload.exp };
}

// ---------------------------------------------------------------------------
// IP hashing — never a raw IP at rest
// ---------------------------------------------------------------------------

/**
 * Keyed hash of a client IP for the session row. `null` when the IP is unknown
 * (no trusted proxy) or no key can be derived — an unset `BETTER_AUTH_SECRET`
 * also means no token can be minted, so this never silently downgrades a live
 * session to "unhashed".
 */
export function hashDemoIp(ip: string | null): string | null {
  if (!ip) return null;
  const key = deriveDemoKey("demo-ip");
  if (!key) return null;
  return crypto.createHmac("sha256", key).update(ip).digest("hex");
}

// ---------------------------------------------------------------------------
// Demo workspace resolution — by slug, fail closed
// ---------------------------------------------------------------------------

export type DemoWorkspaceResolution =
  | { readonly ok: true; readonly id: string; readonly slug: string }
  | {
      readonly ok: false;
      readonly reason: "no_internal_db" | "not_found" | "lookup_failed";
    };

const WORKSPACE_CACHE_TTL_MS = 30_000;
let workspaceCache: { slug: string; id: string; until: number } | null = null;

/** Test seam — drop the resolved-workspace cache. */
export function _resetDemoWorkspaceCacheForTests(): void {
  workspaceCache = null;
}

/**
 * Resolve the demo workspace's id from its slug. Only a FOUND workspace is
 * cached (30s, matching the settings refresh window); every failure is
 * re-checked on the next call so an operator who fixes the slug is not stuck
 * behind a cached miss, and a workspace that disappears stops answering within
 * the window.
 */
export async function resolveDemoWorkspaceId(): Promise<DemoWorkspaceResolution> {
  const slug = getDemoWorkspaceSlug();
  const now = Date.now();
  if (workspaceCache && workspaceCache.slug === slug && workspaceCache.until > now) {
    return { ok: true, id: workspaceCache.id, slug };
  }
  if (!hasInternalDB()) return { ok: false, reason: "no_internal_db" };

  let rows: { id: string }[];
  try {
    rows = await internalQuery<{ id: string }>(
      `SELECT id FROM organization WHERE slug = $1 AND deleted_at IS NULL LIMIT 1`,
      [slug],
    );
  } catch (err) {
    log.error(
      { slug, err: err instanceof Error ? err.message : String(err) },
      "Demo workspace lookup failed — anonymous demo refuses (fail-closed)",
    );
    return { ok: false, reason: "lookup_failed" };
  }
  const row = rows[0];
  if (!row) {
    log.warn({ slug }, "No organization carries the demo workspace slug — anonymous demo refuses");
    return { ok: false, reason: "not_found" };
  }
  workspaceCache = { slug, id: row.id, until: now + WORKSPACE_CACHE_TTL_MS };
  return { ok: true, id: row.id, slug };
}

// ---------------------------------------------------------------------------
// Sessions — one row per minted identity
// ---------------------------------------------------------------------------

export interface AnonymousDemoSession {
  readonly id: string;
  readonly workspaceId: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly answerCount: number;
  readonly emailCapturedAt: Date | null;
}

type SessionRow = {
  id: string;
  workspace_id: string;
  created_at: string | Date;
  expires_at: string | Date;
  answer_count: number;
  email_captured_at: string | Date | null;
};

function rowToSession(row: SessionRow): AnonymousDemoSession {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    createdAt: new Date(row.created_at),
    expiresAt: new Date(row.expires_at),
    answerCount: Number(row.answer_count),
    emailCapturedAt: row.email_captured_at === null ? null : new Date(row.email_captured_at),
  };
}

const CLIENT_LABEL_MAX = 200;

/**
 * Mint a session row. Throws when there is no internal DB or the insert fails —
 * the caller answers 500/503 with a request id rather than minting a token no
 * row backs (the launch-cycle count would then undercount, silently).
 */
export async function startAnonymousDemoSession(input: {
  workspaceId: string;
  ip: string | null;
  clientLabel: string | null;
  expiresAt: number;
}): Promise<AnonymousDemoSession> {
  if (!hasInternalDB()) {
    throw new Error("Anonymous demo sessions require an internal database");
  }
  const clientLabel = input.clientLabel?.trim().slice(0, CLIENT_LABEL_MAX) || null;
  const rows = await internalQuery<SessionRow>(
    `INSERT INTO demo_anonymous_sessions (workspace_id, ip_hash, client_label, expires_at)
     VALUES ($1, $2, $3, $4)
     RETURNING id, workspace_id, created_at, expires_at, answer_count, email_captured_at`,
    [input.workspaceId, hashDemoIp(input.ip), clientLabel, new Date(input.expiresAt).toISOString()],
  );
  const row = rows[0];
  if (!row) throw new Error("Anonymous demo session insert returned no row");
  return rowToSession(row);
}

/** Load a session by id. `null` when absent; throws on a DB failure (caller fails closed). */
export async function loadAnonymousDemoSession(
  sessionId: string,
): Promise<AnonymousDemoSession | null> {
  if (!hasInternalDB()) return null;
  const rows = await internalQuery<SessionRow>(
    `SELECT id, workspace_id, created_at, expires_at, answer_count, email_captured_at
     FROM demo_anonymous_sessions WHERE id = $1 LIMIT 1`,
    [sessionId],
  );
  const row = rows[0];
  return row ? rowToSession(row) : null;
}

/**
 * Count one delivered answer. Best-effort: a failure here must never turn a
 * delivered answer into an error, but it is logged with the request id because
 * it also moves the email-capture gate.
 */
export async function recordAnonymousDemoAnswer(
  sessionId: string,
  requestId?: string,
): Promise<void> {
  if (!hasInternalDB()) return;
  try {
    await internalQuery(
      `UPDATE demo_anonymous_sessions
       SET answer_count = answer_count + 1, last_seen_at = now()
       WHERE id = $1`,
      [sessionId],
    );
  } catch (err) {
    log.warn(
      { sessionId, requestId, err: err instanceof Error ? err.message : String(err) },
      "Failed to record an anonymous demo answer — the session's answer count is behind",
    );
  }
}

// ---------------------------------------------------------------------------
// Rate limits — per IP and per minted identity
// ---------------------------------------------------------------------------

/** Fallback bucket when the client IP is unknown (no trusted proxy). */
const ANON_IP_KEY = "anon-demo";

// Two limiters, two key spaces: an IP can never collide with a session id.
const ipLimiter = createSlidingWindowLimiter({ windowMs: RATE_LIMIT_WINDOW_MS });
const identityLimiter = createSlidingWindowLimiter({ windowMs: RATE_LIMIT_WINDOW_MS });

export type AnonymousDemoLimitBucket = "ip" | "identity";

export type AnonymousDemoLimitResult =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly bucket: AnonymousDemoLimitBucket;
      readonly retryAfterMs: number;
    };

/**
 * Check BOTH windows and record in both only when both pass — a blocked
 * attempt is not charged, so a client that backs off recovers on schedule.
 * `sessionId` is null for a session mint (no identity exists yet); the IP
 * window alone applies there.
 */
export async function checkAnonymousDemoLimits(input: {
  ip: string | null;
  sessionId: string | null;
}): Promise<AnonymousDemoLimitResult> {
  const ipLimit = getAnonymousDemoIpRpmLimit();
  const identityLimit = getAnonymousDemoIdentityRpmLimit();
  const ipKey = input.ip && input.ip.length > 0 ? input.ip : ANON_IP_KEY;
  const now = Date.now();

  const ipCheck = await ipLimiter.peek(ipKey, ipLimit, now);
  if (!ipCheck.allowed) {
    return { allowed: false, bucket: "ip", retryAfterMs: ipCheck.retryAfterMs };
  }
  if (input.sessionId !== null) {
    const identityCheck = await identityLimiter.peek(input.sessionId, identityLimit, now);
    if (!identityCheck.allowed) {
      return { allowed: false, bucket: "identity", retryAfterMs: identityCheck.retryAfterMs };
    }
  }

  await ipLimiter.record(ipKey, ipLimit, now);
  if (input.sessionId !== null) {
    await identityLimiter.record(input.sessionId, identityLimit, now);
  }
  return { allowed: true };
}

/** Clear all anonymous-demo rate-limit state. For tests. */
export async function resetAnonymousDemoRateLimits(): Promise<void> {
  await ipLimiter.reset();
  await identityLimiter.reset();
}

/** Evict fully-stale buckets. Swept by the demo cleanup fiber in `effect/layers.ts`. */
export async function anonymousDemoCleanupTick(): Promise<void> {
  const now = Date.now();
  await ipLimiter.cleanup(now);
  await identityLimiter.cleanup(now);
}

// ---------------------------------------------------------------------------
// Optional email hand-off — after the first answer, never before
// ---------------------------------------------------------------------------

export type CaptureAnonymousDemoEmailResult =
  | { readonly ok: true; readonly returning: boolean }
  | {
      readonly ok: false;
      readonly reason: "answer_required" | "session_not_found" | "invalid_email";
    };

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Attach an email to an anonymous session. Refused with `answer_required`
 * while `answer_count` is zero — the rule the issue states ("optional and after
 * the first answer, never before") is enforced here, once, for both the REST
 * and the MCP hand-off. The email itself goes to `demo_leads` through the same
 * `captureDemoLead` path the email demo uses; the session row keeps only the
 * timestamp.
 */
export async function captureAnonymousDemoEmail(input: {
  sessionId: string;
  email: string;
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}): Promise<CaptureAnonymousDemoEmailResult> {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL_SHAPE.test(email)) return { ok: false, reason: "invalid_email" };

  const session = await loadAnonymousDemoSession(input.sessionId);
  if (!session) return { ok: false, reason: "session_not_found" };
  if (session.answerCount < 1) return { ok: false, reason: "answer_required" };

  const lead = await captureDemoLead({
    email,
    ip: input.ip,
    userAgent: input.userAgent,
    requestId: input.requestId,
  });
  try {
    await internalQuery(
      `UPDATE demo_anonymous_sessions
       SET email_captured_at = COALESCE(email_captured_at, now()), last_seen_at = now()
       WHERE id = $1`,
      [input.sessionId],
    );
  } catch (err) {
    // The lead is already captured; only the session's own stamp is behind.
    log.warn(
      { sessionId: input.sessionId, requestId: input.requestId, err: err instanceof Error ? err.message : String(err) },
      "Failed to stamp email_captured_at on the anonymous demo session",
    );
  }
  return { ok: true, returning: lead.returning };
}
