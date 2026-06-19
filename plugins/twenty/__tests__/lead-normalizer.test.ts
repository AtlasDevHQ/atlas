/**
 * LeadNormalizer unit tests — pure-function snapshot-style coverage of
 * the demo and sales-form variants.
 */
import { describe, test, expect } from "bun:test";
import {
  LeadEventSchema,
  normalizeConversionLead,
  normalizeDemoLead,
  normalizeLead,
  normalizeMcpSignupLead,
  normalizeSalesFormLead,
  normalizeSignupLead,
  type ConversionLeadEvent,
  type DemoLeadEvent,
  type McpSignupLeadEvent,
  type SalesFormLeadEvent,
  type SignupLeadEvent,
} from "../src/lead-normalizer";

describe("normalizeDemoLead", () => {
  test("maps a full demo event to a Twenty upsert payload", () => {
    const event: DemoLeadEvent = {
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
    const event: SalesFormLeadEvent = {
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

describe("normalizeSignupLead", () => {
  test("maps a full signup event to a Twenty upsert payload (no note)", () => {
    const event: SignupLeadEvent = {
      source: "signup",
      email: "User@Example.com",
      name: "Alice Example",
    };

    const result = normalizeSignupLead(event);

    expect(result.eventSource).toBe("SIGNUP");
    expect(result.person.email).toBe("user@example.com");
    expect(result.person.eventSource).toBe("SIGNUP");
    expect(result.person.name).toEqual({ firstName: "Alice", lastName: "Example" });
    // Signup events carry no IP/message → no atlasIp, no Note.
    expect(result.person.customFields).toEqual({});
    expect(result.note).toBeUndefined();
  });

  test("lowercases and trims the email", () => {
    const result = normalizeSignupLead({
      source: "signup",
      email: "  Bob@ACME.COM ",
      name: "Bob",
    });
    expect(result.person.email).toBe("bob@acme.com");
  });

  test("single-word name maps to firstName only (no empty lastName)", () => {
    const result = normalizeSignupLead({
      source: "signup",
      email: "u@t.com",
      name: "Cher",
    });
    expect(result.person.name).toEqual({ firstName: "Cher" });
  });

  test("multi-word last name collapses everything after the first whitespace into lastName", () => {
    const result = normalizeSignupLead({
      source: "signup",
      email: "u@t.com",
      name: "Mary  Anne   Van Der Beek",
    });
    expect(result.person.name).toEqual({
      firstName: "Mary",
      lastName: "Anne Van Der Beek",
    });
  });

  test("omits name when missing — Better Auth allows email-only signup", () => {
    const result = normalizeSignupLead({
      source: "signup",
      email: "u@t.com",
    });
    expect(result.person.name).toBeUndefined();
  });

  test("omits name when empty / whitespace-only — never PATCH a stray empty name", () => {
    for (const name of ["", "   ", "\t"]) {
      const result = normalizeSignupLead({
        source: "signup",
        email: "u@t.com",
        name,
      });
      expect(result.person.name).toBeUndefined();
    }
  });

  test("always stamps eventSource = SIGNUP for the signup variant", () => {
    const result = normalizeSignupLead({ source: "signup", email: "u@t.com" });
    expect(result.eventSource).toBe("SIGNUP");
    expect(result.person.eventSource).toBe("SIGNUP");
  });

  test("never attaches a Note (signup carries no message)", () => {
    const result = normalizeSignupLead({
      source: "signup",
      email: "u@t.com",
      name: "Alice Example",
    });
    expect(result.note).toBeUndefined();
  });

  test("does NOT round-trip an ip — signup doesn't capture one", () => {
    // Future-proof: even if a caller is widened to pass ip, it must not
    // appear on the Person — the signup variant is explicitly the
    // "auth-side, no request context" lead.
    const result = normalizeSignupLead({
      source: "signup",
      email: "u@t.com",
      name: "Alice",
    });
    expect(result.person.customFields).toEqual({});
    expect(JSON.stringify(result)).not.toContain("atlasIp");
  });
});

describe("normalizeMcpSignupLead", () => {
  test("maps a full MCP-signup event to a Twenty upsert payload (no note)", () => {
    const event: McpSignupLeadEvent = {
      source: "mcp-signup",
      email: "Founder@Acme.com",
      name: "Founder Acme",
    };

    const result = normalizeMcpSignupLead(event);

    // The distinct lead source is the whole point — MCP signups must be
    // attributable as their own acquisition channel, never folded into SIGNUP.
    expect(result.eventSource).toBe("MCP_SIGNUP");
    expect(result.person.email).toBe("founder@acme.com");
    expect(result.person.eventSource).toBe("MCP_SIGNUP");
    expect(result.person.name).toEqual({ firstName: "Founder", lastName: "Acme" });
    // No request context (IP/UA) and no message → no atlasIp, no Note.
    expect(result.person.customFields).toEqual({});
    expect(result.note).toBeUndefined();
  });

  test("lowercases and trims the email", () => {
    const result = normalizeMcpSignupLead({
      source: "mcp-signup",
      email: "  Bob@ACME.COM ",
      name: "Bob",
    });
    expect(result.person.email).toBe("bob@acme.com");
  });

  test("single-word name maps to firstName only (no empty lastName)", () => {
    const result = normalizeMcpSignupLead({
      source: "mcp-signup",
      email: "u@t.com",
      name: "Cher",
    });
    expect(result.person.name).toEqual({ firstName: "Cher" });
  });

  test("omits name when missing — MCP signup is email-first too", () => {
    const result = normalizeMcpSignupLead({
      source: "mcp-signup",
      email: "u@t.com",
    });
    expect(result.person.name).toBeUndefined();
  });

  test("omits name when empty / whitespace-only — never PATCH a stray empty name", () => {
    for (const name of ["", "   ", "\t"]) {
      const result = normalizeMcpSignupLead({
        source: "mcp-signup",
        email: "u@t.com",
        name,
      });
      expect(result.person.name).toBeUndefined();
    }
  });

  test("always stamps eventSource = MCP_SIGNUP for the mcp-signup variant", () => {
    const result = normalizeMcpSignupLead({ source: "mcp-signup", email: "u@t.com" });
    expect(result.eventSource).toBe("MCP_SIGNUP");
    expect(result.person.eventSource).toBe("MCP_SIGNUP");
  });

  test("never attaches a Note and never round-trips an ip", () => {
    const result = normalizeMcpSignupLead({
      source: "mcp-signup",
      email: "u@t.com",
      name: "Founder",
    });
    expect(result.note).toBeUndefined();
    expect(result.person.customFields).toEqual({});
    expect(JSON.stringify(result)).not.toContain("atlasIp");
  });
});

describe("normalizeConversionLead", () => {
  test("maps a conversion event to a Twenty upsert payload carrying atlasStripeCustomerId", () => {
    const event: ConversionLeadEvent = {
      source: "conversion",
      email: "User@Example.com",
      stripeCustomerId: "cus_NffrFeUfNV2Hib",
    };

    const result = normalizeConversionLead(event);

    expect(result).toEqual({
      person: {
        email: "user@example.com",
        eventSource: "CONVERSION",
        customFields: { atlasStripeCustomerId: "cus_NffrFeUfNV2Hib" },
      },
      eventSource: "CONVERSION",
    });
  });

  test("lowercases and trims the email", () => {
    const result = normalizeConversionLead({
      source: "conversion",
      email: "  Bob@ACME.COM ",
      stripeCustomerId: "cus_abc",
    });
    expect(result.person.email).toBe("bob@acme.com");
  });

  test("always stamps eventSource = CONVERSION", () => {
    const result = normalizeConversionLead({
      source: "conversion",
      email: "u@t.com",
      stripeCustomerId: "cus_xyz",
    });
    expect(result.eventSource).toBe("CONVERSION");
    expect(result.person.eventSource).toBe("CONVERSION");
  });

  test("never attaches a Note (conversion carries no message)", () => {
    const result = normalizeConversionLead({
      source: "conversion",
      email: "u@t.com",
      stripeCustomerId: "cus_abc",
    });
    expect(result.note).toBeUndefined();
  });

  test("does not put atlasIp on the Person (conversion has no request context)", () => {
    const result = normalizeConversionLead({
      source: "conversion",
      email: "u@t.com",
      stripeCustomerId: "cus_abc",
    });
    expect(JSON.stringify(result)).not.toContain("atlasIp");
  });

  test("preserves the stripeCustomerId verbatim — no normalization", () => {
    // Stripe customer IDs are opaque tokens — never lowercase or trim them.
    const result = normalizeConversionLead({
      source: "conversion",
      email: "u@t.com",
      stripeCustomerId: " CUS_Mixed_Case ",
    });
    expect(result.person.customFields?.atlasStripeCustomerId).toBe(
      " CUS_Mixed_Case ",
    );
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

  test("dispatches signup source to the signup normalizer", () => {
    const result = normalizeLead({
      source: "signup",
      email: "u@t.com",
      name: "Alice Example",
    });
    expect(result.eventSource).toBe("SIGNUP");
    expect(result.note).toBeUndefined();
  });

  test("dispatches conversion source to the conversion normalizer", () => {
    const result = normalizeLead({
      source: "conversion",
      email: "u@t.com",
      stripeCustomerId: "cus_abc",
    });
    expect(result.eventSource).toBe("CONVERSION");
    expect(result.person.customFields?.atlasStripeCustomerId).toBe("cus_abc");
  });

  test("dispatches mcp-signup source to the mcp-signup normalizer", () => {
    const result = normalizeLead({
      source: "mcp-signup",
      email: "u@t.com",
      name: "Founder Acme",
    });
    expect(result.eventSource).toBe("MCP_SIGNUP");
    expect(result.note).toBeUndefined();
  });
});

describe("LeadEventSchema — parse at the crm_outbox flush boundary", () => {
  // This schema is the SSOT for the persisted payload shape. `ee/src/saas-crm`
  // runs `LeadEventSchema.parse(row.payload)` at flush instead of an `as`-cast,
  // so these cases assert the trust boundary that replaced the old hand-mirror
  // + `_leadUnionsAreMirrors` witness + grep guard.

  test("accepts every valid variant", () => {
    const valid: unknown[] = [
      { source: "demo", email: "a@b.com" },
      { source: "demo", email: "a@b.com", ip: "203.0.113.7", userAgent: "UA" },
      { source: "demo", email: "a@b.com", ip: null, userAgent: null },
      {
        source: "sales-form",
        email: "a@b.com",
        name: "Ada Lovelace",
        company: "Analytical",
        planInterest: "Pro",
        message: "hi",
      },
      { source: "signup", email: "a@b.com" },
      { source: "signup", email: "a@b.com", name: "Ada" },
      { source: "mcp-signup", email: "a@b.com" },
      { source: "mcp-signup", email: "a@b.com", name: "Ada" },
      { source: "conversion", email: "a@b.com", stripeCustomerId: "cus_123" },
    ];
    for (const payload of valid) {
      expect(() => LeadEventSchema.parse(payload)).not.toThrow();
    }
  });

  test("rejects an unknown source (what the exhaustiveness switch alone caught late)", () => {
    expect(() =>
      LeadEventSchema.parse({ source: "telepathy", email: "a@b.com" }),
    ).toThrow();
  });

  test("rejects a conversion row missing stripeCustomerId (what the as-cast let through)", () => {
    // The pre-refactor `row.payload as SaasCrmLeadInput` cast + discriminant-only
    // switch would have passed this straight into the dispatcher; the parse
    // dead-letters it with a precise field error instead.
    expect(() =>
      LeadEventSchema.parse({ source: "conversion", email: "a@b.com" }),
    ).toThrow();
  });

  test("rejects a sales-form row missing required fields", () => {
    expect(() =>
      LeadEventSchema.parse({ source: "sales-form", email: "a@b.com" }),
    ).toThrow();
  });

  test("rejects a non-object / null payload", () => {
    expect(() => LeadEventSchema.parse(null)).toThrow();
    expect(() => LeadEventSchema.parse("nope")).toThrow();
  });
});
