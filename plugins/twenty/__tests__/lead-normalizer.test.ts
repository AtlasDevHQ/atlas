/**
 * LeadNormalizer unit tests — pure-function snapshot-style coverage of
 * the demo variant.
 */
import { describe, test, expect } from "bun:test";
import {
  normalizeDemoLead,
  normalizeLead,
  type AtlasDemoLeadEvent,
} from "../src/lead-normalizer";

describe("normalizeDemoLead", () => {
  test("maps a full demo event to a Twenty upsert payload", () => {
    const event: AtlasDemoLeadEvent = {
      source: "demo",
      email: "User@Example.com",
      ip: "203.0.113.42",
      userAgent: "Mozilla/5.0",
    };

    const result = normalizeDemoLead(event);

    expect(result).toEqual({
      person: {
        email: "user@example.com",
        eventSource: "DEMO",
        customFields: { atlasIp: "203.0.113.42" },
      },
      eventSource: "DEMO",
    });
  });

  test("lowercases and trims the email", () => {
    const result = normalizeDemoLead({
      source: "demo",
      email: "  Alice@ACME.COM ",
    });
    expect(result.person.email).toBe("alice@acme.com");
  });

  test("omits atlasIp when ip is null", () => {
    const result = normalizeDemoLead({
      source: "demo",
      email: "u@t.com",
      ip: null,
    });
    expect(result.person.customFields).toEqual({});
  });

  test("omits atlasIp when ip is undefined", () => {
    const result = normalizeDemoLead({
      source: "demo",
      email: "u@t.com",
    });
    expect(result.person.customFields).toEqual({});
  });

  test("omits atlasIp when ip is an empty string", () => {
    const result = normalizeDemoLead({
      source: "demo",
      email: "u@t.com",
      ip: "",
    });
    expect(result.person.customFields).toEqual({});
  });

  test("does NOT round-trip userAgent into Twenty", () => {
    const result = normalizeDemoLead({
      source: "demo",
      email: "u@t.com",
      userAgent: "Mozilla/5.0",
    });
    // userAgent is captured for log correlation at the call site but
    // intentionally not mapped to Twenty. Confirm the contract.
    expect(JSON.stringify(result)).not.toContain("Mozilla");
    expect(JSON.stringify(result)).not.toContain("userAgent");
  });

  test("always stamps eventSource = DEMO for the demo variant", () => {
    const result = normalizeDemoLead({ source: "demo", email: "u@t.com" });
    expect(result.eventSource).toBe("DEMO");
    expect(result.person.eventSource).toBe("DEMO");
  });
});

describe("normalizeLead — dispatch", () => {
  test("dispatches demo source to the demo normalizer", () => {
    const result = normalizeLead({ source: "demo", email: "u@t.com" });
    expect(result.eventSource).toBe("DEMO");
  });
});
