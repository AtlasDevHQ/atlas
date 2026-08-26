"use client";

import { getToolArgs, getToolResult, isToolComplete } from "../../lib/helpers";
import { LoadingCard } from "./loading-card";
import { ResultCardBase, ResultCardErrorBoundary } from "./result-card-base";
import { TierBadge } from "./tier-badge";
import { formatDate, str, stripHeadlineMarkup, toRows, type ResultLine } from "../../lib/brain-rows";

/**
 * The `searchBrain` result card (#5451) — the first non-admin surface anywhere
 * that renders a trust tier.
 *
 * Before this, `searchBrain` fell through `tool-part.tsx`'s `default:` arm to a
 * gray "Tool: searchBrain" box, so the tier — computed, fused, carried on the
 * wire and covered by tests — reached a person only if the model chose to
 * mention it in prose. ADR-0036 makes the label a permanent product invariant
 * on "every retrieval result **and every UI surface**"; this is the second
 * clause.
 *
 * ## Every row carries a chip, including the ones this build cannot classify
 *
 * `toRows` below never drops a row and never omits a tier, and {@link TierBadge}
 * has no path that renders nothing. A malformed row reaches the surface as a
 * loud "unknown tier" chip rather than as an unlabelled line — an unlabelled
 * row is exactly the bug, and "we'd notice" is what did not happen for the six
 * weeks the label existed nowhere.
 */
export function SearchBrainCard({ part }: { part: unknown }) {
  return (
    <ResultCardErrorBoundary label="Atlas search">
      <SearchBrainCardInner part={part} />
    </ResultCardErrorBoundary>
  );
}

function SearchBrainCardInner({ part }: { part: unknown }) {
  const args = getToolArgs(part);
  const result = getToolResult(part) as Record<string, unknown> | null;
  const done = isToolComplete(part);

  if (!done) return <LoadingCard label="Searching the Atlas..." />;

  const query = str(args.query) ?? "Atlas search";

  // The degraded paths carry their own prose; `search-brain.ts` is emphatic
  // that none of them may read as "the Atlas knows nothing".
  const error = result ? str(result.error) : null;
  if (error) {
    return (
      <div className="my-2 rounded-lg border border-yellow-300 bg-yellow-50 px-3 py-2 text-xs text-yellow-800 dark:border-yellow-900/50 dark:bg-yellow-950/20 dark:text-yellow-400">
        {error}
      </div>
    );
  }

  const rows = toRows(result);
  const unavailable = result ? str(result.unavailable) : null;

  return (
    <ResultCardBase
      badge="Atlas"
      badgeClassName="bg-primary/15 text-primary dark:bg-primary/20 dark:text-primary"
      title={query}
      headerExtra={
        <span className="text-muted-foreground">
          {rows.length} result{rows.length === 1 ? "" : "s"}
        </span>
      }
    >
      {unavailable && (
        <p className="px-3 py-2 text-xs text-yellow-800 dark:text-yellow-400">
          The Atlas could not be searched ({unavailable}) — this is not the same as it
          knowing nothing.
        </p>
      )}
      {!unavailable && rows.length === 0 && (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          Searched the Atlas; nothing matched.
        </p>
      )}
      {rows.length > 0 && (
        <ul data-testid="brain-results" className="divide-y divide-border">
          {rows.map((row, index) => (
            <li
              key={index}
              data-testid="brain-result"
              className="flex items-start gap-2 px-3 py-2 text-xs"
            >
              <TierBadge tier={row.tier} className="mt-0.5" />
              <span className="min-w-0 flex-1">
                <span className="block break-words text-foreground">
                  {row.primary}
                </span>
                {(row.secondary || row.linked) && (
                  <span className="mt-0.5 block text-muted-foreground">
                    {row.linked && <span className="mr-1">linked ·</span>}
                    {row.secondary}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </ResultCardBase>
  );
}
