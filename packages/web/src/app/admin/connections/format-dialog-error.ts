import { friendlyError, type FetchError } from "@/ui/lib/fetch-error";

/**
 * Format a save-mutation error for the Add / Edit Connection dialog (#2485).
 *
 * 429 gets explicit retry guidance because the server's stock copy ("Too
 * many requests. Please wait before trying again.") is easy for admins to
 * miss next to the submit spinner — admins who didn't see the inline
 * banner filed #2485 thinking the form was broken.
 *
 * Every other 4xx/5xx is rendered verbatim from the structured error body
 * via `friendlyError`. We deliberately do NOT collapse the message to
 * "Something went wrong" — the route hands back `connection_failed`,
 * `conflict`, `plan_limit_exceeded` etc with actionable copy and we want
 * the admin to see it.
 */
export function formatDialogError(err: FetchError): string {
  if (err.status === 429) {
    const base = "Too many requests. Wait a few seconds and try again.";
    return err.requestId ? `${base} (Request ID: ${err.requestId})` : base;
  }
  return friendlyError(err);
}
