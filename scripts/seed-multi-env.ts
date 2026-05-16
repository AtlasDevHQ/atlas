#!/usr/bin/env bun
/**
 * Seed the local Atlas dev workspace with the multi-env connections +
 * connection groups used by the e2e tracer. Idempotent — groups are
 * pre-checked, connections rely on the create endpoint's 409, and
 * memberships are compared before re-assignment.
 *
 * Auth flow:
 *   1. Sign in with admin@useatlas.dev.
 *   2. Enroll TOTP on the first run (Atlas requires MFA on all
 *      admin/owner/platform_admin sessions — see admin-mfa-required.ts).
 *      Save the resulting secret to `.atlas/mfa-secret` (gitignored)
 *      so subsequent runs can satisfy the 2FA challenge.
 *   3. Rotate the admin password to a known value so subsequent runs
 *      (and the Playwright tracer) don't burn the per-window sign-in
 *      budget on stale-password fallbacks.
 *   4. Mint the connection-groups + connections.
 *
 * Prereqs:
 *   - Base stack:  bun run db:up
 *   - Multi-env:   bun run db:multi-env:up
 *   - API:         ATLAS_DEPLOY_MODE=self-hosted bun run dev:api
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  signInWithPassword,
  satisfyTotpChallenge,
  type HttpRequestInit,
  type HttpReply,
} from "../e2e/browser/lib/admin-auth";
import { secretFromOtpAuthUri, totp } from "../e2e/browser/lib/totp";

const API = process.env.ATLAS_API_URL ?? "http://localhost:3001";
const EMAIL = process.env.ATLAS_ADMIN_EMAIL ?? "admin@useatlas.dev";
/** Known credential the seed rotates to so all subsequent callers use it. */
const TRACER_PASSWORD = "atlas-multi-env-tracer!";
const PASSWORDS = [
  process.env.ATLAS_ADMIN_PASSWORD,
  TRACER_PASSWORD,
  "atlas-dev",
].filter((p): p is string => typeof p === "string" && p.length > 0);

const SECRET_FILE = resolve(process.cwd(), ".atlas", "mfa-secret");

// ─── Cookie jar (Bun fetch is server-to-server, no built-in jar) ─────

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

/** Mutable cookie jar threaded through the auth flow + admin calls. */
let cookieJar = "";

