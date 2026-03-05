import { describe, expect, test, mock } from "bun:test";
import {
  formatCellValue,
  formatCsvValue,
  quoteCsvField,
  renderTable,
  handleActionApproval,
} from "../atlas";

// ---------------------------------------------------------------------------
// formatCellValue
// ---------------------------------------------------------------------------

describe("formatCellValue", () => {
  test("null returns (null)", () => {
    expect(formatCellValue(null)).toBe("(null)");
  });

  test("undefined returns (null)", () => {
    expect(formatCellValue(undefined)).toBe("(null)");
  });

  test("number is locale-formatted", () => {
    const result = formatCellValue(1234);
    // toLocaleString is environment-dependent, but for 1234 we expect a separator
    expect(result).toBe((1234).toLocaleString());
  });

  test("string passes through", () => {
    expect(formatCellValue("hello")).toBe("hello");
  });

  test("boolean true returns 'true'", () => {
    expect(formatCellValue(true)).toBe("true");
  });

  test("boolean false returns 'false'", () => {
    expect(formatCellValue(false)).toBe("false");
  });

  test("zero returns '0'", () => {
    expect(formatCellValue(0)).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// formatCsvValue
// ---------------------------------------------------------------------------

describe("formatCsvValue", () => {
  test("null returns empty string", () => {
    expect(formatCsvValue(null)).toBe("");
  });

  test("undefined returns empty string", () => {
    expect(formatCsvValue(undefined)).toBe("");
  });

  test("number returns raw string (no locale formatting)", () => {
    expect(formatCsvValue(1234)).toBe("1234");
  });

  test("string passes through", () => {
    expect(formatCsvValue("hello")).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// quoteCsvField
// ---------------------------------------------------------------------------

describe("quoteCsvField", () => {
  test("plain value passes through unquoted", () => {
    expect(quoteCsvField("hello")).toBe("hello");
  });

  test("value with comma gets quoted", () => {
    expect(quoteCsvField("a,b")).toBe('"a,b"');
  });

  test("value with double-quote gets double-quoted", () => {
    expect(quoteCsvField('say "hi"')).toBe('"say ""hi"""');
  });

  test("value with newline gets quoted", () => {
    expect(quoteCsvField("line1\nline2")).toBe('"line1\nline2"');
  });

  test("value with comma and quote gets both treatments", () => {
    expect(quoteCsvField('a,"b"')).toBe('"a,""b"""');
  });

  test("empty string passes through", () => {
    expect(quoteCsvField("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// renderTable
// ---------------------------------------------------------------------------

describe("renderTable", () => {
  test("basic table with 2 columns and 2 rows", () => {
    const columns = ["name", "age"];
    const rows = [
      { name: "Alice", age: 30 },
      { name: "Bob", age: 25 },
    ];
    const output = renderTable(columns, rows);
    const lines = output.split("\n");

    // Top border, header, separator, 2 data rows, bottom border = 6 lines
    expect(lines).toHaveLength(6);

    // Top border
    expect(lines[0]).toMatch(/^┌.*┐$/);
    // Header row contains column names
    expect(lines[1]).toContain("name");
    expect(lines[1]).toContain("age");
    // Separator (single, after header)
    expect(lines[2]).toMatch(/^├.*┤$/);
    // Data rows
    expect(lines[3]).toContain("Alice");
    expect(lines[4]).toContain("Bob");
    // Bottom border
    expect(lines[5]).toMatch(/^└.*┘$/);
  });

  test("single separator after header, not per row", () => {
    const columns = ["x"];
    const rows = [{ x: "a" }, { x: "b" }, { x: "c" }];
    const output = renderTable(columns, rows);
    const separators = output.split("\n").filter((l) => l.startsWith("├"));
    expect(separators).toHaveLength(1);
  });

  test("null values display as (null)", () => {
    const columns = ["val"];
    const rows = [{ val: null }];
    const output = renderTable(columns, rows);
    expect(output).toContain("(null)");
  });

  test("empty rows array produces header-only table", () => {
    const columns = ["col1", "col2"];
    const rows: Record<string, unknown>[] = [];
    const output = renderTable(columns, rows);
    const lines = output.split("\n");

    // Top border, header, separator, bottom border = 4 lines
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain("col1");
    expect(lines[1]).toContain("col2");
  });
});

// ---------------------------------------------------------------------------
// handleActionApproval
// ---------------------------------------------------------------------------

describe("handleActionApproval", () => {
  test("returns ok:true and status on successful approval", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ status: "executed" }), { status: 200 }),
      ),
    ) as unknown as typeof fetch;

    try {
      const result = await handleActionApproval(
        "http://localhost:3001/api/v1/actions/abc/approve",
      );
      expect(result.ok).toBe(true);
      expect(result.status).toBe("executed");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns ok:false with error on HTTP error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ message: "Action has already been resolved." }),
          { status: 409 },
        ),
      ),
    ) as unknown as typeof fetch;

    try {
      const result = await handleActionApproval(
        "http://localhost:3001/api/v1/actions/abc/approve",
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain("already been resolved");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns ok:false on network error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("fetch failed: ECONNREFUSED")),
    ) as unknown as typeof fetch;

    try {
      const result = await handleActionApproval(
        "http://localhost:3001/api/v1/actions/abc/approve",
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain("ECONNREFUSED");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("passes API key in Authorization header", async () => {
    const originalFetch = globalThis.fetch;
    let capturedHeaders: Headers | undefined;
    globalThis.fetch = mock((_input: unknown, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      return Promise.resolve(
        new Response(JSON.stringify({ status: "approved" }), { status: 200 }),
      );
    }) as unknown as typeof fetch;

    try {
      await handleActionApproval(
        "http://localhost:3001/api/v1/actions/abc/approve",
        "my-secret-key",
      );
      expect(capturedHeaders?.get("Authorization")).toBe("Bearer my-secret-key");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
