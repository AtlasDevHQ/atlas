/**
 * Parse a failed `POST /api/v1/integrations/:slug/install-form` response into a
 * single actionable message for the install dialogs (`RestInstallDialog`,
 * `CuratedInstallDialog`) to throw — FormDialog then surfaces it as the shared
 * root-level error banner (arch-win #91 / #4203).
 *
 * Surfaces the first field error (e.g. the spec-probe failure on `openapi_url`)
 * so the admin sees exactly what to fix, else the top-level message, and
 * appends a short request-id tail for log correlation whenever the body carries
 * a `requestId` (the API always includes one on a 5xx, and on some 4xx too).
 * Deliberately never widened to "Something went wrong": the route hands back
 * actionable, server-typed copy and we render it verbatim.
 */
export async function installFormErrorMessage(res: Response): Promise<string> {
  let message = `Install failed (${res.status})`;
  try {
    const b = (await res.json()) as {
      message?: string;
      fieldErrors?: Record<string, string[] | undefined>;
      requestId?: string;
    };
    const firstField = b.fieldErrors ? Object.keys(b.fieldErrors)[0] : undefined;
    const firstErr = firstField ? b.fieldErrors?.[firstField]?.[0] : undefined;
    if (firstField && firstErr) message = `${firstField}: ${firstErr}`;
    else if (b.message) message = b.message;
    if (b.requestId) message = `${message} (ref: ${b.requestId.slice(0, 8)})`;
  } catch {
    // intentionally ignored: non-JSON body → keep the status-only message.
  }
  return message;
}
