/**
 * Structured error from a failed fetch operation.
 * May represent an HTTP error response (with status and optional requestId)
 * or a network-level failure (status undefined).
 *
 * `code` captures the machine-readable `error` field from the API's JSON body
 * (e.g. `"enterprise_required"`). Prefer branching on this over string-matching
 * the human-facing `message`.
 */
export interface FetchError {
  message: string;
  status?: number;
  requestId?: string;
  code?: string;
}

/**
 * Extract a structured error from a failed fetch response.
 * Parses the JSON body for `message`, `error` (machine-readable code), and
 * `requestId` fields; falls back to a status-only message if the body isn't JSON.
 */
export async function extractFetchError(res: Response): Promise<FetchError> {
  let message = `HTTP ${res.status}`;
  let requestId: string | undefined;
  let code: string | undefined;
  try {
    const body: unknown = await res.json();
    if (typeof body === "object" && body !== null) {
      const obj = body as Record<string, unknown>;
      // Require a non-empty message so a server returning `{ message: "" }`
      // (intentional, misconfigured, or truncated) doesn't clobber the
      // `HTTP ${status}` fallback — downstream helpers silently drop empty
      // messages (`combineMutationErrors` filters them, `friendlyError`
      // renders blank banners for non-gated status codes).
      if (typeof obj.message === "string" && obj.message.length > 0) {
        message = obj.message;
      }
      if (typeof obj.requestId === "string") requestId = obj.requestId;
      if (typeof obj.error === "string") code = obj.error;
    }
  } catch (err) {
    // Non-JSON body is expected — log unexpected errors (e.g. body already consumed) for debugging.
    if (!(err instanceof SyntaxError)) {
      console.debug("extractFetchError: unexpected error reading response body", err);
    }
  }
  return {
    message,
    status: res.status,
    ...(requestId && { requestId }),
    ...(code && { code }),
  };
}

/**
 * Nullable variant of {@link friendlyError} for call sites that thread a
 * `FetchError | null` through to a `string | null` prop (e.g.
 * `FormDialog.serverError`, `InlineError`). Collapses the
 * `err ? friendlyError(err) : null` ternary to a single call:
 *
 *   serverError={friendlyErrorOrNull(mutation.error)}
 *
 * Exists because `friendlyError` is strictly `FetchError → string` — widening
 * it to accept null would force ~30 non-null call sites to narrow a return
 * that's always a string today.
 */
export function friendlyErrorOrNull(err: FetchError | null | undefined): string | null {
  return err ? friendlyError(err) : null;
}

/**
 * Convert a FetchError into a user-friendly message.
 * Replaces known HTTP status codes (401, 403, 404, 503) with admin-specific
 * guidance; falls back to the raw error message for other codes or non-HTTP
 * errors. Appends request ID for log correlation when available.
 */
export function friendlyError(err: FetchError): string {
  let msg: string;
  // Schema mismatch only wins for client-side parse failures (status undefined),
  // because the body parses as 200 OK but fails Zod — HTTP status alone can't
  // distinguish this case. Gating on `status === undefined` prevents an HTTP
  // error whose body happens to set `error: "schema_mismatch"` from masking
  // the 401/403/404/503 mappings below — the 401 "sign in" message has to
  // reach the user even if a misconfigured server tags the body that way.
  if (err.code === "schema_mismatch" && err.status === undefined)
    msg = "The server returned data this version of the app can't read. This usually means the server and app are out of sync — contact your administrator or try again later.";
  else if (err.status === 401) msg = "Not authenticated. Please sign in.";
  else if (err.status === 403)
    msg = "Access denied. Admin role required to view this page.";
  else if (err.status === 404)
    msg = "This feature is not enabled on this server.";
  else if (err.status === 503)
    msg = "A required service is unavailable. Check server configuration.";
  else msg = err.message;
  if (err.requestId) msg += ` (Request ID: ${err.requestId})`;
  return msg;
}
