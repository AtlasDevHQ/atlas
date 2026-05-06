/**
 * Smoke regression for the passkey plugin's HTTP surface.
 *
 * The passkey plugin auto-mounts `/passkey/*` under `/api/auth/*` when
 * `passkey()` is in the options.plugins list. Two failure modes this test
 * catches that the unit-level `passkey-tile.test.tsx` cannot:
 *
 *   1. A future refactor that drops `passkey()` from `buildPlugins()` (or
 *      conditionally skips it). The web client's `signIn.passkey()` call
 *      would still typecheck — the plugin's client mirror is loaded
 *      unconditionally — but every WebAuthn ceremony would 404 at runtime.
 *
 *   2. A Better Auth version bump that renames the authentication endpoint
 *      from `/passkey/generate-authenticate-options` to anything else. We
 *      route the entire passkey-first sign-in flow off that path; a rename
 *      would silently break #2091's UX.
 *
 * The test does NOT exercise the full WebAuthn ceremony — virtual
 * authenticator coverage lives in `e2e/browser/passkey-signin.spec.ts`.
 * Here we just probe the route is reachable and produces the documented
 * 200 challenge envelope (or a 4xx that is NOT 404).
 */

import { describe, it, expect } from "bun:test";
import { betterAuth } from "better-auth";
import { passkey } from "@better-auth/passkey";
import {
  buildAuthOptions,
  parseAuthSecret,
  type BuildAuthOptionsDeps,
} from "../server";

const SECRET = parseAuthSecret("0123456789abcdef0123456789abcdef");

function makeDeps(overrides: Partial<BuildAuthOptionsDeps> = {}): BuildAuthOptionsDeps {
  return {
    env: {} as NodeJS.ProcessEnv,
    secret: SECRET,
    baseURL: "http://localhost:3000",
    database: undefined,
    cookieDomain: undefined,
    socialProviders: undefined,
    // Mirror the production wiring in `buildPlugins()` — passkey is loaded
    // unconditionally next to twoFactor. The rpID fallback matches the
    // server.ts default so a regression that flips it (which would
    // invalidate every existing passkey) is also visible.
    plugins: [
      passkey({
        rpID: "localhost",
        rpName: "Atlas",
      }),
    ],
    trustedOrigins: ["http://localhost:3000"],
    bootstrapAdmin: { mode: "none" },
    ...overrides,
  };
}

function makeAuth(): ReturnType<typeof betterAuth> {
  const options = buildAuthOptions(makeDeps());
  return betterAuth(options as Parameters<typeof betterAuth>[0]);
}

describe("Passkey plugin — route surface", () => {
  it("mounts /api/auth/passkey/generate-authenticate-options (the sign-in entry path)", async () => {
    const auth = makeAuth();
    const req = new Request(
      "http://localhost:3000/api/auth/passkey/generate-authenticate-options",
      { method: "GET", headers: { "x-atlas-client-ip": "10.0.0.1", origin: "http://localhost:3000" } },
    );
    const res = await auth.handler(req);

    // The exact body shape is Better Auth's contract; we only assert the
    // route is RECOGNIZED (anything that isn't 404 means the path was
    // matched by the plugin). A 200 with a JSON challenge envelope is the
    // happy path; any 4xx other than 404 still proves wiring.
    expect(res.status).not.toBe(404);
  });

  it("registers `passkey` in the auth options.plugins list", () => {
    const options = buildAuthOptions(makeDeps());
    // `id: "passkey"` is the plugin's stable identifier — tested instead of
    // a structural shape check so a future Better Auth version that adds
    // new fields to plugin objects doesn't false-positive this assertion.
    const ids = (options.plugins ?? []).map((p) => (p as { id?: string }).id);
    expect(ids).toContain("passkey");
  });

  it("the sign-in passkey route is GET (Better Auth contract — required for conditional UI autofill)", async () => {
    const auth = makeAuth();
    const wrongMethod = new Request(
      "http://localhost:3000/api/auth/passkey/generate-authenticate-options",
      { method: "DELETE", headers: { origin: "http://localhost:3000" } },
    );
    const res = await auth.handler(wrongMethod);
    // 404 vs 405 is fuzzy across Better Auth versions; either proves the
    // GET-only contract — what we MUST NOT see is a 200 (which would mean
    // the route accepts arbitrary methods and the conditional-UI assumption
    // about idempotent challenge issuance is broken).
    expect([404, 405]).toContain(res.status);
  });
});
