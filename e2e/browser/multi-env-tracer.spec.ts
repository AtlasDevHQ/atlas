import { test, expect, type APIRequestContext, type BrowserContext, type APIResponse } from "@playwright/test";
import { Client } from "pg";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  signInWithPassword,
  satisfyTotpChallenge,
  type HttpReply,
  type HttpRequestInit,
} from "./lib/admin-auth";

/**
 * Multi-environment tracer — real-API e2e (no route mocks).
 *
 * Companion to `multi-env-admin.integration.spec.ts` (route-mock UI
 * integration). This spec drives the live admin API to confirm that
 * three Postgres backends behind one workspace are independently
 * routable. The local overlay seeds them with **divergent** row counts
 * + a schema difference in prod, so a routing bug — e.g. the picker
 * silently falls through to dev — surfaces as a count mismatch rather
 * than as identical-success false greens.
 *
 * Prereqs (skipped if missing — see `assertOverlay()` below):
 *   docker compose -f docker-compose.yml -f docker-compose.multi-env.yml up -d
 *   ATLAS_DEPLOY_MODE=self-hosted bun run dev:api
 *   bun scripts/seed-multi-env.ts   (one-time MFA enrol; saves .atlas/mfa-secret)
 *
 * Independent auth flow:
 *   The shared `global-setup.ts` doesn't satisfy MFA — admin@useatlas.dev
 *   requires TOTP via the `mfaRequired` gate. This spec does its own
 *   sign-in inside the test, reading the secret that `seed-multi-env.ts`
 *   enrolled on its first run. Cookies are pushed into
 *   `context.addCookies()` so the browser navigation step is
 *   admin-authed without depending on storage-state.
 */

const API_URL = process.env.ATLAS_API_URL ?? "http://localhost:3001";
const WEB_URL = process.env.BASE_URL ?? "http://localhost:3000";
const SECRET_FILE = resolve(process.cwd(), ".atlas", "mfa-secret");
// Mirrors PASSWORDS order in `scripts/seed-multi-env.ts`: tracer
// password first because that's what the seed rotated to; `atlas-dev`
// only matters on a fresh DB before the seed has run.
const PASSWORDS = [
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
      // intentionally ignored: best-effort socket teardown after probe;
      // the assertion has already passed/failed by this point.
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
    // intentionally ignored: see assertOverlay.
    await client.end().catch(() => {});
  }
}

// ─── HttpShim for APIRequestContext ──────────────────────────────────
//
// Playwright's APIRequestContext carries its own cookie jar across
// calls within the same context — the shim just wraps the request +
// surfaces the standard `{ status, body, rawText }` envelope so the
// shared `lib/admin-auth` helpers can run against it.

