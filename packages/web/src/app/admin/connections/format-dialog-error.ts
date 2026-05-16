import { friendlyError, type FetchError } from "@/ui/lib/fetch-error";

/**
 * Format a save-mutation error for the Add / Edit Connection dialog (#2485).
 *
 * `rate_limited` 429s get explicit retry guidance because the server's
 * stock copy ("Too many requests. Please wait before trying again.") is
 * generic — the inline banner that #2485 introduced needs to tell the
 * admin exactly what action recovers the form, not just that something
 * rate-limited.
 *
 * Every other 4xx/5xx — including `plan_limit_exceeded` (which also
 * comes back as 429 but with actionable "Upgrade to add more" copy
 * from billing/enforcement.ts) — is rendered verbatim from the
 * structured error body via `friendlyError`. We deliberately do NOT
 * collapse messages to "Something went wrong" or wait-and-retry: the
 * route hands back `connection_failed`, `conflict`, `plan_limit_exceeded`
 * etc with actionable copy and we want the admin to see it.
 */
export function formatDialogError(err: FetchError): string {
  // Branch on `code` so a 429 with a non-rate-limited code (today:
  // `plan_limit_exceeded`; tomorrow: anything else 429 might carry)
  // keeps its server-typed message instead of being collapsed into
  // wait-and-retry guidance that does not apply.
  if (err.status === 429 && (err.code === "rate_limited" || err.code === undefined)) {
    const base = "Too many requests. Wait a few seconds and try again.";
    return err.requestId ? `${base} (Request ID: ${err.requestId})` : base;
  }
  return friendlyError(err);
}
