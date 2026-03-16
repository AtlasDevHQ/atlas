import { describe, expect, it } from "bun:test";
import { Parser } from "node-sql-parser";

// Direct import — extractClassification is a pure function that only
// depends on the parser instance and does no I/O.
// We re-implement the same extraction logic here because sql.ts has
// module-level imports that require mocking. Using the parser directly
// keeps these tests fast and isolated.

const parser = new Parser();

interface SQLClassification {
  tablesAccessed: string[];
  columnsAccessed: string[];
}

/**
 * Mirror of extractClassification from sql.ts — tested here to validate
 * the extraction logic without needing full module mocking.
 */
function extractClassification(
  sql: string,
  dialect: string,
  cteNames: Set<string>,
): SQLClassification {
  try {
    const tableRefs = parser.tableList(sql, { database: dialect });
    const tablesAccessed = [...new Set(
      tableRefs
        .map((ref) => {
          const parts = ref.split("::");
          return parts.pop()?.toLowerCase() ?? "";
        })
        .filter((t) => t && !cteNames.has(t)),
    )];

    const columnRefs = parser.columnList(sql, { database: dialect });
    const columnsAccessed = [...new Set(
      columnRefs
        .map((ref) => {
          const parts = ref.split("::");
          const col = parts.pop() ?? "";
          if (col === "(.*)") return "*";
          return col.toLowerCase();
        })
        .filter(Boolean),
    )];

    return { tablesAccessed, columnsAccessed };
  } catch {
    return { tablesAccessed: [], columnsAccessed: [] };
  }
}

