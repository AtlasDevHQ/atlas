import { test, expect, type APIRequestContext, type BrowserContext } from "@playwright/test";
import { Client } from "pg";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Multi-environment tracer — real-API e2e (no route mocks).
 *
 * Companion to `multi-env-admin.integration.spec.ts` (which is route-mock
 * UI integration) — this spec drives the live admin API and asserts that
 * switching envs actually changes what the system queries. Three local
 * Postgres containers (5433/5434/5435) are seeded with **divergent** row
 * counts + a schema difference in prod, so a routing bug — e.g. the
 * picker silently falls through to dev — surfaces as a count mismatch
 * rather than as identical-success false greens.
 *
 * Prereqs (skipped if missing — see `assertOverlay()` below):
 *   docker compose -f docker-compose.yml -f docker-compose.multi-env.yml up -d
 *   ATLAS_DEPLOY_MODE=self-hosted bun run dev:api
 *   bun scripts/seed-multi-env.ts   (one-time MFA enrol; saves .atlas/mfa-secret)
 *
 * Independent auth flow:
 *   The shared `global-setup.ts` doesn't satisfy MFA — admin@useatlas.dev
 *   requires TOTP via the `mfaRequired` gate. Rather than fork that, this
 *   spec does its own sign-in inside `test.beforeAll`, reading the secret
 *   that `scripts/seed-multi-env.ts` enrolled on its first run. Cookies
 *   are pushed into `context.addCookies()` so the page navigation in step
 *   4 below is admin-authed without depending on storage-state.
 */

const API_URL = process.env.ATLAS_API_URL ?? "http://localhost:3001";
const WEB_URL = process.env.BASE_URL ?? "http://localhost:3000";
const SECRET_FILE = resolve(process.cwd(), ".atlas", "mfa-secret");
const PASSWORDS = [
  // Order matters: try the seed-rotated password FIRST so the happy path
  // doesn't burn Better Auth's per-window sign-in budget (default 10/60s)
  // by attempting a stale password before falling through. The bare
  // `atlas-dev` only matters on a freshly-reset DB before `seed-multi-env`
  // has rotated it.
  process.env.ATLAS_ADMIN_PASSWORD,
  "atlas-multi-env-tracer!",
  "atlas-dev",
].filter((p): p is string => typeof p === "string" && p.length > 0);

const ENVS = [
  { id: "env-dev",     group: "dev",     port: 5433, expectedCustomers: 10,   hasVipTier: false },
  { id: "env-staging", group: "staging", port: 5434, expectedCustomers: 100,  hasVipTier: false },
  { id: "env-prod",    group: "prod",    port: 5435, expectedCustomers: 1000, hasVipTier: true  },
] as const;

type EnvSpec = (typeof ENVS)[number];

function envUrl(env: EnvSpec): string {
  return `postgresql://atlas:atlas@localhost:${env.port}/atlas_env`;
}

// ─── Pre-flight: Postgres overlay reachable ──────────────────────────

async function assertOverlay(): Promise<void> {
  for (const env of ENVS) {
    const client = new Client({ connectionString: envUrl(env), connectionTimeoutMillis: 2000 });
    try {
      await client.connect();
      await client.query("SELECT 1");
    } catch (err) {
      test.skip(
        true,
        `Multi-env overlay not reachable on :${env.port} (${err instanceof Error ? err.message : String(err)}). ` +
          `Run \`bun run db:multi-env:up\` and retry.`,
      );
      return;
    } finally {
      await client.end().catch(() => {});
    }
  }
}

