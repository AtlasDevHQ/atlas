/**
 * Shared utilities for sandbox backends.
 *
 * Extracted from the explore and python nsjail/sandbox backend files
 * to eliminate cross-backend duplication.
 */

import { SENSITIVE_PATTERNS } from "@atlas/api/lib/security";

/** Maximum bytes to read from stdout/stderr (1 MB). */
export const MAX_OUTPUT = 1024 * 1024;

/**
 * Read up to `max` bytes from a stream, releasing the reader on completion or error.
 *
 * Used by nsjail backends (explore + python) to cap subprocess output
 * and by testNsjailCapabilities for capability checks.
 */
export async function readLimited(
  stream: ReadableStream,
  max: number,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        chunks.push(value.slice(0, max - (total - value.byteLength)));
        break;
      }
      chunks.push(value);
    }
  } finally {
    // intentionally ignored: stream cancel errors are non-critical during cleanup
    await reader.cancel().catch(() => {});
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Logger interface accepted by parsePositiveInt — avoids coupling to pino. */
interface MinimalLogger {
  warn: (...args: unknown[]) => void;
}

/**
 * Parse a positive integer from an env var, returning defaultValue on invalid input.
 *
 * Used by both explore and python nsjail backends for resource limit config.
 */
export function parsePositiveInt(
  envVar: string,
  defaultValue: number,
  name: string,
  log: MinimalLogger,
): number {
  const raw = process.env[envVar];
  if (raw === undefined) return defaultValue;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed <= 0) {
    log.warn(
      { envVar, raw, default: defaultValue },
      `Invalid ${envVar} for ${name}, using default`,
    );
    return defaultValue;
  }
  return parsed;
}

/**
 * Format an error for logging, with extra detail from @vercel/sandbox
 * APIError json/text fields when present.
 *
 * Used by both explore-sandbox.ts and python-sandbox.ts.
 */
export function sandboxErrorDetail(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const detail = err.message;
  // APIError from @vercel/sandbox carries json/text with the server response.
  // These properties are not in our type stubs — discovered from runtime errors.
  const json = (err as unknown as Record<string, unknown>).json;
  const text = (err as unknown as Record<string, unknown>).text;
  if (json) {
    try {
      return `${detail} — response: ${JSON.stringify(json)}`;
    } catch {
      // intentionally ignored: JSON.stringify can fail on circular references
      return `${detail} — response: [unserializable object]`;
    }
  }
  if (typeof text === "string" && text) return `${detail} — body: ${text.slice(0, 500)}`;
  return detail;
}

/** Scrub sensitive data from error messages before exposing to users. */
export function safeError(detail: string): string {
  return SENSITIVE_PATTERNS.test(detail)
    ? "sandbox API error (details in server logs)"
    : detail;
}
