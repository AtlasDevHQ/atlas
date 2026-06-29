import { describe, it, expect } from "bun:test";
import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins";
import { emailOTP } from "better-auth/plugins/email-otp";
import { buildAuthOptions, parseAuthSecret, type BuildAuthOptionsDeps } from "../server";

/**
 * Post-signup session-durability net (#4018 / #4086).
 *
 * #4018 fixed a brand-new signup landing in a broken app: after the OTP-verify
 * step every authed call 401'd. The durable regression net it left lived on the
 * WEB side (`buildAuthHeaders` unit tests + the OTP-hydration ordering) and in
 * the `/verify-prod-signup` primitive-8 runbook — there was no SERVER-side test
 * pinning the actual contract the web fix depends on. #4086 re-reported the same
 * dead-end (`POST /api/v1/onboarding/use-demo` → 401, `set-auth-token` returned
 * with "no Set-Cookie") against `v0.0.33`.
 *
 * The server-side contract the whole flow rests on, asserted here against a LIVE
 * Better Auth instance built through the SAME `buildAuthOptions` path production
 * uses:
 *
 *   In managed mode with `requireEmailVerification` on, the email-OTP
 *   `verify-email` step (`autoSignInAfterVerification`) MUST establish a durable,
 *   HOST-ONLY session cookie (ADR-0024 §5) that a subsequent COOKIE-ONLY request
 *   — no `Authorization` bearer, exactly how Atlas's `/api/v1` REST layer
 *   authenticates after #4018 — authenticates with.
 *
 * The `bearer()` plugin is loaded (as in production `buildPlugins()`) precisely
 * because the failure mode in #4086 was the response carrying ONLY the bearer
 * (`set-auth-token`) and no usable cookie. The bearer plugin's own after-hook
 * derives `set-auth-token` FROM the session `Set-Cookie`, so its presence here
 * proves the cookie is emitted — and the cookie-only `get-session` below proves
 * the cookie, not the bearer, is the durable credential the REST layer reads.
 *
 * Uses the in-memory adapter (`database: undefined`) like
 * `rate-limit-integration.test.ts` — the cookie-establishment path is Better
 * Auth core + Atlas's `emailVerification` wiring, identical across adapters.
 */

const SECRET = parseAuthSecret("0123456789abcdef0123456789abcdef");

/**
 * Capture the plaintext OTP. Production's `emailOTP` sender dispatches the code
 * by email (`storeOTP: "hashed"`, so the verification row holds only a hash);
 * a test sender lets us read the code the user would type. Mirrors the exact
 * production `emailOTP` options (8-char, `overrideDefaultEmailVerification`,
 * client-owned send) so a drift in those is exercised through this flow.
 */
function makeAuth(): { auth: ReturnType<typeof betterAuth>; getOtp: () => string | null } {
  let capturedOtp: string | null = null;
  const deps: BuildAuthOptionsDeps = {
    env: {
      // Rate limiting off so the multi-call flow never trips a bucket.
      ATLAS_AUTH_RATE_LIMIT_ENABLED: "false",
      // The production posture: verification required → autoSignIn off at signup,
      // session established at verify-email via autoSignInAfterVerification.
      ATLAS_REQUIRE_EMAIL_VERIFICATION: "true",
    } as NodeJS.ProcessEnv,
    secret: SECRET,
    baseURL: "http://localhost:3000",
    database: undefined,
    cookiePrefix: "atlas",
    socialProviders: undefined,
    plugins: [
      bearer(),
      emailOTP({
        otpLength: 8,
        expiresIn: 600,
        sendVerificationOnSignUp: false,
        overrideDefaultEmailVerification: true,
        storeOTP: "hashed",
        sendVerificationOTP: async (data) => {
          capturedOtp = data.otp;
        },
      }),
      // `BuildAuthOptionsDeps["plugins"]` is `any[]` (Better Auth's plugin types
      // are un-unifiable union generics — see `buildPlugins`), so this minimal
      // set is assignable with no cast.
    ],
    trustedOrigins: ["http://localhost:3000"],
    bootstrapAdmin: { mode: "none" },
  };
  const auth = betterAuth(buildAuthOptions(deps));
  return { auth, getOtp: () => capturedOtp };
}