async function probeCustomers(env: EnvSpec): Promise<{ count: number; columns: string[] }> {
  const client = new Client({ connectionString: envUrl(env) });
  await client.connect();
  try {
    const countRes = await client.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM customers");
    const colsRes = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'customers'`,
    );
    return {
      count: Number(countRes.rows[0]?.count ?? "0"),
      columns: colsRes.rows.map((r) => r.column_name).sort(),
    };
  } finally {
    await client.end().catch(() => {});
  }
}

// ─── TOTP (RFC 6238, SHA-1, 6 digits, 30s) ───────────────────────────

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input: string): Buffer {
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

// ─── Sign-in (with MFA challenge satisfaction) ───────────────────────

interface AuthCookie { name: string; value: string }

function parseSetCookies(headers: Record<string, string[] | string | undefined>): AuthCookie[] {
  const raw = headers["set-cookie"];
  const list: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list
    .map((sc) => sc.split(";")[0]!.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      const eq = s.indexOf("=");
      return eq < 0 ? null : { name: s.slice(0, eq), value: s.slice(eq + 1) };
    })
    .filter((c): c is AuthCookie => c !== null);
}

/**
 * Drive the Better Auth sign-in flow: password → TOTP challenge. Returns
 * the cookies that Playwright's APIRequestContext has accumulated — the
 * caller can pass these to `context.addCookies()` for a browser session.
 * The request context itself retains the cookie jar internally for any
 * subsequent `request.get/post(...)` calls.
 *
 * The TOTP secret is the one `scripts/seed-multi-env.ts` enrolled on its
 * first run; if that file is missing, we soft-skip with an explicit
 * pointer rather than fail confusingly downstream.
 */
async function signInAdmin(request: APIRequestContext): Promise<AuthCookie[]> {
  if (!existsSync(SECRET_FILE)) {
    test.skip(
      true,
      `MFA secret not found at ${SECRET_FILE}. Run \`bun scripts/seed-multi-env.ts\` first to enrol.`,
    );
    return [];
  }
  const secret = readFileSync(SECRET_FILE, "utf8").trim();

  let signedIn = false;
  let lastError: string | null = null;
  for (const password of PASSWORDS) {
    const signIn = await request.post(`${API_URL}/api/auth/sign-in/email`, {
      headers: { origin: API_URL, "content-type": "application/json" },
      data: { email: "admin@useatlas.dev", password },
    });
    if (signIn.status() === 200) {
      signedIn = true;
      break;
    }
    lastError = `${signIn.status()}: ${await signIn.text().catch(() => "<no body>")}`;
  }
  if (!signedIn) {
    throw new Error(`Sign-in failed for admin@useatlas.dev — last error: ${lastError ?? "unknown"}`);
  }

  // Satisfy 2FA challenge. Playwright's APIRequestContext carries the
  // session cookie from the sign-in response automatically — we don't
  // need to thread it through headers.
  for (const offset of [0, -30, 30]) {
    const code = totp(secret, Math.floor(Date.now() / 1000) + offset);
    const verify = await request.post(`${API_URL}/api/auth/two-factor/verify-totp`, {
      headers: { origin: API_URL, "content-type": "application/json" },
      data: { code, trustDevice: true },
    });
    if (verify.status() === 200) {
      // Pull the now-complete cookie jar out of the context's storage
      // state so the caller can mirror it onto a BrowserContext.
      const state = await request.storageState();
      const apiOrigin = new URL(API_URL);
      return state.cookies
        .filter((c) => c.domain === apiOrigin.hostname || c.domain === `.${apiOrigin.hostname}`)
        .map((c) => ({ name: c.name, value: c.value }));
    }
  }
  throw new Error("two-factor/verify-totp failed for all clock-skew offsets — secret may be stale.");
}

function cookiesForDomain(cookies: AuthCookie[], origin: string): Parameters<BrowserContext["addCookies"]>[0] {
  const u = new URL(origin);
  return cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: u.hostname,
    path: "/",
    httpOnly: true,
    secure: u.protocol === "https:",
    sameSite: "Lax",
  }));
}

// ─── Admin-API helpers (rely on APIRequestContext's cookie jar) ──────
//
// All admin probes go through with `x-atlas-mode: developer` because the
// seed flow stamps new connections as `status='draft'` (per the 1.4.4
// publish model). Published-mode requests filter drafts out via
// `getVisibleConnectionIds`, so a 404 here would otherwise be a false
// failure — the connections genuinely exist but aren't visible without
// the dev-mode header.

const DEV_MODE_HEADERS = { origin: API_URL, "x-atlas-mode": "developer" } as const;

async function adminGet<T>(request: APIRequestContext, path: string): Promise<{ status: number; body: T | null }> {
  const res = await request.get(`${API_URL}${path}`, { headers: DEV_MODE_HEADERS });
  const text = await res.text();
  let body: T | null = null;
  try { body = text.length > 0 ? (JSON.parse(text) as T) : null; } catch { body = null; }
  return { status: res.status(), body };
}

async function adminPost<T>(request: APIRequestContext, path: string, data?: unknown): Promise<{ status: number; body: T | null }> {
  const res = await request.post(`${API_URL}${path}`, {
    headers: { ...DEV_MODE_HEADERS, "content-type": "application/json" },
    data,
  });
  const text = await res.text();
  let body: T | null = null;
  try { body = text.length > 0 ? (JSON.parse(text) as T) : null; } catch { body = null; }
  return { status: res.status(), body };
}

// ─── Tests ───────────────────────────────────────────────────────────

