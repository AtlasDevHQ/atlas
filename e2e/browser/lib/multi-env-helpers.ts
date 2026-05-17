/**
 * Shared scaffolding for the multi-env content-routing specs (#2441 follow-on
 * to #2443's deferred multi-group checklist items).
 *
 * Each spec needs the same three things: an MFA-satisfied admin
 * `APIRequestContext`, typed accessors for the admin/list endpoints we touch,
 * and a soft-delete sweep so a failed spec doesn't poison the next run.
 * Everything here is API-only — the existing `multi-env-tracer.spec.ts` already
 * carries the canonical UI gate for `/admin/connections`, and that's the only
 * page where the wire shape and the rendered tree diverge meaningfully.
 *
 * Why not `globalSetup`: spec files run in their own workers; sharing setup
 * across them would force serial execution. The helper instead does a fresh
 * sign-in per spec (cheap — the seed has already rotated to the known
 * tracer password) and resolves groups by name.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { APIRequestContext, APIResponse, PlaywrightWorkerArgs } from "@playwright/test";
import { request as playwrightRequest, test } from "@playwright/test";
import {
  signInWithPassword,
  satisfyTotpChallenge,
  type HttpRequestInit,
  type HttpReply,
} from "./admin-auth";

export const API_URL = process.env.ATLAS_API_URL ?? "http://localhost:3001";
const SECRET_FILE = resolve(process.cwd(), ".atlas", "mfa-secret");

// Mirror the seed's rotated password first.
const PASSWORDS = [
  process.env.ATLAS_ADMIN_PASSWORD,
  "atlas-multi-env-tracer!",
  "atlas-dev",
].filter((p): p is string => typeof p === "string" && p.length > 0);

// Draft-content surfaces 404 in published mode (#2412 + 1.4.4 publish model).
// All admin calls here go through with `x-atlas-mode: developer` for the same
// reason the tracer spec does — we're exercising content the tests just
// created, which is unpublished.
const DEV_MODE_HEADERS = { "x-atlas-mode": "developer" } as const;

function buildShim(request: APIRequestContext) {
  return async <T = unknown>(path: string, init: HttpRequestInit): Promise<HttpReply<T>> => {
    const url = `${API_URL}${path}`;
    const headers = { origin: API_URL, ...(init.headers ?? {}) };
    let res: APIResponse;
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
      } catch {
        // Non-JSON 5xx error pages aren't actionable — surface status only.
      }
    }
    return { status: res.status(), body, rawText: text };
  };
}

/**
 * Drive Better Auth sign-in + TOTP for `admin@useatlas.dev`. Skips the
 * caller's test if the seed hasn't been run (no `.atlas/mfa-secret`).
 *
 * Each call burns one against Better Auth's sign-in budget (10/60s per
 * identifier across the deploy), so prefer `createAdminRequestContext` for
 * spec-level `beforeAll`: it authenticates a brand-new APIRequestContext
 * once and returns it for reuse across every test in the file.
 */
export async function signInMultiEnvAdmin(request: APIRequestContext): Promise<void> {
  if (!existsSync(SECRET_FILE)) {
    test.skip(
      true,
      `MFA secret not found at ${SECRET_FILE}. Run \`bun scripts/seed-multi-env.ts\` first.`,
    );
    return;
  }
  const secret = readFileSync(SECRET_FILE, "utf8").trim();
  const shim = buildShim(request);
  await signInWithPassword(shim, "admin@useatlas.dev", PASSWORDS);
  await satisfyTotpChallenge(shim, secret);
}

/** Storage file written by `multi-env-setup.ts` after the one-time auth. */
const MULTI_ENV_STORAGE_STATE = resolve(__dirname, "..", "multi-env-storage.json");

/**
 * Create an admin-authenticated `APIRequestContext` by replaying the
 * cookie jar that `multi-env-setup.ts` saved on its single sign-in.
 * Specs call this from `beforeAll`; the returned context survives every
 * test in the file. Re-using one storage state across all multi-env specs
 * keeps total Better Auth sign-ins per `playwright test` invocation at 1
 * — required to stay under the 10/60s budget.
 *
 * Falls back to an inline sign-in if the storage state isn't there yet
 * (lets you run a single spec in isolation without the project dep). The
 * fallback path still goes through the same rate-limited endpoints, so
 * it's only safe for ad-hoc one-spec invocations.
 */
