/**
 * Shared utilities for sandbox backends.
 *
 * Extracted from the explore and python nsjail/sandbox backend files
 * to eliminate cross-backend duplication.
 */

import { SENSITIVE_PATTERNS } from "@atlas/api/lib/security";
import { resolveDeployEnv } from "@atlas/api/lib/env-profile";

/** Maximum bytes to read from stdout/stderr (1 MB). */
export const MAX_OUTPUT = 1024 * 1024;

/** The notice appended to any output that was cut at the MAX_OUTPUT cap. */
function truncationNotice(max = MAX_OUTPUT): string {
  return `\n[output truncated: exceeded ${Math.floor(max / (1024 * 1024))} MB limit]`;
}

/**
 * Cap a fully-buffered output string destined for agent context, appending a
 * truncation notice so the model knows the output was cut rather than complete.
 *
 * Complements readLimited: readLimited bounds subprocess-stream memory during
 * the read (and reports whether it truncated); capOutput bounds already-buffered
 * strings from backends that return whole outputs (Vercel sandbox, just-bash,
 * plugin/BYOC backends).
 */
export function capOutput(output: string, max = MAX_OUTPUT): string {
  if (output.length <= max) return output;
  return `${output.slice(0, max)}${truncationNotice(max)}`;
}

/**
 * Mark a stream that a backend already capped at read time (nsjail), appending
 * the truncation notice iff readLimited reported it cut the stream.
 *
 * The nsjail path caps by BYTES in readLimited, so its truncation cannot be
 * re-derived from the decoded string's `.length` (UTF-16 code units): a
 * multi-byte output cut at the byte cap can decode to fewer code units than
 * MAX_OUTPUT, which is why relying on capOutput's `length > max` check silently
 * dropped the notice for non-ASCII output (#4781/#4785). Carrying the truncation
 * fact out of the byte layer makes the notice encoding-independent.
 */
export function markCappedStream(text: string, truncated: boolean, max = MAX_OUTPUT): string {
  return truncated ? `${text}${truncationNotice(max)}` : text;
}

/** Result of readLimited: the decoded text plus whether the cap cut the stream. */
export interface LimitedRead {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * Read up to `max` bytes from a stream, releasing the reader on completion or error.
 *
 * Returns the decoded text and whether the `max`-byte cap actually cut the
 * stream — callers surface truncation from this byte-accurate flag rather than
 * re-deriving it from the decoded string length (see markCappedStream).
 *
 * Used by nsjail backends (explore + python) to cap subprocess output
 * and by testNsjailCapabilities for capability checks.
 */
export async function readLimited(
  stream: ReadableStream,
  max: number,
): Promise<LimitedRead> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        chunks.push(value.slice(0, max - (total - value.byteLength)));
        truncated = true;
        break;
      }
      chunks.push(value);
    }
  } finally {
    // intentionally ignored: stream cancel errors are non-critical during cleanup
    await reader.cancel().catch(() => {});
  }
  return { text: new TextDecoder().decode(Buffer.concat(chunks)), truncated };
}

/**
 * Attribution tags for Vercel sandboxes created by Atlas (max 5 allowed by
 * the API; we use 3). Without them, sandbox listings are a wall of
 * random-named entries with no way to tell prod explore pools from local-dev
 * or e2e churn — which is exactly how 1,200+ untraceable sandboxes
 * accumulated before 2026-07.
 */
export function atlasSandboxTags(source: "explore" | "python"): Record<string, string> {
  return {
    app: "atlas",
    source,
    env: resolveDeployEnv(),
  };
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