async function http<T>(path: string, init: HttpRequestInit): Promise<HttpReply<T>> {
  const res = await fetch(`${API}${path}`, {
    method: init.method,
    headers: {
      cookie: cookieJar,
      // Better Auth's CSRF guard requires an Origin header on POST. Bun's
      // fetch omits it for server-to-server calls, so set it explicitly to
      // the API origin — matches BETTER_AUTH_URL / trusted-origins.
      origin: API,
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  cookieJar = mergeCookies(cookieJar, collectSetCookies(res));
  const text = await res.text();
  let body: T | null = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text) as T;
    } catch (err) {
      // A 200 carrying a malformed body is the kind of failure this script
      // is supposed to surface. Log a truncated preview so the next person
      // diagnosing this doesn't see "body: null" with no breadcrumb.
      console.warn(
        `[seed-multi-env] non-JSON body on ${init.method} ${path} (${res.status}): ` +
          `${text.slice(0, 200)}${text.length > 200 ? "..." : ""} ` +
          `(${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
  return { status: res.status, body, rawText: text };
}

// ─── MFA enrollment ──────────────────────────────────────────────────

async function enrollMfa(password: string): Promise<void> {
  console.log("[seed-multi-env] enrolling MFA (first run — saving secret to .atlas/mfa-secret)");
  const enable = await http<{ totpURI: string; backupCodes: string[] }>("/api/auth/two-factor/enable", {
    method: "POST",
    body: { password },
  });
  if (enable.status !== 200 || !enable.body?.totpURI) {
    throw new Error(`two-factor/enable failed: ${enable.status} ${JSON.stringify(enable.body)}`);
  }
  const secret = secretFromOtpAuthUri(enable.body.totpURI);
  const code = totp(secret);
  const verify = await http<{ status?: string; token?: string }>("/api/auth/two-factor/verify-totp", {
    method: "POST",
    body: { code, trustDevice: true },
  });
  if (verify.status !== 200) {
    throw new Error(`two-factor/verify-totp (first enroll) failed: ${verify.status} ${JSON.stringify(verify.body)}`);
  }
  await mkdir(dirname(SECRET_FILE), { recursive: true });
  await writeFile(SECRET_FILE, secret + "\n", { mode: 0o600 });
  console.log("[seed-multi-env] MFA enrolled");
}

async function satisfyChallengeFromSavedSecret(): Promise<void> {
  if (!existsSync(SECRET_FILE)) {
    throw new Error(
      `Sign-in returned a 2FA challenge but no saved secret at ${SECRET_FILE}. ` +
        `Re-run after \`bun run db:reset\` to re-enroll, or delete the admin's twoFactor row.`,
    );
  }
  const secret = (await readFile(SECRET_FILE, "utf8")).trim();
  await satisfyTotpChallenge(http, secret);
}

// ─── Password rotation ───────────────────────────────────────────────

async function rotatePasswordIfDefault(currentPassword: string): Promise<void> {
  if (currentPassword === TRACER_PASSWORD) return;
  const res = await http<{ message?: string }>("/api/v1/admin/me/password", {
    method: "POST",
    body: { currentPassword, newPassword: TRACER_PASSWORD },
  });
  if (res.status === 200) {
    console.log(`[seed-multi-env] admin password rotated to tracer-known value`);
    return;
  }
  // Non-200 isn't fatal (a parallel run may have already rotated it),
  // but include the body so we can tell apart "already rotated" from
  // "policy rejected" instead of seeing a status-only diagnostic.
  console.warn(
    `[seed-multi-env] password rotation skipped (${res.status}): ${res.rawText?.slice(0, 200) ?? "<no body>"}`,
  );
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

async function ensureGroup(name: string): Promise<string> {
  const list = await http<GroupsResp>("/api/v1/admin/connection-groups", { method: "GET" });
  const existing = list.body?.groups?.find((g) => g.name === name);
  if (existing) {
    console.log(`[seed-multi-env] group exists: ${name} → ${existing.id}`);
    return existing.id;
  }
  const created = await http<GroupRow>("/api/v1/admin/connection-groups", {
    method: "POST",
    body: { name },
  });
  if (created.status !== 201 || !created.body) {
    throw new Error(`Create group "${name}" failed: ${created.status} ${JSON.stringify(created.body)}`);
  }
  console.log(`[seed-multi-env] group created: ${name} → ${created.body.id}`);
  return created.body.id;
}

async function ensureConnection(env: EnvSpec): Promise<void> {
  const created = await http<{ id: string }>("/api/v1/admin/connections", {
    method: "POST",
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

async function ensureMembership(groupId: string, connectionId: string): Promise<void> {
  const list = await http<ConnsResp>("/api/v1/admin/connections", { method: "GET" });
  const row = list.body?.connections?.find((c) => c.id === connectionId);
  if (row?.groupId === groupId) {
    console.log(`[seed-multi-env] membership ok: ${connectionId} ∈ ${groupId}`);
    return;
  }
  const res = await http<unknown>(`/api/v1/admin/connection-groups/${groupId}/members`, {
    method: "POST",
    body: { connectionId },
  });
  if (res.status !== 200) {
    throw new Error(`Assign ${connectionId} → ${groupId} failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  console.log(`[seed-multi-env] membership set: ${connectionId} ∈ ${groupId}`);
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  const initial = await signInWithPassword(http, EMAIL, PASSWORDS);

  // Probe an admin endpoint to discover whether MFA is required.
  // 200 = no MFA enrolled on this session yet (rare — only if the gate
  // is off). 403 mfa_enrollment_required = need to enrol TOTP.
  // 401 = sign-in completed but a 2FA challenge is pending.
  const probe = await http<{ error?: string }>("/api/v1/admin/connection-groups", { method: "GET" });
  if (probe.status === 403 && probe.body?.error === "mfa_enrollment_required") {
    await enrollMfa(initial.password);
  } else if (probe.status === 401 && initial.body.twoFactorRedirect === true) {
    await satisfyChallengeFromSavedSecret();
  } else if (probe.status !== 200) {
    throw new Error(`Unexpected admin-probe response: ${probe.status} ${JSON.stringify(probe.body)}`);
  }
  console.log(`[seed-multi-env] signed in as ${EMAIL}`);

  await rotatePasswordIfDefault(initial.password);

  for (const env of ENVS) {
    const groupId = await ensureGroup(env.group);
    await ensureConnection(env);
    await ensureMembership(groupId, env.id);
  }
  console.log("[seed-multi-env] done");
}

main().catch((err) => {
  console.error("[seed-multi-env] failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
