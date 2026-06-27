import { describe, it, expect } from "bun:test";
import { deviceErrorMessage } from "./device-error";

describe("deviceErrorMessage (#4043 / ADR-0025)", () => {
  it("prefers error_description (the RFC 8628 human-facing field)", () => {
    expect(
      deviceErrorMessage({ error: "access_denied", error_description: "You denied the request." }),
    ).toBe("You denied the request.");
  });

  it("falls back to message when error_description is absent", () => {
    expect(deviceErrorMessage({ message: "Network failed" })).toBe("Network failed");
  });

  it("falls back to the raw error code when neither description nor message exists", () => {
    expect(deviceErrorMessage({ error: "expired_token" })).toBe("expired_token");
  });

  it("returns an actionable default for unknown / nullish shapes", () => {
    const fallback = "That code is invalid or has expired. Check your terminal and try again.";
    expect(deviceErrorMessage(null)).toBe(fallback);
    expect(deviceErrorMessage(undefined)).toBe(fallback);
    expect(deviceErrorMessage({})).toBe(fallback);
    expect(deviceErrorMessage("a string")).toBe(fallback);
    expect(deviceErrorMessage({ error_description: "" })).toBe(fallback);
  });
});
