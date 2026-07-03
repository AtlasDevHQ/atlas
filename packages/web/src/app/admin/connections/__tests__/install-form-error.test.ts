import { describe, expect, test } from "bun:test";
import { installFormErrorMessage } from "../install-form-error";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("installFormErrorMessage", () => {
  test("prefers the first field error (what the admin must fix)", async () => {
    const res = jsonResponse(400, {
      message: "Validation failed",
      fieldErrors: { openapi_url: ["Could not reach the spec URL"] },
    });
    expect(await installFormErrorMessage(res)).toBe("openapi_url: Could not reach the spec URL");
  });

  test("falls back to the top-level message when there are no field errors", async () => {
    const res = jsonResponse(409, { message: "Already installed" });
    expect(await installFormErrorMessage(res)).toBe("Already installed");
  });

  test("appends a short request-id tail for log correlation", async () => {
    const res = jsonResponse(500, { message: "Internal error", requestId: "abcdef1234567890" });
    expect(await installFormErrorMessage(res)).toBe("Internal error (ref: abcdef12)");
  });

  test("keeps a status-only message on a non-JSON body (never widens to a generic error)", async () => {
    const res = new Response("<html>gateway timeout</html>", { status: 504 });
    expect(await installFormErrorMessage(res)).toBe("Install failed (504)");
  });
});
