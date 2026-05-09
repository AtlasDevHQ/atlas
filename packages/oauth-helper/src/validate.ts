import { OAuthHelperError, type OAuthHelperErrorCode } from "./errors";

/**
 * Refuse anything other than `https://` (or `http://localhost` /
 * `http://127.0.0.1` for dev). Used by callers for both:
 *
 *   1. The user-supplied `apiUrl` driving discovery — a typo'd or
 *      hostile env var (`ATLAS_PUBLIC_API_URL=http://evil.example.com`)
 *      would drive the user through a fake authorize page and ship a
 *      foreign-issued JWT into their MCP client config.
 *   2. The discovered `token_endpoint` — a malicious DCR response can
 *      advertise `token_endpoint: "http://evil/token"` and would
 *      otherwise smuggle the auth code + PKCE verifier over plaintext.
 *
 * The `code` argument lets the caller distinguish which guard tripped
 * (`invalid_api_url` for case 1, `invalid_token_endpoint` for case 2)
 * so the consumer's error envelope routes the right hint.
 */
function validateHttpsUrl(
  input: string,
  code: Extract<OAuthHelperErrorCode, "invalid_api_url" | "invalid_token_endpoint">,
  label: string,
): void {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch (err) {
    throw new OAuthHelperError(
      `${label} is not a valid URL: ${input}`,
      code,
      { cause: err },
    );
  }
  if (parsed.protocol === "https:") return;
  if (
    parsed.protocol === "http:" &&
    (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost")
  ) {
    return;
  }
  throw new OAuthHelperError(
    `${label} must use https:// (or http://localhost for dev). Got: ${input}`,
    code,
  );
}

export function validateIssuerUrl(apiUrl: string): void {
  validateHttpsUrl(apiUrl, "invalid_api_url", "apiUrl");
}

export function validateTokenEndpoint(tokenEndpoint: string): void {
  validateHttpsUrl(tokenEndpoint, "invalid_token_endpoint", "tokenEndpoint");
}
