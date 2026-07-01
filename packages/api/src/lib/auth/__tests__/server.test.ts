import { describe, it, expect, afterEach } from "bun:test";
import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins";
import { memoryAdapter } from "better-auth/adapters/memory";
import { apiKey } from "@better-auth/api-key";
import { APIError } from "better-auth/api";
import {
  resetAuthInstance,
  canMintSCIMToken,
  assertInvitationRoleAllowed,
  isTransportError,
  buildPlugins,
  buildSignupCaptchaPlugin,
  resolvePasskeyRpId,
  DEFAULT_RP_ID,
} from "../server";

describe("Better Auth instance shape", () => {
  afterEach(() => {
    resetAuthInstance();
  });

  it("betterAuth() with @better-auth/api-key returns expected shape", async () => {
    // Verify the `as unknown as AuthInstance` cast in server.ts doesn't
    // hide a missing property. This uses the real betterAuth() constructor
    // with the same plugins as production.
    const instance = betterAuth({
      // Minimal adapter stub — enough for construction, never queried.
      database: {
        db: null,
        type: "sqlite",
      } as unknown as Parameters<typeof betterAuth>[0]["database"],
      secret: "test-secret-at-least-32-characters-long",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Better Auth plugin types are complex union types that vary by plugin combination
      plugins: [bearer(), apiKey()] as any[],
    });

    expect(typeof instance.handler).toBe("function");
    expect(typeof instance.api.getSession).toBe("function");
    expect(instance.$context).toBeInstanceOf(Promise);

    // Drain the $context promise so the async DB adapter init error
    // doesn't surface as an unhandled rejection after the test ends.
    await instance.$context.catch(() => {});
  });
});

// #2242 — regression coverage for the SCIM token role gate. The previous
// gate accepted {admin, platform_admin} only; an org owner would pass the
// upstream admin SCIM router (which accepts owner via adminAuth) and then
// bomb at this predicate with "Only admin users can generate SCIM
// tokens". Aligning to the canonical ADMIN_ROLES triple closes that
// inconsistency.
describe("canMintSCIMToken", () => {
  it("accepts admin", () => {
    expect(canMintSCIMToken("admin")).toBe(true);
  });

  it("accepts owner — #2242 regression", () => {
    expect(canMintSCIMToken("owner")).toBe(true);
  });

  it("accepts platform_admin", () => {
    expect(canMintSCIMToken("platform_admin")).toBe(true);
  });

  it("rejects member", () => {
    expect(canMintSCIMToken("member")).toBe(false);
  });

  it("rejects undefined / missing role", () => {
    expect(canMintSCIMToken(undefined)).toBe(false);
    expect(canMintSCIMToken(null)).toBe(false);
  });

  it("rejects unknown / typo'd role values", () => {
    expect(canMintSCIMToken("administrator")).toBe(false);
    expect(canMintSCIMToken("Owner")).toBe(false);
    expect(canMintSCIMToken("")).toBe(false);
    expect(canMintSCIMToken(42)).toBe(false);
  });
});

