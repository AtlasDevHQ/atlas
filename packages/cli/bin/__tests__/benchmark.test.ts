import { afterEach, describe, expect, test } from "bun:test";
import {
  compareResultSets,
  escapeIdent,
  executeGoldSQL,
  mapDuckDBType,
  normalizeValue,
  sortRows,
  valuesMatch,
} from "../benchmark";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ---------------------------------------------------------------------------
// escapeIdent
// ---------------------------------------------------------------------------

describe("escapeIdent", () => {
  test("wraps simple name in double quotes", () => {
    expect(escapeIdent("users")).toBe('"users"');
  });

  test("doubles internal double quotes", () => {
    expect(escapeIdent('my"table')).toBe('"my""table"');
  });

  test("handles empty string", () => {
    expect(escapeIdent("")).toBe('""');
  });

  test("handles name with spaces", () => {
    expect(escapeIdent("my table")).toBe('"my table"');
  });

  test("handles multiple internal quotes", () => {
    expect(escapeIdent('"a""b"')).toBe('"""a""""b"""');
  });
});

// ---------------------------------------------------------------------------
// normalizeValue
// ---------------------------------------------------------------------------

describe("normalizeValue", () => {
  test('"null" string → null', () => {
    expect(normalizeValue("null")).toBe(null);
  });

  test('"NULL" string → null', () => {
    expect(normalizeValue("NULL")).toBe(null);
  });

  test('"none" string → null', () => {
    expect(normalizeValue("none")).toBe(null);
  });

  test('"None" string → null', () => {
    expect(normalizeValue("None")).toBe(null);
  });

  test("null → null", () => {
    expect(normalizeValue(null)).toBe(null);
  });

  test("undefined → null", () => {
    expect(normalizeValue(undefined)).toBe(null);
  });

  test("empty string → null", () => {
    expect(normalizeValue("")).toBe(null);
  });

  test("whitespace-only string → null", () => {
    expect(normalizeValue("   ")).toBe(null);
  });

  test("whitespace trimming", () => {
    expect(normalizeValue("  hello  ")).toBe("hello");
  });

  test("non-numeric strings remain lowercase", () => {
    expect(normalizeValue("Alice")).toBe("alice");
    expect(normalizeValue("FOO BAR")).toBe("foo bar");
  });

  test("number parsing from string", () => {
    expect(normalizeValue("42")).toBe(42);
    expect(normalizeValue("3.14")).toBe(3.14);
    expect(normalizeValue("-10")).toBe(-10);
  });

  test("actual number passes through", () => {
    expect(normalizeValue(99)).toBe(99);
    expect(normalizeValue(0)).toBe(0);
    expect(normalizeValue(-5.5)).toBe(-5.5);
  });

  test("boolean → 0/1", () => {
    expect(normalizeValue(true)).toBe(1);
    expect(normalizeValue(false)).toBe(0);
  });

  test("bigint → number", () => {
    expect(normalizeValue(100n)).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// valuesMatch
// ---------------------------------------------------------------------------

describe("valuesMatch", () => {
  test("exact boundary — absolute tolerance", () => {
    // 0.001 is exactly at the boundary → should match
    expect(valuesMatch(0, 0.001)).toBe(true);
    // 0.0011 exceeds absolute tolerance
    expect(valuesMatch(0, 0.0011)).toBe(false);
  });

  test("relative tolerance with negative numbers", () => {
    // -1000 vs -1000.5: relative diff = 0.5/1000.5 ≈ 0.0005 < 0.001
    expect(valuesMatch(-1000, -1000.5)).toBe(true);
    // -1000 vs -1002: relative diff = 2/1002 ≈ 0.002 > 0.001
    expect(valuesMatch(-1000, -1002)).toBe(false);
  });

  test("null vs non-null → false", () => {
    expect(valuesMatch(null, 0)).toBe(false);
    expect(valuesMatch(0, null)).toBe(false);
    expect(valuesMatch(null, "hello")).toBe(false);
  });

  test("both null → true", () => {
    expect(valuesMatch(null, null)).toBe(true);
    expect(valuesMatch(null, undefined)).toBe(true);
    expect(valuesMatch("", null)).toBe(true);
  });

  test("zero vs small number interactions", () => {
    expect(valuesMatch(0, 0.0005)).toBe(true);
    expect(valuesMatch(0, 0.002)).toBe(false);
    expect(valuesMatch(0, 0)).toBe(true);
  });

  test("string numbers match actual numbers", () => {
    expect(valuesMatch("42", 42)).toBe(true);
    expect(valuesMatch("3.14", 3.14)).toBe(true);
  });

  test("case-insensitive string match", () => {
    expect(valuesMatch("Alice", "alice")).toBe(true);
    expect(valuesMatch("FOO", "foo")).toBe(true);
  });

  test("different strings → false", () => {
    expect(valuesMatch("alice", "bob")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sortRows
// ---------------------------------------------------------------------------

describe("sortRows", () => {
  test("multi-column tiebreaking", () => {
    const rows = [
      [1, "b"],
      [1, "a"],
      [2, "a"],
    ];
    const sorted = sortRows(rows);
    expect(sorted).toEqual([
      [1, "a"],
      [1, "b"],
      [2, "a"],
    ]);
  });

  test("nulls sort before values", () => {
    const rows = [
      [3],
      [null],
      [1],
    ];
    const sorted = sortRows(rows);
    expect(sorted).toEqual([
      [null],
      [1],
      [3],
    ]);
  });

  test("mixed types in sort", () => {
    const rows = [
      [100],
      ["abc"],
      [null],
      [1],
    ];
    const sorted = sortRows(rows);
    // null first, then numbers (1, 100), then strings
    // After normalization: null, 1 (number), 100 (number), "abc" (string)
    // Numbers sort before strings since number < string comparison
    // uses String() conversion: "1" < "abc", "100" < "abc"
    expect(sorted[0]).toEqual([null]);
    expect(sorted[1]).toEqual([1]);
    expect(sorted[2]).toEqual([100]);
    expect(sorted[3]).toEqual(["abc"]);
  });

  test("empty rows array", () => {
    expect(sortRows([])).toEqual([]);
  });

  test("single row unchanged", () => {
    const rows = [[1, 2, 3]];
    expect(sortRows(rows)).toEqual([[1, 2, 3]]);
  });

  test("does not mutate original array", () => {
    const rows = [[2], [1]];
    const original = [...rows];
    sortRows(rows);
    expect(rows).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// mapDuckDBType
// ---------------------------------------------------------------------------

describe("mapDuckDBType", () => {
  test("INT types → number", () => {
    expect(mapDuckDBType("INTEGER")).toBe("number");
    expect(mapDuckDBType("INT")).toBe("number");
    expect(mapDuckDBType("BIGINT")).toBe("number");
    expect(mapDuckDBType("SMALLINT")).toBe("number");
    expect(mapDuckDBType("TINYINT")).toBe("number");
    expect(mapDuckDBType("UBIGINT")).toBe("number");
  });

  test("FLOAT/DOUBLE/DECIMAL → number", () => {
    expect(mapDuckDBType("FLOAT")).toBe("number");
    expect(mapDuckDBType("DOUBLE")).toBe("number");
    expect(mapDuckDBType("DECIMAL(10,2)")).toBe("number");
    expect(mapDuckDBType("NUMERIC")).toBe("number");
    expect(mapDuckDBType("REAL")).toBe("number");
  });

  test("HUGEINT/UHUGEINT → number", () => {
    expect(mapDuckDBType("HUGEINT")).toBe("number");
    expect(mapDuckDBType("UHUGEINT")).toBe("number");
  });

  test("VARCHAR/TEXT → string", () => {
    expect(mapDuckDBType("VARCHAR")).toBe("string");
    expect(mapDuckDBType("TEXT")).toBe("string");
    expect(mapDuckDBType("VARCHAR(255)")).toBe("string");
  });

  test("BOOLEAN → boolean", () => {
    expect(mapDuckDBType("BOOLEAN")).toBe("boolean");
    expect(mapDuckDBType("BOOL")).toBe("boolean");
  });

  test("TIMESTAMP/DATE → date", () => {
    expect(mapDuckDBType("TIMESTAMP")).toBe("date");
    expect(mapDuckDBType("DATE")).toBe("date");
    expect(mapDuckDBType("TIME")).toBe("date");
    expect(mapDuckDBType("TIMESTAMP WITH TIME ZONE")).toBe("date");
  });

  test("BLOB → string (default)", () => {
    expect(mapDuckDBType("BLOB")).toBe("string");
  });

  test("unknown type → string (default)", () => {
    expect(mapDuckDBType("JSON")).toBe("string");
    expect(mapDuckDBType("UUID")).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// compareResultSets
// ---------------------------------------------------------------------------

describe("compareResultSets", () => {
  test("identical sets match", () => {
    const data = {
      columns: ["a", "b"],
      rows: [
        { a: 1, b: "hello" },
        { a: 2, b: "world" },
      ],
    };
    expect(compareResultSets(data, data)).toBe(true);
  });

  test("different row order matches", () => {
    const gold = {
      columns: ["x"],
      rows: [{ x: 1 }, { x: 2 }, { x: 3 }],
    };
    const pred = {
      columns: ["x"],
      rows: [{ x: 3 }, { x: 1 }, { x: 2 }],
    };
    expect(compareResultSets(gold, pred)).toBe(true);
  });

  test("different row count fails", () => {
    const gold = {
      columns: ["x"],
      rows: [{ x: 1 }, { x: 2 }],
    };
    const pred = {
      columns: ["x"],
      rows: [{ x: 1 }],
    };
    expect(compareResultSets(gold, pred)).toBe(false);
  });

  test("different column count fails", () => {
    const gold = {
      columns: ["a", "b"],
      rows: [{ a: 1, b: 2 }],
    };
    const pred = {
      columns: ["a"],
      rows: [{ a: 1 }],
    };
    expect(compareResultSets(gold, pred)).toBe(false);
  });

  test("numeric tolerance — absolute", () => {
    const gold = {
      columns: ["val"],
      rows: [{ val: 1.0 }],
    };
    const pred = {
      columns: ["val"],
      rows: [{ val: 1.0005 }],
    };
    expect(compareResultSets(gold, pred)).toBe(true);
  });

  test("numeric tolerance — exceeds threshold", () => {
    const gold = {
      columns: ["val"],
      rows: [{ val: 1.0 }],
    };
    const pred = {
      columns: ["val"],
      rows: [{ val: 1.01 }],
    };
    expect(compareResultSets(gold, pred)).toBe(false);
  });

  test("numeric tolerance — relative for large numbers", () => {
    const gold = {
      columns: ["val"],
      rows: [{ val: 10000 }],
    };
    const pred = {
      columns: ["val"],
      rows: [{ val: 10005 }],
    };
    // Relative diff: 5/10005 ≈ 0.0005 < 0.001
    expect(compareResultSets(gold, pred)).toBe(true);
  });

  test("null/undefined/empty equivalence", () => {
    const gold = {
      columns: ["a"],
      rows: [{ a: null }],
    };
    const pred = {
      columns: ["a"],
      rows: [{ a: undefined }],
    };
    expect(compareResultSets(gold, pred)).toBe(true);
  });

  test("empty string treated as null", () => {
    const gold = {
      columns: ["a"],
      rows: [{ a: null }],
    };
    const pred = {
      columns: ["a"],
      rows: [{ a: "" }],
    };
    expect(compareResultSets(gold, pred)).toBe(true);
  });

  test("case-insensitive strings", () => {
    const gold = {
      columns: ["name"],
      rows: [{ name: "Alice" }],
    };
    const pred = {
      columns: ["name"],
      rows: [{ name: "alice" }],
    };
    expect(compareResultSets(gold, pred)).toBe(true);
  });

  test("boolean-to-number coercion", () => {
    const gold = {
      columns: ["flag"],
      rows: [{ flag: true }, { flag: false }],
    };
    const pred = {
      columns: ["flag"],
      rows: [{ flag: 1 }, { flag: 0 }],
    };
    expect(compareResultSets(gold, pred)).toBe(true);
  });

  test("column names ignored — only values matter", () => {
    const gold = {
      columns: ["col_a"],
      rows: [{ col_a: 42 }],
    };
    const pred = {
      columns: ["totally_different_name"],
      rows: [{ totally_different_name: 42 }],
    };
    expect(compareResultSets(gold, pred)).toBe(true);
  });

  test("bigint values compared as numbers", () => {
    const gold = {
      columns: ["count"],
      rows: [{ count: 100n }],
    };
    const pred = {
      columns: ["count"],
      rows: [{ count: 100 }],
    };
    expect(compareResultSets(gold, pred)).toBe(true);
  });

  test("string number matches actual number", () => {
    const gold = {
      columns: ["val"],
      rows: [{ val: "42" }],
    };
    const pred = {
      columns: ["val"],
      rows: [{ val: 42 }],
    };
    expect(compareResultSets(gold, pred)).toBe(true);
  });

  test("empty result sets match", () => {
    const gold = { columns: ["a", "b"], rows: [] as Record<string, unknown>[] };
    const pred = { columns: ["x", "y"], rows: [] as Record<string, unknown>[] };
    expect(compareResultSets(gold, pred)).toBe(true);
  });

  test("multi-row multi-column with mixed types", () => {
    const gold = {
      columns: ["id", "name", "score"],
      rows: [
        { id: 1, name: "Alice", score: 95.5 },
        { id: 2, name: "Bob", score: null },
      ],
    };
    const pred = {
      columns: ["id", "name", "score"],
      rows: [
        { id: 2, name: "bob", score: undefined },
        { id: 1, name: "alice", score: 95.5005 },
      ],
    };
    expect(compareResultSets(gold, pred)).toBe(true);
  });

  test("duplicate rows — different distributions fail", () => {
    const gold = {
      columns: ["x"],
      rows: [{ x: 1 }, { x: 1 }, { x: 2 }],
    };
    const pred = {
      columns: ["x"],
      rows: [{ x: 1 }, { x: 2 }, { x: 2 }],
    };
    expect(compareResultSets(gold, pred)).toBe(false);
  });

  test("duplicate rows — same distributions match", () => {
    const gold = {
      columns: ["x"],
      rows: [{ x: 1 }, { x: 1 }, { x: 2 }],
    };
    const pred = {
      columns: ["x"],
      rows: [{ x: 2 }, { x: 1 }, { x: 1 }],
    };
    expect(compareResultSets(gold, pred)).toBe(true);
  });

  test('string "None" matches null', () => {
    const gold = {
      columns: ["a"],
      rows: [{ a: null }],
    };
    const pred = {
      columns: ["a"],
      rows: [{ a: "None" }],
    };
    expect(compareResultSets(gold, pred)).toBe(true);
  });

  test('string "null" matches null', () => {
    const gold = {
      columns: ["a"],
      rows: [{ a: null }],
    };
    const pred = {
      columns: ["a"],
      rows: [{ a: "null" }],
    };
    expect(compareResultSets(gold, pred)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// executeGoldSQL
// ---------------------------------------------------------------------------

describe("executeGoldSQL", () => {
  let tmpDir: string;
  let dbPath: string;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test("executes query on in-memory SQLite fixture", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bird-test-"));
    dbPath = path.join(tmpDir, "test.sqlite");

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = require("bun:sqlite");
    const db = new Database(dbPath);
    db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)");
    db.run("INSERT INTO users VALUES (1, 'Alice', 30)");
    db.run("INSERT INTO users VALUES (2, 'Bob', 25)");
    db.run("INSERT INTO users VALUES (3, 'Charlie', 35)");
    db.close();

    const result = executeGoldSQL(dbPath, "SELECT name, age FROM users WHERE age > 28 ORDER BY age");
    expect(result.columns).toEqual(["name", "age"]);
    expect(result.rows).toEqual([
      { name: "Alice", age: 30 },
      { name: "Charlie", age: 35 },
    ]);
  });

  test("handles aggregate queries", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bird-test-"));
    dbPath = path.join(tmpDir, "test.sqlite");

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = require("bun:sqlite");
    const db = new Database(dbPath);
    db.run("CREATE TABLE items (id INTEGER, price REAL)");
    db.run("INSERT INTO items VALUES (1, 10.5)");
    db.run("INSERT INTO items VALUES (2, 20.0)");
    db.run("INSERT INTO items VALUES (3, 30.5)");
    db.close();

    const result = executeGoldSQL(dbPath, "SELECT COUNT(*) as cnt, SUM(price) as total FROM items");
    expect(result.columns).toEqual(["cnt", "total"]);
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].cnt).toBe(3);
    expect(result.rows[0].total).toBe(61.0);
  });

  test("empty result set", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bird-test-"));
    dbPath = path.join(tmpDir, "test.sqlite");

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = require("bun:sqlite");
    const db = new Database(dbPath);
    db.run("CREATE TABLE empty_table (id INTEGER, val TEXT)");
    db.close();

    const result = executeGoldSQL(dbPath, "SELECT * FROM empty_table");
    expect(result.rows).toEqual([]);
  });
});
