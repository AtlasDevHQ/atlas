/**
 * Default fetch timeout for every helper request. 30s is the same value
 * both pre-extraction implementations used; a single constant keeps the
 * wire timeout consistent across consumers without a config hop.
 */
export const FETCH_TIMEOUT_MS = 30 * 1000;

/**
 * Surface OAuth 2.1 / DCR error responses as `error: error_description`
 * when the body parses as the canonical `{error,error_description,error_uri}`
 * shape (RFC 6749 §5.2). Falls back to the raw text (truncated to 1KiB)
 * when the body is empty / not JSON / not the canonical shape, so we
 * never silently lose upstream signal.
 *
 * If the body itself fails to read (malformed UTF-8, mid-stream abort,
 * stream lock contention) we surface the read failure inline as the
 * "detail" string so support tickets do NOT end up with a bare status
 * code. Returning `""` here would lose the only diagnostic we have.
 */
export async function describeOAuthErrorBody(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch (err) {
    return `<failed to read response body: ${
      err instanceof Error ? err.message : String(err)
    }>`;
  }
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as Partial<{
      error: string;
      error_description: string;
      error_uri: string;
    }>;
    const parts: string[] = [];
    if (typeof parsed.error === "string" && parsed.error.length > 0) {
      parts.push(parsed.error);
    }
    if (typeof parsed.error_description === "string" && parsed.error_description.length > 0) {
      parts.push(parsed.error_description);
    }
    if (typeof parsed.error_uri === "string" && parsed.error_uri.length > 0) {
      parts.push(`see ${parsed.error_uri}`);
    }
    if (parts.length > 0) return parts.join(": ");
  } catch {
    // intentionally ignored: not JSON — fall through to the raw-text
    // branch below. The raw text is preserved (truncated) so non-OAuth
    // error bodies still surface in the eventual error message.
  }
  return raw.length > 1024 ? `${raw.slice(0, 1024)}…` : raw;
}