function buildShim(request: APIRequestContext) {
  return async <T = unknown>(path: string, init: HttpRequestInit): Promise<HttpReply<T>> => {
    const url = `${API_URL}${path}`;
    let res: APIResponse;
    const headers = { origin: API_URL, ...(init.headers ?? {}) };
    if (init.method === "GET") {
      res = await request.get(url, { headers });
    } else {
      res = await request.post(url, {
        headers: { ...headers, "content-type": "application/json" },
        data: init.body,
      });
    }
    const text = await res.text();
    let body: T | null = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text) as T;
      } catch (err) {
        console.warn(
          `[multi-env-tracer] non-JSON body on ${init.method} ${path} (${res.status()}): ` +
            `${text.slice(0, 200)}${text.length > 200 ? "..." : ""} ` +
            `(${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }
    return { status: res.status(), body, rawText: text };
  };
}

interface AuthCookie { name: string; value: string }

/**
 * Drive the Better Auth sign-in + TOTP challenge so subsequent
 * `request.*` calls (and the browser context if mirrored) are
 * admin-authed and MFA-satisfied.
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
  const shim = buildShim(request);

  await signInWithPassword(shim, "admin@useatlas.dev", PASSWORDS);
  await satisfyTotpChallenge(shim, secret);

  const state = await request.storageState();
  const apiOrigin = new URL(API_URL);
  return state.cookies
    .filter((c) => c.domain === apiOrigin.hostname || c.domain === `.${apiOrigin.hostname}`)
    .map((c) => ({ name: c.name, value: c.value }));
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
// Admin probes go through with `x-atlas-mode: developer` because the
// seed flow stamps new connections as `status='draft'` (per the 1.4.4
// publish model). Published-mode requests filter drafts out via
// `getVisibleConnectionIds`, so a 404 here would otherwise be a false
// failure — the connections genuinely exist but aren't visible without
// the dev-mode header.

const DEV_MODE_HEADERS = { "x-atlas-mode": "developer" } as const;

async function adminGet<T>(request: APIRequestContext, path: string): Promise<{ status: number; body: T | null }> {
  const res = await request.get(`${API_URL}${path}`, { headers: { origin: API_URL, ...DEV_MODE_HEADERS } });
  const text = await res.text();
  let body: T | null = null;
  try { body = text.length > 0 ? (JSON.parse(text) as T) : null; } catch { body = null; }
  return { status: res.status(), body };
}

async function adminPost<T>(request: APIRequestContext, path: string, data?: unknown): Promise<{ status: number; body: T | null }> {
  const res = await request.post(`${API_URL}${path}`, {
    headers: { origin: API_URL, ...DEV_MODE_HEADERS, "content-type": "application/json" },
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
    // Single sign-in covers both the API assertions and the UI gate so
    // we stay under Better Auth's 10/60s sign-in budget across parallel
    // workers + back-to-back runs.

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

    // ── 4. Regression gate: /admin/connections must render without
    //       uncaught exceptions even if useAdminFetch returns an
    //       unexpected shape. The page's defensive Array.isArray()
    //       guard would suppress the crash but emit a console.warn
    //       prefixed `[admin/connections]` — we assert that warn never
    //       fires so the underlying schema-drift root cause doesn't
    //       hide behind the guard.
    if (!(await isWebReachable())) {
      console.warn(`Web dev server not reachable at ${WEB_URL}; skipping UI regression gate.`);
      return;
    }
    const ctx = await browser.newContext({ baseURL: WEB_URL });
    await ctx.addCookies([
      ...cookiesForDomain(cookies, WEB_URL),
      ...cookiesForDomain(cookies, API_URL),
    ]);
    const page = await ctx.newPage();
    try {
      const pageErrors: string[] = [];
      const consoleMessages: string[] = [];
      page.on("pageerror", (err) => pageErrors.push(err.message));
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
        await expect(heading).toBeVisible({ timeout: 15_000 });
      } catch (err) {
        throw new Error(
          [
            `Connections heading not visible after navigation.`,
            `Navigation status: ${resp?.status() ?? "?"}; final URL: ${page.url()}`,
            `Page errors: ${pageErrors.join(" | ") || "(none)"}`,
            `Console warnings/errors: ${consoleMessages.slice(0, 10).join(" | ") || "(none)"}`,
            `Failed requests: ${failedRequests.slice(0, 5).join(" | ") || "(none)"}`,
            `Underlying: ${err instanceof Error ? err.message : String(err)}`,
          ].join("\n"),
        );
      }
      // Uncaught JS errors are the prod regression signature.
      expect(pageErrors, `unexpected page errors: ${pageErrors.join(" | ")}`).toEqual([]);
      // The page-level defensive guard emits a warning prefixed
      // `[admin/connections]` when it has to fall back. If that fires,
      // the schema-drift root cause has recurred even though the page
      // still rendered — gate against that too.
      const guardActivations = consoleMessages.filter((m) => m.includes("[admin/connections]"));
      expect(guardActivations, `defensive guard fired: ${guardActivations.join(" | ")}`).toEqual([]);
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
    // intentionally ignored: probe-only — distinguishing ECONNREFUSED
    // from TLS handshake from DNS error wouldn't change the soft-skip
    // outcome, and `console.debug` would clutter the test log.
    return false;
  }
}
