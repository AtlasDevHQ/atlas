import { defaultRandomBytes, encodeBase64Url } from "./_internal/encoding";

export interface PkceCodeChallenge {
  /** Random verifier persisted between begin → complete. */
  codeVerifier: string;
  /** SHA-256 of `codeVerifier`, base64url-encoded. Sent on `/authorize`. */
  codeChallenge: string;
  /**
   * Always `S256`. RFC 7636 §4.2 defines both `plain` and `S256`;
   * OAuth 2.1 §4.1.1 forbids `plain` for new deployments.
   */
  method: "S256";
}

export interface RandomBytesOptions {
  /** Test seam — defaults to `crypto.getRandomValues`. */
  randomBytesImpl?: (length: number) => Uint8Array;
}

const VERIFIER_BYTES = 32;
const STATE_BYTES = 32;

export async function generatePkce(options?: RandomBytesOptions): Promise<PkceCodeChallenge> {
  const randomBytes = options?.randomBytesImpl ?? defaultRandomBytes;
  const codeVerifier = encodeBase64Url(randomBytes(VERIFIER_BYTES));
  const codeChallenge = await pkceChallenge(codeVerifier);
  return { codeVerifier, codeChallenge, method: "S256" };
}

/**
 * Anti-CSRF nonce echoed by the auth server in the redirect — callers
 * must persist this and compare against the callback's `state`. Same
 * RNG seam as `generatePkce` so deterministic tests can pin both.
 */
export function generateState(options?: RandomBytesOptions): string {
  const randomBytes = options?.randomBytesImpl ?? defaultRandomBytes;
  return encodeBase64Url(randomBytes(STATE_BYTES));
}

async function pkceChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return encodeBase64Url(new Uint8Array(digest));
}
