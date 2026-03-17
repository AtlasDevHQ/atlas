/**
 * Request-scoped store for UI message stream writers.
 *
 * During streaming Python execution, the Python tool needs to write progress
 * events (stdout chunks, chart renders) to the same UI message stream that
 * carries the agent's text output. This module provides a simple Map-based
 * store keyed by request ID, set up by the chat route and read by the tool.
 *
 * Uses getRequestContext() (AsyncLocalStorage) to locate the writer for
 * the current request without threading it through function arguments.
 */

import type { UIMessageStreamWriter } from "ai";
import { getRequestContext } from "@atlas/api/lib/logger";

const writers = new Map<string, UIMessageStreamWriter>();

/** Register a stream writer for the current request. Called by the chat route. */
export function setStreamWriter(requestId: string, writer: UIMessageStreamWriter): void {
  writers.set(requestId, writer);
}

/** Remove the stream writer when the stream completes. */
export function clearStreamWriter(requestId: string): void {
  writers.delete(requestId);
}

/** Get the stream writer for the current request. Returns undefined if not in a streaming context. */
export function getStreamWriter(): UIMessageStreamWriter | undefined {
  const ctx = getRequestContext();
  if (!ctx?.requestId) return undefined;
  return writers.get(ctx.requestId);
}
