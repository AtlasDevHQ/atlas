import { describe, it, expect } from "bun:test";
import { deviceAuthorization } from "better-auth/plugins";
import { DEVICE_TOKEN_ENDPOINT_PATH } from "../server";
import { getWebOrigin } from "@atlas/api/lib/web-origin";
import { resolveDeviceVerificationUri } from "../device-verification-uri";

/**
 * Contract-pinning tests for the better-auth deviceAuthorization plugin
 * (#4043 / ADR-0026). The origin=cli key-scoping hinges on the plugin's
 * INTERNAL token-endpoint path matching the const the `session.create.before`
 * hook detects on. These tests turn a future better-auth bump that breaks that
 * assumption (a rename, or the zod-options regression) into a RED test rather
 * than a silent fail-open `platform_admin` escalation.
 */
describe("deviceAuthorization plugin contract (#4043)", () => {
  it("token endpoint path equals DEVICE_TOKEN_ENDPOINT_PATH (the cli-detection signal)", () => {
    const plugin = deviceAuthorization({ verificationUri: "/device", schema: {} });
    expect(plugin.endpoints?.deviceToken?.path).toBe(DEVICE_TOKEN_ENDPOINT_PATH);
  });

  it("requires the `schema: {}` workaround under zod v4 (bare call throws)", () => {
    // better-auth 1.6.20 × zod 4.4.3: the options schema declares
    // `schema: z.custom(() => true)` WITHOUT `.optional()`, so the bare call
    // throws at construction (a RUNTIME zod error — the TS option type marks
    // `schema` optional, so no `@ts-expect-error` is needed). If this STOPS
    // throwing after a bump, the workaround in server.ts buildPlugins() can go.
    expect(() => deviceAuthorization({ verificationUri: "/device" })).toThrow();
  });

  it("schema:{} preserves the deviceCode table + all device endpoints", () => {
    const plugin = deviceAuthorization({ verificationUri: "/device", schema: {} });
    expect(plugin.schema?.deviceCode?.fields).toBeDefined();
    expect(Object.keys(plugin.endpoints ?? {})).toEqual(
      expect.arrayContaining(["deviceCode", "deviceToken", "deviceVerify", "deviceApprove", "deviceDeny"]),
    );
  });
});

/**
 * #4167 — the plugin's `verificationUri` is the URL `atlas login` prints for a
 * human to approve at. server.ts wires it as
 * `resolveDeviceVerificationUri(getWebOrigin())`; the bug was a hardcoded
 * relative "/device" that Better Auth resolved against the API origin (→ 404).
 * This pins the COMPOSITION the wiring depends on: given a web origin, it must
 * produce an absolute URL on that (web) host, never a relative path or the API
 * host. A regression to a literal relative verificationUri would go RED here.
 * Self-contained: env is saved and restored, never mutated at module top level.
 */
describe("device verificationUri wiring (#4167)", () => {
  const ORIGIN_KEYS = [
    "ATLAS_CORS_ORIGIN",
    "BETTER_AUTH_TRUSTED_ORIGINS",
    "ATLAS_API_REGION",
  ] as const;

  function withEnv(overrides: Partial<Record<(typeof ORIGIN_KEYS)[number], string | undefined>>, run: () => void) {
    const saved = Object.fromEntries(ORIGIN_KEYS.map((k) => [k, process.env[k]]));
    try {
      for (const k of ORIGIN_KEYS) {
        const v = overrides[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      run();
    } finally {
      for (const k of ORIGIN_KEYS) {
        const v = saved[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it("composes getWebOrigin() into an ABSOLUTE web-origin /device URL (never the API host)", () => {
    withEnv({ ATLAS_CORS_ORIGIN: "https://app.staging.useatlas.dev", BETTER_AUTH_TRUSTED_ORIGINS: undefined, ATLAS_API_REGION: undefined }, () => {
      const uri = resolveDeviceVerificationUri(getWebOrigin());
      expect(uri).toBe("https://app.staging.useatlas.dev/device");
      // Absolute (parses standalone) so Better Auth won't re-resolve it against
      // the API base — the crux of the 404 fix.
      expect(() => new URL(uri)).not.toThrow();
      expect(uri).not.toContain("api.");
    });
  });

  it("falls back to relative /device only when no web origin resolves (single-origin embedded deploy)", () => {
    withEnv({ ATLAS_CORS_ORIGIN: undefined, BETTER_AUTH_TRUSTED_ORIGINS: undefined, ATLAS_API_REGION: undefined }, () => {
      expect(resolveDeviceVerificationUri(getWebOrigin())).toBe("/device");
    });
  });
});
