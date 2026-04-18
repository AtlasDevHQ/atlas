import { describe, it, expect } from "bun:test";
import {
  buildProviderConfig,
  hasAnyProviderFieldFilled,
  INITIAL_FIELD_VALUES,
  type ProviderFieldValues,
} from "../build-provider-config";

function values(overrides: Partial<ProviderFieldValues> = {}): ProviderFieldValues {
  return { ...INITIAL_FIELD_VALUES, ...overrides };
}

describe("buildProviderConfig", () => {
  describe("resend", () => {
    it("rejects empty key", () => {
      expect(buildProviderConfig("resend", values())).toEqual({
        ok: false,
        error: "API key is required.",
      });
    });

    it("trims and returns apiKey", () => {
      expect(buildProviderConfig("resend", values({ resendApiKey: "  re_abc  " }))).toEqual({
        ok: true,
        config: { apiKey: "re_abc" },
      });
    });
  });

  describe("sendgrid", () => {
    it("returns apiKey shape", () => {
      expect(buildProviderConfig("sendgrid", values({ sendgridApiKey: "SG.x" }))).toEqual({
        ok: true,
        config: { apiKey: "SG.x" },
      });
    });
  });

  describe("postmark", () => {
    it("returns serverToken shape", () => {
      expect(buildProviderConfig("postmark", values({ postmarkServerToken: "abc-123" }))).toEqual({
        ok: true,
        config: { serverToken: "abc-123" },
      });
    });

    it("trims whitespace", () => {
      expect(buildProviderConfig("postmark", values({ postmarkServerToken: "  abc-123  " }))).toEqual({
        ok: true,
        config: { serverToken: "abc-123" },
      });
    });
  });

  describe("smtp", () => {
    const ok = (overrides: Partial<ProviderFieldValues> = {}) =>
      values({
        smtpHost: "smtp.example.com",
        smtpPort: "587",
        smtpUsername: "user@x.com",
        smtpPassword: "pw",
        smtpTls: true,
        ...overrides,
      });

    it("parses integer port and trims strings", () => {
      const result = buildProviderConfig("smtp", ok({ smtpHost: "  smtp.example.com  " }));
      expect(result).toEqual({
        ok: true,
        config: {
          host: "smtp.example.com",
          port: 587,
          username: "user@x.com",
          password: "pw",
          tls: true,
        },
      });
    });

    it("rejects missing host", () => {
      expect(buildProviderConfig("smtp", ok({ smtpHost: "" }))).toEqual({
        ok: false,
        error: "Host is required.",
      });
    });

    it("rejects non-integer port", () => {
      expect(buildProviderConfig("smtp", ok({ smtpPort: "abc" }))).toEqual({
        ok: false,
        error: "Port must be 1–65535.",
      });
    });

    it("rejects port below range", () => {
      expect(buildProviderConfig("smtp", ok({ smtpPort: "0" }))).toEqual({
        ok: false,
        error: "Port must be 1–65535.",
      });
    });

    it("rejects port above range", () => {
      expect(buildProviderConfig("smtp", ok({ smtpPort: "70000" }))).toEqual({
        ok: false,
        error: "Port must be 1–65535.",
      });
    });

    it("accepts port boundary values", () => {
      expect(buildProviderConfig("smtp", ok({ smtpPort: "1" })).ok).toBe(true);
      expect(buildProviderConfig("smtp", ok({ smtpPort: "65535" })).ok).toBe(true);
    });

    it("rejects empty port (coerces to 0, out of range)", () => {
      expect(buildProviderConfig("smtp", ok({ smtpPort: "" }))).toEqual({
        ok: false,
        error: "Port must be 1–65535.",
      });
    });

    it("rejects negative port", () => {
      expect(buildProviderConfig("smtp", ok({ smtpPort: "-1" }))).toEqual({
        ok: false,
        error: "Port must be 1–65535.",
      });
    });

    it("rejects floating-point port", () => {
      expect(buildProviderConfig("smtp", ok({ smtpPort: "587.5" }))).toEqual({
        ok: false,
        error: "Port must be 1–65535.",
      });
    });

    it("trims username and password", () => {
      const result = buildProviderConfig("smtp", ok({ smtpUsername: "  user  ", smtpPassword: "  pw  " }));
      expect(result).toEqual({
        ok: true,
        config: { host: "smtp.example.com", port: 587, username: "user", password: "pw", tls: true },
      });
    });

    it("rejects missing password", () => {
      expect(buildProviderConfig("smtp", ok({ smtpPassword: "" }))).toEqual({
        ok: false,
        error: "Password is required.",
      });
    });

    it("passes tls flag through", () => {
      const result = buildProviderConfig("smtp", ok({ smtpTls: false }));
      expect(result.ok).toBe(true);
      if (result.ok) expect((result.config as { tls: boolean }).tls).toBe(false);
    });
  });

  describe("ses", () => {
    const ok = (overrides: Partial<ProviderFieldValues> = {}) =>
      values({
        sesRegion: "us-east-1",
        sesAccessKeyId: "AKIAxxx",
        sesSecretAccessKey: "secret",
        ...overrides,
      });

    it("returns ses shape", () => {
      expect(buildProviderConfig("ses", ok())).toEqual({
        ok: true,
        config: { region: "us-east-1", accessKeyId: "AKIAxxx", secretAccessKey: "secret" },
      });
    });

    it("rejects missing region", () => {
      expect(buildProviderConfig("ses", ok({ sesRegion: "" }))).toEqual({
        ok: false,
        error: "Region is required.",
      });
    });

    it("rejects missing accessKeyId", () => {
      expect(buildProviderConfig("ses", ok({ sesAccessKeyId: "" }))).toEqual({
        ok: false,
        error: "Access key ID is required.",
      });
    });

    it("rejects missing secret", () => {
      expect(buildProviderConfig("ses", ok({ sesSecretAccessKey: "" }))).toEqual({
        ok: false,
        error: "Secret access key is required.",
      });
    });

    it("trims all string fields", () => {
      expect(
        buildProviderConfig(
          "ses",
          ok({ sesRegion: "  us-east-1  ", sesAccessKeyId: "  AKIAx  ", sesSecretAccessKey: "  s  " }),
        ),
      ).toEqual({
        ok: true,
        config: { region: "us-east-1", accessKeyId: "AKIAx", secretAccessKey: "s" },
      });
    });
  });
});