function authPost(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost:3000/api/auth${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-atlas-client-ip": "192.0.2.77",
      origin: "http://localhost:3000",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/** Join the response's Set-Cookie header(s) into one newline-delimited string. */
function joinSetCookie(res: Response): string {
  const cookies =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : [res.headers.get("set-cookie") ?? ""];
  return cookies.join("\n");
}

/** Extract the `atlas.session_token=<value>` cookie pair, or "" if absent. */
function sessionCookiePair(setCookie: string): string {
  const m = setCookie.match(/(atlas\.session_token=[^;]+)/);
  return m ? m[1] : "";
}

/**
 * Drive a full signup → send-OTP → verify-email flow and return the verify
 * response plus the session cookie it issued.
 */
async function signupThroughOtp(
  auth: ReturnType<typeof betterAuth>,
  getOtp: () => string | null,
  email: string,
): Promise<{ verify: Response; setCookie: string; cookiePair: string }> {
  const signup = await auth.handler(
    authPost("/sign-up/email", { name: "Durable", email, password: "correct horse battery staple" }),
  );
  expect(signup.status).toBe(200);
  // requireEmailVerification → no session yet at signup.
  expect(sessionCookiePair(joinSetCookie(signup))).toBe("");

  const send = await auth.handler(
    authPost("/email-otp/send-verification-otp", { email, type: "email-verification" }),
  );
  expect(send.status).toBe(200);
  const otp = getOtp();
  expect(otp).toBeTruthy();

  const verify = await auth.handler(authPost("/email-otp/verify-email", { email, otp }));
  const setCookie = joinSetCookie(verify);
  return { verify, setCookie, cookiePair: sessionCookiePair(setCookie) };
}

describe("post-signup session durability — managed OTP-verify (#4018 / #4086)", () => {
  it("verify-email issues a durable HOST-ONLY session cookie (ADR-0024 §5)", async () => {
    const { auth, getOtp } = makeAuth();
    const { verify, setCookie, cookiePair } = await signupThroughOtp(
      auth,
      getOtp,
      `durable-host-${Date.now()}@example.com`,
    );

    expect(verify.status).toBe(200);
    // The session cookie MUST be present — #4086's reported symptom was
    // `verify-email` returning a bearer with no usable session cookie.
    expect(cookiePair).not.toBe("");
    expect(setCookie).toContain("atlas.session_token");
    // Host-only: no parent-domain attribute, or a regional session token would
    // be sent to every region's API host (ADR-0024 §5). SameSite=Lax so the
    // host-only cookie still rides credentialed same-site cross-origin fetches
    // from app.useatlas.dev. (Secure is verified at deploy — http baseURL here.)
    expect(setCookie).not.toContain("Domain=");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("HttpOnly");
  }, 20_000);

  it("a COOKIE-ONLY request authenticates against the verify-email session (no bearer)", async () => {
    const { auth, getOtp } = makeAuth();
    const { cookiePair } = await signupThroughOtp(
      auth,
      getOtp,
      `durable-cookie-${Date.now()}@example.com`,
    );
    expect(cookiePair).not.toBe("");

    // Replay the cookie with NO Authorization header — exactly how Atlas's
    // `/api/v1` REST layer authenticates after #4018 (cookie-only in managed
    // mode). This is the regression #4086 reports: the cookie-only path 401'd.
    const getSession = await auth.handler(
      new Request("http://localhost:3000/api/auth/get-session", {
        method: "GET",
        headers: {
          "x-atlas-client-ip": "192.0.2.77",
          origin: "http://localhost:3000",
          cookie: cookiePair,
        },
      }),
    );
    expect(getSession.status).toBe(200);
    const body = (await getSession.json()) as { user?: { emailVerified?: boolean } } | null;
    // A 200 with a `null` body is the failure shape #4086 observed
    // (`get-session` → 200, body `null`). The session must be real.
    expect(body?.user).toBeTruthy();
    expect(body?.user?.emailVerified).toBe(true);
  }, 20_000);

  it("verify-email also exposes the bearer, but the cookie is the durable credential", async () => {
    // #4086's evidence was `set-auth-token` present, cookie missing. The
    // bearer plugin derives `set-auth-token` FROM the session Set-Cookie, so
    // the two travel together — assert both, so a future change that drops the
    // cookie while keeping the bearer (the exact reported regression) fails.
    const { auth, getOtp } = makeAuth();
    const { verify, cookiePair } = await signupThroughOtp(
      auth,
      getOtp,
      `durable-bearer-${Date.now()}@example.com`,
    );
    expect(verify.headers.get("set-auth-token")).toBeTruthy();
    expect(cookiePair).not.toBe("");
  }, 20_000);

  it("negative control: with NO cookie and NO bearer, get-session is unauthenticated", async () => {
    // Proves the cookie above is what authenticates — not some always-on
    // default that would make the positive tests vacuous.
    const { auth } = makeAuth();
    const getSession = await auth.handler(
      new Request("http://localhost:3000/api/auth/get-session", {
        method: "GET",
        headers: { "x-atlas-client-ip": "192.0.2.77", origin: "http://localhost:3000" },
      }),
    );
    // Better Auth returns 200 + `null` body for an anonymous get-session.
    const body = (await getSession.json()) as unknown;
    expect(body).toBeNull();
  }, 20_000);
});
