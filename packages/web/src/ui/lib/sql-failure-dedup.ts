import { isToolUIPart, getToolName } from "ai";
import { getToolArgs, getToolResult } from "./helpers";

/**
 * When the agent retries the same SQL verbatim and it fails again with the
 * same error, the chat surface used to stack N identical red blocks. This
 * helper folds those duplicates: the first occurrence renders with a
 * "Tried N times" badge; later identical failures are skipped.
 *
 * Identity is `args.sql + result.error`. A non-string error contributes no
 * dedup key, so a future shape change to a structured error object can't
 * silently collapse genuinely different failures into one bucket via
 * `String([object Object])`.
 */
export interface SqlFailureDedup {
  /** First-occurrence part index → total count of identical failures. Only set when count >= 2. */
  failureRuns: Map<number, number>;
  /** Part indices to skip rendering (every occurrence after the first). */
  skipFailureIndex: Set<number>;
}

export function computeSqlFailureDedup(
  parts: readonly unknown[] | undefined,
): SqlFailureDedup {
  const failureRuns = new Map<number, number>();
  const skipFailureIndex = new Set<number>();
  if (!parts || parts.length === 0) return { failureRuns, skipFailureIndex };

  const firstSeen = new Map<string, number>();
  const counts = new Map<string, number>();

  for (let i = 0; i < parts.length; i++) {
    const key = sqlFailureKey(parts[i]);
    if (!key) continue;
    if (firstSeen.has(key)) {
      skipFailureIndex.add(i);
    } else {
      firstSeen.set(key, i);
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  for (const [key, count] of counts) {
    if (count > 1) {
      const idx = firstSeen.get(key);
      if (idx !== undefined) failureRuns.set(idx, count);
    }
  }

  return { failureRuns, skipFailureIndex };
}

function sqlFailureKey(part: unknown): string | null {
  if (!isToolUIPart(part as Parameters<typeof isToolUIPart>[0])) return null;
  if (getToolName(part as Parameters<typeof getToolName>[0]) !== "executeSQL") return null;
  const result = getToolResult(part) as { success?: boolean; error?: unknown } | null;
  if (!result || result.success !== false) return null;
  // Non-string errors contribute no key — they render as separate cards
  // rather than collapsing through `String([object Object])`.
  if (typeof result.error !== "string") return null;
  const sql = String(getToolArgs(part).sql ?? "");
  return `${sql}\n${result.error}`;
}
