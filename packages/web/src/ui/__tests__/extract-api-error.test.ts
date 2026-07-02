/**
 * Unit tests for the shared API-error extraction helper — precedence
 * (fieldErrors first, then message), the short-`requestId` suffix, the
 * status-only fallback for non-JSON bodies, and the type guards that keep a
 * malformed body from assigning a non-string into the message.
 */

import { describe, expect, test } from "bun:test";
import { apiErrorFromBody, extractApiError } from "../lib/extract-api-error";

describe("apiErrorFromBody", () => {
  test("prefers the first field error over the top-level message", () => {
    const msg = apiErrorFromBody(
      { message: "top", fieldErrors: { endpoint_url: ["Endpoint URL is required."] } },
      400,
      "Could not save",
    );
    expect(msg).toBe("Endpoint URL is required.");
  });

  test("falls back to message, appending the short requestId ref", () => {
    const msg = apiErrorFromBody(
      { message: "Bundle is too large.", requestId: "abcdef1234567890" },
      400,
      "Ingest failed",
    );
    expect(msg).toBe("Bundle is too large. (ref: abcdef12)");
  });

  test("status-only fallback for null / non-object bodies", () => {
    expect(apiErrorFromBody(null, 502, "Ingest failed")).toBe("Ingest failed (502).");
    expect(apiErrorFromBody("<html>", 502, "Ingest failed")).toBe("Ingest failed (502).");
  });

  test("guards malformed shapes — non-string field errors and array fieldErrors never win", () => {
    expect(
      apiErrorFromBody({ fieldErrors: { a: [42] }, message: "real" }, 400, "Failed"),
    ).toBe("real");
    expect(apiErrorFromBody({ fieldErrors: ["nope"], message: "real" }, 400, "Failed")).toBe(
      "real",
    );
    expect(apiErrorFromBody({ message: 42 }, 400, "Failed")).toBe("Failed (400).");
  });
});

describe("extractApiError", () => {
  test("parses a JSON response body", async () => {
    const res = new Response(JSON.stringify({ message: "boom" }), { status: 400 });
    expect(await extractApiError(res, "Failed")).toBe("boom");
  });

  test("non-JSON body falls back to the status-only message", async () => {
    const res = new Response("<html>captive portal</html>", { status: 200 });
    expect(await extractApiError(res, "Failed")).toBe("Failed (200).");
  });
});
