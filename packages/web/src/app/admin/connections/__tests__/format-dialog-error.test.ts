/**
 * Unit tests for the Add / Edit Connection dialog error formatter (#2485).
 *
 * Locks the 429 retry-guidance carve-out so the server's stock "Please
 * wait before trying again" copy can't silently re-displace the admin-
 * facing "Wait a few seconds" guidance the issue closed on. The non-429
 * cases bind the verbatim structured-body contract so a future
 * "friendly default" doesn't collapse `connection_failed` / `conflict`
 * back into a generic banner.
 */

import { describe, expect, test } from "bun:test";
import { formatDialogError } from "../format-dialog-error";
import type { FetchError } from "@/ui/lib/fetch-error";

describe("formatDialogError — #2485 dialog error surfacing", () => {
  test("429 substitutes admin-facing retry guidance, not server stock copy", () => {
    const err: FetchError = {
      status: 429,
      code: "rate_limited",
      message: "Too many requests. Please wait before trying again.",
    };
    const out = formatDialogError(err);
    expect(out).toBe("Too many requests. Wait a few seconds and try again.");
  });

  test("429 appends Request ID when present", () => {
    const err: FetchError = {
      status: 429,
      code: "rate_limited",
      message: "Too many requests. Please wait before trying again.",
      requestId: "abc-123",
    };
    const out = formatDialogError(err);
    expect(out).toContain("Wait a few seconds and try again.");
    expect(out).toContain("Request ID: abc-123");
  });

  test("plan_limit_exceeded (also 429) surfaces the server's structured upgrade message verbatim", () => {
    // Both rate-limited and plan-limit-exceeded come back as 429, but
    // the recovery action is different: rate-limited admins wait,
    // plan-limited admins upgrade. Collapsing both to wait-and-retry
    // would tell a plan-limited admin to wait for a budget refresh
    // that never comes. The 429 substitution gates on `code` so the
    // structured "Upgrade to add more" copy from billing/enforcement
    // reaches the user.
    const err: FetchError = {
      status: 429,
      code: "plan_limit_exceeded",
      message: "Your free plan allows up to 1 connections. Upgrade to add more.",
    };
    const out = formatDialogError(err);
    expect(out).toContain("Your free plan allows up to 1 connections");
    expect(out).toContain("Upgrade to add more");
    // The wait-and-retry copy must NOT appear — that would mislead a
    // plan-limited admin into waiting instead of upgrading.
    expect(out).not.toContain("Wait a few seconds");
  });

  test("429 without a code (defensive) substitutes retry guidance", () => {
    // Belt-and-suspenders: a 429 from an upstream layer that forgot to
    // populate `code` should still get the wait-and-retry copy, because
    // the most common cause of 429 in this surface is rate-limiting.
    const err: FetchError = {
      status: 429,
      message: "Too many requests.",
    };
    const out = formatDialogError(err);
    expect(out).toBe("Too many requests. Wait a few seconds and try again.");
  });

  test("400 connection_failed surfaces the server's structured error body verbatim", () => {
    // The server hands back actionable copy ("Fix the URL and try
    // again.") — the dialog must not collapse it into a generic banner.
    const err: FetchError = {
      status: 400,
      code: "connection_failed",
      message: "Connection test failed: bad credentials. Fix the URL and try again.",
    };
    const out = formatDialogError(err);
    expect(out).toContain("Connection test failed: bad credentials");
    expect(out).toContain("Fix the URL and try again");
  });

  test("409 conflict surfaces the server message verbatim", () => {
    const err: FetchError = {
      status: 409,
      code: "conflict",
      message: 'Connection "warehouse" already exists.',
    };
    const out = formatDialogError(err);
    expect(out).toContain('Connection "warehouse" already exists');
  });

  test("500 internal_error preserves the structured body — no 'Something went wrong' substitution", () => {
    const err: FetchError = {
      status: 500,
      code: "internal_error",
      message: "Failed to save connection.",
      requestId: "req-789",
    };
    const out = formatDialogError(err);
    expect(out).toContain("Failed to save connection");
    expect(out).toContain("req-789");
  });
});
