import { describe, expect, it } from "bun:test";

import { parseAttachmentFilename } from "@/ui/lib/helpers";

describe("parseAttachmentFilename", () => {
  it("extracts a quoted plain filename", () => {
    expect(
      parseAttachmentFilename('attachment; filename="revenue-overview-20260604-123045.pdf"'),
    ).toBe("revenue-overview-20260604-123045.pdf");
  });

  it("extracts an unquoted plain filename", () => {
    expect(parseAttachmentFilename("attachment; filename=board.png")).toBe("board.png");
  });

  it("prefers and decodes the RFC 5987 filename* form", () => {
    expect(
      parseAttachmentFilename("attachment; filename=\"fallback.pdf\"; filename*=UTF-8''q2%20sales.pdf"),
    ).toBe("q2 sales.pdf");
  });

  it("falls back to the plain form when filename* is malformed", () => {
    // %E0%A4%A is an incomplete percent-escape — decodeURIComponent throws.
    expect(
      parseAttachmentFilename("attachment; filename=\"safe.pdf\"; filename*=UTF-8''%E0%A4%A"),
    ).toBe("safe.pdf");
  });

  it("returns null for an absent header", () => {
    expect(parseAttachmentFilename(null)).toBeNull();
  });

  it("returns null when the header carries no filename", () => {
    expect(parseAttachmentFilename("attachment")).toBeNull();
    expect(parseAttachmentFilename("inline")).toBeNull();
  });
});
