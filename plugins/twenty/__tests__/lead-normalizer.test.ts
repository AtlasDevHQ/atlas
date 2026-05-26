/**
 * LeadNormalizer unit tests — pure-function snapshot-style coverage of
 * the demo and sales-form variants.
 */
import { describe, test, expect } from "bun:test";
import {
  normalizeDemoLead,
  normalizeLead,
  normalizeSalesFormLead,
  type AtlasDemoLeadEvent,
  type AtlasSalesFormLeadEvent,
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

describe("normalizeSalesFormLead", () => {
  test("maps a full sales-form event to a Twenty upsert payload + note", () => {
    const event: AtlasSalesFormLeadEvent = {
      source: "sales-form",
      email: "User@Example.com",
      name: "Alice Example",
      company: "Acme Co",
      planInterest: "Business",
      message: "We need ten seats and SSO.",
      ip: "203.0.113.42",
    };

    const result = normalizeSalesFormLead(event);

    expect(result.eventSource).toBe("SALES_FORM");
    expect(result.person.email).toBe("user@example.com");
    expect(result.person.eventSource).toBe("SALES_FORM");
    // First/last names split from the single `name` input.
    expect(result.person.name).toEqual({ firstName: "Alice", lastName: "Example" });
    expect(result.person.customFields).toEqual({ atlasIp: "203.0.113.42" });
    // Note body is the message text verbatim.
    expect(result.note).toBeDefined();
    expect(result.note?.body).toBe("We need ten seats and SSO.");
    // Title carries useful triage context (company + planInterest).
    expect(result.note?.title).toContain("Acme Co");
    expect(result.note?.title).toContain("Business");
  });

  test("lowercases and trims the email", () => {
    const result = normalizeSalesFormLead({
      source: "sales-form",
      email: "  Bob@ACME.COM ",
      name: "Bob",
      company: "Acme",
      planInterest: "Pro",
      message: "Hi",
    });
    expect(result.person.email).toBe("bob@acme.com");
  });

  test("single-word name maps to firstName only (no empty lastName)", () => {
    const result = normalizeSalesFormLead({
      source: "sales-form",
      email: "u@t.com",
      name: "Cher",
      company: "C",
      planInterest: "Starter",
      message: "Hello",
    });
    expect(result.person.name).toEqual({ firstName: "Cher" });
  });

  test("multi-word last name collapses everything after the first whitespace into lastName", () => {
    const result = normalizeSalesFormLead({
      source: "sales-form",
      email: "u@t.com",
      name: "Mary  Anne   Van Der Beek",
      company: "C",
      planInterest: "Starter",
      message: "Hello",
    });
    expect(result.person.name).toEqual({
      firstName: "Mary",
      lastName: "Anne Van Der Beek",
    });
  });

  test("omits atlasIp when ip is null/undefined/empty", () => {
    for (const ip of [null, undefined, ""] as const) {
      const result = normalizeSalesFormLead({
        source: "sales-form",
        email: "u@t.com",
        name: "X",
        company: "Y",
        planInterest: "Pro",
        message: "Hi",
        ip,
      });
      expect(result.person.customFields).toEqual({});
    }
  });

  test("note body preserves whitespace and newlines from the message exactly", () => {
    const message = "Line one.\n\nLine two with  spaces.\n\tIndented.";
    const result = normalizeSalesFormLead({
      source: "sales-form",
      email: "u@t.com",
      name: "X",
      company: "Y",
      planInterest: "Pro",
      message,
    });
    expect(result.note?.body).toBe(message);
  });

  test("always stamps eventSource = SALES_FORM for the sales-form variant", () => {
    const result = normalizeSalesFormLead({
      source: "sales-form",
      email: "u@t.com",
      name: "X",
      company: "Y",
      planInterest: "Pro",
      message: "Hi",
    });
    expect(result.eventSource).toBe("SALES_FORM");
    expect(result.person.eventSource).toBe("SALES_FORM");
  });

  test("does NOT round-trip userAgent into Twenty (parity with demo variant)", () => {
    const result = normalizeSalesFormLead({
      source: "sales-form",
      email: "u@t.com",
      name: "X",
      company: "Y",
      planInterest: "Pro",
      message: "Hi",
      userAgent: "Mozilla/5.0",
    });
    expect(JSON.stringify(result)).not.toContain("Mozilla");
    expect(JSON.stringify(result)).not.toContain("userAgent");
  });
});

describe("normalizeLead — dispatch", () => {
  test("dispatches demo source to the demo normalizer", () => {
    const result = normalizeLead({ source: "demo", email: "u@t.com" });
    expect(result.eventSource).toBe("DEMO");
  });

  test("dispatches sales-form source to the sales-form normalizer", () => {
    const result = normalizeLead({
      source: "sales-form",
      email: "u@t.com",
      name: "X",
      company: "Y",
      planInterest: "Pro",
      message: "Hi",
    });
    expect(result.eventSource).toBe("SALES_FORM");
    expect(result.note?.body).toBe("Hi");
  });
});
