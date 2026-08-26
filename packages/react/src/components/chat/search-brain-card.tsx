"use client";

import { getToolArgs, getToolResult, isToolComplete } from "../../lib/helpers";
import { LoadingCard } from "./loading-card";
import { ResultCardBase, ResultCardErrorBoundary } from "./result-card-base";
import { TierBadge } from "./tier-badge";

/**
 * The `searchBrain` result card for the embeddable widget (#5451).
 *
 * The widget is a UI surface under ADR-0036's wording, so it carries the tier
 * on the same terms the first-party chat does rather than being argued out of
 * it. This is a sibling of
 * `packages/web/src/ui/components/chat/search-brain-card.tsx` — the same
 * duplication every other card in this package already lives with (SQL,
 * explore, data table), for the same reason: the widget bundles standalone.
 * What must NOT drift is the tier vocabulary, and that is pinned separately by
 * `lib/trust-tier.ts` and its mirror test.
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

/** One rendered line: the tier chip plus what the row says. */
interface BrainRow {
  /**
   * The raw wire value, NOT narrowed. Passing `string` straight to the badge is
   * what makes an unrecognized tier visible instead of absent.
   */
  readonly tier: string;
  readonly primary: string;
  readonly secondary: string | null;
  /** True for a 1-hop link-graph expansion result rather than a direct match. */
  readonly linked: boolean;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Collapse `ts_headline` markup to plain text — the snippet arrives with `<b>` tags. */
function plain(value: unknown): string | null {
  const s = str(value);
  return s ? s.replace(/<\/?b>/g, "") : null;
}

function formatDate(value: unknown): string | null {
  const s = str(value);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString();
}

/**
 * Project one fused row onto a line, by tier.
 *
 * Reads defensively rather than casting to `BrainSearchResult`: this is a tool
 * output crossing an HTTP + streaming boundary, and a card that throws on a
 * shape surprise takes the tier chip down with it.
 */
function toRow(raw: unknown, linked: boolean): BrainRow {
  const row = raw != null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const tier = typeof row.tier === "string" ? row.tier : "";

  switch (tier) {
    case "fact": {
      const claim = [str(row.subject), str(row.predicate), str(row.object)]
        .filter(Boolean)
        .join(" ");
      const age = formatDate(row.validFrom);
      const decayLevel = str((row.decay as Record<string, unknown> | undefined)?.level);
      // `unknown` is a real decay level meaning "no age signal", not a missing
      // value — showing it as a chip caption would read as a defect.
      const decay = decayLevel && decayLevel !== "unknown" ? decayLevel : null;
      const corroboration =
        typeof row.corroborationCount === "number" && row.corroborationCount > 1
          ? `${row.corroborationCount} sources`
          : null;
      return {
        tier,
        primary: claim || plain(row.snippet) || "(claim unavailable)",
        secondary:
          [age && `since ${age}`, decay, corroboration].filter(Boolean).join(" · ") || null,
        linked,
      };
    }
    case "raw-episode": {
      const said = plain(row.snippet) ?? str(row.body) ?? str(row.locator);
      const who = str(row.sourceActor);
      const when = formatDate(row.occurredAt);
      const extraction = row.extraction === "pending" ? "not yet distilled" : null;
      return {
        tier,
        primary: said ?? "(source material unavailable)",
        secondary:
          [str(row.source), who, when, extraction].filter(Boolean).join(" · ") || null,
        linked,
      };
    }
    case "document": {
      return {
        tier,
        primary: str(row.title) ?? str(row.path) ?? "(untitled document)",
        secondary:
          [str(row.collection), plain(row.snippet)].filter(Boolean).join(" · ") || null,
        linked,
      };
    }
    default:
      // Deliberately still a row. See the module header.
      return {
        tier,
        primary: plain(row.snippet) ?? str(row.title) ?? "(result could not be read)",
        secondary: null,
        linked,
      };
  }
}

function toRows(result: Record<string, unknown> | null): BrainRow[] {
  if (!result) return [];
  const results = Array.isArray(result.results) ? result.results : [];
  const neighbors = Array.isArray(result.neighbors) ? result.neighbors : [];
  return [
    ...results.map((r) => toRow(r, false)),
    ...neighbors.map((n) => toRow(n, true)),
  ];
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
        <span className="text-zinc-500">
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
        <p className="px-3 py-2 text-xs text-zinc-500 dark:text-zinc-400">
          Searched the Atlas; nothing matched.
        </p>
      )}
      {rows.length > 0 && (
        <ul data-testid="brain-results" className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {rows.map((row, index) => (
            <li
              key={index}
              data-testid="brain-result"
              className="flex items-start gap-2 px-3 py-2 text-xs"
            >
              <TierBadge tier={row.tier} className="mt-0.5" />
              <span className="min-w-0 flex-1">
                <span className="block break-words text-zinc-700 dark:text-zinc-300">
                  {row.primary}
                </span>
                {(row.secondary || row.linked) && (
                  <span className="mt-0.5 block text-zinc-500 dark:text-zinc-400">
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
