/**
 * Staging email-clamp WIRING tests (#2913 + #2985).
 *
 * The pure `clampOutbound` chokepoint (`lib/staging/clamp.ts`) is already
 * unit-tested in `staging/__tests__/clamp.test.ts`. THIS suite covers the
 * other half: that `sendEmail` actually routes every outbound message through
 * the clamp BEFORE the provider send (#2913), and that the region the clamp
 * receives is resolved FAIL-CLOSED so a misconfigured staging box can never
 * silently email a real recipient (#2985).
 *
 * Why a separate file from `delivery.test.ts`: this suite needs a capturing
 * logger mock (to assert the misconfig warn fires with keys only) and tight
 * control of `ATLAS_API_REGION` / `ATLAS_DEPLOY_ENV`. bun's isolated per-file
 * runner keeps those mocks from leaking into the sibling delivery suite.
 *
 * Observability of the clamp is indirect on purpose: `sendEmail` exposes no
 * "what recipient did you send" return value, so we observe the REAL effect —
 * the recipient handed to the provider — by capturing the Resend fetch body.
 * That is the behavior that matters (a real address must never reach Resend
 * from staging), not any internal call shape.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Capturing logger mock — lets the warn-observability test assert the wiring
// layer logged the misconfig (keys only). All levels captured; tests inspect
// `warnCalls`.
// ---------------------------------------------------------------------------

interface LogCall {
  readonly obj: unknown;
  readonly msg: string;
}
// Cleared in place (`.length = 0`) — never reassigned — because the logger
// mock's `record(warnCalls)` closes over THIS array reference at module-load
// time. Reassigning would leave the logger pushing into an orphaned array.
const warnCalls: LogCall[] = [];

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test logger shim
const record = (sink: LogCall[]) => (obj: any, msg?: any) => {
  sink.push({ obj, msg: typeof msg === "string" ? msg : String(obj) });
};

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: record(warnCalls),
    error: () => {},
    debug: () => {},
  }),
}));

const { sendEmail, sendEmailWithTransport, assertStagingMailRegion } = await import("../delivery");
type EmailTransport = Parameters<typeof sendEmailWithTransport>[1];

// ---------------------------------------------------------------------------
// Env snapshot + fetch capture
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  "ATLAS_API_REGION",
  "ATLAS_DEPLOY_ENV",
  "STAGING_MAIL_SINK",
  "RESEND_API_KEY",
  "ATLAS_EMAIL_FROM",
  "ATLAS_SMTP_URL",
] as const;
const saved: Record<string, string | undefined> = {};
const originalFetch = globalThis.fetch;

/** Default sink when STAGING_MAIL_SINK is unset (mirrors clamp.ts). */
const DEFAULT_SINK = "staging-mail@useatlas.dev";

let lastResendTo: unknown;

/**
 * Mock fetch as a successful Resend send, capturing the `to` field the
 * provider received. `to` is what the clamp rewrites; capturing it is how we
 * assert the real address never escaped.
 */
function installResendCapture() {
  lastResendTo = undefined;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : {};
    lastResendTo = body.to;
    return new Response(JSON.stringify({ id: "msg-1" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
}

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];
  // A configured provider so sendEmail reaches the network path (not the
  // no-transport log fallback) and the clamp's effect is observable.
  process.env.RESEND_API_KEY = "re_test_key";
  warnCalls.length = 0;
  installResendCapture();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of ENV_KEYS) {
    if (saved[key] !== undefined) process.env[key] = saved[key];
    else delete process.env[key];
  }
});

const REAL = "real.customer@example.com";

// ---------------------------------------------------------------------------
// #2913 — the clamp is wired into the send path
// ---------------------------------------------------------------------------

describe("sendEmail — staging clamp wiring (#2913)", () => {
  it("rewrites the recipient to the sink before the provider send on ATLAS_API_REGION=staging", async () => {
    process.env.ATLAS_API_REGION = "staging";

    const result = await sendEmail({ to: REAL, subject: "Q3 report", html: "<p>x</p>" });

    expect(result.success).toBe(true);
    expect(result.provider).toBe("resend");
    // Resend's payload sends `to` as an array — the real address must be gone.
    expect(lastResendTo).toEqual([DEFAULT_SINK]);
  });

  it("honors STAGING_MAIL_SINK as the redirect target", async () => {
    process.env.ATLAS_API_REGION = "staging";
    process.env.STAGING_MAIL_SINK = "soak-inbox@staging.useatlas.dev";

    await sendEmail({ to: REAL, subject: "x", html: "<p>x</p>" });

    expect(lastResendTo).toEqual(["soak-inbox@staging.useatlas.dev"]);
  });
});

// ---------------------------------------------------------------------------
// Prod / self-hosted / dev paths are unchanged (#2913 acceptance: identity
// for `us|eu|apac` and for an unset region off the staging env).
// ---------------------------------------------------------------------------