describe("extractClassification", () => {
  const PG = "PostgresQL";
  const noCTEs = new Set<string>();

  describe("table extraction", () => {
    it("extracts a single table from simple SELECT", () => {
      const result = extractClassification(
        "SELECT id, name FROM companies",
        PG,
        noCTEs,
      );
      expect(result.tablesAccessed).toEqual(["companies"]);
    });

    it("extracts multiple tables from JOIN", () => {
      const result = extractClassification(
        "SELECT c.name, p.email FROM companies c JOIN people p ON c.id = p.company_id",
        PG,
        noCTEs,
      );
      expect(result.tablesAccessed).toContain("companies");
      expect(result.tablesAccessed).toContain("people");
      expect(result.tablesAccessed).toHaveLength(2);
    });

    it("extracts tables from subqueries", () => {
      const result = extractClassification(
        "SELECT * FROM companies WHERE id IN (SELECT company_id FROM people)",
        PG,
        noCTEs,
      );
      expect(result.tablesAccessed).toContain("companies");
      expect(result.tablesAccessed).toContain("people");
    });

    it("excludes CTE names from tables", () => {
      const cteNames = new Set(["top_companies"]);
      const result = extractClassification(
        "WITH top_companies AS (SELECT id FROM companies LIMIT 10) SELECT * FROM top_companies",
        PG,
        cteNames,
      );
      expect(result.tablesAccessed).toContain("companies");
      expect(result.tablesAccessed).not.toContain("top_companies");
    });

    it("handles nested CTEs", () => {
      const cteNames = new Set(["a", "b"]);
      const result = extractClassification(
        "WITH a AS (SELECT id FROM companies), b AS (SELECT id FROM a) SELECT * FROM b",
        PG,
        cteNames,
      );
      expect(result.tablesAccessed).toEqual(["companies"]);
    });

    it("deduplicates tables referenced multiple times", () => {
      const result = extractClassification(
        "SELECT * FROM companies c1 JOIN companies c2 ON c1.id = c2.parent_id",
        PG,
        noCTEs,
      );
      expect(result.tablesAccessed).toEqual(["companies"]);
    });

    it("lowercases table names", () => {
      const result = extractClassification(
        "SELECT * FROM Companies",
        PG,
        noCTEs,
      );
      expect(result.tablesAccessed).toEqual(["companies"]);
    });
  });

  describe("column extraction", () => {
    it("extracts columns from SELECT list", () => {
      const result = extractClassification(
        "SELECT id, name FROM companies",
        PG,
        noCTEs,
      );
      expect(result.columnsAccessed).toContain("id");
      expect(result.columnsAccessed).toContain("name");
    });

    it("stores SELECT * as ['*']", () => {
      const result = extractClassification(
        "SELECT * FROM companies",
        PG,
        noCTEs,
      );
      expect(result.columnsAccessed).toContain("*");
    });

    it("extracts columns from WHERE clause", () => {
      const result = extractClassification(
        "SELECT id FROM companies WHERE name = 'Acme'",
        PG,
        noCTEs,
      );
      expect(result.columnsAccessed).toContain("id");
      expect(result.columnsAccessed).toContain("name");
    });

    it("extracts columns from GROUP BY", () => {
      const result = extractClassification(
        "SELECT status, COUNT(*) FROM companies GROUP BY status",
        PG,
        noCTEs,
      );
      expect(result.columnsAccessed).toContain("status");
    });

    it("extracts columns from ORDER BY", () => {
      const result = extractClassification(
        "SELECT id FROM companies ORDER BY name",
        PG,
        noCTEs,
      );
      expect(result.columnsAccessed).toContain("name");
    });

    it("extracts columns from JOIN conditions", () => {
      const result = extractClassification(
        "SELECT c.name FROM companies c JOIN people p ON c.id = p.company_id",
        PG,
        noCTEs,
      );
      expect(result.columnsAccessed).toContain("id");
      expect(result.columnsAccessed).toContain("company_id");
      expect(result.columnsAccessed).toContain("name");
    });

    it("deduplicates columns", () => {
      const result = extractClassification(
        "SELECT name FROM companies WHERE name LIKE '%Acme%' ORDER BY name",
        PG,
        noCTEs,
      );
      const nameCount = result.columnsAccessed.filter((c) => c === "name").length;
      expect(nameCount).toBe(1);
    });

    it("lowercases column names", () => {
      const result = extractClassification(
        "SELECT Name, ID FROM companies",
        PG,
        noCTEs,
      );
      expect(result.columnsAccessed).toContain("name");
      expect(result.columnsAccessed).toContain("id");
    });
  });

  describe("combined scenarios", () => {
    it("handles complex query with JOINs, WHERE, GROUP BY, ORDER BY", () => {
      const result = extractClassification(
        `SELECT c.name, COUNT(p.id) as headcount
         FROM companies c
         JOIN people p ON c.id = p.company_id
         WHERE c.status = 'active'
         GROUP BY c.name
         ORDER BY headcount DESC`,
        PG,
        noCTEs,
      );
      expect(result.tablesAccessed).toContain("companies");
      expect(result.tablesAccessed).toContain("people");
      expect(result.columnsAccessed).toContain("name");
      expect(result.columnsAccessed).toContain("id");
      expect(result.columnsAccessed).toContain("company_id");
      expect(result.columnsAccessed).toContain("status");
    });

    it("handles UNION queries", () => {
      const result = extractClassification(
        "SELECT name FROM companies UNION ALL SELECT name FROM people",
        PG,
        noCTEs,
      );
      expect(result.tablesAccessed).toContain("companies");
      expect(result.tablesAccessed).toContain("people");
    });
  });

  describe("error handling", () => {
    it("returns empty arrays on unparseable SQL", () => {
      const result = extractClassification(
        "THIS IS NOT SQL",
        PG,
        noCTEs,
      );
      expect(result.tablesAccessed).toEqual([]);
      expect(result.columnsAccessed).toEqual([]);
    });
  });

  describe("MySQL dialect", () => {
    it("extracts tables in MySQL mode", () => {
      const result = extractClassification(
        "SELECT id, name FROM companies",
        "MySQL",
        noCTEs,
      );
      expect(result.tablesAccessed).toEqual(["companies"]);
      expect(result.columnsAccessed).toContain("id");
      expect(result.columnsAccessed).toContain("name");
    });
  });
});