export async function createAdminRequestContext(
  playwright: PlaywrightWorkerArgs["playwright"] | typeof playwrightRequest,
): Promise<APIRequestContext> {
  const factory: { newContext: typeof playwrightRequest.newContext } =
    "request" in playwright ? playwright.request : (playwright as typeof playwrightRequest);
  if (existsSync(MULTI_ENV_STORAGE_STATE)) {
    return factory.newContext({
      baseURL: API_URL,
      storageState: MULTI_ENV_STORAGE_STATE,
    });
  }
  const request = await factory.newContext({ baseURL: API_URL });
  await signInMultiEnvAdmin(request);
  return request;
}

export interface AdminCallOpts {
  /** Body payload — encoded as JSON. Ignored for GET / DELETE. */
  body?: unknown;
  /** Extra query string to append (without leading `?`). */
  query?: string;
}

export interface AdminReply<T> {
  status: number;
  body: T | null;
  rawText: string;
}

async function adminCall<T>(
  request: APIRequestContext,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  opts: AdminCallOpts = {},
): Promise<AdminReply<T>> {
  const url = `${API_URL}${path}${opts.query ? `?${opts.query}` : ""}`;
  const headers = { origin: API_URL, ...DEV_MODE_HEADERS } as Record<string, string>;
  let res: APIResponse;
  if (method === "GET") {
    res = await request.get(url, { headers });
  } else if (method === "DELETE") {
    res = await request.delete(url, { headers });
  } else {
    res = await request.fetch(url, {
      method,
      headers: { ...headers, "content-type": "application/json" },
      data: opts.body ?? {},
    });
  }
  const text = await res.text();
  let body: T | null = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text) as T;
    } catch {
      body = null;
    }
  }
  return { status: res.status(), body, rawText: text };
}

export const adminGet = <T>(req: APIRequestContext, path: string, opts?: AdminCallOpts) =>
  adminCall<T>(req, "GET", path, opts);
export const adminPost = <T>(req: APIRequestContext, path: string, body?: unknown, opts?: AdminCallOpts) =>
  adminCall<T>(req, "POST", path, { ...opts, body });
export const adminPut = <T>(req: APIRequestContext, path: string, body?: unknown) =>
  adminCall<T>(req, "PUT", path, { body });
export const adminPatch = <T>(req: APIRequestContext, path: string, body?: unknown) =>
  adminCall<T>(req, "PATCH", path, { body });
export const adminDelete = <T>(req: APIRequestContext, path: string) =>
  adminCall<T>(req, "DELETE", path);

// ── Group resolution ────────────────────────────────────────────────

export interface GroupRow {
  id: string;
  name: string;
  status?: string;
  primaryConnectionId?: string | null;
  resolvedConnectionId?: string | null;
}
interface GroupsResp { groups: GroupRow[] }

/**
 * Resolve a group id by name. The seed provisions `dev`, `staging`, `prod`;
 * any other name is treated as a spec-created throwaway and `null` is a
 * legitimate result (so the caller can decide between create-or-skip).
 */
export async function findGroupByName(
  request: APIRequestContext,
  name: string,
): Promise<GroupRow | null> {
  const r = await adminGet<GroupsResp>(request, "/api/v1/admin/connection-groups", { query: "includeArchived=true" });
  if (r.status !== 200 || !r.body) return null;
  return r.body.groups.find((g) => g.name === name) ?? null;
}

/**
 * Guard against running on a workspace that hasn't been multi-env-seeded.
 * Returns the resolved `dev`, `staging`, `prod` rows or skips the test if
 * any are missing.
 */
export async function requireSeededGroups(request: APIRequestContext): Promise<{
  dev: GroupRow;
  staging: GroupRow;
  prod: GroupRow;
}> {
  const [dev, staging, prod] = await Promise.all([
    findGroupByName(request, "dev"),
    findGroupByName(request, "staging"),
    findGroupByName(request, "prod"),
  ]);
  if (!dev || !staging || !prod) {
    test.skip(
      true,
      `Multi-env seed missing: dev=${!!dev} staging=${!!staging} prod=${!!prod}. ` +
        `Run \`bun run db:multi-env:up && bun scripts/seed-multi-env.ts\`.`,
    );
    throw new Error("unreachable");
  }
  return { dev, staging, prod };
}