describe("assertInvitationRoleAllowed", () => {
  it("accepts member role", () => {
    expect(() => assertInvitationRoleAllowed("member")).not.toThrow();
  });

  it("accepts admin role", () => {
    expect(() => assertInvitationRoleAllowed("admin")).not.toThrow();
  });

  it("accepts owner role", () => {
    expect(() => assertInvitationRoleAllowed("owner")).not.toThrow();
  });

  it("rejects platform_admin single string", () => {
    expect(() => assertInvitationRoleAllowed("platform_admin")).toThrow(APIError);
  });

  it("rejects PLATFORM_ADMIN casing variant", () => {
    expect(() => assertInvitationRoleAllowed("PLATFORM_ADMIN")).toThrow(APIError);
  });

  it("rejects ' platform_admin ' with surrounding whitespace", () => {
    expect(() => assertInvitationRoleAllowed(" platform_admin ")).toThrow(APIError);
  });

  it("rejects mixed-case 'Platform_Admin'", () => {
    expect(() => assertInvitationRoleAllowed("Platform_Admin")).toThrow(APIError);
  });

  it("rejects array role containing platform_admin", () => {
    expect(() => assertInvitationRoleAllowed(["member", "platform_admin"])).toThrow(APIError);
  });

  it("rejects array role with cased PLATFORM_ADMIN", () => {
    expect(() => assertInvitationRoleAllowed(["admin", "PLATFORM_ADMIN"])).toThrow(APIError);
  });

  it("accepts array role with no platform_admin", () => {
    expect(() => assertInvitationRoleAllowed(["member", "admin"])).not.toThrow();
  });

  it("ignores null / undefined entries", () => {
    expect(() => assertInvitationRoleAllowed([null, "member"])).not.toThrow();
    expect(() => assertInvitationRoleAllowed(undefined)).not.toThrow();
  });
});

describe("isTransportError", () => {
  it("matches pg connection-reset code", () => {
    const err = Object.assign(new Error("connection closed"), { code: "ECONNRESET" });
    expect(isTransportError(err)).toBe(true);
  });

  it("matches pg admin-shutdown code 57P01", () => {
    const err = Object.assign(new Error("server shut down"), { code: "57P01" });
    expect(isTransportError(err)).toBe(true);
  });

  it("matches connection-class SQLSTATE codes (08xxx)", () => {
    const err = Object.assign(new Error("connection failure"), { code: "08006" });
    expect(isTransportError(err)).toBe(true);
  });

  it("matches 'connection terminated' message", () => {
    expect(isTransportError(new Error("connection terminated unexpectedly"))).toBe(true);
  });

  it("matches 'pool ended' message", () => {
    expect(isTransportError(new Error("pool ended"))).toBe(true);
  });

  it("rejects programmer errors (syntax error)", () => {
    expect(isTransportError(new Error("syntax error at or near 'WHERE'"))).toBe(false);
  });

  it("rejects TypeError for malformed response", () => {
    expect(isTransportError(new TypeError("Cannot read property 'allowed' of undefined"))).toBe(false);
  });

  it("rejects non-Error values", () => {
    expect(isTransportError("connection terminated")).toBe(false);
    expect(isTransportError(null)).toBe(false);
    expect(isTransportError(undefined)).toBe(false);
  });
});

describe("organization plugin wiring", () => {
  // Wiring assertion — `requireEmailVerificationOnInvitation: true` closes
  // the invitation-claiming-via-signup oracle. A Better Auth upgrade that
  // renames or defaults this option silently re-opens the path.
  it("requireEmailVerificationOnInvitation is wired to true", () => {
    const plugins = buildPlugins();
    const org = plugins.find((p: { id?: string }) => p.id === "organization");
    expect(org).toBeDefined();
    // The plugin stores its options under `.options` after construction.
    // Different Better Auth versions have shipped the option under one of
    // a few keys (`options`, `_config`); probe both.
    const opts =
      (org as { options?: { requireEmailVerificationOnInvitation?: boolean } }).options
      ?? (org as { _config?: { requireEmailVerificationOnInvitation?: boolean } })._config
      ?? (org as Record<string, unknown>);
    // If neither shape is present, the assertion below still trips on
    // `undefined`, surfacing the BA shape change to the next maintainer.
    expect((opts as { requireEmailVerificationOnInvitation?: boolean }).requireEmailVerificationOnInvitation).toBe(true);
  });

  it("organization plugin exposes invitation hooks", () => {
    const plugins = buildPlugins();
    const org = plugins.find((p: { id?: string }) => p.id === "organization");
    expect(org).toBeDefined();
  });

  // #4046 / ADR-0027 §6 — the workspace-scoped API key path is inert unless the
  // apiKey() plugin is wired. The plugin's options (`enableMetadata` /
  // `enableSessionForAPIKeys`) are NOT introspectable on the constructed plugin
  // object, so this guards the weaker-but-load-bearing invariant that the plugin
  // stays present in buildPlugins(); the end-to-end metadata/session behavior is
  // pinned by managed.test.ts (enrichment) + admin-workspace-keys.test.ts (mint).
  it("buildPlugins() includes the api-key plugin (workspace-key path, #4046)", () => {
    const plugins = buildPlugins();
    const apiKeyPlugin = plugins.find((p: { id?: string }) => p.id === "api-key");
    expect(apiKeyPlugin).toBeDefined();
  });
});

