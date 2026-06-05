/**
 * Cross-filter compatibility + active-filter derivation (#3213).
 *
 * Cross-filtering is built on the #3212 drilldown foundation: a click sets a
 * dashboard PARAMETER (via the shared `dparams` URL key), and the render batch
 * binds that value into every card whose SQL references the `:<param>`
 * placeholder. This module answers the two questions the page needs to drive the
 * cross-filter UX on top of that plumbing:
 *
 *   1. Which cards does an active filter actually touch? — a card whose SQL binds
 *      none of the active filter params is "incompatible" (the filter can't move
 *      it), so the UI marks it rather than leaving the viewer to wonder why a
 *      tile didn't change.
 *   2. What chips should the filter bar show? — one chip per active override that
 *      maps to a declared parameter.
 *
 * Pure + framework-free so the page can derive both without mounting, and so the
 * placeholder scan is unit-testable against the server contract.
 */
import type { DashboardCard, DashboardParameter } from "@/ui/lib/types";
import type { ParameterValues } from "@/ui/components/dashboards/dashboard-parameter-bar";

/**
 * Distinct `:<name>` parameter placeholders a card's SQL references.
 *
 * Mirrors the conservative scanner in `@atlas/api/lib/dashboard-parameters`
 * (`rewriteNamedPlaceholders` / `extractPlaceholderNames`): a colon that is part
 * of a `::` cast, or that sits inside a single-quoted string literal, a
 * double-quoted / backtick identifier, or a line / block comment, is NOT a
 * placeholder. The server is the authoritative binder — this client-side copy
 * drives only the cross-filter *compatibility* affordance, so over-skipping is
 * safe (a card merely looks unaffected, which is exactly how the server would
 * bind it). The web package is a pure HTTP client and cannot import from
 * `@atlas/api`, hence the small faithful port.
 */
export function extractCardPlaceholders(sql: string): Set<string> {
  const names = new Set<string>();
  const isIdentStart = (ch: string) => /[A-Za-z_]/.test(ch);
  const isIdentPart = (ch: string) => /[A-Za-z0-9_]/.test(ch);

  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];

    // Single-quoted string literal ('' and \' escapes both keep us inside it).
    if (ch === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "\\") {
          i += 2; // skip the escape + escaped char (MySQL backslash escapes)
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; } // '' escaped quote
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // Double-quoted (PostgreSQL) / backtick (MySQL) quoted identifier.
    if (ch === '"' || ch === "`") {
      const quote = ch;
      i++;
      while (i < n) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // Line comment — skip to end of line.
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    // Block comment — skip to the closing */.
    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    // Colon: `::` cast is not a placeholder; `:name` is.
    if (ch === ":") {
      if (sql[i + 1] === ":") { i += 2; continue; }
      if (i + 1 < n && isIdentStart(sql[i + 1])) {
        let j = i + 1;
        while (j < n && isIdentPart(sql[j])) j++;
        names.add(sql.slice(i + 1, j));
        i = j;
        continue;
      }
    }
    i++;
  }
  return names;
}

/**
 * Whether a card is AFFECTED by the active cross-filters — its SQL binds at
 * least one active filter param. A chart card that binds none is "incompatible":
 * no active filter can change its result. With no filters active, every card is
 * "affected" (nothing is incompatible). Text / section-block cards have no SQL
 * and are never affected.
 */
export function isCardAffectedByFilters(card: DashboardCard, activeKeys: string[]): boolean {
  if (activeKeys.length === 0) return true;
  if (card.kind === "text" || !card.sql) return false;
  const bound = extractCardPlaceholders(card.sql);
  return activeKeys.some((k) => bound.has(k));
}

/**
 * Ids of the CHART cards visibly *unaffected* by the active cross-filters — the
 * page marks these so a tile that didn't change reads as intentional, not
 * broken. Empty when no filters are active. Text / section cards are never
 * included: a section header has no data to filter, so badging it would be
 * noise.
 */
export function incompatibleCardIds(cards: DashboardCard[], activeKeys: string[]): Set<string> {
  const ids = new Set<string>();
  if (activeKeys.length === 0) return ids;
  for (const card of cards) {
    if (card.kind === "text") continue;
    if (!isCardAffectedByFilters(card, activeKeys)) ids.add(card.id);
  }
  return ids;
}

/** One active cross-filter, ready to render as a chip. */
export interface ActiveFilter {
  /** Declared parameter key — also the chip's remove target. */
  key: string;
  /** Parameter label (chip prefix). */
  label: string;
  /** Stringified active value (chip body). */
  value: string;
}

/**
 * Active cross-filters for the chips bar — one entry per override that maps to a
 * declared parameter and carries a non-empty value. Overrides whose key names no
 * declared parameter are dropped (stale URL state the render path ignores
 * anyway). Order follows the declared parameter order so the chips stay stable
 * across reloads and shared links.
 */
export function activeFilters(
  overrides: ParameterValues,
  parameters: DashboardParameter[],
): ActiveFilter[] {
  const out: ActiveFilter[] = [];
  for (const param of parameters) {
    const value = overrides[param.key];
    if (value === null || value === undefined || value === "") continue;
    out.push({ key: param.key, label: param.label, value: String(value) });
  }
  return out;
}
