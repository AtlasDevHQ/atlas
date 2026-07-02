/**
 * Extract an actionable message from a failed API `Response` — the one home
 * for the `message` / `fieldErrors` / short-`requestId` parsing idiom the
 * hand-rolled fetch dialogs (create-collection, upload-bundle) previously each
 * carried a copy of. Never throws: a non-JSON body falls back to the
 * status-only message.
 */
export async function extractApiError(res: Response, fallback: string): Promise<string> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // intentionally ignored: non-JSON body → keep the status-only message.
  }
  return apiErrorFromBody(body, res.status, fallback);
}

/**
 * Same extraction for callers that already consumed the response body (e.g. a
 * dialog that needs other fields from the same JSON).
 */
export function apiErrorFromBody(body: unknown, status: number, fallback: string): string {
  let message = `${fallback} (${status}).`;
  if (body !== null && typeof body === "object") {
    const b = body as {
      message?: unknown;
      fieldErrors?: unknown;
      requestId?: unknown;
    };
    const fieldErrors =
      b.fieldErrors !== null && typeof b.fieldErrors === "object" && !Array.isArray(b.fieldErrors)
        ? (b.fieldErrors as Record<string, unknown>)
        : undefined;
    const firstField = fieldErrors ? Object.keys(fieldErrors)[0] : undefined;
    const firstFieldErrs = firstField !== undefined ? fieldErrors?.[firstField] : undefined;
    const firstErr = Array.isArray(firstFieldErrs) ? firstFieldErrs[0] : undefined;
    if (typeof firstErr === "string" && firstErr !== "") message = firstErr;
    else if (typeof b.message === "string" && b.message !== "") message = b.message;
    if (typeof b.requestId === "string" && b.requestId !== "") {
      message = `${message} (ref: ${b.requestId.slice(0, 8)})`;
    }
  }
  return message;
}
