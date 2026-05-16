#!/usr/bin/env bun
/**
 * Seed the local Atlas dev workspace with the three multi-env connections
 * + connection groups used by the e2e tracer. Idempotent — re-running
 * against an already-seeded workspace is a no-op (409 conflicts are
 * caught and logged).
 *
 * Auth flow:
 *   1. Sign in with admin@useatlas.dev / atlas-dev.
 *   2. Enroll TOTP on the first run (Atlas requires MFA on all
 *      admin/owner/platform_admin sessions — see admin-mfa-required.ts).
 *      Save the resulting secret to `.atlas/mfa-secret` (gitignored)
 *      so subsequent runs can satisfy the 2FA challenge.
 *   3. Mint the connection-groups + connections.
 *
 * Prereqs:
 *   - Base stack:  bun run db:up
 *   - Multi-env:   bun run db:multi-env:up
 *   - API:         ATLAS_DEPLOY_MODE=self-hosted bun run dev:api
 *
 * Reads admin creds from env (defaults match the dev defaults):
 *   ATLAS_ADMIN_EMAIL = admin@useatlas.dev
 *   ATLAS_ADMIN_PASSWORD = atlas-dev   (try the e2e-rotated password
 *     first, then this)
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHmac } from "node:crypto";
import { dirname, resolve } from "node:path";

const API = process.env.ATLAS_API_URL ?? "http://localhost:3001";
const EMAIL = process.env.ATLAS_ADMIN_EMAIL ?? "admin@useatlas.dev";
// Rotation target: the seed script rotates the admin password to this
// value on first run so subsequent calls (and the Playwright tracer)
// have a single known credential. Avoids burning Better Auth's per-window
// sign-in budget on stale-password fallbacks.
const TRACER_PASSWORD = "atlas-multi-env-tracer!";
const PASSWORDS = [
  process.env.ATLAS_ADMIN_PASSWORD,
  TRACER_PASSWORD,
  "atlas-dev",
].filter((p): p is string => typeof p === "string" && p.length > 0);

const SECRET_FILE = resolve(process.cwd(), ".atlas", "mfa-secret");

// ─── TOTP (RFC 6238, SHA-1, 6 digits, 30s window) ────────────────────

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, "").toUpperCase();
  const bits: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`Invalid base32 char in TOTP secret: ${ch}`);
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

/** RFC 6238 TOTP — secret is base32, returns a 6-digit code as a string. */
function totp(secret: string, atSeconds: number = Math.floor(Date.now() / 1000)): string {
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

function secretFromOtpAuthUri(uri: string): string {
  const match = uri.match(/[?&]secret=([^&]+)/i);
  if (!match) throw new Error(`Could not parse secret from otpauth URI: ${uri.slice(0, 60)}...`);
  return decodeURIComponent(match[1]!);
}

// ─── Cookie jar helpers ──────────────────────────────────────────────

function collectSetCookies(res: Response): string[] {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

function mergeCookies(existing: string, setCookies: string[]): string {
  const jar = new Map<string, string>();
  for (const pair of existing.split(";").map((p) => p.trim()).filter(Boolean)) {
    const [k, ...v] = pair.split("=");
    if (k) jar.set(k, v.join("="));
  }
  for (const sc of setCookies) {
    const first = sc.split(";")[0]!.trim();
    const [k, ...v] = first.split("=");
    if (k) jar.set(k, v.join("="));
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

// ─── HTTP helpers ────────────────────────────────────────────────────

interface ReqOpts {
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  cookies: string;
  body?: unknown;
}

interface Reply<T> { status: number; body: T | null; cookies: string }

async function http<T>(path: string, opts: ReqOpts): Promise<Reply<T>> {
  const res = await fetch(`${API}${path}`, {
    method: opts.method,
    headers: {
      cookie: opts.cookies,
      // Better Auth's CSRF guard requires an Origin header on POST. Bun's
      // fetch omits it for server-to-server calls, so set it explicitly to
      // the API origin — matches BETTER_AUTH_URL / trusted-origins.
      origin: API,
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let body: T | null = null;
  const text = await res.text();
  if (text.length > 0) {
    try { body = JSON.parse(text) as T; } catch { body = null; }
  }
  return { status: res.status, body, cookies: mergeCookies(opts.cookies, collectSetCookies(res)) };
}

// ─── Auth flow ───────────────────────────────────────────────────────

interface SignInBody {
  token?: string;
  user?: { id: string; twoFactorEnabled?: boolean };
  twoFactorRedirect?: boolean;
  twoFactorMethods?: string[];
}

async function signInWithPassword(): Promise<{ cookies: string; body: SignInBody; password: string }> {
  for (const password of PASSWORDS) {
    const r = await http<SignInBody>("/api/auth/sign-in/email", {
      method: "POST",
      cookies: "",
      body: { email: EMAIL, password },
    });
    if (r.status === 200 && r.body) {
      return { cookies: r.cookies, body: r.body, password };
    }
    if (r.status !== 401) {
      throw new Error(`sign-in/email returned ${r.status}: ${JSON.stringify(r.body)}`);
    }
  }
  throw new Error(`Could not sign in as ${EMAIL} with any known password. Set ATLAS_ADMIN_PASSWORD.`);
}

async function enrollMfa(cookies: string, password: string): Promise<{ cookies: string; secret: string }> {
  console.log("[seed-multi-env] enrolling MFA (first run — saving secret to .atlas/mfa-secret)");
  const enable = await http<{ totpURI: string; backupCodes: string[] }>("/api/auth/two-factor/enable", {
    method: "POST",
    cookies,
    body: { password },
  });
  if (enable.status !== 200 || !enable.body?.totpURI) {
    throw new Error(`two-factor/enable failed: ${enable.status} ${JSON.stringify(enable.body)}`);
  }
  const secret = secretFromOtpAuthUri(enable.body.totpURI);
  // Verify the first code so `twoFactorEnabled` flips to true on the user row.
  const code = totp(secret);
  const verify = await http<{ status?: string; token?: string }>("/api/auth/two-factor/verify-totp", {
    method: "POST",
    cookies: enable.cookies,
    body: { code, trustDevice: true },
  });
  if (verify.status !== 200) {
    throw new Error(`two-factor/verify-totp (first enrol) failed: ${verify.status} ${JSON.stringify(verify.body)}`);
  }
  await mkdir(dirname(SECRET_FILE), { recursive: true });
  await writeFile(SECRET_FILE, secret + "\n", { mode: 0o600 });
  console.log("[seed-multi-env] MFA enrolled");
  return { cookies: verify.cookies, secret };
}

async function satisfyChallenge(cookies: string): Promise<string> {
  if (!existsSync(SECRET_FILE)) {
    throw new Error(
      `Sign-in returned a 2FA challenge but no saved secret at ${SECRET_FILE}. ` +
        `Re-run after \`bun run db:reset\` to re-enroll, or delete the admin's twoFactor row.`,
    );
  }
  const secret = (await readFile(SECRET_FILE, "utf8")).trim();
  // 2FA verify within a small clock window. Try the current step + the
  // previous one to absorb any clock skew between this script and the API.
  for (const offset of [0, -30, 30]) {
    const code = totp(secret, Math.floor(Date.now() / 1000) + offset);
    const r = await http<{ status?: string; token?: string }>("/api/auth/two-factor/verify-totp", {
      method: "POST",
      cookies,
      body: { code, trustDevice: true },
    });
    if (r.status === 200) return r.cookies;
  }
  throw new Error("two-factor/verify-totp failed for all clock-skew offsets — the saved secret may be stale.");
}


// ─── Seed ────────────────────────────────────────────────────────────

interface EnvSpec {
  id: string;
  group: string;
  url: string;
  description: string;
}

const ENVS: readonly EnvSpec[] = [
  { id: "env-dev",     group: "dev",     url: "postgresql://atlas:atlas@localhost:5433/atlas_env", description: "Dev env (10 customers, 5 orders)" },
  { id: "env-staging", group: "staging", url: "postgresql://atlas:atlas@localhost:5434/atlas_env", description: "Staging env (100 customers, 50 orders)" },
  { id: "env-prod",    group: "prod",    url: "postgresql://atlas:atlas@localhost:5435/atlas_env", description: "Prod env (1000 customers, 500 orders, vip_tier)" },
];

interface GroupRow { id: string; name: string }
interface GroupsResp { groups: GroupRow[] }
interface ConnRow { id: string; groupId?: string | null }
interface ConnsResp { connections: ConnRow[] }

async function ensureGroup(cookies: string, name: string): Promise<string> {
  const list = await http<GroupsResp>("/api/v1/admin/connection-groups", { method: "GET", cookies });
  const existing = list.body?.groups?.find((g) => g.name === name);
  if (existing) {
    console.log(`[seed-multi-env] group exists: ${name} → ${existing.id}`);
    return existing.id;
  }
  const created = await http<GroupRow>("/api/v1/admin/connection-groups", {
    method: "POST",
    cookies,
    body: { name },
  });
  if (created.status !== 201 || !created.body) {
    throw new Error(`Create group "${name}" failed: ${created.status} ${JSON.stringify(created.body)}`);
  }
  console.log(`[seed-multi-env] group created: ${name} → ${created.body.id}`);
  return created.body.id;
}

async function ensureConnection(cookies: string, env: EnvSpec): Promise<void> {
  const created = await http<{ id: string }>("/api/v1/admin/connections", {
    method: "POST",
    cookies,
    body: { id: env.id, url: env.url, description: env.description },
  });
  if (created.status === 201) {
    console.log(`[seed-multi-env] connection created: ${env.id}`);
    return;
  }
  if (created.status === 409) {
    console.log(`[seed-multi-env] connection exists: ${env.id}`);
    return;
  }
  throw new Error(`Create connection "${env.id}" failed: ${created.status} ${JSON.stringify(created.body)}`);
}

async function ensureMembership(cookies: string, groupId: string, connectionId: string): Promise<void> {
  const list = await http<ConnsResp>("/api/v1/admin/connections", { method: "GET", cookies });
  const row = list.body?.connections?.find((c) => c.id === connectionId);
  if (row?.groupId === groupId) {
    console.log(`[seed-multi-env] membership ok: ${connectionId} ∈ ${groupId}`);
    return;
  }
  const res = await http<unknown>(`/api/v1/admin/connection-groups/${groupId}/members`, {
    method: "POST",
    cookies,
    body: { connectionId },
  });
  if (res.status !== 200) {
    throw new Error(`Assign ${connectionId} → ${groupId} failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  console.log(`[seed-multi-env] membership set: ${connectionId} ∈ ${groupId}`);
}

async function rotatePasswordIfDefault(cookies: string, currentPassword: string): Promise<void> {
  if (currentPassword === TRACER_PASSWORD) return;
  const res = await http<{ message?: string }>("/api/v1/admin/me/password", {
    method: "POST",
    cookies,
    body: { currentPassword, newPassword: TRACER_PASSWORD },
  });
  if (res.status === 200) {
    console.log(`[seed-multi-env] admin password rotated to tracer-known value`);
    return;
  }
  // Non-200 isn't fatal — maybe an older session, or the password was
  // already rotated by a parallel run. Continue with the current cookie.
  console.warn(`[seed-multi-env] password rotation skipped (${res.status})`);
}

async function main() {
  // `authenticate()` returns the cookie jar; we need to know which password
  // succeeded to know whether to rotate. Hoist that into a small wrapper.
  const initial = await signInWithPassword();
  let cookies = initial.cookies;
  const probe = await http<{ error?: string }>("/api/v1/admin/connection-groups", { method: "GET", cookies });
  if (probe.status === 403 && probe.body?.error === "mfa_enrollment_required") {
    cookies = (await enrollMfa(cookies, initial.password)).cookies;
  } else if (probe.status === 401 && initial.body.twoFactorRedirect === true) {
    cookies = await satisfyChallenge(cookies);
  } else if (probe.status !== 200) {
    throw new Error(`Unexpected admin-probe response: ${probe.status} ${JSON.stringify(probe.body)}`);
  }
  console.log(`[seed-multi-env] signed in as ${EMAIL}`);

  await rotatePasswordIfDefault(cookies, initial.password);

  for (const env of ENVS) {
    const groupId = await ensureGroup(cookies, env.group);
    await ensureConnection(cookies, env);
    await ensureMembership(cookies, groupId, env.id);
  }
  console.log("[seed-multi-env] done");
}

main().catch((err) => {
  console.error("[seed-multi-env] failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