describe("hasAnyProviderFieldFilled", () => {
  it("resend — true when apiKey filled", () => {
    expect(hasAnyProviderFieldFilled("resend", values({ resendApiKey: "x" }))).toBe(true);
  });

  it("resend — false on whitespace-only", () => {
    expect(hasAnyProviderFieldFilled("resend", values({ resendApiKey: "   " }))).toBe(false);
  });

  it("smtp — true when any of host/username/password filled", () => {
    expect(hasAnyProviderFieldFilled("smtp", values({ smtpHost: "x" }))).toBe(true);
    expect(hasAnyProviderFieldFilled("smtp", values({ smtpUsername: "x" }))).toBe(true);
    expect(hasAnyProviderFieldFilled("smtp", values({ smtpPassword: "x" }))).toBe(true);
  });

  it("smtp — true when port changed from default (port is credential material)", () => {
    expect(hasAnyProviderFieldFilled("smtp", values({ smtpPort: "2525" }))).toBe(true);
  });

  it("smtp — true when TLS toggled off", () => {
    expect(hasAnyProviderFieldFilled("smtp", values({ smtpTls: false }))).toBe(true);
  });

  it("smtp — false when all fields match defaults", () => {
    expect(hasAnyProviderFieldFilled("smtp", values())).toBe(false);
  });

  it("ses — true when accessKeyId or secret filled", () => {
    expect(hasAnyProviderFieldFilled("ses", values({ sesAccessKeyId: "AKIA" }))).toBe(true);
    expect(hasAnyProviderFieldFilled("ses", values({ sesSecretAccessKey: "s" }))).toBe(true);
  });

  it("ses — true when region changed from default", () => {
    expect(hasAnyProviderFieldFilled("ses", values({ sesRegion: "us-west-2" }))).toBe(true);
  });

  it("ses — false when region matches default", () => {
    expect(hasAnyProviderFieldFilled("ses", values())).toBe(false);
  });
});
