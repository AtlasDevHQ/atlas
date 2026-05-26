/**
 * HTTP status → permanent/transient classification.
 */

import { describe, expect, test } from "bun:test";
import { classifyHttpStatus } from "../classify";

describe("classifyHttpStatus", () => {
  test("5xx → transient (upstream outage)", () => {
    expect(classifyHttpStatus(500)).toBe("transient");
    expect(classifyHttpStatus(502)).toBe("transient");
    expect(classifyHttpStatus(503)).toBe("transient");
  });

  test("429 → transient (rate-limited; backoff spreads the retry)", () => {
    expect(classifyHttpStatus(429)).toBe("transient");
  });

  test("0 / negative / NaN → transient (transport flake)", () => {
    expect(classifyHttpStatus(0)).toBe("transient");
    expect(classifyHttpStatus(NaN)).toBe("transient");
  });

  test("4xx other than 429 → permanent (deterministic misconfig)", () => {
    expect(classifyHttpStatus(400)).toBe("permanent");
    expect(classifyHttpStatus(401)).toBe("permanent");
    expect(classifyHttpStatus(403)).toBe("permanent");
    expect(classifyHttpStatus(404)).toBe("permanent");
    expect(classifyHttpStatus(422)).toBe("permanent");
  });

  test("2xx/3xx fall through to permanent so a caller throwing on success surfaces as a code bug", () => {
    expect(classifyHttpStatus(200)).toBe("permanent");
    expect(classifyHttpStatus(302)).toBe("permanent");
  });
});