test.describe("multi-env tracer — real API, real Postgres", () => {
  test.beforeAll(async () => {
    await assertOverlay();
  });

  test("seeds are divergent across envs (pre-flight contract)", async () => {
    const probes = await Promise.all(ENVS.map((e) => probeCustomers(e).then((p) => ({ env: e, p }))));
    for (const { env, p } of probes) {
      expect(p.count, `${env.group} customers`).toBe(env.expectedCustomers);
      expect(p.columns.includes("vip_tier"), `${env.group} has vip_tier?`).toBe(env.hasVipTier);
    }
    const counts = probes.map((x) => x.p.count);
    expect(new Set(counts).size, "envs must have distinct row counts").toBeGreaterThan(1);
  });

  test("admin API + /admin/connections — single-signin combined gate", async ({ browser, request }) => {
    // Combined into one test (was two) so we sign in ONCE per spec run —
    // Better Auth's sign-in/email defaults to 10 attempts per 60s window
    // and three parallel test workers each authenticating burned that
    // budget on quick re-runs, surfacing as a flaky 429.

    const cookies = await signInAdmin(request);

    // ── 1. Admin probe goes through. If MFA isn't satisfied, this 403s
    //       and the rest of the test would fail with opaque schema errors.
    const probe = await adminGet<unknown>(request, "/api/v1/admin/connection-groups");
    expect(probe.status, "admin probe should be 200 after MFA").toBe(200);

    // ── 2. Health-check each connection — proves URL stored +
    //       decryptable + the Postgres on the other end answers. This is
    //       the routing-layer assertion.
    for (const env of ENVS) {
      const health = await adminPost<unknown>(request, `/api/v1/admin/connections/${env.id}/test`);
      expect(health.status, `health-check ${env.id}`).toBe(200);
    }

    // ── 3. Non-admin `/me` feed surfaces all 3 groups — the read path
    //       the chat env picker uses.
    const me = await adminGet<{
      groups: Array<{ name: string; members: Array<{ connectionId: string }> }>;
    }>(request, "/api/v1/me/connection-groups");
    expect(me.status).toBe(200);
    for (const env of ENVS) {
      const group = me.body?.groups.find((g) => g.name === env.group);
      expect(group, `me feed missing ${env.group}`).toBeDefined();
      const member = group?.members.find((m) => m.connectionId === env.id);
      expect(member, `me feed group ${env.group} missing connection ${env.id}`).toBeDefined();
    }

    // ── 4. Regression gate — the prod "O is not iterable" crash was a
    //       `for...of` over a non-array shape returned by useAdminFetch
    //       under some schema-drift conditions. Page now has a defensive
    //       Array.isArray() guard; this test exercises the page end-to-end
    //       to ensure it renders without throwing.
    if (!(await isWebReachable())) {
      // Soft-skip the UI portion if the web dev server isn't up — the API
      // assertions above still cover the routing-layer story.
      console.warn(`Web dev server not reachable at ${WEB_URL}; skipping UI regression gate.`);
      return;
    }
    // Mirror cookies onto BOTH origins (web :3000 and API :3001) so the
    // browser sends them whether the page calls API relatively (proxied)
    // or via NEXT_PUBLIC_ATLAS_API_URL (cross-origin).
    const ctx = await browser.newContext({ baseURL: WEB_URL });
    await ctx.addCookies([
      ...cookiesForDomain(cookies, WEB_URL),
      ...cookiesForDomain(cookies, API_URL),
    ]);
    const page = await ctx.newPage();
    try {
      const consoleErrors: string[] = [];
      const consoleMessages: string[] = [];
      page.on("pageerror", (err) => consoleErrors.push(err.message));
      page.on("console", (msg) => {
        if (msg.type() === "error" || msg.type() === "warning") {
          consoleMessages.push(`[${msg.type()}] ${msg.text()}`);
        }
      });
      const failedRequests: string[] = [];
      page.on("requestfailed", (req) => failedRequests.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText ?? ""}`));

      const resp = await page.goto("/admin/connections");
      const heading = page.getByRole("heading", { name: "Connections" });
      try {
        // The page hydrates + makes parallel admin fetches; 15s covers
        // cold-start compile time in turbopack dev mode. `expect.toBeVisible`
        // polls until the locator resolves (unlike Locator.isVisible which
        // returns immediately).
        await expect(heading).toBeVisible({ timeout: 15_000 });
      } catch (err) {
        throw new Error(
          [
            `Connections heading not visible after navigation.`,
            `Navigation status: ${resp?.status() ?? "?"}; final URL: ${page.url()}`,
            `Page errors: ${consoleErrors.join(" | ") || "(none)"}`,
            `Console warnings/errors: ${consoleMessages.slice(0, 10).join(" | ") || "(none)"}`,
            `Failed requests: ${failedRequests.slice(0, 5).join(" | ") || "(none)"}`,
            `Underlying: ${err instanceof Error ? err.message : String(err)}`,
          ].join("\n"),
        );
      }
      // No uncaught JS errors — a defensive console.warn from the page is
      // fine (warns aren't pageerrors), but uncaught exceptions are not.
      expect(consoleErrors, `unexpected page errors: ${consoleErrors.join(" | ")}`).toEqual([]);
    } finally {
      await ctx.close();
    }
  });
});

async function isWebReachable(): Promise<boolean> {
  try {
    const res = await fetch(WEB_URL, { signal: AbortSignal.timeout(2000) });
    return res.status < 500;
  } catch {
    return false;
  }
}
