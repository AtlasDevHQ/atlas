/**
 * Stream a body with a cumulative size cap — the shared authoritative guard
 * against lying or chunked byte sources. A declared `Content-Length` is
 * advisory (clients and endpoints can omit or misstate it); only counting the
 * bytes as they arrive bounds memory. Both untrusted-input paths of the
 * knowledge pillar read through this: the admin bundle upload
 * (`api/routes/admin-knowledge.ts` ingest route) and the bundle-endpoint
 * fetch (`lib/knowledge/sync.ts` — scheduled and manual "Sync now" alike).
 */

import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("knowledge.read-body-cap");

/**
 * The stream crossed `maxBytes` and the read was aborted. The message carries
 * no source details (no host, no path) — callers translate it into their own
 * redaction-appropriate wording.
 */
export class BodyCapExceededError extends Error {
  constructor(maxBytes: number) {
    super(`Body exceeds the ${maxBytes}-byte limit — read aborted.`);
    this.name = "BodyCapExceededError";
  }
}

/**
 * Read `body` fully, throwing `BodyCapExceededError` the moment the cumulative
 * byte count crosses `maxBytes` (the connection is released either way). A
 * null body resolves to an empty buffer. `logContext` identifies the caller in
 * the cancel-failure debug log (e.g. `{ host }` from the sync fetch,
 * `{ requestId }` from the ingest route) — the shared helper otherwise
 * couldn't say WHICH byte source misbehaved.
 */
export async function readBodyWithCap(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  logContext: Record<string, unknown> = {},
): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > maxBytes) {
        throw new BodyCapExceededError(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    // Release the connection whether we finished or bailed on the cap.
    await reader.cancel().catch((err: unknown) => {
      log.debug(
        { ...logContext, err: err instanceof Error ? err.message : String(err) },
        "Body reader cancel failed after read completed/aborted",
      );
    });
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