describe("sendEmail — non-staging regions deliver the real recipient unchanged", () => {
  for (const region of ["us", "eu", "apac"] as const) {
    it(`delivers to the real recipient for ATLAS_API_REGION=${region}`, async () => {
      process.env.ATLAS_API_REGION = region;

      await sendEmail({ to: REAL, subject: "x", html: "<p>x</p>" });

      expect(lastResendTo).toEqual([REAL]);
    });
  }

  it("delivers to the real recipient when ATLAS_API_REGION is unset (self-hosted / dev)", async () => {
    // No ATLAS_API_REGION, no ATLAS_DEPLOY_ENV → getApiRegion() is null and
    // the deploy env defaults to production → no clamp.
    await sendEmail({ to: REAL, subject: "x", html: "<p>x</p>" });

    expect(lastResendTo).toEqual([REAL]);
  });
});

// ---------------------------------------------------------------------------
// #2985 — FAIL-CLOSED: a staging-shaped deploy (ATLAS_DEPLOY_ENV=staging) ALWAYS
// clamps, regardless of how ATLAS_API_REGION is (mis)configured. The whole
// point of this issue: a malformed/unknown/fat-fingered region cannot silently
// disable the clamp on the staging deploy and email a real recipient.
// ---------------------------------------------------------------------------

describe("sendEmail — fail-closed staging clamp (#2985)", () => {
  beforeEach(() => {
    process.env.ATLAS_DEPLOY_ENV = "staging";
  });

  // THE load-bearing case: a region narrow alone would PASS `"us"`
  // (isDeployRegion("us") === true) and route through the prod identity path,
  // emailing a real recipient from the staging box. The deploy-env axis closes
  // that gap — staging-env clamps no matter the region.
  it("clamps even when ATLAS_API_REGION is fat-fingered to a valid prod region (us)", async () => {
    process.env.ATLAS_API_REGION = "us";

    await sendEmail({ to: REAL, subject: "x", html: "<p>x</p>" });

    expect(lastResendTo).toEqual([DEFAULT_SINK]);
  });

  it("clamps when ATLAS_API_REGION is unset on a staging-shaped deploy (null must not leak)", async () => {
    // ATLAS_API_REGION deliberately not set.
    await sendEmail({ to: REAL, subject: "x", html: "<p>x</p>" });

    expect(lastResendTo).toEqual([DEFAULT_SINK]);
  });

  // The exact misconfig vectors #2985 names: wrong case, trailing whitespace,
  // a typo. None of these narrow to a DeployRegion, and on a staging box none
  // may leak.
  for (const malformed of ["Staging", "staging ", " staging", "stg", "us-west"]) {
    it(`clamps when ATLAS_API_REGION is the malformed value ${JSON.stringify(malformed)}`, async () => {
      process.env.ATLAS_API_REGION = malformed;

      await sendEmail({ to: REAL, subject: "x", html: "<p>x</p>" });

      expect(lastResendTo).toEqual([DEFAULT_SINK]);
    });
  }
});

// ---------------------------------------------------------------------------
// #2985 — observability: surface the region/env divergence so a soak operator
// can SEE (and fix) the misconfig that a naive region narrow would have leaked
// on. The clamp still fires defensively (the cases above prove no leak); this
// warn converts the otherwise-silent misconfig into a visible signal. KEYS
// ONLY — the recipient/body never appears in the log.
// ---------------------------------------------------------------------------

/** Find the staging-region misconfig warn among captured warn calls. */
function findMisconfigWarn() {
  return warnCalls.find((c) => /ATLAS_API_REGION/.test(c.msg) && /staging/i.test(c.msg));
}

