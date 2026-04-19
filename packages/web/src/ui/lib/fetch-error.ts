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
      if (typeof obj.message === "string") message = obj.message;
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
 * Convert a FetchError into a user-friendly message.
 * Replaces known HTTP status codes (401, 403, 404, 503) with admin-specific
 * guidance; falls back to the raw error message for other codes or non-HTTP
 * errors. Appends request ID for log correlation when available.
 */
export function friendlyError(err: FetchError): string {
  let msg: string;
  if (err.status === 401) msg = "Not authenticated. Please sign in.";
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
