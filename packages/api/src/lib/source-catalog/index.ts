/**
 * Pure **Source catalog** builder (ADR-0022 §4, slice (b) #3894).
 *
 * Renders the compact routing menu the agent reads to decide *which* data
 * source(s) hold an answer before drilling in with `explore`. One entry per
 * SQL Connection group + REST datasource: a stable id (the agent's routing
 * target), a display name, a short description, and a bounded list of headline
 * entities / operations.
 *
 * This is the discovery half of cross-group reach: slice (a) (#3893) gave the
 * agent the *ability* to target a group per query; without a menu it would have
 * to `explore` every group blind to find the right one. The catalog is that
 * menu — "read this, then drill in" — and unifies SQL groups + REST datasources
 * (two separate reach axes) into one list (ADR-0022 §4; the unification the
 * `group-reach/lookup.ts` scope-note defers to slice (b)).
 *
 * **Pure.** No DB, no IO. The caller resolves the sources (impure — see
 * `./lookup.ts`) and hands them in, making the format exhaustively unit-testable
 * and decoupled from the prompt plumbing — the same split `group-reach/` uses
 * (`resolveReach` ↔ `loadVisibleGroups`).
 *
 * **Bounded.** Description length, headline-item count, and total source count
 * are all capped so the block stays within a predictable prompt budget no matter
 * how large a workspace grows (ADR-0022 §4 "bounded"; the deferred-embedding
 * boundary). By design, every cap that actually drops content emits a visible
 * note ("+N more", "Showing N of M") rather than silently truncating — a
 * silently-capped catalog would read to the agent as "these are all your
 * sources" when they are not.
 *
 * @see ADR-0022 — cross-group reach + Source catalog
 * @see issue #3894 — slice (b) acceptance criteria
 */

/** A data source the agent can route to: a SQL Connection group or a REST datasource. */
export interface CatalogSource {
  /** SQL Connection group vs REST datasource — drives the entry's label + section. */
  readonly kind: "sql" | "rest";
  /**
   * Stable routing id the agent targets — a SQL group's canonical
   * `connection_group_id` (`executeSQL`'s per-query `group`) or a REST
   * datasource's install id (`executeRestOperation`'s `datasourceId`).
   */
  readonly id: string;
  /** Human display name. Falls back to `id` when blank. */
  readonly name: string;
  /**
   * Operator-refined or auto-generated description. When present and non-blank
   * it drives the entry's prose; when absent the entry falls back to an
   * entity-name summary derived from {@link entities}. (`?` already encodes
   * absence — callers normalize a DB `null` to `undefined`.)
   */
  readonly description?: string;
  /**
   * Headline entity names (SQL) or operation names (REST). Used both for the
   * "Key entities/operations" line and as the description fallback when no
   * description is set. May be empty (a freshly-installed, unprofiled source).
   */
  readonly entities?: readonly string[];
}

export interface SourceCatalogOptions {
  /** Max headline items rendered per source (excess collapses to "+N more"). Default 6. */
  readonly maxItemsPerSource?: number;
  /** Max description characters before a word-boundary ellipsis. Default 200. */
  readonly maxDescriptionChars?: number;
  /** Max sources rendered total (excess collapses to a trailing note). Default 40. */
  readonly maxSources?: number;
}

const DEFAULTS = {
  maxItemsPerSource: 6,
  maxDescriptionChars: 200,
  maxSources: 40,
} as const;

/** Stable, case-insensitive id sort with id tiebreak — deterministic across calls. */
function byId(a: CatalogSource, b: CatalogSource): number {
  const an = a.id.toLowerCase();
  const bn = b.id.toLowerCase();
  if (an < bn) return -1;
  if (an > bn) return 1;
  // Case-only difference: fall back to the raw id so the order is total.
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/** Truncate to a word boundary at/under `max`, appending an ellipsis when cut. */
function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  const slice = trimmed.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  // Prefer the last whole word; if the first word already exceeds `max`, hard-cut.
  const head = lastSpace > Math.floor(max / 2) ? slice.slice(0, lastSpace) : slice;
  return `${head.trimEnd()}…`;
}

/**
 * Dedupe (case-insensitive), sort, and cap a list of headline item names. Pure
 * and deterministic; returns the kept names plus how many were dropped so the
 * caller can render an explicit "+N more" rather than silently truncating.
 */
function boundItems(
  items: readonly string[],
  max: number,
): { readonly kept: string[]; readonly overflow: number } {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const raw of items) {
    const name = raw.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(name);
  }
  unique.sort((a, b) => a.localeCompare(b));
  if (unique.length <= max) return { kept: unique, overflow: 0 };
  return { kept: unique.slice(0, max), overflow: unique.length - max };
}

/**
 * Summarize a source from its headline items alone — the description fallback
 * (ADR-0022 §4 "entity-derived fallback when a description is absent"). Pure;
 * the live counterpart to the persisted auto-description {@link deriveGroupDescription}.
 */
