import { describe, it, expect } from "bun:test";
import { deviceAuthorization } from "better-auth/plugins";
import { DEVICE_TOKEN_ENDPOINT_PATH } from "../server";

/**
 * Contract-pinning tests for the better-auth deviceAuthorization plugin
 * (#4043 / ADR-0025). The origin=cli key-scoping hinges on the plugin's
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
