import { describe, expect, test } from "bun:test";
import { summarizeUserAgent } from "../components/settings/sessions-section";

describe("summarizeUserAgent", () => {
  test("returns a generic label when user-agent is missing", () => {
    expect(summarizeUserAgent(null)).toBe("Unknown device");
  });

  test("identifies macOS + Chrome", () => {
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    expect(summarizeUserAgent(ua)).toBe("macOS · Chrome");
  });

  test("identifies macOS + Safari (Chrome substring is in Safari UA too)", () => {
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
    expect(summarizeUserAgent(ua)).toBe("macOS · Safari");
  });

  test("identifies Windows + Edge", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0";
    expect(summarizeUserAgent(ua)).toBe("Windows · Edge");
  });

  test("identifies Linux + Firefox", () => {
    const ua = "Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0";
    expect(summarizeUserAgent(ua)).toBe("Linux · Firefox");
  });

  test("identifies iOS + Safari", () => {
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
    expect(summarizeUserAgent(ua)).toBe("iOS · Safari");
  });

  test("falls back to Unknown · Browser for unrecognized UAs", () => {
    expect(summarizeUserAgent("curl/8.4.0")).toBe("Unknown · Browser");
  });
});
