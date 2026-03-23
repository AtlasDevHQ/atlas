import { describe, it, expect } from "bun:test";
import { detectPII, detectPIIBatch } from "./pii-detection";

// ── Regex detection (high confidence) ───────────────────────────

describe("detectPII — regex match on sample values", () => {
  it("detects email addresses", () => {
    const result = detectPII({
      name: "contact",
      type: "string",
      sampleValues: ["alice@example.com", "bob@corp.io", "carol@test.org"],
    });
    expect(result).not.toBeNull();
    expect(result!.category).toBe("email");
    expect(result!.confidence).toBe("high");
    expect(result!.method).toBe("regex");
  });

  it("detects SSNs", () => {
    const result = detectPII({
      name: "tax_identifier",
      type: "string",
      sampleValues: ["123-45-6789", "987-65-4321", "555-12-3456"],
    });
    expect(result).not.toBeNull();
    expect(result!.category).toBe("ssn");
    expect(result!.confidence).toBe("high");
  });

  it("detects credit card numbers", () => {
    const result = detectPII({
      name: "payment_info",
      type: "string",
      sampleValues: ["4111-1111-1111-1111", "5500 0000 0000 0004"],
    });
    expect(result).not.toBeNull();
    expect(result!.category).toBe("credit_card");
    expect(result!.confidence).toBe("high");
  });

  it("detects phone numbers", () => {
    const result = detectPII({
      name: "contact_number",
      type: "string",
      sampleValues: ["555-123-4567", "(555) 987-6543", "555.111.2222"],
    });
    expect(result).not.toBeNull();
    expect(result!.category).toBe("phone");
    expect(result!.confidence).toBe("high");
  });

  it("detects IPv4 addresses", () => {
    const result = detectPII({
      name: "origin",
      type: "string",
      sampleValues: ["192.168.1.1", "10.0.0.1", "172.16.0.5"],
    });
    expect(result).not.toBeNull();
    expect(result!.category).toBe("ip_address");
    expect(result!.confidence).toBe("high");
  });

  it("detects dates of birth", () => {
    const result = detectPII({
      name: "important_date",
      type: "string",
      sampleValues: ["1990-01-15", "1985-12-25", "2000-06-30"],
    });
    expect(result).not.toBeNull();
    expect(result!.category).toBe("date_of_birth");
    expect(result!.confidence).toBe("high");
  });

  it("does not detect when match ratio is below threshold", () => {
    const result = detectPII({
      name: "mixed_data",
      type: "string",
      sampleValues: ["alice@example.com", "not-an-email", "also-not", "nope", "still-no"],
    });
    // 1/5 = 0.2, below the 0.5 threshold for email
    expect(result).toBeNull();
  });

  it("handles empty sample values", () => {
    const result = detectPII({
      name: "mystery",
      type: "string",
      sampleValues: [],
    });
    // Falls through to name/type detection
    expect(result).toBeNull();
  });

  it("handles null and empty string values", () => {
    const result = detectPII({
      name: "misc",
      type: "string",
      sampleValues: [null, "", undefined, "alice@example.com", "bob@test.io"],
    });
    // 2/2 valid strings match email (nulls/empty filtered out)
    expect(result).not.toBeNull();
    expect(result!.category).toBe("email");
  });
});

// ── Column name heuristic (medium confidence) ───────────────────

