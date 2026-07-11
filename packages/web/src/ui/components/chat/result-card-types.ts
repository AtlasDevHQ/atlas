/** Shared value types for chat result cards. */

/**
 * Snapshot of a prior SQL execution, used to render a "was N rows · Ns"
 * comparison caption on a re-rendered result. Optional throughout the chat
 * render path.
 */
export interface PreviousExecution {
  executionMs?: number;
  rowCount?: number;
}
