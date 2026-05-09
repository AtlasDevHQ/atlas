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
 */
export async function describeOAuthErrorBody(res: Response): Promise<string> {
  const raw = await res.text().catch(() => "");
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
    // intentionally ignored: not JSON — fall through to raw-text branch.
  }
  return raw.length > 1024 ? `${raw.slice(0, 1024)}…` : raw;
}
