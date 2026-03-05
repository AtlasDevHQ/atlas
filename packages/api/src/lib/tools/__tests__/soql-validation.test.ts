import { describe, it, expect } from "bun:test";
import { validateSOQL, appendSOQLLimit } from "../soql-validation";

const ALLOWED = new Set(["Account", "Contact", "Opportunity", "Lead"]);

describe("validateSOQL", () => {
  describe("Layer 0: Empty check", () => {
    it("rejects empty string", () => {
      const result = validateSOQL("", ALLOWED);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Empty");
    });

    it("rejects whitespace-only", () => {
      const result = validateSOQL("   \n\t  ", ALLOWED);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Empty");
    });
  });

  describe("Layer 1: Mutation guard", () => {
    for (const keyword of ["INSERT", "UPDATE", "DELETE", "UPSERT", "MERGE", "UNDELETE"]) {
      it(`rejects ${keyword}`, () => {
        const result = validateSOQL(`${keyword} INTO Account`, ALLOWED);
        expect(result.valid).toBe(false);
        expect(result.error).toContain("Forbidden");
      });

      it(`rejects ${keyword.toLowerCase()}`, () => {
        const result = validateSOQL(`${keyword.toLowerCase()} into account`, ALLOWED);
        expect(result.valid).toBe(false);
        expect(result.error).toContain("Forbidden");
      });
    }
  });

  describe("Layer 2: SELECT-only", () => {
    it("accepts SELECT query", () => {
      const result = validateSOQL("SELECT Id FROM Account", ALLOWED);
      expect(result.valid).toBe(true);
    });

    it("rejects non-SELECT query", () => {
      const result = validateSOQL("DESCRIBE Account", ALLOWED);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Only SELECT");
    });

    it("rejects semicolons", () => {
      const result = validateSOQL("SELECT Id FROM Account;", ALLOWED);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Semicolons");
    });

    it("rejects multiple statements", () => {
      const result = validateSOQL("SELECT Id FROM Account; SELECT Id FROM Contact", ALLOWED);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Semicolons");
    });
  });

  describe("Layer 3: Object whitelist", () => {
    it("allows whitelisted objects", () => {
      const result = validateSOQL("SELECT Id, Name FROM Account", ALLOWED);
      expect(result.valid).toBe(true);
    });

    it("rejects non-whitelisted objects", () => {
      const result = validateSOQL("SELECT Id FROM CustomObject__c", ALLOWED);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("not in the allowed list");
    });

    it("checks subquery objects", () => {
      const result = validateSOQL(
        "SELECT Id FROM Account WHERE Id IN (SELECT AccountId FROM CustomObject__c)",
        ALLOWED,
      );
      expect(result.valid).toBe(false);
      expect(result.error).toContain("CustomObject__c");
    });

    it("allows subquery with whitelisted objects", () => {
      const result = validateSOQL(
        "SELECT Id FROM Account WHERE Id IN (SELECT AccountId FROM Contact)",
        ALLOWED,
      );
      expect(result.valid).toBe(true);
    });

    it("is case-insensitive", () => {
      const result = validateSOQL("SELECT Id FROM account", ALLOWED);
      expect(result.valid).toBe(true);
    });

    it("rejects queries with no FROM clause", () => {
      const result = validateSOQL("SELECT 1", ALLOWED);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("No FROM");
    });
  });

  describe("Relationship subquery whitelist bypass (parent-to-child)", () => {
    it("accepts parent-to-child relationship subquery with plural relationship name", () => {
      // "Contacts" is the relationship name (plural), not in the whitelist.
      // Only "Contact" (singular) is whitelisted. This should pass because
      // relationship subqueries in SELECT are not whitelist-checked.
      const result = validateSOQL(
        "SELECT Id, Name, (SELECT LastName FROM Contacts) FROM Account",
        ALLOWED,
      );
      expect(result.valid).toBe(true);
    });

    it("accepts multiple relationship subqueries in SELECT", () => {
      const result = validateSOQL(
        "SELECT Id, (SELECT LastName FROM Contacts), (SELECT Amount FROM Opportunities) FROM Account",
        ALLOWED,
      );
      expect(result.valid).toBe(true);
    });

    it("accepts relationship subquery with unknown relationship name", () => {
      // Custom relationship names like "Cases" won't be in the whitelist
      const result = validateSOQL(
        "SELECT Id, (SELECT Subject FROM Cases) FROM Account",
        ALLOWED,
      );
      expect(result.valid).toBe(true);
    });

    it("still rejects non-whitelisted objects in WHERE semi-join subqueries", () => {
      // Semi-join subqueries in WHERE reference real object names — must be checked
      const result = validateSOQL(
        "SELECT Id FROM Account WHERE Id IN (SELECT AccountId FROM CustomObject__c)",
        ALLOWED,
      );
      expect(result.valid).toBe(false);
      expect(result.error).toContain("CustomObject__c");
    });

    it("allows whitelisted objects in WHERE semi-join subqueries", () => {
      const result = validateSOQL(
        "SELECT Id FROM Account WHERE Id IN (SELECT AccountId FROM Contact)",
        ALLOWED,
      );
      expect(result.valid).toBe(true);
    });

    it("accepts relationship subquery AND valid WHERE subquery together", () => {
      const result = validateSOQL(
        "SELECT Id, (SELECT LastName FROM Contacts) FROM Account WHERE Id IN (SELECT AccountId FROM Opportunity)",
        ALLOWED,
      );
      expect(result.valid).toBe(true);
    });

    it("rejects relationship subquery with invalid WHERE subquery", () => {
      const result = validateSOQL(
        "SELECT Id, (SELECT LastName FROM Contacts) FROM Account WHERE Id IN (SELECT AccountId FROM Forbidden__c)",
        ALLOWED,
      );
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Forbidden__c");
    });

    it("still checks top-level FROM object", () => {
      const result = validateSOQL(
        "SELECT Id, (SELECT LastName FROM Contacts) FROM NotAllowed__c",
        ALLOWED,
      );
      expect(result.valid).toBe(false);
      expect(result.error).toContain("NotAllowed__c");
    });
  });

  describe("String literal false positives in mutation guard", () => {
    it("allows 'delete' inside a string literal", () => {
      const result = validateSOQL(
        "SELECT Id FROM Account WHERE Name = 'delete this'",
        ALLOWED,
      );
      expect(result.valid).toBe(true);
    });

    it("allows 'update' inside a string literal", () => {
      const result = validateSOQL(
        "SELECT Id FROM Account WHERE Description = 'please update record'",
        ALLOWED,
      );
      expect(result.valid).toBe(true);
    });

    it("allows 'insert' inside a string literal", () => {
      const result = validateSOQL(
        "SELECT Id FROM Contact WHERE Name = 'insert coin'",
        ALLOWED,
      );
      expect(result.valid).toBe(true);
    });

    it("allows 'merge' inside a string literal", () => {
      const result = validateSOQL(
        "SELECT Id FROM Lead WHERE Status = 'merge pending'",
        ALLOWED,
      );
      expect(result.valid).toBe(true);
    });

    it("allows 'upsert' inside a string literal", () => {
      const result = validateSOQL(
        "SELECT Id FROM Account WHERE Name = 'upsert test'",
        ALLOWED,
      );
      expect(result.valid).toBe(true);
    });

    it("allows LIKE pattern with forbidden keyword", () => {
      const result = validateSOQL(
        "SELECT Id FROM Account WHERE Name LIKE '%delete%'",
        ALLOWED,
      );
      expect(result.valid).toBe(true);
    });

    it("still rejects actual DELETE statements", () => {
      const result = validateSOQL("DELETE FROM Account", ALLOWED);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Forbidden");
    });

    it("still rejects forbidden keyword outside string literal even with strings present", () => {
      // The keyword DELETE appears outside the string
      const result = validateSOQL(
        "DELETE FROM Account WHERE Name = 'safe string'",
        ALLOWED,
      );
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Forbidden");
    });

    it("handles multiple string literals with forbidden keywords", () => {
      const result = validateSOQL(
        "SELECT Id FROM Account WHERE Name = 'delete' AND Type = 'update this'",
        ALLOWED,
      );
      expect(result.valid).toBe(true);
    });

    it("handles empty string literals", () => {
      const result = validateSOQL(
        "SELECT Id FROM Account WHERE Name = ''",
        ALLOWED,
      );
      expect(result.valid).toBe(true);
    });
  });

  describe("valid queries", () => {
    it("accepts basic query", () => {
      const result = validateSOQL("SELECT Id, Name FROM Account LIMIT 10", ALLOWED);
      expect(result.valid).toBe(true);
    });

    it("accepts query with WHERE clause", () => {
      const result = validateSOQL(
        "SELECT Id, Name FROM Account WHERE Name = 'Test'",
        ALLOWED,
      );
      expect(result.valid).toBe(true);
    });

    it("accepts query with aggregate functions", () => {
      const result = validateSOQL(
        "SELECT COUNT(Id) FROM Opportunity GROUP BY StageName",
        ALLOWED,
      );
      expect(result.valid).toBe(true);
    });
  });
});

describe("appendSOQLLimit", () => {
  it("appends LIMIT when not present", () => {
    const result = appendSOQLLimit("SELECT Id FROM Account", 100);
    expect(result).toBe("SELECT Id FROM Account LIMIT 100");
  });

  it("does not append LIMIT when already present", () => {
    const result = appendSOQLLimit("SELECT Id FROM Account LIMIT 50", 100);
    expect(result).toBe("SELECT Id FROM Account LIMIT 50");
  });

  it("is case-insensitive for existing LIMIT", () => {
    const result = appendSOQLLimit("SELECT Id FROM Account limit 50", 100);
    expect(result).toBe("SELECT Id FROM Account limit 50");
  });

  it("trims whitespace", () => {
    const result = appendSOQLLimit("  SELECT Id FROM Account  ", 100);
    expect(result).toBe("SELECT Id FROM Account LIMIT 100");
  });
});