function summarizeItems(items: readonly string[], noun: string): string {
  const { kept, overflow } = boundItems(items, 3);
  if (kept.length === 0) return `No ${noun} profiled yet.`;
  const list = kept.join(", ");
  const tail = overflow > 0 ? `, and ${overflow} more` : "";
  return `Covers ${list}${tail}.`;
}

const HEADER = "## Source catalog";

const GUIDANCE =
  "Pick the data source(s) that hold the answer from the menu below, then use the `explore` tool on the chosen source before writing SQL. Target a source by the id in brackets — pass a SQL group's id as `executeSQL`'s `group` and a REST datasource's id as `executeRestOperation`'s `datasourceId`. You may query several sources and combine the results in your own reasoning (Atlas does not run cross-source joins).";

function renderEntry(source: CatalogSource, opts: Required<SourceCatalogOptions>): string {
  const name = source.name.trim() || source.id;
  const noun = source.kind === "rest" ? "operations" : "entities";
  const itemLabel = source.kind === "rest" ? "Key operations" : "Key entities";
  const items = source.entities ?? [];

  const rawDescription = source.description?.trim();
  const description = rawDescription
    ? truncate(rawDescription, opts.maxDescriptionChars)
    : summarizeItems(items, noun);

  let line = `- **${name}** [id: \`${source.id}\`] — ${description}`;

  const { kept, overflow } = boundItems(items, opts.maxItemsPerSource);
  if (kept.length > 0) {
    const more = overflow > 0 ? ` (+${overflow} more)` : "";
    line += ` ${itemLabel}: ${kept.join(", ")}${more}.`;
  }
  return line;
}

/**
 * Build the Source catalog system-prompt block from the workspace's sources.
 *
 * Returns `""` for an empty source list so the caller can append it
 * unconditionally (mirrors `buildOrgKnowledgeSection`). Output is deterministic:
 * SQL groups first then REST datasources, each ordered by id; headline items
 * deduped + sorted; every bound that drops content surfaces a note.
 */
export function buildSourceCatalog(
  sources: readonly CatalogSource[],
  options: SourceCatalogOptions = {},
): string {
  if (sources.length === 0) return "";

  const opts: Required<SourceCatalogOptions> = {
    maxItemsPerSource: options.maxItemsPerSource ?? DEFAULTS.maxItemsPerSource,
    maxDescriptionChars: options.maxDescriptionChars ?? DEFAULTS.maxDescriptionChars,
    maxSources: options.maxSources ?? DEFAULTS.maxSources,
  };

  const sql = sources.filter((s) => s.kind === "sql").slice().sort(byId);
  const rest = sources.filter((s) => s.kind === "rest").slice().sort(byId);

  // Cap total sources, SQL groups taking priority (they are the larger reach
  // surface). An overflow is reported, never silently dropped.
  const ordered = [...sql, ...rest];
  const shown = ordered.slice(0, opts.maxSources);
  const overflow = ordered.length - shown.length;

  const shownSql = shown.filter((s) => s.kind === "sql");
  const shownRest = shown.filter((s) => s.kind === "rest");

  const blocks: string[] = [HEADER, GUIDANCE];

  if (shownSql.length > 0) {
    blocks.push(
      "### SQL connection groups\n" +
        shownSql.map((s) => renderEntry(s, opts)).join("\n"),
    );
  }
  if (shownRest.length > 0) {
    blocks.push(
      "### REST datasources\n" +
        shownRest.map((s) => renderEntry(s, opts)).join("\n"),
    );
  }

  if (overflow > 0) {
    blocks.push(
      `_Showing ${shown.length} of ${ordered.length} sources. Narrow the conversation scope (Focus on one group) to surface the rest._`,
    );
  }

  return blocks.join("\n\n");
}

/**
 * Derive a persisted auto-description for a Connection group from its entities
 * (ADR-0022 §4 "auto-generated from each group's entities at generation time").
 *
 * Pure. Richer than the catalog's live {@link summarizeItems} fallback: it weaves
 * in entity descriptions when the profiler/enricher produced them, so the stored
 * seed an operator later refines is informative rather than a bare name list.
 * The result is bounded — a single sentence naming the headline tables plus the
 * total count. Returns `""` for an empty group (nothing to describe yet) so the
 * caller can skip persisting a useless row.
 */
export function deriveGroupDescription(
  entities: ReadonlyArray<{ readonly name: string; readonly description?: string | null }>,
  options: { readonly maxNamed?: number; readonly maxChars?: number } = {},
): string {
  const maxNamed = options.maxNamed ?? 4;
  const maxChars = options.maxChars ?? 200;

  const named = entities
    .map((e) => ({ name: e.name.trim(), description: e.description?.trim() || null }))
    .filter((e) => e.name.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (named.length === 0) return "";

  const head = named.slice(0, maxNamed);
  const rendered = head.map((e) =>
    e.description ? `${e.name} (${e.description})` : e.name,
  );
  const remaining = named.length - head.length;
  const tail = remaining > 0 ? `, and ${remaining} more` : "";
  const total = named.length === 1 ? "1 table" : `${named.length} tables`;

  const sentence = `${total}: ${rendered.join("; ")}${tail}.`;
  return truncate(sentence, maxChars);
}
