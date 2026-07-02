/**
 * Extract an actionable message from a failed API `Response` — the one home
 * for the `message` / `fieldErrors` / short-`requestId` parsing idiom the
 * hand-rolled fetch dialogs (create-collection, upload-bundle) previously each
 * carried a copy of. Never throws: a non-JSON body falls back to the
 * status-only message.
 */
export async function extractApiError(res: Response, fallback: string): Promise<string> {
  let message = `${fallback} (${res.status}).`;
  try {
    const body = (await res.json()) as {
      message?: string;
      fieldErrors?: Record<string, string[] | undefined>;
      requestId?: string;
    };
    const firstField = body.fieldErrors ? Object.keys(body.fieldErrors)[0] : undefined;
    const firstErr = firstField ? body.fieldErrors?.[firstField]?.[0] : undefined;
    if (firstErr) message = firstErr;
    else if (body.message) message = body.message;
    if (body.requestId) message = `${message} (ref: ${body.requestId.slice(0, 8)})`;
  } catch {
    // intentionally ignored: non-JSON body → keep the status-only message.
  }
  return message;
}
