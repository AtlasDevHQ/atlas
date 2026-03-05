/**
 * Slack request signature verification.
 *
 * Verifies incoming requests are genuinely from Slack using HMAC-SHA256
 * signature validation with timing-safe comparison. Rejects requests
 * with timestamps older than 5 minutes to prevent replay attacks.
 *
 * @see https://api.slack.com/authentication/verifying-requests-from-slack
 */

import crypto from "crypto";

const MAX_TIMESTAMP_AGE_SECONDS = 300; // 5 minutes

export type VerifyResult =
  | { valid: true }
  | { valid: false; error: string };

/**
 * Verify a Slack request signature.
 *
 * @param signingSecret - The SLACK_SIGNING_SECRET from app credentials
 * @param signature - The `x-slack-signature` header value (v0=...)
 * @param timestamp - The `x-slack-request-timestamp` header value (unix seconds)
 * @param body - The raw request body string
 */
export function verifySlackSignature(
  signingSecret: string,
  signature: string | null,
  timestamp: string | null,
  body: string,
): VerifyResult {
  if (!signature || !timestamp) {
    return { valid: false, error: "Missing signature or timestamp headers" };
  }

  const ts = parseInt(timestamp, 10);
  if (isNaN(ts)) {
    return { valid: false, error: "Invalid timestamp" };
  }

  // Reject requests with timestamps more than 5 minutes from current time (past or future)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > MAX_TIMESTAMP_AGE_SECONDS) {
    return { valid: false, error: "Request timestamp too old" };
  }

  const sigBasestring = `v0:${timestamp}:${body}`;
  const mySignature =
    "v0=" +
    crypto
      .createHmac("sha256", signingSecret)
      .update(sigBasestring)
      .digest("hex");

  // Timing-safe comparison to prevent timing attacks
  try {
    const sigBuffer = Buffer.from(signature, "utf8");
    const myBuffer = Buffer.from(mySignature, "utf8");
    if (sigBuffer.length !== myBuffer.length) {
      return { valid: false, error: "Invalid signature" };
    }
    if (!crypto.timingSafeEqual(sigBuffer, myBuffer)) {
      return { valid: false, error: "Invalid signature" };
    }
  } catch {
    return { valid: false, error: "Signature verification error" };
  }

  return { valid: true };
}