describe("detectPII — column name heuristic", () => {
  it("detects email column name", () => {
    const result = detectPII({ name: "email", type: "string", sampleValues: [] });
    expect(result).not.toBeNull();
    expect(result!.category).toBe("email");
    expect(result!.confidence).toBe("medium");
    expect(result!.method).toBe("column_name");
  });

  it("detects email_address column name", () => {
    const result = detectPII({ name: "email_address", type: "string", sampleValues: [] });
    expect(result).not.toBeNull();
    expect(result!.category).toBe("email");
  });

  it("detects phone number columns", () => {
    for (const name of ["phone", "phone_number", "telephone", "mobile", "cell", "fax"]) {
      const result = detectPII({ name, type: "string", sampleValues: [] });
      expect(result).not.toBeNull();
      expect(result!.category).toBe("phone");
    }
  });

  it("detects SSN column names", () => {
    for (const name of ["ssn", "social_security", "national_id", "tax_id"]) {
      const result = detectPII({ name, type: "string", sampleValues: [] });
      expect(result).not.toBeNull();
      expect(result!.category).toBe("ssn");
    }
  });

  it("detects name columns", () => {
    for (const name of ["first_name", "last_name", "full_name", "surname", "display_name"]) {
      const result = detectPII({ name, type: "string", sampleValues: [] });
      expect(result).not.toBeNull();
      expect(result!.category).toBe("name");
    }
  });

  it("detects IP address columns", () => {
    for (const name of ["ip_address", "client_ip", "remote_ip", "source_ip"]) {
      const result = detectPII({ name, type: "string", sampleValues: [] });
      expect(result).not.toBeNull();
      expect(result!.category).toBe("ip_address");
    }
  });

  it("detects date of birth columns", () => {
    for (const name of ["dob", "date_of_birth", "birth_date", "birthday"]) {
      const result = detectPII({ name, type: "string", sampleValues: [] });
      expect(result).not.toBeNull();
      expect(result!.category).toBe("date_of_birth");
    }
  });

  it("detects address columns", () => {
    for (const name of ["street_address", "postal_code", "zip_code", "zip"]) {
      const result = detectPII({ name, type: "string", sampleValues: [] });
      expect(result).not.toBeNull();
      expect(result!.category).toBe("address");
    }
  });

  it("does not match generic columns", () => {
    for (const name of ["id", "created_at", "status", "count", "total"]) {
      const result = detectPII({ name, type: "string", sampleValues: [] });
      expect(result).toBeNull();
    }
  });
});

// ── Type-based heuristic (low confidence) ───────────────────────

describe("detectPII — type heuristic", () => {
  it("detects inet type as IP address", () => {
    const result = detectPII({ name: "addr", type: "inet", sampleValues: [] });
    expect(result).not.toBeNull();
    expect(result!.category).toBe("ip_address");
    expect(result!.confidence).toBe("low");
    expect(result!.method).toBe("type_heuristic");
  });

  it("detects cidr type as IP address", () => {
    const result = detectPII({ name: "network", type: "cidr", sampleValues: [] });
    expect(result).not.toBeNull();
    expect(result!.category).toBe("ip_address");
  });

  it("does not flag generic date columns", () => {
    const result = detectPII({ name: "created_at", type: "date", sampleValues: [] });
    expect(result).toBeNull();
  });
});

// ── Priority: regex > name > type ───────────────────────────────

describe("detectPII — detection priority", () => {
  it("prefers regex over column name heuristic", () => {
    const result = detectPII({
      name: "phone",
      type: "string",
      sampleValues: ["alice@example.com", "bob@test.io"],
    });
    // Column name says phone, but sample values say email — regex wins
    expect(result).not.toBeNull();
    expect(result!.category).toBe("email");
    expect(result!.confidence).toBe("high");
  });

  it("falls back to name when no sample values match", () => {
    const result = detectPII({
      name: "email",
      type: "string",
      sampleValues: ["not-an-email"],
    });
    expect(result).not.toBeNull();
    expect(result!.category).toBe("email");
    expect(result!.confidence).toBe("medium");
  });
});

// ── Batch detection ─────────────────────────────────────────────

describe("detectPIIBatch", () => {
  it("returns map of detections for multiple columns", () => {
    const results = detectPIIBatch([
      { name: "email", type: "string", sampleValues: ["alice@test.com"] },
      { name: "id", type: "integer", sampleValues: [1, 2, 3] },
      { name: "ssn", type: "string", sampleValues: [] },
    ]);
    expect(results.size).toBe(2);
    expect(results.has("email")).toBe(true);
    expect(results.has("ssn")).toBe(true);
    expect(results.has("id")).toBe(false);
  });

  it("returns empty map when no PII detected", () => {
    const results = detectPIIBatch([
      { name: "id", type: "integer", sampleValues: [1] },
      { name: "status", type: "string", sampleValues: ["active"] },
    ]);
    expect(results.size).toBe(0);
  });
});