describe("sendEmail — staging region-misconfig warn (#2985)", () => {
  it("warns (keys only) when ATLAS_DEPLOY_ENV=staging but ATLAS_API_REGION diverges", async () => {
    process.env.ATLAS_DEPLOY_ENV = "staging";
    process.env.ATLAS_API_REGION = "us"; // diverges from the expected "staging"

    await sendEmail({ to: REAL, subject: "secret-subject", html: "<p>secret-body</p>" });

    const warn = findMisconfigWarn();
    expect(warn).toBeDefined();
    // No recipient or body content may appear anywhere in the log entry.
    const serialized = JSON.stringify(warn);
    expect(serialized).not.toContain(REAL);
    expect(serialized).not.toContain("secret-subject");
    expect(serialized).not.toContain("secret-body");
    // The diagnostic config keys an operator needs ARE present.
    expect(serialized).toContain("us");
    expect(serialized).toContain("staging");
  });

  it("does NOT warn when staging is correctly configured (region === 'staging')", async () => {
    process.env.ATLAS_DEPLOY_ENV = "staging";
    process.env.ATLAS_API_REGION = "staging";

    await sendEmail({ to: REAL, subject: "x", html: "<p>x</p>" });

    expect(findMisconfigWarn()).toBeUndefined();
  });

  it("does NOT warn off the staging env even when a region looks odd", async () => {
    // Production deploy with a granular region — legitimate, not a staging
    // misconfig, so no warn.
    process.env.ATLAS_DEPLOY_ENV = "production";
    process.env.ATLAS_API_REGION = "us-west";

    await sendEmail({ to: REAL, subject: "x", html: "<p>x</p>" });

    expect(findMisconfigWarn()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// #2985 — boot assert: a staging-shaped deploy MUST stamp ATLAS_API_REGION=staging.
// Wired into the staging boot Layer (effect/layers.ts:StagingSeedLive); a throw
// there dies the boot DAG so a misconfigured staging box never serves real mail.
// ---------------------------------------------------------------------------

describe("assertStagingMailRegion (#2985)", () => {
  it("throws on a staging-shaped deploy whose ATLAS_API_REGION is fat-fingered to a prod region", () => {
    process.env.ATLAS_DEPLOY_ENV = "staging";
    process.env.ATLAS_API_REGION = "us";

    expect(() => assertStagingMailRegion()).toThrow(/ATLAS_API_REGION/);
  });

  it("throws on a staging-shaped deploy whose ATLAS_API_REGION is unset", () => {
    process.env.ATLAS_DEPLOY_ENV = "staging";
    // ATLAS_API_REGION deliberately unset.

    expect(() => assertStagingMailRegion()).toThrow(/staging/i);
  });

  it("throws on a staging-shaped deploy whose ATLAS_API_REGION is malformed (whitespace)", () => {
    process.env.ATLAS_DEPLOY_ENV = "staging";
    process.env.ATLAS_API_REGION = "staging "; // trailing whitespace

    expect(() => assertStagingMailRegion()).toThrow();
  });

  it("does NOT throw when staging is correctly configured", () => {
    process.env.ATLAS_DEPLOY_ENV = "staging";
    process.env.ATLAS_API_REGION = "staging";

    expect(() => assertStagingMailRegion()).not.toThrow();
  });

  it("is a no-op off the staging env (prod / self-hosted / dev), whatever the region", () => {
    // Production with a real region — fine.
    process.env.ATLAS_DEPLOY_ENV = "production";
    process.env.ATLAS_API_REGION = "us";
    expect(() => assertStagingMailRegion()).not.toThrow();

    // Unset deploy env (defaults to production) with no region — fine.
    delete process.env.ATLAS_DEPLOY_ENV;
    delete process.env.ATLAS_API_REGION;
    expect(() => assertStagingMailRegion()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The clamp is applied ONCE before the provider branch, so it must cover every
// provider — not just Resend. These lock that invariant against a future
// refactor that adds a provider path consuming the raw (unclamped) message.
// ---------------------------------------------------------------------------

describe("sendEmail — clamp covers the webhook provider path too", () => {
  // Route through deliverWebhook instead of deliverResend: set ATLAS_SMTP_URL
  // and clear RESEND_API_KEY (otherwise the platform-config path resolves a
  // Resend transport and short-circuits before the webhook branch). Env is set
  // inside the test body (not a describe beforeEach) so it survives the
  // file-level beforeEach that clears every ENV_KEY regardless of hook ordering.
  // The fetch capture records `body.to`, which the webhook sends as a bare string.
  const WEBHOOK_URL = "https://smtp-bridge.example.com/send";

  it("rewrites the recipient to the sink on staging (webhook path)", async () => {
    delete process.env.RESEND_API_KEY;
    process.env.ATLAS_SMTP_URL = WEBHOOK_URL;
    process.env.ATLAS_API_REGION = "staging";

    const result = await sendEmail({ to: REAL, subject: "x", html: "<p>x</p>" });

    expect(result.provider).toBe("webhook");
    expect(lastResendTo).toBe(DEFAULT_SINK); // webhook `to` is a bare string
  });

  it("delivers the real recipient off staging (webhook path, region=us)", async () => {
    delete process.env.RESEND_API_KEY;
    process.env.ATLAS_SMTP_URL = WEBHOOK_URL;
    process.env.ATLAS_API_REGION = "us";

    await sendEmail({ to: REAL, subject: "x", html: "<p>x</p>" });

    expect(lastResendTo).toBe(REAL);
  });
});

// ---------------------------------------------------------------------------
// sendEmailWithTransport is the SECOND outbound entry point (admin "test
// email" with fresh credentials). It must clamp too, or a staging admin
// testing creds would email a real recipient (#2913/#2985).
// ---------------------------------------------------------------------------

describe("sendEmailWithTransport — clamps the admin test-email path", () => {
  const resendTransport: EmailTransport = {
    provider: "resend",
    senderAddress: "Atlas <noreply@useatlas.dev>",
    config: { provider: "resend", apiKey: "re_transport_key" },
  };

  it("rewrites the admin-supplied recipient to the sink on staging", async () => {
    process.env.ATLAS_API_REGION = "staging";

    const result = await sendEmailWithTransport(
      { to: REAL, subject: "x", html: "<p>x</p>" },
      resendTransport,
    );

    expect(result.success).toBe(true);
    expect(lastResendTo).toEqual([DEFAULT_SINK]);
  });

  it("delivers to the admin-supplied recipient off staging (region=us)", async () => {
    process.env.ATLAS_API_REGION = "us";

    await sendEmailWithTransport(
      { to: REAL, subject: "x", html: "<p>x</p>" },
      resendTransport,
    );

    expect(lastResendTo).toEqual([REAL]);
  });
});
