/**
 * CSPRNG entry point for the helper. Sole call site for
 * `crypto.getRandomValues` — must not be replaced with `Math.random`
 * even for tests; pass `randomBytesImpl` on the relevant `*Options`
 * shape to drive deterministic test output without weakening the
 * production RNG.
 */
export function defaultRandomBytes(length: number): Uint8Array {
  const buf = new Uint8Array(length);
  crypto.getRandomValues(buf);
  return buf;
}

/**
 * RFC 4648 §5 URL-safe base64 with stripped padding.
 *
 * PKCE (RFC 7636 §4.2) and OAuth `state` (RFC 6749 §10.12) both require
 * this exact wire shape — do NOT re-add `=` padding, do NOT swap to the
 * standard alphabet, and do NOT remove the `+`/`/` substitutions.
 * Server-side PKCE verification computes `BASE64URL(SHA-256(verifier))`
 * and compares byte-for-byte; any divergence here yields opaque
 * "invalid_grant" failures at the token endpoint.
 */
export function encodeBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
