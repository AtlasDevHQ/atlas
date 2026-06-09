import { describe, it, expect } from "bun:test";
import { resolveSidecarAuth } from "../auth";

describe("resolveSidecarAuth", () => {
  it("returns token mode when SIDECAR_AUTH_TOKEN is set", () => {
    const config = resolveSidecarAuth({ SIDECAR_AUTH_TOKEN: "shared-secret" });
    expect(config).toEqual({ mode: "token", token: "shared-secret" });
  });

  it("prefers the token when both token and disable flag are set", () => {
    const config = resolveSidecarAuth({
      SIDECAR_AUTH_TOKEN: "shared-secret",
      SIDECAR_AUTH_DISABLE: "1",
    });
    expect(config).toEqual({ mode: "token", token: "shared-secret" });
  });

  it("returns disabled mode only with the explicit SIDECAR_AUTH_DISABLE=1 opt-out", () => {
    const config = resolveSidecarAuth({ SIDECAR_AUTH_DISABLE: "1" });
    expect(config).toEqual({ mode: "disabled" });
  });

  it("throws (fail closed) when the token is unset and auth was not explicitly disabled", () => {
    expect(() => resolveSidecarAuth({})).toThrow(/SIDECAR_AUTH_TOKEN is not set/);
  });

  it("throws when the token is an empty string", () => {
    expect(() => resolveSidecarAuth({ SIDECAR_AUTH_TOKEN: "" })).toThrow(
      /SIDECAR_AUTH_TOKEN is not set/,
    );
  });

  it("does not accept disable values other than exactly '1'", () => {
    expect(() => resolveSidecarAuth({ SIDECAR_AUTH_DISABLE: "true" })).toThrow(
      /SIDECAR_AUTH_TOKEN is not set/,
    );
    expect(() => resolveSidecarAuth({ SIDECAR_AUTH_DISABLE: "0" })).toThrow(
      /SIDECAR_AUTH_TOKEN is not set/,
    );
  });
});
