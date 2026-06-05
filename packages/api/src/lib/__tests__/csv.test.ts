import { describe, it, expect } from "bun:test";
import { csvCell, toCsv, csvFilename } from "@atlas/api/lib/csv";

describe("csvCell — RFC 4180 escaping", () => {
  it("passes a plain string through unquoted", () => {
    expect(csvCell("hello")).toBe("hello");
  });

  it("renders null/undefined as an empty field", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("stringifies numbers and booleans without quoting", () => {
    expect(csvCell(42)).toBe("42");
    expect(csvCell(0)).toBe("0");
    expect(csvCell(-3.5)).toBe("-3.5");
    expect(csvCell(true)).toBe("true");
    expect(csvCell(false)).toBe("false");
  });

  it("quotes a field containing a comma", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
  });

  it("doubles embedded quotes and wraps the field", () => {
    expect(csvCell('she said "hi"')).toBe('"she said ""hi"""');
  });

  it("quotes a field containing a newline or carriage return", () => {
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell("a\r\nb")).toBe('"a\r\nb"');
  });
});

describe("csvCell — formula-injection neutralization", () => {
  it("prefixes a leading = with a single quote", () => {
    expect(csvCell("=SUM(A1:A2)")).toBe("'=SUM(A1:A2)");
  });

  it("prefixes a leading @ with a single quote", () => {
    expect(csvCell("@cmd")).toBe("'@cmd");
  });

  it("prefixes a leading tab or carriage return (then quotes for CR)", () => {
    expect(csvCell("\t=1+1")).toBe("'\t=1+1");
    // A leading CR is both a formula vector and needs RFC quoting.
    expect(csvCell("\r=1+1")).toBe("\"'\r=1+1\"");
  });

  it("neutralizes a leading + or - when the field is NOT a plain number", () => {
    expect(csvCell("+cmd")).toBe("'+cmd");
    expect(csvCell("-2+3")).toBe("'-2+3");
    expect(csvCell("-")).toBe("'-");
  });

  it("does NOT neutralize genuine numeric strings (pg returns numeric/bigint as strings)", () => {
    // A numeric column value arrives as a string from the pg driver; mangling
    // it to text ('-5.00) would break every numeric dashboard export.
    expect(csvCell("-5.00")).toBe("-5.00");
    expect(csvCell("+1e3")).toBe("+1e3");
    expect(csvCell("-42")).toBe("-42");
  });

  it("neutralizes first, THEN applies RFC quoting", () => {
    // Leading "=" is neutralized to "'=1,2"; the comma then forces quoting.
    expect(csvCell("=1,2")).toBe("\"'=1,2\"");
  });

  it("neutralizes a dangerous leading char inside an object value", () => {
    expect(csvCell({ k: "=evil" })).toBe('"{""k"":""=evil""}"');
  });
});

describe("toCsv", () => {
  it("emits a header row then one CRLF-separated row per record", () => {
    const csv = toCsv(
      ["name", "count"],
      [
        { name: "alice", count: 3 },
        { name: "bob", count: 7 },
      ],
    );
    expect(csv).toBe("name,count\r\nalice,3\r\nbob,7");
  });

  it("renders missing keys as empty cells", () => {
    const csv = toCsv(["a", "b"], [{ a: 1 }]);
    expect(csv).toBe("a,b\r\n1,");
  });

  it("escapes header names and neutralizes formula cells", () => {
    const csv = toCsv(["full,name", "note"], [{ "full,name": "x", note: "=HYPERLINK(1)" }]);
    expect(csv).toBe('"full,name",note\r\nx,\'=HYPERLINK(1)');
  });

  it("returns just the header for an empty row set", () => {
    expect(toCsv(["a", "b"], [])).toBe("a,b");
  });
});

describe("csvFilename", () => {
  const at = new Date(Date.UTC(2026, 5, 5, 12, 30, 45)); // 2026-06-05 12:30:45 UTC

  it("derives a slug from the card title plus a UTC stamp", () => {
    expect(csvFilename("Monthly Revenue", at)).toBe("monthly-revenue-20260605-123045.csv");
  });

  it("strips unsafe characters and collapses separators", () => {
    expect(csvFilename("Q3 / 2026 — Sales!!", at)).toBe("q3-2026-sales-20260605-123045.csv");
  });

  it("falls back to 'card' when the title has no usable characters", () => {
    expect(csvFilename("———", at)).toBe("card-20260605-123045.csv");
    expect(csvFilename("", at)).toBe("card-20260605-123045.csv");
  });
});
