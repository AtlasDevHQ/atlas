/**
 * Tests for CSV file upload feature.
 *
 * Covers:
 * - CSV generation (headers, escaping, encoding, multi-dataset)
 * - Export keyword detection
 * - Platform file upload support matrix
 * - Auto-attach threshold logic
 * - Fallback message generation
 * - Row counting
 */

import { describe, expect, it } from "bun:test";
import {
  generateCSV,
  buildCSVFileUpload,
  buildCSVFromQueryData,
  isExportRequest,
  platformSupportsFileUpload,
  shouldAttachCSV,
  buildFallbackMessage,
  countTotalRows,
} from "./file-upload";

// ---------------------------------------------------------------------------
// generateCSV
// ---------------------------------------------------------------------------

describe("generateCSV", () => {
  it("generates CSV with headers and data rows", () => {
    const csv = generateCSV(
      ["name", "count"],
      [
        { name: "Alice", count: 42 },
        { name: "Bob", count: 17 },
      ],
    );

    expect(csv).toContain("name,count");
    expect(csv).toContain("Alice,42");
    expect(csv).toContain("Bob,17");
  });

  it("includes UTF-8 BOM", () => {
    const csv = generateCSV(["a"], [{ a: 1 }]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it("uses CRLF line endings", () => {
    const csv = generateCSV(["a"], [{ a: 1 }]);
    expect(csv).toContain("\r\n");
  });

  it("escapes values containing commas", () => {
    const csv = generateCSV(["name"], [{ name: "Smith, John" }]);
    expect(csv).toContain('"Smith, John"');
  });

  it("escapes values containing double quotes", () => {
    const csv = generateCSV(["name"], [{ name: 'She said "hello"' }]);
    expect(csv).toContain('"She said ""hello"""');
  });

  it("escapes values containing newlines", () => {
    const csv = generateCSV(["note"], [{ note: "line1\nline2" }]);
    expect(csv).toContain('"line1\nline2"');
  });

  it("handles null and undefined values as empty strings", () => {
    const csv = generateCSV(
      ["a", "b"],
      [{ a: null, b: undefined }],
    );
    // Row should be just a comma (two empty values)
    const lines = csv.split("\r\n");
    expect(lines[1]).toBe(",");
  });

  it("handles empty rows array", () => {
    const csv = generateCSV(["a", "b"], []);
    const lines = csv.split("\r\n").filter(Boolean);
    expect(lines).toHaveLength(1); // headers only
    expect(lines[0]).toContain("a,b");
  });
});

// ---------------------------------------------------------------------------
// buildCSVFileUpload
// ---------------------------------------------------------------------------

describe("buildCSVFileUpload", () => {
  it("returns a FileUpload with correct properties", () => {
    const file = buildCSVFileUpload(
      ["name"],
      [{ name: "Alice" }],
    );

    expect(file.filename).toMatch(/^atlas-export-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.csv$/);
    expect(file.mimeType).toBe("text/csv");
    expect(file.data).toBeInstanceOf(Buffer);
  });

  it("generates valid CSV content in the buffer", () => {
    const file = buildCSVFileUpload(
      ["x", "y"],
      [{ x: 1, y: 2 }],
    );

    const content = (file.data as Buffer).toString("utf-8");
    expect(content).toContain("x,y");
    expect(content).toContain("1,2");
  });
});

// ---------------------------------------------------------------------------
// buildCSVFromQueryData
// ---------------------------------------------------------------------------

describe("buildCSVFromQueryData", () => {
  it("returns null for empty datasets", () => {
    expect(buildCSVFromQueryData([])).toBeNull();
    expect(buildCSVFromQueryData([{ columns: [], rows: [] }])).toBeNull();
    expect(buildCSVFromQueryData([{ columns: ["a"], rows: [] }])).toBeNull();
  });

  it("builds CSV from a single dataset", () => {
    const file = buildCSVFromQueryData([
      { columns: ["id", "name"], rows: [{ id: 1, name: "Alice" }] },
    ]);

    expect(file).not.toBeNull();
    const content = (file!.data as Buffer).toString("utf-8");
    expect(content).toContain("id,name");
    expect(content).toContain("1,Alice");
  });

  it("merges multiple datasets with superset columns", () => {
    const file = buildCSVFromQueryData([
      { columns: ["a", "b"], rows: [{ a: 1, b: 2 }] },
      { columns: ["b", "c"], rows: [{ b: 3, c: 4 }] },
    ]);

    expect(file).not.toBeNull();
    const content = (file!.data as Buffer).toString("utf-8");
    // Superset: a, b, c
    expect(content).toContain("a,b,c");
    // First dataset row
    expect(content).toContain("1,2,");
    // Second dataset row
    expect(content).toContain(",3,4");
  });
});

// ---------------------------------------------------------------------------
// isExportRequest
// ---------------------------------------------------------------------------

describe("isExportRequest", () => {
  it("detects 'export' keyword", () => {
    expect(isExportRequest("export the results")).toBe(true);
    expect(isExportRequest("can you Export this?")).toBe(true);
  });

  it("detects 'download' keyword", () => {
    expect(isExportRequest("download the data")).toBe(true);
  });

  it("detects 'send as CSV'", () => {
    expect(isExportRequest("send as csv please")).toBe(true);
  });

  it("detects 'as csv'", () => {
    expect(isExportRequest("give me the results as csv")).toBe(true);
  });

  it("detects 'csv file'", () => {
    expect(isExportRequest("I want a csv file")).toBe(true);
  });

  it("detects 'to csv'", () => {
    expect(isExportRequest("convert to csv")).toBe(true);
  });

  it("returns false for normal queries", () => {
    expect(isExportRequest("how many users last month?")).toBe(false);
    expect(isExportRequest("show me the top 10 customers")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// platformSupportsFileUpload
// ---------------------------------------------------------------------------

describe("platformSupportsFileUpload", () => {
  it("returns true for file-capable platforms", () => {
    for (const platform of ["slack", "teams", "discord", "gchat", "telegram", "whatsapp"]) {
      expect(platformSupportsFileUpload(platform)).toBe(true);
    }
  });

  it("returns false for platforms without file upload", () => {
    expect(platformSupportsFileUpload("github")).toBe(false);
    expect(platformSupportsFileUpload("linear")).toBe(false);
  });

  it("returns false for unknown platforms", () => {
    expect(platformSupportsFileUpload("unknown")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// shouldAttachCSV
// ---------------------------------------------------------------------------

describe("shouldAttachCSV", () => {
  it("attaches when explicit export is requested", () => {
    expect(shouldAttachCSV(1, true)).toBe(true);
    expect(shouldAttachCSV(0, true)).toBe(true);
  });

  it("attaches when rows exceed default threshold", () => {
    expect(shouldAttachCSV(21, false)).toBe(true);
  });

  it("does not attach at or below default threshold", () => {
    expect(shouldAttachCSV(20, false)).toBe(false);
    expect(shouldAttachCSV(10, false)).toBe(false);
  });

  it("respects custom threshold", () => {
    expect(shouldAttachCSV(51, false, { autoAttachThreshold: 50 })).toBe(true);
    expect(shouldAttachCSV(50, false, { autoAttachThreshold: 50 })).toBe(false);
  });

  it("disables auto-attach when threshold is 0", () => {
    expect(shouldAttachCSV(1000, false, { autoAttachThreshold: 0 })).toBe(false);
  });

  it("still attaches on explicit export when threshold is 0", () => {
    expect(shouldAttachCSV(5, true, { autoAttachThreshold: 0 })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildFallbackMessage
// ---------------------------------------------------------------------------

describe("buildFallbackMessage", () => {
  it("includes web UI link when webBaseUrl is configured", () => {
    const msg = buildFallbackMessage("https://app.example.com");
    expect(msg).toContain("https://app.example.com");
    expect(msg).toContain("View full results");
  });

  it("strips trailing slashes from webBaseUrl", () => {
    const msg = buildFallbackMessage("https://app.example.com///");
    expect(msg).toContain("https://app.example.com)");
  });

  it("prompts to configure webBaseUrl when not set", () => {
    const msg = buildFallbackMessage();
    expect(msg).toContain("fileUpload.webBaseUrl");
  });
});

// ---------------------------------------------------------------------------
// countTotalRows
// ---------------------------------------------------------------------------

describe("countTotalRows", () => {
  it("sums rows across datasets", () => {
    expect(
      countTotalRows([
        { columns: ["a"], rows: [{ a: 1 }, { a: 2 }] },
        { columns: ["b"], rows: [{ b: 3 }] },
      ]),
    ).toBe(3);
  });

  it("returns 0 for empty data", () => {
    expect(countTotalRows([])).toBe(0);
    expect(countTotalRows([{ columns: ["a"], rows: [] }])).toBe(0);
  });
});
