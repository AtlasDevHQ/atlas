/**
 * Progress tracking for `atlas init` profiling.
 *
 * Provides a spinner with table count, ETA, and elapsed time.
 * Falls back to simple line-by-line output when stderr is not a TTY.
 */
import * as p from "@clack/prompts";
import pc from "picocolors";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ProfileProgressCallbacks {
  onStart(total: number): void;
  onTableStart(name: string, index: number, total: number): void;
  onTableDone(name: string, index: number, total: number): void;
  onTableError(name: string, error: string, index: number, total: number): void;
  onComplete(succeeded: number, elapsedMs: number): void;
}

// ---------------------------------------------------------------------------
// ETA helpers (exported for testing)
// ---------------------------------------------------------------------------

/** Format milliseconds as a human-friendly string (e.g. "42s", "1m 12s"). */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/** Estimate remaining time given elapsed time, items completed, and total items. Returns ms. */
export function estimateRemaining(elapsedMs: number, completed: number, total: number): number {
  if (completed <= 0 || completed >= total) return 0;
  const perItem = elapsedMs / completed;
  return perItem * (total - completed);
}

// ---------------------------------------------------------------------------
// Progress tracker factory
// ---------------------------------------------------------------------------

const ETA_INTERVAL = 5; // Show ETA every N tables

export function createProgressTracker(): ProfileProgressCallbacks {
  const isTTY = process.stderr.isTTY ?? false;
  let startTime = 0;
  let errorCount = 0;
  let spinner: ReturnType<typeof p.spinner> | undefined;

  return {
    onStart(total: number) {
      startTime = Date.now();
      errorCount = 0;

      if (isTTY) {
        process.stderr.write(`\n${pc.cyan(`Found ${total} table${total !== 1 ? "s" : ""} to profile`)}\n\n`);
        spinner = p.spinner();
        spinner.start("Starting profiler...");
      } else {
        process.stderr.write(`Found ${total} table${total !== 1 ? "s" : ""} to profile\n`);
      }
    },

    onTableStart(name: string, index: number, total: number) {
      const msg = `Profiling ${name} (${index + 1}/${total})...`;
      if (isTTY && spinner) {
        spinner.message(msg);
      } else {
        process.stderr.write(`  ${msg}\n`);
      }
    },

    onTableDone(_name: string, index: number, total: number) {
      const done = index + 1;

      // Show ETA every N tables (but not on the last one — completion handles that)
      if (done < total && done % ETA_INTERVAL === 0) {
        const elapsed = Date.now() - startTime;
        const remaining = estimateRemaining(elapsed, done, total);
        const msg = `${done}/${total} tables profiled (${formatDuration(elapsed)} elapsed, ~${formatDuration(remaining)} remaining)`;
        if (isTTY && spinner) {
          spinner.message(msg);
        } else {
          process.stderr.write(`  ${msg}\n`);
        }
      }
    },

    onTableError(name: string, error: string, _index: number, _total: number) {
      errorCount++;
      if (isTTY && spinner) {
        try {
          // Temporarily stop spinner to print warning, then restart
          spinner.stop(pc.yellow(`  Warning: Failed to profile ${name}: ${error}`));
          spinner = p.spinner();
          spinner.start("Continuing...");
        } catch {
          // Terminal IO failed — fall back to plain write
          spinner = undefined;
          process.stderr.write(`  Warning: Failed to profile ${name}: ${error}\n`);
        }
      } else {
        process.stderr.write(`  ${pc.yellow(`Warning: Failed to profile ${name}: ${error}`)}\n`);
      }
    },

    onComplete(succeeded: number, elapsedMs: number) {
      const failPart = errorCount > 0 ? `, ${errorCount} failed` : "";
      const summary = `Profiled ${succeeded} table${succeeded !== 1 ? "s" : ""} in ${formatDuration(elapsedMs)}${failPart}`;
      if (isTTY && spinner) {
        spinner.stop(pc.green(summary));
      } else {
        process.stderr.write(`${summary}\n`);
      }
    },
  };
}
