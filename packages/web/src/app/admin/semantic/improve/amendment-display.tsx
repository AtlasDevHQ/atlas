// ---------------------------------------------------------------------------
// Shared display primitives for the semantic-improve views.
//
// Split out of page.tsx so the Pending queue (ProposalCard) and the Rejected
// view (RejectedCard, #4512) render an Amendment's diff and payload identically
// — the two views can't drift on how a change is shown.
// ---------------------------------------------------------------------------

export function diffLineStyle(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) {
    return "text-muted-foreground bg-muted font-semibold";
  }
  if (line.startsWith("@@")) {
    return "text-violet-600 dark:text-violet-400 bg-violet-50 dark:bg-violet-950/30";
  }
  if (line.startsWith("+")) {
    return "text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-950/30";
  }
  if (line.startsWith("-")) {
    return "text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/30";
  }
  return "text-muted-foreground";
}

/** Color-coded unified diff. */
export function DiffViewer({ diff }: { diff: string }) {
  return (
    <pre className="rounded-md border text-xs font-mono p-0 m-0 whitespace-pre-wrap break-words">
      {diff.split("\n").map((line, i) => (
        <div key={i} className={`px-3 py-0.5 ${diffLineStyle(line)}`}>
          {line || " "}
        </div>
      ))}
    </pre>
  );
}

/** Format amendment data for display when no diff is available. */
export function formatAmendment(type: string, amendment: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(amendment)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "object" && !Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        lines.push(`  ${k}: ${String(v)}`);
      }
    } else if (Array.isArray(value)) {
      lines.push(`${key}: [${value.join(", ")}]`);
    } else {
      lines.push(`${key}: ${String(value)}`);
    }
  }
  return lines.join("\n") || `(${type})`;
}