// #4159 — Cloudflare Turnstile moved OFF the headless MCP `start_trial` door
// (a non-browser caller can't solve it) ONTO the interactive web email/password
// signup. The captcha plugin is scoped to `/sign-up/email` only and is
// registered iff `TURNSTILE_SECRET_KEY` is set (a secretless registration would
// 500 every matched request). `buildSignupCaptchaPlugin` takes env explicitly so
// these cases are pure — no process.env mutation, no shared-state leakage.
describe("buildSignupCaptchaPlugin (#4159)", () => {
  it("returns null when TURNSTILE_SECRET_KEY is unset (no captcha → self-hosted signup unbroken)", () => {
    expect(buildSignupCaptchaPlugin({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it("builds a cloudflare-turnstile captcha scoped to /sign-up/email ONLY when the secret is set", () => {
    const plugin = buildSignupCaptchaPlugin({
      TURNSTILE_SECRET_KEY: "0xSECRET-test",
    } as NodeJS.ProcessEnv);
    expect(plugin).not.toBeNull();
    expect(plugin?.id).toBe("captcha");
    // `.options` is typed as CaptchaOptions on the plugin's return, so read it
    // directly (provider/secretKey/endpoints are all on the union).
    expect(plugin?.options.provider).toBe("cloudflare-turnstile");
    expect(plugin?.options.secretKey).toBe("0xSECRET-test");
    // Signup-only: NOT the plugin's default set (which also gates /sign-in/email
    // and /request-password-reset). Proof-of-human is a signup-only control here.
    expect(plugin?.options.endpoints).toEqual(["/sign-up/email"]);
  });

  it("buildPlugins() registers the captcha plugin when the secret is present", () => {
    const prev = process.env.TURNSTILE_SECRET_KEY;
    process.env.TURNSTILE_SECRET_KEY = "0xSECRET-buildplugins";
    try {
      const plugins = buildPlugins();
      const captchaPlugin = plugins.find((p: { id?: string }) => p.id === "captcha");
      expect(captchaPlugin).toBeDefined();
    } finally {
      if (prev === undefined) delete process.env.TURNSTILE_SECRET_KEY;
      else process.env.TURNSTILE_SECRET_KEY = prev;
    }
  });

  it("buildPlugins() omits the captcha plugin when the secret is absent", () => {
    const prev = process.env.TURNSTILE_SECRET_KEY;
    delete process.env.TURNSTILE_SECRET_KEY;
    try {
      const plugins = buildPlugins();
      const captchaPlugin = plugins.find((p: { id?: string }) => p.id === "captcha");
      expect(captchaPlugin).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.TURNSTILE_SECRET_KEY;
      else process.env.TURNSTILE_SECRET_KEY = prev;
    }
  });
});

// #4159 — the load-bearing guarantee behind moving Turnstile onto the web
// signup: the captcha plugin gates the HTTP `/sign-up/email` door but NEVER the
// in-process `auth.api.signUpEmail` seam that `provisionTrialWorkspace` (the MCP
// `start_trial` path) uses. The captcha is `onRequest` middleware, which fires
// only through Better Auth's HTTP router; direct `auth.api.*` calls bypass it.
describe("captcha gates the HTTP signup door only, not the in-process seam (#4159)", () => {
  afterEach(() => {
    resetAuthInstance();
  });

  function instanceWithCaptcha() {
    const captchaPlugin = buildSignupCaptchaPlugin({
      TURNSTILE_SECRET_KEY: "0xSECRET-test",
    } as NodeJS.ProcessEnv);
    return betterAuth({
      baseURL: "http://localhost:3000",
      // Real in-memory adapter so both the HTTP handler and the in-process
      // `auth.api` seam actually run (a null adapter fails `$context` init
      // before either can exercise the captcha boundary). The core email/
      // password models must be declared up-front — the memory adapter throws
      // "Model … not found" for a table it wasn't given.
      database: memoryAdapter({ user: [], account: [], session: [], verification: [] }),
      secret: "test-secret-at-least-32-characters-long",
      emailAndPassword: { enabled: true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Better Auth plugin union types
      plugins: [captchaPlugin] as any[],
    });
  }

  it("rejects an HTTP /sign-up/email with NO x-captcha-response header (400)", async () => {
    const instance = instanceWithCaptcha();
    const res = await instance.handler(
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "a@b.com", password: "password123", name: "A" }),
      }),
    );
    // The captcha onRequest short-circuits the HTTP door — a missing token is
    // the plugin's 400 MISSING_RESPONSE body.
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("CAPTCHA");
    await instance.$context.catch(() => {});
  });

  it("does NOT gate the in-process auth.api.signUpEmail seam — the MCP trial path needs no token", async () => {
    const instance = instanceWithCaptcha();
    // The in-process call bypasses `onRequest` (which fires only through the
    // HTTP router), so it is NOT rejected for a missing CAPTCHA — it runs to
    // completion and creates the user. If a future change made the captcha fire
    // on in-process calls, this would throw the MISSING_RESPONSE captcha error
    // and the headless MCP `start_trial` door would break (#4159).
    const out = await instance.api.signUpEmail({
      body: { email: "seam@example.com", password: "password123", name: "Seam" },
    });
    expect(out.user.email).toBe("seam@example.com");
    await instance.$context.catch(() => {});
  });
});

// #3159 — the Better Auth admin plugin authorized the caller off the RAW
// `user.role` column (via `hasPermission`), a contained-but-live footgun after
// #2890. It was removed entirely; its consumers are direct internal-DB ops and
// ban enforcement is reproduced via the session-create hook + a per-request
// check. This test is the runtime half of the reintroduction guard (the static
// half is scripts/check-no-admin-plugin.sh): a future `admin()` re-add trips
// here. If you genuinely need it back, you are also re-adding the raw-role
// authorization seam — reconsider.
describe("admin plugin removal (#3159)", () => {
  it("buildPlugins() contains no Better Auth admin plugin", () => {
    const plugins = buildPlugins();
    const adminPlugin = plugins.find((p: { id?: string }) => p.id === "admin");
    expect(adminPlugin).toBeUndefined();
  });
});

// #3045 — WebAuthn rpID silently defaulted to the prod domain on every deploy
// whose ATLAS_RPID was unset, breaking passkeys with an opaque browser error
// on staging / self-hosted custom domains / preview envs. The resolver derives
// the rpID from the configured web origin when ATLAS_RPID is unset and fails
// loud at boot when the effective rpID can't be valid for that origin.
//
// resolvePasskeyRpId takes (env, webOrigin) explicitly so these cases are pure
// — no process.env / getWebOrigin() mutation, no shared-state leakage between
// the subprocess-isolated test files.
describe("resolvePasskeyRpId (#3045)", () => {
  describe("ATLAS_RPID unset → derive from the web origin host", () => {
    it("prod web origin derives app.useatlas.dev — unchanged from the legacy default, no passkey invalidation", () => {
      expect(resolvePasskeyRpId({}, "https://app.useatlas.dev")).toBe("app.useatlas.dev");
      // The pre-#3045 hardcoded default; deriving must reproduce it exactly so
      // no enrolled prod passkey is invalidated.
      expect(resolvePasskeyRpId({}, "https://app.useatlas.dev")).toBe(DEFAULT_RP_ID);
    });

    it("staging web origin derives app.staging.useatlas.dev (the value silently wrong before)", () => {
      expect(resolvePasskeyRpId({}, "https://app.staging.useatlas.dev")).toBe(
        "app.staging.useatlas.dev",
      );
    });

    it("localhost dev origin derives localhost — passkeys now work locally without an explicit override", () => {
      expect(resolvePasskeyRpId({}, "http://localhost:3000")).toBe("localhost");
    });

    it("an empty ATLAS_RPID is treated as unset (falls through to derive)", () => {
      expect(resolvePasskeyRpId({ ATLAS_RPID: "" }, "https://app.staging.useatlas.dev")).toBe(
        "app.staging.useatlas.dev",
      );
      expect(resolvePasskeyRpId({ ATLAS_RPID: "   " }, "https://app.staging.useatlas.dev")).toBe(
        "app.staging.useatlas.dev",
      );
    });
  });

  describe("explicit ATLAS_RPID always overrides", () => {
    it("explicit value wins over the derived origin host", () => {
      // Origin host is app.useatlas.dev (what derivation would pick), but the
      // operator pins the parent domain — the explicit value must win.
      expect(
        resolvePasskeyRpId({ ATLAS_RPID: "useatlas.dev" }, "https://app.useatlas.dev"),
      ).toBe("useatlas.dev");
    });

    it("explicit value is trimmed", () => {
      expect(
        resolvePasskeyRpId({ ATLAS_RPID: "  app.useatlas.dev  " }, "https://app.useatlas.dev"),
      ).toBe("app.useatlas.dev");
    });
  });

  describe("registrable-domain suffix is valid", () => {
    it("a parent domain of the origin host is accepted", () => {
      // useatlas.dev is a registrable-domain suffix of app.staging.useatlas.dev.
      expect(
        resolvePasskeyRpId({ ATLAS_RPID: "useatlas.dev" }, "https://app.staging.useatlas.dev"),
      ).toBe("useatlas.dev");
      expect(
        resolvePasskeyRpId({ ATLAS_RPID: "staging.useatlas.dev" }, "https://app.staging.useatlas.dev"),
      ).toBe("staging.useatlas.dev");
    });
  });

  describe("hostname comparison is case-insensitive (DNS)", () => {
    it("a mixed-case explicit rpID is valid for a lowercase origin host — no false-positive fail-loud", () => {
      // new URL().hostname lowercases the origin host; the operator-typed
      // explicit value may carry case. The boot assertion must compare
      // case-insensitively or it would wrongly refuse to boot a correctly
      // configured deploy. The returned value is left verbatim (rpID stability).
      expect(
        resolvePasskeyRpId({ ATLAS_RPID: "App.UseAtlas.DEV" }, "https://app.useatlas.dev"),
      ).toBe("App.UseAtlas.DEV");
      expect(
        resolvePasskeyRpId({ ATLAS_RPID: "UseAtlas.DEV" }, "https://app.staging.useatlas.dev"),
      ).toBe("UseAtlas.DEV");
    });

    it("a mixed-case origin host derives a lowercase rpID (URL normalization is pinned)", () => {
      // Locks in that derivation goes through new URL().hostname (which
      // lowercases) — a future refactor to raw string slicing would silently
      // shift the rpID and invalidate enrolled keys.
      expect(resolvePasskeyRpId({}, "https://App.Staging.UseAtlas.DEV")).toBe(
        "app.staging.useatlas.dev",
      );
    });
  });

  describe("invalid explicit rpID for the web origin → fail loud at boot", () => {
    it("prod rpID on a staging origin throws an actionable error", () => {
      expect(() =>
        resolvePasskeyRpId({ ATLAS_RPID: "app.useatlas.dev" }, "https://app.staging.useatlas.dev"),
      ).toThrow(/not valid for the configured web origin/);
    });

    it("error names both the rpID and the origin host, and how to fix it", () => {
      try {
        resolvePasskeyRpId({ ATLAS_RPID: "app.useatlas.dev" }, "https://app.staging.useatlas.dev");
        throw new Error("expected resolvePasskeyRpId to throw");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        expect(message).toContain("app.useatlas.dev"); // the bad rpID
        expect(message).toContain("app.staging.useatlas.dev"); // the origin host
        expect(message).toContain("ATLAS_RPID"); // the env var to fix
      }
    });

    it("an unrelated registrable domain throws (suffix without a dot boundary is not a match)", () => {
      // "useatlas.dev" must NOT validate against "notuseatlas.dev" — a plain
      // endsWith would falsely accept it; the dot-boundary check rejects it.
      expect(() =>
        resolvePasskeyRpId({ ATLAS_RPID: "useatlas.dev" }, "https://notuseatlas.dev"),
      ).toThrow(/not valid for the configured web origin/);
    });
  });

  describe("no web origin configured → legacy default, never a hard-fail", () => {
    it("null web origin + ATLAS_RPID unset → legacy default, no throw", () => {
      expect(resolvePasskeyRpId({}, null)).toBe(DEFAULT_RP_ID);
    });

    it("null web origin + explicit ATLAS_RPID → explicit wins, no assertion", () => {
      // Self-hosted single-origin: nothing to validate against, so even an
      // arbitrary explicit value is honored rather than rejected.
      expect(resolvePasskeyRpId({ ATLAS_RPID: "auth.example.com" }, null)).toBe("auth.example.com");
    });

    it("unparseable web origin is treated as no-origin (no throw, no validation)", () => {
      // An unparseable CORS/trusted-origin entry can't be validated against;
      // the resolver logs at error level and degrades to the explicit/default
      // value rather than crashing.
      expect(resolvePasskeyRpId({ ATLAS_RPID: "auth.example.com" }, "not-a-url")).toBe(
        "auth.example.com",
      );
      expect(resolvePasskeyRpId({}, "not-a-url")).toBe(DEFAULT_RP_ID);
    });

    it("scheme-less host:port origin parses to an empty host → no-origin, no throw", () => {
      // "app.example.com:3000" parses as protocol "app.example.com:" with an
      // empty hostname — not the validatable case, so validation is skipped
      // (logged at error level) and an explicit-but-arbitrary value is honored
      // rather than triggering a false fail-loud.
      expect(resolvePasskeyRpId({}, "app.example.com:3000")).toBe(DEFAULT_RP_ID);
      expect(resolvePasskeyRpId({ ATLAS_RPID: "auth.example.com" }, "localhost:3000")).toBe(
        "auth.example.com",
      );
    });
  });

  describe("IP-literal origin → resolves but does not throw (passkeys can't work on an IP)", () => {
    it("an IPv4 origin derives the IP rpID without throwing (suffix-equal), logged loud elsewhere", () => {
      // WebAuthn rpIDs can't be IPs, so passkeys are effectively disabled here —
      // but we must NOT throw (that would break non-passkey managed auth for a
      // dev on an IP host, and there's no valid rpID to substitute).
      expect(resolvePasskeyRpId({}, "http://127.0.0.1:3000")).toBe("127.0.0.1");
      expect(resolvePasskeyRpId({}, "http://192.168.1.50:3000")).toBe("192.168.1.50");
    });

    it("an explicit IP rpID matching an IP origin resolves without throwing", () => {
      expect(resolvePasskeyRpId({ ATLAS_RPID: "127.0.0.1" }, "http://127.0.0.1:3000")).toBe(
        "127.0.0.1",
      );
    });

    it("localhost (a name, not an IP) derives normally", () => {
      // Regression guard: the IP check must not catch the valid `localhost` rpID.
      expect(resolvePasskeyRpId({}, "http://localhost:3000")).toBe("localhost");
    });
  });
});
