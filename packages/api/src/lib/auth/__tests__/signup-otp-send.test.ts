import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins/email-otp";
import { buildAuthOptions, parseAuthSecret, type BuildAuthOptionsDeps } from "../server";

/**
 * Real-better-auth regression for #4010 — the existing-email OTP dead-end.
 *
 * The mock-based page test (`signup/account/page.test.tsx`) asserts the CLIENT
 * now dispatches the OTP explicitly. This file owns the SERVER half: that
 * better-auth's actual `requireEmailVerification: true` signup path behaves the
 * way the fix assumes, exercised against a live instance with the built-in
 * in-memory adapter (no DB) — the same wiring `getAuthInstance()` uses, plus the
 * real `emailOTP` plugin (with a capturing `sendVerificationOTP` in place of the
 * Resend dispatcher so we can observe sends).
 *
 * The three invariants the fix rests on:
 *
 *   1. A FRESH signup does NOT auto-send the OTP from the signup endpoint —
 *      `emailVerification.sendOnSignUp: false` makes the client the single
 *      source, so there's no double-send. (Before the fix this fired here.)
 *   2. A SECOND signup with the SAME email returns the synthetic
 *      `{ token: null }` success (enumeration protection) and likewise does not
 *      send — byte-identical to the fresh case at the endpoint, which is exactly
 *      why the client can't tell them apart and must own the send.
 *   3. The client-driven `/email-otp/send-verification-otp` (what the page now
 *      calls post-`signUp.email`) DOES dispatch a real OTP for the existing
 *      user — proving the duplicate path reaches a truthful code screen rather
 *      than dead-ending. This is the call the mock test can only assert was
 *      issued; here we prove better-auth honors it.
 *
 * A pre-fix `sendOnSignUp: <default true>` would make invariant 1 red (the fresh
 * signup would send once from the endpoint AND once from the client → two OTPs).
 */

const AUTH_ENV_VARS = ["ATLAS_REQUIRE_EMAIL_VERIFICATION"] as const;
const ORIGINAL_ENV: Record<string, string | undefined> = {};
for (const key of AUTH_ENV_VARS) ORIGINAL_ENV[key] = process.env[key];

beforeEach(() => {
  for (const key of AUTH_ENV_VARS) delete process.env[key];
});

afterEach(() => {
  for (const key of AUTH_ENV_VARS) {
    if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL_ENV[key];
  }
});

// 32 chars — satisfies the BETTER_AUTH_SECRET length floor.
const SECRET = parseAuthSecret("0123456789abcdef0123456789abcdef");

/** Records every OTP the plugin asks Atlas to dispatch (plaintext code included
 *  so a test can drive a real verify round-trip). */
type SentOTP = { email: string; type: string; otp: string };

/**
 * Build a live better-auth instance wired through `buildAuthOptions` (the exact
 * call path `getAuthInstance()` uses), with the real `emailOTP` plugin mirroring
 * Atlas's server config — but its `sendVerificationOTP` captured into `sent`
 * instead of hitting Resend, so we can assert exactly when (and how often) a
 * send fires.
 *
 * `database: undefined` → better-auth falls back to its in-memory adapter, which
 * starts empty per test-file subprocess under Atlas's isolated runner.
 */
function makeAuth(sent: SentOTP[]): ReturnType<typeof betterAuth> {
  const deps: BuildAuthOptionsDeps = {
    env: { ATLAS_REQUIRE_EMAIL_VERIFICATION: "true" } as NodeJS.ProcessEnv,
    secret: SECRET,
    baseURL: "http://localhost:3000",
    database: undefined,
    cookiePrefix: "atlas",
    socialProviders: undefined,
    // Mirror the production emailOTP config (server.ts buildPlugins) — same
    // override + signup flags — with the dispatcher swapped for a recorder.
    plugins: [
      emailOTP({
        otpLength: 8,
        expiresIn: 600,
        sendVerificationOnSignUp: false,
        overrideDefaultEmailVerification: true,
        storeOTP: "hashed",
        sendVerificationOTP: async (data) => {
          sent.push({ email: data.email, type: data.type, otp: data.otp });
        },
      }),
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- Better Auth plugin union types vary by combination
    ] as any,
    trustedOrigins: ["http://localhost:3000"],
    bootstrapAdmin: { mode: "none" },
  };
  const options = buildAuthOptions(deps);
  return betterAuth(options as Parameters<typeof betterAuth>[0]);
}

