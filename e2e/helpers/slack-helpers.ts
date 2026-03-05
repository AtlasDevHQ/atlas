/**
 * Slack signature helpers for E2E tests.
 *
 * Generates HMAC-SHA256 signatures matching the Slack request signing spec.
 */

import crypto from "crypto";

/**
 * Generate a Slack request signature for the given body and secret.
 *
 * @param secret - Slack signing secret
 * @param body - Raw request body string
 * @param timestamp - Unix timestamp (defaults to now)
 */
export function makeSignature(
  secret: string,
  body: string,
  timestamp?: string,
): { signature: string; timestamp: string } {
  const ts = timestamp ?? String(Math.floor(Date.now() / 1000));
  const sigBasestring = `v0:${ts}:${body}`;
  const sig =
    "v0=" +
    crypto.createHmac("sha256", secret).update(sigBasestring).digest("hex");
  return { signature: sig, timestamp: ts };
}