// Each test passes its OWN `ip` so the auth rate-limit buckets (keyed on
// x-atlas-client-ip; the OTP send endpoint inherits the global default
// 100/60s, while /sign-up/email caps at 5/60s) never collide across tests
// sharing this subprocess — mirroring rate-limit-integration.test.ts's
// per-scenario IP isolation. A shared IP would let a sibling test's calls
// exhaust the /sign-up bucket and turn a real dispatch into a silent 429.
function authPost(path: string, body: unknown, ip: string): Request {
  return new Request(`http://localhost:3000/api/auth${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-atlas-client-ip": ip, // TEST-NET-1 (192.0.2.0/24) — never a real client
      "origin": "http://localhost:3000",
    },
    body: JSON.stringify(body),
  });
}

function signupRequest(email: string, ip: string): Request {
  return authPost("/sign-up/email", { email, password: "hunter2hunter2", name: "Jane" }, ip);
}

function sendOtpRequest(email: string, ip: string): Request {
  return authPost("/email-otp/send-verification-otp", { email, type: "email-verification" }, ip);
}

function verifyOtpRequest(email: string, otp: string, ip: string): Request {
  return authPost("/email-otp/verify-email", { email, otp }, ip);
}

describe("signup OTP send wiring — real better-auth (#4010)", () => {
  it("a FRESH signup returns token:null and does NOT auto-send from the signup endpoint (no double-send)", async () => {
    const sent: SentOTP[] = [];
    const auth = makeAuth(sent);
    const email = `fresh-${Date.now()}@example.com`;
    const ip = "192.0.2.11";

    const res = await auth.handler(signupRequest(email, ip));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string | null };
    // requireEmailVerification=true ⟹ no session token on signup.
    expect(body.token).toBeNull();
    // The single-source-of-send invariant: the signup endpoint must NOT fire
    // the OTP. Before the fix (`sendOnSignUp` defaulting to true) this was 1,
    // which — combined with the now-explicit client send — double-mailed.
    expect(sent).toHaveLength(0);
  });

  it("a SECOND signup with the same email returns the synthetic token:null and still does not send", async () => {
    const sent: SentOTP[] = [];
    const auth = makeAuth(sent);
    const email = `dup-${Date.now()}@example.com`;
    const ip = "192.0.2.12";

    const first = await auth.handler(signupRequest(email, ip));
    expect(first.status).toBe(200);

    const second = await auth.handler(signupRequest(email, ip));
    // Enumeration protection: the existing-email branch returns a synthetic
    // success indistinguishable from the fresh one — same 200, same token:null.
    expect(second.status).toBe(200);
    const body = (await second.json()) as { token: string | null };
    expect(body.token).toBeNull();
    // Neither signup attempt sent — the endpoint is silent on both branches,
    // which is precisely why the client (which can't tell them apart) owns it.
    expect(sent).toHaveLength(0);
  });

  it("the client-driven resend endpoint DOES dispatch a real OTP for an already-registered email (the dead-end fix)", async () => {
    const sent: SentOTP[] = [];
    const auth = makeAuth(sent);
    const email = `existing-${Date.now()}@example.com`;
    const ip = "192.0.2.13";

    // Register the email (first signup creates the real user row).
    await auth.handler(signupRequest(email, ip));
    // A second signup is the prod scenario; both signups are silent.
    await auth.handler(signupRequest(email, ip));
    expect(sent).toHaveLength(0);

    // This is exactly what the fixed page does after `signUp.email` resolves
    // with token:null — call the enumeration-safe resend endpoint. The user
    // row exists, so better-auth dispatches a real OTP: no dead-end.
    const res = await auth.handler(sendOtpRequest(email, ip));
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].email).toBe(email);
    expect(sent[0].type).toBe("email-verification");
  });

  it("dispatches a real OTP for an already-VERIFIED existing email too (AC1 verified sub-case)", async () => {
    // AC1 covers an already-registered email that is EITHER unverified OR
    // verified. A verified user whose email is re-entered at signup still hits
    // the synthetic `token: null` path and the page still drives the resend —
    // so the resend must keep dispatching even after the user is verified, or
    // the verified-existing-email signup would dead-end exactly like the bug.
    const sent: SentOTP[] = [];
    const auth = makeAuth(sent);
    const email = `verified-${Date.now()}@example.com`;
    const ip = "192.0.2.14";

    // Register, then fully verify the user via a real OTP round-trip.
    await auth.handler(signupRequest(email, ip));
    const sendRes = await auth.handler(sendOtpRequest(email, ip));
    expect(sendRes.status).toBe(200);
    expect(sent).toHaveLength(1);
    const verifyRes = await auth.handler(verifyOtpRequest(email, sent[0].otp, ip));
    expect(verifyRes.status).toBe(200); // email is now verified

    // Re-entering the (now verified) email at signup returns the synthetic
    // success again, and the client-driven resend must STILL dispatch a code.
    const dupSignup = await auth.handler(signupRequest(email, ip));
    expect(dupSignup.status).toBe(200);
    const resend = await auth.handler(sendOtpRequest(email, ip));
    expect(resend.status).toBe(200);
    // A second OTP was dispatched for the verified user — no dead-end.
    expect(sent).toHaveLength(2);
    expect(sent[1].email).toBe(email);
    expect(sent[1].type).toBe("email-verification");
  });
});
